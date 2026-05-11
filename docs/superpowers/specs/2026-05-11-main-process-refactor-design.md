# 主进程领域模块化重构设计文档

date: 2026-05-11
scope: src/main/ 目录重构
author: zhuman

## 背景

当前 `src/main/` 下 4 个核心文件总计 6699 行代码：

| 文件 | 行数 | 职责 |
|------|------|------|
| `main.ts` | 2764 | IPC 路由、窗口管理、生命周期、工具函数、业务逻辑全部混在一起 |
| `coworkStore.ts` | 1498 | 会话、消息、记忆、配置 4 张表的 CRUD 挤在一个类中 |
| `skillManager.ts` | 1923 | 技能注册、构建、运行、文件监控、PATH 解析全部耦合 |
| `sqliteStore.ts` | 514 | 数据库初始化 + 所有表结构定义 + KV 操作 + 迁移逻辑 |

问题：单文件过大导致代码审查困难、新功能难以定位插入点、单元测试几乎不可能。

## 目标

1. `main.ts` < 50 行，只做启动引导
2. 每个业务域（cowork/skill/im/scheduled-task/mcp/system）自治：类型 + 数据层 + 服务层 + IPC 路由
3. 依赖关系显式化，消除隐式 getter 链
4. 不改动任何业务逻辑，纯物理拆分

## 目录结构

```
src/main/
├── core/                          # 纯 Electron 基础设施（无业务逻辑）
│   ├── app.ts                     # 应用生命周期、单实例锁、信号处理
│   ├── window.ts                  # BrowserWindow 创建/管理
│   ├── windowState.ts             # 窗口状态转发
│   ├── tray.ts                    # 系统托盘
│   ├── lifecycle.ts               # 启动/退出清理顺序编排
│   ├── csp.ts                     # Content Security Policy
│   └── broadcaster.ts             # 向所有窗口广播事件的统一封装
│
├── domains/                       # 业务域（每个域是一个自治单元）
│   ├── cowork/
│   │   ├── types.ts               # 本域所有类型
│   │   ├── store/
│   │   │   ├── sessionStore.ts    # 会话 CRUD
│   │   │   ├── messageStore.ts    # 消息 CRUD
│   │   │   ├── memoryStore.ts     # 记忆 CRUD
│   │   │   ├── configStore.ts     # 配置 CRUD
│   │   │   └── _migrations.ts     # 本域表结构 DDL
│   │   ├── service/
│   │   │   ├── runnerService.ts   # CoworkRunner 封装、事件转发
│   │   │   ├── exportService.ts   # 截图/导出
│   │   │   └── sandboxService.ts  # 沙箱状态/安装
│   │   └── ipc.ts                 # cowork:* IPC handlers
│   │
│   ├── skill/
│   │   ├── types.ts
│   │   ├── store/
│   │   │   ├── registryStore.ts   # 技能注册发现
│   │   │   └── configStore.ts     # 技能配置
│   │   ├── service/
│   │   │   ├── builderService.ts  # 技能构建（node/python 命令调用）
│   │   │   ├── runnerService.ts   # 技能运行调度
│   │   │   └── watcherService.ts  # 文件监控
│   │   └── ipc.ts
│   │
│   ├── im/                        # 保持现有目录结构
│   │
│   ├── scheduled-task/
│   │   ├── types.ts
│   │   ├── store/
│   │   │   ├── taskStore.ts
│   │   │   └── runStore.ts
│   │   ├── service/
│   │   │   └── schedulerService.ts
│   │   └── ipc.ts
│   │
│   ├── mcp/
│   │   ├── types.ts
│   │   ├── store/
│   │   │   └── serverStore.ts
│   │   └── ipc.ts
│   │
│   └── system/
│       ├── store/
│       │   └── kvStore.ts         # 通用 KV + SQLite 初始化 + 迁移框架
│       ├── service/
│       │   ├── proxyService.ts    # 系统代理
│       │   ├── updateService.ts   # 自动更新
│       │   ├── logService.ts      # 日志导出
│       │   └── permissionService.ts # macOS 权限
│       └── ipc.ts
│
├── ipc/
│   ├── router.ts                  # 统一注册所有 domains/*/ipc.ts
│   └── types.ts                   # IPC 请求/响应类型契约
│
├── utils/                         # 跨域纯工具函数
│   ├── sanitize.ts                # IPC payload 消毒
│   ├── paths.ts                   # 路径规范化
│   └── validators.ts              # 配置校验
│
├── main.ts                        # 入口（< 50 行）
└── preload.ts                     # 保持现有
```

## 模块边界与依赖规则

