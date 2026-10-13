import https from 'node:https';
import { currentConfig } from './config.mjs';
import { sendTelegramRawText } from './telegram.mjs';

let quotaPatrolTimer = null;
export let cachedCfAccounts = null;
export let lastCfAccountsFetch = 0;
const cfAlertedToday = new Set();

// 功能 1: 后台自动额度巡检与实时数据同步 (每 5 分钟静默更新一次，兼顾直连模式与面板模式)
export function startQuotaPatrol() {
  if (quotaPatrolTimer) clearInterval(quotaPatrolTimer);

  const doPatrol = async () => {
    const mode = currentConfig.cfQuotaMode || 'usagepanel';
    const hasConfig = (mode === 'direct' && (currentConfig.cfDirect?.accounts || []).length > 0) ||
                      (mode !== 'direct' && currentConfig.cfPanel?.username && currentConfig.cfPanel?.password);
    if (!hasConfig) return;

    console.log(`[CF Quota Patrol] 后台静默拉取子账户最新额度数据 (${mode === 'direct' ? '官方 API 直连' : 'UsagePanel 镜像'})...`);
    try {
      await getCfSubAccounts(true);
    } catch (err) {
      console.warn(`[CF Quota Patrol] 巡检出现异常: ${err.message}`);
    }
  };

  // 启动 2 秒后立即执行一次初始拉取
  setTimeout(doPatrol, 2000);

  // 后台每 5 分钟自动拉取一次最新额度，保障监控中心实时联动！
  const minutes = Math.max(1, parseInt(currentConfig.cfQuotaIntervalMinutes || '5', 10));
  quotaPatrolTimer = setInterval(doPatrol, minutes * 60 * 1000);
}

// ================= Cloudflare 多账户额度自动拉取与预警 =================
// cachedCfAccounts exported above
// lastCfAccountsFetch exported above
// cfAlertedToday defined above

// ================= 通用 Cloudflare 额度告警触发器 =================
export function checkAndTriggerQuotaAlert(accounts) {
  if (!Array.isArray(accounts)) return;
  const threshold = Math.max(1, Math.min(100, Number(currentConfig.cfAlertThreshold || currentConfig.cfPanel?.alertThreshold || 80)));
  const todayStr = new Date().toISOString().slice(0, 10);

  for (const acc of accounts) {
    if (!acc || acc.error) continue;
    const alertKey = `${todayStr}-${acc.id}-${threshold}`;
    if (acc.percent >= threshold && !cfAlertedToday.has(alertKey)) {
      cfAlertedToday.add(alertKey);
      const totalStr = (acc.total || 0).toLocaleString();
      const maxStr = (acc.max || 100000).toLocaleString();
      const pctStr = (acc.percent || 0).toFixed(1);
      const wStr = (acc.workers || 0).toLocaleString();
      const pStr = (acc.pages || 0).toLocaleString();

      const alertMsg = `⚠️ *【Cloudflare 额度预警】*\n\n` +
        `• *账户名称*: ${acc.name}\n` +
        `• *今日请求*: ${totalStr} / ${maxStr} (${pctStr}%)\n` +
        `• *Workers*: ${wStr} | *Pages*: ${pStr}\n` +
        `• *已达告警阈值*: ${threshold}%\n\n` +
        `💡 请注意分流均衡或适时切换优选后端。`;

      sendTelegramRawText(alertMsg).catch(() => {});
      console.warn(`[CF Quota Alert] 账户 ${acc.name} 达到 ${pctStr}% (设定阈值: ${threshold}%)，已触发 Telegram 告警推送`);
    }
  }
}

// ================= Cloudflare 官方 API 直连模块 (模式 B) =================
const R2_CLASS_A_ACTIONS = new Set([
  'listbuckets', 'putbucket', 'listobjects', 'listobjectsv2', 'putobject', 'copyobject',
  'completemultipartupload', 'createmultipartupload', 'lifecyclestoragetiertransition',
  'listmultipartuploads', 'uploadpart', 'uploadpartcopy', 'listparts',
  'putbucketencryption', 'putbucketcors', 'putbucketlifecycleconfiguration'
]);
const R2_CLASS_B_ACTIONS = new Set([
  'headbucket', 'headobject', 'getobject', 'usagesummary', 'getbucketencryption',
  'getbucketlocation', 'getbucketcors', 'getbucketlifecycleconfiguration'
]);
const R2_FREE_ACTIONS = new Set(['deleteobject', 'deleteobjects', 'deletebucket', 'abortmultipartupload']);

