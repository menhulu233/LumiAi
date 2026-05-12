import { app } from 'electron';
import { broadcastToAllWindows } from './broadcaster';
import { onSandboxProgress } from '../domains/cowork/service/coworkSandboxRuntime';
import { handleTerminationSignal, performAppQuit } from './cleanup';
import { bootstrap } from './bootstrap';

export function initApp(): Promise<void> {
  onSandboxProgress((progress) => {
    broadcastToAllWindows('cowork:sandbox:downloadProgress', progress);
  });

  app.on('before-quit', (e) => {
    performAppQuit(e);
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
