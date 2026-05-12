# Main Process Restructure Implementation Plan

> **Status:** ✅ **COMPLETED (2026-05-11)** — All 9 legacy top-level files have been moved into their target directories and the old shims at `src/main/{appConstants,fsCompat,logger,autoLaunchManager,trayManager,mcpStore,scheduledTaskStore,skillServices}.ts` plus the duplicated `src/main/core/preload.ts` are deleted. `tsc --noEmit` passes. The barrel-file phase described below was executed as a transitional step and then removed.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move scattered files in `src/main/` into correct domain/system/core directories and split `lifecycle.ts` into focused modules, keeping compilation green after every batch.

**Architecture:** File-level moves with barrel-file backward compatibility; `lifecycle.ts` decomposed into factories, bootstrap, cleanup, and migrations. No logic changes.

**Tech Stack:** Electron, TypeScript, Node.js built-in test runner, sql.js

---

## File Structure

### Files to Create

| File | Responsibility |
|---|---|
| `src/main/core/constants.ts` | Application constants (moved from `appConstants.ts`) |
| `src/main/core/logger.ts` | Logging utilities (moved from `logger.ts`) |
| `src/main/core/preload.ts` | Preload script (moved from `preload.ts`) |
| `src/main/core/factories.ts` | Global state + getter factories extracted from `lifecycle.ts` |
| `src/main/core/bootstrap.ts` | Ordered startup sequence extracted from `lifecycle.ts` |
| `src/main/core/cleanup.ts` | Shutdown sequence extracted from `lifecycle.ts` |
| `src/main/core/migrations.ts` | Legacy data migrations extracted from `lifecycle.ts` |
| `src/main/system/service/autoLaunchService.ts` | Auto-launch settings (moved from `autoLaunchManager.ts`) |
| `src/main/system/service/trayService.ts` | Tray icon/menu (moved from `trayManager.ts`) |
| `src/main/domains/mcp/store/mcpStore.ts` | MCP server CRUD (moved from `mcpStore.ts`) |
| `src/main/domains/scheduled-task/store/scheduledTaskStore.ts` | Scheduled task CRUD (moved from `scheduledTaskStore.ts`) |
| `src/main/domains/skill/service/skillServiceManager.ts` | Skill background services (moved from `skillServices.ts`) |

### Files to Modify

| File | Change |
|---|---|
| `src/main/appConstants.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/fsCompat.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/logger.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/autoLaunchManager.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/trayManager.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/mcpStore.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/scheduledTaskStore.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/skillServices.ts` | Convert to barrel file, then delete after imports migrated |
| `src/main/lifecycle.ts` | Split content into new files, reduce to skeleton |
| `src/main/main.ts` | Update imports if needed |
| `src/main/ipc/router.ts` | Update imports if needed |
| `src/main/core/lifecycle.ts` | Final skeleton after split |

---

## Task 1: Move appConstants.ts and fsCompat.ts

**Files:**
- Create: `src/main/core/constants.ts`
- Create: `src/main/utils/fsCompat.ts`
- Modify: `src/main/appConstants.ts`
- Modify: `src/main/fsCompat.ts`
- Test: `npm run build`

- [ ] **Step 1: Move appConstants.ts to core/constants.ts**

  Copy the entire content of `src/main/appConstants.ts` into `src/main/core/constants.ts`.

  ```bash
  cat src/main/appConstants.ts > src/main/core/constants.ts
  ```

- [ ] **Step 2: Create barrel file for appConstants.ts**

  Replace `src/main/appConstants.ts` with:

  ```ts
  export * from './core/constants';
  ```

- [ ] **Step 3: Move fsCompat.ts to utils/fsCompat.ts**

  Copy the entire content of `src/main/fsCompat.ts` into `src/main/utils/fsCompat.ts`.

  ```bash
  cat src/main/fsCompat.ts > src/main/utils/fsCompat.ts
  ```

- [ ] **Step 4: Create barrel file for fsCompat.ts**

  Replace `src/main/fsCompat.ts` with:

  ```ts
  export * from './utils/fsCompat';
  ```

