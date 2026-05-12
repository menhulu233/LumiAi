import { app } from 'electron';
import { destroyTray } from '../system/service/trayService';
import { getSkillServiceManager } from '../domains/skill/service/skillServiceManager';
import { getContainer } from './container';
import { stopCoworkOpenAICompatProxy } from '../domains/cowork/service/coworkOpenAICompatProxy';
import { setIsQuitting } from './window';

let isCleanupFinished = false;
let isCleanupInProgress = false;

export function getCleanupState(): { finished: boolean; inProgress: boolean } {
  return { finished: isCleanupFinished, inProgress: isCleanupInProgress };
}

export const runAppCleanup = async (): Promise<void> => {
  console.log('[Main] App is quitting, starting cleanup...');
  destroyTray();

  const container = getContainer();

  container.skillManager?.stopWatching();

  if (container.coworkRunner) {
    console.log('[Main] Stopping cowork sessions...');
    container.coworkRunner.stopAllSessions();
  }

  await stopCoworkOpenAICompatProxy().catch((error) => {
    console.error('Failed to stop OpenAI compatibility proxy:', error);
  });

  const skillServices = getSkillServiceManager();
  await skillServices.stopAll();

  if (container.imGatewayManager) {
    await container.imGatewayManager.stopAll().catch(err => {
      console.error('[IM Gateway] Error stopping gateways on quit:', err);
    });
  }

  if (container.scheduler) {
    container.scheduler.stop();
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
