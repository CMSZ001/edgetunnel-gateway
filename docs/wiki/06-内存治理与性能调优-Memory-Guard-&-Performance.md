# 🧠 内存治理与性能调优指南 (Memory Guard & Performance)

在 7x24 小时长时间运行代理大流量下载、视频串流或多设备并发时，任何微小的 Buffer 积压或对象滞留都会导致网关物理内存缓慢攀升。**EdgeTunnel Gateway** 独创了全方位 **Memory Guard 内存治理与自动回收体系**，确保网关物理常驻内存（RSS）长期稳定维持在 **50MB ~ 80MB** 极佳低位。

---

## 🔍 1. 内存过高的本质原因分析与复盘

在网关演进初期，曾遇到长时间运行后物理内存上涨的现象，经深入诊断，核心根源如下：

1. **V8 引擎默认的“懒惰”GC 机制**：
   - Node.js 默认根据宿主机的总物理内存划分堆空间。在没有主动干预时，V8 认为内存充裕，**极少执行 Full Major GC（Mark-Sweep-Compact 标记-清除-整理）**，更不会主动将闲置内存归还给 Linux 操作系统；
2. **首包 128KB 暂存 Buffer 强引用驻留**：
   - 为了实现故障转移重试，网关在握手初期暂存了首包数据。但握手 200 OK 成功后，若未显式清空，长连接（如 2 小时的视频流）在整个生命周期中都会强引用这个 Buffer 数组；
3. **输入流缺乏背压 (Backpressure) 流控**：
   - 当客户端千兆跑满上传时，若远端网络处理较慢，未监听 `write()` 的返回值，未及时挂起客户端输入，会导致巨量 Buffer 堆积在 Node.js 内存队列中；
4. **僵尸 Socket 悬挂**：
   - 客户端异常丢包或强制关闭连接时，未建立两端互锁销毁，导致远端套接字及内核缓冲区无法即刻被 GC 释放。

---

## 🛡️ 2. Memory Guard 四重防御机制

针对上述痛点，网关在底层构建了完备的内存防护盾：

```text
客户端连接 ──► 动态暂存首包 (≤128KB) ──► 远端 200 握手成功 ──► 瞬间清空暂存 (initialChunks.length = 0)
                                                    │
                                                    ▼
数据持续转发 ──► 监听内核写缓冲区饱水 ──► 触发背压暂停输入 (pause) ──► 缓冲区排空恢复 (drain -> resume)
                                                    │
                                                    ▼
任一端异常断开 ──► 互锁销毁对端 Socket ──► 释放文件描述符与底层 Buffer ──► 杜绝僵尸连接
```

### ① 握手即清机制
在 `dev/lib/proxy-xhttp.mjs` 中，一旦远端返回 200 OK，网关立即执行：
```javascript
isHandshakeSuccess = true;
initialChunks.length = 0; // 瞬间释放 128KB 暂存内存
```

### ② 全链路背压流控机制 (Backpressure)
严格遵循 Node.js Stream 标准背压规范：
```javascript
const canContinue = currentOutReq.write(chunk);
if (!canContinue && typeof inputReadable.pause === 'function') {
  inputReadable.pause(); // 挂起客户端输入，停止继续读取
}

outReq.on('drain', () => {
  if (typeof inputReadable.resume === 'function') {
    inputReadable.resume(); // 远端缓冲区排空后恢复读取
  }
});
```

### ③ Socket 互锁销毁机制
无论客户端还是远端，任意一端触发 `close` 或 `error`，网关立即互锁执行 `destroy()`，杜绝未关闭的挂起连接：
```javascript
const cleanup = () => {
  try { targetSocket.destroy(); } catch {}
  try { socket.destroy(); } catch {}
};
targetSocket.on('close', cleanup);
socket.on('close', cleanup);
```

### ④ 模块系统深层缓存协调清洗
当触发回收时，独立的 `lib/memory.mjs` 模块会协调全系统各业务组件：
- 优雅关闭并释放闲置的 HTTP/2 连接池；
- 清理超过 12 小时未活跃的历史优选节点记录；
- 清理过期的管理员 Session 凭据；
- 清理跨天的 Telegram 告警去重 Set；
- 适度修剪超过容量的实时日志队列。

---

## ⚡ 3. 启用 V8 原生垃圾回收 (`--expose-gc`)

Node.js 原生支持手动触发垃圾回收，但需要在启动命令中注入 `--expose-gc` 参数。

### 在 Docker Compose 中配置
```yaml
command: ["node", "--expose-gc", "server.mjs"]
```

### 工作原理
注入该参数后，全局作用域下将暴露 `global.gc()` 函数。网关在内存守护巡检时，会连续触发两次 Full GC：
```javascript
if (typeof global.gc === 'function') {
  global.gc(); // 第一轮：标记-清除不可达对象
  global.gc(); // 第二轮：彻底压缩整理内存碎片并将内存交还操作系统
}
```

---

## 🤖 4. 后台智能内存巡检守护器

网关在后台运行常驻守护任务：
- **巡检频率**：默认每 **5 分钟** 巡检一次物理内存；
- **告警阈值**：默认 **150 MB**（支持自由配置）；
- **自动触发**：当检测到当前常驻物理内存（RSS）超过阈值时，网关在后台静默执行全量清理与原生 GC，并在控制台记录释放对比：
  ```text
  [Memory Guard] 深度内存回收完成 [来源: 阈值自动守护 | 原生V8 GC: 已执行]: RSS: 168.4MB -> 65.2MB (释放 103.2MB)
  ```

---

## 🖥️ 5. Web 控制台可视化与一键深度回收

在 Web 管理控制台中：
1. **监控中心状态卡片**：
   - 呈现当前实时内存数值（如 `68.5 MB`）；
   - **动态健康标签**：
     - `🟢 极佳`：< 100 MB；
     - `🔵 正常`：100 MB ~ 200 MB；
     - `🔴 偏高`：> 200 MB；
   - **`[⚡ 立即回收]` 按钮**：管理员点击后，立即通过 REST API 触发深度清理，并在屏幕右下角弹出 Toast 释放报告（如 `✅ 深度内存回收完成！物理内存已释放 103.2 MB`）。
2. **核心配置参数面板**：
   - 自由开启/关闭自动守护、调整触发阈值与巡检周期；
   - 实时显示当前环境的 V8 GC 支持状态徽章（`✅ V8 原生 GC 已就绪` 或 `ℹ️ 标准回收模式`）。