- [ ] **Step 5: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/core/constants.ts src/main/utils/fsCompat.ts src/main/appConstants.ts src/main/fsCompat.ts
  git commit -m "refactor: move appConstants and fsCompat to correct directories

Move appConstants.ts -> core/constants.ts
Move fsCompat.ts -> utils/fsCompat.ts
Keep barrel files for backward compatibility.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 2: Move logger.ts to core/logger.ts

**Files:**
- Create: `src/main/core/logger.ts`
- Modify: `src/main/logger.ts`
- Test: `npm run build`

- [ ] **Step 1: Move logger.ts to core/logger.ts**

  Copy the entire content of `src/main/logger.ts` into `src/main/core/logger.ts`.

  ```bash
  cat src/main/logger.ts > src/main/core/logger.ts
  ```

- [ ] **Step 2: Create barrel file for logger.ts**

  Replace `src/main/logger.ts` with:

  ```ts
  export * from './core/logger';
  ```

- [ ] **Step 3: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/main/core/logger.ts src/main/logger.ts
  git commit -m "refactor: move logger.ts to core/logger.ts

Keep barrel file for backward compatibility.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 3: Move autoLaunchManager.ts and trayManager.ts

**Files:**
- Create: `src/main/system/service/autoLaunchService.ts`
- Create: `src/main/system/service/trayService.ts`
- Modify: `src/main/autoLaunchManager.ts`
- Modify: `src/main/trayManager.ts`
- Test: `npm run build`

- [ ] **Step 1: Move autoLaunchManager.ts**

  Copy the entire content of `src/main/autoLaunchManager.ts` into `src/main/system/service/autoLaunchService.ts`.

  ```bash
  cat src/main/autoLaunchManager.ts > src/main/system/service/autoLaunchService.ts
  ```

- [ ] **Step 2: Create barrel file for autoLaunchManager.ts**

  Replace `src/main/autoLaunchManager.ts` with:

  ```ts
  export * from './system/service/autoLaunchService';
  ```

- [ ] **Step 3: Move trayManager.ts**

  Copy the entire content of `src/main/trayManager.ts` into `src/main/system/service/trayService.ts`.

  ```bash
  cat src/main/trayManager.ts > src/main/system/service/trayService.ts
  ```

- [ ] **Step 4: Create barrel file for trayManager.ts**

  Replace `src/main/trayManager.ts` with:

  ```ts
  export * from './system/service/trayService';
  ```

- [ ] **Step 5: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 6: Commit**

  ```bash
  git add src/main/system/service/autoLaunchService.ts src/main/system/service/trayService.ts src/main/autoLaunchManager.ts src/main/trayManager.ts
  git commit -m "refactor: move autoLaunchManager and trayManager to system/service

Move autoLaunchManager.ts -> system/service/autoLaunchService.ts
Move trayManager.ts -> system/service/trayService.ts
Keep barrel files for backward compatibility.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 4: Move Store and Service Files

**Files:**
- Create: `src/main/domains/mcp/store/mcpStore.ts`
- Create: `src/main/domains/scheduled-task/store/scheduledTaskStore.ts`
- Create: `src/main/domains/skill/service/skillServiceManager.ts`
- Modify: `src/main/mcpStore.ts`
- Modify: `src/main/scheduledTaskStore.ts`
- Modify: `src/main/skillServices.ts`
- Test: `npm run build`

- [ ] **Step 1: Move mcpStore.ts**

  Copy the entire content of `src/main/mcpStore.ts` into `src/main/domains/mcp/store/mcpStore.ts`.

  ```bash
  cat src/main/mcpStore.ts > src/main/domains/mcp/store/mcpStore.ts
  ```

- [ ] **Step 2: Create barrel file for mcpStore.ts**

  Replace `src/main/mcpStore.ts` with:

  ```ts
  export { McpStore, type McpServerRecord, type McpServerFormData } from './domains/mcp/store/mcpStore';
  ```

- [ ] **Step 3: Move scheduledTaskStore.ts**

  Copy the entire content of `src/main/scheduledTaskStore.ts` into `src/main/domains/scheduled-task/store/scheduledTaskStore.ts`.

  ```bash
  cat src/main/scheduledTaskStore.ts > src/main/domains/scheduled-task/store/scheduledTaskStore.ts
  ```

- [ ] **Step 4: Create barrel file for scheduledTaskStore.ts**

  Replace `src/main/scheduledTaskStore.ts` with:

  ```ts
  export { ScheduledTaskStore, type ScheduledTask, type ScheduledTaskInput, type ScheduledTaskRun, type TaskState, type Schedule, type NotifyPlatform, type TaskLastStatus } from './domains/scheduled-task/store/scheduledTaskStore';
  ```

- [ ] **Step 5: Move skillServices.ts**

  Copy the entire content of `src/main/skillServices.ts` into `src/main/domains/skill/service/skillServiceManager.ts`.

  ```bash
  cat src/main/skillServices.ts > src/main/domains/skill/service/skillServiceManager.ts
  ```

- [ ] **Step 6: Create barrel file for skillServices.ts**

  Replace `src/main/skillServices.ts` with:

  ```ts
  export { SkillServiceManager, getSkillServiceManager } from './domains/skill/service/skillServiceManager';
  ```

- [ ] **Step 7: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 8: Commit**

  ```bash
  git add src/main/domains/mcp/store/mcpStore.ts src/main/domains/scheduled-task/store/scheduledTaskStore.ts src/main/domains/skill/service/skillServiceManager.ts src/main/mcpStore.ts src/main/scheduledTaskStore.ts src/main/skillServices.ts
  git commit -m "refactor: move mcpStore, scheduledTaskStore, skillServices to domains