function getCfTimeWindow() {
  const now = new Date();
  const dayStart = new Date(now);
  dayStart.setUTCHours(0, 0, 0, 0);
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));

  return {
    nowIso: now.toISOString(),
    dayStartIso: dayStart.toISOString(),
    monthStartIso: monthStart.toISOString(),
    dayStartDate: dayStart.toISOString().slice(0, 10),
    monthStartDate: monthStart.toISOString().slice(0, 10),
    dateEnd: now.toISOString().slice(0, 10)
  };
}

function pickLatestGroups(groups, idField, timeField) {
  const latest = new Map();
  for (const group of groups || []) {
    const dimensions = group?.dimensions || {};
    const id = dimensions[idField] || '__account';
    const time = String(dimensions[timeField] || '');
    const current = latest.get(id);
    if (!current || time >= current.time) {
      latest.set(id, { time, group });
    }
  }
  return Array.from(latest.values()).map(item => item.group);
}

function cfApiRequest(pathname, token, options = {}) {
  return new Promise((resolve, reject) => {
    const isPost = options.method === 'POST';
    const postData = options.body ? JSON.stringify(options.body) : null;

    const reqOptions = {
      hostname: 'api.cloudflare.com',
      port: 443,
      path: pathname,
      method: options.method || 'GET',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'User-Agent': 'EdgeTunnel-LB-CF-Direct/2.0'
      },
      family: 4,
      timeout: 15000
    };

    if (isPost && postData) {
      reqOptions.headers['Content-Length'] = Buffer.byteLength(postData);
    }

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data);
          resolve({ status: res.statusCode, data: parsed });
        } catch (err) {
          resolve({ status: res.statusCode, raw: data, error: err.message });
        }
      });
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('Cloudflare 官方 API 请求超时(>15s)'));
    });

    if (isPost && postData) {
      req.write(postData);
    }
    req.end();
  });
}

