# 主进程代码审查记录（2026-05-11）

> 范围：`src/main/` 重构完成后的回归审查
> 性质：问题记录文档，**仅记录**已发现的 bug / 风险，不在本文档中给出最终修复实现
> 关联：`docs/architecture/main-process-structure.md`

---

## 概览

| 等级 | 数量 | 说明 |
|---|---|---|
| 🔴 严重（已确认 Bug） | 1 | 影响功能正确性 |
| 🟡 中等（潜在风险/设计缺陷） | 7 | 在特定路径下会触发问题或不易维护 |
| 🟢 提示（改进建议） | 0+ | 见附录 |

恶意软件评估：本次审查的 7 个核心文件均为标准 Electron 主进程编排，无可疑外联、动态执行、反调试等行为，**不是恶意软件**。

---

## 🔴 严重问题

### BUG-001：`lifecycle.ts` 对 `cleanup.ts` 导入的 `let` 变量进行赋值无效

**位置**：`src/main/core/lifecycle.ts:5,14,16,19,26,27`

**现象**：
```ts
import { runAppCleanup, handleTerminationSignal, isCleanupFinished, isCleanupInProgress } from './cleanup';
...
if (isCleanupFinished) return;
...
isCleanupInProgress = true;
setIsQuitting(true);
void runAppCleanup()
  .catch(...)
  .finally(() => {
    isCleanupFinished = true;
    isCleanupInProgress = false;
    app.exit(0);
  });
```

**问题**：
1. ES Module 的 `import` 绑定是只读的，对导入标识符赋值在 TypeScript strict 模式下应编译报错。
2. 即便在某些打包/转译模式下被放行，CommonJS 转译产物中赋值变成 `exports.isCleanupFinished = true`，但 `cleanup.ts` 内部的所有读取仍指向本地 `let` 变量，**赋值不会同步**。
3. 结果：`cleanup.ts` 内部任何对 `isCleanupInProgress` / `isCleanupFinished` 的判断永远拿不到 `lifecycle.ts` 这边写入的值。
4. 第二次 `before-quit` 触发时（例如用户连点关闭、托盘菜单调用 `app.quit()`），状态判断不可靠，可能重复执行 `runAppCleanup()`。

**建议修复方向**（仅记录，不在本文档落地实现）：
- 让 `cleanup.ts` 自己维护内部状态，对外暴露：
  - `getCleanupState(): 'idle' | 'in_progress' | 'finished'`
  - `markCleanupStarted()` / `markCleanupFinished()`
- 或将清理流程封装成单一异步函数 `ensureCleanupOnce()`，由 `cleanup.ts` 内部用 `let cleanupPromise: Promise<void> | null` 做幂等。

**需要进一步确认**：`cleanup.ts` 当前对 `isCleanupFinished` / `isCleanupInProgress` 的导出形式（`export let` vs `export const`）以及内部是否真的依赖这两个变量做幂等判断。

---

## 🟡 中等问题

### ISSUE-002：`factories.ts` 工厂函数缺少 store 就绪断言

**位置**：`src/main/core/factories.ts`（`getCoworkRunner` / `getIMGatewayManager` / `getScheduler` 等）

**问题**：所有派生工厂内部调用 `getCoworkStore()` 或 `getStore()`，但没有显式断言 store 已经初始化。一旦未来在 `app.whenReady()` 之前的代码路径（例如 `setupAppEventHandlers()`、调试入口）误用这些工厂，会从 `getStore()` 抛出 `Error: Store not initialized.`，错误信息不指出**哪个工厂**触发，定位成本高。

**建议**：每个工厂入口加 `assertStoreReady('getCoworkRunner')`，把调用栈名写进异常。

---

### ISSUE-003：`getIMGatewayManager()` 副作用过重，违背 getter 单一职责

**位置**：`src/main/core/factories.ts:94-152`

**问题**：名义上的 getter 在首次调用时执行了：
1. 构造 `IMGatewayManager`
2. 调用 `initialize(...)`（含 LLM 配置闭包 + skills prompt 闭包）
3. 注册三个 listener

如果未来在 `bootstrap()` 之前的某段代码（调试/测试/IPC 错误路径）误调一次 `getIMGatewayManager()`，listener 会绑死，二次 `initialize` 将抛错或覆盖旧状态。

**建议**：getter 与 wiring 分离，仿 `getCoworkRunner` 的轻量级模式，把 `initialize + listener 挂载`移到 `bootstrap.ts` 显式调用一次。

---

