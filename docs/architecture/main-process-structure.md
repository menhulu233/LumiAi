# 主进程架构说明（src/main）

> 状态：2026-05-11 重构完成后的快照
> 适用范围：Electron 主进程代码（`src/main/`）
> 性质：只读文档，记录当前模块边界与依赖方向，不约束尚未发生的改动

---

## 1. 分层目标

`src/main/` 经过 2026-05-11 的目录重组后，按"职责相近、变更频率相近"原则划分为 5 层：

| 层级 | 目录 | 职责 | 典型变更原因 |
|---|---|---|---|
| 入口 | `main.ts`、`preload.ts` | 进程启动、preload bridge | 极低频 |
| 核心 | `core/` | App 生命周期、窗口、容器、迁移、CSP、日志 | 低频 |
| 系统能力 | `system/` | OS 层服务（托盘、自启、代理、权限）、KV 存储 | 中频 |
| 业务域 | `domains/` | cowork / im / mcp / skill / scheduled-task | 高频 |
| 共享库 | `libs/` | 跨域可复用的运行时与适配器 | 中频 |
| 工具 | `utils/` | 纯函数、路径、fs 兼容 | 极低频 |

IPC 注册统一收敛在 `ipc/router.ts`。

---

## 2. 目录树（当前真实状态）

```
src/main/
├── main.ts                     入口：仅做最小化引导，调用 bootstrap()
├── preload.ts                  渲染进程桥接 API
│
├── core/                       进程核心
│   ├── app.ts                  常量与平台判定（isDev/isMac/isWindows 等）
│   ├── api.ts                  通用 API IPC（versions、env 等）
│   ├── bootstrap.ts            启动编排（whenReady → store → 子系统 → IPC → window）
│   ├── broadcaster.ts          全局事件广播
│   ├── cleanup.ts              退出清理
│   ├── constants.ts            APP_NAME 等
│   ├── container.ts            依赖容器（getContainer/setContainer）
│   ├── csp.ts                  Content Security Policy
│   ├── factories.ts            子系统单例工厂（store/runner/scheduler/...）
│   ├── lifecycle.ts            生命周期事件挂载
│   ├── logger.ts               主进程日志器
│   ├── migrations.ts           历史数据迁移（legacy memory、electron-store）
│   ├── reload.ts               dev 热重载
│   └── window.ts               BrowserWindow 创建、标题栏、窗口 IPC
│
├── system/                     系统能力
│   ├── ipc.ts                  system 域 IPC（13KB，覆盖较多 OS 相关 handler）
│   ├── service/
│   │   ├── autoLaunchService.ts
│   │   ├── permissionService.ts
│   │   ├── proxyService.ts
│   │   └── trayService.ts
│   └── store/
│       └── kvStore.ts          通用 KV 存储抽象
│
├── domains/                    业务域
│   ├── cowork/
│   │   ├── ipc.ts              ~21KB
│   │   ├── store/
│   │   └── types.ts
│   ├── im/
│   │   ├── ipc.ts
│   │   ├── types.ts            ~10KB
│   │   ├── gateway/            DingTalk / Feishu / Telegram / Discord / QQ / Wecom
│   │   ├── service/            imStore / imChatHandler / imCoworkHandler / imGatewayManager / http / 等
│   │   └── utils/
│   ├── mcp/
│   │   ├── ipc.ts
│   │   └── store/
│   ├── scheduled-task/
│   │   ├── ipc.ts
│   │   └── store/
│   └── skill/
│       ├── ipc.ts
│       ├── skillManager.ts
│       ├── types.ts
│       ├── service/
│       └── store/
│
├── libs/                       跨域共享运行时与适配器
│   ├── appUpdateInstaller.ts
│   ├── claudeSdk.ts
│   ├── claudeSettings.ts
│   ├── coworkConfigStore.ts
│   ├── coworkFormatTransform.ts
│   ├── coworkLogger.ts
│   ├── coworkMemoryExtractor.ts
│   ├── coworkMemoryJudge.ts
│   ├── coworkOpenAICompatProxy.ts   ~87KB
│   ├── coworkRunner.ts              ~218KB（最大文件，后续候选拆分）
│   ├── coworkSandboxRuntime.ts      ~38KB
│   ├── coworkUtil.ts                ~63KB
│   ├── coworkVmRunner.ts            ~23KB
│   ├── logExport.ts
│   ├── pythonRuntime.ts
│   ├── scheduler.ts
│   └── systemProxy.ts
│
├── ipc/                        IPC 注册中枢
│   ├── router.ts               registerIPCHandlers(container)
│   └── types.ts                跨域共享的 IPC 类型
│
├── utils/                      纯工具
│   ├── fsCompat.ts
│   ├── paths.ts
│   └── sanitize.ts
│
└── im/                         过渡 barrel（见 §5 遗留过渡点）
    └── index.ts                只做 re-export，未来可移除
```