export async function getCfDirectAccounts(force = false) {
  const accounts = currentConfig.cfDirect?.accounts || [];
  if (accounts.length === 0) {
    return { ok: false, needAuth: true, message: '尚未配置 Cloudflare 官方 API 直连账户（请在【配置凭据】添加 Account ID 与 API Token）' };
  }

  if (!force && cachedCfAccounts && cachedCfAccounts.mode === 'direct' && (Date.now() - lastCfAccountsFetch < 60000)) {
    return cachedCfAccounts;
  }

  const tw = getCfTimeWindow();
  console.log(`[CF Direct API] 开始轮询 ${accounts.length} 个 Cloudflare 官方子账户配额 (UTC 时间窗口: ${tw.dayStartIso})...`);

  const results = await Promise.all(accounts.map(async (acc, idx) => {
    const accId = (acc.accountId || '').trim();
    const token = (acc.apiToken || '').trim();
    const name = acc.name || `CF 账户 ${idx + 1}`;

    if (!accId || !token) {
      return {
        id: acc.id || `acc-${idx}`,
        name,
        accountId: accId || '未配置',
        updateTime: new Date().toISOString(),
        workers: 0,
        pages: 0,
        total: 0,
        max: 100000,
        percent: 0,
        error: '未配置 Account ID 或 API Token',
        resources: {
          kv: { namespaces: 0, reads: 0, readsLimit: 100000, writes: 0, writesLimit: 1000, storageBytes: 0, storageLimitBytes: 1073741824 },
          d1: { databases: 0, rowsRead: 0, rowsReadLimit: 5000000, rowsWritten: 0, rowsWrittenLimit: 100000, storageBytes: 0, storageLimitBytes: 5368709120 },
          r2: { buckets: 0, classA: 0, classALimit: 1000000, classB: 0, classBLimit: 10000000, storageBytes: 0, storageLimitBytes: 10737418240 }
        }
      };
    }

    try {
      // 1. GraphQL: Workers 与 Pages 请求数
      const wpQuery = {
        query: `query getBillingMetrics($AccountID: String!, $filter: AccountWorkersInvocationsAdaptiveFilter_InputObject) {
          viewer { accounts(filter: {accountTag: $AccountID}) {
            pagesFunctionsInvocationsAdaptiveGroups(limit: 1000, filter: $filter) { sum { requests } }
            workersInvocationsAdaptive(limit: 10000, filter: $filter) { sum { requests } }
          } }
        }`,
        variables: {
          AccountID: accId,
          filter: { datetime_geq: tw.dayStartIso, datetime_leq: tw.nowIso }
        }
      };

      // 2. GraphQL: KV 操作与存储统计
      const kvQuery = {
        query: `query KvUsage($accountTag: String!, $dayStart: Date!, $dateEnd: Date!, $storageStart: Date!) {
          viewer { accounts(filter: {accountTag: $accountTag}) {
            kvOperationsAdaptiveGroups(limit: 10000, filter: {date_geq: $dayStart, date_leq: $dateEnd}) {
              sum { requests }
              dimensions { actionType }
            }
            kvStorageAdaptiveGroups(limit: 10000, filter: {date_geq: $storageStart, date_leq: $dateEnd}, orderBy: [date_DESC]) {
              max { keyCount byteCount }
              dimensions { date namespaceId }
            }
          } }
        }`,
        variables: {
          accountTag: accId,
          dayStart: tw.dayStartDate,
          dateEnd: tw.dateEnd,
          storageStart: tw.monthStartDate
        }
      };

      // 3. GraphQL: D1 操作与存储统计
      const d1Query = {
        query: `query D1Usage($accountTag: String!, $dayStart: Date!, $dateEnd: Date!, $storageStart: Date!) {
          viewer { accounts(filter: {accountTag: $accountTag}) {
            d1AnalyticsAdaptiveGroups(limit: 10000, filter: {date_geq: $dayStart, date_leq: $dateEnd}) {
              sum { rowsRead rowsWritten readQueries writeQueries }
              dimensions { date databaseId }
            }
            d1StorageAdaptiveGroups(limit: 10000, filter: {date_geq: $storageStart, date_leq: $dateEnd}, orderBy: [date_DESC]) {
              max { databaseSizeBytes }
              dimensions { date databaseId }
            }
          } }
        }`,
        variables: {
          accountTag: accId,
          dayStart: tw.dayStartDate,
          dateEnd: tw.dateEnd,
          storageStart: tw.monthStartDate
        }
      };

      // 4. GraphQL: R2 操作与存储统计
      const r2Query = {
        query: `query R2Usage($accountTag: String!, $monthStart: Time!, $now: Time!) {
          viewer { accounts(filter: {accountTag: $accountTag}) {
            r2OperationsAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}) {
              sum { requests }
              dimensions { actionType actionStatus }
            }
            r2StorageAdaptiveGroups(limit: 10000, filter: {datetime_geq: $monthStart, datetime_leq: $now}, orderBy: [datetime_DESC]) {
              max { objectCount uploadCount payloadSize metadataSize }
              dimensions { datetime bucketName }
            }
          } }
        }`,
        variables: {
          accountTag: accId,
          monthStart: tw.monthStartIso,
          now: tw.nowIso
        }
      };

      const [wpRes, kvRes, d1Res, r2Res] = await Promise.allSettled([
        cfApiRequest('/client/v4/graphql', token, { method: 'POST', body: wpQuery }),
        cfApiRequest('/client/v4/graphql', token, { method: 'POST', body: kvQuery }),
        cfApiRequest('/client/v4/graphql', token, { method: 'POST', body: d1Query }),
        cfApiRequest('/client/v4/graphql', token, { method: 'POST', body: r2Query })
      ]);

      // 处理 Workers & Pages
      let workers = 0;
      let pages = 0;
      if (wpRes.status === 'fulfilled' && wpRes.value?.data?.data?.viewer?.accounts?.[0]) {
        const wpAcc = wpRes.value.data.data.viewer.accounts[0];
        workers = (wpAcc.workersInvocationsAdaptive || []).reduce((s, c) => s + (Number(c?.sum?.requests) || 0), 0);
        pages = (wpAcc.pagesFunctionsInvocationsAdaptiveGroups || []).reduce((s, c) => s + (Number(c?.sum?.requests) || 0), 0);
      } else if (wpRes.status === 'fulfilled' && wpRes.value?.data?.errors?.length > 0) {
        // 权限或版本降级：仅查 Workers
        try {
          const fallbackGql = {
            query: `query GetWorkersOnly($accountTag: String!, $since: String!) {
              viewer { accounts(filter: {accountTag: $accountTag}) {
                workersInvocationsAdaptive(limit: 10000, filter: {datetime_geq: $since}) {
                  sum { requests }
                }
              } }
            }`,
            variables: { accountTag: accId, since: tw.dayStartIso }
          };
          const fbRes = await cfApiRequest('/client/v4/graphql', token, { method: 'POST', body: fallbackGql });
          workers = (fbRes.data?.data?.viewer?.accounts?.[0]?.workersInvocationsAdaptive || []).reduce((s, c) => s + (Number(c?.sum?.requests) || 0), 0);
        } catch {}
      }

      // 处理 KV
      let kvReads = 0, kvWrites = 0, kvDeletes = 0, kvLists = 0, kvOperations = 0;
      let kvNamespaces = 0, kvKeys = 0, kvStorageBytes = 0;
      if (kvRes.status === 'fulfilled' && kvRes.value?.data?.data?.viewer?.accounts?.[0]) {
        const kvAcc = kvRes.value.data.data.viewer.accounts[0];
        for (const g of kvAcc.kvOperationsAdaptiveGroups || []) {
          const reqs = Number(g?.sum?.requests) || 0;
          const act = String(g?.dimensions?.actionType || '').toLowerCase();
          kvOperations += reqs;
          if (act.includes('read')) kvReads += reqs;
          else if (act.includes('write')) kvWrites += reqs;
          else if (act.includes('delete')) kvDeletes += reqs;
          else if (act.includes('list')) kvLists += reqs;
        }
        const kvGroups = pickLatestGroups(kvAcc.kvStorageAdaptiveGroups, 'namespaceId', 'date');
        kvNamespaces = kvGroups.length;
        kvKeys = kvGroups.reduce((tot, g) => tot + (Number(g?.max?.keyCount) || 0), 0);
        kvStorageBytes = kvGroups.reduce((tot, g) => tot + (Number(g?.max?.byteCount) || 0), 0);
      }

      // 处理 D1
      let d1RowsRead = 0, d1RowsWritten = 0, d1ReadQueries = 0, d1WriteQueries = 0;
      let d1Databases = 0, d1StorageBytes = 0;
      if (d1Res.status === 'fulfilled' && d1Res.value?.data?.data?.viewer?.accounts?.[0]) {
        const d1Acc = d1Res.value.data.data.viewer.accounts[0];
        for (const g of d1Acc.d1AnalyticsAdaptiveGroups || []) {
          d1RowsRead += Number(g?.sum?.rowsRead) || 0;
          d1RowsWritten += Number(g?.sum?.rowsWritten) || 0;
          d1ReadQueries += Number(g?.sum?.readQueries) || 0;
          d1WriteQueries += Number(g?.sum?.writeQueries) || 0;
        }
        const d1Groups = pickLatestGroups(d1Acc.d1StorageAdaptiveGroups, 'databaseId', 'date');
        d1Databases = d1Groups.length;
        d1StorageBytes = d1Groups.reduce((tot, g) => tot + (Number(g?.max?.databaseSizeBytes) || 0), 0);
      }

      // 处理 R2
      let r2ClassA = 0, r2ClassB = 0, r2Free = 0, r2Other = 0, r2Operations = 0;
      let r2Buckets = 0, r2Objects = 0, r2StorageBytes = 0;
      if (r2Res.status === 'fulfilled' && r2Res.value?.data?.data?.viewer?.accounts?.[0]) {
        const r2Acc = r2Res.value.data.data.viewer.accounts[0];
        for (const g of r2Acc.r2OperationsAdaptiveGroups || []) {
          const status = String(g?.dimensions?.actionStatus || 'success').toLowerCase();
          if (status && status !== 'success') continue;
          const reqs = Number(g?.sum?.requests) || 0;
          const act = String(g?.dimensions?.actionType || '').replace(/[^a-z0-9]/gi, '').toLowerCase();
          r2Operations += reqs;
          if (R2_CLASS_A_ACTIONS.has(act)) r2ClassA += reqs;
          else if (R2_CLASS_B_ACTIONS.has(act)) r2ClassB += reqs;
          else if (R2_FREE_ACTIONS.has(act)) r2Free += reqs;
          else r2Other += reqs;
        }
        const r2Groups = pickLatestGroups(r2Acc.r2StorageAdaptiveGroups, 'bucketName', 'datetime');
        r2Buckets = r2Groups.length;
        r2Objects = r2Groups.reduce((tot, g) => tot + (Number(g?.max?.objectCount) || 0), 0);
        r2StorageBytes = r2Groups.reduce((tot, g) => tot + (Number(g?.max?.payloadSize) || 0) + (Number(g?.max?.metadataSize) || 0), 0);
      }

      const total = workers + pages;
      const max = 100000;
      const percent = max > 0 ? Math.min(100, Math.round((total / max) * 1000) / 10) : 0;

      return {
        id: acc.id || `acc-${idx}`,
        name,
        accountId: accId,
        updateTime: new Date().toISOString(),
        workers,
        pages,
        total,
        max,
        percent,
        resources: {
          kv: {
            namespaces: kvNamespaces,
            reads: kvReads,
            readsLimit: 100000,
            writes: kvWrites,
            writesLimit: 1000,
            deletes: kvDeletes,
            lists: kvLists,
            deletesLimit: 1000,
            listsLimit: 1000,
            operations: kvOperations,
            storageBytes: kvStorageBytes,
            storageLimitBytes: 1073741824,
            keys: kvKeys,
            period: 'day'
          },
          d1: {
            databases: d1Databases,
            rowsRead: d1RowsRead,
            rowsReadLimit: 5000000,
            rowsWritten: d1RowsWritten,
            rowsWrittenLimit: 100000,
            readQueries: d1ReadQueries,
            writeQueries: d1WriteQueries,
            storageBytes: d1StorageBytes,
            storageLimitBytes: 5368709120,
            period: 'day'
          },
          r2: {
            buckets: r2Buckets,
            classA: r2ClassA,
            classALimit: 1000000,
            classB: r2ClassB,
            classBLimit: 10000000,
            free: r2Free,
            other: r2Other,
            operations: r2Operations,
            storageBytes: r2StorageBytes,
            storageLimitBytes: 10737418240,
            objects: r2Objects,
            period: 'month'
          },
          kvReads,
          kvWrites,
          d1RowsRead,
          r2Operations
        }
      };
    } catch (err) {
      return {
        id: acc.id || `acc-${idx}`,
        name,
        accountId: accId,
        updateTime: new Date().toISOString(),
        workers: 0,
        pages: 0,
        total: 0,
        max: 100000,
        percent: 0,
        error: `API 请求异常: ${err.message}`,
        resources: {
          kv: { namespaces: 0, reads: 0, readsLimit: 100000, writes: 0, writesLimit: 1000, storageBytes: 0, storageLimitBytes: 1073741824 },
          d1: { databases: 0, rowsRead: 0, rowsReadLimit: 5000000, rowsWritten: 0, rowsWrittenLimit: 100000, storageBytes: 0, storageLimitBytes: 5368709120 },
          r2: { buckets: 0, classA: 0, classALimit: 1000000, classB: 0, classBLimit: 10000000, storageBytes: 0, storageLimitBytes: 10737418240 }
        }
      };
    }
  }));

  cachedCfAccounts = {
    ok: true,
    data: results,
    accounts: results,
    mode: 'direct',
    count: results.length,
    updateTime: new Date().toISOString()
  };
  lastCfAccountsFetch = Date.now();
  checkAndTriggerQuotaAlert(results);
  return cachedCfAccounts;
}


