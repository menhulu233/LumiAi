import { BrowserWindow } from 'electron';

export function broadcastToAllWindows(channel: string, ...args: unknown[]): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) {
      try {
        win.webContents.send(channel, ...args);
      } catch (e) {
        console.error(`[Broadcast] Failed to send ${channel}:`, e);
      }
    }
  }
}