---

## 3. 依赖方向规范

允许的依赖方向（自上而下，单向）：

1. `main.ts`
2. → `core/bootstrap.ts`
3. → `core/*`（容器、窗口、工厂、迁移）
4. → `ipc/router.ts`
5. → `system/*` 与 `domains/*/ipc.ts`
6. → `libs/*`
7. → `utils/*`

补充约束：

- `domains/*` 之间**不应直接互相 import**。跨域协作走 `core/container.ts` 暴露的实例，或通过 `libs/` 中的共享模块。
- `libs/*` 可以被 `core/`、`system/`、`domains/` 引用，但 `libs/*` 不应反向引用 `core/`、`system/`、`domains/`（当前 `libs/coworkOpenAICompatProxy.ts` 在 bootstrap 中以函数注入方式接收依赖，符合该约束）。
- `utils/*` 是叶子层，不引用上层任何模块。
- IPC handler 一律在各域的 `ipc.ts` 中注册，再由 `ipc/router.ts` 聚合，避免散落在业务逻辑内。

---

## 4. 启动序列（bootstrap.ts 概览）

`bootstrap()` 的执行顺序：

1. `await app.whenReady()`
2. 确保默认项目目录 `~/lumiai/project` 存在
3. `initStore()` → `setStoreInstance(store)`
4. 历史迁移：`migrateLegacyMemoryFileToUserMemories`、`migrateFromElectronStore`
5. `getCoworkStore().resetRunningSessions()` 把卡死的 running 会话复位
6. 注入 `claudeSettings` 的 store getter
7. 启动 cowork OpenAI 兼容代理，并向其注入 scheduled-task 依赖
8. 初始化 skill / mcp / im gateway / scheduled-task 等子系统
9. `applyProxyPreference(...)`、`ensurePythonRuntimeReady(...)`
10. `setContainer(...)` 注册容器，供 IPC handler 取实例
11. `setContentSecurityPolicy()`
12. `registerIPCHandlers(container)`
13. `createWindow(...)`、托盘、自启
14. 监听 `activate`、配置变更等事件

---

## 5. 遗留过渡点（不影响运行）

以下条目是重构期间为了兼容旧 import 路径而保留的过渡产物，未来可在确认无外部依赖后清理：

| 位置 | 内容 | 备注 |
|---|---|---|
| `src/main/im/index.ts` | barrel，re-export `domains/im/**` 的类型与类 | 旧代码若仍写 `from '../im'`，由此 barrel 兜底；新代码请直接 import `domains/im/*` |
| `src/main/ipc/types.ts` | 跨域 IPC 类型（~11KB） | 暂时集中，不影响分层；如需进一步拆分可按域切到各 `domains/*/types.ts` |
| `libs/cowork*` 大文件 | `coworkRunner.ts` 218KB、`coworkOpenAICompatProxy.ts` 87KB、`coworkUtil.ts` 63KB | 单文件偏大，仅在需要时再拆，不强求 |

---

## 6. 安全相关基线

`core/window.ts` 中 `BrowserWindow` 的 webPreferences 当前配置：

- `nodeIntegration: false`
- `contextIsolation: true`
- `sandbox: true`
- `webSecurity: true`
- `devTools` 仅在 dev 环境开启

`core/csp.ts` 在主进程层面设置 Content Security Policy。任何调整这些项的改动都应被视为安全敏感变更。

---

## 7. 入口与生命周期补充

`src/main/main.ts` 极简，固定 5 步：
1. `app.name = APP_NAME` 并 `app.setName(APP_NAME)`
2. `configureUserDataPath()`（来自 `utils/paths.ts`）
3. `setupAppEventHandlers()`（来自 `core/app.ts`）
4. `initApp()`（来自 `core/lifecycle.ts`，内部调用 `bootstrap()`）
5. `.catch(console.error)` 兜底

因此 `main.ts` 永远不应承载业务逻辑，新加的启动步骤应放进 `core/bootstrap.ts` 的对应阶段。

---

## 8. 容器与子系统单例

`core/container.ts` 定义了主进程内可被各域 IPC 取用的实例集合：

| 字段 | 类型来源 |
|---|---|
| `store` | `system/store/kvStore.ts` |
| `coworkStore` | `domains/cowork/store` |
| `coworkRunner` | `libs/coworkRunner.ts` |
| `skillManager` | `domains/skill/skillManager.ts` |
| `mcpStore` | `domains/mcp/store/mcpStore.ts` |
| `imGatewayManager` | `domains/im/service/imGatewayManager.ts` |
| `scheduledTaskStore` | `domains/scheduled-task/store/scheduledTaskStore.ts` |
| `scheduler` | `libs/scheduler.ts` |

