/**
 * Sub-Store 节点转换脚本：自动对接局域网 Macvlan 双引擎分流网关
 * 逻辑：
 * - WS 节点 -> 指向 10.10.10.35:8787 (原生 HTTP/1.1 WebSocket)
 * - XHTTP 节点 -> 指向 10.10.10.35:8788 (原生 HTTP/2 / H1.1 自适应)
 * - 自动把优选 IP 与端口打包进 prefer 参数 (并清除末尾冗余斜杠)
 * - 原原本本保留节点原有的 Host、UUID 等所有自定义头部与信息
 */
function operator(proxies, targetPlatform) {
    const LOCAL_GATEWAY_IP = '10.10.10.35';
    const PORT_WS = 8787;
    const PORT_XHTTP = 8788;

    return proxies.map(proxy => {
        if (proxy.type && proxy.type.toLowerCase() === 'vless') {
            const originalServer = String(proxy.server || '').trim().replace(/\/+$/, '');
            const originalPort = proxy.port || 443;
            const prefer = originalPort === 443 ? originalServer : `${originalServer}:${originalPort}`;

            // 判断是否为 XHTTP 协议节点
            const isXhttp = (proxy.network && (proxy.network.toLowerCase() === 'xhttp' || proxy.network.toLowerCase() === 'splithttp')) ||
                            proxy['xhttp-opts'] || proxy['splithttp-opts'];

            // 1. 设置目标 IP 与对应的专用引擎端口
            proxy.server = LOCAL_GATEWAY_IP;
            proxy.port = isXhttp ? PORT_XHTTP : PORT_WS;

            // 2. 局域网关闭 TLS
            proxy.tls = false;
            delete proxy.sni;
            delete proxy.ech;
            delete proxy.fingerprint;
            delete proxy.alpn;

            // 3. 将原本的优选服务器及端口注入到 Path 中，并清理冗余末尾斜杠
            const appendPrefer = (p) => {
                if (!p) return `/?prefer=${encodeURIComponent(prefer)}`;
                const cleanP = p.replace(/\/+$/, '');
                return cleanP.includes('?') 
                    ? `${cleanP}&prefer=${encodeURIComponent(prefer)}` 
                    : `${cleanP}?prefer=${encodeURIComponent(prefer)}`;
            };

            // 原原本本保留节点原有的 Host 与其它配置，不再删除任何 Host
            if (proxy['ws-opts']) {
                proxy['ws-opts'].path = appendPrefer(proxy['ws-opts'].path);
            }

            if (proxy['xhttp-opts']) {
                proxy['xhttp-opts'].path = appendPrefer(proxy['xhttp-opts'].path);
            }

            if (proxy['splithttp-opts']) {
                proxy['splithttp-opts'].path = appendPrefer(proxy['splithttp-opts'].path);
            }
        }
        return proxy;
    });
}
