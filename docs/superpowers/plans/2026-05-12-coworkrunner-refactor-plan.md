# CoworkRunner 架构重构实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 4622 行的 CoworkRunner 单类拆分为职责单一的模块，保持公开接口向后兼容

**Architecture:** 采用依赖注入 + 同步调用模式，Runner 持有全部状态，服务无状态。Result/Either 显式错误处理，权限统一协调。

**Tech Stack:** TypeScript, Electron, Claude Agent SDK

---

## 文件结构

```
src/main/domains/cowork/service/
├── CoworkRunner.ts                    # 重构后 ~500 行
├── CoworkRunnerTypes.ts               # ActiveSession, PermissionRequest 等类型
│
├── types/
│   └── result.ts                    # Result<T, E> 类型
│
├── execution/
│   ├── LocalExecutionService.ts      # 本地执行 (~400 行)
│   └── SandboxExecutionService.ts    # 沙箱执行 (~400 行)
│
├── tools/
│   └── ToolExecutionService.ts       # 工具执行 (~300 行)
│
├── workspace/
│   └── WorkspaceService.ts           # 工作区服务 (~300 行)
│
└── permission/
    └── PermissionCoordinator.ts       # 权限协调 (~200 行)
```

**迁移顺序:** ToolExecutionService → WorkspaceService → PermissionCoordinator → LocalExecutionService → SandboxExecutionService → 简化 CoworkRunner

---

## 第一阶段：创建基础设施

### Task 1: 创建 types/result.ts

**Files:**
- Create: `src/main/domains/cowork/service/types/result.ts`

- [ ] **Step 1: 创建 result.ts 类型定义**

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

- [ ] **Step 2: 编译验证**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 3: Commit**

```bash
git add src/main/domains/cowork/service/types/result.ts
git commit -m "feat(cowork): add Result type for explicit error handling"
```

---

### Task 2: 创建 CoworkRunnerTypes.ts

**Files:**
- Create: `src/main/domains/cowork/service/CoworkRunnerTypes.ts`

- [ ] **Step 1: 从 coworkRunner.ts 提取类型定义**

从当前 `coworkRunner.ts` 的 `ActiveSession`、`PermissionRequest`、`PendingPermission`、`SandboxPendingPermission`、`QueuedTurnMemoryUpdate` 等类型提取到新文件。

```typescript
// src/main/domains/cowork/service/CoworkRunnerTypes.ts

import type { CoworkExecutionMode } from '../store';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PendingPermission {
  sessionId: string;
  resolve: (result: PermissionResult) => void;
}

export interface SandboxPendingPermission {
  sessionId: string;
  responsePath: string;
}

export interface QueuedTurnMemoryUpdate {
  key: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  implicitEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  guardLevel: string;
  userMessageId?: string;
  assistantMessageId?: string;
  enqueuedAt: number;
}

export interface ActiveSession {
  sessionId: string;
  claudeSessionId: string | null;
  workspaceRoot: string;
  confirmationMode: 'modal' | 'text';
  pendingPermission: PermissionRequest | null;
  abortController: AbortController;
  currentStreamingMessageId: string | null;
  currentStreamingContent: string;
  currentStreamingThinkingMessageId: string | null;
  currentStreamingThinking: string;
  currentStreamingBlockType: 'thinking' | 'text' | null;
  currentStreamingTextTruncated: boolean;
  currentStreamingThinkingTruncated: boolean;
  lastStreamingTextUpdateAt: number;
  lastStreamingThinkingUpdateAt: number;
  hasAssistantTextOutput: boolean;
  hasAssistantThinkingOutput: boolean;
  executionMode: CoworkExecutionMode;
  sandboxProcess?: any;
  sandboxIpcDir?: string;
  ipcBridge?: any;
  sandboxSkillsGuestPath?: string;
  sandboxSkillMounts?: Record<string, { tag: string; guestPath: string }>;
  sandboxSkillRootMounts?: any[];
  sandboxTurnResolve?: (result: any) => void;
  autoApprove?: boolean;
}
```

- [ ] **Step 2: 更新 coworkRunner.ts 导入**

在 coworkRunner.ts 顶部添加:
```typescript
export * from './CoworkRunnerTypes';
```

