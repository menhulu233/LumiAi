// src/main/domains/cowork/service/execution/SandboxExecutionService.ts

import path from 'path';
import fs from 'fs';
import type { ChildProcessByStdio } from 'child_process';
import type { Readable } from 'stream';
import type { CoworkStore } from '../../store';
import type { ActiveSession, PermissionRequest } from '../CoworkRunnerTypes';
import type { SandboxRuntimeInfo } from '../coworkSandboxRuntime';
import type { Result } from '../types/result';
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
} from '../coworkVmRunner';
import { handleClaudeEvent, finalizeStreamingContent } from '../coworkRunnerStream';
import {
  getCurrentApiConfig,
} from '../claudeSettings';
import { getEnhancedEnv } from '../coworkUtil';
import {
  extractHostFromUrl,
  mergeNoProxyList,
  escapeXml,
  formatSandboxSpawnError,
} from '../coworkRunnerHelpers';
import { coworkLog } from '../coworkLogger';
import {
  collectHostSkillsRoots,
  resolveSandboxSkillsConfig,
  enforceSandboxWorkspacePrompt,
  resolveAutoRoutingForSandbox,
} from './sandboxSkills';
import { readSandboxStream, writeSandboxHostToolResponse } from './sandboxStream';
import { waitForVmReady } from './sandboxLifecycle';

export const SANDBOX_ATTACHMENT_DIR = path.join('.cowork-temp', 'attachments');

const SANDBOX_SKILLS_MOUNT_TAG = 'skills';
const SANDBOX_SKILLS_GUEST_PATH = '/workspace/skills';
const SANDBOX_SKILLS_GUEST_PATH_WINDOWS = '/workspace/project/skills';
const SANDBOX_WORKSPACE_GUEST_ROOT = '/workspace/project';
const SANDBOX_WORKSPACE_LEGACY_ROOT = '/workspace';
const SANDBOX_HISTORY_MAX_MESSAGES = 18;
const SANDBOX_HISTORY_MAX_TOTAL_CHARS = 24000;
const SANDBOX_HISTORY_MAX_MESSAGE_CHARS = 3000;

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

export interface SandboxSkillRootMount {
  hostRoot: string;
  guestRoot: string;
  mountTag: string;
}

export interface SandboxSkillEntry {
  skillId: string;
  hostPath: string;
  guestPath: string;
  mountTag: string;
}

export interface SandboxExecutionDependencies {
  store: CoworkStore;
  emit: (event: string, ...args: unknown[]) => void;
  permissionManager: any;
  handleError: (sessionId: string, error: string) => void;
  isSessionStopRequested: (sessionId: string, activeSession: ActiveSession) => boolean;
  applyTurnMemoryUpdatesForSession: (sessionId: string) => Promise<void>;
  hostToolExecutor: (payload: Record<string, unknown>) => { success: boolean; text: string };
  sanitizeToolPayload: (payload: Record<string, unknown>) => Record<string, unknown>;
  clearSandboxPermissions: (sessionId: string) => void;
  clearPendingPermissions: (sessionId: string) => void;
  addSystemMessage: (sessionId: string, content: string) => void;
  permissionManagerGetConfig: () => { memoryEnabled: boolean };
}

export interface SandboxExecutionParams {
  activeSession: ActiveSession;
  prompt: string;
  cwd: string;
  systemPrompt: string;
  runtimeInfo: SandboxRuntimeInfo;
  imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>;
}

export class SandboxExecutionService {
  private deps: SandboxExecutionDependencies;

  constructor(deps: SandboxExecutionDependencies) {
    this.deps = deps;
  }

  getSandboxUnavailableFallbackNotice(errorMessage: string): string {
    if (this.deps.store.getAppLanguage() === 'en') {
      return `Sandbox VM is unavailable. Falling back to local execution. (${errorMessage})`;
    }
    return `沙箱 VM 当前不可用，已回退为本地执行。（${errorMessage}）`;
  }

  async run(params: SandboxExecutionParams): Promise<void> {
    const { activeSession, prompt, cwd, systemPrompt, runtimeInfo, imageAttachments } = params;
    const { sessionId, abortController } = activeSession;

    if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
      this.deps.store.updateSession(sessionId, { status: 'idle' });
      this.deps.clearPendingPermissions(sessionId);
      // Note: activeSessions.delete is done by caller
      return;
    }

    const apiConfig = getCurrentApiConfig('sandbox');
    if (!apiConfig) {
      this.deps.handleError(sessionId, 'API configuration not found. Please configure model settings.');
      this.deps.clearPendingPermissions(sessionId);
      return;
    }

