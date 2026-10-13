export function parsePreferAndCleanPath(rawPath) {
  let targetServer = null;
  let cleanedPath = rawPath;

  const preferMatch = rawPath.match(/[?&]prefer=([^&/]+)/i);
  if (preferMatch) {
    try {
      let decoded = preferMatch[1];
      for (let i = 0; i < 3; i++) {
        if (!decoded.includes('%')) break;
        const next = decodeURIComponent(decoded);
        if (next === decoded) break;
        decoded = next;
      }
      targetServer = decoded.replace(/%3a/gi, ':').trim();
    } catch {
      targetServer = preferMatch[1].replace(/%3a/gi, ':').trim();
    }
  }

  cleanedPath = cleanedPath
    .replace(/[?&]prefer=[^&/]+/gi, '')
    .replace(/\?&/, '?')
    .replace(/&&+/, '&')
    .replace(/[?&]$/, '')
    .replace(/\/+$/, '');

  if (cleanedPath === '') cleanedPath = '/';
  return { targetServer, cleanedPath };
}

export function getSafeHttp2ConnectUrl(connectHost, connectPort) {
  const isIpv6 = connectHost.includes(':') && !connectHost.startsWith('[');
  const formattedHost = isIpv6 ? `[${connectHost}]` : connectHost;
  return `https://${formattedHost}:${connectPort}`;
}

export function isBenignError(err) {
  if (!err) return false;
  const msg = err.message || '';
  const code = err.code || '';
  return (
    code === 'ECONNRESET' ||
    code === 'EPIPE' ||
    code === 'ETIMEDOUT' ||
    code === 'ERR_STREAM_PREMATURE_CLOSE' ||
    code === 'ERR_STREAM_DESTROYED' ||
    code === 'ERR_HTTP2_INVALID_STREAM' ||
    code === 'ERR_HTTP2_STREAM_CANCEL' ||
    code === 'ERR_HTTP2_STREAM_ERROR' ||
    code === 'ERR_HTTP2_SESSION_ERROR' ||
    msg.includes('premature close') ||
    msg.includes('socket hang up') ||
    msg.includes('Client aborted') ||
    msg.includes('stream has been destroyed') ||
    msg.includes('The stream has been destroyed') ||
    msg.includes('ERR_HTTP2_STREAM_CANCEL') ||
    msg.includes('Stream closed')
  );
}