构造逻辑集中在 `core/factories.ts`，采用懒加载单例：
- `initStore()` 用 `Promise.race` 给底层 KV 加 15 秒初始化超时
- `KvStore.create` 时把各域 migrations 合并传入：`coworkMigrations`、`memoryMigrations`、`scheduledTaskMigrations`、`mcpMigrations`
- `getCoworkStore()` 构造后会立即执行 `autoDeleteNonPersonalMemories()` 做一次清理
- `getCoworkRunner()` 通过 `setMcpServerProvider(() => getMcpStore().getEnabledServers())` 解耦 cowork 对 mcp 的硬依赖
- `getIMGatewayManager()` 在构造时注入 `coworkRunner` / `coworkStore`，并通过 `initialize({ getLLMConfig, getSkillsPrompt })` 将 LLM 配置与技能路由 prompt 以闭包方式提供，事件总线 `statusChange` / `message` / `error` 通过 `broadcaster` 广播到所有窗口
- `getScheduler()` 把 `scheduledTaskStore`、`coworkStore`、`getCoworkRunner`、可选的 `getIMGatewayManager`、`getSkillsPrompt` 注入，IM Gateway 取不到时安静降级为 `null`

依赖在构造时通过 getter / 工厂函数注入，避免模块加载期的循环引用。

---

## 9. 各文件一句话用途

`core/`：
- `app.ts` — `setupAppEventHandlers`、常量（`isDev`/`isMac`/`isWindows`、`DEV_SERVER_URL`、`PRELOAD_PATH`、`TITLEBAR_*`）
- `api.ts` — 注册通用 API IPC（版本、env 等）
- `bootstrap.ts` — 启动编排
- `broadcaster.ts` — `broadcastToAllWindows(channel, payload)`
- `cleanup.ts` — 退出清理
- `constants.ts` — `APP_NAME`
- `container.ts` — `Container` 类型与 `get/setContainer`
- `csp.ts` — `setContentSecurityPolicy()`
- `factories.ts` — 子系统单例工厂
- `lifecycle.ts` — 暴露 `initApp()`，挂载生命周期事件
- `logger.ts` — 主进程日志
- `migrations.ts` — `migrateLegacyMemoryFileToUserMemories`、`migrateFromElectronStore`
- `reload.ts` — dev 热重载辅助
- `window.ts` — `createWindow`、标题栏 overlay、`registerWindowIPC`

`libs/`：
- `appUpdateInstaller.ts` — 应用自更新安装
- `claudeSdk.ts` — Claude SDK 适配
- `claudeSettings.ts` — Claude 设置读写（接收 store getter 注入）
- `coworkConfigStore.ts` — Cowork 配置存储
- `coworkFormatTransform.ts` — Cowork 消息格式转换
- `coworkLogger.ts` — Cowork 域日志
- `coworkMemoryExtractor.ts` — 从会话中抽取候选记忆
- `coworkMemoryJudge.ts` — 候选记忆的过滤判定
- `coworkOpenAICompatProxy.ts` — OpenAI 兼容代理（流式协议、消息映射）
- `coworkRunner.ts` — Cowork 主运行时（会话状态机、工具调度）
- `coworkSandboxRuntime.ts` — Cowork 沙箱运行时
- `coworkUtil.ts` — Cowork 工具集合
- `coworkVmRunner.ts` — Cowork VM Runner
- `logExport.ts` — 日志导出
- `pythonRuntime.ts` — 内置 Python 运行时管理
- `scheduler.ts` — 定时任务调度器
- `systemProxy.ts` — 系统代理检测

`system/`：
- `ipc.ts` — system 域 IPC
- `service/autoLaunchService.ts` — 开机自启
- `service/permissionService.ts` — 系统权限
- `service/proxyService.ts` — 代理偏好应用
- `service/trayService.ts` — 系统托盘
- `store/kvStore.ts` — 底层 KV 存储（带 migrations）

`utils/`：
- `fsCompat.ts` — fs 兼容封装
- `paths.ts` — 路径与 `configureUserDataPath()`
- `sanitize.ts` — 字符串/路径净化

`ipc/`：
- `router.ts` — `registerIPCHandlers(container)` 聚合各域
- `types.ts` — 跨域 IPC 类型

`im/`（过渡）：
- `index.ts` — re-export `domains/im/**`，仅为兼容旧路径

---

## 10. 后续可选方向（仅记录，不作承诺）

- 对 `libs/coworkRunner.ts` / `coworkOpenAICompatProxy.ts` 做按职责拆分（流式协议、消息转换、工具执行、状态机各自一份）。
- 把 `ipc/types.ts` 按域切到各自 `domains/*/types.ts`。
- 在确认无外部 import 后移除 `src/main/im/index.ts` 过渡 barrel。
- 给 `domains/*` 增加 README，说明该域的对外契约（IPC channel、事件、存储 schema）。

以上仅为建议清单，不构成必须立即执行的工作。