    const paths = ensureCoworkSandboxDirs(sessionId);
    const cwdMapping = resolveSandboxCwd(cwd);
    const env = await getEnhancedEnv('sandbox');
    const hostSkillsRoots = collectHostSkillsRoots(env, cwdMapping, systemPrompt);
    const sandboxSkills = resolveSandboxSkillsConfig(hostSkillsRoots, runtimeInfo.platform);
    const sandboxEnv = this.buildSandboxEnv(env, sandboxSkills.guestSkillsRoot);
    coworkLog('INFO', 'runSandbox', 'Resolved sandbox API endpoint', {
      sessionId,
      anthropicBaseUrl: this.summarizeEndpointForLog(sandboxEnv.ANTHROPIC_BASE_URL),
      anthropicModel: sandboxEnv.ANTHROPIC_MODEL ?? null,
      httpProxy: this.summarizeEndpointForLog(sandboxEnv.HTTP_PROXY ?? sandboxEnv.http_proxy),
      noProxy: sandboxEnv.NO_PROXY ?? sandboxEnv.no_proxy ?? null,
      directHostRouting: !(sandboxEnv.HTTP_PROXY || sandboxEnv.http_proxy),
    });
    const sandboxSystemPrompt = enforceSandboxWorkspacePrompt(systemPrompt, cwdMapping.guestPath);
    const resolvedSystemPrompt = resolveAutoRoutingForSandbox(sandboxSystemPrompt, {
      guestSkillsRoot: sandboxSkills.guestSkillsRoot,
      hostSkillsRoots: hostSkillsRoots,
      hostSkillsRootMounts: sandboxSkills.rootMounts,
    });
    activeSession.sandboxSkillsGuestPath = sandboxSkills.guestSkillsRoot ?? undefined;
    activeSession.sandboxSkillMounts = Object.keys(sandboxSkills.skillMounts).length > 0
      ? sandboxSkills.skillMounts
      : undefined;
    activeSession.sandboxSkillRootMounts = sandboxSkills.rootMounts.length > 0
      ? sandboxSkills.rootMounts
      : undefined;

    const mounts: Record<string, { tag: string; guestPath: string }> = {
      work: {
        tag: cwdMapping.mountTag,
        guestPath: cwdMapping.guestPath,
      },
      ipc: {
        tag: 'ipc',
        guestPath: '/workspace/ipc',
      },
      ...sandboxSkills.skillMounts,
    };

    const input: Record<string, unknown> = {
      prompt,
      cwd: cwdMapping.guestPath,
      workspaceRoot: cwdMapping.guestPath,
      hostWorkspaceRoot: cwdMapping.hostPath,
      memoryEnabled: this.deps.permissionManagerGetConfig().memoryEnabled,
      autoApprove: Boolean(activeSession.autoApprove),
      confirmationMode: activeSession.confirmationMode,
      env: sandboxEnv,
      mounts,
    };

    if (imageAttachments && imageAttachments.length > 0) {
      input.imageAttachments = imageAttachments;
    }

    // NOTE: Do NOT pass activeSession.claudeSessionId here.  This method always
    // starts a fresh VM, so any previous SDK session ID (e.g. from a prior app
    // run stored in the DB) is unreachable by the new VM process.  Continuation
    // within the same running VM is handled by continueSandboxTurn() instead.
    // Clear the stale value so the new SDK session's ID will replace it.
    activeSession.claudeSessionId = null;

    if (resolvedSystemPrompt) {
      input.systemPrompt = resolvedSystemPrompt;
    }

    let currentChild: ChildProcessByStdio<null, Readable, Readable> | undefined;

    const isHvfDenied = (message: string) => message.includes('HV_DENIED');
    const isWhpxFailed = (message: string) =>
      /WHPX|whpx/.test(message) && /fail|error|not.*support|unavailable/i.test(message);
    const isMemoryAllocationFailed = (message: string) =>
      message.includes('cannot set up guest memory');

    const runOnce = async (
      accelOverride?: string | null,
      launcherOverride?: 'direct' | 'launchctl',
      memoryMb?: number,
    ): Promise<{ status: 'ok' } | { status: 'error'; message: string; hvfDenied: boolean; memoryFailed: boolean }> => {
      if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
        this.deps.store.updateSession(sessionId, { status: 'idle' });
        return { status: 'ok' };
      }
      const startTime = Date.now();
      const accelMode = accelOverride ?? (process.platform === 'darwin' ? 'hvf' : process.platform === 'win32' ? 'whpx' : 'default');
      console.log(`Starting sandbox VM with acceleration: ${accelMode}, launcher: ${launcherOverride ?? 'direct'}, memory: ${memoryMb ?? 4096}MB`);

