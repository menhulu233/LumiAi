import { app, BrowserWindow } from 'electron';
import path from 'path';
import fs from 'fs';
import os from 'os';
import {
  initStore,
  getStore,
  getCoworkStore,
  getCoworkRunner,
  getSkillManager,
  getMcpStore,
  getIMGatewayManager,
  wireIMGatewayManager,
  getScheduledTaskStore,
  getScheduler,
  setStoreInstance,
  AppConfigSettings,
  getUseSystemProxyFromConfig,
} from './factories';
import { setStoreGetter } from '../libs/claudeSettings';
import { startCoworkOpenAICompatProxy, setScheduledTaskDeps } from '../libs/coworkOpenAICompatProxy';
import { getSkillServiceManager } from '../domains/skill/service/skillServiceManager';
import { isAutoLaunched, setAutoLaunchEnabled } from '../system/service/autoLaunchService';
import { createTray, updateTrayMenu } from '../system/service/trayService';
import { ensurePythonRuntimeReady } from '../libs/pythonRuntime';
import { applyProxyPreference } from '../system/service/proxyService';
import { setContainer } from './container';
import { registerIPCHandlers } from '../ipc/router';
import { setContentSecurityPolicy } from './csp';
import { createWindow, getMainWindow, updateTitleBarOverlay } from './window';
import { migrateLegacyMemoryFileToUserMemories, migrateFromElectronStore } from './migrations';

export async function bootstrap(): Promise<void> {
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
  const store = await initStore();
  setStoreInstance(store);
  console.log('[Main] initApp: store initialized');

  try {
    migrateLegacyMemoryFileToUserMemories(store.getDatabase(), (key) => store.get(key), (key, value) => store.set(key, value));
    migrateFromElectronStore(store.getDatabase(), app.getPath('userData'), () => store.save());
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

  const containerDeps = {
    store: getStore(),
    coworkStore: getCoworkStore(),
    coworkRunner: getCoworkRunner(),
    skillManager: getSkillManager(),
    mcpStore: getMcpStore(),
    imGatewayManager: getIMGatewayManager(),
    scheduledTaskStore: getScheduledTaskStore(),
    scheduler: getScheduler(),
  };
  setContainer(containerDeps);
  registerIPCHandlers(containerDeps);

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

  wireIMGatewayManager(containerDeps.imGatewayManager);

  containerDeps.imGatewayManager.startAllEnabled().catch((error) => {
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
