# CoworkRunner 架构重构设计文档

> **日期:** 2026-05-12
> **状态:** 已批准，待实施
> **目标:** 将 4622 行的 CoworkRunner 单类拆分为企业级模块化架构

---

## 1. 背景与目标

### 1.1 当前问题

`coworkRunner.ts` 存在以下问题：

- **单类过大** - 4622 行，包含多重职责混杂
- **违反单一职责原则** - 会话管理、工具执行、本地执行、沙箱执行、权限协调混在一个类
- **难以测试** - 巨大的类需要 mock 大量内部状态
- **可维护性差** - 新增功能只能往里堆，难以定位问题

### 1.2 重构目标

- 拆分为职责单一的模块
- 保持公开接口（startSession/continueSession/stopSession/respondToPermission）向后兼容
- 提升可测试性和可维护性
- 符合企业级架构规范

---

## 2. 架构决策

| 决策点 | 选择 | 理由 |
|--------|------|------|
| 兼容性策略 | 接口兼容 | 公开 API 稳定，内部可完全重写 |
| 状态管理 | Runner 持有全部状态 | 单一权威来源，便于审计追踪 |
| 协作方式 | 依赖注入 + 同步调用 | 显式调用链，调试友好 |
| 权限处理 | 统一 PermissionCoordinator | 隔离本地/沙箱差异，扩展性好 |
| 错误处理 | Result/Either 显式返回 | 异常不外抛，调用方显式判断 |

---

## 3. 目标架构

```
CoworkRunner (门面/状态管理者)
│
├── 持有状态: activeSessions, stoppedSessions, pendingPermissions 等
│
├── 公开接口 (向后兼容):
│   ├── startSession() -> Promise<Result<void>>
│   ├── continueSession() -> Promise<Result<void>>
│   ├── stopSession()
│   ├── respondToPermission()
│   └── getSessionConfirmationMode() / isSessionActive() 等查询方法
│
├── 依赖注入的服务:
│   ├── LocalExecutionService
│   ├── SandboxExecutionService
│   ├── ToolExecutionService
│   ├── WorkspaceService
│   └── PermissionCoordinator
│
└── 内部状态管理:
    └── SessionStateManager (如有需要可独立)
```

---

## 4. 模块设计

### 4.1 Result 类型定义

所有服务方法返回统一的 Result 类型：

```typescript
// src/main/domains/cowork/service/types/result.ts

export type Result<T, E = Error> =
  | { ok: true; data: T }
  | { ok: false; error: E; canFallback?: boolean };

export function success<T>(data: T): Result<T> {
  return { ok: true, data };
}

export function failure<E extends Error = Error>(
  error: E,
  options?: { canFallback?: boolean }
): Result<never, E> {
  return { ok: false, error, canFallback: options?.canFallback };
}
```

### 4.2 LocalExecutionService

**职责:** 管理本地 Claude Code 进程生命周期

**公开接口:**

```typescript
// src/main/domains/cowork/service/LocalExecutionService.ts

export interface LocalExecutionParams {
  sessionId: string;
  prompt: string;
  cwd: string;
  systemPrompt: string;
  imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
  abortSignal: AbortSignal;
  permissionHandler: PermissionHandler;
  mcpServerProvider?: McpServerProvider;
  autoApprove?: boolean;
}

export interface ExecutionResult {
  claudeSessionId: string | null;
  eventCount: number;
}

export class LocalExecutionService {
  constructor(
    private store: CoworkStore,
    private apiConfigProvider: () => ApiConfig,
    private claudeSdkLoader: () => typeof ClaudeSdkModule,
    private envBuilder: (cwd: string) => Promise<Record<string, string>>,
    private logger: Logger
  ) {}

  async run(params: LocalExecutionParams): Promise<Result<ExecutionResult>> {
    // 实现
  }
}
```

**不持有的状态:** 服务方法只接收参数快照，执行过程中不保留任何 session 级别状态。

### 4.3 SandboxExecutionService

**职责:** 管理沙箱 VM 生命周期和多轮对话

```typescript
// src/main/domains/cowork/service/SandboxExecutionService.ts

export interface SandboxExecutionParams {
  sessionId: string;
  prompt: string;
  cwd: string;
  systemPrompt: string;
  imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
  abortSignal: AbortSignal;
  permissionHandler: PermissionHandler;
  runtimeInfo: SandboxRuntimeInfo;
}

export class SandboxExecutionService {
  constructor(
    private store: CoworkStore,
    private sandboxRuntime: SandboxRuntimeService,
    private skillResolver: SkillResolver,
    private logger: Logger
  ) {}

  async run(params: SandboxExecutionParams): Promise<Result<ExecutionResult>> {
    // 实现
  }

  async continueTurn(
    activeSession: ActiveSession,
    params: SandboxExecutionParams
  ): Promise<Result<ExecutionResult>> {
    // 沙箱多轮对话支持
  }
}
```