      // Remove stale serial.log from previous attempt to avoid Windows file-lock conflicts
      const serialLogPath = path.join(paths.ipcDir, 'serial.log');
      try {
        fs.unlinkSync(serialLogPath);
        coworkLog('INFO', 'runSandbox', 'Removed stale serial.log');
      } catch (e) {
        // File may not exist (first attempt) or still locked (process not yet exited)
        const code = e && typeof e === 'object' && 'code' in e ? (e as { code: string }).code : '';
        if (code && code !== 'ENOENT') {
          coworkLog('WARN', 'runSandbox', `Failed to remove serial.log: ${code}`, {
            serialLogPath,
          });
        }
      }

      // On Windows, allocate a TCP port for virtio-serial IPC bridge
      let ipcPort: number | undefined;
      if (runtimeInfo.platform === 'win32') {
        try {
          ipcPort = await findFreePort();
          console.log(`Allocated IPC port ${ipcPort} for virtio-serial bridge`);
        } catch (error) {
          const message = `Failed to allocate IPC port: ${error instanceof Error ? error.message : String(error)}`;
          return { status: 'error', message, hvfDenied: false, memoryFailed: false };
        }
      }

      let child: ChildProcessByStdio<null, Readable, Readable>;
      try {
        child = spawnCoworkSandboxVm({
          runtime: runtimeInfo,
          ipcDir: paths.ipcDir,
          cwdMapping,
          extraMounts: sandboxSkills.extraMounts,
          accelOverride,
          launcher: launcherOverride,
          ipcPort,
          memoryMb,
        });
      } catch (error) {
        const message = formatSandboxSpawnError(error, runtimeInfo);
        return { status: 'error', message, hvfDenied: isHvfDenied(message), memoryFailed: false };
      }

      console.log(`Sandbox VM spawned in ${Date.now() - startTime}ms`);
      currentChild = child;
      activeSession.sandboxProcess = child;
      activeSession.sandboxIpcDir = paths.ipcDir;