Move mcpStore.ts -> domains/mcp/store/mcpStore.ts
Move scheduledTaskStore.ts -> domains/scheduled-task/store/scheduledTaskStore.ts
Move skillServices.ts -> domains/skill/service/skillServiceManager.ts
Keep barrel files for backward compatibility.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 5: Move IM Module Files

**Files:**
- Create: `src/main/domains/im/service/imGatewayManager.ts`
- Create: `src/main/domains/im/service/imStore.ts`
- Create: `src/main/domains/im/service/imChatHandler.ts`
- Create: `src/main/domains/im/service/imCoworkHandler.ts`
- Create: `src/main/domains/im/gateway/dingtalkGateway.ts`
- Create: `src/main/domains/im/gateway/feishuGateway.ts`
- Create: `src/main/domains/im/gateway/telegramGateway.ts`
- Create: `src/main/domains/im/gateway/discordGateway.ts`
- Create: `src/main/domains/im/gateway/qqGateway.ts`
- Create: `src/main/domains/im/gateway/wecomGateway.ts`
- Create: `src/main/domains/im/types.ts`
- Modify: `src/main/im/index.ts`
- Test: `npm run build`

- [ ] **Step 1: Copy all IM files to new locations**

  ```bash
  mkdir -p src/main/domains/im/service src/main/domains/im/gateway
  cp src/main/im/imGatewayManager.ts src/main/domains/im/service/
  cp src/main/im/imStore.ts src/main/domains/im/service/
  cp src/main/im/imChatHandler.ts src/main/domains/im/service/
  cp src/main/im/imCoworkHandler.ts src/main/domains/im/service/
  cp src/main/im/dingtalkGateway.ts src/main/domains/im/gateway/
  cp src/main/im/feishuGateway.ts src/main/domains/im/gateway/
  cp src/main/im/telegramGateway.ts src/main/domains/im/gateway/
  cp src/main/im/discordGateway.ts src/main/domains/im/gateway/
  cp src/main/im/qqGateway.ts src/main/domains/im/gateway/
  cp src/main/im/wecomGateway.ts src/main/domains/im/gateway/
  cp src/main/im/types.ts src/main/domains/im/
  ```

- [ ] **Step 2: Update import paths inside moved IM files**

  Inside `src/main/domains/im/service/imGatewayManager.ts`, update relative imports:
  - `../libs/coworkRunner` → `../../libs/coworkRunner`
  - `../domains/cowork/store` → `../../domains/cowork/store`
  - `../im/types` → `../types`
  - `../im/dingtalkMedia` → `../gateway/dingtalkMedia` (note: dingtalkMedia stays in im/ for now or move too)
  - `../im/http` → `../http`

  Inside gateway files, update imports from `../im/` to `../service/` or `../types` as appropriate.

  Inside `src/main/domains/im/service/imCoworkHandler.ts`, update imports from `../im/` to relative paths.

