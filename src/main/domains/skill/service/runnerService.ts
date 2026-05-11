import { spawn } from 'child_process';
import { getElectronNodeRuntimePath } from '../../../libs/coworkUtil';
import {
  SkillScriptRunResult,
  EmailConnectivityCheckCode,
  EmailConnectivityCheck,
} from '../types';

export const runScriptWithTimeout = (options: {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
}): Promise<SkillScriptRunResult> => new Promise((resolve) => {
  const startedAt = Date.now();
  const child = spawn(options.command, options.args, {
    cwd: options.cwd,
    env: options.env,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  let settled = false;
  let timedOut = false;
  let stdout = '';
  let stderr = '';
  let forceKillTimer: NodeJS.Timeout | null = null;

  const settle = (result: SkillScriptRunResult) => {
    if (settled) return;
    settled = true;
    resolve(result);
  };

  const timeoutTimer = setTimeout(() => {
    timedOut = true;
    child.kill('SIGTERM');
    forceKillTimer = setTimeout(() => {
      child.kill('SIGKILL');
    }, 2000);
  }, options.timeoutMs);

  child.stdout.on('data', (chunk) => {
    stdout += chunk.toString();
  });
  child.stderr.on('data', (chunk) => {
    stderr += chunk.toString();
  });

  child.on('error', (error: NodeJS.ErrnoException) => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    settle({
      success: false,
      exitCode: null,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
      timedOut,
      error: error.message,
      spawnErrorCode: error.code,
    });
  });

  child.on('close', (exitCode) => {
    clearTimeout(timeoutTimer);
    if (forceKillTimer) clearTimeout(forceKillTimer);
    settle({
      success: !timedOut && exitCode === 0,
      exitCode,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      durationMs: Date.now() - startedAt,
      timedOut,
      error: timedOut ? `Command timed out after ${options.timeoutMs}ms` : undefined,
    });
  });
});

export class SkillRunnerService {
  getScriptRuntimeCandidates(env: NodeJS.ProcessEnv): Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> {
    const candidates: Array<{ command: string; extraEnv?: NodeJS.ProcessEnv }> = [];
    // hasCommand is checked by the caller via buildSkillEnv; we always include node first
    candidates.push({ command: 'node' });
    candidates.push({
      command: getElectronNodeRuntimePath(),
      extraEnv: { ELECTRON_RUN_AS_NODE: '1' },
    });
    return candidates;
  }

  parseScriptMessage(stdout: string): string | null {
    if (!stdout) {
      return null;
    }
    try {
      const parsed = JSON.parse(stdout);
      if (parsed && typeof parsed === 'object' && typeof parsed.message === 'string' && parsed.message.trim()) {
        return parsed.message.trim();
      }
      return null;
    } catch {
      return null;
    }
  }

  getLastOutputLine(text: string): string {
    return text
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean)
      .slice(-1)[0] || '';
  }

  buildEmailConnectivityCheck(
    code: EmailConnectivityCheckCode,
    result: SkillScriptRunResult
  ): EmailConnectivityCheck {
    const label = code === 'imap_connection' ? 'IMAP' : 'SMTP';

    if (result.success) {
      const parsedMessage = this.parseScriptMessage(result.stdout);
      return {
        code,
        level: 'pass',
        message: parsedMessage || `${label} connection successful`,
        durationMs: result.durationMs,
      };
    }

    const message = result.timedOut
      ? `${label} connectivity check timed out`
      : result.error
        || this.getLastOutputLine(result.stderr)
        || this.getLastOutputLine(result.stdout)
        || `${label} connection failed`;

    return {
      code,
      level: 'fail',
      message,
      durationMs: result.durationMs,
    };
  }
}
