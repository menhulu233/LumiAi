import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { KvStore } from '../system/store/kvStore';
import { CoworkStore } from '../domains/cowork/store';
import { CoworkRunner } from '../libs/coworkRunner';
import { SkillManager } from '../domains/skill/skillManager';
import { McpStore } from '../mcpStore';
import { IMGatewayManager } from '../im';
import { ScheduledTaskStore } from '../scheduledTaskStore';
import { Scheduler } from '../libs/scheduler';
import { setStoreGetter } from '../libs/claudeSettings';
import { startCoworkOpenAICompatProxy, stopCoworkOpenAICompatProxy, setScheduledTaskDeps } from '../libs/coworkOpenAICompatProxy';
import { getSkillServiceManager } from '../skillServices';
import { isAutoLaunched, setAutoLaunchEnabled } from '../autoLaunchManager';
import { createTray, destroyTray, updateTrayMenu } from '../trayManager';
import { ensurePythonRuntimeReady } from '../libs/pythonRuntime';
import { applyProxyPreference } from '../system/service/proxyService';
import { setContainer, getContainer } from './container';
import { registerIPCHandlers } from '../ipc/router';
import { setContentSecurityPolicy } from './csp';
import { createWindow, getMainWindow, updateTitleBarOverlay, setIsQuitting } from './window';
import { broadcastToAllWindows } from './broadcaster';
import { onSandboxProgress } from '../libs/coworkSandboxRuntime';
import { coworkMigrations } from '../domains/cowork/store/_migrations';
import { memoryMigrations } from '../domains/cowork/store/_memoryMigrations';
import { scheduledTaskMigrations } from '../domains/scheduled-task/store/_migrations';
import { mcpMigrations } from '../domains/mcp/store/_migrations';

let store: KvStore | null = null;
let coworkStore: CoworkStore | null = null;
let coworkRunner: CoworkRunner | null = null;
let skillManager: SkillManager | null = null;
let mcpStore: McpStore | null = null;
let imGatewayManager: IMGatewayManager | null = null;
let scheduledTaskStore: ScheduledTaskStore | null = null;
let scheduler: Scheduler | null = null;
let storeInitPromise: Promise<KvStore> | null = null;

const initStore = async (): Promise<KvStore> => {
  if (!storeInitPromise) {
    if (!app.isReady()) {
      throw new Error('Store accessed before app is ready.');
    }
    storeInitPromise = Promise.race([
      KvStore.create(app.getPath('userData'), [
        ...coworkMigrations,
        ...memoryMigrations,
        ...scheduledTaskMigrations,
        ...mcpMigrations,
      ]),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('Store initialization timed out after 15s')), 15_000)
      ),
    ]);
  }
  return storeInitPromise;
};

export const getStore = (): KvStore => {
  if (!store) {
    throw new Error('Store not initialized. Call initStore() first.');
  }
  return store;
};

// ==================== Legacy Migration Helpers ====================
// These are temporary helpers moved from sqliteStore.ts.
// They will be cleaned up in a future refactoring task.

const USER_MEMORIES_MIGRATION_KEY = 'userMemories.migration.v1.completed';

function tryReadLegacyMemoryText(): string {
  const candidates = [
    path.join(process.cwd(), 'MEMORY.md'),
    path.join(app.getAppPath(), 'MEMORY.md'),
    path.join(process.cwd(), 'memory.md'),
    path.join(app.getAppPath(), 'memory.md'),
  ];

  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
        return fs.readFileSync(candidate, 'utf8');
      }
    } catch {
      // Skip unreadable candidates.
    }
  }
  return '';
}

function parseLegacyMemoryEntries(raw: string): string[] {
  const normalized = raw.replace(/```[\s\S]*?```/g, ' ');
  const lines = normalized.split(/\r?\n/);
  const entries: string[] = [];
  const seen = new Set<string>();

  for (const line of lines) {
    const match = line.trim().match(/^-+\s*(?:\[[^\]]+\]\s*)?(.+)$/);
    if (!match?.[1]) continue;
    const text = match[1].replace(/\s+/g, ' ').trim();
    if (!text || text.length < 6) continue;
    if (/^\(empty\)$/i.test(text)) continue;
    const key = text.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(text.length > 360 ? `${text.slice(0, 359)}…` : text);
  }

  return entries.slice(0, 200);
}

function memoryFingerprint(text: string): string {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return require('crypto').createHash('sha1').update(normalized).digest('hex');
}

