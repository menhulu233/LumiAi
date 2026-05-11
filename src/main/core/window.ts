import { BrowserWindow, ipcMain, Menu, nativeImage, nativeTheme, app } from 'electron';
import path from 'path';
import fs from 'fs';
import { APP_NAME } from '../appConstants';
import { isDev, isMac, isWindows, DEV_SERVER_URL, PRELOAD_PATH, TITLEBAR_HEIGHT, TITLEBAR_COLORS } from './app';
import { scheduleReload } from './reload';

export let mainWindow: BrowserWindow | null = null;
export let isQuitting = false;

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}

export function setIsQuitting(value: boolean): void {
  isQuitting = value;
}

type AppConfigSettings = {
  theme?: string;
  language?: string;
  useSystemProxy?: boolean;
};

const resolveThemeFromConfig = (config?: AppConfigSettings): 'light' | 'dark' => {
  if (config?.theme === 'dark') {
    return 'dark';
  }
  if (config?.theme === 'light') {
    return 'light';
  }
  return nativeTheme.shouldUseDarkColors ? 'dark' : 'light';
};

export const getInitialTheme = (config?: AppConfigSettings): 'light' | 'dark' => {
  return resolveThemeFromConfig(config);
};

export const getTitleBarOverlayOptions = (config?: AppConfigSettings) => {
  const theme = resolveThemeFromConfig(config);
  return {
    color: TITLEBAR_COLORS[theme].color,
    symbolColor: TITLEBAR_COLORS[theme].symbolColor,
    height: TITLEBAR_HEIGHT,
  };
};

export const updateTitleBarOverlay = (config?: AppConfigSettings) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (!isMac && !isWindows) {
    mainWindow.setTitleBarOverlay(getTitleBarOverlayOptions(config));
  }
  const theme = resolveThemeFromConfig(config);
  mainWindow.setBackgroundColor(theme === 'dark' ? '#0F1117' : '#F8F9FB');
};

export const emitWindowState = () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.webContents.isDestroyed()) return;
  mainWindow.webContents.send('window:state-changed', {
    isMaximized: mainWindow.isMaximized(),
    isFullscreen: mainWindow.isFullScreen(),
    isFocused: mainWindow.isFocused(),
  });
};

export const showSystemMenu = (position?: { x?: number; y?: number }) => {
  if (!isWindows) return;
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const isMaximized = mainWindow.isMaximized();
  const menu = Menu.buildFromTemplate([
    { label: 'Restore', enabled: isMaximized, click: () => mainWindow?.restore() },
    { role: 'minimize' },
    { label: 'Maximize', enabled: !isMaximized, click: () => mainWindow?.maximize() },
    { type: 'separator' },
    { role: 'close' },
  ]);

  menu.popup({
    window: mainWindow,
    x: Math.max(0, Math.round(position?.x ?? 0)),
    y: Math.max(0, Math.round(position?.y ?? 0)),
  });
};

const getAppIconPath = (): string | undefined => {
  if (process.platform !== 'win32' && process.platform !== 'linux') return undefined;
  const basePath = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(__dirname, '..', 'resources', 'tray');
  return process.platform === 'win32'
    ? path.join(basePath, 'tray-icon.ico')
    : path.join(basePath, 'tray-icon.png');
};

export function createWindow(
  getConfig: () => AppConfigSettings | undefined,
  onReadyToShow: () => void
): BrowserWindow {
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    if (!mainWindow.isVisible()) mainWindow.show();
    if (!mainWindow.isFocused()) mainWindow.focus();
    return mainWindow;
  }

  const config = getConfig();

  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    title: APP_NAME,
    icon: getAppIconPath(),
    ...(isMac
      ? {
          titleBarStyle: 'hiddenInset' as const,
          trafficLightPosition: { x: 12, y: 20 },
        }
      : isWindows
        ? {
            frame: false,
            titleBarStyle: 'hidden' as const,
          }
        : {
          titleBarStyle: 'hidden' as const,
          titleBarOverlay: getTitleBarOverlayOptions(config),
        }),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      preload: PRELOAD_PATH,
      backgroundThrottling: false,
      devTools: isDev,
      spellcheck: false,
      enableWebSQL: false,
      autoplayPolicy: 'document-user-activation-required',
      disableDialogs: true,
      navigateOnDragDrop: false
    },
    backgroundColor: getInitialTheme(config) === 'dark' ? '#0F1117' : '#F8F9FB',
    show: false,
    autoHideMenuBar: true,
    enableLargerThanScreen: false
  });

  if (isMac && isDev) {
    const iconPath = path.join(__dirname, '../build/icons/png/512x512.png');
    if (fs.existsSync(iconPath)) {
      app.dock.setIcon(nativeImage.createFromPath(iconPath));
    }
  }

  mainWindow.setMenu(null);
  mainWindow.setMinimumSize(800, 600);

  const loadTimeout = setTimeout(() => {
    if (mainWindow && mainWindow.webContents.isLoadingMainFrame()) {
      console.log('Window load timed out, attempting to reload...');
      scheduleReload('load-timeout');
    }
  }, 30000);

  mainWindow.webContents.once('did-finish-load', () => {
    clearTimeout(loadTimeout);
  });
  mainWindow.webContents.on('did-finish-load', () => {
    emitWindowState();
  });

  mainWindow.on('close', (e) => {
    if (mainWindow && !isQuitting && !isDev) {
      e.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    console.error('Window render process gone:', details);
    scheduleReload('webContents-crashed');
  });

  if (isDev) {
    const maxRetries = 3;
    let retryCount = 0;

    const tryLoadURL = () => {
      mainWindow?.loadURL(DEV_SERVER_URL).catch((err) => {
        console.error('Failed to load URL:', err);
        retryCount++;
        if (retryCount < maxRetries) {
          console.log(`Retrying to load URL (${retryCount}/${maxRetries})...`);
          setTimeout(tryLoadURL, 3000);
        } else {
          console.error('Failed to load URL after maximum retries');
          if (mainWindow && !mainWindow.isDestroyed()) {
            mainWindow.loadFile(path.join(__dirname, '../resources/error.html'));
          }
        }
      });
    };

    tryLoadURL();
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));
  }

  mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription) => {
    console.error('Page failed to load:', errorCode, errorDescription);
    if (isDev) {
      setTimeout(() => {
        scheduleReload('did-fail-load');
      }, 3000);
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  const forwardWindowState = () => emitWindowState();
  mainWindow.on('maximize', forwardWindowState);
  mainWindow.on('unmaximize', forwardWindowState);
  mainWindow.on('enter-full-screen', forwardWindowState);
  mainWindow.on('leave-full-screen', forwardWindowState);
  mainWindow.on('focus', forwardWindowState);
  mainWindow.on('blur', forwardWindowState);

  mainWindow.once('ready-to-show', () => {
    emitWindowState();
    onReadyToShow();
  });

  return mainWindow;
}

export function registerWindowIPC(): void {
  ipcMain.on('window-minimize', () => {
    mainWindow?.minimize();
  });

  ipcMain.on('window-maximize', () => {
    if (mainWindow?.isMaximized()) {
      mainWindow.unmaximize();
    } else {
      mainWindow?.maximize();
    }
  });

  ipcMain.on('window-close', () => {
    mainWindow?.close();
  });

  ipcMain.handle('window:isMaximized', () => {
    return mainWindow?.isMaximized() ?? false;
  });

  ipcMain.on('window:showSystemMenu', (_event, position: { x?: number; y?: number } | undefined) => {
    showSystemMenu(position);
  });
}
