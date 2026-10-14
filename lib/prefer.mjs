import net from 'node:net';
import { currentConfig } from './config.mjs';

export const preferNodes = new Map();
export const MAX_PREFER_NODES = 50;

export function parseTargetHostPort(serverStr) {
  let host = currentConfig.defaultPrefer || 'cf.example.com';
  let port = 443;
  if (!serverStr) return { host, port };

  let str = serverStr.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '');
  str = str.replace(/%3a/gi, ':');
  try { str = decodeURIComponent(str); } catch {}
  str = str.replace(/%3a/gi, ':');
  if (!str) return { host, port };

  // IPv6 格式: [2400:cb00:...]:443 或 [2400:cb00:...]
  if (str.startsWith('[')) {
    const closeBracket = str.indexOf(']');
    if (closeBracket !== -1) {
      host = str.slice(1, closeBracket);
      const after = str.slice(closeBracket + 1);
      if (after.startsWith(':')) {
        const p = parseInt(after.slice(1), 10);
        if (!isNaN(p) && p > 0 && p <= 65535) port = p;
      }
      return { host, port };
    }
  }

  // 常规 IPv4 / 域名格式: 1.1.1.1:443 或 example.com
  const lastColon = str.lastIndexOf(':');
  if (lastColon !== -1) {
    const possibleHost = str.slice(0, lastColon);
    const possiblePort = str.slice(lastColon + 1);
    const p = parseInt(possiblePort, 10);
    if (!isNaN(p) && p > 0 && p <= 65535 && !possibleHost.includes(':')) {
      host = possibleHost;
      port = p;
      return { host, port };
    }
  }

  host = str;
  return { host, port };
}

export function normalizePreferTarget(serverStr) {
  const { host, port } = parseTargetHostPort(serverStr);
  const isIpv6 = host.includes(':') && !host.startsWith('[');
  const formattedHost = isIpv6 ? `[${host}]` : host;
  return {
    target: `${formattedHost}:${port}`,
    host,
    port
  };
}

export function recordPreferActivity(serverStr, clientIp = null, latency = null, status = 'ok', error = null) {
  try {
    const defaultNorm = normalizePreferTarget(currentConfig.defaultPrefer);
    const effectiveServer = serverStr || currentConfig.defaultPrefer;
    const { target, host, port } = normalizePreferTarget(effectiveServer);

    let node = preferNodes.get(target);
    const now = Date.now();
    if (!node) {
      if (preferNodes.size >= MAX_PREFER_NODES) {
        let oldestKey = null;
        let oldestTime = Infinity;
        for (const [k, v] of preferNodes.entries()) {
          if (!v.isDefault && v.lastSeen < oldestTime) {
            oldestTime = v.lastSeen;
            oldestKey = k;
          }
        }
        if (oldestKey) preferNodes.delete(oldestKey);
      }
      node = {
        target,
        host,
        port,
        isDefault: (target === defaultNorm.target),
        firstSeen: now,
        lastSeen: now,
        requestCount: 0,
        lastLatency: null,
        lastStatus: null,
        lastError: null,
        clients: []
      };
      preferNodes.set(target, node);
    }

    node.lastSeen = now;
    node.requestCount++;
    node.isDefault = (target === defaultNorm.target);

    if (latency !== null && !isNaN(latency)) {
      node.lastLatency = latency;
      node.lastStatus = status;
      node.lastError = error || null;
    } else if (status === 'error') {
      node.lastStatus = 'error';
      node.lastError = error || '连接异常';
    }

    if (clientIp) {
      const pureIp = String(clientIp).split(':')[0].trim();
      if (pureIp && pureIp !== '未知' && !node.clients.includes(pureIp)) {
        node.clients.push(pureIp);
        if (node.clients.length > 5) node.clients.shift();
      }
    }
  } catch (e) {
    // 忽略异常
  }
}

export function pingPreferTarget(targetStr, timeoutMs = 3500) {
  return new Promise((resolve) => {
    const { host, port } = parseTargetHostPort(targetStr);
    const start = Date.now();
    let isResolved = false;

    const socket = new net.Socket();
    socket.setTimeout(timeoutMs);

    const finish = (result) => {
      if (isResolved) return;
      isResolved = true;
      try { socket.destroy(); } catch {}

      const norm = normalizePreferTarget(targetStr);
      const node = preferNodes.get(norm.target);
      if (node) {
        node.lastLatency = result.latency;
        node.lastStatus = result.status;
        node.lastError = result.error;
      }

      resolve(result);
    };

    socket.connect(port, host, () => {
      const latency = Date.now() - start;
      finish({
        target: targetStr,
        host,
        port,
        ok: true,
        latency,
        status: 'ok',
        error: null
      });
    });

    socket.on('timeout', () => {
      finish({
        target: targetStr,
        host,
        port,
        ok: false,
        latency: null,
        status: 'timeout',
        error: 'TCP 连接超时 (>3.5s)'
      });
    });

    socket.on('error', (err) => {
      finish({
        target: targetStr,
        host,
        port,
        ok: false,
        latency: null,
        status: 'error',
        error: err.code || err.message
      });
    });
  });
}

export function getPreferNodesList() {
  recordPreferActivity(currentConfig.defaultPrefer);
  const defaultNorm = normalizePreferTarget(currentConfig.defaultPrefer);

  const list = [];
  for (const node of preferNodes.values()) {
    node.isDefault = (node.target === defaultNorm.target);
    list.push({ ...node });
  }

  list.sort((a, b) => {
    if (a.isDefault) return -1;
    if (b.isDefault) return 1;
    return b.lastSeen - a.lastSeen;
  });

  return list;
}

export function cleanStalePreferNodes(maxAgeMs = 12 * 3600 * 1000) {
  const now = Date.now();
  const defaultNorm = normalizePreferTarget(currentConfig.defaultPrefer);
  let cleaned = 0;
  for (const [k, v] of preferNodes.entries()) {
    if (!v.isDefault && k !== defaultNorm.target && (now - v.lastSeen > maxAgeMs)) {
      preferNodes.delete(k);
      cleaned++;
    }
  }
  return cleaned;
}