function migrateLegacyMemoryFileToUserMemories(db: any, storeGet: (key: string) => any, storeSet: (key: string, value: any) => void): void {
  if (storeGet(USER_MEMORIES_MIGRATION_KEY) === '1') {
    return;
  }

  const content = tryReadLegacyMemoryText();
  if (!content.trim()) {
    storeSet(USER_MEMORIES_MIGRATION_KEY, '1');
    return;
  }

  const entries = parseLegacyMemoryEntries(content);
  if (entries.length === 0) {
    storeSet(USER_MEMORIES_MIGRATION_KEY, '1');
    return;
  }

  const now = Date.now();
  const crypto = require('crypto');
  db.run('BEGIN TRANSACTION;');
  try {
    for (const text of entries) {
      const fp = memoryFingerprint(text);
      const existing = db.exec(
        `SELECT id FROM user_memories WHERE fingerprint = ? AND status != 'deleted' LIMIT 1`,
        [fp]
      );
      if (existing[0]?.values?.[0]?.[0]) {
        continue;
      }

      const memoryId = crypto.randomUUID();
      db.run(`
        INSERT INTO user_memories (
          id, text, fingerprint, confidence, is_explicit, status, created_at, updated_at, last_used_at
        ) VALUES (?, ?, ?, ?, 1, 'created', ?, ?, NULL)
      `, [memoryId, text, fp, 0.9, now, now]);

      db.run(`
        INSERT INTO user_memory_sources (id, memory_id, session_id, message_id, role, is_active, created_at)
        VALUES (?, ?, NULL, NULL, 'system', 1, ?)
      `, [crypto.randomUUID(), memoryId, now]);
    }

    db.run('COMMIT;');
  } catch (error) {
    db.run('ROLLBACK;');
    console.warn('Failed to migrate legacy MEMORY.md entries:', error);
  }

  storeSet(USER_MEMORIES_MIGRATION_KEY, '1');
}

function migrateFromElectronStore(db: any, userDataPath: string, saveFn: () => void): void {
  const result = db.exec('SELECT COUNT(*) as count FROM kv');
  const count = result[0]?.values[0]?.[0] as number;
  if (count > 0) return;

  const legacyPath = path.join(userDataPath, 'config.json');
  if (!fs.existsSync(legacyPath)) return;

  try {
    const raw = fs.readFileSync(legacyPath, 'utf8');
    const data = JSON.parse(raw) as Record<string, unknown>;
    if (!data || typeof data !== 'object') return;

    const entries = Object.entries(data);
    if (!entries.length) return;

    const now = Date.now();
    db.run('BEGIN TRANSACTION;');
    try {
      entries.forEach(([key, value]) => {
        db.run(`
          INSERT INTO kv (key, value, updated_at)
          VALUES (?, ?, ?)
        `, [key, JSON.stringify(value), now]);
      });
      db.run('COMMIT;');
      saveFn();
      console.info(`Migrated ${entries.length} entries from electron-store.`);
    } catch (error) {
      db.run('ROLLBACK;');
      throw error;
    }
  } catch (error) {
    console.warn('Failed to migrate electron-store data:', error);
  }
}

export const getCoworkStore = () => {
  if (!coworkStore) {
    const kvStore = getStore();
    coworkStore = new CoworkStore(kvStore.getDatabase(), () => kvStore.save());
    const cleaned = coworkStore.autoDeleteNonPersonalMemories();
    if (cleaned > 0) {
      console.info(`[cowork-memory] Auto-deleted ${cleaned} non-personal/procedural memories`);
    }
  }
  return coworkStore;
};

export const getCoworkRunner = () => {
  if (!coworkRunner) {
    coworkRunner = new CoworkRunner(getCoworkStore());
    coworkRunner.setMcpServerProvider(() => {
      return getMcpStore().getEnabledServers();
    });
  }
  return coworkRunner;
};

export const getSkillManager = () => {
  if (!skillManager) {
    skillManager = new SkillManager(getStore);
  }
  return skillManager;
};

export const getMcpStore = () => {
  if (!mcpStore) {
    const kvStore = getStore();
    mcpStore = new McpStore(kvStore.getDatabase(), () => kvStore.save());
  }
  return mcpStore;
};

export const getIMGatewayManager = () => {
  if (!imGatewayManager) {
    const kvStore = getStore();
    const runner = getCoworkRunner();
    const store = getCoworkStore();

    imGatewayManager = new IMGatewayManager(
      kvStore.getDatabase(),
      () => kvStore.save(),
      {
        coworkRunner: runner,
        coworkStore: store,
      }
    );

    imGatewayManager.initialize({
      getLLMConfig: async () => {
        const appConfig = kvStore.get<any>('app_config');
        if (!appConfig) return null;
        const providers = appConfig.providers || {};
        for (const [providerName, providerConfig] of Object.entries(providers) as [string, any][]) {
          if (providerConfig.enabled && providerConfig.apiKey) {
            const model = providerConfig.models?.[0]?.id;
            return {
              apiKey: providerConfig.apiKey,
              baseUrl: providerConfig.baseUrl,
              model: model,
              provider: providerName,
            };
          }
        }
        if (appConfig.api?.key) {
          return {
            apiKey: appConfig.api.key,
            baseUrl: appConfig.api.baseUrl,
            model: appConfig.model?.defaultModel,
          };
        }
        return null;
      },
      getSkillsPrompt: async () => {
        return getSkillManager().buildAutoRoutingPrompt();
      },
    });

    imGatewayManager.on('statusChange', (status) => {
      broadcastToAllWindows('im:status:change', status);
    });

    imGatewayManager.on('message', (message) => {
      broadcastToAllWindows('im:message:received', message);
    });

    imGatewayManager.on('error', ({ platform, error }) => {
      console.error(`[IM Gateway] ${platform} error:`, error);
    });
  }
  return imGatewayManager;
};

