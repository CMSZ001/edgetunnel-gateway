# ☁️ Cloudflare 额度监控与联动 (Cloudflare Quota Monitoring)

**EdgeTunnel Gateway** 创新性地将出站分流负载均衡与 **Cloudflare 官方配额监控** 打通。通过每 5 分钟后台静默巡检，监控中心能够实时反映各子账户当日的使用情况，并在配额接近饱和时自动触发调度避让。

---

## 📊 1. 监控双模式对比

网关提供了两种配额抓取模式，用户可根据自身习惯自由选择：

| 维度 | 模式 B: 官方 API 直连模式 (Direct，强烈推荐) | 模式 A: UsagePanel 镜像模式 |
| :--- | :--- | :--- |
| **工作原理** | 网关直接使用用户提供的 API Token 请求 Cloudflare GraphQL 官方接口 | 网关通过内置同源反代代理连接已部署的 [UsagePanel](https://github.com/cmliu/CF-Workers-UsagePanel) 面板 |
| **部署依赖** | **零外部依赖**，无需部署额外的 UsagePanel 服务 | 需事先部署并维护一个 UsagePanel Pages/Worker 实例 |
| **数据实时性** | 极高，毫秒级直连官方 GraphQL 获取精确统计 | 依赖第三方面板自身同步周期 |
| **安全性** | 凭据本地加盐哈希存储在 NAS 内部，不出局域网 | 需在网关中填写面板管理员账号与密码 |
| **支持指标** | Workers、Pages、KV、D1、R2 请求与容量多维解构 | 呈现 UsagePanel 已解析的各账户概览 |

---

## 🔑 2. 配置模式 B：Cloudflare 官方 API 直连 (Direct)

### 步骤 1：获取 Account ID
1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)；
2. 在任意域名或 Workers 页面右侧栏中，复制 **Account ID（账户 ID）**。

### 步骤 2：创建只读 API Token
1. 点击右上角头像 -> **My Profile (我的个人资料)** -> **API Tokens (API 令牌)**；
2. 点击 **Create Token (创建令牌)** -> 选择 **Create Additional Tokens (自定义令牌)**；
3. 设定令牌名称（如 `edgetunnel-quota-readonly`）；
4. **配置权限 (Permissions)**（只需只读权限）：
   - `Account` -> `Account Analytics` -> `Read` (读取分析数据)
   - `Account` -> `Workers Scripts` -> `Read` (读取脚本信息)
5. **Account Resources**：选择 `All accounts` 或包含你的目标账户；
6. 创建并复制生成的 API Token。

### 步骤 3：在网关 Web 控制台录入
1. 打开网关控制台，进入 **“CF 额度面板”** 选项卡；
2. 切换至 **“模式 B：Cloudflare 官方 API 直连”**；
3. 点击 **“➕ 添加账户凭据”**：
   - **账户别名**：如 `主账户-01`；
   - **Account ID**：填入步骤 1 复制的 ID；
   - **API Token**：填入步骤 2 复制的令牌；
4. 点击 **“💾 保存并测试直连”**，网关将立即执行握手校验，验证成功后开始静默巡检。

---

## 🌐 3. 配置模式 A：UsagePanel 镜像模式

若你已部署了 [cmliu/CF-Workers-UsagePanel](https://github.com/cmliu/CF-Workers-UsagePanel)：
1. 打开网关控制台，进入 **“CF 额度面板”** 选项卡；
2. 切换至 **“模式 A：UsagePanel 镜像模式”**；
3. 填入你的 UsagePanel 面板访问地址（如 `https://usagepanel.pages.dev`）与面板管理员账号密码；
4. 点击 **“💾 保存配置并同步”**，网关内置的同源反向代理将自动接管会话 Cookie，无需二次登录即可在内网直连嵌入查看原版面板界面。

---

## ⚙️ 4. 调度联动：Cloudflare 额度自动避让机制

网关不仅仅是在页面上“展示”额度，而是深度将额度数据与底层负载均衡调度绑定：

```text
后台巡检 (每 5 分钟) ──► 解析子账户当日消耗 ──► 判断使用率是否 ≥ 95%
                                                 ├─ 是 ─► 将该账户绑定的后端域名【移出可用池】进行断流保护
                                                 └─ 否 ─► 保持正常轮询分流
```

- **配置位置**：Web 控制台 **【⚙️ 核心配置】** -> **Cloudflare 额度自动避让阈值**（默认 95%）；
- **全节点超限降级保护**：当你的所有 Cloudflare 子账户全部超过 95% 时，网关会自动降级保留全部节点，绝不断网！

---

## 📢 5. Telegram 精准预警与 SOCKS5 代理通道

当子账户额度突破预警阈值（默认 80%）或遇到致命故障时，网关可通过 Telegram Bot 及时推送告警通知。

### 关键特性
1. **15 分钟节流防轰炸**：同一账户在 15 分钟内最多只推送一次告警，避免由于瞬时高频请求导致刷屏；
2. **直通旁路由出境 (SOCKS5 代理)**：
   - NAS 处于纯国内网络时，无法直连 `api.telegram.org`；
   - 在核心配置中配置 `TG_PROXY=socks5://10.10.10.1:7890`，网关会通过内网旁路由（如 Mihomo / Clash）将 Telegram 请求转发至外网，安全可靠。

### 配置与连通性测试
在 Web 控制台 **“🔔 Telegram 配置”** 选项卡中，填入 Bot Token、Chat ID 与 SOCKS5 代理地址，点击 **“📡 发送测试消息”**，若配置正确，你的 Telegram 会立刻收到来自网关的测试握手推送！