- [ ] **Step 3: 编译验证**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 4: Commit**

```bash
git add src/main/domains/cowork/service/CoworkRunnerTypes.ts
git commit -m "feat(cowork): extract CoworkRunner types to separate file"
```

---

## 第二阶段：迁移工具执行 (ToolExecutionService)

### Task 3: 创建 ToolExecutionService.ts

**Files:**
- Create: `src/main/domains/cowork/service/tools/ToolExecutionService.ts`
- Modify: `src/main/domains/cowork/service/coworkRunner.ts` (移除已迁移方法)

- [ ] **Step 1: 提取工具方法到 ToolExecutionService**

从 `coworkRunner.ts` 提取以下方法:
- `runConversationSearchTool`
- `runRecentChatsTool`
- `runMemoryUserEditsTool`
- `extractToolCommand` (辅助)
- `isDeleteOperation` (辅助)
- `truncateCommandPreview` (辅助)
- `isSafetyApproval` (辅助)
- `isPythonRelatedBashCommand` (辅助)
- `isPythonPipBashCommand` (辅助)

```typescript
// src/main/domains/cowork/service/tools/ToolExecutionService.ts

import type { CoworkStore } from '../store';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { coworkLog } from '../coworkLogger';

export interface ToolContext {
  sessionId: string;
  workspaceRoot: string;
  permissionHandler: PermissionHandler;
}

export interface ToolResult {
  content: string;
  metadata?: Record<string, unknown>;
}

export type ToolHandler = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<{ content: string; metadata?: Record<string, unknown> }>;

const DELETE_TOOL_NAMES = new Set(['bash', 'rm', 'rmdir', 'del', 'delete', 'remove']);
const DELETE_COMMAND_RE = /\brsync\s+.*--delete|\brsync\s+.*-(-del|delete)/;
const FIND_DELETE_COMMAND_RE = /find\s+.*-delete|\.\/cleanup|\.\/clean|\.gitcleanup/;
const GIT_CLEAN_COMMAND_RE = /^git\s+clean|^git\s+reset\s+--hard/;

export class ToolExecutionService {
  constructor(private store: CoworkStore) {}

  createToolContext(
    sessionId: string,
    workspaceRoot: string,
    permissionHandler: PermissionHandler
  ): ToolContext {
    return { sessionId, workspaceRoot, permissionHandler };
  }

  async runConversationSearchTool(args: {
    query: string;
    type?: string;
  }): Promise<{ content: string }> {
    // 从 coworkRunner.ts 迁移
  }

  async runRecentChatsTool(args: {
    query?: string;
  }): Promise<{ content: string }> {
    // 从 coworkRunner.ts 迁移
  }

  async runMemoryUserEditsTool(args: {
    operation: 'create' | 'update' | 'delete';
    id?: string;
    text?: string;
    confidence?: number;
  }): Promise<{ content: string }> {
    // 从 coworkRunner.ts 迁移
  }

  private extractToolCommand(toolInput: Record<string, unknown>): string {
    const commandLike = toolInput.command ?? toolInput.cmd ?? toolInput.script;
    return typeof commandLike === 'string' ? commandLike : '';
  }

  private isDeleteOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
    // 从 coworkRunner.ts 迁移
  }
}
```

- [ ] **Step 2: 在 coworkRunner.ts 导入 ToolExecutionService**

```typescript
import { ToolExecutionService } from './tools/ToolExecutionService';
```

- [ ] **Step 3: CoworkRunner 组合 ToolExecutionService**

在 CoworkRunner 构造函数中:
```typescript
private toolExecution: ToolExecutionService;

constructor(store: CoworkStore) {
  super();
  this.store = store;
  this.toolExecution = new ToolExecutionService(store);
  // ...
}
```

- [ ] **Step 4: 编译验证**

Run: `npm run compile:electron`
Expected: Success (可能有未使用的方法警告，可以忽略)

- [ ] **Step 5: Commit**

```bash
git add src/main/domains/cowork/service/tools/ToolExecutionService.ts
git add src/main/domains/cowork/service/coworkRunner.ts
git commit -m "feat(cowork): extract ToolExecutionService from CoworkRunner"
```