export const getScheduledTaskStore = () => {
  if (!scheduledTaskStore) {
    const kvStore = getStore();
    scheduledTaskStore = new ScheduledTaskStore(kvStore.getDatabase(), () => kvStore.save());
  }
  return scheduledTaskStore;
};

export const getScheduler = () => {
  if (!scheduler) {
    scheduler = new Scheduler({
      scheduledTaskStore: getScheduledTaskStore(),
      coworkStore: getCoworkStore(),
      getCoworkRunner,
      getIMGatewayManager: () => {
        try { return getIMGatewayManager(); } catch { return null; }
      },
      getSkillsPrompt: async () => {
        return getSkillManager().buildAutoRoutingPrompt();
      },
    });
  }
  return scheduler;
};

type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
};

let isCleanupFinished = false;
let isCleanupInProgress = false;

export const runAppCleanup = async (): Promise<void> => {
  console.log('[Main] App is quitting, starting cleanup...');
  destroyTray();
  skillManager?.stopWatching();

  if (coworkRunner) {
    console.log('[Main] Stopping cowork sessions...');
    coworkRunner.stopAllSessions();
  }

  await stopCoworkOpenAICompatProxy().catch((error) => {
    console.error('Failed to stop OpenAI compatibility proxy:', error);
  });

  const skillServices = getSkillServiceManager();
  await skillServices.stopAll();

  if (imGatewayManager) {
    await imGatewayManager.stopAll().catch(err => {
      console.error('[IM Gateway] Error stopping gateways on quit:', err);
    });
  }

  if (scheduler) {
    scheduler.stop();
  }
};

const handleTerminationSignal = (signal: NodeJS.Signals) => {
  if (isCleanupFinished || isCleanupInProgress) {
    return;
  }
  console.log(`[Main] Received ${signal}, running cleanup before exit...`);
  isCleanupInProgress = true;
  setIsQuitting(true);
  void runAppCleanup()
    .catch((error) => {
      console.error(`[Main] Cleanup error during ${signal}:`, error);
    })
    .finally(() => {
      isCleanupFinished = true;
      isCleanupInProgress = false;
      app.exit(0);
    });
};

export function initApp(): Promise<void> {
  onSandboxProgress((progress) => {
    broadcastToAllWindows('cowork:sandbox:downloadProgress', progress);
  });

  app.on('before-quit', (e) => {
    if (isCleanupFinished) return;
    e.preventDefault();
    if (isCleanupInProgress) {
      return;
    }
    isCleanupInProgress = true;
    setIsQuitting(true);
    void runAppCleanup()
      .catch((error) => {
        console.error('[Main] Cleanup error:', error);
      })
      .finally(() => {
        isCleanupFinished = true;
        isCleanupInProgress = false;
        app.exit(0);
      });
  });

  process.once('SIGINT', () => handleTerminationSignal('SIGINT'));
  process.once('SIGTERM', () => handleTerminationSignal('SIGTERM'));

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') {
      app.quit();
    }
  });

  return bootstrap();
}

