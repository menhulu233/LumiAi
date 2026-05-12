# Main Process Restructure Design

## Overview

Move scattered files in `src/main/` into the correct `domain/` / `system/` / `core/` directories and split the 590-line `lifecycle.ts` into focused modules. Each batch must keep the project compiling.

## Goals

1. Eliminate root-level file sprawl in `src/main/`.
2. Establish a single source of truth for each module's location.
3. Reduce `lifecycle.ts` to an event-registration skeleton.
4. Preserve compilation at every step.

## Non-Goals

- Refactoring logic inside moved files (logic changes are Phase 2+).
- Removing the `libs/` directory (that is Phase 3).
- Adding tests (that is Phase 4).

## Final Directory Structure

```
src/main/
  core/
    constants.ts              ← appConstants.ts
    logger.ts                 ← logger.ts
    preload.ts                ← preload.ts
    lifecycle.ts              # skeleton: event registration only
    bootstrap.ts              # new: startup sequence
    cleanup.ts                # new: shutdown sequence
    factories.ts              # new: getters + global state
  system/
    service/
      autoLaunchService.ts    ← autoLaunchManager.ts
      trayService.ts          ← trayManager.ts
  domains/
    mcp/
      store/
        mcpStore.ts           ← mcpStore.ts
    scheduled-task/
      store/
        scheduledTaskStore.ts ← scheduledTaskStore.ts
    skill/
      service/
        skillServiceManager.ts ← skillServices.ts
    im/
      service/
        imGatewayManager.ts
        imStore.ts
        imChatHandler.ts
        imCoworkHandler.ts
      gateway/
        dingtalkGateway.ts
        feishuGateway.ts
        telegramGateway.ts
        discordGateway.ts
        qqGateway.ts
        wecomGateway.ts
      types.ts
  utils/
    fsCompat.ts               ← fsCompat.ts
```

The `libs/` directory is intentionally left untouched for now.

## Execution Batches (Dependency Order)

| Batch | Files | External Dependencies |
|---|---|---|
| 1 | `appConstants.ts` → `core/constants.ts`<br>`fsCompat.ts` → `utils/fsCompat.ts` | None |
| 2 | `logger.ts` → `core/logger.ts` | Batch 1 |
| 3 | `autoLaunchManager.ts` → `system/service/autoLaunchService.ts`<br>`trayManager.ts` → `system/service/trayService.ts` | Batch 1+2 |
| 4 | `mcpStore.ts` → `domains/mcp/store/mcpStore.ts`<br>`scheduledTaskStore.ts` → `domains/scheduled-task/store/scheduledTaskStore.ts`<br>`skillServices.ts` → `domains/skill/service/skillServiceManager.ts` | Batch 1+2+3 |
| 5 | `im/*.ts` → `domains/im/{service,gateway}/` | Batch 1~4 |
| 6 | `lifecycle.ts` split into `bootstrap.ts` / `cleanup.ts` / `factories.ts` / `migrations.ts` | All above |

## Barrel File Strategy

After moving a file, keep the old file as a re-export so existing imports continue to work:

```ts
// src/main/mcpStore.ts (old location)
export { McpStore, type McpServerRecord, type McpServerFormData }
  from './domains/mcp/store/mcpStore';
```

Internal imports inside the codebase are migrated to the new path in the same batch. Once all internal imports are updated, the barrel file is deleted.

## lifecycle.ts Split

### `core/factories.ts` (~180 lines)

- Global variables: `store`, `coworkStore`, `coworkRunner`, `skillManager`, `mcpStore`, `imGatewayManager`, `scheduledTaskStore`, `scheduler`
- `initStore()`
- `getStore()`, `getCoworkStore()`, `getCoworkRunner()`, `getSkillManager()`, `getMcpStore()`, `getIMGatewayManager()`, `getScheduledTaskStore()`, `getScheduler()`
- `AppConfigSettings` type
- `getUseSystemProxyFromConfig()`

### `core/bootstrap.ts` (~120 lines)

- `bootstrap()` — explicit ordered startup:
  1. `await app.whenReady()`
  2. Ensure default project directory
  3. `store = await initStore()`
  4. Run legacy migrations
  5. Reset stuck cowork sessions
  6. Init skill manager (sync bundled skills, start watching, start services)
  7. Ensure Python runtime
  8. Apply proxy preference + start OpenAI compat proxy
  9. Set scheduled-task dependencies
  10. Build container + register IPC handlers
  11. Create window + tray
  12. Start IM gateways
  13. Initialize auto-launch
  14. Subscribe to config changes

### `core/cleanup.ts` (~50 lines)

- `runAppCleanup()`
- `handleTerminationSignal()`
- `isCleanupFinished` / `isCleanupInProgress` flags

### `core/migrations.ts` (~110 lines, new file)

- `migrateLegacyMemoryFileToUserMemories()`
- `migrateFromElectronStore()`
- `USER_MEMORIES_MIGRATION_KEY`

### `core/lifecycle.ts` (~30 lines)

- `initApp()` — registers Electron lifecycle events (`before-quit`, `SIGINT`, `SIGTERM`, `window-all-closed`, `activate`) and calls `bootstrap()`.

## Acceptance Criteria

- [ ] Every file listed in the batches has been moved to its target location.
- [ ] `npm run build` compiles without errors after each batch.
- [ ] `lifecycle.ts` is under 50 lines.
- [ ] No file remains in `src/main/` root except `main.ts`.
- [ ] All barrel files are removed after internal imports are migrated.
- [ ] `npm run lint` passes.
