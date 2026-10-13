# local-edgetunnel-lb 本地自适应动态分流网关

[![Docker](https://img.shields.io/badge/Docker-Node%2020--Alpine-2496ED?logo=docker&logoColor=white)](https://hub.docker.com/_/node)
[![License](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Synology%20NAS%20%7C%20Linux-green.svg)]()
[![Architecture](https://img.shields.io/badge/Architecture-Modular%20ESM-orange.svg)]()

专为 **Cloudflare Pages / Workers (EdgeTunnel)** 打造的轻量级高性能局域网自适应负载均衡与智能分流网关。通过 Docker 部署在 NAS / 软路由 / 物理服务器上，赋予独立局域网 IP（Macvlan 模式），为内网全设备（软路由 Mihomo、PC v2rayN、手机等）提供高可用、多域名轮询、握手期透明故障转移、动态优选 IP 透传与多账户额度监控管理服务。

---

## 🌟 核心特性

- ⚡ **多协议独立端口负载均衡**
  - **端口 `8787` (Pages/WebSocket)**：原生 HTTP/1.1 握手转发，实现 101 Switching Protocols 全双工管道代理。
  - **端口 `8788` (Worker/XHTTP)**：**首包嗅探双模自适应**。基于纯净 TCP 环回管道，无缝自动兼容 **Mihomo 原生 H2C (明文 HTTP/2)** 与 **v2rayN (明文 HTTP/1.1 POST 流式)**，单端口无需切换。
  - **端口 `8789` (Web UI & REST API)**：现代化暗色/亮色管理控制台，全域可视化运维。
- 🔄 **握手期透明无感故障转移 (Transparent Failover Retry)**
  - 采用**首包 128KB 动态数据暂存技术**，在握手期遇到 Cloudflare 边缘阻断错误（`1101`、`502`、`429`、`403`、`521`）或网络中断时，网关自动在后台静默重试备用健康节点，对客户端完全透明无感知，杜绝连接闪断。
  - **HTTP/2 会话长连接复用池 (H2 Session Pool)**：按 `Host#SNI` 智能维持出站 H2 活跃连接并定时空闲回收，大幅降低握手往返延迟。
- 🎯 **优选 IP 动态透传、全域感知与实时物理测速**
  - 配合 Sub-Store 脚本自动在请求路径中携带 `prefer=优选IP:端口`；
  - 网关在握手时自动解析并直连该最优优选 IP，同时清洗请求路径，保证远端 Cloudflare 收到的 Path 纯净合法；
  - **活跃优选节点感知**：网关自动收集客户端使用的所有优选 IP/域名，实时展示物理 RTT 往返延迟、请求频次与来源设备，支持一键批量测速、单节点测试与一键设为全局默认。
- ☁️ **Cloudflare 多账户额度监控与后台静默联动**
  - **双模式支持**：原生支持 **Cloudflare 官方 API 直连模式 (Direct)** 与 **UsagePanel 镜像模式**；
  - **每 5 分钟自动静默巡检**：后台定时向 Cloudflare 官方 API 拉取各子账户当日 Workers / Pages / KV / D1 / R2 实时用量；
  - **监控中心毫秒级全自动联动**：监控中心卡片与 CF 额度深度打通，额度变动即时驱动卡片进度条更新，无需手动刷新页面。
- 🛡️ **智能健康检查与自动容错熔断**
  - 单节点连续遭遇 5 次明确阻断后自动隔离 **60 秒**，期间流量平滑切换至其余健康节点；
  - 严格排除优选链路超时与客户端主动断连误判，杜绝误熔断；节点恢复后自动解封归队。
- 📢 **Telegram Bot 智能精准告警**
  - 支持 Telegram 消息推送，兼容直连与 **SOCKS5 / HTTP 代理通道**；
  - 仅对 1101 致命异常与子账户额度超限推送告警，配备 **15 分钟防刷节流机制**，避免通知轰炸。
- 🖥️ **现代化模块化 Web 控制台**
  - 选项卡导航栏具备**零位移吸顶常驻（Sticky Header）**特性，无论页面滚动多深，切换卡片纹丝不动；
  - 单节点启停滑动开关（Switch Toggle）、页面级二次确认防误触弹窗；
  - 实时 SSE (Server-Sent Events) 日志流，支持等级筛选与自动滚屏；
  - 核心配置热重载，并自带历史快照备份与一键回滚机制。

---

## 📐 架构与工作流

```mermaid
graph TD
    Client1["Mihomo 客户端<br/>(原生 H2C / WS, tls: false)"] -->|局域网请求 10.10.10.35| GW["local-edgetunnel-lb 网关<br/>(Docker Macvlan)"]
    Client2["v2rayN 客户端<br/>(HTTP/1.1 POST, tls: false)"] -->|局域网请求 10.10.10.35| GW
    Browser["管理员浏览器<br/>(Web UI 控制台)"] -->|访问 :8789| GW

    subgraph 网关内部处理流程
        GW --> Sniff{"端口流量监听"}
        Sniff -->|:8787 WS 协议| H1Server["HTTP/1.1 WS 负载均衡器"]
        Sniff -->|:8788 XHTTP 协议| LoopbackMux["首包嗅探双模分发器"]
        Sniff -->|:8789 Web 控制台| WebUI["Web 控制台 & REST API<br/>(静态托管 + SSE日志)"]
        
        LoopbackMux -->|检测到 PRI * HTTP/2.0| IsolatedH2["内置 H2C 解析服务器"]
        LoopbackMux -->|检测到 POST HTTP/1.1| IsolatedH1["内置 H1 解析服务器"]
        
        H1Server --> Extract["提取 prefer= 优选 IP<br/>清洗出站 Path"]
        IsolatedH2 --> Extract
        IsolatedH1 --> Extract
        
        Extract --> BufferCheck["首包 128KB 缓冲<br/>+ H2 会话复用池"]
        BufferCheck --> HealthCheck{"健康检测 & 熔断器"}
        HealthCheck -->|阻断/中断| Failover["透明故障转移重试 (最多2次)<br/>无感切换备用后端"]
        HealthCheck -->|正常| LB["后端池轮询出站"]
    end

    LB -->|直连优选IP + 真实SNI/Host + TLS| CF_Pages["Cloudflare Pages 后端池<br/>(pages-*.example.com)"]
    LB -->|直连优选IP + 真实SNI/Host + TLS (H2)| CF_Worker["Cloudflare Worker 后端池<br/>(worker-*.example.com)"]
    WebUI -->|每 5 分钟后台静默轮询| CF_API["Cloudflare 官方 GraphQL API<br/>(多子账户配额拉取)"]
    HealthCheck -.->|触发严重阻断| TG["Telegram 告警推送<br/>(支持 SOCKS5 代理)"]
```

---

## 📁 目录与工程结构

本项目采用**纯原生 ES Modules (ESM) 与纯原生前端资源**架构，零编译打包依赖，改动直接生效：

```text
local-edgetunnel-lb/
├── server.mjs                  # 核心入口：服务监听装配 (8787/8788/8789) 与 REST API 路由
├── lib/                        # 原生后端业务模块
│   ├── config.mjs              # 配置加载、持久化、历史备份与回滚
│   ├── auth.mjs                # 管理员密码加盐哈希与 Bearer Token 会话管理
│   ├── telegram.mjs            # Telegram 消息推送、SOCKS5 代理与自检
│   ├── health.mjs              # 动态熔断隔离 (5次容错)、健康恢复与统计
│   ├── prefer.mjs              # 活跃优选节点感知、TCP 延迟测速与清理
│   ├── traffic.mjs             # 流量历史采样与文件持久化
│   ├── cf-quota.mjs            # Cloudflare 直连API轮询与 5 分钟静默巡检
│   ├── utils.mjs               # 公共工具函数 (安全URL处理、良性错误过滤等)
│   ├── proxy-ws.mjs            # WebSocket (8787) Pages 核心转发代理
│   └── proxy-xhttp.mjs         # XHTTP (8788) Worker 双模网关与透明故障转移
├── public/                     # 原生前端静态资源
│   ├── index.html              # 纯骨架 DOM 结构 (吸顶导航栏、各选项卡容器)
│   ├── css/
│   │   └── style.css           # 样式表 (暗黑/浅色主题、Switch 开关、模态弹窗)
│   └── js/
│       └── app.js              # 控制台脚本 (监控中心、CF额度面板、配置管理、SSE)
├── substore-operator.js        # Sub-Store 订阅节点清洗转换脚本
├── docker-compose.yml          # Docker Compose 容器编排文件
├── config.json                 # 本地运行时持久化配置
└── README.md                   # 项目工程文档
```

---

## 🔌 端口规划一览

| 端口 | 协议 / 模式 | 用途说明 |
| :---: | :---: | :--- |
| **`8787`** | HTTP/1.1 (WS Upgrade) | **Cloudflare Pages (WebSocket)** 专属负载均衡端口 |
| **`8788`** | TCP 首包自适应 (H2C / H1.1) | **Cloudflare Worker (XHTTP)** 专属双模兼容负载均衡端口 |
| **`8789`** | HTTP / REST API | **Web UI 管理控制台** 与健康监控面板 (带密码鉴权) |

---

## ⚙️ 环境变量配置说明 (`docker-compose.yml`)

| 环境变量 | 默认值 / 示例 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `8787` | Pages / WebSocket 负载均衡监听端口 |
| `H2C_PORT` | `8788` | Worker / XHTTP 自适应双模监听端口 |
| `WEB_PORT` | `8789` | Web UI 控制台访问端口 |
| `PREFERRED_SERVER` | `cf.example.com` | 默认兜底优选服务器（节点未携带 `prefer` 时使用） |
| `PAGES_BACKENDS` | `p1.example.com,p2.example.com` | 真实 Pages 后端域名列表（英文逗号分隔） |
| `WORKER_BACKENDS` | `w1.example.com,w2.example.com` | 真实 Worker 后端域名列表（英文逗号分隔） |
| `TRAFFIC_SAMPLE_MINUTES` | `5` | 流量走势图采样频率（单位：分钟） |
| `CF_PANEL_URL` | `https://usagepanel.pages.dev` | UsagePanel 原版后台镜像地址 |
| `TG_BOT_TOKEN` | `123456789:ABC...` | Telegram 机器人 Token（为空则不推送） |
| `TG_CHAT_ID` | `-100123456789` | 接收告警的 Telegram Chat ID |
| `TG_PROXY` | `socks5://10.10.10.1:7890` | Telegram 代理通道（支持 SOCKS5 / HTTP 格式） |

> **提示**：除了环境变量外，网关支持通过 Web UI 界面在线修改任何配置，并持久化保存至 `config.json`，支持自动历史快照备份与随时一键回滚。

---

## 🚀 部署指南 (群晖 NAS / Linux)

### 1. 准备目录与配置文件
以群晖 NAS 为例：
```bash
mkdir -p /volume2/docker/edgetunnel-lb
cd /volume2/docker/edgetunnel-lb
```
将项目文件同步到该目录下，并根据实际网络规划配置 `docker-compose.yml`（推荐使用 `macvlan` 模式分配独立 IP 如 `10.10.10.35`）。

### 2. 启动容器
```bash
docker compose up -d
```

### 3. 查看运行日志
```bash
docker compose logs -f
```
当看到类似以下日志时，代表网关已成功启动并就绪：
```text
============================================================
🚀 EdgeTunnel 本地自适应分流网关已全部启动！(模块化架构版)
   🔌 WebSocket (HTTP/1.1) 监听端口: 8787
      • Pages 后端池: p1.example.com, p2.example.com
   ⚡ XHTTP 双模监听端口:    8788 (兼容 Mihomo H2 与 v2rayN H1)
      • Worker 后端池: w1.example.com, w2.example.com
   🌐 默认实际 Server:     cf.example.com
   🖥️ Web UI 管理控制台:    http://0.0.0.0:8789
   📢 Telegram 告警通知:   已启用 (SOCKS5/代理: socks5://10.10.10.1:7890)
============================================================
```

### 4. 访问 Web 控制台
浏览器访问：`http://<网关IP>:8789/`，初次访问将引导设置管理员密码，登录后即可体验完整的可视化运维功能。

---

## 📱 客户端配置与 Sub-Store 脚本说明

### 1. Sub-Store 脚本配置
本项目包含 `substore-operator.js` 脚本，用于对订阅节点进行全自动化重定向与参数清洗：
1. 打开 Sub-Store Web 界面；
2. 在目标订阅或组合订阅的 **Script Operator（脚本操作）** 中填入 `substore-operator.js`；
3. 该脚本自动完成以下处理：
   - 提取节点原有的优选服务器（域名或 IP+端口），转换为 `prefer=ip:port` 追加在 URL 路径末尾；
   - 将节点服务器地址指向内网网关 **`10.10.10.35`**；
   - 自动分流端口：WS 节点分流至 **`8787`**，XHTTP 节点分流至 **`8788`**；
   - 将节点 `tls` 设置为 `false`，并自动清洗路径尾部多余斜杠，完整保留原有全部伪装与认证参数。

### 2. Mihomo / Clash Meta 节点示例

#### XHTTP 节点 (端口 8788)
```yaml
proxies:
  - name: "[CF] 优选节点-XHTTP"
    type: vless
    server: 10.10.10.35
    port: 8788
    uuid: 00000000-0000-0000-0000-000000000000
    udp: true
    tls: false              # 客户端直连网关，关闭 TLS
    network: xhttp
    xhttp-opts:
      host: lb.example.com  # 伪装域名完整保留
      path: /drama/html/album/proxyip=proxyip.example.com?ed=2560&prefer=cf.example.com
      mode: stream-one
      x-padding-obfs-mode: true
      x-padding-key: your_key
      x-padding-header: your_header
      x-padding-placement: queryInHeader
      x-padding-method: tokenish
    encryption: none
```

#### WebSocket 节点 (端口 8787)
```yaml
proxies:
  - name: "[CF] 优选节点-WS"
    type: vless
    server: 10.10.10.35
    port: 8787
    uuid: 00000000-0000-0000-0000-000000000000
    udp: true
    tls: false              # 客户端直连网关，关闭 TLS
    network: ws
    ws-opts:
      path: /redirect.html/about/library/proxyip=104.16.1.1:443?prefer=104.16.1.1:443
      headers:
        Host: pglb.example.com
    encryption: none
```

---

## ❓ 常见问题 (FAQ)

### Q1: 节点配置里为什么必须设置 `tls: false`？
> **答**：客户端连接的是你局域网内的这台网关（`10.10.10.35`），内网无需也不能进行公网 TLS 证书握手。真正的 TLS 加密握手发生在**网关出站连接 Cloudflare 边缘节点**时，由网关全权负责以真实的 Worker/Pages 域名建立最高强度的 TLS/H2 加密传输。

### Q2: 遇到节点阻断时，客户端会报错断线吗？
> **答**：不会。网关实现了**首包 128KB 内存缓冲机制**。在握手初期如果目标后端返回了 `1101`、`502`、`429`、`521` 等阻断状态码，网关会自动在后台重试切换至备用 Worker/Pages 节点并重放首包数据，整个过程对客户端完全无感，无需客户端重新发起连接。

### Q3: 为什么监控中心的 Cloudflare 额度会自动联动更新？
> **答**：网关后台运行着每 5 分钟周期的静默巡检任务，全自动轮询 Cloudflare 官方 API 并更新本地缓存。监控中心每 3 秒刷新网关状态时，会自动获取最新额度数据，无需手动进入额度面板即可实时联动呈现。

### Q4: 为什么 v2rayN 和 Mihomo 可以共用 8788 同一个端口？
> **答**：Xray-core 在 `security: none` 时会将 XHTTP 退化为标准明文 `HTTP/1.1 POST`，而 Mihomo 在 `tls: false` 时会发送符合 RFC 7540 标准的明文 H2C 握手魔数（`PRI * HTTP/2.0...`）。网关实现了首包字节嗅探，并在毫秒级内通过纯净 TCP 管道分别分流到专有的 H2C 引擎或 H1 引擎，互不干扰且无协议损耗。

### Q5: Cloudflare 额度达到多少会自动暂停使用？可以在核心配置里自定义吗？
> **答**：**默认阈值为 95%**。当某个后端关联绑定的 Cloudflare 子账户当日请求额度使用率达到或超过该阈值时，网关在动态调度轮询时会**自动暂停调度该节点（移出健康池）**，优先将流量引流至其他未超限的子账户后端；若全部节点均超过该阈值，网关会自动降级兜底保留所有节点，防止断网。
> 
> 现在可以在 Web 控制台的 **【⚙️ 核心配置】** 选项卡中自由调整该设置项（**Cloudflare 额度自动避让阈值**，支持 10% ~ 100%，步长 1%），修改后即时热生效并自动持久化。

---

## 📜 许可证

本项目基于 [MIT 许可证](LICENSE) 开源发布。