// src/main/domains/cowork/service/execution/sandboxStream.ts
// Stream reading and host tool response writing for sandbox execution

import path from 'path';
import fs from 'fs';
import { StringDecoder } from 'string_decoder';
import type { ActiveSession } from '../CoworkRunnerTypes';
import { coworkLog } from '../coworkLogger';

export async function readSandboxStream(
  streamPath: string,
  onLine: (line: string) => void,
  signal: AbortSignal
): Promise<void> {
  const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
  let fileHandle: fs.promises.FileHandle | null = null;
  let position = 0;
  let buffer = '';
  const decoder = new StringDecoder('utf8');

  try {
    while (!signal.aborted) {
      if (!fileHandle) {
        if (!fs.existsSync(streamPath)) {
          await sleep(50); // Reduced from 200ms
          continue;
        }
        fileHandle = await fs.promises.open(streamPath, 'r');
        position = 0;
        buffer = '';
      }

      const stat = await fileHandle.stat();
      if (stat.size > position) {
        const length = stat.size - position;
        const chunk = Buffer.alloc(length);
        const result = await fileHandle.read(chunk, 0, length, position);
        position += result.bytesRead;
        buffer += decoder.write(chunk.subarray(0, result.bytesRead));

        let newlineIndex = buffer.indexOf('\n');
        while (newlineIndex !== -1) {
          const line = buffer.slice(0, newlineIndex);
          buffer = buffer.slice(newlineIndex + 1);
          if (line.trim()) {
            onLine(line);
          }
          newlineIndex = buffer.indexOf('\n');
        }
      } else {
        await sleep(50); // Reduced from 200ms
      }
    }
  } finally {
    if (fileHandle) {
      await fileHandle.close();
    }
    buffer += decoder.end();
    if (buffer.trim()) {
      onLine(buffer);
    }
  }
}

export function writeSandboxHostToolResponse(
  activeSession: ActiveSession,
  responsesDir: string,
  requestId: string,
  payload: Record<string, unknown>
): void {
  const responsePath = path.join(responsesDir, `${requestId}.host-tool.json`);
  try {
    fs.writeFileSync(responsePath, JSON.stringify(payload));
  } catch (error) {
    coworkLog('WARN', 'sandbox:hostTool', 'Failed to write host tool response file', {
      requestId,
      responsePath,
      error: error instanceof Error ? error.message : String(error),
    });
  }
  if (activeSession.ipcBridge) {
    activeSession.ipcBridge.sendHostToolResponse(requestId, payload);
  }
}
