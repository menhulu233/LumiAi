import { app } from 'electron';
import { destroyTray } from '../system/service/trayService';
import { getSkillServiceManager } from '../domains/skill/service/skillServiceManager';
import {
  getCoworkRunner,
  getIMGatewayManager,
  getScheduler,
  getSkillManager,
} from './factories';
import { stopCoworkOpenAICompatProxy } from '../libs/coworkOpenAICompatProxy';
import { setIsQuitting } from './window';

let isCleanupFinished = false;
let isCleanupInProgress = false;

export function getCleanupState(): { finished: boolean; inProgress: boolean } {
  return { finished: isCleanupFinished, inProgress: isCleanupInProgress };
}

export const runAppCleanup = async (): Promise<void> => {
  console.log('[Main] App is quitting, starting cleanup...');
  destroyTray();
  const manager = getSkillManager();
  manager?.stopWatching();

  const runner = getCoworkRunner();
  if (runner) {
    console.log('[Main] Stopping cowork sessions...');
    runner.stopAllSessions();
  }

  await stopCoworkOpenAICompatProxy().catch((error) => {
    console.error('Failed to stop OpenAI compatibility proxy:', error);
  });

  const skillServices = getSkillServiceManager();
  await skillServices.stopAll();

  const imManager = getIMGatewayManager();
  if (imManager) {
    await imManager.stopAll().catch(err => {
      console.error('[IM Gateway] Error stopping gateways on quit:', err);
    });
  }

  const sched = getScheduler();
  if (sched) {
    sched.stop();
  }
};

function performCleanupAndExit(): void {
  if (isCleanupFinished || isCleanupInProgress) {
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
}

export const handleTerminationSignal = (signal: NodeJS.Signals) => {
  if (isCleanupFinished || isCleanupInProgress) {
    return;
  }
  console.log(`[Main] Received ${signal}, running cleanup before exit...`);
  performCleanupAndExit();
};

export function performAppQuit(e?: Electron.Event): void {
  if (isCleanupFinished) {
    return;
  }
  if (e) {
    e.preventDefault();
  }
  performCleanupAndExit();
}