- [ ] **Step 3: Update barrel file `src/main/im/index.ts`**

  Replace `src/main/im/index.ts` with re-exports pointing to new locations:

  ```ts
  export * from '../domains/im/types';
  export { IMStore } from '../domains/im/service/imStore';
  export { DingTalkGateway } from '../domains/im/gateway/dingtalkGateway';
  export { FeishuGateway } from '../domains/im/gateway/feishuGateway';
  export { TelegramGateway } from '../domains/im/gateway/telegramGateway';
  export { DiscordGateway } from '../domains/im/gateway/discordGateway';
  export { IMChatHandler } from '../domains/im/service/imChatHandler';
  export { IMCoworkHandler, type IMCoworkHandlerOptions } from '../domains/im/service/imCoworkHandler';
  export { IMGatewayManager, type IMGatewayManagerOptions } from '../domains/im/service/imGatewayManager';
  export * from '../domains/im/gateway/dingtalkMedia';
  export { parseMediaMarkers, stripMediaMarkers } from '../domains/im/gateway/dingtalkMediaParser';
  export { buildIMMediaInstruction } from '../domains/im/service/imMediaInstruction';
  ```

  Note: Some helper files (`dingtalkMedia.ts`, `dingtalkMediaParser.ts`, `imMediaInstruction.ts`, `http.ts`, `jsonEncoding.ts`, `logSanitizer.ts`) may remain in `src/main/im/` or be moved to `domains/im/service/` or `domains/im/utils/`. For this task, only move the main gateway/handler/manager files.

- [ ] **Step 4: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors. If import path errors occur, fix them iteratively.