---

## 第三阶段：迁移工作区服务 (WorkspaceService)

### Task 4: 创建 WorkspaceService.ts

**Files:**
- Create: `src/main/domains/cowork/service/workspace/WorkspaceService.ts`
- Modify: `src/main/domains/cowork/service/coworkRunner.ts` (移除已迁移方法)

- [ ] **Step 1: 提取工作区方法到 WorkspaceService**

从 `coworkRunner.ts` 提取:
- `normalizeWorkspaceRoot`
- `inferWorkspaceRootFromSessionCwd`
- `resolveHostWorkspaceFallback`
- `mapSandboxGuestCwdToHost`
- `resolveSessionCwdForExecution`
- `parseAttachmentEntries`
- `resolveAttachmentPath`
- `toWorkspaceRelativePromptPath`
- `findAttachmentsOutsideCwd`
- `augmentPromptWithReferencedWorkspaceFiles`
- `findWorkspaceFileByName`
- `resolveInferredFilePath`
- `inferReferencedWorkspaceFiles`

- [ ] **Step 2: 编译验证**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 3: Commit**

```bash
git add src/main/domains/cowork/service/workspace/WorkspaceService.ts
git commit -m "feat(cowork): extract WorkspaceService from CoworkRunner"
```

---

## 第四阶段：迁移权限协调 (PermissionCoordinator)

### Task 5: 创建 PermissionCoordinator.ts

**Files:**
- Create: `src/main/domains/cowork/service/permission/PermissionCoordinator.ts`
- Modify: `src/main/domains/cowork/service/coworkRunner.ts` (移除已迁移方法)
- Modify: `src/main/domains/cowork/service/coworkRunnerPermission.ts` (整合)

- [ ] **Step 1: 整合 PermissionManager 到 PermissionCoordinator**

当前 `coworkRunnerPermission.ts` 有 `PermissionManager` 类。将它改名为 `PermissionCoordinator` 并增强。

从 `coworkRunner.ts` 迁移:
- `respondToPermission` (路由逻辑)
- `clearPendingPermissions`
- `clearSandboxPermissions`
- `writeSandboxHostToolResponse`
- `writeSandboxPermissionResponse`

- [ ] **Step 2: 编译验证**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 3: Commit**

```bash
git add src/main/domains/cowork/service/permission/PermissionCoordinator.ts
git commit -m "feat(cowork): extract PermissionCoordinator from CoworkRunner"
```

---

## 第五阶段：迁移本地执行 (LocalExecutionService)

### Task 6: 创建 LocalExecutionService.ts

**Files:**
- Create: `src/main/domains/cowork/service/execution/LocalExecutionService.ts`
- Modify: `src/main/domains/cowork/service/coworkRunner.ts` (移除 runClaudeCodeLocal)

- [ ] **Step 1: 提取 runClaudeCodeLocal 到 LocalExecutionService**

从 `coworkRunner.ts` (~2244-3043 行) 提取整个 `runClaudeCodeLocal` 方法及其依赖:
- `STDERR_TAIL_MAX_CHARS`
- `STDERR_FATAL_PATTERNS`
- `windowsHideInitScript` (来自 ensureWindowsChildProcessHideInitScript)

需要传递的依赖:
- `store: CoworkStore`
- `apiConfigProvider: () => ApiConfig`
- `claudeSdkLoader: () => typeof ClaudeSdkModule`
- `envBuilder: (cwd: string) => Promise<Record<string, string>>`
- `permissionHandler: PermissionHandler`

- [ ] **Step 2: 适配 handleClaudeEvent 调用**

`runClaudeCodeLocal` 调用 `handleClaudeEvent(sessionId, event, activeSession, deps)`。将此依赖作为参数传入。

- [ ] **Step 3: 编译验证**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 4: Commit**

```bash
git add src/main/domains/cowork/service/execution/LocalExecutionService.ts
git commit -m "feat(cowork): extract LocalExecutionService from CoworkRunner"
```

---

## 第六阶段：迁移沙箱执行 (SandboxExecutionService)

### Task 7: 创建 SandboxExecutionService.ts

