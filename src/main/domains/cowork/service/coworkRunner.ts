import { EventEmitter } from 'events';
import { type ChildProcessByStdio, spawn, spawnSync } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { StringDecoder } from 'string_decoder';
import { v4 as uuidv4 } from 'uuid';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { CoworkStore, CoworkMessage, CoworkExecutionMode } from '../store';
import { getClaudeCodePath, getCurrentApiConfig } from './claudeSettings';
import { loadClaudeSdk } from './claudeSdk';
import { getElectronNodeRuntimePath, getEnhancedEnv, getEnhancedEnvWithTmpdir, getSkillsRoot } from './coworkUtil';
import { coworkLog, getCoworkLogPath } from './coworkLogger';
import { ensurePythonPipReady, ensurePythonRuntimeReady } from '../../skill/service/pythonRuntime';
import { cpRecursiveSync } from '../../../utils/fsCompat';
import { isQuestionLikeMemoryText, type CoworkMemoryGuardLevel } from './coworkMemoryExtractor';
import { z } from 'zod';
import { ensureSandboxReady, getSandboxRuntimeInfoIfReady, type SandboxRuntimeInfo } from './coworkSandboxRuntime';
import {
  buildSandboxRequest,
  collectSkillFilesForSandbox,
  ensureCoworkSandboxDirs,
  findFreePort,
  resolveSandboxCwd,
  spawnCoworkSandboxVm,
  type SandboxCwdMapping,
  type SandboxExtraMount,
  VirtioSerialBridge,
} from './coworkVmRunner';
import {
  handleClaudeEvent,
  handleStreamEvent,
  finalizeStreamingContent,
  persistFinalResult,
} from './coworkRunnerStream';
import { PermissionManager } from './coworkRunnerPermission';
import { WorkspaceService } from './workspace/WorkspaceService';
import { PromptBuilderService } from './prompt/PromptBuilderService';
import {
  injectSandboxHistoryPrompt,
  injectLocalHistoryPrompt,
  rewriteSkillPathsForSandbox,
  rewriteSkillLocationForSandbox,
  rewriteSkillReferencesForSandbox,
  buildSandboxSkillRootMappings,
  mapHostSkillPathToSandboxPath,
  buildLocalTimeContextPrompt,
  buildWindowsEncodingPrompt,
  buildWindowsBundledRuntimePrompt,
  buildWorkspaceSafetyPrompt,
  composeEffectiveSystemPrompt,
  buildPromptPrefix,
} from './coworkRunnerPrompt';
import {
  ensureWindowsChildProcessHideInitScript,
  prependNodeRequireArg,
  escapeRegExp,
  isPathWithin,
  detectBinaryMagic,
  summarizeRuntimeBinary,
  persistSandboxSpawnDiagnostics,
  formatSandboxSpawnError,
  summarizeEndpointForLog,
  extractHostFromUrl,
  mergeNoProxyList,
  escapeXml,
} from './coworkRunnerHelpers';
import { ToolExecutionService } from './tools/ToolExecutionService';
import { SandboxExecutionService } from './execution/SandboxExecutionService';
import { LocalExecutionService } from './execution/LocalExecutionService';
import { CoworkSessionService } from './CoworkSessionService';

export * from './CoworkRunnerTypes';

const SANDBOX_ALLOWED_ENV_KEYS = [
  'ANTHROPIC_AUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_BASE_URL',
  'LUMIAI_API_BASE_URL',
  'ANTHROPIC_MODEL',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'NO_PROXY',
  'http_proxy',
  'https_proxy',
  'no_proxy',
  'TZ',
  'tz',
] as const;

