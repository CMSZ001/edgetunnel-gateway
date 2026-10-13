import { currentConfig } from './config.mjs';
import { sendTelegramAlert } from './telegram.mjs';

export const backendStats = new Map();
export const backendHealth = new Map();
export const backendFailureCounts = new Map();

export const CIRCUIT_BREAKER_TTL_MS = 60 * 1000;
export const FAILURE_THRESHOLD = 5;

export function recordBackendReq(backend, isSuccess = true) {
  if (!backend) return;
  let s = backendStats.get(backend);
  if (!s) {
    s = { total: 0, success: 0, fail: 0 };
    backendStats.set(backend, s);
  }
  s.total++;
  if (isSuccess) s.success++;
  else s.fail++;
}

export const backendEwma = new Map();
const EWMA_ALPHA = 0.25;
const DEFAULT_INITIAL_RTT = 200;

export function recordBackendLatency(backend, latencyMs) {
  if (!backend || typeof latencyMs !== 'number' || latencyMs <= 0) return;
  const old = backendEwma.get(backend) || DEFAULT_INITIAL_RTT;
  const updated = Math.round(EWMA_ALPHA * latencyMs + (1 - EWMA_ALPHA) * old);
  backendEwma.set(backend, updated);
}

export function isBackendDisabled(backend) {
  return Array.isArray(currentConfig.disabledBackends) && currentConfig.disabledBackends.includes(backend);
}

export function markBackendSuccess(backend, latencyMs = null) {
  recordBackendReq(backend, true);
  if (typeof latencyMs === 'number' && latencyMs > 0) {
    recordBackendLatency(backend, latencyMs);
  }
  backendFailureCounts.set(backend, 0);
  const state = backendHealth.get(backend);
  if (state && !state.isHealthy) {
    console.log(`\x1b[32m[Health Check] 后端 ${backend} 传输成功，熔断解除，静默恢复健康池！\x1b[0m`);
    backendHealth.delete(backend);
  }
}

export function markBackendFailure(backend, reason, metrics = null) {
  recordBackendReq(backend, false);
  if (!reason || 
      reason.includes('Invalid URL') || 
      /ECONNRESET|EPIPE|CANCEL|stream.*destroyed|Client aborted/i.test(reason) ||
      /timeout|超时|ETIMEDOUT/i.test(reason)) {
    return;
  }

  // 失败时适度惩罚当前节点的 EWMA 估算延迟，降低下一次被调度的权重
  const curEwma = backendEwma.get(backend) || DEFAULT_INITIAL_RTT;
  backendEwma.set(backend, Math.min(2500, Math.round(curEwma * 1.5)));

  const now = Date.now();
  const currentFails = (backendFailureCounts.get(backend) || 0) + 1;
  backendFailureCounts.set(backend, currentFails);

  const existing = backendHealth.get(backend);
  if (existing && !existing.isHealthy) return;

  if (currentFails >= FAILURE_THRESHOLD) {
    if (metrics) metrics.circuitTrips++;
    console.warn(`\x1b[33m[Circuit Breaker] ⚠️ 熔断告警: 后端 ${backend} 连续遭遇 ${currentFails} 次明确阻断 [${reason}]，自动隔离 ${CIRCUIT_BREAKER_TTL_MS / 1000} 秒。\x1b[0m`);
    backendHealth.set(backend, {
      isHealthy: false,
      blockUntil: now + CIRCUIT_BREAKER_TTL_MS,
      reason: `连续 ${currentFails} 次失败: ${reason}`
    });
    sendTelegramAlert(backend, reason, metrics);
  } else {
    console.warn(`[Health Check] ⚠️ 后端 ${backend} 遇到异常 [${reason}] (连续失败 ${currentFails}/${FAILURE_THRESHOLD} 次，暂不熔断)`);
  }
}

export function resetAllCircuit() {
  backendHealth.clear();
  backendFailureCounts.clear();
  backendEwma.clear();
  console.log('[Circuit Breaker] 所有后端熔断状态已被手动重置');
}