```
renderer (preload.ts)
     ↕ IPC 调用
domains/*/ipc.ts       ← 唯一接触 ipcMain 的地方
     ↓ 调用
domains/*/service/*.ts ← 业务逻辑，可单元测试
     ↓ 调用
domains/*/store/*.ts   ← 纯数据访问，依赖 sql.js
     ↓ 调用
utils/ + core/         ← 底层工具，无业务知识
```

**硬性规则：**
1. `domains/*/service/` 不能直接操作 SQL，必须通过 `domains/*/store/`
2. `domains/` 之间通过显式 service 接口通信，禁止直接访问其他域的 store
3. `core/` 和 `utils/` 不能依赖任何 `domains/` 下的模块
4. `ipc.ts` 只做一件事：把 IPC 事件翻译成 service 方法调用

## 域间通信

| 场景 | 方式 | 示例 |
|------|------|------|
| A 域需要 B 域的数据 | 通过 service 接口调用 | `coworkService.getSession()` |
| A 域需要响应 B 域的状态变化 | EventEmitter | `imGatewayManager.on('statusChange', ...)` |
| 多个域共享初始化后的实例 | DI Container | `container.coworkRunner` |

## DI Container（替代隐式 getter）

**当前问题：**
```typescript
const getCoworkStore = () => {
  if (!coworkStore) {
    const sqliteStore = getStore();  // 运行时才知道依赖
    coworkStore = new CoworkStore(...);
  }
  return coworkStore;
};
```

**重构后：**
```typescript
// core/container.ts
export interface Container {
  kvStore: KvStore;
  coworkStore: CoworkStore;
  coworkRunner: CoworkRunner;
  skillStore: SkillRegistryStore;
  skillService: SkillBuilderService;
  mcpStore: McpStore;
  imGatewayManager: IMGatewayManager;
  scheduledTaskStore: ScheduledTaskStore;
  scheduler: Scheduler;
}

export async function createContainer(): Promise<Container> {
  const kvStore = await KvStore.create(app.getPath('userData'));
  const coworkStore = new CoworkStore(kvStore.getDatabase(), kvStore.save.bind(kvStore));
  const coworkRunner = new CoworkRunner(coworkStore);
  // ... 显式组装所有依赖
  return { kvStore, coworkStore, coworkRunner, ... };
}
```

启动时一次性组装，依赖链一目了然，便于测试时 mock。

## Store 拆分

### sqliteStore.ts → system/store/kvStore.ts

- **保留：** SQL.js 初始化、WASM 加载、`kv` 表操作
- **移除：** 所有业务表结构定义（cowork_sessions/messages/config、user_memories、scheduled_tasks、mcp_servers）
- **新增：** 迁移框架，各域通过 `registerDomainMigration()` 注册自己的 DDL

```typescript
export interface Migration {
  name: string;
  sql: string;
}

export class KvStore {
  private db: Database;

  static async create(userDataPath: string, domainMigrations: Migration[]): Promise<KvStore> {
    const store = new KvStore(await loadDatabase(userDataPath));
    store.initializeCoreTables();
    for (const m of domainMigrations) {
      store.applyMigration(m);
    }
    return store;
  }

  getDatabase(): Database { return this.db; }
  save(): void { /* export to disk */ }
  get<T>(key: string): T | undefined { /* ... */ }
  set<T>(key: string, value: T): void { /* ... */ }
  delete(key: string): void { /* ... */ }
}
```

### coworkStore.ts → domains/cowork/store/*.ts

**原 CoworkStore（1498 行）拆分为 4 个独立 store：**

| 新文件 | 职责 | 原方法 |
|--------|------|--------|
| `sessionStore.ts` | `cowork_sessions` 表 | createSession, getSession, updateSession, deleteSession, listSessions, setSessionPinned, resetRunningSessions, listRecentCwds |
| `messageStore.ts` | `cowork_messages` 表 | addMessage, getMessagesBySessionId, updateMessage, deleteMessage |
| `memoryStore.ts` | `user_memories` + `user_memory_sources` 表 | createUserMemory, updateUserMemory, deleteUserMemory, listUserMemories, getUserMemoryStats, autoDeleteNonPersonalMemories |
| `configStore.ts` | `cowork_config` 表 | getConfig, setConfig |

**聚合 facade：**
```typescript
// domains/cowork/store/index.ts
export class CoworkStore {
  session: CoworkSessionStore;
  message: CoworkMessageStore;
  memory: CoworkMemoryStore;
  config: CoworkConfigStore;

  constructor(db: Database, saveFn: () => void) {
    this.session = new CoworkSessionStore(db, saveFn);
    this.message = new CoworkMessageStore(db, saveFn);
    this.memory = new CoworkMemoryStore(db, saveFn);
    this.config = new CoworkConfigStore(db, saveFn);
  }
}
```

