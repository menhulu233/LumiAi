import type { CoworkExecutionMode } from '../store';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { CoworkMemoryGuardLevel } from './coworkMemoryExtractor';
import type { VirtioSerialBridge } from './coworkVmRunner';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

export interface PendingPermission {
  sessionId: string;
  resolve: (result: PermissionResult) => void;
}

export interface SandboxPendingPermission {
  sessionId: string;
  responsePath: string;
}

export interface QueuedTurnMemoryUpdate {
  key: string;
  sessionId: string;
  userText: string;
  assistantText: string;
  implicitEnabled: boolean;
  memoryLlmJudgeEnabled: boolean;
  guardLevel: CoworkMemoryGuardLevel;
  userMessageId?: string;
  assistantMessageId?: string;
  enqueuedAt: number;
}

export type SandboxSkillRootMount = {
  hostRoot: string;
  guestRoot: string;
  mountTag: string;
};

export interface ActiveSession {
  sessionId: string;
  claudeSessionId: string | null;
  workspaceRoot: string;
  confirmationMode: 'modal' | 'text';
  pendingPermission: PermissionRequest | null;
  abortController: AbortController;
  currentStreamingMessageId: string | null;
  currentStreamingContent: string;
  currentStreamingThinkingMessageId: string | null;
  currentStreamingThinking: string;
  currentStreamingBlockType: 'thinking' | 'text' | null;
  currentStreamingTextTruncated: boolean;
  currentStreamingThinkingTruncated: boolean;
  lastStreamingTextUpdateAt: number;
  lastStreamingThinkingUpdateAt: number;
  hasAssistantTextOutput: boolean;
  hasAssistantThinkingOutput: boolean;
  executionMode: CoworkExecutionMode;
  sandboxProcess?: ChildProcessByStdio<null, Readable, Readable>;
  sandboxIpcDir?: string;
  ipcBridge?: VirtioSerialBridge;
  sandboxSkillsGuestPath?: string;
  sandboxSkillMounts?: Record<string, { tag: string; guestPath: string }>;
  sandboxSkillRootMounts?: SandboxSkillRootMount[];
  sandboxTurnResolve?: (result: { status: 'ok' } | { status: 'error'; message: string; hvfDenied: boolean; memoryFailed: boolean }) => void;
  autoApprove?: boolean;
}
