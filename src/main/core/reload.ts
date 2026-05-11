import { BrowserWindow, WebContents } from 'electron';

let lastReloadAt = 0;
const MIN_RELOAD_INTERVAL_MS = 5000;

export function scheduleReload(reason: string, webContents?: WebContents): void {
  const target = webContents ?? BrowserWindow.getAllWindows()[0]?.webContents;
  if (!target || target.isDestroyed()) {
    return;
  }
  const now = Date.now();
  if (now - lastReloadAt < MIN_RELOAD_INTERVAL_MS) {
    console.warn(`Skipping reload (${reason}); last reload was ${now - lastReloadAt}ms ago.`);
    return;
  }
  lastReloadAt = now;
  console.warn(`Reloading window due to ${reason}`);
  target.reloadIgnoringCache();
}
