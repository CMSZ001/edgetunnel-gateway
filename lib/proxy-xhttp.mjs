import http from 'node:http';
import http2 from 'node:http2';
import net from 'node:net';
import { currentConfig } from './config.mjs';
import { getNextWorkerBackend, markBackendSuccess, markBackendFailure } from './health.mjs';
import { parseTargetHostPort, recordPreferActivity } from './prefer.mjs';
import { parsePreferAndCleanPath, getSafeHttp2ConnectUrl, isBenignError } from './utils.mjs';

const clientIpMap = new Map();
const h2SessionPool = new Map();

function getOrCreateH2Session(connectHost, connectPort, backendSni) {
  const poolKey = `${connectHost}:${connectPort}#${backendSni}`;
  let poolItem = h2SessionPool.get(poolKey);

  if (poolItem && poolItem.session && !poolItem.session.destroyed && !poolItem.session.closed && !poolItem.session.socket?.destroyed) {
    poolItem.lastUsed = Date.now();
    poolItem.activeStreams++;
    return { session: poolItem.session, isReused: true, poolKey };
  }

  if (poolItem) {
    try { poolItem.session?.destroy(); } catch {}
    h2SessionPool.delete(poolKey);
  }

  const targetUrl = getSafeHttp2ConnectUrl(connectHost, connectPort);
  const session = http2.connect(targetUrl, {
    servername: backendSni,
    rejectUnauthorized: false
  });

  const newItem = {
    session,
    poolKey,
    lastUsed: Date.now(),
    activeStreams: 1
  };
  h2SessionPool.set(poolKey, newItem);

  const cleanupItem = () => {
    if (h2SessionPool.get(poolKey)?.session === session) {
      h2SessionPool.delete(poolKey);
    }
  };

  session.on('error', cleanupItem);
  session.on('close', cleanupItem);
  session.on('goaway', cleanupItem);

  return { session, isReused: false, poolKey };
}

function releaseH2Session(poolKey) {
  const poolItem = h2SessionPool.get(poolKey);
  if (poolItem) {
    poolItem.activeStreams = Math.max(0, poolItem.activeStreams - 1);
    poolItem.lastUsed = Date.now();
  }
}

setInterval(() => {
  const now = Date.now();
  for (const [key, item] of h2SessionPool.entries()) {
    if (item.activeStreams <= 0 && (now - item.lastUsed > 60000)) {
      try { item.session.close(); } catch {}
      h2SessionPool.delete(key);
    }
  }
}, 15000);

function getRealClientIp(streamOrReq) {
  if (!streamOrReq) return '未知';
  const sock = streamOrReq.session?.socket || streamOrReq.socket || (streamOrReq.localPort !== undefined ? streamOrReq : null);
  if (!sock) return '未知';

  const realIp = clientIpMap.get(sock.remotePort) || clientIpMap.get(sock.localPort);
  return realIp || `${sock.remoteAddress || '未知'}:${sock.remotePort || ''}`;
}