export async function getCfSubAccounts(force = false) {
  const mode = currentConfig.cfQuotaMode || "usagepanel";
  if (mode === "direct") {
    return await getCfDirectAccounts(force);
  }
  const cfg = currentConfig.cfPanel || {};
  const targetBase = (cfg.url || currentConfig.cfPanelUrl || 'https://usagepanel.pages.dev').replace(/\/+$/, '');
  const username = cfg.username || '';
  const password = cfg.password || '';

  if (!username || !password) {
    return { ok: false, needAuth: true, message: '尚未配置 CF 额度面板管理员账号与密码' };
  }

  if (!force && cachedCfAccounts && (Date.now() - lastCfAccountsFetch < 60000)) {
    return cachedCfAccounts;
  }

  const agent = new https.Agent({ keepAlive: true, family: 4, timeout: 25000 });

  try {
    const loginPayload = JSON.stringify({ username, password });
    const targetUrlObj = new URL(targetBase);

    // 1. 登录验证
    const loginRes = await new Promise((resolve, reject) => {
      const req = https.request(`${targetUrlObj.protocol}//${targetUrlObj.host}/api/login`, {
        method: 'POST',
        agent,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(loginPayload),
          'Host': targetUrlObj.host,
          'User-Agent': 'EdgeTunnel-LB-Monitor/2.0'
        },
        family: 4,
        timeout: 25000
      }, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('登录接口响应超时(>25s)')); });
      req.write(loginPayload);
      req.end();
    });

    if (loginRes.status !== 200) {
      let errMsg = '登录失败 (HTTP ' + loginRes.status + ')';
      try { const d = JSON.parse(loginRes.body); if (d.msg) errMsg = d.msg; } catch {}
      return { ok: false, error: errMsg };
    }

    const setCookies = loginRes.headers['set-cookie'];
    if (!setCookies) {
      return { ok: false, error: '未获取到登录凭证 Cookie' };
    }
    const cookieHeader = (Array.isArray(setCookies) ? setCookies : [setCookies])
      .map(c => c.split(';')[0]).join('; ');

    // 2. 复用 Keep-Alive 连接高速获取子账户配置数据
    const configRes = await new Promise((resolve, reject) => {
      const req = https.request(`${targetUrlObj.protocol}//${targetUrlObj.host}/admin/config.json`, {
        method: 'GET',
        agent,
        headers: {
          'Cookie': cookieHeader,
          'Host': targetUrlObj.host,
          'User-Agent': 'EdgeTunnel-LB-Monitor/2.0'
        },
        family: 4,
        timeout: 25000
      }, res => {
        let b = '';
        res.on('data', c => b += c);
        res.on('end', () => resolve({ status: res.statusCode, body: b }));
      });
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(new Error('请求配置数据超时(>25s)')); });
      req.end();
    });

    if (configRes.status !== 200) {
      return { ok: false, error: '获取子账户数据失败 (HTTP ' + configRes.status + ')' };
    }

    const rawAccounts = JSON.parse(configRes.body);
    if (!Array.isArray(rawAccounts)) {
      return { ok: false, error: '子账户数据格式异常' };
    }

    const accounts = rawAccounts.map(a => {
      const usage = a.Usage || {};
      const pages = Number(usage.pages) || 0;
      const workers = Number(usage.workers) || 0;
      const total = Number(usage.total) || (pages + workers);
      const max = Number(usage.max) || 100000;
      const percent = max > 0 ? Math.min(100, Math.round((total / max) * 1000) / 10) : 0;

      return {
        id: a.ID,
        name: a.Name || '未命名账户',
        accountId: a.AccountID || a.AccountId || a.accountId || '',
        updateTime: a.UpdateTime,
        pages,
        workers,
        total,
        max,
        percent,
        resources: {
          ...usage.resources,
          kv: usage.resources?.kv || {},
          d1: usage.resources?.d1 || {},
          r2: usage.resources?.r2 || {},
          kvReads: usage.resources?.kv?.reads || 0,
          kvWrites: usage.resources?.kv?.writes || 0,
          d1RowsRead: usage.resources?.d1?.rowsRead || 0,
          r2Operations: usage.resources?.r2?.operations || 0
        }
      };
    });

    cachedCfAccounts = {
      ok: true,
      mode: 'usagepanel',
      updatedAt: Date.now(),
      targetUrl: targetBase,
      accounts
    };
    lastCfAccountsFetch = Date.now();

    // 3. 触发 Telegram 额度报警 (双轨通用)
    checkAndTriggerQuotaAlert(accounts);

    return cachedCfAccounts;
  } catch (err) {
    console.error(`[CF Accounts Fetch] 失败: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    agent.destroy();
  }
}