### 4.4 ToolExecutionService

**职责:** 工具注册与执行管理

```typescript
// src/main/domains/cowork/service/ToolExecutionService.ts

export interface ToolContext {
  sessionId: string;
  workspaceRoot: string;
  permissionHandler: PermissionHandler;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<Result<ToolResult>>;

export class ToolExecutionService {
  private tools: Map<string, ToolHandler> = new Map();

  constructor(private store: CoworkStore, private logger: Logger) {
    this.registerBuiltinTools();
  }

  registerTool(name: string, handler: ToolHandler): void {
    this.tools.set(name, handler);
  }

  async executeTool(
    toolName: string,
    toolInput: Record<string, unknown>,
    context: ToolContext
  ): Promise<Result<ToolResult>> {
    const handler = this.tools.get(toolName);
    if (!handler) {
      return failure(new Error(`Unknown tool: ${toolName}`));
    }
    return handler(toolInput, context);
  }

  private registerBuiltinTools(): void {
    // conversation_search
    this.registerTool('conversation_search', async (args, ctx) => {
      // 实现
    });

    // recent_chats
    this.registerTool('recent_chats', async (args, ctx) => {
      // 实现
    });

    // memory_user_edits
    this.registerTool('memory_user_edits', async (args, ctx) => {
      // 实现
    });
  }
}
```

### 4.5 WorkspaceService

**职责:** 工作区解析、附件处理、路径规范化

```typescript
// src/main/domains/cowork/service/WorkspaceService.ts

export interface WorkspaceContext {
  workspaceRoot: string;
  cwd: string;
}

export interface AttachmentResolution {
  resolved: string[];
  unresolved: string[];
}

export class WorkspaceService {
  constructor(
    private skillResolver: SkillResolver,
    private logger: Logger
  ) {}

  normalizeWorkspaceRoot(workspaceRoot: string, cwd: string): string {
    // 实现
  }

  inferWorkspaceRootFromCwd(cwd: string): string {
    // 实现
  }

  resolveAttachments(
    prompt: string,
    cwd: string,
    context: WorkspaceContext
  ): Promise<AttachmentResolution> {
    // 实现
  }

  augmentPromptWithReferences(prompt: string, cwd: string): string {
    // 实现
  }
}
```

### 4.6 PermissionCoordinator

**职责:** 统一权限接口，内部区分本地/沙箱实现

```typescript
// src/main/domains/cowork/service/PermissionCoordinator.ts

export interface PermissionHandler {
  requestPermission(
    toolName: string,
    toolInput: Record<string, unknown>,
    question: string
  ): Promise<Result<PermissionResult>>;
}

export class PermissionCoordinator {
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private sandboxPermissions: Map<string, SandboxPendingPermission> = new Map();

  createHandler(sessionId: string): PermissionHandler {
    // 返回对应 session 的权限处理器
  }

  resolvePermission(requestId: string, result: PermissionResult): void {
    // 处理用户响应
  }

  clearSession(sessionId: string): void {
    // 清理 session 相关权限
  }
}
```

### 4.7 CoworkRunner (门面)

**职责:** 状态管理、服务编排、公开接口实现

```typescript
// src/main/domains/cowork/service/CoworkRunner.ts (重构后)

export class CoworkRunner extends EventEmitter {
  // 状态 (集中在 Runner)
  private activeSessions: Map<string, ActiveSession> = new Map();
  private stoppedSessions: Set<string> = new Set();
  private turnMemoryQueue: QueuedTurnMemoryUpdate[] = [];

  // 服务实例
  private localExecution: LocalExecutionService;
  private sandboxExecution: SandboxExecutionService;
  private toolExecution: ToolExecutionService;
  private workspace: WorkspaceService;
  private permission: PermissionCoordinator;

  constructor(store: CoworkStore) {
    super();

    // 依赖注入
    this.permission = new PermissionCoordinator(/* dependencies */);
    this.workspace = new WorkspaceService(/* dependencies */);
    this.toolExecution = new ToolExecutionService(store, /* dependencies */);
    this.localExecution = new LocalExecutionService(store, /* dependencies */);
    this.sandboxExecution = new SandboxExecutionService(store, /* dependencies */);
  }

  async startSession(
    sessionId: string,
    prompt: string,
    options: StartSessionOptions
  ): Promise<Result<void>> {
    // 1. 状态检查
    // 2. 构建 ActiveSession
    // 3. 调用 WorkspaceService 解析工作区
    // 4. 根据 executionMode 分发到 LocalExecutionService 或 SandboxExecutionService
    // 5. 返回 Result
  }

  async continueSession(
    sessionId: string,
    prompt: string,
    options: ContinueSessionOptions
  ): Promise<Result<void>> {
    // 类似 startSession
  }

  stopSession(sessionId: string): void {
    // 清理状态
    this.activeSessions.delete(sessionId);
    this.stoppedSessions.add(sessionId);
    // 通知相关服务
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    this.permission.resolvePermission(requestId, result);
  }
}
```

