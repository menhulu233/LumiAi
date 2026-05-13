import { app } from 'electron';
import { destroyTray } from '../system/service/trayService';
import { getSkillServiceManager } from '../domains/skill/service/skillServiceManager';
import { getContainer } from './container';
import { stopCoworkOpenAICompatProxy } from '../domains/cowork/service/coworkOpenAICompatProxy';
import { setIsQuitting } from './window';

let _isCleanupFinished = false;
let _isCleanupInProgress = false;

// Internal state accessors (read-only)
export function getCleanupState(): { finished: boolean; inProgress: boolean } {
  return { finished: _isCleanupFinished, inProgress: _isCleanupInProgress };
}

// Internal state mutators (only for use within cleanup.ts)
function markCleanupStarted(): void {
  _isCleanupInProgress = true;
  _isCleanupFinished = false;
}

function markCleanupFinished(): void {
  _isCleanupInProgress = false;
  _isCleanupFinished = true;
}

function isCleanupRunning(): boolean {
  return _isCleanupInProgress || _isCleanupFinished;
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
  if (isCleanupRunning()) {
    return;
  }
  markCleanupStarted();
  setIsQuitting(true);
  void runAppCleanup()
    .catch((error) => {
      console.error('[Main] Cleanup error:', error);
    })
    .finally(() => {
      markCleanupFinished();
      app.exit(0);
    });
}

export const handleTerminationSignal = (signal: NodeJS.Signals) => {
  if (isCleanupRunning()) {
    return;
  }
  console.log(`[Main] Received ${signal}, running cleanup before exit...`);
  performCleanupAndExit();
};

export function performAppQuit(e?: Electron.Event): void {
  if (isCleanupRunning()) {
    return;
  }
  if (e) {
    e.preventDefault();
  }
  performCleanupAndExit();
}