async function bootstrap(): Promise<void> {
  console.log('[Main] initApp: waiting for app.whenReady()');
  await app.whenReady();
  console.log('[Main] initApp: app is ready');

  const defaultProjectDir = path.join(os.homedir(), 'lumiai', 'project');
  if (!fs.existsSync(defaultProjectDir)) {
    fs.mkdirSync(defaultProjectDir, { recursive: true });
    console.log('Created default project directory:', defaultProjectDir);
  }
  console.log('[Main] initApp: default project dir ensured');

  console.log('[Main] initApp: starting initStore()');
  store = await initStore();
  console.log('[Main] initApp: store initialized');

  try {
    migrateLegacyMemoryFileToUserMemories(store.getDatabase(), (key) => store!.get(key), (key, value) => store!.set(key, value));
    migrateFromElectronStore(store.getDatabase(), app.getPath('userData'), () => store!.save());
    console.log('[Main] initApp: legacy migrations done');
  } catch (error) {
    console.warn('[Main] initApp: legacy migrations failed:', error);
  }

  const resetCount = getCoworkStore().resetRunningSessions();
  console.log('[Main] initApp: resetRunningSessions done, count:', resetCount);
  if (resetCount > 0) {
    console.log(`[Main] Reset ${resetCount} stuck cowork session(s) from running -> idle`);
  }

  setStoreGetter(() => store);
  console.log('[Main] initApp: setStoreGetter done');
  const manager = getSkillManager();
  console.log('[Main] initApp: getSkillManager done');

  try {
    manager.syncBundledSkillsToUserData();
    console.log('[Main] initApp: syncBundledSkillsToUserData done');
  } catch (error) {
    console.error('[Main] initApp: syncBundledSkillsToUserData failed:', error);
  }

  try {
    const runtimeResult = await ensurePythonRuntimeReady();
    if (!runtimeResult.success) {
      console.error('[Main] initApp: ensurePythonRuntimeReady failed:', runtimeResult.error);
    } else {
      console.log('[Main] initApp: ensurePythonRuntimeReady done');
    }
  } catch (error) {
    console.error('[Main] initApp: ensurePythonRuntimeReady threw:', error);
  }

  try {
    manager.startWatching();
    console.log('[Main] initApp: startWatching done');
  } catch (error) {
    console.error('[Main] initApp: startWatching failed:', error);
  }

  try {
    const skillServices = getSkillServiceManager();
    console.log('[Main] initApp: getSkillServiceManager done');
    await skillServices.startAll();
    console.log('[Main] initApp: skill services started');
  } catch (error) {
    console.error('[Main] initApp: skill services failed:', error);
  }

  const appConfig = getStore().get<AppConfigSettings>('app_config');
  await applyProxyPreference(getUseSystemProxyFromConfig(appConfig));

  await startCoworkOpenAICompatProxy().catch((error) => {
    console.error('Failed to start OpenAI compatibility proxy:', error);
  });

  setScheduledTaskDeps({ getScheduledTaskStore, getScheduler });

  setContainer({
    store: getStore(),
    coworkStore: getCoworkStore(),
    coworkRunner: getCoworkRunner(),
    skillManager: getSkillManager(),
    mcpStore: getMcpStore(),
    imGatewayManager: getIMGatewayManager(),
    scheduledTaskStore: getScheduledTaskStore(),
    scheduler: getScheduler(),
  });

  registerIPCHandlers(getContainer());

  setContentSecurityPolicy();

  console.log('[Main] initApp: creating window');
  createWindow(
    () => getStore().get<AppConfigSettings>('app_config'),
    () => {
      const win = getMainWindow();
      if (!isAutoLaunched()) {
        win?.show();
      }
      createTray(() => getMainWindow(), getStore());
      getScheduler().start();
    }
  );
  console.log('[Main] initApp: window created');

  getIMGatewayManager().startAllEnabled().catch((error) => {
    console.error('[IM] Failed to auto-start enabled gateways:', error);
  });

  if (!getStore().get('auto_launch_initialized')) {
    getStore().set('auto_launch_initialized', true);
    getStore().set('auto_launch_enabled', true);
    setAutoLaunchEnabled(true);
  }

  let lastLanguage = getStore().get<AppConfigSettings>('app_config')?.language;
  let lastUseSystemProxy = getUseSystemProxyFromConfig(getStore().get<AppConfigSettings>('app_config'));
  getStore().onDidChange<AppConfigSettings>('app_config', (newConfig, oldConfig) => {
    updateTitleBarOverlay(getStore().get<AppConfigSettings>('app_config'));
    const currentLanguage = newConfig?.language;
    if (currentLanguage !== lastLanguage) {
      lastLanguage = currentLanguage;
      updateTrayMenu(() => getMainWindow(), getStore());
    }

    const previousUseSystemProxy = oldConfig
      ? getUseSystemProxyFromConfig(oldConfig)
      : lastUseSystemProxy;
    const currentUseSystemProxy = getUseSystemProxyFromConfig(newConfig);
    if (currentUseSystemProxy !== previousUseSystemProxy) {
      void applyProxyPreference(currentUseSystemProxy);
    }
    lastUseSystemProxy = currentUseSystemProxy;
  });

  app.on('activate', () => {
    const win = getMainWindow();
    if (win && !win.isDestroyed()) {
      if (!win.isVisible()) win.show();
      if (!win.isFocused()) win.focus();
      return;
    }
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow(
        () => getStore().get<AppConfigSettings>('app_config'),
        () => {
          const w = getMainWindow();
          if (!isAutoLaunched()) {
            w?.show();
          }
          createTray(() => getMainWindow(), getStore());
          getScheduler().start();
        }
      );
    }
  });
}