---

## 5. 文件结构

```
src/main/domains/cowork/service/
├── CoworkRunner.ts                 # 重构后的门面类 (预计 ~500 行)
├── CoworkRunnerTypes.ts            # 类型定义：ActiveSession, PermissionRequest 等
│
├── types/
│   ├── result.ts                  # Result<T, E> 类型定义
│   └── index.ts                   # 统一导出
│
├── execution/
│   ├── LocalExecutionService.ts    # 本地执行服务 (~400 行)
│   ├── SandboxExecutionService.ts  # 沙箱执行服务 (~400 行)
│   └── ExecutionResult.ts          # 执行结果类型
│
├── tools/
│   ├── ToolExecutionService.ts     # 工具执行服务 (~300 行)
│   └── builtin/
│       ├── conversationSearchTool.ts
│       ├── recentChatsTool.ts
│       └── memoryUserEditsTool.ts
│
├── workspace/
│   ├── WorkspaceService.ts         # 工作区服务 (~300 行)
│   └── AttachmentResolver.ts       # 附件解析
│
├── permission/
│   ├── PermissionCoordinator.ts   # 权限协调器 (~200 行)
│   ├── LocalPermissionHandler.ts   # 本地权限处理
│   └── SandboxPermissionHandler.ts  # 沙箱权限处理
│
└── memory/
    └── TurnMemoryQueue.ts          # 内存更新队列
```

---

## 6. 迁移策略

### 阶段一：创建新模块骨架

1. 创建 `types/result.ts`
2. 创建各服务接口和骨架类
3. 确保编译通过

### 阶段二：逐个迁移实现

1. **ToolExecutionService** - 最早迁移，因为相对独立
2. **WorkspaceService** - 依赖少，易验证
3. **PermissionCoordinator** - 涉及状态，需要仔细迁移
4. **LocalExecutionService** - 最大最复杂的模块
5. **SandboxExecutionService** - 最后迁移

### 阶段三：简化 CoworkRunner

迁移完成后，CoworkRunner 只保留：
- 状态管理
- 服务编排
- 公开接口实现
- EventEmitter 事件转发

---

## 7. 验证标准

- [ ] `npm run compile:electron` 通过
- [ ] `npm run lint` 无错误
- [ ] `npm run test:memory` 通过
- [ ] 手动测试：启动会话、发送消息、停止会话完整流程
- [ ] 手动测试：沙箱模式完整流程
- [ ] 手动测试：权限审批流程
- [ ] CoworkRunner.ts 行数降至 500 行以内
- [ ] 每个新模块可独立单元测试

---

## 8. 风险与缓解

| 风险 | 缓解措施 |
|------|----------|
| 迁移过程破坏现有功能 | 分阶段迁移，每阶段验证编译和功能 |
| EventEmitter 兼容性 | CoworkRunner 保持 EventEmitter，事件由 Runner 统一转发 |
| 状态丢失 | Runner 持有所有状态，服务无状态 |
| 性能下降 | 保持同步调用，避免事件总线开销 |

---

## 9. 附录：关键类型

### ActiveSession (目标结构)

```typescript
interface ActiveSession {
  sessionId: string;
  claudeSessionId: string | null;
  workspaceRoot: string;
  confirmationMode: 'modal' | 'text';
  executionMode: CoworkExecutionMode;
  abortController: AbortController;
  pendingPermission: PermissionRequest | null;
  autoApprove: boolean;

  // 沙箱特有
  sandboxProcess?: ChildProcess;
  ipcBridge?: VirtioSerialBridge;

  // 流式状态
  streamingMessageId: string | null;
  streamingContent: string;
}
```

### McpServerProvider

```typescript
type McpServerProvider = () => Array<{
  name: string;
  transportType: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
}>;
```
