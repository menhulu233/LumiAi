import { app } from 'electron';
import { KvStore } from '../system/store/kvStore';
import { CoworkStore } from '../domains/cowork/store';
import { CoworkRunner } from '../libs/coworkRunner';
import { SkillManager } from '../domains/skill/skillManager';
import { McpStore } from '../domains/mcp/store/mcpStore';
import { IMGatewayManager } from '../domains/im/service/imGatewayManager';
import { ScheduledTaskStore } from '../domains/scheduled-task/store/scheduledTaskStore';
import { Scheduler } from '../domains/scheduled-task/service/scheduler';
import { broadcastToAllWindows } from './broadcaster';
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

export const initStore = async (): Promise<KvStore> => {
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

function assertStoreReady(caller: string): void {
  if (!store) {
    throw new Error(`Store not initialized. Call initStore() first. (triggered by ${caller})`);
  }
}

export const getStore = (): KvStore => {
  assertStoreReady('getStore');
  return store!;
};

export const setStoreInstance = (instance: KvStore | null): void => {
  store = instance;
};

export const getCoworkStore = () => {
  if (!coworkStore) {
    assertStoreReady('getCoworkStore');
    const kvStore = store!;
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
    assertStoreReady('getMcpStore');
    const kvStore = store!;
    mcpStore = new McpStore(kvStore.getDatabase(), () => kvStore.save());
  }
  return mcpStore;
};

export const getIMGatewayManager = () => {
  if (!imGatewayManager) {
    assertStoreReady('getIMGatewayManager');
    const kvStore = store!;
    const runner = getCoworkRunner();
    const cwStore = getCoworkStore();

    imGatewayManager = new IMGatewayManager(
      kvStore.getDatabase(),
      () => kvStore.save(),
      {
        coworkRunner: runner,
        coworkStore: cwStore,
      }
    );
  }
  return imGatewayManager;
};

export function wireIMGatewayManager(manager: IMGatewayManager): void {
  assertStoreReady('wireIMGatewayManager');
  const kvStore = store!;

  manager.initialize({
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

  manager.on('statusChange', (status) => {
    broadcastToAllWindows('im:status:change', status);
  });

  manager.on('message', (message) => {
    broadcastToAllWindows('im:message:received', message);
  });

  manager.on('error', ({ platform, error }) => {
    console.error(`[IM Gateway] ${platform} error:`, error);
  });
}

export const getScheduledTaskStore = () => {
  if (!scheduledTaskStore) {
    assertStoreReady('getScheduledTaskStore');
    const kvStore = store!;
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

export type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

export const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
};
