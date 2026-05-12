import { app } from 'electron';
import { KvStore } from '../system/store/kvStore';
import { CoworkStore } from '../domains/cowork/store';
import { CoworkRunner } from '../domains/cowork/service/coworkRunner';
import { SkillManager } from '../domains/skill/skillManager';
import { McpStore } from '../domains/mcp/store/mcpStore';
import { IMGatewayManager } from '../domains/im/service/imGatewayManager';
import { ScheduledTaskStore } from '../domains/scheduled-task/store/scheduledTaskStore';
import { Scheduler } from '../domains/scheduled-task/service/scheduler';
import { broadcastToAllWindows } from './broadcaster';
import { setContainer, getContainer, type Container } from './container';
import { coworkMigrations } from '../domains/cowork/store/_migrations';
import { memoryMigrations } from '../domains/cowork/store/_memoryMigrations';
import { scheduledTaskMigrations } from '../domains/scheduled-task/store/_migrations';
import { mcpMigrations } from '../domains/mcp/store/_migrations';

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

export function createContainer(kvStore: KvStore): Container {
  // 1. CoworkStore
  const coworkStore = new CoworkStore(kvStore.getDatabase(), () => kvStore.save());
  const cleaned = coworkStore.autoDeleteNonPersonalMemories();
  if (cleaned > 0) {
    console.info(`[cowork-memory] Auto-deleted ${cleaned} non-personal/procedural memories`);
  }

  // 2. McpStore
  const mcpStore = new McpStore(kvStore.getDatabase(), () => kvStore.save());

  // 3. CoworkRunner
  const coworkRunner = new CoworkRunner(coworkStore);
  coworkRunner.setMcpServerProvider(() => mcpStore.getEnabledServers());

  // 4. SkillManager
  const skillManager = new SkillManager(kvStore);

  // 5. IMGatewayManager
  const imGatewayManager = new IMGatewayManager(
    kvStore.getDatabase(),
    () => kvStore.save(),
    {
      coworkRunner,
      coworkStore,
    }
  );

  // Wire IMGatewayManager callbacks
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
      return skillManager.buildAutoRoutingPrompt();
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

  // 6. ScheduledTaskStore
  const scheduledTaskStore = new ScheduledTaskStore(kvStore.getDatabase(), () => kvStore.save());

  // 7. Scheduler
  const scheduler = new Scheduler({
    scheduledTaskStore,
    coworkStore,
    getCoworkRunner: () => coworkRunner,
    getIMGatewayManager: () => imGatewayManager,
    getSkillsPrompt: async () => skillManager.buildAutoRoutingPrompt(),
  });

  const container: Container = {
    store: kvStore,
    coworkStore,
    coworkRunner,
    skillManager,
    mcpStore,
    imGatewayManager,
    scheduledTaskStore,
    scheduler,
  };

  setContainer(container);
  return container;
}

// --- Legacy getters (backward compatibility) ---

export const getStore = (): KvStore => getContainer().store;
export const getCoworkStore = (): CoworkStore => getContainer().coworkStore;
export const getCoworkRunner = (): CoworkRunner => getContainer().coworkRunner;
export const getSkillManager = (): SkillManager => getContainer().skillManager;
export const getMcpStore = (): McpStore => getContainer().mcpStore;
export const getIMGatewayManager = (): IMGatewayManager => getContainer().imGatewayManager;
export const getScheduledTaskStore = (): ScheduledTaskStore => getContainer().scheduledTaskStore;
export const getScheduler = (): Scheduler => getContainer().scheduler;

// wireIMGatewayManager is now handled inside createContainer.
// Kept as a no-op for any external callers that may still reference it.
export function wireIMGatewayManager(_manager: IMGatewayManager): void {
  // IM gateway wiring is performed during createContainer().
}

export type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

export const getUseSystemProxyFromConfig = (config?: { useSystemProxy?: boolean }): boolean => {
  return config?.useSystemProxy === true;
};
