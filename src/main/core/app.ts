import { app, BrowserWindow } from 'electron';
import path from 'path';
import { APP_NAME } from './constants';
import { scheduleReload } from './reload';

export const isDev = process.env.NODE_ENV === 'development';
export const isLinux = process.platform === 'linux';
export const isMac = process.platform === 'darwin';
export const isWindows = process.platform === 'win32';
export const DEV_SERVER_URL = process.env.ELECTRON_START_URL || 'http://localhost:5175';
export const enableVerboseLogging =
  process.env.ELECTRON_ENABLE_LOGGING === '1' ||
  process.env.ELECTRON_ENABLE_LOGGING === 'true';
export const disableGpu =
  process.env.LUMIAI_DISABLE_GPU === '1' ||
  process.env.LUMIAI_DISABLE_GPU === 'true' ||
  process.env.ELECTRON_DISABLE_GPU === '1' ||
  process.env.ELECTRON_DISABLE_GPU === 'true';
export const reloadOnChildProcessGone =
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === '1' ||
  process.env.ELECTRON_RELOAD_ON_CHILD_PROCESS_GONE === 'true';
export const TITLEBAR_HEIGHT = 48;
export const TITLEBAR_COLORS = {
  dark: { color: '#0F1117', symbolColor: '#E4E5E9' },
  light: { color: '#F3F4F6', symbolColor: '#1A1D23' },
} as const;

export const PRELOAD_PATH = app.isPackaged
  ? path.join(__dirname, 'preload.js')
  : path.join(app.getAppPath(), 'dist-electron', 'preload.js');

export function setupAppEventHandlers(): void {
  if (isLinux) {
    app.commandLine.appendSwitch('no-sandbox');
    app.commandLine.appendSwitch('disable-dev-shm-usage');
  }
  if (disableGpu) {
    app.commandLine.appendSwitch('disable-gpu');
    app.commandLine.appendSwitch('disable-software-rasterizer');
    app.disableHardwareAcceleration();
  }
  if (enableVerboseLogging) {
    app.commandLine.appendSwitch('enable-logging');
    app.commandLine.appendSwitch('v', '1');
  }

  app.on('ready', () => {
    app.configureHostResolver({
      enableBuiltInResolver: true,
      secureDnsMode: 'off'
    });
  });

  app.on('render-process-gone', (_event, webContents, details) => {
    console.error('Render process gone:', details);
    const shouldReload =
      details.reason === 'crashed' ||
      details.reason === 'killed' ||
      details.reason === 'oom' ||
      details.reason === 'launch-failed' ||
      details.reason === 'integrity-failure';
    if (shouldReload) {
      scheduleReload(`render-process-gone (${details.reason})`, webContents);
    }
  });

  app.on('child-process-gone', (_event, details) => {
    console.error('Child process gone:', details);
    if (reloadOnChildProcessGone && (details.type === 'GPU' || details.type === 'Utility')) {
      scheduleReload(`child-process-gone (${details.type}/${details.reason})`);
    }
  });

  process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
  });

  process.on('unhandledRejection', (error) => {
    console.error('Unhandled Rejection:', error);
  });

  process.on('exit', (code) => {
    console.log(`[Main] Process exiting with code: ${code}`);
  });

  const gotTheLock = app.requestSingleInstanceLock();

  if (!gotTheLock) {
    app.quit();
  } else {
    app.on('second-instance', (_event, commandLine, workingDirectory) => {
      console.log('[Main] second-instance event', { commandLine, workingDirectory });
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (!mainWindow.isVisible()) mainWindow.show();
        if (!mainWindow.isFocused()) mainWindow.focus();
      }
    });
  }
}
