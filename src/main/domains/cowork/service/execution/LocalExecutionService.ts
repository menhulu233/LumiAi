// src/main/domains/cowork/service/execution/LocalExecutionService.ts

import { EventEmitter } from 'events';
import { type ChildProcessByStdio, spawn, spawnSync } from 'child_process';
import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import type { Readable } from 'stream';
import { v4 as uuidv4 } from 'uuid';
import type { PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import type { CoworkStore } from '../../store';
import type { CoworkExecutionMode } from '../../store';
import type { ActiveSession } from '../CoworkRunnerTypes';
import type { Result } from '../types/result';
import { handleClaudeEvent, finalizeStreamingContent } from '../coworkRunnerStream';
import { PermissionManager } from '../coworkRunnerPermission';
import { coworkLog, getCoworkLogPath } from '../coworkLogger';
import { getCurrentApiConfig, getClaudeCodePath } from '../claudeSettings';
import { loadClaudeSdk } from '../claudeSdk';
import { getEnhancedEnvWithTmpdir, getElectronNodeRuntimePath } from '../coworkUtil';
import {
  ensureWindowsChildProcessHideInitScript,
  prependNodeRequireArg,
} from '../coworkRunnerHelpers';
import { ensurePythonRuntimeReady, ensurePythonPipReady } from '../../../skill/service/pythonRuntime';
import { z } from 'zod';

const STDERR_TAIL_MAX_CHARS = 24_000;
const SDK_STARTUP_TIMEOUT_MS = 30_000;
const SDK_STARTUP_TIMEOUT_WITH_USER_MCP_MS = 120_000;
const STDERR_FATAL_PATTERNS: RegExp[] = [
  /authentication[_ ]error/i,
  /invalid[_ ]api[_ ]key/i,
  /unauthorized/i,
  /model[_ ]not[_ ]found/i,
  /connection[_ ]refused/i,
  /ECONNREFUSED/,
  /could not connect/i,
  /api[_ ]key[_ ]not[_ ]valid/i,
  /permission[_ ]denied/i,
  /access[_ ]denied/i,
  /rate[_ ]limit/i,
  /quota[_ ]exceeded/i,
  /billing/i,
  /overloaded/i,
];

const DELETE_TOOL_NAMES = new Set(['delete', 'remove', 'unlink', 'rmdir']);
const DELETE_COMMAND_RE = /\b(rm|rmdir|unlink|del|erase|remove-item)\b/i;
const FIND_DELETE_COMMAND_RE = /\bfind\b[\s\S]*\s-delete\b/i;
const GIT_CLEAN_COMMAND_RE = /\bgit\s+clean\b/i;
const PYTHON_BASH_COMMAND_RE = /(?:^|[^\w.-])(?:python(?:3)?|py(?:\.exe)?|pip(?:3)?)(?:\s+-3)?(?:\s|$)|\.py(?:\s|$)/i;
const PYTHON_PIP_BASH_COMMAND_RE = /(?:^|[^\w.-])(?:pip(?:3)?|python(?:3)?\s+-m\s+pip|py(?:\.exe)?\s+-m\s+pip)(?:\s|$)/i;

export interface LocalExecutionDependencies {
  store: CoworkStore;
  emit: (event: string, ...args: unknown[]) => void;
  permissionManager: PermissionManager;
  handleError: (sessionId: string, error: string) => void;
  isSessionStopRequested: (sessionId: string, activeSession?: ActiveSession) => boolean;
  applyTurnMemoryUpdatesForSession: (sessionId: string) => void;
  sanitizeToolPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  enforceToolSafetyPolicy: (
    sessionId: string,
    signal: AbortSignal,
    activeSession: ActiveSession,
    toolName: string,
    toolInput: Record<string, unknown>
  ) => Promise<PermissionResult | null>;
  extractToolCommand: (toolInput: Record<string, unknown>) => string;
  ensureWindowsPythonRuntimeForCommand: (sessionId: string, command: string) => Promise<{ ok: boolean; reason?: string }>;
  addSystemMessage: (sessionId: string, content: string) => void;
  waitForPermissionResponse: (sessionId: string, requestId: string, signal?: AbortSignal) => Promise<PermissionResult>;
  clearPendingPermissions: (sessionId: string) => void;
  runConversationSearchTool: (args: {
    query: string;
    max_results?: number;
    before?: string;
    after?: string;
  }) => string;
  runRecentChatsTool: (args: {
    n?: number;
    sort_order?: 'asc' | 'desc';
    before?: string;
    after?: string;
  }) => string;
  runMemoryUserEditsTool: (args: {
    action: 'list' | 'add' | 'update' | 'delete';
    id?: string;
    text?: string;
    confidence?: number;
    status?: 'created' | 'stale' | 'deleted';
    is_explicit?: boolean;
    limit?: number;
    query?: string;
  }) => { text: string; isError: boolean };
  formatMemoryUserEditsResult: (input: {
    action: 'list' | 'add' | 'update' | 'delete';
    successCount: number;
    failedCount: number;
    changedIds: string[];
    reason?: string;
    payload?: string;
  }) => string;
  truncateCommandPreview: (command: string, maxLength?: number) => string;
  isDeleteOperation: (toolName: string, toolInput: Record<string, unknown>) => boolean;
  requestSafetyApproval: (
    sessionId: string,
    signal: AbortSignal,
    activeSession: ActiveSession,
    question: string,
    requestedToolName: string,
    requestedToolInput: Record<string, unknown>
  ) => Promise<boolean>;
  stoppedSessions: Set<string>;
  activeSessions: Map<string, ActiveSession>;
  mcpServerProvider?: () => Array<{
    name: string;
    transportType: string;
    command?: string;
    args?: string[];
    env?: Record<string, string>;
    url?: string;
    headers?: Record<string, string>;
  }>;
}

export interface LocalExecutionParams {
  activeSession: ActiveSession;
  prompt: string;
  cwd: string;
  systemPrompt: string;
  imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
}

export interface ExecutionResult {
  claudeSessionId: string | null;
  eventCount: number;
}

export class LocalExecutionService {
  private deps: LocalExecutionDependencies;

  constructor(deps: LocalExecutionDependencies) {
    this.deps = deps;
  }

  async run(params: LocalExecutionParams): Promise<Result<ExecutionResult>> {
    const { activeSession, prompt, cwd, systemPrompt, imageAttachments } = params;
    const { sessionId, abortController } = activeSession;
    const config = this.deps.store.getConfig();

    if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
      this.deps.store.updateSession(sessionId, { status: 'idle' });
      this.deps.clearPendingPermissions(sessionId);
      this.deps.activeSessions.delete(sessionId);
      return { ok: true, data: { claudeSessionId: null, eventCount: 0 } };
    }

    // Reset per-turn output dedupe flags.
    activeSession.hasAssistantTextOutput = false;
    activeSession.hasAssistantThinkingOutput = false;
    activeSession.currentStreamingTextTruncated = false;
    activeSession.currentStreamingThinkingTruncated = false;
    activeSession.lastStreamingTextUpdateAt = 0;
    activeSession.lastStreamingThinkingUpdateAt = 0;

    const apiConfig = getCurrentApiConfig('local');
    if (!apiConfig) {
      this.deps.handleError(sessionId, 'API configuration not found. Please configure model settings.');
      this.deps.clearPendingPermissions(sessionId);
      this.deps.activeSessions.delete(sessionId);
      return {
        ok: false,
        error: new Error('API configuration not found'),
        canFallback: true
      };
    }
    coworkLog('INFO', 'runClaudeCodeLocal', 'Resolved API config', {
      apiType: apiConfig.apiType,
      baseURL: apiConfig.baseURL,
      model: apiConfig.model,
      hasApiKey: Boolean(apiConfig.apiKey),
    });

    const claudeCodePath = getClaudeCodePath();
    const envVars = await getEnhancedEnvWithTmpdir(cwd, 'local');
    const electronNodeRuntimePath = getElectronNodeRuntimePath();
    const windowsHideInitScript = ensureWindowsChildProcessHideInitScript();
    let stderrTail = '';

    // Log MCP-relevant environment for debugging
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: isPackaged=${app.isPackaged}, platform=${process.platform}, arch=${process.arch}`);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: LUMIAI_ELECTRON_PATH=${envVars.LUMIAI_ELECTRON_PATH || '(not set)'}`);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: ELECTRON_RUN_AS_NODE=${envVars.ELECTRON_RUN_AS_NODE || '(not set)'}`);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: NODE_PATH=${envVars.NODE_PATH || '(not set)'}`);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: HOME=${envVars.HOME || '(not set)'}`);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: TMPDIR=${envVars.TMPDIR || '(not set)'}`);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: LUMIAI_NPM_BIN_DIR=${envVars.LUMIAI_NPM_BIN_DIR || '(not set)'}`);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: claudeCodePath=${claudeCodePath}`);
    // Log full PATH split by delimiter
    const pathEntries = (envVars.PATH || '').split(path.delimiter);
    coworkLog('INFO', 'runClaudeCodeLocal', `MCP env: PATH has ${pathEntries.length} entries:`);
    for (let i = 0; i < pathEntries.length; i++) {
      coworkLog('INFO', 'runClaudeCodeLocal', `  PATH[${i}]: ${pathEntries[i]}`);
    }

    // When packaged, process.execPath is the Electron binary.
    // child_process.fork() uses process.execPath by default, so without
    // ELECTRON_RUN_AS_NODE the SDK would launch another Electron app instance
    // instead of running cli.js as a Node script, causing exit code 1.
    if (app.isPackaged) {
      envVars.ELECTRON_RUN_AS_NODE = '1';
    }

    // On Windows, check that git-bash is available before attempting to start.
    // Claude Code CLI requires git-bash for shell tool execution.
    if (process.platform === 'win32' && !envVars.CLAUDE_CODE_GIT_BASH_PATH) {
      const bashResolutionDiagnostic = typeof envVars.LUMIAI_GIT_BASH_RESOLUTION_ERROR === 'string'
        ? envVars.LUMIAI_GIT_BASH_RESOLUTION_ERROR.trim()
        : '';
      const errorMsg = 'Windows local execution requires a healthy Git Bash runtime, but no valid bash was resolved. '
        + 'This may be caused by missing bundled PortableGit or a conflicting system bash that cannot run cygpath. '
        + 'Please reinstall or upgrade to a correctly built version that includes resources/mingit. '
        + 'Advanced fallback: set CLAUDE_CODE_GIT_BASH_PATH to your bash.exe path '
        + '(e.g. C:\\Program Files\\Git\\bin\\bash.exe).'
        + (bashResolutionDiagnostic ? ` Resolver diagnostic: ${bashResolutionDiagnostic}` : '');
      coworkLog('ERROR', 'runClaudeCodeLocal', errorMsg);
      this.deps.handleError(sessionId, errorMsg);
      this.deps.clearPendingPermissions(sessionId);
      this.deps.activeSessions.delete(sessionId);
      return { ok: false, error: new Error(errorMsg) };
    }

    if (process.platform === 'win32') {
      coworkLog('INFO', 'runClaudeCodeLocal', 'Resolved Windows git-bash path', {
        gitBashPath: envVars.CLAUDE_CODE_GIT_BASH_PATH,
      });
    }

    const handleSdkStderr = (message: string): void => {
      stderrTail += message;
      if (stderrTail.length > STDERR_TAIL_MAX_CHARS) {
        stderrTail = stderrTail.slice(-STDERR_TAIL_MAX_CHARS);
      }
      coworkLog('WARN', 'ClaudeCodeProcess', 'stderr output', { stderr: message });

      // Detect fatal errors early and abort the session
      for (const pattern of STDERR_FATAL_PATTERNS) {
        if (pattern.test(message)) {
          coworkLog('ERROR', 'ClaudeCodeProcess', 'Fatal error detected in stderr, aborting', {
            pattern: pattern.toString(),
            stderr: message,
          });
          if (!abortController.signal.aborted) {
            abortController.abort();
          }
          break;
        }
      }
    };

    const options: Record<string, unknown> = {
      cwd,
      abortController,
      env: envVars,
      pathToClaudeCodeExecutable: claudeCodePath,
      permissionMode: 'default',
      includePartialMessages: true,
      disallowedTools: ['WebSearch', 'WebFetch'],
      stderr: handleSdkStderr,
      canUseTool: async (
        toolName: string,
        toolInput: unknown,
        { signal }: { signal: AbortSignal }
      ): Promise<PermissionResult> => {
        if (abortController.signal.aborted || signal.aborted) {
          return { behavior: 'deny', message: 'Session aborted' };
        }

        const resolvedName = String(toolName ?? 'unknown');
        const resolvedInput =
          toolInput && typeof toolInput === 'object'
            ? (toolInput as Record<string, unknown>)
            : { value: toolInput };

        if (resolvedName === 'Bash') {
          const command = this.deps.extractToolCommand(resolvedInput);
          const pythonRuntimeCheck = await this.deps.ensureWindowsPythonRuntimeForCommand(sessionId, command);
          if (!pythonRuntimeCheck.ok) {
            const reason = pythonRuntimeCheck.reason || 'Python runtime unavailable.';
            this.deps.addSystemMessage(sessionId, reason);
            return {
              behavior: 'deny',
              message: reason,
            };
          }
        }

        // Auto-approve mode (kept for compatibility with legacy callers).
        if (activeSession.autoApprove) {
          return { behavior: 'allow', updatedInput: resolvedInput };
        }

        if (resolvedName !== 'AskUserQuestion') {
          const policyResult = await this.deps.enforceToolSafetyPolicy(
            sessionId,
            signal,
            activeSession,
            resolvedName,
            resolvedInput
          );
          if (policyResult) {
            return policyResult;
          }
        }

        if (resolvedName !== 'AskUserQuestion') {
          return { behavior: 'allow', updatedInput: resolvedInput };
        }

        const request: { requestId: string; toolName: string; toolInput: Record<string, unknown> } = {
          requestId: uuidv4(),
          toolName: resolvedName,
          toolInput: this.deps.sanitizeToolPayload(resolvedInput) as Record<string, unknown>,
        };

        activeSession.pendingPermission = request;
        this.deps.emit('permissionRequest', sessionId, request);

        const result = await this.deps.waitForPermissionResponse(sessionId, request.requestId, signal);
        if (abortController.signal.aborted || signal.aborted) {
          return { behavior: 'deny', message: 'Session aborted' };
        }

        if (result.behavior === 'deny') {
          return result.message
            ? result
            : { behavior: 'deny', message: 'Permission denied' };
        }

        const updatedInput = result.updatedInput ?? resolvedInput;
        const hasAnswers = updatedInput && typeof updatedInput === 'object' && 'answers' in updatedInput;
        if (!hasAnswers) {
          return { behavior: 'deny', message: 'No answers provided' };
        }

        return { behavior: 'allow', updatedInput };
      },
    };

    if (app.isPackaged) {
      // The SDK's default ProcessTransport uses child_process.fork() and may
      // relaunch the Electron app binary on some macOS installs. Override the
      // process spawner to force Node-mode execution via Electron directly.
      options.spawnClaudeCodeProcess = (spawnOptions: {
        command: string;
        args: string[];
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        signal?: AbortSignal;
      }) => {
        const isPackagedDarwin = app.isPackaged && process.platform === 'darwin';
        const useElectronShim =
          process.platform === 'win32'
          || isPackagedDarwin
          || spawnOptions.env?.LUMIAI_NODE_SHIM_ACTIVE === '1';
        const spawnEnv: NodeJS.ProcessEnv = {
          ...(spawnOptions.env ?? {}),
          ELECTRON_RUN_AS_NODE: '1',
        };
        if (useElectronShim) {
          spawnEnv.LUMIAI_ELECTRON_PATH = spawnOptions.env?.LUMIAI_ELECTRON_PATH || electronNodeRuntimePath;
        } else {
          delete spawnEnv.LUMIAI_ELECTRON_PATH;
        }

        let command = spawnOptions.command || 'node';
        const normalizedCommand = command.trim().toLowerCase();
        const commandBaseName = path.basename(command).toLowerCase();
        const isNodeLikeCommand = normalizedCommand === 'node'
          || normalizedCommand === 'node.exe'
          || commandBaseName === 'node'
          || commandBaseName === 'node.exe'
          || commandBaseName === 'node.cmd'
          || normalizedCommand.endsWith('\\node.cmd')
          || normalizedCommand.endsWith('/node.cmd');
        if (process.platform === 'win32' && isNodeLikeCommand) {
          command = electronNodeRuntimePath;
          spawnEnv.LUMIAI_ELECTRON_PATH = electronNodeRuntimePath;
          coworkLog('INFO', 'runClaudeCodeLocal', `Rewrote Windows SDK command "${spawnOptions.command || 'node'}" to Electron runtime: ${electronNodeRuntimePath}`);
        } else if (isPackagedDarwin && isNodeLikeCommand) {
          command = electronNodeRuntimePath;
          spawnEnv.LUMIAI_ELECTRON_PATH = electronNodeRuntimePath;
          coworkLog('INFO', 'runClaudeCodeLocal', `Rewrote packaged macOS SDK command "${spawnOptions.command || 'node'}" to Electron helper runtime: ${electronNodeRuntimePath}`);
        }

        if (isPackagedDarwin && command && path.isAbsolute(command)) {
          const commandCandidates = new Set<string>([command, path.resolve(command)]);
          const appExecCandidates = new Set<string>([process.execPath, path.resolve(process.execPath)]);
          try {
            commandCandidates.add(fs.realpathSync.native(command));
          } catch {
            // Ignore realpath resolution errors.
          }
          try {
            appExecCandidates.add(fs.realpathSync.native(process.execPath));
          } catch {
            // Ignore realpath resolution errors.
          }
          const pointsToAppExecutable = Array.from(commandCandidates).some((candidate) => appExecCandidates.has(candidate));
          if (pointsToAppExecutable) {
            command = electronNodeRuntimePath;
            spawnEnv.LUMIAI_ELECTRON_PATH = electronNodeRuntimePath;
            coworkLog('WARN', 'runClaudeCodeLocal', 'SDK spawner command points to app executable; rewriting to Electron helper runtime');
          }
        }
        coworkLog('INFO', 'runClaudeCodeLocal', 'Using packaged custom SDK spawner', {
          command,
          args: spawnOptions.args,
        });

        const shouldInjectWindowsHideRequire =
          process.platform === 'win32'
          && Boolean(windowsHideInitScript)
          && spawnOptions.args.length > 0
          && /\.m?js$/i.test(path.basename(spawnOptions.args[0]));
        const effectiveSpawnArgs = shouldInjectWindowsHideRequire
          ? prependNodeRequireArg(spawnOptions.args, windowsHideInitScript as string)
          : spawnOptions.args;
        if (shouldInjectWindowsHideRequire) {
          coworkLog('INFO', 'runClaudeCodeLocal', `Injected Windows hidden-subprocess preload: ${windowsHideInitScript}`);
        }

        const child = spawn(command, effectiveSpawnArgs, {
          cwd: spawnOptions.cwd,
          env: spawnEnv,
          stdio: ['pipe', 'pipe', 'pipe'],
          windowsHide: process.platform === 'win32',
          signal: spawnOptions.signal,
        });

        child.stderr?.on('data', (chunk: Buffer | string) => {
          handleSdkStderr(chunk.toString());
        });

        return child;
      };
    }

    // The SDK session state is bound to the subprocess and its project directory.
    // After stop, the subprocess is killed and the session cannot be reliably
    // resumed (cwd/model mismatch causes "No conversation found" errors).
    // Instead, we inject conversation history into the prompt in startSession().
    activeSession.claudeSessionId = null;

    if (systemPrompt) {
      options.systemPrompt = systemPrompt;
    }

    let startupTimer: ReturnType<typeof setTimeout> | null = null;

    try {
      coworkLog('INFO', 'runClaudeCodeLocal', 'Starting local Claude Code session', {
        sessionId,
        cwd,
        claudeCodePath,
        claudeCodePathExists: fs.existsSync(claudeCodePath),
        isPackaged: app.isPackaged,
        resourcesPath: process.resourcesPath,
        processExecPath: process.execPath,
        platform: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        ANTHROPIC_BASE_URL: envVars.ANTHROPIC_BASE_URL,
        ANTHROPIC_MODEL: envVars.ANTHROPIC_MODEL,
        NODE_PATH: envVars.NODE_PATH,
        logFile: getCoworkLogPath(),
      });

      const { query, createSdkMcpServer, tool } = await loadClaudeSdk();
      coworkLog('INFO', 'runClaudeCodeLocal', 'Claude SDK loaded successfully');

      const memoryServerName = `user-memory-${sessionId.slice(0, 8)}`;
      const memoryTools: any[] = [
        tool(
          'conversation_search',
          'Search prior conversations by query and return Claude-style <chat> blocks.',
          {
            query: z.string().min(1),
            max_results: z.number().int().min(1).max(10).optional(),
            before: z.string().optional(),
            after: z.string().optional(),
          },
          async (args: {
            query: string;
            max_results?: number;
            before?: string;
            after?: string;
          }) => {
            const text = this.deps.runConversationSearchTool(args);
            return {
              content: [
                {
                  type: 'text',
                  text,
                },
              ],
            } as any;
          }
        ),
        tool(
          'recent_chats',
          'List recent chats and return Claude-style <chat> blocks.',
          {
            n: z.number().int().min(1).max(20).optional(),
            sort_order: z.enum(['asc', 'desc']).optional(),
            before: z.string().optional(),
            after: z.string().optional(),
          },
          async (args: {
            n?: number;
            sort_order?: 'asc' | 'desc';
            before?: string;
            after?: string;
          }) => {
            const text = this.deps.runRecentChatsTool(args);
            return {
              content: [{ type: 'text', text }],
            } as any;
          }
        ),
      ];
      if (config.memoryEnabled) {
        memoryTools.push(
          tool(
            'memory_user_edits',
            'Manage user memories. action=list|add|update|delete.',
            {
              action: z.enum(['list', 'add', 'update', 'delete']),
              id: z.string().optional(),
              text: z.string().optional(),
              confidence: z.number().min(0).max(1).optional(),
              status: z.enum(['created', 'stale', 'deleted']).optional(),
              is_explicit: z.boolean().optional(),
              limit: z.number().int().min(1).max(200).optional(),
              query: z.string().optional(),
            },
            async (args: {
              action: 'list' | 'add' | 'update' | 'delete';
              id?: string;
              text?: string;
              confidence?: number;
              status?: 'created' | 'stale' | 'deleted';
              is_explicit?: boolean;
              limit?: number;
              query?: string;
            }) => {
              try {
                const result = this.deps.runMemoryUserEditsTool(args);
                return {
                  content: [{
                    type: 'text',
                    text: result.text,
                  }],
                  isError: result.isError,
                } as any;
              } catch (error) {
                return {
                  content: [{
                    type: 'text',
                    text: this.deps.formatMemoryUserEditsResult({
                      action: args.action,
                      successCount: 0,
                      failedCount: 1,
                      changedIds: [],
                      reason: error instanceof Error ? error.message : String(error),
                    }),
                  }],
                  isError: true,
                } as any;
              }
            }
          )
        );
      }
      options.mcpServers = {
        ...(options.mcpServers as Record<string, unknown> | undefined),
        [memoryServerName]: createSdkMcpServer({
          name: memoryServerName,
          tools: memoryTools,
        }),
      };
      let userMcpServerCount = 0;

      // Inject user-configured MCP servers (local mode only)
      if (this.deps.mcpServerProvider) {
        try {
          const enabledMcpServers = this.deps.mcpServerProvider();
          coworkLog('INFO', 'runClaudeCodeLocal', `MCP: ${enabledMcpServers.length} user-configured servers found`);
          for (const server of enabledMcpServers) {
            const serverKey = server.name;
            // Skip if name conflicts with existing MCP servers (e.g., memory server)
            if (options.mcpServers && serverKey in (options.mcpServers as Record<string, unknown>)) {
              coworkLog('WARN', 'runClaudeCodeLocal', `MCP server name conflict: "${serverKey}", skipping user config`);
              continue;
            }
            let serverConfig: Record<string, unknown>;
            switch (server.transportType) {
              case 'stdio':
                {
                  const stdioCommand = server.command || '';
                  let effectiveStdioCommand = stdioCommand;
                  const stdioArgs = server.args || [];
                  let effectiveStdioArgs = [...stdioArgs];
                  let shouldInjectWindowsHideRequire = false;
                  let stdioEnv = server.env && Object.keys(server.env).length > 0
                    ? { ...server.env }
                    : undefined;

                  if (process.platform === 'win32' && app.isPackaged && effectiveStdioCommand) {
                    const normalizedCommand = effectiveStdioCommand.trim().toLowerCase();
                    const npmbinDir = envVars.LUMIAI_NPM_BIN_DIR;
                    const npxCliJs = npmbinDir ? path.join(npmbinDir, 'npx-cli.js') : '';
                    const npmCliJs = npmbinDir ? path.join(npmbinDir, 'npm-cli.js') : '';

                    const withElectronNodeEnv = (base: Record<string, string> | undefined): Record<string, string> => ({
                      ...(base || {}),
                      ELECTRON_RUN_AS_NODE: '1',
                      LUMIAI_ELECTRON_PATH: electronNodeRuntimePath,
                    });

                    if (
                      normalizedCommand === 'node'
                      || normalizedCommand === 'node.exe'
                      || normalizedCommand.endsWith('\\node.cmd')
                      || normalizedCommand.endsWith('/node.cmd')
                    ) {
                      effectiveStdioCommand = electronNodeRuntimePath;
                      stdioEnv = withElectronNodeEnv(stdioEnv);
                      shouldInjectWindowsHideRequire = true;
                      coworkLog('INFO', 'runClaudeCodeLocal', `MCP "${serverKey}": rewrote stdio command "${stdioCommand}" to Electron runtime`);
                    } else if (
                      (normalizedCommand === 'npx' || normalizedCommand === 'npx.cmd' || normalizedCommand.endsWith('\\npx.cmd') || normalizedCommand.endsWith('/npx.cmd'))
                      && npxCliJs
                      && fs.existsSync(npxCliJs)
                    ) {
                      effectiveStdioCommand = electronNodeRuntimePath;
                      effectiveStdioArgs = [npxCliJs, ...stdioArgs];
                      stdioEnv = withElectronNodeEnv(stdioEnv);
                      shouldInjectWindowsHideRequire = true;
                      coworkLog('INFO', 'runClaudeCodeLocal', `MCP "${serverKey}": rewrote stdio command "${stdioCommand}" to Electron runtime + npx-cli.js`);
                    } else if (
                      (normalizedCommand === 'npm' || normalizedCommand === 'npm.cmd' || normalizedCommand.endsWith('\\npm.cmd') || normalizedCommand.endsWith('/npm.cmd'))
                      && npmCliJs
                      && fs.existsSync(npmCliJs)
                    ) {
                      effectiveStdioCommand = electronNodeRuntimePath;
                      effectiveStdioArgs = [npmCliJs, ...stdioArgs];
                      stdioEnv = withElectronNodeEnv(stdioEnv);
                      shouldInjectWindowsHideRequire = true;
                      coworkLog('INFO', 'runClaudeCodeLocal', `MCP "${serverKey}": rewrote stdio command "${stdioCommand}" to Electron runtime + npm-cli.js`);
                    }
                  }

                  if (process.platform === 'win32' && shouldInjectWindowsHideRequire && windowsHideInitScript) {
                    effectiveStdioArgs = prependNodeRequireArg(effectiveStdioArgs, windowsHideInitScript);
                    coworkLog('INFO', 'runClaudeCodeLocal', `MCP "${serverKey}": injected Windows hidden-subprocess preload`);
                  }

                  if (app.isPackaged && process.platform === 'darwin' && stdioCommand && path.isAbsolute(stdioCommand)) {
                    const commandCandidates = new Set<string>([stdioCommand, path.resolve(stdioCommand)]);
                    const appExecCandidates = new Set<string>([
                      process.execPath,
                      path.resolve(process.execPath),
                      electronNodeRuntimePath,
                      path.resolve(electronNodeRuntimePath),
                    ]);

                    try {
                      commandCandidates.add(fs.realpathSync.native(stdioCommand));
                    } catch {
                      // Ignore realpath resolution errors.
                    }

                    try {
                      appExecCandidates.add(fs.realpathSync.native(process.execPath));
                    } catch {
                      // Ignore realpath resolution errors.
                    }
                    try {
                      appExecCandidates.add(fs.realpathSync.native(electronNodeRuntimePath));
                    } catch {
                      // Ignore realpath resolution errors.
                    }

                    const pointsToAppExecutable = Array.from(commandCandidates).some((candidate) => appExecCandidates.has(candidate));
                    if (pointsToAppExecutable) {
                      effectiveStdioCommand = electronNodeRuntimePath;
                      stdioEnv = {
                        ...(stdioEnv || {}),
                        ELECTRON_RUN_AS_NODE: '1',
                        LUMIAI_ELECTRON_PATH: electronNodeRuntimePath,
                      };
                      coworkLog('WARN', 'runClaudeCodeLocal', `MCP "${serverKey}": command points to app executable; rewriting command to Electron helper runtime`);
                    }
                  }

                serverConfig = {
                  type: 'stdio',
                  command: effectiveStdioCommand,
                  args: effectiveStdioArgs,
                  env: stdioEnv && Object.keys(stdioEnv).length > 0 ? stdioEnv : undefined,
                };
                coworkLog('INFO', 'runClaudeCodeLocal', `MCP "${serverKey}": stdio command="${effectiveStdioCommand}", args=${JSON.stringify(effectiveStdioArgs)}`);
                if (stdioEnv && Object.keys(stdioEnv).length > 0) {
                  coworkLog('INFO', 'runClaudeCodeLocal', `MCP "${serverKey}": custom env vars: ${JSON.stringify(stdioEnv)}`);
                }
                // Resolve command path to verify it's findable
                if (effectiveStdioCommand) {
                  if (path.isAbsolute(effectiveStdioCommand)) {
                    coworkLog(
                      fs.existsSync(effectiveStdioCommand) ? 'INFO' : 'WARN',
                      'runClaudeCodeLocal',
                      `MCP "${serverKey}": absolute command "${effectiveStdioCommand}" exists=${fs.existsSync(effectiveStdioCommand)}`
                    );
                  } else {
                    const whichCmd = process.platform === 'win32' ? 'where' : 'which';
                    try {
                      const resolveResult = spawnSync(whichCmd, [effectiveStdioCommand], {
                        env: { ...envVars, ...(stdioEnv || {}) } as NodeJS.ProcessEnv,
                        encoding: 'utf-8',
                        timeout: 5000,
                        windowsHide: process.platform === 'win32',
                      });
                      if (resolveResult.status === 0 && resolveResult.stdout) {
                        coworkLog('INFO', 'runClaudeCodeLocal', `MCP "${serverKey}": command "${effectiveStdioCommand}" resolves to: ${resolveResult.stdout.trim()}`);
                      } else {
                        coworkLog('WARN', 'runClaudeCodeLocal', `MCP "${serverKey}": command "${effectiveStdioCommand}" NOT FOUND in PATH (exit: ${resolveResult.status}, stderr: ${(resolveResult.stderr || '').trim()})`);
                      }
                    } catch (e) {
                      coworkLog('WARN', 'runClaudeCodeLocal', `MCP "${serverKey}": failed to resolve command "${effectiveStdioCommand}": ${e instanceof Error ? e.message : String(e)}`);
                    }
                  }
                }
                break;
                }
              case 'sse':
                serverConfig = {
                  type: 'sse',
                  url: server.url || '',
                  headers: server.headers && Object.keys(server.headers).length > 0 ? server.headers : undefined,
                };
                break;
              case 'http':
                serverConfig = {
                  type: 'http',
                  url: server.url || '',
                  headers: server.headers && Object.keys(server.headers).length > 0 ? server.headers : undefined,
                };
                break;
              default:
                coworkLog('WARN', 'runClaudeCodeLocal', `Unknown MCP transport type: "${server.transportType}", skipping`);
                continue;
            }
            options.mcpServers = {
              ...(options.mcpServers as Record<string, unknown>),
              [serverKey]: serverConfig,
            };
            userMcpServerCount += 1;
            coworkLog('INFO', 'runClaudeCodeLocal', `Injected user MCP server: "${serverKey}" (${server.transportType})`);
          }
        } catch (error) {
          coworkLog('WARN', 'runClaudeCodeLocal', `Failed to load user MCP servers: ${error instanceof Error ? error.message : String(error)}`);
        }
      }

      // Log final MCP server config summary
      if (options.mcpServers) {
        const mcpKeys = Object.keys(options.mcpServers as Record<string, unknown>);
        coworkLog('INFO', 'runClaudeCodeLocal', `MCP final config: ${mcpKeys.length} servers: [${mcpKeys.join(', ')}]`);
        for (const key of mcpKeys) {
          const cfg = (options.mcpServers as Record<string, Record<string, unknown>>)[key];
          if (cfg && typeof cfg === 'object' && 'type' in cfg) {
            coworkLog('INFO', 'runClaudeCodeLocal', `MCP server "${key}": type=${cfg.type}, command=${cfg.command || 'N/A'}, args=${JSON.stringify(cfg.args || [])}`);
          }
        }
        // Dump full MCP config as JSON for complete debugging
        try {
          const serializable: Record<string, unknown> = {};
          for (const key of mcpKeys) {
            const cfg = (options.mcpServers as Record<string, Record<string, unknown>>)[key];
            if (cfg && typeof cfg === 'object') {
              // Only serialize plain config objects; skip SDK server instances
              if ('type' in cfg && typeof cfg.type === 'string') {
                serializable[key] = cfg;
              } else {
                serializable[key] = { type: '(SDK server instance)' };
              }
            }
          }
          coworkLog('INFO', 'runClaudeCodeLocal', `MCP full config dump: ${JSON.stringify(serializable, null, 2)}`);
        } catch (e) {
          coworkLog('WARN', 'runClaudeCodeLocal', `MCP config dump failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      // Build prompt: if we have image attachments, use SDKUserMessage with content blocks
      // instead of a plain string prompt, so the model can see the images.
      let queryPrompt: string | AsyncIterable<unknown>;
      if (imageAttachments && imageAttachments.length > 0) {
        const contentBlocks: Array<Record<string, unknown>> = [];
        // Add text block
        if (prompt.trim()) {
          contentBlocks.push({ type: 'text', text: prompt });
        }
        // Add image blocks
        for (const img of imageAttachments) {
          contentBlocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: img.mimeType,
              data: img.base64Data,
            },
          });
        }
        const userMessage: {
          type: 'user';
          message: { role: 'user'; content: Array<Record<string, unknown>> };
          parent_tool_use_id: string | null;
          session_id: string;
        } = {
          type: 'user' as const,
          message: {
            role: 'user' as const,
            content: contentBlocks,
          },
          parent_tool_use_id: null,
          session_id: '',
        };
        // Create a one-shot async iterable that yields the single message
        queryPrompt = (async function* () {
          yield userMessage;
        })();
      } else {
        queryPrompt = prompt;
      }

      // Set up a startup timeout BEFORE calling query(): if no events arrive
      // within the timeout, abort. This covers both the query() call itself
      // (which spawns the subprocess) and the initial event wait.
      const startupTimeoutMs = userMcpServerCount > 0
        ? SDK_STARTUP_TIMEOUT_WITH_USER_MCP_MS
        : SDK_STARTUP_TIMEOUT_MS;
      coworkLog('INFO', 'runClaudeCodeLocal', `Using SDK startup timeout: ${startupTimeoutMs}ms (userMcpServers=${userMcpServerCount})`);
      startupTimer = setTimeout(() => {
        coworkLog('ERROR', 'runClaudeCodeLocal', 'SDK startup timeout: no events received within timeout', {
          timeoutMs: startupTimeoutMs,
          userMcpServers: userMcpServerCount,
        });
        if (!abortController.signal.aborted) {
          abortController.abort();
        }
      }, startupTimeoutMs);

      const result = await query({ prompt: queryPrompt, options } as any);
      coworkLog('INFO', 'runClaudeCodeLocal', 'Claude Code process started, iterating events');
      let eventCount = 0;

      for await (const event of result as AsyncIterable<unknown>) {
        // Clear startup timeout on first event
        if (startupTimer) {
          clearTimeout(startupTimer);
          startupTimer = null;
        }
        if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
          break;
        }
        eventCount++;
        const eventPayload = event as Record<string, unknown> | null;
        const eventType = eventPayload && typeof eventPayload === 'object' ? String(eventPayload.type ?? '') : typeof event;
        coworkLog('INFO', 'runClaudeCodeLocal', `Event #${eventCount}: type=${eventType}`);
        handleClaudeEvent(sessionId, event, activeSession, {
          store: this.deps.store,
          emit: this.deps.emit.bind(this),
          permissionManager: this.deps.permissionManager,
          handleError: this.deps.handleError.bind(this),
          isSessionStopRequested: this.deps.isSessionStopRequested.bind(this),
          applyTurnMemoryUpdatesForSession: this.deps.applyTurnMemoryUpdatesForSession.bind(this),
        });
      }
      // Clean up timer if loop ended before first event (e.g. empty iterator)
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }
      coworkLog('INFO', 'runClaudeCodeLocal', `Event iteration completed, total events: ${eventCount}`);

      if (this.deps.stoppedSessions.has(sessionId)) {
        this.deps.store.updateSession(sessionId, { status: 'idle' });
        return { ok: true, data: { claudeSessionId: activeSession.claudeSessionId, eventCount } };
      }

      // Ensure any remaining streaming content is saved to database
      finalizeStreamingContent(activeSession, this.deps.store, this.deps.emit.bind(this));

      const session = this.deps.store.getSession(sessionId);
      if (session?.status !== 'error') {
        this.deps.store.updateSession(sessionId, { status: 'completed' });
        this.deps.applyTurnMemoryUpdatesForSession(sessionId);
        this.deps.emit('complete', sessionId, activeSession.claudeSessionId);
      }

      return { ok: true, data: { claudeSessionId: activeSession.claudeSessionId, eventCount } };
    } catch (error) {
      // Clean up startup timer if still pending
      if (startupTimer) {
        clearTimeout(startupTimer);
        startupTimer = null;
      }

      if (this.deps.stoppedSessions.has(sessionId)) {
        this.deps.store.updateSession(sessionId, { status: 'idle' });
        return { ok: true, data: { claudeSessionId: activeSession.claudeSessionId, eventCount: 0 } };
      }

      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      const stderrOutput = stderrTail;
      coworkLog('ERROR', 'runClaudeCodeLocal', 'Claude Code process failed', {
        errorMessage,
        errorStack: error instanceof Error ? error.stack : undefined,
        stderr: stderrOutput || '(no stderr captured)',
        claudeCodePath,
        claudeCodePathExists: fs.existsSync(claudeCodePath),
      });

      const detailedError = stderrOutput
        ? `${errorMessage}\n\nProcess stderr:\n${stderrOutput.slice(-2000)}\n\nLog file: ${getCoworkLogPath()}`
        : `${errorMessage}\n\nLog file: ${getCoworkLogPath()}`;
      this.deps.handleError(sessionId, detailedError);
      return { ok: false, error: error instanceof Error ? error : new Error(errorMessage) };
    } finally {
      this.deps.clearPendingPermissions(sessionId);
      this.deps.activeSessions.delete(sessionId);
    }
  }
}