      if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
        try {
          child.kill('SIGKILL');
        } catch {
          // ignore kill race
        }
        return { status: 'ok' };
      }

      let stderrBuffer = '';

      coworkLog('INFO', 'runSandbox', 'Sandbox VM spawned', {
        sessionId,
        runtimeBinary: runtimeInfo.runtimeBinary,
        imagePath: runtimeInfo.imagePath,
        platform: runtimeInfo.platform,
        arch: runtimeInfo.arch,
        ipcPort: ipcPort ?? null,
        ipcDir: paths.ipcDir,
        accelMode,
        launcher: launcherOverride ?? 'direct',
        pid: child.pid,
      });

      const handleLine = (line: string) => {
        if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
          return;
        }
        const trimmed = line.trim();
        if (!trimmed) return;

        let payload: Record<string, unknown> | null = null;
        try {
          payload = JSON.parse(trimmed) as Record<string, unknown>;
        } catch {
          return;
        }

        const messageType = String(payload.type ?? '');
        if (messageType === 'sdk_event' && payload.event) {
          handleClaudeEvent(sessionId, payload.event, activeSession, {
            store: this.deps.store,
            emit: this.deps.emit,
            permissionManager: this.deps.permissionManager,
            handleError: this.deps.handleError,
            isSessionStopRequested: this.deps.isSessionStopRequested,
            applyTurnMemoryUpdatesForSession: this.deps.applyTurnMemoryUpdatesForSession,
          });
          return;
        }

        if (messageType === 'host_tool_request') {
          const requestId = String(payload.requestId ?? '');
          if (!requestId) return;

          const result = this.deps.hostToolExecutor(payload);
          writeSandboxHostToolResponse(activeSession, paths.responsesDir, requestId, {
            type: 'host_tool_response',
            requestId,
            success: result.success,
            text: result.text,
            error: result.success ? undefined : result.text,
          });
          return;
        }

        if (messageType === 'permission_request') {
          const requestId = String(payload.requestId ?? '');
          if (!requestId) return;

          const toolName = String(payload.toolName ?? 'AskUserQuestion');
          const toolInputRaw = payload.toolInput;
          const toolInput =
            toolInputRaw && typeof toolInputRaw === 'object'
              ? (toolInputRaw as Record<string, unknown>)
              : {};

          const responsePath = path.join(paths.responsesDir, `${requestId}.json`);

          const request: PermissionRequest = {
            requestId,
            toolName,
            toolInput: this.deps.sanitizeToolPayload(toolInput) as Record<string, unknown>,
          };

          activeSession.pendingPermission = request;
          this.deps.emit('permissionRequest', sessionId, request);
        }
      };

      child.stderr.on('data', (chunk) => {
        const text = chunk.toString();
        stderrBuffer += text;
        if (stderrBuffer.length > 10000) {
          stderrBuffer = stderrBuffer.slice(-10000);
        }
        // Log QEMU stderr in real-time for diagnostics
        coworkLog('WARN', 'QEMUStderr', text.trim());
      });
      // Drain stdout to avoid backpressure blocking the VM process.
      child.stdout.on('data', () => {});

      const streamAbort = new AbortController();
      let streamPromise: Promise<void> | null = null;

      try {
        // On Windows, connect the virtio-serial bridge BEFORE waiting for VM ready,
        // because the bridge receives heartbeat messages and writes them to the local
        // file that waitForVmReady polls.
        if (ipcPort && runtimeInfo.platform === 'win32') {
          const bridge = new VirtioSerialBridge(paths.ipcDir, cwdMapping.hostPath);
          try {
            await bridge.connect(ipcPort);
            activeSession.ipcBridge = bridge;
            coworkLog('INFO', 'runSandbox', `IPC bridge connected on port ${ipcPort}`);
            console.log(`IPC bridge connected on port ${ipcPort}`);
          } catch (error) {
            bridge.close();
            // Kill the QEMU process to release serial.log file lock before retry
            try { child.kill('SIGKILL'); } catch { /* ignore */ }
            // Check if QEMU stderr reveals acceleration or memory failure
            const stderrSnippet = stderrBuffer.trim();
            const accelFailed = isHvfDenied(stderrSnippet) || isWhpxFailed(stderrSnippet);
            const memFailed = isMemoryAllocationFailed(stderrSnippet);
            let message = `Failed to connect IPC bridge: ${error instanceof Error ? error.message : String(error)}`;
            if (stderrSnippet) {
              message += `\nQEMU stderr: ${stderrSnippet.slice(-1000)}`;
            }
            coworkLog('ERROR', 'runSandbox', 'IPC bridge connection failed', {
              port: ipcPort,
              errorMessage: error instanceof Error ? error.message : String(error),
              qemuStderr: stderrSnippet.slice(-2000) || '(empty)',
              accelFailed,
              memoryFailed: memFailed,
              processExited: child.killed || !child.pid,
            });
            return { status: 'error', message, hvfDenied: accelFailed, memoryFailed: memFailed };
          }
        }

        // Wait for the VM to be ready before sending requests.
        // Windows TCG can be significantly slower than hardware acceleration.
        const vmReadyTimeoutOverride = Number.parseInt(
          process.env.COWORK_SANDBOX_VM_READY_TIMEOUT_MS ?? '',
          10
        );
        const defaultVmReadyTimeout =
          runtimeInfo.platform === 'win32' && accelMode === 'tcg'
            ? 300000
            : 180000;
        const vmReadyTimeoutMs =
          Number.isFinite(vmReadyTimeoutOverride) && vmReadyTimeoutOverride > 0
            ? vmReadyTimeoutOverride
            : defaultVmReadyTimeout;

        coworkLog('INFO', 'runSandbox', 'Waiting for VM heartbeat', {
          timeoutMs: vmReadyTimeoutMs,
          accelMode,
          platform: runtimeInfo.platform,
        });

        const vmReady = await waitForVmReady(paths.ipcDir, child, vmReadyTimeoutMs, {
          platform: runtimeInfo.platform,
          accelMode,
        });
        if (!vmReady) {
          const stderrSnippet = stderrBuffer.trim();
          let message = 'VM failed to become ready';
          if (stderrSnippet) {
            message += `\nQEMU stderr: ${stderrSnippet.slice(-1000)}`;
          }
          // Check serial.log for additional boot diagnostics
          try {
            const serialLog = fs.readFileSync(path.join(paths.ipcDir, 'serial.log'), 'utf8').trim();
            if (serialLog) {
              message += `\nSerial log (last 1500 chars): ${serialLog.slice(-1500)}`;
            }
          } catch { /* serial log may not exist */ }
          const accelFailed = isHvfDenied(stderrSnippet) || isWhpxFailed(stderrSnippet);
          const memFailed = isMemoryAllocationFailed(stderrSnippet);
          coworkLog('ERROR', 'runSandbox', 'VM failed to become ready', {
            elapsed: Date.now() - startTime,
            qemuStderr: stderrSnippet.slice(-2000) || '(empty)',
            accelFailed,
            memoryFailed: memFailed,
          });
          // Kill the QEMU process and close IPC bridge to release serial.log file lock before retry
          try { child.kill('SIGKILL'); } catch { /* ignore */ }
          if (activeSession.ipcBridge) {
            try { activeSession.ipcBridge.close(); } catch { /* ignore */ }
            activeSession.ipcBridge = undefined;
          }
          return { status: 'error', message, hvfDenied: accelFailed, memoryFailed: memFailed };
        }

        if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
          return { status: 'ok' };
        }

        // On Windows (serial mode), push skill files into the sandbox
        // since 9p filesystem sharing is not available.
        if (activeSession.ipcBridge && sandboxSkills.guestSkillsRoot && sandboxSkills.skillEntries.length > 0) {
          coworkLog('INFO', 'runSandbox', 'Preparing to push skill files via serial bridge', {
            guestSkillsRoot: sandboxSkills.guestSkillsRoot,
            skillCount: sandboxSkills.skillEntries.length,
          });
          try {
            let pushedFileCount = 0;
            let pushedSkillCount = 0;
            for (const skillEntry of sandboxSkills.skillEntries) {
              if (!fs.existsSync(skillEntry.hostPath)) {
                coworkLog('WARN', 'runSandbox', 'Skill directory does not exist, skip push', {
                  skillId: skillEntry.skillId,
                  hostPath: skillEntry.hostPath,
                });
                continue;
              }

              const skillFiles = collectSkillFilesForSandbox(skillEntry.hostPath);
              for (const file of skillFiles) {
                activeSession.ipcBridge!.pushFile(skillEntry.guestPath, file.path, file.data);
              }
              pushedSkillCount += 1;
              pushedFileCount += skillFiles.length;
              coworkLog('INFO', 'runSandbox', 'Pushed skill files to sandbox', {
                skillId: skillEntry.skillId,
                hostPath: skillEntry.hostPath,
                guestPath: skillEntry.guestPath,
                fileCount: skillFiles.length,
              });
            }
            coworkLog('INFO', 'runSandbox', 'Finished pushing skill files to sandbox via serial bridge', {
              pushedSkillCount,
              pushedFileCount,
            });
          } catch (error) {
            coworkLog('ERROR', 'runSandbox', 'Failed to push skill files to sandbox', {
              error: error instanceof Error ? error.message : String(error),
            });
          }
        } else if (activeSession.ipcBridge) {
          coworkLog('INFO', 'runSandbox', 'No sandbox skills to push via serial bridge', {
            hostSkillsRoots: hostSkillsRoots.join(', '),
          });
        } else {
          coworkLog('INFO', 'runSandbox', 'No IPC bridge (9p mode), skill files shared via virtfs mounts', {
            skillCount: sandboxSkills.skillEntries.length,
            skillPaths: sandboxSkills.skillEntries.map((entry) => entry.hostPath).join(', '),
          });
        }

        // On Windows (serial mode), push staged attachment files into the sandbox
        if (activeSession.ipcBridge) {
          this.pushStagedAttachmentsToSandbox(activeSession.ipcBridge, cwd, sessionId);
        }

        const { requestId, streamPath } = buildSandboxRequest(paths, input);
        streamPromise = readSandboxStream(streamPath, handleLine, streamAbort.signal);

        // On Windows, send the request via virtio-serial bridge instead of file
        if (activeSession.ipcBridge) {
          activeSession.ipcBridge.sendRequest(requestId, input);
          console.log(`Sandbox request ${requestId} sent via virtio-serial bridge`);
        }

        return await new Promise((resolve) => {
          // Allow the result event handler to resolve this turn without killing the VM
          activeSession.sandboxTurnResolve = resolve;

          child.on('error', (error) => {
            activeSession.sandboxTurnResolve = undefined;
            activeSession.sandboxProcess = undefined;
            activeSession.sandboxIpcDir = undefined;
            const message = formatSandboxSpawnError(error, runtimeInfo);
            resolve({ status: 'error', message, hvfDenied: isHvfDenied(message), memoryFailed: isMemoryAllocationFailed(message) });
          });

          child.on('close', (code) => {
            activeSession.sandboxProcess = undefined;
            activeSession.sandboxIpcDir = undefined;

            // If already resolved by result event, just clean up — don't resolve again
            if (!activeSession.sandboxTurnResolve) {
              return;
            }
            activeSession.sandboxTurnResolve = undefined;

            if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
              this.deps.store.updateSession(sessionId, { status: 'idle' });
              resolve({ status: 'ok' });
              return;
            }

            finalizeStreamingContent(activeSession, this.deps.store, this.deps.emit);

            if (code !== 0) {
              const message = stderrBuffer.trim() || `Sandbox VM exited with code ${code}`;
              resolve({ status: 'error', message, hvfDenied: isHvfDenied(message), memoryFailed: isMemoryAllocationFailed(message) });
              return;
            }

            // Only update status if not already completed (may have been set by result event)
            const session = this.deps.store.getSession(sessionId);
            if (session?.status !== 'error' && session?.status !== 'completed') {
              this.deps.store.updateSession(sessionId, { status: 'completed' });
              this.deps.applyTurnMemoryUpdatesForSession(sessionId);
              this.deps.emit('complete', sessionId, activeSession.claudeSessionId);
            }
            resolve({ status: 'ok' });
          });
        });
      } finally {
        streamAbort.abort();
        if (streamPromise) {
          try {
            await streamPromise;
          } catch (error) {
            console.warn('Sandbox stream reader error:', error);
          }
        }

        // If the VM is still alive (turn completed via result event), keep it
        // running for potential multi-turn continuation.
        const vmStillAlive = activeSession.sandboxProcess && !activeSession.sandboxProcess.killed;
        if (vmStillAlive) {
          // Only clear turn-specific state, keep VM and bridge alive
          this.deps.clearSandboxPermissions(sessionId);
          this.deps.clearPendingPermissions(sessionId);
          activeSession.pendingPermission = null;
        } else {
          // VM exited or errored — full cleanup
          if (child && !child.killed) {
            try {
              child.kill('SIGTERM');
              // Give it a moment to terminate gracefully, then force kill
              setTimeout(() => {
                if (!child.killed) {
                  child.kill('SIGKILL');
                }
              }, 1000);
            } catch (error) {
              console.warn('Failed to kill sandbox process in cleanup:', error);
            }
          }
          this.deps.clearSandboxPermissions(sessionId);
          this.deps.clearPendingPermissions(sessionId);
          activeSession.pendingPermission = null;
          // Close virtio-serial bridge if active
          if (activeSession.ipcBridge) {
            try {
              activeSession.ipcBridge.close();
            } catch (error) {
              console.warn('Failed to close IPC bridge in cleanup:', error);
            }
            activeSession.ipcBridge = undefined;
          }
        }
      }
    };

    abortController.signal.addEventListener('abort', () => {
      if (!currentChild) return;
      try {
        currentChild.kill('SIGKILL');
      } catch (error) {
        console.warn('Failed to kill sandbox process on abort:', error);
      }
    }, { once: true });

    let accelOverride: string | null | undefined;
    let launcherOverride: 'direct' | 'launchctl' | undefined;
    let memoryMb: number | undefined;
    const MEMORY_FALLBACK_STEPS = [2048, 1024];
    let memoryFallbackIndex = 0;

    for (let attempt = 0; attempt < 5; attempt += 1) {
      // Wait briefly between retries for the previous QEMU process to fully exit
      // and release file locks (especially serial.log on Windows)
      if (attempt > 0) {
        await new Promise(r => setTimeout(r, 1000));
      }
      coworkLog('INFO', 'runSandbox', `Sandbox attempt ${attempt + 1}/5`, {
        accelOverride: accelOverride ?? 'default',
        launcher: launcherOverride ?? 'direct',
        memoryMb: memoryMb ?? 4096,
      });
      const result = await runOnce(accelOverride, launcherOverride, memoryMb);
      if (result.status === 'ok') {
        return;
      }

      coworkLog('WARN', 'runSandbox', `Sandbox attempt ${attempt + 1} failed`, {
        hvfDenied: result.hvfDenied,
        memoryFailed: result.memoryFailed,
        message: result.message.slice(0, 500),
      });

      // Memory allocation failure — retry with reduced memory
      if (result.memoryFailed && memoryFallbackIndex < MEMORY_FALLBACK_STEPS.length) {
        const nextMemory = MEMORY_FALLBACK_STEPS[memoryFallbackIndex++];
        this.deps.addSystemMessage(
          sessionId,
          `Sandbox VM failed to allocate memory (${memoryMb ?? 4096}MB). Retrying with ${nextMemory}MB.`
        );
        coworkLog('INFO', 'runSandbox', `Memory allocation failed, reducing to ${nextMemory}MB`, {
          previousMemory: memoryMb ?? 4096,
          nextMemory,
        });
        memoryMb = nextMemory;
        continue;
      }

      if (result.hvfDenied && launcherOverride !== 'launchctl' && process.platform === 'darwin') {
        this.deps.addSystemMessage(
          sessionId,
          'HVF acceleration is denied in the app sandbox. Retrying via launchctl.'
        );
        launcherOverride = 'launchctl';
        continue;
      }

      if (result.hvfDenied && accelOverride !== 'tcg') {
        if (process.platform === 'win32') {
          // On Windows, WHPX/Hyper-V may not be enabled. Try TCG (software emulation) as fallback.
          this.deps.addSystemMessage(
            sessionId,
            'Hardware virtualization (WHPX/Hyper-V) is unavailable. Retrying with software emulation (TCG).'
          );
          // TCG boots faster and more reliably with lower guest memory on typical Windows hosts.
          if (!memoryMb || memoryMb > 2048) {
            memoryMb = 2048;
          }
          accelOverride = 'tcg';
          continue;
        }
        // HVF acceleration unavailable - instead of using slow TCG emulation,
        // throw an error to trigger fallback to local execution mode
        this.deps.addSystemMessage(
          sessionId,
          'HVF acceleration is unavailable. Falling back to local execution mode for better performance.'
        );
        throw new Error('HVF unavailable, fallback to local mode');
      }

      throw new Error(result.message);
    }
  }

  /**
   * Send a continuation request to an already-running sandbox VM.
   * Reuses the existing QEMU process and IPC bridge.
   */
  async continueTurn(
    activeSession: ActiveSession,
    prompt: string,
    cwd: string,
    systemPrompt: string,
    imageAttachments?: Array<{ name: string; mimeType: string; base64Data: string }>
  ): Promise<void> {
    const { sessionId } = activeSession;

    if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
      this.deps.store.updateSession(sessionId, { status: 'idle' });
      return;
    }

    // Reset per-turn output dedupe flags
    activeSession.hasAssistantTextOutput = false;
    activeSession.hasAssistantThinkingOutput = false;
    activeSession.currentStreamingTextTruncated = false;
    activeSession.currentStreamingThinkingTruncated = false;
    activeSession.lastStreamingTextUpdateAt = 0;
    activeSession.lastStreamingThinkingUpdateAt = 0;

    const apiConfig = getCurrentApiConfig('sandbox');
    if (!apiConfig) {
      this.deps.handleError(sessionId, 'API configuration not found. Please configure model settings.');
      return;
    }

    const paths = ensureCoworkSandboxDirs(sessionId);
    const cwdMapping = resolveSandboxCwd(cwd);
    const env = await getEnhancedEnv('sandbox');
    const hostSkillsRoots = collectHostSkillsRoots(env, cwdMapping, systemPrompt);
    const sandboxSystemPrompt = enforceSandboxWorkspacePrompt(systemPrompt, cwdMapping.guestPath);
    const resolvedSystemPrompt = resolveAutoRoutingForSandbox(sandboxSystemPrompt, {
      guestSkillsRoot: activeSession.sandboxSkillsGuestPath ?? null,
      hostSkillsRoots: hostSkillsRoots,
      hostSkillsRootMounts: activeSession.sandboxSkillRootMounts,
    });
    const sandboxEnv = this.buildSandboxEnv(env, activeSession.sandboxSkillsGuestPath ?? null);
    coworkLog('INFO', 'runSandbox', 'Resolved sandbox API endpoint (continue)', {
      sessionId,
      anthropicBaseUrl: this.summarizeEndpointForLog(sandboxEnv.ANTHROPIC_BASE_URL),
      anthropicModel: sandboxEnv.ANTHROPIC_MODEL ?? null,
      httpProxy: this.summarizeEndpointForLog(sandboxEnv.HTTP_PROXY ?? sandboxEnv.http_proxy),
      noProxy: sandboxEnv.NO_PROXY ?? sandboxEnv.no_proxy ?? null,
      directHostRouting: !(sandboxEnv.HTTP_PROXY || sandboxEnv.http_proxy),
    });

    // Ensure the bridge has the latest host CWD for file sync
    if (activeSession.ipcBridge) {
      activeSession.ipcBridge.setHostCwd(cwdMapping.hostPath);
    }

    const mounts: Record<string, { tag: string; guestPath: string }> = {
      work: {
        tag: cwdMapping.mountTag,
        guestPath: cwdMapping.guestPath,
      },
      ipc: {
        tag: 'ipc',
        guestPath: '/workspace/ipc',
      },
      ...(activeSession.sandboxSkillMounts ?? {}),
    };

    const input: Record<string, unknown> = {
      prompt,
      cwd: cwdMapping.guestPath,
      workspaceRoot: cwdMapping.guestPath,
      hostWorkspaceRoot: cwdMapping.hostPath,
      memoryEnabled: this.deps.permissionManagerGetConfig().memoryEnabled,
      autoApprove: Boolean(activeSession.autoApprove),
      confirmationMode: activeSession.confirmationMode,
      env: sandboxEnv,
      mounts,
    };

    if (imageAttachments && imageAttachments.length > 0) {
      input.imageAttachments = imageAttachments;
    }

    if (activeSession.claudeSessionId) {
      input.sessionId = activeSession.claudeSessionId;
    }

    if (resolvedSystemPrompt) {
      input.systemPrompt = resolvedSystemPrompt;
    }

    // On Windows (serial mode), push staged attachment files into the sandbox
    if (activeSession.ipcBridge) {
      this.pushStagedAttachmentsToSandbox(activeSession.ipcBridge, cwd, sessionId);
    }

    const { requestId, streamPath } = buildSandboxRequest(paths, input);
    const streamAbort = new AbortController();

    const handleLine = (line: string) => {
      if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
        return;
      }
      const trimmed = line.trim();
      if (!trimmed) return;

      let payload: Record<string, unknown> | null = null;
      try {
        payload = JSON.parse(trimmed) as Record<string, unknown>;
      } catch {
        return;
      }

      const messageType = String(payload.type ?? '');
      if (messageType === 'sdk_event' && payload.event) {
        handleClaudeEvent(sessionId, payload.event, activeSession, {
          store: this.deps.store,
          emit: this.deps.emit,
          permissionManager: this.deps.permissionManager,
          handleError: this.deps.handleError,
          isSessionStopRequested: this.deps.isSessionStopRequested,
          applyTurnMemoryUpdatesForSession: this.deps.applyTurnMemoryUpdatesForSession,
        });
        return;
      }

      if (messageType === 'host_tool_request') {
        const reqId = String(payload.requestId ?? '');
        if (!reqId) return;
        const result = this.deps.hostToolExecutor(payload);
        writeSandboxHostToolResponse(activeSession, paths.responsesDir, reqId, {
          type: 'host_tool_response',
          requestId: reqId,
          success: result.success,
          text: result.text,
          error: result.success ? undefined : result.text,
        });
        return;
      }

      if (messageType === 'permission_request') {
        const reqId = String(payload.requestId ?? '');
        if (!reqId) return;

        const toolName = String(payload.toolName ?? 'AskUserQuestion');
        const toolInputRaw = payload.toolInput;
        const toolInput =
          toolInputRaw && typeof toolInputRaw === 'object'
            ? (toolInputRaw as Record<string, unknown>)
            : {};

        const responsePath = path.join(paths.responsesDir, `${reqId}.json`);

        const request: PermissionRequest = {
          requestId: reqId,
          toolName,
          toolInput: this.deps.sanitizeToolPayload(toolInput) as Record<string, unknown>,
        };

        activeSession.pendingPermission = request;
        this.deps.emit('permissionRequest', sessionId, request);
      }
    };

    const streamPromise = readSandboxStream(streamPath, handleLine, streamAbort.signal);

    if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
      streamAbort.abort();
      return;
    }

    // Send continuation request via IPC bridge
    activeSession.ipcBridge!.sendRequest(requestId, input);
    console.log(`Sandbox continuation request ${requestId} sent via virtio-serial bridge`);

    try {
      await new Promise<void>((resolve, reject) => {
        // Allow the result event handler to resolve this turn
        activeSession.sandboxTurnResolve = (result) => {
          activeSession.sandboxTurnResolve = undefined;
          if (result.status === 'ok') {
            resolve();
          } else {
            reject(new Error(result.message));
          }
        };

        // Handle unexpected process exit during this turn
        const onClose = (code: number | null) => {
          if (!activeSession.sandboxTurnResolve) return;
          activeSession.sandboxTurnResolve = undefined;
          activeSession.sandboxProcess = undefined;
          activeSession.sandboxIpcDir = undefined;
          if (activeSession.ipcBridge) {
            try { activeSession.ipcBridge.close(); } catch { /* ignore */ }
            activeSession.ipcBridge = undefined;
          }

          if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
            this.deps.store.updateSession(sessionId, { status: 'idle' });
            resolve();
            return;
          }

          finalizeStreamingContent(activeSession, this.deps.store, this.deps.emit);

          if (code !== 0) {
            reject(new Error(`Sandbox VM exited with code ${code}`));
            return;
          }
          resolve();
        };

        activeSession.sandboxProcess!.on('close', onClose);

        if (this.deps.isSessionStopRequested(sessionId, activeSession)) {
          activeSession.sandboxTurnResolve = undefined;
          resolve();
        }
      });
    } finally {
      streamAbort.abort();
      if (streamPromise) {
        try {
          await streamPromise;
        } catch { /* ignore */ }
      }
      this.deps.clearSandboxPermissions(sessionId);
      this.deps.clearPendingPermissions(sessionId);
      activeSession.pendingPermission = null;
    }
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
  }

  private summarizeEndpointForLog(rawValue: string | undefined): string | null {
    if (!rawValue) return null;
    const trimmed = rawValue.trim();
    if (!trimmed) return null;
    try {
      const parsed = new URL(trimmed);
      const defaultPort = parsed.protocol === 'https:' ? '443' : parsed.protocol === 'http:' ? '80' : '';
      const resolvedPort = parsed.port || defaultPort;
      const port = resolvedPort ? `:${resolvedPort}` : '';
      return `${parsed.protocol}//${parsed.hostname}${port}`;
    } catch {
      return trimmed.length > 160 ? `${trimmed.slice(0, 157)}...` : trimmed;
    }
  }
}
