import { session } from 'electron';
import {
  applySystemProxyEnv,
  resolveSystemProxyUrl,
  restoreOriginalProxyEnv,
  setSystemProxyEnabled,
} from './systemProxy';

export async function applyProxyPreference(useSystemProxy: boolean): Promise<void> {
  try {
    await session.defaultSession.setProxy({ mode: useSystemProxy ? 'system' : 'direct' });
  } catch (error) {
    console.error('[Main] Failed to apply session proxy mode:', error);
  }

  setSystemProxyEnabled(useSystemProxy);

  if (!useSystemProxy) {
    restoreOriginalProxyEnv();
    console.log('[Main] System proxy disabled (direct mode).');
    return;
  }

  const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
  applySystemProxyEnv(proxyUrl);

  if (proxyUrl) {
    console.log('[Main] System proxy enabled for process env:', proxyUrl);
  } else {
    console.warn('[Main] System proxy mode enabled, but no proxy endpoint was resolved (DIRECT).');
  }
}