**Files:**
- Create: `src/main/domains/cowork/service/execution/SandboxExecutionService.ts`
- Modify: `src/main/domains/cowork/service/coworkRunner.ts` (移除 runClaudeCodeInSandbox, continueSandboxTurn)

- [ ] **Step 1: 提取沙箱方法到 SandboxExecutionService**

从 `coworkRunner.ts` 提取:
- `runClaudeCodeInSandbox`
- `continueSandboxTurn`
- `handleHostToolExecution` (工具执行相关)
- `getSandboxUnavailableFallbackNotice`

- [ ] **Step 2: 编译验证**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 3: Commit**

```bash
git add src/main/domains/cowork/service/execution/SandboxExecutionService.ts
git commit -m "feat(cowork): extract SandboxExecutionService from CoworkRunner"
```

---

## 第七阶段：简化 CoworkRunner

### Task 8: 重构 CoworkRunner 为门面类

**Files:**
- Modify: `src/main/domains/cowork/service/coworkRunner.ts`

- [ ] **Step 1: 清理已迁移方法**

确认所有方法已迁移到对应服务，删除 `coworkRunner.ts` 中的以下内容:
- 所有 `private run*` 方法
- 所有 `private *Tool*` 方法
- `normalizeWorkspaceRoot` 等工作区方法
- `respondToPermission` 路由逻辑
- 权限状态 Map/Set

- [ ] **Step 2: 重构 startSession/continueSession**

将原来的 `startSession` 和 `continueSession` 方法重构为服务编排:
```typescript
async startSession(
  sessionId: string,
  prompt: string,
  options: StartSessionOptions
): Promise<void> {
  // 1. 状态检查和构建 ActiveSession
  // 2. 调用 WorkspaceService 解析工作区
  // 3. 根据 executionMode 分发到 LocalExecutionService 或 SandboxExecutionService
  // 4. 错误时尝试 fallback
}
```

- [ ] **Step 3: 编译验证**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 4: 验证行数**

Run: `wc -l src/main/domains/cowork/service/coworkRunner.ts`
Expected: < 600 行

- [ ] **Step 5: Commit**

```bash
git add src/main/domains/cowork/service/coworkRunner.ts
git commit -m "refactor(cowork): simplify CoworkRunner to facade, delegate to services"
```

---

## 第八阶段：最终验证

### Task 9: 全面验证

- [ ] **Step 1: 编译检查**

Run: `npm run compile:electron`
Expected: Success

- [ ] **Step 2: Lint 检查**

Run: `npm run lint`
Expected: Success

- [ ] **Step 3: 内存测试**

Run: `npm run test:memory`
Expected: Success

- [ ] **Step 4: 行数统计**

Run: `wc -l src/main/domains/cowork/service/*.ts`
Expected: 各文件行数符合设计 (~400-500 行)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat(cowork): complete CoworkRunner architecture refactor

- Extract Result type for explicit error handling
- Split into: ToolExecutionService, WorkspaceService, PermissionCoordinator, LocalExecutionService, SandboxExecutionService
- CoworkRunner now serves as facade, delegates to services
- All public interfaces maintained backward compatible"
```

---

## 任务依赖关系

```
Task 1 (Result类型)
    ↓
Task 2 (CoworkRunnerTypes) ← Task 1
    ↓
Task 3 (ToolExecutionService) ← Task 1, Task 2
    ↓
Task 4 (WorkspaceService) ← Task 1, Task 2
    ↓
Task 5 (PermissionCoordinator) ← Task 1, Task 2
    ↓
Task 6 (LocalExecutionService) ← Task 3, Task 4, Task 5
    ↓
Task 7 (SandboxExecutionService) ← Task 3, Task 4, Task 5
    ↓
Task 8 (Simplify CoworkRunner) ← Task 3-7
    ↓
Task 9 (Final Verification)
```

---

## 备选方案说明

如果某个任务过于复杂，可以进一步拆分:
- LocalExecutionService 可拆分为: LocalProcessService + LocalSdkService
- SandboxExecutionService 可拆分为: SandboxVmService + SandboxIpcService
- WorkspaceService 可拆分为: WorkspaceResolver + AttachmentResolver

但初始计划保持简单，按上述任务执行即可。