export function createXhttpGateway(metrics, getCachedCfAccounts = () => null) {
  function handleWorkerForward(clientInStream, headers, rawPath, clientMethod, protoLabel, isHttp1Response = false, clientInReadable = null) {
    if (metrics) metrics.xhttpRequests++;
    const clientTag = getRealClientIp(clientInStream);
    const { targetServer: extractedServer, cleanedPath } = parsePreferAndCleanPath(rawPath);
    const targetServer = extractedServer || currentConfig.defaultPrefer;
    const { host: connectHost, port: connectPort } = parseTargetHostPort(targetServer);

    recordPreferActivity(targetServer, clientTag);

    const inputReadable = (isHttp1Response && clientInReadable) ? clientInReadable : clientInStream;

    const baseHeaders = {
      ':method': clientMethod,
      ':path': cleanedPath,
      ':scheme': 'https'
    };

    for (const [key, value] of Object.entries(headers)) {
      if (!key.startsWith(':')) {
        const lower = key.toLowerCase();
        if (!['connection', 'keep-alive', 'transfer-encoding', 'upgrade', 'host', 'content-length'].includes(lower)) {
          if (lower === 'te' && value !== 'trailers') continue;
          baseHeaders[key] = value;
        }
      }
    }

    const initialChunks = [];
    let isHandshakeSuccess = false;
    let currentOutReq = null;
    let currentPoolKey = null;
    let isClientEnded = false;

    const onClientData = (chunk) => {
      if (!isHandshakeSuccess && initialChunks.reduce((acc, c) => acc + c.length, 0) < 131072) {
        initialChunks.push(chunk);
      }
      if (currentOutReq && !currentOutReq.destroyed) {
        try { currentOutReq.write(chunk); } catch {}
      }
    };

    const onClientEnd = () => {
      isClientEnded = true;
      if (currentOutReq && !currentOutReq.destroyed) {
        try { currentOutReq.end(); } catch {}
      }
    };

    inputReadable.on('data', onClientData);
    inputReadable.on('end', onClientEnd);

    const cleanupClient = () => {
      inputReadable.removeListener('data', onClientData);
      inputReadable.removeListener('end', onClientEnd);
      if (currentOutReq) {
        try { currentOutReq.destroy(); } catch {}
      }
      if (currentPoolKey) {
        releaseH2Session(currentPoolKey);
        currentPoolKey = null;
      }
    };

    clientInStream.on('close', cleanupClient);
    if (isHttp1Response && clientInReadable) {
      clientInReadable.on('close', cleanupClient);
    }

    const maxRetries = 2;
    const triedBackends = [];

    function attemptForwardXhttp(attempt = 0) {
      const isClientDead = isHttp1Response ? (clientInStream.writableEnded || clientInStream.destroyed) : (clientInStream.destroyed || clientInStream.closed);
      if (isClientDead) {
        cleanupClient();
        return;
      }

      const backendSni = getNextWorkerBackend(triedBackends, getCachedCfAccounts());
      triedBackends.push(backendSni);
      const remoteHostHeader = backendSni;

      const outHeaders = {
        ...baseHeaders,
        ':authority': backendSni
      };

      if (attempt === 0) {
        console.log(`------------------------------------------------------------\n` +
                    `[${protoLabel} #${clientTag}] 收到流式请求:\n` +
                    `  📥 [客户端入站 Ingress]\n` +
                    `     • 客户端来源: ${clientTag}\n` +
                    `     • 客户端 Host/Authority: ${headers[':authority'] || headers['host'] || '未指定'}\n` +
                    `     • 请求方式 Method: ${clientMethod}\n` +
                    `     • 客户端原始请求路径: ${rawPath}\n` +
                    `  📤 [网关转发出站 Egress]\n` +
                    `     • 实际 Server: ${connectHost}:${connectPort}\n` +
                    `     • 实际 TLS SNI: ${backendSni} (Worker后端)\n` +
                    `     • 实际 HTTP Host: ${remoteHostHeader}\n` +
                    `     • 实际请求路径: ${cleanedPath}\n` +
                    `------------------------------------------------------------`);
      } else {
        console.warn(`[XHTTP Failover #${clientTag}] 🔄 正在透明故障转移至备用 Worker 后端 (第 ${attempt} 次重试): ${backendSni}`);
      }

      let sessionWrap;
      try {
        sessionWrap = getOrCreateH2Session(connectHost, connectPort, backendSni);
      } catch (err) {
        if (!isBenignError(err)) {
          console.error(`[XHTTP Session Init Error #${clientTag}]:`, err.message);
          markBackendFailure(backendSni, err.message, metrics);
          recordPreferActivity(targetServer, clientTag, null, 'error', err.message);
        }
        if (attempt < maxRetries) {
          attemptForwardXhttp(attempt + 1);
          return;
        }
        if (isHttp1Response) {
          if (!clientInStream.headersSent) clientInStream.writeHead(502);
          clientInStream.end();
        } else {
          try { clientInStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch {}
        }
        cleanupClient();
        return;
      }

      const { session: cfSession, poolKey, isReused } = sessionWrap;
      currentPoolKey = poolKey;

      let outReq;
      try {
        outReq = cfSession.request(outHeaders);
        currentOutReq = outReq;
      } catch (err) {
        releaseH2Session(poolKey);
        if (attempt < maxRetries) {
          attemptForwardXhttp(attempt + 1);
          return;
        }
        if (isHttp1Response) {
          if (!clientInStream.headersSent) clientInStream.writeHead(502);
          clientInStream.end();
        } else {
          try { clientInStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch {}
        }
        cleanupClient();
        return;
      }

      for (const chunk of initialChunks) {
        try { outReq.write(chunk); } catch {}
      }
      if (isClientEnded) {
        try { outReq.end(); } catch {}
      }

      const startTime = Date.now();

      outReq.on('response', (inHeaders) => {
        const status = inHeaders[':status'];
        const elapsed = Date.now() - startTime;

        if (status === 200) {
          isHandshakeSuccess = true;
          markBackendSuccess(backendSni);
          recordPreferActivity(targetServer, clientTag, elapsed, 'ok');
          console.log(`[${protoLabel} #${clientTag}] ✅ 握手成功: 状态码 200 (耗时: ${elapsed}ms, H2连接池复用: ${isReused ? '是' : '否'}) | 实际 Server: ${connectHost}:${connectPort} | SNI: ${backendSni}`);

          if (isHttp1Response) {
            const h1Headers = {};
            for (const [k, v] of Object.entries(inHeaders)) {
              if (!k.startsWith(':') && !['connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase())) {
                h1Headers[k] = v;
              }
            }
            clientInStream.writeHead(status, h1Headers);
            outReq.pipe(clientInStream);
          } else {
            clientInStream.respond(inHeaders);
            outReq.pipe(clientInStream);
          }
          return;
        }

        const canRetry = attempt < maxRetries && (status === 1101 || status === 429 || status === 502 || status === 503 || status === 403 || status === 521 || status === 522);
        if (canRetry) {
          markBackendFailure(backendSni, `HTTP 状态码: ${status}`, metrics);
          recordPreferActivity(targetServer, clientTag, elapsed, 'warn', `HTTP ${status}`);
          console.warn(`[${protoLabel} Failover #${clientTag}] ⚠️ 响应阻断状态码: ${status}，透明切换备用 Worker 重试...`);
          try { outReq.destroy(); } catch {}
          releaseH2Session(poolKey);
          attemptForwardXhttp(attempt + 1);
          return;
        }

        if (status >= 400) {
          markBackendFailure(backendSni, `HTTP 状态码: ${status}`, metrics);
          recordPreferActivity(targetServer, clientTag, elapsed, 'warn', `HTTP ${status}`);
        }

        if (isHttp1Response) {
          const h1Headers = {};
          for (const [k, v] of Object.entries(inHeaders)) {
            if (!k.startsWith(':') && !['connection', 'keep-alive', 'transfer-encoding'].includes(k.toLowerCase())) {
              h1Headers[k] = v;
            }
          }
          clientInStream.writeHead(status, h1Headers);
          outReq.pipe(clientInStream);
        } else {
          clientInStream.respond(inHeaders);
          outReq.pipe(clientInStream);
        }
      });

      outReq.on('error', (err) => {
        if (!isHandshakeSuccess && attempt < maxRetries) {
          if (!isBenignError(err)) {
            console.warn(`[XHTTP Egress Error #${clientTag} (${backendSni})]:`, err.message);
            markBackendFailure(backendSni, err.message, metrics);
          }
          try { outReq.destroy(); } catch {}
          releaseH2Session(poolKey);
          attemptForwardXhttp(attempt + 1);
          return;
        }

        if (!isBenignError(err)) {
          console.error(`[XHTTP CF Request Error #${clientTag}]:`, err.message);
          markBackendFailure(backendSni, err.message, metrics);
        }
        if (isHttp1Response) {
          try { clientInStream.end(); } catch {}
        } else {
          try { clientInStream.close(http2.constants.NGHTTP2_INTERNAL_ERROR); } catch {}
        }
        cleanupClient();
      });

      outReq.on('close', () => {
        releaseH2Session(poolKey);
      });
    }

    attemptForwardXhttp(0);
  }

  const isolatedH2Server = http2.createServer();
  isolatedH2Server.on('stream', (stream, headers) => {
    if (metrics) metrics.h2cRequests++;
    handleWorkerForward(stream, headers, headers[':path'] || '/', headers[':method'] || 'POST', 'XHTTP/H2C', false);
  });

  const isolatedH1Server = http.createServer((req, res) => {
    if (metrics) metrics.h1Requests++;
    handleWorkerForward(res, req.headers, req.url || '/', req.method || 'POST', 'XHTTP/H1.1-POST', true, req);
  });

  return {
    listen(port, host, callback) {
      isolatedH2Server.listen(0, '127.0.0.1', () => {
        isolatedH1Server.listen(0, '127.0.0.1', () => {
          const h2InternalPort = isolatedH2Server.address().port;
          const h1InternalPort = isolatedH1Server.address().port;

          const mainGateway = net.createServer((socket) => {
            const realClientAddress = (socket.remoteAddress || '未知') + ':' + (socket.remotePort || '');
            socket.on('error', (err) => {
              if (!isBenignError(err)) socket.destroy();
            });

            socket.once('data', (chunk) => {
              const isH2c = chunk.length >= 24 && chunk.toString('utf8', 0, 24) === 'PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n';
              const targetPort = isH2c ? h2InternalPort : h1InternalPort;

              const targetSocket = net.connect(targetPort, '127.0.0.1', () => {
                clientIpMap.set(targetSocket.localPort, realClientAddress);
                targetSocket.write(chunk);
                socket.pipe(targetSocket);
                targetSocket.pipe(socket);
              });

              targetSocket.on('close', () => {
                clientIpMap.delete(targetSocket.localPort);
              });
              targetSocket.on('error', () => {
                socket.destroy();
              });
            });
          });

          mainGateway.listen(port, host, callback);
        });
      });
    }
  };
}