const SANDBOX_SKILLS_MOUNT_TAG = 'skills';
// On macOS/Linux, keep sandbox skills outside the project workspace mount to
// avoid creating skills directories in the user's selected host folder.
// On Windows, keep historical path for compatibility with serial-mode flows.
const SANDBOX_SKILLS_GUEST_PATH = '/workspace/skills';
const SANDBOX_SKILLS_GUEST_PATH_WINDOWS = '/workspace/project/skills';
const SANDBOX_WORKSPACE_GUEST_ROOT = '/workspace/project';
const SANDBOX_WORKSPACE_LEGACY_ROOT = '/workspace';
const ATTACHMENT_LINE_RE = /^\s*(?:[-*]\s*)?(输入文件|input\s*file)\s*[:：]\s*(.+?)\s*$/i;
const INFERRED_FILE_REFERENCE_RE = /([^\s"'`，。！？：:；;（）()\[\]{}<>《》【】]+?\.[A-Za-z][A-Za-z0-9]{0,7})/g;
const SANDBOX_ATTACHMENT_DIR = path.join('.cowork-temp', 'attachments');
const LEGACY_SKILLS_ROOT_HINTS = [
  '/home/ubuntu/skills',
  '/mnt/skills',
  '/tmp/workspace/skills',
  '/workspace/skills',
  '/workspace/skills',
];
const INFERRED_FILE_SEARCH_IGNORE = new Set(['.git', 'node_modules', '.cowork-temp', '.idea', '.vscode']);
const SANDBOX_HISTORY_MAX_MESSAGES = 18;
const SANDBOX_HISTORY_MAX_TOTAL_CHARS = 24000;
const SANDBOX_HISTORY_MAX_MESSAGE_CHARS = 3000;
const LOCAL_HISTORY_MAX_MESSAGES = 24;
const LOCAL_HISTORY_MAX_TOTAL_CHARS = 32000;
const LOCAL_HISTORY_MAX_MESSAGE_CHARS = 4000;
const CONTENT_TRUNCATED_HINT = '\n...[truncated to prevent memory pressure]';
const TOOL_INPUT_PREVIEW_MAX_CHARS = 4000;
const TOOL_INPUT_PREVIEW_MAX_DEPTH = 5;
const TOOL_INPUT_PREVIEW_MAX_KEYS = 60;
const TOOL_INPUT_PREVIEW_MAX_ITEMS = 30;
const SKILLS_MARKER = '/skills/';
const PERMISSION_RESPONSE_TIMEOUT_MS = 60_000;
const SAFETY_APPROVAL_ALLOW_OPTION = '允许本次操作';
const SAFETY_APPROVAL_DENY_OPTION = '拒绝本次操作';
function findSkillsMarkerIndex(value: string): number {
  return value.toLowerCase().lastIndexOf(SKILLS_MARKER);
}

function resolveSkillPathFromRoots(
  rawPath: string,
  hostSkillsRoots: string[]
): string | null {
  if (!rawPath) return null;

  const trimmed = rawPath.trim();
  if (!trimmed) return null;

  if (fs.existsSync(trimmed)) {
    return trimmed;
  }

  const normalized = trimmed.replace(/\\/g, '/');
  const markerIndex = findSkillsMarkerIndex(normalized);
  if (markerIndex >= 0) {
    const relative = normalized.slice(markerIndex + SKILLS_MARKER.length).replace(/^\/+/, '');
    if (relative) {
      const relativeParts = relative.split('/').filter(Boolean);
      for (const root of hostSkillsRoots) {
        if (!root) continue;
        const candidate = path.join(root, ...relativeParts);
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }
  }

  const skillId = path.basename(path.dirname(trimmed));
  if (skillId) {
    for (const root of hostSkillsRoots) {
      if (!root) continue;
      const candidate = path.join(root, skillId, 'SKILL.md');
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

// Event types emitted by the runner
export interface CoworkRunnerEvents {
  message: (sessionId: string, message: CoworkMessage) => void;
  messageUpdate: (sessionId: string, messageId: string, content: string) => void;
  permissionRequest: (sessionId: string, request: PermissionRequest) => void;
  complete: (sessionId: string, claudeSessionId: string | null) => void;
  error: (sessionId: string, error: string) => void;
}

export interface PermissionRequest {
  requestId: string;
  toolName: string;
  toolInput: Record<string, unknown>;
}

interface ActiveSession {
  sessionId: string;
  claudeSessionId: string | null;
  workspaceRoot: string;
  confirmationMode: 'modal' | 'text';
  pendingPermission: PermissionRequest | null;
  abortController: AbortController;
  // Track the current streaming message for incremental updates
  currentStreamingMessageId: string | null;
  currentStreamingContent: string;
  // Track thinking block streaming
  currentStreamingThinkingMessageId: string | null;
  currentStreamingThinking: string;
  // Track which block type is currently streaming (to distinguish on content_block_stop)
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
  /** Resolve callback for the current sandbox turn; called by the result event handler. */
  sandboxTurnResolve?: (result: { status: 'ok' } | { status: 'error'; message: string; hvfDenied: boolean; memoryFailed: boolean }) => void;
  /** When true, auto-approve all tool permissions (for scheduled tasks) */
  autoApprove?: boolean;
}

interface PendingPermission {
  sessionId: string;
  resolve: (result: PermissionResult) => void;
}

interface SandboxPendingPermission {
  sessionId: string;
  responsePath: string;
}

interface QueuedTurnMemoryUpdate {
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

type AttachmentEntry = {
  lineIndex: number;
  label: string;
  rawPath: string;
};

type SandboxSkillRewriteOptions = {
  guestSkillsRoot?: string | null;
  hostSkillsRoots?: string[];
  hostSkillsRootMounts?: SandboxSkillRootMount[];
};

type SandboxSkillEntry = {
  skillId: string;
  hostPath: string;
  guestPath: string;
  mountTag: string;
};

type SandboxSkillRootMount = {
  hostRoot: string;
  guestRoot: string;
  mountTag: string;
};

export class CoworkRunner extends EventEmitter {
  private store: CoworkStore;
  private permissionManager: PermissionManager;
  private activeSessions: Map<string, ActiveSession> = new Map();
  private pendingPermissions: Map<string, PendingPermission> = new Map();
  private sandboxPermissions: Map<string, SandboxPendingPermission> = new Map();
  private stoppedSessions: Set<string> = new Set();
  private turnMemoryQueue: QueuedTurnMemoryUpdate[] = [];
  private turnMemoryQueueKeys: Set<string> = new Set();
  private lastTurnMemoryKeyBySession: Map<string, string> = new Map();
  private drainingTurnMemoryQueue = false;
  private mcpServerProvider?: () => Array<{
    name: string;
    transportType: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
  private toolExecution: ToolExecutionService;
  private workspace: WorkspaceService;
  private sandboxExecution: SandboxExecutionService;
  private localExecution: LocalExecutionService;
  private sessionService: CoworkSessionService;
  private promptBuilder: PromptBuilderService;

  constructor(store: CoworkStore) {
    super();
    this.store = store;
    this.permissionManager = new PermissionManager((event, sessionId, request) => {
      this.emit(event, sessionId, request);
    });
    this.toolExecution = new ToolExecutionService(this.store);
    this.workspace = new WorkspaceService(this.store);
    this.sessionService = new CoworkSessionService(this.store);
    this.promptBuilder = new PromptBuilderService(this.store);
    this.sandboxExecution = new SandboxExecutionService({
      store: this.store,
      emit: this.emit.bind(this),
      permissionManager: this.permissionManager,
      handleError: this.handleError.bind(this),
      isSessionStopRequested: this.isSessionStopRequested.bind(this),
      applyTurnMemoryUpdatesForSession: this.applyTurnMemoryUpdatesForSession.bind(this),
      hostToolExecutor: this.toolExecution.hostToolExecutor.bind(this.toolExecution),
      sanitizeToolPayload: this.sanitizeToolPayload.bind(this),
      clearSandboxPermissions: this.clearSandboxPermissions.bind(this),
      clearPendingPermissions: this.clearPendingPermissions.bind(this),
      addSystemMessage: this.addSystemMessage.bind(this),
      permissionManagerGetConfig: () => this.store.getConfig(),
    });
    this.localExecution = new LocalExecutionService({
      store: this.store,
      emit: this.emit.bind(this),
      permissionManager: this.permissionManager,
      handleError: this.handleError.bind(this),
      isSessionStopRequested: this.isSessionStopRequested.bind(this),
      applyTurnMemoryUpdatesForSession: this.applyTurnMemoryUpdatesForSession.bind(this),
      sanitizeToolPayload: this.sanitizeToolPayload.bind(this),
      enforceToolSafetyPolicy: this.enforceToolSafetyPolicy.bind(this),
      extractToolCommand: this.extractToolCommand.bind(this),
      ensureWindowsPythonRuntimeForCommand: this.ensureWindowsPythonRuntimeForCommand.bind(this),
      addSystemMessage: this.addSystemMessage.bind(this),
      waitForPermissionResponse: this.waitForPermissionResponse.bind(this),
      clearPendingPermissions: this.clearPendingPermissions.bind(this),
      runConversationSearchTool: this.toolExecution.runConversationSearchTool.bind(this.toolExecution),
      runRecentChatsTool: this.toolExecution.runRecentChatsTool.bind(this.toolExecution),
      runMemoryUserEditsTool: this.toolExecution.runMemoryUserEditsTool.bind(this.toolExecution),
      formatMemoryUserEditsResult: this.toolExecution.formatMemoryUserEditsResult.bind(this.toolExecution),
      truncateCommandPreview: this.toolExecution.truncateCommandPreview.bind(this.toolExecution),
      isDeleteOperation: this.toolExecution.isDeleteOperation.bind(this.toolExecution),
      requestSafetyApproval: this.requestSafetyApproval.bind(this),
      stoppedSessions: this.stoppedSessions,
      activeSessions: this.activeSessions,
      mcpServerProvider: this.mcpServerProvider,
    });
  }

  setMcpServerProvider(provider: () => Array<{
    name: string;
    transportType: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>): void {
    this.mcpServerProvider = provider;
  }

  private isSessionStopRequested(sessionId: string, activeSession?: ActiveSession): boolean {
    return this.stoppedSessions.has(sessionId) || Boolean(activeSession?.abortController.signal.aborted);
  }

  private applyTurnMemoryUpdatesForSession(sessionId: string): void {
    const config = this.store.getConfig();
    if (!config.memoryEnabled) {
      return;
    }

    const session = this.store.getSession(sessionId);
    if (!session || session.messages.length === 0) {
      return;
    }

    const lastUser = [...session.messages].reverse().find((message) => message.type === 'user' && message.content?.trim());
    const lastAssistant = [...session.messages].reverse().find((message) => {
      if (message.type !== 'assistant') return false;
      if (!message.content?.trim()) return false;
      if (message.metadata?.isThinking) return false;
      return true;
    });

    if (!lastUser || !lastAssistant) {
      return;
    }

    const key = `${sessionId}:${lastUser.id}:${lastAssistant.id}`;
    if (this.lastTurnMemoryKeyBySession.get(sessionId) === key || this.turnMemoryQueueKeys.has(key)) {
      return;
    }
    this.turnMemoryQueueKeys.add(key);
    this.turnMemoryQueue.push({
      key,
      sessionId,
      userText: lastUser.content,
      assistantText: lastAssistant.content,
      implicitEnabled: config.memoryImplicitUpdateEnabled,
      memoryLlmJudgeEnabled: config.memoryLlmJudgeEnabled,
      guardLevel: config.memoryGuardLevel,
      userMessageId: lastUser.id,
      assistantMessageId: lastAssistant.id,
      enqueuedAt: Date.now(),
    });
    void this.drainTurnMemoryQueue();
  }

  private getSandboxUnavailableFallbackNotice(errorMessage: string): string {
    return this.sandboxExecution.getSandboxUnavailableFallbackNotice(errorMessage);
  }

  private async drainTurnMemoryQueue(): Promise<void> {
    if (this.drainingTurnMemoryQueue) {
      return;
    }
    this.drainingTurnMemoryQueue = true;
    try {
      while (this.turnMemoryQueue.length > 0) {
        const job = this.turnMemoryQueue.shift();
        if (!job) continue;
        try {
          const result = await this.store.applyTurnMemoryUpdates({
            sessionId: job.sessionId,
            userText: job.userText,
            assistantText: job.assistantText,
            implicitEnabled: job.implicitEnabled,
            memoryLlmJudgeEnabled: job.memoryLlmJudgeEnabled,
            guardLevel: job.guardLevel,
            userMessageId: job.userMessageId,
            assistantMessageId: job.assistantMessageId,
          });
          coworkLog('INFO', 'memory:turnUpdateAsync', 'Applied turn memory updates asynchronously', {
            sessionId: job.sessionId,
            queueSize: this.turnMemoryQueue.length,
            latencyMs: Math.max(0, Date.now() - job.enqueuedAt),
            ...result,
          });
        } catch (error) {
          coworkLog('WARN', 'memory:turnUpdateAsync', 'Failed to apply turn memory updates asynchronously', {
            sessionId: job.sessionId,
            queueSize: this.turnMemoryQueue.length,
            error: error instanceof Error ? error.message : String(error),
          });
        } finally {
          this.lastTurnMemoryKeyBySession.set(job.sessionId, job.key);
          this.turnMemoryQueueKeys.delete(job.key);
        }
      }
    } finally {
      this.drainingTurnMemoryQueue = false;
      if (this.turnMemoryQueue.length > 0) {
        void this.drainTurnMemoryQueue();
      }
    }
  }

  private buildUserMemoriesXml(): string {
    const config = this.store.getConfig();
    if (!config.memoryEnabled) {
      return '<userMemories></userMemories>';
    }

    const memories = this.store.listUserMemories({
      status: 'created',
      includeDeleted: false,
      limit: config.memoryUserMemoriesMaxItems,
      offset: 0,
    });

    if (memories.length === 0) {
      return '<userMemories></userMemories>';
    }

    const MAX_ITEM_CHARS = 200;
    const MAX_TOTAL_CHARS = 2000;
    let totalChars = 0;
    const lines: string[] = [];
    for (const memory of memories) {
      const text = memory.text.length > MAX_ITEM_CHARS
        ? memory.text.slice(0, MAX_ITEM_CHARS) + '...'
        : memory.text;
      const line = `- ${escapeXml(text)}`;
      if (totalChars + line.length > MAX_TOTAL_CHARS) break;
      lines.push(line);
      totalChars += line.length;
    }
    return `<userMemories>\n${lines.join('\n')}\n</userMemories>`;
  }

  private isDirectory(target: string): boolean {
    try {
      return fs.statSync(target).isDirectory();
    } catch {
      return false;
    }
  }

  private extractHostSkillRootsFromPrompt(systemPrompt: string): string[] {
    if (!systemPrompt || !systemPrompt.includes('<location>')) {
      return [];
    }

    const roots = new Set<string>();
    const locationRe = /<location>(.*?)<\/location>/g;
    let match: RegExpExecArray | null;
    while ((match = locationRe.exec(systemPrompt)) !== null) {
      const rawLocation = match[1]?.trim();
      if (!rawLocation || !path.isAbsolute(rawLocation)) {
        continue;
      }

      const normalized = path.resolve(rawLocation);
      const normalizedPosix = normalized.replace(/\\/g, '/');
      const markerIndex = findSkillsMarkerIndex(normalizedPosix);
      const rootFromMarker = markerIndex < 0
        ? null
        : normalizedPosix.slice(0, markerIndex + SKILLS_MARKER.length - 1);

      if (rootFromMarker) {
        roots.add(path.resolve(rootFromMarker));
        continue;
      }

      roots.add(path.resolve(path.dirname(path.dirname(normalized))));
    }

    return Array.from(roots);
  }

  private collectHostSkillsRoots(
    env: Record<string, string | undefined>,
    cwdMapping: SandboxCwdMapping,
    systemPrompt: string
  ): string[] {
    const candidates: string[] = [];
    const pushCandidate = (candidate?: string | null) => {
      if (!candidate) return;
      const resolved = path.resolve(candidate);
      if (!candidates.includes(resolved)) {
        candidates.push(resolved);
      }
    };

    pushCandidate(env.SKILLS_ROOT);
    pushCandidate(env.LUMIAI_SKILLS_ROOT);
    for (const root of this.extractHostSkillRootsFromPrompt(systemPrompt)) {
      pushCandidate(root);
    }
    pushCandidate(getSkillsRoot());

    if (app.isPackaged) {
      pushCandidate(path.join(process.resourcesPath, 'skills'));
      pushCandidate(path.join(process.resourcesPath, 'skills'));
      pushCandidate(path.join(app.getAppPath(), 'skills'));
      pushCandidate(path.join(app.getAppPath(), 'skills'));
    }

    pushCandidate(path.join(cwdMapping.hostPath, 'skills'));
    pushCandidate(path.join(cwdMapping.hostPath, 'skills'));

    return candidates.filter((candidate) => this.isDirectory(candidate));
  }

  private collectSandboxSkillEntries(
    hostSkillsRoots: string[],
    guestSkillsRoot: string
  ): SandboxSkillEntry[] {
    const bySkillId = new Map<string, string>();
    const orderedSkillIds: string[] = [];

    const upsertSkill = (skillId: string, hostPath: string) => {
      if (bySkillId.has(skillId)) {
        const index = orderedSkillIds.indexOf(skillId);
        if (index >= 0) {
          orderedSkillIds.splice(index, 1);
        }
      }
      bySkillId.set(skillId, hostPath);
      orderedSkillIds.push(skillId);
    };

    const collectFromSkillDir = (skillDir: string) => {
      const skillPath = path.join(skillDir, 'SKILL.md');
      if (!fs.existsSync(skillPath)) {
        return;
      }
      const skillId = path.basename(skillDir);
      if (!skillId) {
        return;
      }
      upsertSkill(skillId, path.resolve(skillDir));
    };

    for (const root of hostSkillsRoots) {
      const resolvedRoot = path.resolve(root);
      if (!this.isDirectory(resolvedRoot)) {
        continue;
      }

      // Root itself can be a skill directory.
      collectFromSkillDir(resolvedRoot);

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (!entry.isDirectory() && !entry.isSymbolicLink()) {
          continue;
        }
        collectFromSkillDir(path.join(resolvedRoot, entry.name));
      }
    }

    return orderedSkillIds.map((skillId, index) => {
      const hostPath = bySkillId.get(skillId)!;
      const guestPath = `${guestSkillsRoot}/${skillId}`.replace(/\/+/g, '/');
      return {
        skillId,
        hostPath,
        guestPath,
        mountTag: `${SANDBOX_SKILLS_MOUNT_TAG}${index}`,
      };
    });
  }

  private resolveSandboxSkillsConfig(
    hostSkillsRoots: string[],
    runtimePlatform: string
  ): {
    guestSkillsRoot: string | null;
    skillEntries: SandboxSkillEntry[];
    extraMounts: SandboxExtraMount[];
    skillMounts: Record<string, { tag: string; guestPath: string }>;
    rootMounts: SandboxSkillRootMount[];
  } {
    const guestSkillsRoot = runtimePlatform === 'win32'
      ? SANDBOX_SKILLS_GUEST_PATH_WINDOWS
      : SANDBOX_SKILLS_GUEST_PATH;
    const skillEntries = this.collectSandboxSkillEntries(hostSkillsRoots, guestSkillsRoot);
    if (skillEntries.length === 0) {
      return {
        guestSkillsRoot: null,
        skillEntries: [],
        extraMounts: [],
        skillMounts: {},
        rootMounts: [],
      };
    }

    if (runtimePlatform === 'win32') {
      // Windows sandbox uses virtio-serial sync instead of 9p mounts.
      return {
        guestSkillsRoot,
        skillEntries,
        extraMounts: [],
        skillMounts: {},
        rootMounts: [],
      };
    }

    const keyOf = (target: string): string => (
      process.platform === 'win32' ? target.toLowerCase() : target
    );
    const entryRoots = new Set<string>();
    for (const entry of skillEntries) {
      entryRoots.add(path.resolve(path.dirname(entry.hostPath)));
    }

    const mountHostRoots: string[] = [];
    const seenMountRoots = new Set<string>();
    const pushMountRoot = (candidate: string) => {
      const resolved = path.resolve(candidate);
      if (!entryRoots.has(resolved) || !this.isDirectory(resolved)) {
        return;
      }
      const key = keyOf(resolved);
      if (seenMountRoots.has(key)) {
        return;
      }
      seenMountRoots.add(key);
      mountHostRoots.push(resolved);
    };

    for (const root of hostSkillsRoots) {
      pushMountRoot(root);
    }
    for (const root of entryRoots) {
      pushMountRoot(root);
    }

    const rootMounts = mountHostRoots.map<SandboxSkillRootMount>((hostRoot, index) => ({
      hostRoot,
      guestRoot: index === 0 ? guestSkillsRoot : `${guestSkillsRoot}-roots/${index}`,
      mountTag: `${SANDBOX_SKILLS_MOUNT_TAG}${index}`,
    }));

    const extraMounts = rootMounts.map(({ hostRoot, mountTag }) => ({ hostPath: hostRoot, mountTag }));
    const skillMounts = rootMounts.reduce<Record<string, { tag: string; guestPath: string }>>((acc, entry, index) => {
      acc[`skillsRoot${index}`] = {
        tag: entry.mountTag,
        guestPath: entry.guestRoot,
      };
      return acc;
    }, {});

    return {
      guestSkillsRoot,
      skillEntries,
      extraMounts,
      skillMounts,
      rootMounts,
    };
  }

  private buildSandboxEnv(
    env: Record<string, string | undefined>,
    guestSkillsRoot: string | null
  ): Record<string, string> {
    const sandboxEnv: Record<string, string> = {};

    // In QEMU user-mode networking, the host is accessible at 10.0.2.2
    // Remap localhost/127.0.0.1 proxy URLs to the QEMU gateway
    const remapLocalhostToQemuGateway = (url: string): string => {
      return url
        .replace(/\/\/localhost([:/])/gi, '//10.0.2.2$1')
        .replace(/\/\/127\.0\.0\.1([:/])/g, '//10.0.2.2$1');
    };

    for (const key of SANDBOX_ALLOWED_ENV_KEYS) {
      const value = env[key];
      if (!value) continue;
      if (
        (key.toLowerCase().includes('proxy') && !key.toLowerCase().includes('no_proxy'))
        || key === 'ANTHROPIC_BASE_URL'
        || key === 'LUMIAI_API_BASE_URL'
      ) {
        sandboxEnv[key] = remapLocalhostToQemuGateway(value);
      } else {
        sandboxEnv[key] = value;
      }
    }

    const envTimezone = (sandboxEnv.TZ ?? sandboxEnv.tz ?? '').trim();
    if (envTimezone) {
      sandboxEnv.TZ = envTimezone;
      delete sandboxEnv.tz;
    } else {
      // Keep sandbox wall-clock time aligned with host locale when TZ is not explicitly set.
      const hostTimezone = Intl.DateTimeFormat().resolvedOptions().timeZone?.trim();
      if (hostTimezone) {
        sandboxEnv.TZ = hostTimezone;
      }
    }

    if (guestSkillsRoot) {
      sandboxEnv.SKILLS_ROOT = guestSkillsRoot;
      sandboxEnv.LUMIAI_SKILLS_ROOT = guestSkillsRoot;
    }
    sandboxEnv.WEB_SEARCH_SERVER = 'http://10.0.2.2:8923';

    // Ensure requests to host-side services bypass system HTTP proxies.
    const noProxyHosts = [
      'localhost',
      '127.0.0.1',
      '10.0.2.2',
    ];
    const anthropicHost = extractHostFromUrl(sandboxEnv.ANTHROPIC_BASE_URL);
    const internalApiHost = extractHostFromUrl(sandboxEnv.LUMIAI_API_BASE_URL);
    const webSearchHost = extractHostFromUrl(sandboxEnv.WEB_SEARCH_SERVER);
    if (anthropicHost) noProxyHosts.push(anthropicHost);
    if (internalApiHost) noProxyHosts.push(internalApiHost);
    if (webSearchHost) noProxyHosts.push(webSearchHost);

    const mergedNoProxy = mergeNoProxyList(sandboxEnv.NO_PROXY ?? sandboxEnv.no_proxy, noProxyHosts);
    sandboxEnv.NO_PROXY = mergedNoProxy;
    sandboxEnv.no_proxy = mergedNoProxy;

    // Some SDK/network stacks may ignore NO_PROXY for local gateway addresses.
    // When model traffic is explicitly routed to host gateway, force direct mode.
    const anthropicBaseHost = extractHostFromUrl(sandboxEnv.ANTHROPIC_BASE_URL)?.toLowerCase();
    const shouldForceDirectHostRouting = anthropicBaseHost === '10.0.2.2'
      || anthropicBaseHost === '127.0.0.1'
      || anthropicBaseHost === 'localhost';
    if (shouldForceDirectHostRouting) {
      delete sandboxEnv.HTTP_PROXY;
      delete sandboxEnv.HTTPS_PROXY;
      delete sandboxEnv.http_proxy;
      delete sandboxEnv.https_proxy;
    }

    return sandboxEnv;
  }

  private parseAttachmentEntries(prompt: string): AttachmentEntry[] {
    const lines = prompt.split(/\r?\n/);
    const entries: AttachmentEntry[] = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      const match = line.match(ATTACHMENT_LINE_RE);
      if (!match?.[1] || !match[2]) continue;
      entries.push({
        lineIndex: i,
        label: match[1],
        rawPath: match[2].trim(),
      });
    }
    return entries;
  }

  private resolveAttachmentPath(inputPath: string, cwd: string): string {
    if (inputPath.startsWith('~/')) {
      const home = process.env.HOME || process.env.USERPROFILE || '';
      return home ? path.resolve(home, inputPath.slice(2)) : path.resolve(cwd, inputPath);
    }
    return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath);
  }

  private toWorkspaceRelativePromptPath(cwd: string, absolutePath: string): string {
    const relative = path.relative(cwd, absolutePath);
    const normalized = relative.split(path.sep).join('/');
    if (!normalized || normalized === '.') {
      return './';
    }
    return normalized.startsWith('.') ? normalized : `./${normalized}`;
  }

  private stageExternalAttachment(
    cwd: string,
    sourcePath: string,
    sessionId: string,
    index: number
  ): string | null {
    if (!fs.existsSync(sourcePath)) {
      return null;
    }

    try {
      const sourceStat = fs.statSync(sourcePath);
      const stageRoot = path.join(cwd, SANDBOX_ATTACHMENT_DIR, sessionId);
      fs.mkdirSync(stageRoot, { recursive: true });

      const baseName = path.basename(sourcePath) || `attachment-${index + 1}`;
      const parsed = path.parse(baseName);
      let targetPath = path.join(stageRoot, baseName);
      let suffix = 1;
      while (fs.existsSync(targetPath)) {
        targetPath = path.join(stageRoot, `${parsed.name}-${suffix}${parsed.ext}`);
        suffix += 1;
      }

      if (sourceStat.isDirectory()) {
        cpRecursiveSync(sourcePath, targetPath, { force: true });
      } else {
        fs.copyFileSync(sourcePath, targetPath);
      }

      return this.toWorkspaceRelativePromptPath(cwd, targetPath);
    } catch (error) {
      console.warn('[cowork] Failed to stage sandbox attachment:', sourcePath, error);
      return null;
    }
  }

  /**
   * Push staged attachment files from .cowork-temp/attachments/{sessionId}/ to
   * the sandbox VM via virtio-serial bridge.  On macOS/Linux, attachments are
   * accessible via 9p mount, so this is only needed on Windows (serial mode).
   */
  private pushStagedAttachmentsToSandbox(
    bridge: VirtioSerialBridge,
    cwd: string,
    sessionId: string
  ): void {
    const stageRoot = path.join(cwd, SANDBOX_ATTACHMENT_DIR, sessionId);
    if (!fs.existsSync(stageRoot)) {
      return;
    }

    const files: { relativePath: string; data: Buffer }[] = [];
    const scan = (dir: string, base: string): void => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        const fullPath = path.join(dir, entry.name);
        const relPath = base ? `${base}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          scan(fullPath, relPath);
        } else if (entry.isFile()) {
          try {
            files.push({ relativePath: relPath, data: fs.readFileSync(fullPath) });
          } catch { /* skip unreadable files */ }
        }
      }
    };
    scan(stageRoot, '');

    if (files.length === 0) {
      return;
    }

    const guestAttachmentDir = `${SANDBOX_ATTACHMENT_DIR.split(path.sep).join('/')}/${sessionId}`;
    for (const file of files) {
      bridge.pushFile(
        SANDBOX_WORKSPACE_GUEST_ROOT,
        `${guestAttachmentDir}/${file.relativePath}`,
        file.data
      );
    }
    coworkLog('INFO', 'runSandbox', 'Pushed staged attachments to sandbox', {
      sessionId,
      fileCount: files.length,
      files: files.map((f) => f.relativePath).join(', '),
    });
  }

  private preparePromptForSandbox(prompt: string, cwd: string, sessionId: string): {
    prompt: string;
    unresolved: string[];
  } {
    return this.promptBuilder.preparePromptForSandbox(prompt, cwd, sessionId);
  }

  private findWorkspaceFileByName(cwd: string, fileName: string, maxMatches = 2): string[] {
    if (!fileName) {
      return [];
    }

    const matches: string[] = [];
    const queue: string[] = [cwd];
    while (queue.length > 0 && matches.length < maxMatches) {
      const current = queue.shift();
      if (!current) continue;

      let entries: fs.Dirent[] = [];
      try {
        entries = fs.readdirSync(current, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const entry of entries) {
        if (matches.length >= maxMatches) break;
        const fullPath = path.join(current, entry.name);
        if (entry.isDirectory()) {
          if (INFERRED_FILE_SEARCH_IGNORE.has(entry.name)) {
            continue;
          }
          queue.push(fullPath);
          continue;
        }
        if (entry.isFile() && entry.name === fileName) {
          matches.push(fullPath);
        }
      }
    }

    return matches;
  }

  private resolveInferredFilePath(candidate: string, cwd: string): string | null {
    const resolved = this.resolveAttachmentPath(candidate, cwd);
    if (fs.existsSync(resolved)) {
      return resolved;
    }

    if (candidate.includes('/') || candidate.includes('\\')) {
      return null;
    }

    const matches = this.findWorkspaceFileByName(cwd, candidate, 2);
    if (matches.length === 1 && fs.existsSync(matches[0])) {
      return path.resolve(matches[0]);
    }

    return null;
  }

  private inferReferencedWorkspaceFiles(prompt: string, cwd: string): string[] {
    const matches = Array.from(prompt.matchAll(INFERRED_FILE_REFERENCE_RE));
    if (matches.length === 0) {
      return [];
    }

    const existing = new Set<string>();
    const inferred: string[] = [];

    for (const match of matches) {
      const candidate = match[1]?.trim();
      if (!candidate || candidate.includes('://')) {
        continue;
      }

      const resolved = this.resolveInferredFilePath(candidate, cwd);
      if (!resolved) {
        continue;
      }

      const relative = path.relative(cwd, resolved);
      const isOutside = relative.startsWith('..') || path.isAbsolute(relative);
      if (isOutside || existing.has(resolved)) {
        continue;
      }

      existing.add(resolved);
      inferred.push(resolved);
    }

    return inferred;
  }

  private augmentPromptWithReferencedWorkspaceFiles(prompt: string, cwd: string): string {
    return this.promptBuilder.augmentPromptWithReferencedWorkspaceFiles(prompt, cwd);
  }


  private truncateLargeContent(content: string, maxChars: number): string {
    return this.promptBuilder.truncateLargeContent(content, maxChars);
  }

  private sanitizeToolPayload(
    value: unknown,
    options: {
      maxDepth?: number;
      maxStringChars?: number;
      maxKeys?: number;
      maxItems?: number;
    } = {}
  ): unknown {
    const maxDepth = options.maxDepth ?? TOOL_INPUT_PREVIEW_MAX_DEPTH;
    const maxStringChars = options.maxStringChars ?? TOOL_INPUT_PREVIEW_MAX_CHARS;
    const maxKeys = options.maxKeys ?? TOOL_INPUT_PREVIEW_MAX_KEYS;
    const maxItems = options.maxItems ?? TOOL_INPUT_PREVIEW_MAX_ITEMS;
    const seen = new WeakSet<object>();

    const visit = (current: unknown, depth: number): unknown => {
      if (
        current === null
        || typeof current === 'number'
        || typeof current === 'boolean'
        || typeof current === 'undefined'
      ) {
        return current;
      }
      if (typeof current === 'string') {
        return this.truncateLargeContent(current, maxStringChars);
      }
      if (typeof current === 'bigint') {
        return current.toString();
      }
      if (typeof current === 'function') {
        return '[function]';
      }
      if (depth >= maxDepth) {
        return '[truncated-depth]';
      }
      if (Array.isArray(current)) {
        const sanitized = current.slice(0, maxItems).map((item) => visit(item, depth + 1));
        if (current.length > maxItems) {
          sanitized.push(`[truncated-items:${current.length - maxItems}]`);
        }
        return sanitized;
      }
      if (typeof current === 'object') {
        if (seen.has(current as object)) {
          return '[circular]';
        }
        seen.add(current as object);
        const source = current as Record<string, unknown>;
        const entries = Object.entries(source);
        const sanitized: Record<string, unknown> = {};
        for (const [key, entryValue] of entries.slice(0, maxKeys)) {
          sanitized[key] = visit(entryValue, depth + 1);
        }
        if (entries.length > maxKeys) {
          sanitized.__truncated_keys__ = entries.length - maxKeys;
        }
        return sanitized;
      }
      return String(current);
    };

    return visit(value, 0);
  }

  private appendStreamingDelta(
    current: string,
    delta: string,
    maxChars: number,
    isTruncated: boolean
  ): { content: string; truncated: boolean; changed: boolean } {
    return this.sessionService.appendStreamingDelta(current, delta, maxChars, isTruncated);
  }

  private formatSandboxHistoryMessage(message: CoworkMessage): string | null {
    return this.sessionService.formatHistoryMessage(message);
  }

  private buildHistoryBlocks(
    messages: CoworkMessage[],
    currentPrompt: string,
    limits: { maxMessages: number; maxTotalChars: number; maxMessageChars: number }
  ): string[] {
    return this.sessionService.buildHistoryBlocks(messages, currentPrompt, limits);
  }

  private buildSandboxHistoryBlocks(messages: CoworkMessage[], currentPrompt: string): string[] {
    return this.sessionService.buildSandboxHistoryBlocks(messages, currentPrompt);
  }

  private injectSandboxHistoryPrompt(sessionId: string, currentPrompt: string, effectivePrompt: string): string {
    return this.sessionService.injectSandboxHistoryPrompt(sessionId, currentPrompt, effectivePrompt);
  }

  /**
   * Inject conversation history into a local-mode prompt when the session is
   * restarted after a stop (subprocess was killed, no SDK session to resume).
   */
  private injectLocalHistoryPrompt(sessionId: string, currentPrompt: string, effectivePrompt: string): string {
    return this.sessionService.injectLocalHistoryPrompt(sessionId, currentPrompt, effectivePrompt);
  }


  private normalizeWorkspaceRoot(workspaceRoot: string, cwd: string): string {
    return this.workspace.normalizeWorkspaceRoot(workspaceRoot, cwd);
  }

  private inferWorkspaceRootFromSessionCwd(cwd: string): string {
    return this.workspace.inferWorkspaceRootFromSessionCwd(cwd);
  }

  private resolveHostWorkspaceFallback(workspaceRoot: string): string | null {
    return this.workspace.resolveHostWorkspaceFallback(workspaceRoot);
  }

  private mapSandboxGuestCwdToHost(cwd: string, hostWorkspaceRoot: string): string | null {
    return this.workspace.mapSandboxGuestCwdToHost(cwd, hostWorkspaceRoot);
  }

  private resolveSessionCwdForExecution(sessionId: string, cwd: string, workspaceRoot: string): string {
    return this.workspace.resolveSessionCwdForExecution(sessionId, cwd, workspaceRoot);
  }

  private extractToolCommand(toolInput: Record<string, unknown>): string {
    return this.toolExecution.extractToolCommand(toolInput);
  }

  private isDeleteOperation(toolName: string, toolInput: Record<string, unknown>): boolean {
    return this.toolExecution.isDeleteOperation(toolName, toolInput);
  }

  private truncateCommandPreview(command: string, maxLength = 120): string {
    return this.toolExecution.truncateCommandPreview(command, maxLength);
  }

  private buildSafetyQuestionInput(
    question: string,
    requestedToolName: string,
    requestedToolInput: Record<string, unknown>
  ): Record<string, unknown> {
    return {
      questions: [
        {
          header: '安全确认',
          question,
          options: [
            {
              label: SAFETY_APPROVAL_ALLOW_OPTION,
              description: '仅允许当前这一次操作继续执行。',
            },
            {
              label: SAFETY_APPROVAL_DENY_OPTION,
              description: '拒绝当前操作，保持文件安全边界。',
            },
          ],
        },
      ],
      answers: {},
      context: {
        requestedToolName,
        requestedToolInput: this.sanitizeToolPayload(requestedToolInput),
      },
    };
  }

  private isSafetyApproval(result: PermissionResult, question: string): boolean {
    return this.toolExecution.isSafetyApproval(result, question);
  }

  private async requestSafetyApproval(
    sessionId: string,
    signal: AbortSignal,
    activeSession: ActiveSession,
    question: string,
    requestedToolName: string,
    requestedToolInput: Record<string, unknown>
  ): Promise<boolean> {
    const request: PermissionRequest = {
      requestId: uuidv4(),
      toolName: 'AskUserQuestion',
      toolInput: this.buildSafetyQuestionInput(question, requestedToolName, requestedToolInput),
    };

    activeSession.pendingPermission = request;
    this.emit('permissionRequest', sessionId, request);

    const result = await this.waitForPermissionResponse(sessionId, request.requestId, signal);
    if (activeSession.abortController.signal.aborted || signal.aborted) {
      return false;
    }
    return this.isSafetyApproval(result, question);
  }

  private async enforceToolSafetyPolicy(
    sessionId: string,
    signal: AbortSignal,
    activeSession: ActiveSession,
    toolName: string,
    toolInput: Record<string, unknown>
  ): Promise<PermissionResult | null> {
    if (this.isDeleteOperation(toolName, toolInput)) {
      const commandPreview = toolName === 'Bash'
        ? this.truncateCommandPreview(this.extractToolCommand(toolInput))
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

  private async ensureWindowsPythonRuntimeForCommand(
    sessionId: string,
    command: string
  ): Promise<{ ok: boolean; reason?: string }> {
    // Delegate to ToolExecutionService
    const toolExec = this.toolExecution;
    if (process.platform !== 'win32' || !toolExec.isPythonRelatedBashCommand(command)) {
      return { ok: true };
    }

    const isPipCommand = toolExec.isPythonPipBashCommand(command);
    const runtimeResult = isPipCommand
      ? await ensurePythonPipReady()
      : await ensurePythonRuntimeReady();
    if (runtimeResult.success) {
      return { ok: true };
    }

    const reason = runtimeResult.error
      || (isPipCommand ? 'Bundled Python pip environment is unavailable.' : 'Bundled Python runtime is unavailable.');
    const summary = toolExec.truncateCommandPreview(command, 140);
    coworkLog('ERROR', 'python-runtime', 'Windows python command blocked: runtime unavailable', {
      sessionId,
      command: summary,
      reason,
    });
    return {
      ok: false,
      reason: isPipCommand
        ? `[python-runtime] Windows 内置 Python pip 环境不可用，已阻止执行该 pip 命令。\n原因: ${reason}\n请重装应用或联系管理员修复内置运行时。`
        : `[python-runtime] Windows 内置 Python 运行时不可用，已阻止执行该 Python 命令。\n原因: ${reason}\n请重装应用或联系管理员修复内置运行时。`,
    };
  }

  async startSession(
    sessionId: string,
    prompt: string,
    options: {
      skipInitialUserMessage?: boolean;
      skillIds?: string[];
      systemPrompt?: string;
      autoApprove?: boolean;
      workspaceRoot?: string;
      confirmationMode?: 'modal' | 'text';
      imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
    } = {}
  ): Promise<void> {
    this.stoppedSessions.delete(sessionId);
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }

    // Mark session as running
    this.store.updateSession(sessionId, { status: 'running' });

    if (!options.skipInitialUserMessage) {
      // Add user message with skill info and imageAttachments
      const messageMetadata: Record<string, unknown> = {};
      if (options.skillIds?.length) {
        messageMetadata.skillIds = options.skillIds;
      }
      if (options.imageAttachments?.length) {
        messageMetadata.imageAttachments = options.imageAttachments;
      }
      const userMessage = this.store.addMessage(sessionId, {
        type: 'user',
        content: prompt,
        metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
      });
      this.emit('message', sessionId, userMessage);
    }

    // Create abort controller
    const abortController = new AbortController();
    const preferredWorkspaceRoot = options.workspaceRoot?.trim()
      ? path.resolve(options.workspaceRoot)
      : this.inferWorkspaceRootFromSessionCwd(session.cwd);
    const sessionCwd = this.resolveSessionCwdForExecution(sessionId, session.cwd, preferredWorkspaceRoot);

    // Store active session
    const activeSession: ActiveSession = {
      sessionId,
      claudeSessionId: session.claudeSessionId,
      workspaceRoot: options.workspaceRoot?.trim()
        ? path.resolve(options.workspaceRoot)
        : this.inferWorkspaceRootFromSessionCwd(sessionCwd),
      confirmationMode: options.confirmationMode ?? 'modal',
      pendingPermission: null,
      abortController,
      currentStreamingMessageId: null,
      currentStreamingContent: '',
      currentStreamingThinkingMessageId: null,
      currentStreamingThinking: '',
      currentStreamingBlockType: null,
      currentStreamingTextTruncated: false,
      currentStreamingThinkingTruncated: false,
      lastStreamingTextUpdateAt: 0,
      lastStreamingThinkingUpdateAt: 0,
      hasAssistantTextOutput: false,
      hasAssistantThinkingOutput: false,
      executionMode: 'local',
      autoApprove: options.autoApprove ?? false,
    };
    this.activeSessions.set(sessionId, activeSession);
    if (session.cwd !== sessionCwd) {
      this.store.updateSession(sessionId, { cwd: sessionCwd });
    }

    const baseSystemPrompt = options.systemPrompt ?? session.systemPrompt;
    const effectiveSystemPrompt = composeEffectiveSystemPrompt(
      baseSystemPrompt,
      this.normalizeWorkspaceRoot(activeSession.workspaceRoot, sessionCwd),
      sessionCwd,
      activeSession.confirmationMode,
      this.store.getConfig().memoryEnabled
    );

    // Run claude-code using the SDK
    try {
      const promptPrefix = buildPromptPrefix(this.buildUserMemoriesXml());
      let effectivePrompt = promptPrefix ? `${promptPrefix}\n\n---\n\n${prompt}` : prompt;

      // If the session already has messages (restarted after stop), inject
      // conversation history so the model retains context from prior turns.
      const currentSession = this.store.getSession(sessionId);
      if (currentSession && currentSession.messages.length > 0) {
        effectivePrompt = injectLocalHistoryPrompt(sessionId, prompt, effectivePrompt, this.store);
      }

      await this.runClaudeCode(activeSession, effectivePrompt, sessionCwd, effectiveSystemPrompt, options.imageAttachments);
    } catch (error) {
      console.error('Cowork session error:', error);
    }
  }

  async continueSession(sessionId: string, prompt: string, options: { systemPrompt?: string; skillIds?: string[]; imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }> } = {}): Promise<void> {
    this.stoppedSessions.delete(sessionId);
    const activeSession = this.activeSessions.get(sessionId);
    if (!activeSession) {
      // If not active, start a new run
      await this.startSession(sessionId, prompt, {
        skillIds: options.skillIds,
        systemPrompt: options.systemPrompt,
        imageAttachments: options.imageAttachments,
      });
      return;
    }

    // Ensure status returns to running for resumed turns on active sessions.
    this.store.updateSession(sessionId, { status: 'running' });

    // Add user message with skill info and imageAttachments
    const messageMetadata: Record<string, unknown> = {};
    if (options.skillIds?.length) {
      messageMetadata.skillIds = options.skillIds;
    }
    if (options.imageAttachments?.length) {
      messageMetadata.imageAttachments = options.imageAttachments;
    }
    console.log('[CoworkRunner] continueSession: building user message', {
      sessionId,
      hasImageAttachments: !!options.imageAttachments,
      imageAttachmentsCount: options.imageAttachments?.length ?? 0,
      metadataKeys: Object.keys(messageMetadata),
      metadataHasImageAttachments: !!messageMetadata.imageAttachments,
    });
    const userMessage = this.store.addMessage(sessionId, {
      type: 'user',
      content: prompt,
      metadata: Object.keys(messageMetadata).length > 0 ? messageMetadata : undefined,
    });
    console.log('[CoworkRunner] continueSession: emitting message', {
      sessionId,
      messageId: userMessage.id,
      hasMetadata: !!userMessage.metadata,
      metadataKeys: userMessage.metadata ? Object.keys(userMessage.metadata) : [],
      hasImageAttachments: !!(userMessage.metadata as Record<string, unknown>)?.imageAttachments,
    });
    this.emit('message', sessionId, userMessage);

    // Continue with the existing session
    const session = this.store.getSession(sessionId);
    if (!session) {
      throw new Error(`Session ${sessionId} not found`);
    }
    const sessionCwd = this.resolveSessionCwdForExecution(sessionId, session.cwd, activeSession.workspaceRoot);
    if (session.cwd !== sessionCwd) {
      this.store.updateSession(sessionId, { cwd: sessionCwd });
    }

    // Use provided systemPrompt (e.g. with updated skill routing) or fall back to session's stored one.
    // Always prepend workspace safety prompt so folder boundary rules are enforced at prompt level.
    let baseSystemPrompt = options.systemPrompt ?? session.systemPrompt;

    // On follow-up turns without new skill selection, strip the full available_skills
    // block to reduce prompt size — the skill was already routed on the first turn.
    if (!options.skillIds?.length && baseSystemPrompt?.includes('<available_skills>')) {
      baseSystemPrompt = baseSystemPrompt.replace(
        /## Skills \(mandatory\)[\s\S]*?<\/available_skills>/,
        '## Skills\nSkill already loaded for this session. Continue following its instructions.'
      );
    }

    const effectiveSystemPrompt = composeEffectiveSystemPrompt(
      baseSystemPrompt,
      this.normalizeWorkspaceRoot(activeSession.workspaceRoot, sessionCwd),
      sessionCwd,
      activeSession.confirmationMode,
      this.store.getConfig().memoryEnabled
    );

    try {
      const promptPrefix = buildPromptPrefix(this.buildUserMemoriesXml());
      const effectivePrompt = promptPrefix ? `${promptPrefix}\n\n---\n\n${prompt}` : prompt;
      await this.runClaudeCode(activeSession, effectivePrompt, sessionCwd, effectiveSystemPrompt, options.imageAttachments);
    } catch (error) {
      console.error('Cowork continue error:', error);
    }
  }

  stopSession(sessionId: string): void {
    this.stoppedSessions.add(sessionId);
    const activeSession = this.activeSessions.get(sessionId);
    if (activeSession) {
      activeSession.abortController.abort();
      if (activeSession.ipcBridge) {
        try {
          activeSession.ipcBridge.close();
        } catch (error) {
          console.warn('Failed to close IPC bridge:', error);
        }
        activeSession.ipcBridge = undefined;
      }
      if (activeSession.sandboxProcess) {
        try {
          activeSession.sandboxProcess.kill('SIGKILL');
        } catch (error) {
          console.warn('Failed to kill sandbox process:', error);
        }
      }
      activeSession.pendingPermission = null;
      this.activeSessions.delete(sessionId);
    }
    this.clearPendingPermissions(sessionId);
    this.clearSandboxPermissions(sessionId);
    this.store.updateSession(sessionId, { status: 'idle' });
  }

  respondToPermission(requestId: string, result: PermissionResult): void {
    const sandboxPermission = this.sandboxPermissions.get(requestId);
    if (sandboxPermission) {
      // Write file-based response (used by 9p/file-mode IPC)
      try {
        fs.writeFileSync(sandboxPermission.responsePath, JSON.stringify(result));
      } catch (error) {
        console.error('Failed to write sandbox permission response:', error);
      }
      // Also send via virtio-serial bridge if available (used on Windows)
      const activeSession = this.activeSessions.get(sandboxPermission.sessionId);
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

    const activeSession = this.activeSessions.get(pending.sessionId);
    if (activeSession) {
      activeSession.pendingPermission = null;
    }
  }

  private async runClaudeCodeLocal(
    activeSession: ActiveSession,
    prompt: string,
    cwd: string,
    systemPrompt: string,
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>
  ): Promise<void> {
    // Delegate to LocalExecutionService
    const result = await this.localExecution.run({
      activeSession,
      prompt,
      cwd,
      systemPrompt,
      imageAttachments,
    });
    if (!result.ok) {
      const error = result as { ok: false; error: Error; canFallback?: boolean };
      if (error.canFallback) {
        // Fallback behavior is handled by caller (runClaudeCode)
      }
    }
  }

  private async runClaudeCode(
    activeSession: ActiveSession,
    prompt: string,
    cwd: string,
    systemPrompt: string,
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>
  ): Promise<void> {
    const { sessionId } = activeSession;
    if (this.isSessionStopRequested(sessionId, activeSession)) {
      this.store.updateSession(sessionId, { status: 'idle' });
      this.clearPendingPermissions(sessionId);
      this.activeSessions.delete(sessionId);
      return;
    }
    const config = this.store.getConfig();
    const executionMode: CoworkExecutionMode = config.executionMode || 'local';
    const resolvedCwd = path.resolve(cwd);

    if (!fs.existsSync(resolvedCwd)) {
      this.handleError(sessionId, `Working directory does not exist: ${resolvedCwd}`);
      this.clearPendingPermissions(sessionId);
      this.activeSessions.delete(sessionId);
      return;
    }

    const shouldPrepareSandboxPrompt = executionMode !== 'local' || activeSession.executionMode === 'sandbox';
    let effectivePrompt = this.augmentPromptWithReferencedWorkspaceFiles(prompt, resolvedCwd);
    let unresolvedSandboxAttachments: string[] = [];
    if (shouldPrepareSandboxPrompt) {
      const prepared = this.preparePromptForSandbox(effectivePrompt, resolvedCwd, sessionId);
      effectivePrompt = prepared.prompt;
      unresolvedSandboxAttachments = prepared.unresolved;
    }

    const outsideAttachments = Array.from(new Set([
      ...this.findAttachmentsOutsideCwd(effectivePrompt, resolvedCwd),
      ...unresolvedSandboxAttachments,
    ]));
    const hasActiveSandboxVm = (
      activeSession.executionMode === 'sandbox'
      && activeSession.sandboxProcess
      && !activeSession.sandboxProcess.killed
      && activeSession.ipcBridge
    );
    if (outsideAttachments.length > 0 && (executionMode !== 'local' || hasActiveSandboxVm)) {
      const detail = outsideAttachments.join(', ');
      if (executionMode === 'sandbox' || hasActiveSandboxVm) {
        this.handleError(
          sessionId,
          `Attachment paths outside working directory are not available in sandbox mode: ${detail}`
        );
        this.clearPendingPermissions(sessionId);
        this.activeSessions.delete(sessionId);
        return;
      }

      this.addSystemMessage(
        sessionId,
        `Attachments outside the working directory are not available in the Sandbox VM. Falling back to local execution.`
      );
      activeSession.executionMode = 'local';
      this.store.updateSession(sessionId, { executionMode: 'local' });
      await this.runClaudeCodeLocal(activeSession, effectivePrompt, resolvedCwd, systemPrompt, imageAttachments);
      return;
    }

    // If there's already a running sandbox VM with IPC bridge, send a
    // continuation request to the same VM instead of spawning a new one.
    if (hasActiveSandboxVm) {
      await this.continueSandboxTurn(activeSession, effectivePrompt, resolvedCwd, systemPrompt, imageAttachments);
      return;
    }

    if (executionMode === 'local') {
      activeSession.executionMode = 'local';
      this.store.updateSession(sessionId, { executionMode: 'local' });
      await this.runClaudeCodeLocal(activeSession, effectivePrompt, resolvedCwd, systemPrompt, imageAttachments);
      return;
    }

    const sandboxReady = executionMode === 'auto'
      ? getSandboxRuntimeInfoIfReady()
      : await ensureSandboxReady();
    if (!sandboxReady.ok) {
      const errorMessage = 'error' in sandboxReady ? sandboxReady.error : 'Sandbox VM unavailable.';
      coworkLog('WARN', 'runClaudeCode', 'Sandbox not ready', { errorMessage, executionMode });
      if (executionMode === 'sandbox') {
        this.handleError(sessionId, errorMessage);
        this.clearPendingPermissions(sessionId);
        this.activeSessions.delete(sessionId);
        return;
      }

      if (executionMode !== 'auto') {
        this.addSystemMessage(
          sessionId,
          this.getSandboxUnavailableFallbackNotice(errorMessage)
        );
      }
      activeSession.executionMode = 'local';
      this.store.updateSession(sessionId, { executionMode: 'local' });
      await this.runClaudeCodeLocal(activeSession, effectivePrompt, resolvedCwd, systemPrompt, imageAttachments);
      return;
    }

    try {
      const sandboxPrompt = injectSandboxHistoryPrompt(sessionId, prompt, effectivePrompt, this.store);
      activeSession.executionMode = 'sandbox';
      this.store.updateSession(sessionId, { executionMode: 'sandbox' });
      coworkLog('INFO', 'runClaudeCode', 'Starting sandbox execution', {
        sessionId,
        runtimeBinary: sandboxReady.runtimeInfo.runtimeBinary,
        imagePath: sandboxReady.runtimeInfo.imagePath,
        platform: sandboxReady.runtimeInfo.platform,
        arch: sandboxReady.runtimeInfo.arch,
      });
      await this.runClaudeCodeInSandbox(activeSession, sandboxPrompt, resolvedCwd, systemPrompt, sandboxReady.runtimeInfo, imageAttachments);
      // If the sandbox VM is still alive, keep the activeSession for multi-turn continuation.
      // Otherwise (VM exited), clean up.
      if (!activeSession.sandboxProcess || activeSession.sandboxProcess.killed) {
        this.activeSessions.delete(sessionId);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown sandbox error';
      if (executionMode === 'sandbox') {
        this.handleError(sessionId, message);
        this.activeSessions.delete(sessionId);
        return;
      }

      this.addSystemMessage(
        sessionId,
        `Sandbox VM execution failed. Falling back to local execution. (${message})`
      );
      activeSession.executionMode = 'local';
      this.store.updateSession(sessionId, { executionMode: 'local' });
      this.activeSessions.set(sessionId, activeSession);
      await this.runClaudeCodeLocal(activeSession, effectivePrompt, resolvedCwd, systemPrompt, imageAttachments);
    }
  }

  private async runClaudeCodeInSandbox(
    activeSession: ActiveSession,
    prompt: string,
    cwd: string,
    systemPrompt: string,
    runtimeInfo: SandboxRuntimeInfo,
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>
  ): Promise<void> {
    // Delegate to SandboxExecutionService
    return this.sandboxExecution.run({
      activeSession,
      prompt,
      cwd,
      systemPrompt,
      runtimeInfo,
      imageAttachments,
    });
  }

  /**
   * Send a continuation request to an already-running sandbox VM.
   * Reuses the existing QEMU process and IPC bridge.
   */
  private async continueSandboxTurn(
    activeSession: ActiveSession,
    prompt: string,
    cwd: string,
    systemPrompt: string,
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>
  ): Promise<void> {
    // Delegate to SandboxExecutionService
    return this.sandboxExecution.continueTurn(activeSession, prompt, cwd, systemPrompt, imageAttachments);
  }

  private resolveAutoRoutingForSandbox(
    systemPrompt: string,
    options: SandboxSkillRewriteOptions = {}
  ): string {
    const guestSkillsRoot = options.guestSkillsRoot?.trim();
    const { prompt: rewrittenPrompt, hasRewrite } = rewriteSkillReferencesForSandbox(systemPrompt, options);
    if (!rewrittenPrompt.includes('<available_skills>')) {
      if (hasRewrite && guestSkillsRoot && !rewrittenPrompt.includes('Sandbox path note: Skills are mounted at')) {
        return [
          `Sandbox path note: Skills are mounted at \`${guestSkillsRoot}\`.`,
          rewrittenPrompt,
        ].join('\n\n');
      }
      return rewrittenPrompt;
    }

    const skillBlockRe = /<available_skills>([\s\S]*?)<\/available_skills>/;
    const match = rewrittenPrompt.match(skillBlockRe);
    if (!match) return rewrittenPrompt;

    // Prefer keeping the original auto-routing flow (select one skill by description,
    // then read it) and only rewrite skill locations to sandbox paths.
    if (guestSkillsRoot) {
      let hasLocationRewrite = false;
      const rewritten = rewrittenPrompt.replace(
        /<location>(.*?)<\/location>/g,
        (_fullMatch: string, rawLocation: string) => {
          const mapped = rewriteSkillLocationForSandbox(rawLocation, options);
          if (!mapped) {
            return `<location>${rawLocation}</location>`;
          }
          hasLocationRewrite = true;
          return `<location>${mapped}</location>`;
        }
      );

      if (hasLocationRewrite) {
        const sandboxPathNote = `Sandbox path note: Skills are mounted at \`${guestSkillsRoot}\`.`;
        if (rewritten.includes(sandboxPathNote)) {
          return rewritten;
        }
        return rewritten.replace(
          '## Skills (mandatory)',
          `## Skills (mandatory)\n${sandboxPathNote}`
        );
      }
    }

    // Fallback: inline skill contents when location-based routing cannot be used.
    // Extract all <location> paths from the available_skills block
    const locationRe = /<location>(.*?)<\/location>/g;
    const skillContents: string[] = [];
    let locMatch: RegExpExecArray | null;

    while ((locMatch = locationRe.exec(match[1])) !== null) {
      const skillPath = locMatch[1].trim();
      try {
        const resolvedSkillPath = resolveSkillPathFromRoots(skillPath, options.hostSkillsRoots ?? []);
        if (resolvedSkillPath && fs.existsSync(resolvedSkillPath)) {
          const content = fs.readFileSync(resolvedSkillPath, 'utf8').trim();
          let rewrittenContent = rewriteSkillPathsForSandbox(content, resolvedSkillPath, options);
          // Extract skill name from the <name> tag near this location
          const nameRe = new RegExp(`<name>(.*?)</name>[\\s\\S]*?<location>${skillPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}</location>`);
          const nameMatch = match[1].match(nameRe);
          const skillId = path.basename(path.dirname(resolvedSkillPath));
          const name = nameMatch?.[1] || skillId;
          const sandboxSkillLocation = rewriteSkillLocationForSandbox(resolvedSkillPath, options);
          const sandboxSkillDir = sandboxSkillLocation
            ? path.posix.dirname(sandboxSkillLocation.replace(/\\/g, '/'))
            : guestSkillsRoot
              ? `${guestSkillsRoot}/${skillId}`.replace(/\/+/g, '/')
              : null;
          if (sandboxSkillDir) {
            rewrittenContent = rewrittenContent.replace(
              /\]\((?!https?:\/\/|#|\/)(\.\/)?([^)]+)\)/g,
              `](${sandboxSkillDir}/$2)`
            );
            skillContents.push(
              `## ${name}\n\n> **Skill files directory**: \`${sandboxSkillDir}/\`\n> When this skill references relative file paths or scripts, resolve them under \`${sandboxSkillDir}/\`.\n\n${rewrittenContent}`
            );
          } else {
            skillContents.push(`## ${name}\n\n${rewrittenContent}`);
          }
        } else {
          coworkLog('WARN', 'resolveAutoRouting', `Skill file not found on host: ${skillPath}`, {
            hostSkillsRoots: (options.hostSkillsRoots ?? []).join(', '),
          });
        }
      } catch (error) {
        coworkLog('ERROR', 'resolveAutoRouting', `Failed to read skill file for sandbox: ${skillPath}`, {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    if (skillContents.length === 0) {
      coworkLog('WARN', 'resolveAutoRouting', 'No skill contents resolved, removing auto-routing section');
      // Remove the entire auto-routing section if no skills could be read
      const sectionRe = /## Skills \(mandatory\)[\s\S]*?<\/available_skills>/;
      return rewrittenPrompt.replace(sectionRe, '').trim();
    }

    coworkLog('INFO', 'resolveAutoRouting', `Resolved ${skillContents.length} skills for sandbox`);

    // Replace the auto-routing section with full skill content
    const sandboxPathNote = guestSkillsRoot
      ? `Sandbox path note: Skills are mounted at \`${guestSkillsRoot}\`. If a skill mentions \`/home/ubuntu/skills\`, \`/mnt/skills\`, \`/tmp/workspace/skills\`, or \`skills/...\`, rewrite it to \`${guestSkillsRoot}/...\`.`
      : 'Sandbox path note: Prefer workspace-relative paths when skill instructions mention local files.';
    let fullContent = `# Available Skills\n\n${sandboxPathNote}\n\nFollow the instructions in each applicable skill section below:\n\n${skillContents.join('\n\n---\n\n')}`;

    // Remap localhost/127.0.0.1 references to QEMU host gateway (10.0.2.2)
    // so that skills referencing host services work from inside the sandbox
    fullContent = fullContent
      .replace(/127\.0\.0\.1/g, '10.0.2.2')
      .replace(/localhost(?=[:\/])/gi, '10.0.2.2');
    const sectionRe = /## Skills \(mandatory\)[\s\S]*?<\/available_skills>/;
    return rewrittenPrompt.replace(sectionRe, fullContent).trim();
  }

  private enforceSandboxWorkspacePrompt(
    systemPrompt: string,
    guestWorkspaceRoot: string
  ): string {
    const normalizedGuestRoot = guestWorkspaceRoot.replace(/\\/g, '/').replace(/\/+$/, '') || '/workspace/project';
    let rewritten = systemPrompt
      .replace(
        /(^\s*-\s*Selected workspace root:\s*).+$/m,
        `$1${normalizedGuestRoot}`
      )
      .replace(
        /(^\s*-\s*Current working directory:\s*).+$/m,
        `$1${normalizedGuestRoot}`
      );

    const sandboxPathRule = [
      '## Sandbox Path Rule (Highest Priority)',
      `- You are running inside a Linux sandbox VM. Use only sandbox paths under \`${normalizedGuestRoot}\` in tool inputs.`,
      `- If a host path appears (for example \`/Users/...\` or \`C:\\\\...\`), map it to \`${normalizedGuestRoot}\` before calling tools.`,
    ].join('\n');

    if (!rewritten.includes('## Sandbox Path Rule (Highest Priority)')) {
      rewritten = [sandboxPathRule, rewritten].filter(Boolean).join('\n\n');
    }
    return rewritten;
  }

  private waitForPermissionResponse(
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

  private clearPendingPermissions(sessionId: string): void {
    for (const [requestId, pending] of this.pendingPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        pending.resolve({ behavior: 'deny', message: 'Session aborted' });
        this.pendingPermissions.delete(requestId);
      }
    }
  }

  private clearSandboxPermissions(sessionId: string): void {
    for (const [requestId, pending] of this.sandboxPermissions.entries()) {
      if (pending.sessionId === sessionId) {
        this.sandboxPermissions.delete(requestId);
      }
    }
  }

  private async waitForVmReady(
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
    const extensionStepMs = 60000;
    const serialActivityWindowMs = 20000;
    let currentTimeoutMs = timeout;
    let timeoutExtensionCount = 0;
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

      if (processExited) {
        console.error(`Sandbox VM process exited prematurely (exit code: ${processExitCode})`);
        return false;
      }

      if (shouldAutoExtend && lastSerialActivityAt > 0) {
        const elapsed = Date.now() - start;
        const serialIdleMs = Date.now() - lastSerialActivityAt;
        const hasRecentBootActivity = serialIdleMs <= serialActivityWindowMs;
        if (hasRecentBootActivity && elapsed < maxTimeoutMs) {
          const nextTimeoutMs = Math.min(currentTimeoutMs + extensionStepMs, maxTimeoutMs);
          if (nextTimeoutMs > currentTimeoutMs) {
            timeoutExtensionCount += 1;
            currentTimeoutMs = nextTimeoutMs;
            coworkLog('INFO', 'waitForVmReady', 'Extending VM ready timeout due to active serial boot output', {
              extensionCount: timeoutExtensionCount,
              currentTimeoutMs,
              maxTimeoutMs,
              elapsed,
              serialIdleMs,
            });
            continue;
          }
        }
      }

      break;
    }

    // Log final heartbeat state for diagnostics
    try {
      if (fs.existsSync(heartbeatPath)) {
        const content = fs.readFileSync(heartbeatPath, 'utf8');
        coworkLog('WARN', 'waitForVmReady', 'Timeout reached with heartbeat file present', {
          heartbeatContent: content.slice(0, 500),
          elapsed: Date.now() - start,
          timeoutMs: currentTimeoutMs,
          timeoutExtensionCount,
        });
      } else {
        coworkLog('WARN', 'waitForVmReady', 'Timeout reached with no heartbeat file', {
          elapsed: Date.now() - start,
          timeoutMs: currentTimeoutMs,
          timeoutExtensionCount,
          serialLogExists: fs.existsSync(serialLogPath),
          lastSerialActivityAgoMs: lastSerialActivityAt > 0 ? Date.now() - lastSerialActivityAt : null,
        });
      }
    } catch { /* ignore */ }

    console.error('VM failed to become ready within timeout');
    return false;
  }

  private async readSandboxStream(
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

  private addSystemMessage(sessionId: string, content: string): void {
    const session = this.store.getSession(sessionId);
    const lastMessage = session?.messages[session.messages.length - 1];
    if (
      lastMessage?.type === 'system'
      && lastMessage.content.trim() === content.trim()
    ) {
      return;
    }
    const message = this.store.addMessage(sessionId, {
      type: 'system',
      content,
    });
    this.emit('message', sessionId, message);
  }

  private findAttachmentsOutsideCwd(prompt: string, cwd: string): string[] {
    const attachments = this.parseAttachmentEntries(prompt);
    if (attachments.length === 0) {
      return [];
    }

    const resolvedCwd = path.resolve(cwd);
    const outside: string[] = [];
    for (const attachment of attachments) {
      const resolvedPath = this.resolveAttachmentPath(attachment.rawPath, resolvedCwd);
      const relative = path.relative(resolvedCwd, resolvedPath);
      if (relative.startsWith('..') || path.isAbsolute(relative)) {
        outside.push(attachment.rawPath);
      }
    }
    return outside;
  }

  private getMessageById(sessionId: string, messageId: string): CoworkMessage | undefined {
    const session = this.store.getSession(sessionId);
    return session?.messages.find((message) => message.id === messageId);
  }

  private extractText(value: unknown): string | null {
    if (typeof value === 'string') {
      return value;
    }

    if (Array.isArray(value)) {
      const parts = value
        .map((item) => {
          if (typeof item === 'string') return item;
          if (item && typeof item === 'object') {
            const record = item as Record<string, unknown>;
            if (typeof record.text === 'string') return record.text;
          }
          return '';
        })
        .filter(Boolean);
      return parts.length ? parts.join('') : null;
    }

    if (value && typeof value === 'object') {
      const record = value as Record<string, unknown>;
      if (typeof record.text === 'string') {
        return record.text;
      }
      if (record.content !== undefined) {
        return this.extractText(record.content);
      }
    }

    return null;
  }

  private handleError(sessionId: string, error: string): void {
    if (this.stoppedSessions.has(sessionId)) {
      return;
    }
    coworkLog('ERROR', 'CoworkRunner', `Session error: ${sessionId}`, { error });
    this.store.updateSession(sessionId, { status: 'error' });
    const message = this.store.addMessage(sessionId, {
      type: 'system',
      content: `Error: ${error}`,
      metadata: { error },
    });
    this.emit('message', sessionId, message);
    this.emit('error', sessionId, error);
  }

  isSessionActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  getSessionConfirmationMode(sessionId: string): 'modal' | 'text' | null {
    return this.activeSessions.get(sessionId)?.confirmationMode ?? null;
  }

  getActiveSessionIds(): string[] {
    return Array.from(this.activeSessions.keys());
  }

  stopAllSessions(): void {
    const sessionIds = this.getActiveSessionIds();
    for (const sessionId of sessionIds) {
      try {
        this.stopSession(sessionId);
      } catch (error) {
        console.error(`Failed to stop session ${sessionId}:`, error);
      }
    }
  }
}
