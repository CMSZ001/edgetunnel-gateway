import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import tls from 'node:tls';
import { currentConfig, cleanTelegramChatId } from './config.mjs';

const telegramAlertCooldown = new Map();
const TELEGRAM_ALERT_COOLDOWN_MS = 15 * 60 * 1000;

export function isCriticalAlertableError(reason) {
  if (!reason) return false;
  // 忽略任何客户端中断、TCP 重置、超时等偶发网络事件
  if (/ETIMEDOUT|ECONNREFUSED|EHOSTUNREACH|ENETUNREACH|ECONNRESET|EPIPE|ERR_HTTP2_STREAM_CANCEL|ECONNABORTED|destroyed|premature/i.test(reason)) {
    return false;
  }
  // 仅限严重后端故障：1101 (Worker 崩溃/超限), 429 (限流), 403 (域名被封), 500/502/521/530 (CF 边缘/源站宕机)
  return /1101|429|403|500|502|521|530/i.test(reason);
}

export function sendTelegramRequest(endpoint, payload = null, onSuccess = null, onFail = null) {
  const tg = currentConfig.telegram;
  if (!tg.botToken) {
    if (onFail) onFail(new Error('未配置 Telegram Bot Token'));
    return;
  }

  const host = tg.apiHost || 'api.telegram.org';
  const pathStr = `/bot${tg.botToken}/${endpoint}`;
  const method = payload ? 'POST' : 'GET';

  if (tg.proxy) {
    let proxyUrl;
    try {
      proxyUrl = new URL(tg.proxy.includes('://') ? tg.proxy : `socks5://${tg.proxy}`);
    } catch {
      if (onFail) onFail(new Error(`无效的代理地址格式: ${tg.proxy}`));
      return;
    }

    const proxyProtocol = proxyUrl.protocol.replace(':', '').toLowerCase();
    const proxyHost = proxyUrl.hostname;
    const proxyPort = parseInt(proxyUrl.port || (proxyProtocol.startsWith('socks') ? '1080' : '7890'), 10);

    if (proxyProtocol.startsWith('socks')) {
      const socket = net.connect(proxyPort, proxyHost);
      socket.setTimeout(6000, () => socket.destroy(new Error('SOCKS5 代理连接超时')));

      let stage = 0;
      socket.on('connect', () => {
        socket.write(Buffer.from([0x05, 0x01, 0x00]));
      });

      socket.on('data', (data) => {
        if (stage === 0) {
          if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
            socket.destroy(new Error(`SOCKS5 认证握手被拒: ${data.toString('hex')}`));
            return;
          }
          stage = 1;
          const hostBuf = Buffer.from(host);
          const req = Buffer.concat([
            Buffer.from([0x05, 0x01, 0x00, 0x03, hostBuf.length]),
            hostBuf,
            Buffer.from([(443 >> 8) & 0xff, 443 & 0xff])
          ]);
          socket.write(req);
        } else if (stage === 1) {
          if (data.length < 2 || data[0] !== 0x05 || data[1] !== 0x00) {
            socket.destroy(new Error(`SOCKS5 CONNECT 目标失败 (错误码: ${data[1]})`));
            return;
          }
          stage = 2;
          socket.removeAllListeners('data');
          socket.setTimeout(0);

          const tlsSocket = tls.connect({ socket, servername: host }, () => {
            let reqData = `${method} ${pathStr} HTTP/1.1\r\n` +
                          `Host: ${host}\r\n` +
                          `User-Agent: local-edgetunnel-lb/1.0\r\n`;
            if (payload) {
              reqData += `Content-Type: application/json\r\n` +
                         `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
                         `Connection: close\r\n\r\n` +
                         payload;
            } else {
              reqData += `Connection: close\r\n\r\n`;
            }
            tlsSocket.write(reqData);
          });

          let rawData = '';
          let handled = false;
          const finishRequest = (str) => {
            if (handled) return;
            handled = true;
            try { tlsSocket.destroy(); } catch {}
            const bodyIdx = str.indexOf('\r\n\r\n');
            const body = bodyIdx !== -1 ? str.substring(bodyIdx + 4) : str;
            if (onSuccess) onSuccess(body);
          };

          tlsSocket.setTimeout(8000, () => {
            if (!handled) {
              handled = true;
              try { tlsSocket.destroy(); } catch {}
              if (onFail) onFail(new Error('等待 Telegram 响应超时 (8s)'));
            }
          });

          tlsSocket.on('data', chunk => {
            rawData += chunk.toString('utf8');
            if (rawData.includes('\r\n\r\n')) {
              const body = rawData.substring(rawData.indexOf('\r\n\r\n') + 4).trim();
              if (body.startsWith('{') && body.endsWith('}')) {
                finishRequest(rawData);
              }
            }
          });
          tlsSocket.on('end', () => { finishRequest(rawData); });
          tlsSocket.on('error', err => {
            if (!handled) {
              handled = true;
              try { tlsSocket.destroy(); } catch {}
              if (onFail) onFail(err);
            }
          });
        }
      });

      socket.on('error', err => {
        socket.destroy();
        if (onFail) onFail(err);
      });
      return;
    } else {
      const req = http.request({
        host: proxyHost,
        port: proxyPort,
        method: 'CONNECT',
        path: `${host}:443`,
        timeout: 6000
      });
      req.on('connect', (res, socket) => {
        if (res.statusCode !== 200) {
          socket.destroy();
          if (onFail) onFail(new Error(`HTTP 代理 CONNECT 失败: ${res.statusCode}`));
          return;
        }
        const tlsSocket = tls.connect({ socket, servername: host }, () => {
          let reqData = `${method} ${pathStr} HTTP/1.1\r\n` +
                        `Host: ${host}\r\n` +
                        `User-Agent: local-edgetunnel-lb/1.0\r\n`;
          if (payload) {
            reqData += `Content-Type: application/json\r\n` +
                       `Content-Length: ${Buffer.byteLength(payload)}\r\n` +
                       `Connection: close\r\n\r\n` +
                       payload;
          } else {
            reqData += `Connection: close\r\n\r\n`;
          }
          tlsSocket.write(reqData);
        });

        let rawData = '';
        tlsSocket.on('data', chunk => { rawData += chunk.toString('utf8'); });
        tlsSocket.on('end', () => {
          const bodyIdx = rawData.indexOf('\r\n\r\n');
          const body = bodyIdx !== -1 ? rawData.substring(bodyIdx + 4) : rawData;
          if (onSuccess) onSuccess(body);
        });
        tlsSocket.on('error', err => {
          tlsSocket.destroy();
          if (onFail) onFail(err);
        });
      });
      req.on('error', err => {
        req.destroy();
        if (onFail) onFail(err);
      });
      req.end();
      return;
    }
  }

  const headers = { 'User-Agent': 'local-edgetunnel-lb/1.0' };
  if (payload) {
    headers['Content-Type'] = 'application/json';
    headers['Content-Length'] = Buffer.byteLength(payload);
  }

  const req = https.request({
    hostname: host,
    port: 443,
    path: pathStr,
    method,
    headers,
    timeout: 6000
  }, (res) => {
    let raw = '';
    res.on('data', chunk => { raw += chunk; });
    res.on('end', () => { if (onSuccess) onSuccess(raw); });
  });

  req.on('error', err => { if (onFail) onFail(err); });
  req.on('timeout', () => req.destroy(new Error('请求 Telegram API 超时')));
  if (payload) req.write(payload);
  req.end();
}

export function verifyTelegramConnectivity(callback) {
  if (!currentConfig.telegram.botToken) {
    if (callback) callback({ ok: false, message: '未配置 Bot Token' });
    return;
  }
  sendTelegramRequest('getMe', null, (resData) => {
    try {
      const obj = JSON.parse(resData);
      if (obj.ok && obj.result) {
        const botName = obj.result.username ? `@${obj.result.username}` : (obj.result.first_name || 'Bot');
        console.log(`\x1b[32m   ✅ [Telegram Bot] 自检连通成功！已确认握手正常 (机器人: ${botName})\x1b[0m`);
        if (callback) callback({ ok: true, bot: botName });
      } else {
        console.warn(`\x1b[33m   ⚠️ [Telegram Bot] 自检返回非正常状态: ${resData}\x1b[0m`);
        if (callback) callback({ ok: false, message: resData });
      }
    } catch (e) {
      if (callback) callback({ ok: true, message: 'HTTP 200 链路畅通' });
    }
  }, (err) => {
    console.error(`\x1b[31m   ❌ [Telegram Bot] 自检握手失败: ${err.message}\x1b[0m`);
    if (callback) callback({ ok: false, error: err.message });
  });
}

export function sendTelegramRawText(text) {
  return new Promise((resolve, reject) => {
    const tg = currentConfig.telegram;
    if (!tg.botToken || !tg.chatId) return resolve(false);
    const payload = JSON.stringify({
      chat_id: cleanTelegramChatId(tg.chatId),
      text,
      parse_mode: 'Markdown'
    });
    sendTelegramRequest('sendMessage', payload, () => resolve(true), (err) => reject(err));
  });
}

export function sendTelegramAlert(backend, reason, metrics = null) {
  const tg = currentConfig.telegram;
  if (!tg.botToken || !tg.chatId) return;
  if (!isCriticalAlertableError(reason)) return;

  const now = Date.now();
  const alertKey = backend;
  const lastTime = telegramAlertCooldown.get(alertKey) || 0;
  if (now - lastTime < TELEGRAM_ALERT_COOLDOWN_MS) return;
  telegramAlertCooldown.set(alertKey, now);
  if (metrics) metrics.alertsSent++;

  const timeStr = new Date().toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' });
  const text = `🚨 *【EdgeTunnel 分流网关告警】*\n\n` +
               `⚠️ *故障等级*: 致命后端异常 (已触发健康熔断)\n` +
               `🎯 *异常后端*: \`${backend}\`\n` +
               `💥 *错误详情*: ${reason}\n` +
               `🛡️ *网关动作*: 已自动将该后端隔离移出轮询池，流量已无缝切换至健康节点\n` +
               `⏰ *发生时间*: ${timeStr}`;

  const payload = JSON.stringify({
    chat_id: cleanTelegramChatId(tg.chatId),
    text,
    parse_mode: 'Markdown'
  });

  sendTelegramRequest('sendMessage', payload, null, (err) => {
    console.error('[Telegram Bot] 推送故障告警失败:', err.message);
  });
}