export function getHealthyBackends(list, excludeBackends = [], cachedCfAccounts = null) {
  const now = Date.now();
  const excludes = Array.isArray(excludeBackends) ? excludeBackends : [excludeBackends].filter(Boolean);

  const enabledList = list.filter(b => !isBackendDisabled(b) && !excludes.includes(b));
  const baseList = enabledList.length > 0 ? enabledList : list.filter(b => !excludes.includes(b));
  if (baseList.length === 0) return list;

  const unblocked = baseList.filter(b => {
    const s = backendHealth.get(b);
    if (!s) return true;
    if (!s.isHealthy && now > s.blockUntil) {
      console.log(`[Circuit Breaker] ⏱️ 后端 ${b} 隔离期已满，重新加入轮询探活。`);
      backendHealth.delete(b);
      return true;
    }
    return s.isHealthy;
  });

  const candidateList = unblocked.length > 0 ? unblocked : baseList;

  const map = currentConfig.backendAccountMap || {};
  const cfAccounts = cachedCfAccounts?.accounts || [];
  if (cfAccounts.length > 0) {
    const safeFromQuota = candidateList.filter(b => {
      const accId = map[b];
      if (!accId) return true;
      const acc = cfAccounts.find(a => (String(a.id) === String(accId) || String(a.accountId) === String(accId) || String(a.name) === String(accId)));
      if (!acc) return true;
      const pct = acc.percent !== undefined ? acc.percent : (acc.total / (acc.max || 100000) * 100);
      const avoidThreshold = Math.max(1, Math.min(100, Number(currentConfig.cfQuotaAvoidThreshold !== undefined ? currentConfig.cfQuotaAvoidThreshold : 95)));
      return pct < avoidThreshold;
    });
    if (safeFromQuota.length > 0) {
      return safeFromQuota;
    }
  }

  return candidateList;
}

// 平滑加权轮询调度（Smooth Weighted Round Robin）
const currentWeightsPages = new Map();
const currentWeightsWorker = new Map();

function selectByEwmaWeighted(candidateList, currentWeightsMap) {
  if (!candidateList || candidateList.length === 0) return null;
  if (candidateList.length === 1) return candidateList[0];

  // 1. 计算各候选节点基于 EWMA 的反比权重
  const weights = [];
  let totalWeight = 0;

  for (const b of candidateList) {
    const ewma = backendEwma.get(b) || DEFAULT_INITIAL_RTT;
    // 延迟越低权重越高，保底权重至少为 1
    const w = Math.max(1, Math.round(1000 / Math.max(ewma, 40)));
    weights.push({ backend: b, weight: w });
    totalWeight += w;
  }

  // 2. 平滑轮询累加并选出瞬时最高权重的节点
  let best = null;
  let maxWeight = -Infinity;

  for (const item of weights) {
    const b = item.backend;
    const cur = (currentWeightsMap.get(b) || 0) + item.weight;
    currentWeightsMap.set(b, cur);

    if (cur > maxWeight) {
      maxWeight = cur;
      best = b;
    }
  }

  // 3. 选中后扣除总权重，保证下一次调度平滑均衡
  if (best) {
    currentWeightsMap.set(best, maxWeight - totalWeight);
    return best;
  }

  return candidateList[0];
}

export function getNextPagesBackend(excludeBackends = [], cachedCfAccounts = null) {
  const full = currentConfig.pagesBackends.length > 0 ? currentConfig.pagesBackends : currentConfig.workerBackends;
  const active = getHealthyBackends(full, excludeBackends, cachedCfAccounts);
  return selectByEwmaWeighted(active, currentWeightsPages);
}

export function getNextWorkerBackend(excludeBackends = [], cachedCfAccounts = null) {
  const full = currentConfig.workerBackends.length > 0 ? currentConfig.workerBackends : currentConfig.pagesBackends;
  const active = getHealthyBackends(full, excludeBackends, cachedCfAccounts);
  return selectByEwmaWeighted(active, currentWeightsWorker);
}

