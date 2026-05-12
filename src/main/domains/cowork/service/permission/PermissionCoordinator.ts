import fs from 'fs';
import path from 'path';
import { v4 as uuidv4 } from 'uuid';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { coworkLog } from '../coworkLogger';
import {
  extractToolCommand,
  isDeleteOperation,
  truncateCommandPreview,
  buildSafetyQuestionInput,
  isSafetyApproval,
} from '../coworkRunnerSafety';
import type { PermissionRequest } from '../coworkRunner';

export interface PendingPermission {
  sessionId: string;
  resolve: (result: PermissionResult) => void;
}

export interface SandboxPendingPermission {
  sessionId: string;
  responsePath: string;
}

export interface PermissionCoordinatorEmit {
  (event: 'permissionRequest', sessionId: string, request: PermissionRequest): void;
}

const PERMISSION_RESPONSE_TIMEOUT_MS = 60_000;

export class PermissionCoordinator {
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private sandboxPermissions: Map<string, SandboxPendingPermission> = new Map();

  constructor(
    private emit: PermissionCoordinatorEmit
  ) {}

  waitForPermissionResponse(
    sessionId: string,
    requestId: string,
    signal?: AbortSignal
  ): Promise<PermissionResult> {
    return new Promise(resolve => {
      let settled = false;
      let timeoutId: ReturnType<typeof setTimeout> | null = null;
      const abortHandler = () => finalize({ behavior: 'deny', message: 'Session aborted' });

      const finalize = (result: PermissionResult) => {
        if (settled) return;
        settled = true;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (signal) {
          signal.removeEventListener('abort', abortHandler);
        }
        this.pendingPermissions.delete(requestId);
        resolve(result);
      };

      this.pendingPermissions.set(requestId, {
        sessionId,
        resolve: finalize,
      });

      timeoutId = setTimeout(() => {
        finalize({
          behavior: 'deny',
          message: 'Permission request timed out after 60s',
        });
      }, PERMISSION_RESPONSE_TIMEOUT_MS);

      if (signal) {
        signal.addEventListener('abort', abortHandler, { once: true });
      }
    });
  }

  clearPendingPermissions(sessionId: string): void {
    for (const [requestId, pending] of this.pendingPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: 'Session aborted' });
        this.pendingPermissions.delete(requestId);
      }
    }
  }

  clearSandboxPermissions(sessionId: string): void {
    for (const [requestId, pending] of this.sandboxPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        this.sandboxPermissions.delete(requestId);
      }
    }
  }

  clearSession(sessionId: string): void {
    this.clearPendingPermissions(sessionId);
    this.clearSandboxPermissions(sessionId);
  }

  respondToPermission(
    requestId: string,
    result: PermissionResult,
    activeSessions: Map<string, { pendingPermission: PermissionRequest | null }>
  ): void {
    const sandboxPermission = this.sandboxPermissions.get(requestId);
    if (sandboxPermission) {
      // Write file-based response (used by 9p/file-mode IPC)
      try {
        fs.writeFileSync(sandboxPermission.responsePath, JSON.stringify(result));
      } catch (error) {
        console.error('Failed to write sandbox permission response:', error);
      }
      // Also send via virtio-serial bridge if available (used on Windows)
      const activeSession = activeSessions.get(sandboxPermission.sessionId) as any;
      if (activeSession?.ipcBridge) {
        activeSession.ipcBridge.sendPermissionResponse(requestId, result as unknown as Record<string, unknown>);
      }
      this.sandboxPermissions.delete(requestId);
      if (activeSession) {
        activeSession.pendingPermission = null;
      }
      return;
    }

    const pending = this.pendingPermissions.get(requestId);
    if (!pending) return;

    pending.resolve(result);
    this.pendingPermissions.delete(requestId);

    const activeSession = activeSessions.get(pending.sessionId);
    if (activeSession) {
      activeSession.pendingPermission = null;
    }
  }

  writeSandboxHostToolResponse(
    activeSession: {
      ipcBridge?: { sendHostToolResponse: (requestId: string, payload: Record<string, unknown>) => void } | undefined;
    },
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

  writeSandboxPermissionResponse(
    activeSession: {
      ipcBridge?: { sendPermissionResponse: (requestId: string, result: Record<string, unknown>) => void } | undefined;
    },
    responsesDir: string,
    requestId: string,
    result: PermissionResult
  ): void {
    const responsePath = path.join(responsesDir, `${requestId}.json`);
    try {
      fs.writeFileSync(responsePath, JSON.stringify(result));
    } catch (error) {
      coworkLog('WARN', 'sandbox:permission', 'Failed to write permission response file', {
        requestId,
        responsePath,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    if (activeSession.ipcBridge) {
      activeSession.ipcBridge.sendPermissionResponse(requestId, result as unknown as Record<string, unknown>);
    }
  }

  getSandboxPermission(requestId: string): SandboxPendingPermission | undefined {
    return this.sandboxPermissions.get(requestId);
  }

  setSandboxPermission(requestId: string, value: SandboxPendingPermission): void {
    this.sandboxPermissions.set(requestId, value);
  }

  deleteSandboxPermission(requestId: string): boolean {
    return this.sandboxPermissions.delete(requestId);
  }

  getPendingPermission(requestId: string): PendingPermission | undefined {
    return this.pendingPermissions.get(requestId);
  }

  deletePendingPermission(requestId: string): boolean {
    return this.pendingPermissions.delete(requestId);
  }

  async requestSafetyApproval(
    sessionId: string,
    signal: AbortSignal,
    activeSession: {
      pendingPermission: PermissionRequest | null;
      abortController: AbortController;
    },
    question: string,
    requestedToolName: string,
    requestedToolInput: Record<string, unknown>
  ): Promise<boolean> {
    const request: PermissionRequest = {
      requestId: uuidv4(),
      toolName: 'AskUserQuestion',
      toolInput: buildSafetyQuestionInput(question, requestedToolName, requestedToolInput),
    };

    activeSession.pendingPermission = request;
    this.emit('permissionRequest', sessionId, request);

    const result = await this.waitForPermissionResponse(sessionId, request.requestId, signal);
    if (activeSession.abortController.signal.aborted || signal.aborted) {
      return false;
    }
    return isSafetyApproval(result, question);
  }

  async enforceToolSafetyPolicy(
    sessionId: string,
    signal: AbortSignal,
    activeSession: {
      pendingPermission: PermissionRequest | null;
      abortController: AbortController;
    },
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<PermissionResult | null> {
    if (isDeleteOperation(toolName, toolInput)) {
      const commandPreview = toolName === 'Bash'
        ? truncateCommandPreview(extractToolCommand(toolInput))
        : '';
      const deleteDetail = commandPreview ? ` 命令: ${commandPreview}` : '';
      const deleteQuestion = `工具 "${toolName}" 将执行删除操作。根据安全策略，删除必须人工确认。是否允许本次操作？${deleteDetail}`;
      const approved = await this.requestSafetyApproval(
        sessionId,
        signal,
        activeSession,
        deleteQuestion,
        toolName,
        toolInput
      );
      if (!approved) {
        return { behavior: 'deny', message: 'Delete operation denied by user.' };
      }
    }

    return null;
  }
}