- [ ] **Step 5: Commit**

  ```bash
  git add src/main/domains/im/
  git add src/main/im/index.ts
  git commit -m "refactor: move IM gateway files to domains/im/

Move gateway managers to domains/im/service/
Move platform gateways to domains/im/gateway/
Keep src/main/im/index.ts as barrel file.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 6: Extract factories.ts from lifecycle.ts

**Files:**
- Create: `src/main/core/factories.ts`
- Modify: `src/main/core/lifecycle.ts`
- Test: `npm run build`

- [ ] **Step 1: Create core/factories.ts**

  Extract from `src/main/core/lifecycle.ts` the following sections:

  - All `let` declarations for singletons (lines ~31-38 in lifecycle.ts)
  - `initStore()` function (lines ~41-59)
  - All `getXxx()` factory functions: `getStore()`, `getCoworkStore()`, `getCoworkRunner()`, `getSkillManager()`, `getMcpStore()`, `getIMGatewayManager()`, `getScheduledTaskStore()`, `getScheduler()` (lines ~61-334)
  - `AppConfigSettings` type and `getUseSystemProxyFromConfig()` (lines ~336-344)

  Create `src/main/core/factories.ts` with the extracted content. Update internal imports:
  - `./container` stays as `./container`
  - `../libs/...` stays as `../libs/...`
  - `../domains/...` stays as `../domains/...`
  - `../system/...` stays as `../system/...`
  - `../mcpStore` stays as `../mcpStore` (barrel file still active)
  - `../scheduledTaskStore` stays as `../scheduledTaskStore` (barrel file)
  - `../skillServices` stays as `../skillServices` (barrel file)
  - `../im` stays as `../im` (barrel file)
  - `../autoLaunchManager` stays as `../autoLaunchManager` (barrel file)
  - `../trayManager` stays as `../trayManager` (barrel file)

- [ ] **Step 2: Update lifecycle.ts to import from factories**

  In `src/main/core/lifecycle.ts`, replace the extracted sections with imports from `./factories`:

  ```ts
  import {
    initStore,
    getStore,
    getCoworkStore,
    getCoworkRunner,
    getSkillManager,
    getMcpStore,
    getIMGatewayManager,
    getScheduledTaskStore,
    getScheduler,
    AppConfigSettings,
    getUseSystemProxyFromConfig,
  } from './factories';
  ```

  Remove the original `let` declarations and function definitions from lifecycle.ts.

- [ ] **Step 3: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/main/core/factories.ts src/main/core/lifecycle.ts
  git commit -m "refactor: extract factories.ts from lifecycle.ts

Extract singleton getters and global state into core/factories.ts.
lifecycle.ts now imports from factories.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 7: Extract migrations.ts from lifecycle.ts

**Files:**
- Create: `src/main/core/migrations.ts`
- Modify: `src/main/core/lifecycle.ts`
- Test: `npm run build`

- [ ] **Step 1: Create core/migrations.ts**

  Extract from `src/main/core/lifecycle.ts`:
  - `USER_MEMORIES_MIGRATION_KEY`
  - `tryReadLegacyMemoryText()`
  - `parseLegacyMemoryEntries()`
  - `memoryFingerprint()`
  - `migrateLegacyMemoryFileToUserMemories()`
  - `migrateFromElectronStore()`

  Create `src/main/core/migrations.ts` with these functions. It needs imports:
  ```ts
  import path from 'path';
  import fs from 'fs';
  import { app } from 'electron';
  import type { Database } from 'sql.js';
  ```

- [ ] **Step 2: Update lifecycle.ts**

  In `src/main/core/lifecycle.ts`:
  - Add import: `import { migrateLegacyMemoryFileToUserMemories, migrateFromElectronStore } from './migrations';`
  - Remove the original migration function definitions.

- [ ] **Step 3: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/main/core/migrations.ts src/main/core/lifecycle.ts
  git commit -m "refactor: extract migrations.ts from lifecycle.ts

Extract legacy data migrations into core/migrations.ts.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 8: Extract cleanup.ts from lifecycle.ts

**Files:**
- Create: `src/main/core/cleanup.ts`
- Modify: `src/main/core/lifecycle.ts`
- Test: `npm run build`

- [ ] **Step 1: Create core/cleanup.ts**

  Extract from `src/main/core/lifecycle.ts`:
  - `isCleanupFinished` / `isCleanupInProgress` flags
  - `runAppCleanup()` function
  - `handleTerminationSignal()` function

  Create `src/main/core/cleanup.ts`. It needs imports:
  ```ts
  import { app } from 'electron';
  import { destroyTray } from '../system/service/trayService';
  import { getSkillServiceManager } from '../skillServices'; // barrel
  import { getCoworkRunner, getIMGatewayManager, getScheduler, getSkillManager } from './factories';
  import { stopCoworkOpenAICompatProxy } from '../libs/coworkOpenAICompatProxy';
  import { setIsQuitting } from './window';
  ```

- [ ] **Step 2: Update lifecycle.ts**

  In `src/main/core/lifecycle.ts`:
  - Add import: `import { runAppCleanup, handleTerminationSignal, isCleanupFinished, isCleanupInProgress } from './cleanup';`
  - Remove the original cleanup function and flag definitions.

- [ ] **Step 3: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/main/core/cleanup.ts src/main/core/lifecycle.ts
  git commit -m "refactor: extract cleanup.ts from lifecycle.ts

Extract shutdown sequence into core/cleanup.ts.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 9: Extract bootstrap.ts from lifecycle.ts

**Files:**
- Create: `src/main/core/bootstrap.ts`
- Modify: `src/main/core/lifecycle.ts`
- Test: `npm run build`

- [ ] **Step 1: Create core/bootstrap.ts**

  Extract from `src/main/core/lifecycle.ts`:
  - `bootstrap()` async function (~lines 431-589)

  Create `src/main/core/bootstrap.ts`. It needs imports:
  ```ts
  import { app } from 'electron';
  import path from 'path';
  import fs from 'fs';
  import os from 'os';
  import {
    initStore, getStore, getCoworkStore, getCoworkRunner,
    getSkillManager, getMcpStore, getIMGatewayManager,
    getScheduledTaskStore, getScheduler,
    AppConfigSettings, getUseSystemProxyFromConfig,
  } from './factories';
  import { setStoreGetter } from '../libs/claudeSettings';
  import { startCoworkOpenAICompatProxy, setScheduledTaskDeps } from '../libs/coworkOpenAICompatProxy';
  import { isAutoLaunched, setAutoLaunchEnabled } from '../system/service/autoLaunchService';
  import { createTray, updateTrayMenu } from '../system/service/trayService';
  import { ensurePythonRuntimeReady } from '../libs/pythonRuntime';
  import { applyProxyPreference } from '../system/service/proxyService';
  import { setContainer } from './container';
  import { registerIPCHandlers } from '../ipc/router';
  import { setContentSecurityPolicy } from './csp';
  import { createWindow, getMainWindow, updateTitleBarOverlay, setIsQuitting } from './window';
  import { onSandboxProgress } from '../libs/coworkSandboxRuntime';
  import { migrateLegacyMemoryFileToUserMemories, migrateFromElectronStore } from './migrations';
  ```

- [ ] **Step 2: Update lifecycle.ts to skeleton**

  Replace the remaining `lifecycle.ts` with the skeleton:

  ```ts
  import { app, BrowserWindow } from 'electron';
  import { initApp } from './lifecycle';
  import { bootstrap } from './bootstrap';
  import { runAppCleanup, handleTerminationSignal, isCleanupFinished, isCleanupInProgress } from './cleanup';
  import { setIsQuitting } from './window';
  import { onSandboxProgress } from '../libs/coworkSandboxRuntime';
  import { broadcastToAllWindows } from './broadcaster';

  export function initApp(): Promise<void> {
    onSandboxProgress((progress) => {
      broadcastToAllWindows('cowork:sandbox:downloadProgress', progress);
    });

    app.on('before-quit', (e) => {
      if (isCleanupFinished) return;
      e.preventDefault();
      if (isCleanupInProgress) return;
      isCleanupInProgress = true;
      setIsQuitting(true);
      void runAppCleanup()
        .catch((error) => console.error('[Main] Cleanup error:', error))
        .finally(() => {
          isCleanupFinished = true;
          isCleanupInProgress = false;
          app.exit(0);
        });
    });

    process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
    process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));

    app.on('window-all-closed', () => {
      if (process.platform !== 'darwin') app.quit();
    });

    return bootstrap();
  }
  ```

  Note: The `activate` event handler is currently inside `bootstrap()`. It should be moved to `lifecycle.ts` since it's an app lifecycle event. Extract it from bootstrap and place it in `lifecycle.ts` after the `return bootstrap()` line:

  ```ts
  // After return bootstrap();
  // (Actually this needs to be registered before app is ready, so keep it in lifecycle.ts)
  ```

  Actually, looking at the original code, `app.on('activate', ...)` is at the end of `bootstrap()`. For proper separation, move it to `lifecycle.ts` after `return bootstrap()`:

  ```ts
  export function initApp(): Promise<void> {
    // ... existing event handlers ...

    app.on('activate', () => {
      const win = getMainWindow();
      if (win && !win.isDestroyed()) {
        if (!win.isVisible()) win.show();
        if (!win.isFocused()) win.focus();
        return;
      }
      if (BrowserWindow.getAllWindows().length === 0) {
        // Re-create window...
      }
    });

    return bootstrap();
  }
  ```

  This requires importing `getMainWindow` and `createWindow` in lifecycle.ts. Alternatively, keep the activate handler in bootstrap.ts since it calls `createWindow` with callbacks. The cleaner approach is to have bootstrap return a cleanup/teardown function, but for Phase 1, we can keep the activate handler in bootstrap.ts to minimize changes.

  Simpler approach for Phase 1: keep `app.on('activate', ...)` inside `bootstrap.ts` — it's still part of the startup sequence even though it's an event registration.

- [ ] **Step 3: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors.

- [ ] **Step 4: Commit**

  ```bash
  git add src/main/core/bootstrap.ts src/main/core/lifecycle.ts
  git commit -m "refactor: extract bootstrap.ts from lifecycle.ts

