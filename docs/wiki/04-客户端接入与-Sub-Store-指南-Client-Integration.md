# 📱 客户端接入与 Sub-Store 指南 (Client Integration)

**EdgeTunnel Gateway** 担当局域网统一透明出口网关的角色。内网客户端只需将原本直连 Cloudflare 公网的流量指向局域网网关 IP（如 `10.10.10.35`），即可实现由网关集中调度、优选直连、容错重试与多账户平摊。

---

## ⚠️ 1. 核心接入铁律：为什么客户端必须设置 `tls: false`？

在配置任何客户端节点时，**必须将 TLS 关闭（`tls: false` 或 `security: none`）**：

- **物理机理**：客户端发起请求直连的是局域网内的网关设备（`10.10.10.35`），内网不存在合法的公网 TLS 证书；
- **真实加密位置**：真正的 TLS 1.3 / HTTP/2 加密握手发生在**网关出站连接 Cloudflare 边缘服务器**时，由网关全权负责以真实的 Worker / Pages 域名建立最强加密传输；
- **零安全隐患**：如果客户端直连网关开启了 TLS，会导致局域网证书握手失败报错（`certificate has expired` 或 `self-signed`）。

---

## 🛠️ 2. Sub-Store 订阅节点全自动转换脚本

本项目自带 `substore-operator.js` 脚本，无需手动逐个修改节点，可在 [Sub-Store](https://github.com/sub-store-org/Sub-Store) 中实现一键全自动化转换！

### 脚本工作原理
1. 提取节点原有的优选服务器（域名或 IP+端口），转换为 `prefer=ip:port` 追加在 URL 路径末尾；
2. 将节点服务器地址指向内网网关 **`10.10.10.35`**；
3. **协议自动分流**：WS 节点分流至 **`8787`**，XHTTP 节点分流至 **`8788`**；
4. 将节点 `tls` 设置为 `false`，并自动清洗路径尾部多余斜杠，完整保留节点原有的 Host、UUID 等所有自定义伪装参数。

### 配置步骤
1. 打开 Sub-Store Web 控制台；
2. 进入目标订阅（或组合订阅），添加 **Script Operator (脚本操作)**；
3. 将网关 Web 控制台【客户端配置】选项卡中的 JS 代码复制粘贴到脚本编辑框中（或直接引用仓库中的 `substore-operator.js`）；
4. 保存订阅，客户端拉取到的节点即可全自动对接到局域网网关！

```javascript
/**
 * Sub-Store 节点转换操作脚本示例
 */
function operator(proxies, targetPlatform) {
    const LOCAL_GATEWAY_IP = '10.10.10.35'; // 替换为你的网关局域网 IP
    const PORT_WS = 8787;
    const PORT_XHTTP = 8788;

    return proxies.map(proxy => {
        if (proxy.type && proxy.type.toLowerCase() === 'vless') {
            const originalServer = String(proxy.server || '').trim().replace(/\/+$/, '');
            const originalPort = proxy.port || 443;
            const prefer = originalPort === 443 ? originalServer : `${originalServer}:${originalPort}`;

            const isXhttp = (proxy.network && (proxy.network.toLowerCase() === 'xhttp' || proxy.network.toLowerCase() === 'splithttp')) ||
                            proxy['xhttp-opts'] || proxy['splithttp-opts'];

            proxy.server = LOCAL_GATEWAY_IP;
            proxy.port = isXhttp ? PORT_XHTTP : PORT_WS;

            proxy.tls = false;
            delete proxy.sni;
            delete proxy.ech;
            delete proxy.fingerprint;
            delete proxy.alpn;

            const appendPrefer = (p) => {
                if (!p) return `/?prefer=${encodeURIComponent(prefer)}`;
                const cleanP = p.replace(/\/+$/, '');
                return cleanP.includes('?') 
                    ? `${cleanP}&prefer=${encodeURIComponent(prefer)}` 
                    : `${cleanP}?prefer=${encodeURIComponent(prefer)}`;
            };

            if (proxy['ws-opts']) proxy['ws-opts'].path = appendPrefer(proxy['ws-opts'].path);
            if (proxy['xhttp-opts']) proxy['xhttp-opts'].path = appendPrefer(proxy['xhttp-opts'].path);
            if (proxy['splithttp-opts']) proxy['splithttp-opts'].path = appendPrefer(proxy['splithttp-opts'].path);
        }
        return proxy;
    });
}
```

---

## 📄 3. 典型客户端配置模板

### ① Mihomo (Clash Meta) 配置模板

#### 🔶 XHTTP Worker 节点 (端口 8788)
```yaml
proxies:
  - name: "[GW] 优选节点-XHTTP"
    type: vless
    server: 10.10.10.35     # 网关局域网 IP
    port: 8788              # XHTTP 双模监听端口
    uuid: 00000000-0000-0000-0000-000000000000
    udp: true
    tls: false              # 必须为 false
    network: xhttp
    xhttp-opts:
      host: lb.example.com  # 伪装 Host 保留
      # 携带 prefer=优选目标
      path: /drama/html/album/proxyip=proxyip.example.com?ed=2560&prefer=cf.example.com
      mode: stream-one
      x-padding-obfs-mode: true
      x-padding-key: your_key
      x-padding-header: your_header
      x-padding-placement: queryInHeader
      x-padding-method: tokenish
    encryption: none
```

#### ⚡ WebSocket Pages 节点 (端口 8787)
```yaml
proxies:
  - name: "[GW] 优选节点-WS"
    type: vless
    server: 10.10.10.35     # 网关局域网 IP
    port: 8787              # WS 监听端口
    uuid: 00000000-0000-0000-0000-000000000000
    udp: true
    tls: false              # 必须为 false
    network: ws
    ws-opts:
      path: /redirect.html/about/library/proxyip=104.16.1.1:443?prefer=104.16.1.1:443
      headers:
        Host: pglb.example.com
    encryption: none
```

---

### ② v2rayN 客户端手动配置

1. **协议选择**：VLESS；
2. **地址 (Address)**：填入网关局域网 IP，如 `10.10.10.35`；
3. **端口 (Port)**：
   - 若使用 Worker XHTTP 协议，填 `8788`；
   - 若使用 Pages WebSocket 协议，填 `8787`；
4. **传输协议 (Network)**：选择 `xhttp` 或 `ws`；
5. **底层传输安全 (TLS)**：选择 `none`；
6. **伪装域名 (Host)**：填入原节点 Host；
7. **路径 (Path)**：在原路径尾部追加 `?prefer=你测速出的优选IP:端口`（若原路径已包含 `?`，则用 `&prefer=...`）。

---

### ③ Sing-box 客户端 Outbound 配置片段
```json
{
  "tag": "edgetunnel-out",
  "type": "vless",
  "server": "10.10.10.35",
  "server_port": 8788,
  "uuid": "00000000-0000-0000-0000-000000000000",
  "transport": {
    "type": "http",
    "host": ["lb.example.com"],
    "path": "/drama/html/album?prefer=104.16.1.1:443",
    "method": "POST"
  }
}
```

---

## 🎯 4. 架构职责解耦：优选 IP 故障快速切流哲学

很多用户曾提出疑问：“网关在转发时，如果优选 IP 超时，网关要不要重试其他备用优选 IP？”

网关的架构原则明确指出：**优选 IP 的故障切流彻底交由客户端（Mihomo / Clash）处理！**
- **原因**：网关只掌握节点层面的信息。如果优选 IP 物理断开或网络丢包，若网关在同一个死 IP 上更换 Worker 域名死等重试，会导致客户端干等 20 多秒，严重拖垮网络体验；
- **分工明确**：
  1. **优选 IP 链路层故障（超时、拒绝连接、主机不可达）**：网关毫秒级快速断开，让上游 Mihomo 策略组秒级感知并自动无缝切流到备用优选节点；
  2. **Worker 业务层阻断（1101 脚本崩溃、502 错误、429 配额耗尽）**：此时物理连接畅通，网关在后台利用 128KB 首包动态暂存无感切换备用后端。
