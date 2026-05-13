// src/main/domains/cowork/service/execution/sandboxLifecycle.ts
// VM lifecycle management: startup, ready waiting, and diagnostics

import path from 'path';
import fs from 'fs';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import { coworkLog } from '../coworkLogger';

export async function waitForVmReady(
  ipcDir: string,
  childProcess: ChildProcessByStdio<null, Readable, Readable>,
  timeout: number = 60000,
  options?: { platform?: string; accelMode?: string }
): Promise<boolean> {
  const heartbeatPath = path.join(ipcDir, 'heartbeat');
  const serialLogPath = path.join(ipcDir, 'serial.log');
  const start = Date.now();

  // Use shorter polling interval for faster response
  const pollInterval = 100; // 100ms instead of 500ms
  let heartbeatSeen = false;

  const maxTimeoutOverride = Number.parseInt(
    process.env.COWORK_SANDBOX_VM_READY_MAX_TIMEOUT_MS ?? '',
    10
  );
  const defaultMaxTimeout =
    options?.platform === 'win32'
      ? Math.max(timeout, options?.accelMode === 'tcg' ? 900000 : 420000)
      : timeout;
  const maxTimeoutMs =
    Number.isFinite(maxTimeoutOverride) && maxTimeoutOverride > timeout
      ? maxTimeoutOverride
      : defaultMaxTimeout;
  const shouldAutoExtend = options?.platform === 'win32' && maxTimeoutMs > timeout;
  const serialActivityWindowMs = 20000;
  const currentTimeoutMs = timeout;
  const timeoutExtensionCount = 0;
  let lastSerialActivityAt = 0;
  let lastSerialSize = -1;
  let lastSerialMtimeMs = -1;

  // Detect early VM exit so we fail fast instead of waiting the full timeout
  let processExited = false;
  let processExitCode: number | null = null;
  childProcess.on('close', (code) => {
    processExited = true;
    processExitCode = code;
  });

  while (true) {
    while (Date.now() - start < currentTimeoutMs) {
      if (processExited) {
        console.error(`Sandbox VM process exited prematurely (exit code: ${processExitCode})`);
        return false;
      }

      if (shouldAutoExtend) {
        try {
          const serialStat = fs.statSync(serialLogPath);
          if (serialStat.size !== lastSerialSize || serialStat.mtimeMs !== lastSerialMtimeMs) {
            lastSerialSize = serialStat.size;
            lastSerialMtimeMs = serialStat.mtimeMs;
            lastSerialActivityAt = Date.now();
          }
        } catch {
          // serial.log might not exist yet
        }
      }

      try {
        if (fs.existsSync(heartbeatPath)) {
          const content = fs.readFileSync(heartbeatPath, 'utf8');
          const data = JSON.parse(content) as { timestamp?: number | string; ipcMounted?: boolean };
          const timestamp = typeof data.timestamp === 'number'
            ? data.timestamp
            : Number.parseInt(String(data.timestamp ?? ''), 10);
          // Heartbeat is valid if fresh and IPC is mounted (or not explicitly false).
          if (Number.isFinite(timestamp) && Date.now() - timestamp < 10000 && data.ipcMounted !== false) {
            const elapsed = Date.now() - start;
            console.log(`VM is ready, heartbeat received after ${elapsed}ms`);
            return true;
          }
          // Log heartbeat validation failure details (once)
          if (!heartbeatSeen) {
            heartbeatSeen = true;
            const clockDelta = Number.isFinite(timestamp) ? Date.now() - timestamp : null;
            coworkLog('INFO', 'waitForVmReady', 'Heartbeat found but not yet valid', {
              timestamp: Number.isFinite(timestamp) ? timestamp : null,
              ipcMounted: data.ipcMounted ?? null,
              clockDelta,
              elapsed: Date.now() - start,
            });
          }
        }
      } catch {
        // Not ready yet
      }
      await new Promise(resolve => setTimeout(resolve, pollInterval));
    }

    console.error('VM failed to become ready within timeout');
    return false;
  }
}