Extract startup sequence into core/bootstrap.ts.
lifecycle.ts is now a skeleton registering Electron events.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 10: Migrate Internal Imports to New Paths

**Files:**
- Modify: All files importing from old barrel file paths
- Delete: All barrel files
- Test: `npm run build`

- [ ] **Step 1: Update imports in core/lifecycle.ts and core/bootstrap.ts**

  Replace barrel file imports with direct new paths:
  - `../mcpStore` → `../domains/mcp/store/mcpStore`
  - `../scheduledTaskStore` → `../domains/scheduled-task/store/scheduledTaskStore`
  - `../skillServices` → `../domains/skill/service/skillServiceManager`
  - `../autoLaunchManager` → `../system/service/autoLaunchService`
  - `../trayManager` → `../system/service/trayService`
  - `../appConstants` → `./constants`
  - `../logger` → `./logger`
  - `../fsCompat` → `../utils/fsCompat`

- [ ] **Step 2: Update imports in ipc/router.ts**

  Check if `ipc/router.ts` imports from any old paths and update.

- [ ] **Step 3: Update imports in main.ts**

  Check if `main.ts` imports from any old paths and update. Currently it imports `APP_NAME` from `./appConstants` — update to `./core/constants`.

- [ ] **Step 4: Search for remaining old-path imports**

  ```bash
  grep -r "from '../appConstants'" src/main/ || true
  grep -r "from '../logger'" src/main/ || true
  grep -r "from '../fsCompat'" src/main/ || true
  grep -r "from '../autoLaunchManager'" src/main/ || true
  grep -r "from '../trayManager'" src/main/ || true
  grep -r "from '../mcpStore'" src/main/ || true
  grep -r "from '../scheduledTaskStore'" src/main/ || true
  grep -r "from '../skillServices'" src/main/ || true
  ```

  Fix any remaining occurrences.