### ISSUE-004：`getLLMConfig` 选 provider 依赖对象插入顺序

**位置**：`src/main/core/factories.ts:111-133`

**问题**：
```ts
for (const [providerName, providerConfig] of Object.entries(providers))
```
业务依赖"第一个被启用的 provider"，这在 V8 实现下虽然是"插入顺序 + 数字键升序"，但属于**隐式约定**。一旦用户同时启用多个 provider，结果取决于配置写入顺序，不可预测。

**建议**：
- 增加显式字段 `providers.activeProvider`；或
- 维护一个显式优先级数组遍历。

---

### ISSUE-005：`bootstrap.ts` 容器装配出现重复 getter 调用

**位置**：`src/main/core/bootstrap.ts:111-131`

**问题**：`setContainer({...})` 与 `registerIPCHandlers({...})` 各自重新列举了一遍 8 个 getter。虽然因为单例缓存只真正构造一次，但代码重复、强耦合，新增依赖时容易漏改一侧。

**建议**：
```ts
const containerDeps = {
  store: getStore(),
  coworkStore: getCoworkStore(),
  coworkRunner: getCoworkRunner(),
  // ...
};
setContainer(containerDeps);
registerIPCHandlers(containerDeps);
```

---

### ISSUE-006：IM Gateway 异步启动未与退出流程协调

**位置**：`src/main/core/bootstrap.ts:149-151`

**问题**：`startAllEnabled()` 以 fire-and-forget 方式启动。如果用户在它完成前触发退出，`cleanup.ts` 可能会在 IM gateway 仍处于"连接中"的状态下被调用。需要确认 cleanup 是否能识别并清理"半启动"的 gateway 实例，否则有端口/子进程泄漏风险。

**建议**：
- 把启动 promise 缓存到 `IMGatewayManager` 自身（例如 `getStartupPromise()`）；
- cleanup 阶段先 `await getStartupPromise()` 再调用 `stopAllEnabled()`，或直接调用一个"取消并停止"的统一接口。

---

### ISSUE-007：主窗口尺寸在小屏设备上可能被强制裁剪

**位置**：`src/main/core/window.ts:147` 附近

**问题**：`width: 1200, height: 800` + `enableLargerThanScreen: false` + `setMinimumSize(800, 600)` 的组合在 13" 屏 @125% 缩放下（工作区约 1536×864）勉强可用，在 768p 笔记本上工作区高度可能不足 720，导致窗口被裁剪或贴边。

**建议**：根据 `screen.getPrimaryDisplay().workArea` 动态计算初始尺寸，如 `Math.min(800, workArea.height - 100)`。

---

### ISSUE-008：`close` 拦截逻辑与多窗口/托盘场景的兼容性

**位置**：`src/main/core/window.ts` close 事件处理

**问题**：当前实现以 `mainWindow && !isQuitting` 为拦截条件（隐藏到托盘）。需要确认：
1. 多次最小化/恢复后 `isQuitting` 是否会被意外置位（例如某条错误路径调用了 `setIsQuitting(true)` 又未还原）。
2. 托盘菜单"退出"是否显式 `setIsQuitting(true)` 后再 `app.quit()`，否则会进入"隐藏循环"，无法真正退出。

**建议**：在 trayService 的 quit 入口、cleanup 入口都显式调用 `setIsQuitting(true)`，并在 README/代码注释中固化这条契约。

---

## 总体评价

- 重构方向正确：入口极简（`main.ts` 仅 4 行业务）、`bootstrap.ts` 把启动编排串成一条线、`factories.ts` 集中单例管理，分层清晰。
- **唯一阻塞项是 BUG-001**，需要先确认 `cleanup.ts` 的导出形式，再决定是改为 getter/setter 还是改为内置幂等。
- 其余 7 项为可逐步优化的设计/健壮性问题，不影响主流程。

---

## 附录：建议的后续动作（仅记录，不在本文档执行）

1. 读取 `src/main/core/cleanup.ts` 全文，确认 BUG-001 是否成立及修复策略。
2. 为 `factories.ts` 增加 `assertStoreReady(name: string)` 辅助函数。
3. 把 IM Gateway 启动 promise 暴露到 `IMGatewayManager`，便于 cleanup 协调。
4. 把 provider 选择改为显式优先级或 `activeProvider` 字段。
5. 把 `bootstrap.ts` 的容器装配整理成单一 `containerDeps` 对象，去重。

---

*记录人：LobsterAI 代码审查 / 2026-05-11*
