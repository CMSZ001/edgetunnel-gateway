import crypto from 'node:crypto';
import { currentConfig } from './config.mjs';

export const authSessions = new Map();

export function hashPassword(password, salt) {
  return crypto.createHash('sha256').update(password + ':' + salt).digest('hex');
}

export function checkAuth(req) {
  const auth = currentConfig.auth;
  // 若尚未初始化密码，放行以便引导用户首次设置
  if (!auth || !auth.passwordHash) return true;

  const authHeader = req.headers['authorization'] || '';
  let token = authHeader.startsWith('Bearer ') ? authHeader.substring(7).trim() : null;
  if (!token) {
    try {
      const url = new URL(req.url, 'http://localhost');
      token = url.searchParams.get('token');
    } catch {}
  }
  if (!token) return false;
  const sess = authSessions.get(token);
  if (!sess) return false;
  if (Date.now() > sess.expiresAt) {
    authSessions.delete(token);
    return false;
  }
  return true;
}

export function createSession(username, durationDays = 7) {
  const token = crypto.randomBytes(32).toString('hex');
  authSessions.set(token, {
    username,
    expiresAt: Date.now() + durationDays * 24 * 3600 * 1000
  });
  return token;
}

export function cleanExpiredSessions() {
  const now = Date.now();
  let cleaned = 0;
  for (const [token, sess] of authSessions.entries()) {
    if (sess.expiresAt && now > sess.expiresAt) {
      authSessions.delete(token);
      cleaned++;
    }
  }
  return cleaned;
}