- [ ] **Step 5: Delete barrel files**

  ```bash
  rm src/main/appConstants.ts
  rm src/main/fsCompat.ts
  rm src/main/logger.ts
  rm src/main/autoLaunchManager.ts
  rm src/main/trayManager.ts
  rm src/main/mcpStore.ts
  rm src/main/scheduledTaskStore.ts
  rm src/main/skillServices.ts
  ```

- [ ] **Step 6: Build and verify**

  ```bash
  npm run build
  ```

  Expected: Compiles without errors. If not, fix any missed imports.

- [ ] **Step 7: Commit**

  ```bash
  git add -A
  git commit -m "refactor: remove barrel files, migrate all imports to new paths

All internal imports now point to canonical locations.
Barrel files removed.

author: zhuman
date: 2026-05-11"
  ```

---

## Task 11: Final Verification

- [ ] **Step 1: Full build**

  ```bash
  npm run build
  ```

  Expected: Zero errors.

- [ ] **Step 2: Lint check**

  ```bash
  npm run lint
  ```

  Expected: Zero errors (or only pre-existing ones).

- [ ] **Step 3: Verify lifecycle.ts line count**

  ```bash
  wc -l src/main/core/lifecycle.ts
  ```

  Expected: Under 50 lines.

- [ ] **Step 4: Verify root directory is clean**

  ```bash
  ls src/main/*.ts
  ```

  Expected: Only `main.ts` and `preload.ts` (preload will be moved in a follow-up if needed, but it's a special Electron file that may stay).

  Actually, `preload.ts` was planned to move to `core/preload.ts`. If not yet moved, do it now or leave for a separate quick task.

- [ ] **Step 5: Commit final state**

  ```bash
  git add -A
  git commit -m "refactor: complete main process restructure Phase 1

- Files moved to domain/system/core directories
- lifecycle.ts split into factories/bootstrap/cleanup/migrations
- All imports migrated to canonical paths
- Barrel files cleaned up

author: zhuman
date: 2026-05-11"
  ```

---

## Self-Review Checklist

- [ ] **Spec coverage:** Every batch from the design doc is covered by Tasks 1-10.
- [ ] **Placeholder scan:** No TBD, TODO, or "implement later" in the plan.
- [ ] **Type consistency:** `getStore`, `getCoworkStore`, etc. signatures match original. Export names match original barrel file re-exports.
- [ ] **Import path correctness:** All relative paths in moved files verified against new directory depth.