### skillManager.ts → domains/skill/**/*.ts

**原 SkillManager（1923 行）拆分为：**

| 新文件 | 职责 | 原方法 |
|--------|------|--------|
| `registryStore.ts` | 技能目录扫描、启用/禁用、发现 | listSkills, setSkillEnabled, deleteSkill, downloadSkill, syncBundledSkillsToUserData |
| `builderService.ts` | npm install / node build / python 命令 | buildSkill, hasCommand, resolveUserShellPath |
| `runnerService.ts` | 技能执行、env/PATH 注入 | runSkill, getSkillEnv |
| `watcherService.ts` | 文件监控 | startWatching, stopWatching |

## IPC 类型契约

统一提取到 `ipc/types.ts`，消除 `preload.ts` 和 `main.ts` 之间的类型不同步：

```typescript
export interface IPCHandlers {
  'cowork:session:start': {
    request: { prompt: string; cwd?: string; systemPrompt?: string; activeSkillIds?: string[]; imageAttachments?: ... };
    response: { success: boolean; session?: CoworkSession; error?: string };
  };
  'cowork:session:stop': {
    request: string; // sessionId
    response: { success: boolean; error?: string };
  };
  // ... 所有 channel
}
```

## 具体迁移示例

### IPC Handler 提取（cowork:session:start）

**当前（main.ts 1228-1318 行）：**
```typescript
ipcMain.handle('cowork:session:start', async (_event, options) => {
  try {
    const coworkStoreInstance = getCoworkStore();
    const config = coworkStoreInstance.getConfig();
    // ... 40 行混合了参数校验、目录解析、probe 调用、runner 启动
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : 'Failed to start session' };
  }
});
```

**重构后（domains/cowork/ipc.ts）：**
```typescript
export function registerCoworkIPC(container: Container) {
  const { coworkStore, coworkRunner, skillManager } = container;

  ipcMain.handle('cowork:session:start', async (_event, options) => {
    try {
      const result = await startSession(coworkStore, coworkRunner, skillManager, options);
      return { success: true, session: result };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to start session' };
    }
  });
}

// 纯函数，可独立测试，不依赖 ipcMain
async function startSession(
  store: CoworkStore,
  runner: CoworkRunner,
  skillManager: SkillManager,
  options: IPCHandlers['cowork:session:start']['request']
): Promise<CoworkSession> {
  // ... 业务逻辑
}
```

### main.ts 最终形态

```typescript
import { app } from 'electron';
import { APP_NAME } from './appConstants';
import { configureUserDataPath } from './utils/paths';
import { createContainer } from './core/container';
import { createWindow } from './core/window';
import { registerIPCHandlers } from './ipc/router';
import { setupLifecycle } from './core/lifecycle';
import { setContentSecurityPolicy } from './core/csp';
import { initLogger } from './logger';

app.name = APP_NAME;
configureUserDataPath();
initLogger();

async function bootstrap() {
  await app.whenReady();
  const container = await createContainer();
  setContentSecurityPolicy();
  registerIPCHandlers(container);
  setupLifecycle(container);
  createWindow(container);
}

bootstrap().catch(console.error);
```

## 迁移步骤

| 步骤 | 操作 | 风险 | 预计时间 |
|------|------|------|----------|
| 1 | 新建 `utils/` 目录，提取 sanitize/paths/validators 纯函数 | 无 | 30min |
| 2 | 新建 `core/broadcaster.ts`，替换所有 `getAllWindows().forEach` | 低 | 20min |
| 3 | 新建 `core/container.ts`，把 getter 改成显式 DI | 中 | 1h |
| 4 | 新建 `ipc/types.ts` 和 `ipc/router.ts`，逐个迁移 IPC handler 文件 | 中 | 2h |
| 5 | 新建 `core/window.ts` / `core/lifecycle.ts` / `core/csp.ts`，拆分窗口和生命周期 | 低 | 1h |
| 6 | 拆分 `sqliteStore.ts` → `system/store/kvStore.ts` + 迁移框架 | 中 | 1h |
| 7 | 拆分 `coworkStore.ts` → `domains/cowork/store/*.ts` | 中 | 1h |
| 8 | 拆分 `skillManager.ts` → `domains/skill/**/*.ts` | 中 | 1.5h |
| 9 | 清理 `main.ts` 到 < 50 行，验证编译通过 | 低 | 30min |

## 底线建议

如果目标是快速降低复杂度，只做步骤 1-5 即可让 `main.ts` 从 2764 行降到 ~300 行。步骤 6-8 的 Store 拆分可以等需要时再动，但建议一次性完成，因为数据层的拆分才是长期维护价值最大的部分。
