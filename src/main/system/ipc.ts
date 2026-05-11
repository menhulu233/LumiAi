import { ipcMain } from 'electron';
import type { Container } from '../core/container';
import { checkCalendarPermission, requestCalendarPermission } from './service/permissionService';

export function registerSystemIPC(container: Container): void {
  // Store IPC (passthrough to KvStore)
  ipcMain.handle('store:get', (_event, key) => container.store.get(key));
  ipcMain.handle('store:set', (_event, key, value) => container.store.set(key, value));
  ipcMain.handle('store:remove', (_event, key) => container.store.delete(key));

  // Permissions
  ipcMain.handle('permissions:checkCalendar', async () => {
    try {
      const status = await checkCalendarPermission();
      return { success: true, status };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to check permission' };
    }
  });

  ipcMain.handle('permissions:requestCalendar', async () => {
    try {
      const granted = await requestCalendarPermission();
      const status = await checkCalendarPermission();
      return { success: true, granted, status };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to request permission' };
    }
  });
}
