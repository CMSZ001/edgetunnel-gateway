import fs from 'node:fs';
import { TRAFFIC_HISTORY_FILE, currentConfig } from './config.mjs';

export const trafficHistory = [];
let lastSampleXhttp = 0;
let lastSampleWs = 0;
let trafficSamplerTimer = null;

// 初始化历史流量 (从持久化文件加载或生成基线)
export function initTrafficBaseline() {
  try {
    if (fs.existsSync(TRAFFIC_HISTORY_FILE)) {
      const saved = JSON.parse(fs.readFileSync(TRAFFIC_HISTORY_FILE, 'utf8'));
      if (Array.isArray(saved) && saved.length > 0) {
        trafficHistory.push(...saved);
        console.log(`[Traffic History] 已从持久化文件恢复 ${saved.length} 个历史采样点`);
        return;
      }
    }
  } catch (err) {
    console.warn(`[Traffic History] 读取持久化历史数据失败: ${err.message}`);
  }

  const now = Date.now();
  for (let i = 11; i >= 0; i--) {
    const t = new Date(now - i * 5 * 60 * 1000);
    const timeStr = `${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
    trafficHistory.push({
      time: timeStr,
      xhttp: 0,
      ws: 0
    });
  }
}

export function recordTrafficSample(metrics) {
  const now = new Date();
  const timeStr = `${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`;
  const curX = metrics?.xhttpRequests || 0;
  const curW = metrics?.wsRequests || 0;

  const dx = Math.max(0, curX - lastSampleXhttp);
  const dw = Math.max(0, curW - lastSampleWs);
  lastSampleXhttp = curX;
  lastSampleWs = curW;

  trafficHistory.push({
    time: timeStr,
    xhttp: curX,
    ws: curW,
    deltaXhttp: dx,
    deltaWs: dw
  });

  if (trafficHistory.length > 24) {
    trafficHistory.shift();
  }

  try {
    fs.writeFileSync(TRAFFIC_HISTORY_FILE, JSON.stringify(trafficHistory, null, 2), 'utf8');
  } catch (err) {}
}

export function startTrafficSampler(metrics) {
  if (trafficSamplerTimer) clearInterval(trafficSamplerTimer);
  const minutes = Math.max(1, parseInt(currentConfig.trafficSampleMinutes || '5', 10));
  trafficSamplerTimer = setInterval(() => recordTrafficSample(metrics), minutes * 60 * 1000);
  console.log(`[Traffic Sampler] 走势图采样频率已热更新为: 每 ${minutes} 分钟一次`);
}
