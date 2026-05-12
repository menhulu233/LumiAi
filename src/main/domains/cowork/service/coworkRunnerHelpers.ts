import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import { coworkLog } from './coworkLogger';
import type { SandboxRuntimeInfo } from './coworkSandboxRuntime';

const WINDOWS_HIDE_INIT_SCRIPT_NAME = 'windows_hide_init.cjs';
const WINDOWS_HIDE_INIT_SCRIPT_CONTENT = [
  '\'use strict\';',
  '',
  'if (process.platform === \'win32\') {',
  '  const childProcess = require(\'child_process\');',
  '',
  '  const addWindowsHide = (options) => {',
  '    if (options == null) return { windowsHide: true };',
  '    if (typeof options !== \'object\') return options;',
  '    if (Object.prototype.hasOwnProperty.call(options, \'windowsHide\')) return options;',
  '    return { ...options, windowsHide: true };',
  '  };',
  '',
  '  const patch = (name, buildWrapper) => {',
  '    const original = childProcess[name];',
  '    if (typeof original !== \'function\') return;',
  '    childProcess[name] = buildWrapper(original);',
  '  };',
  '',
  '  patch(\'spawn\', (original) => function patchedSpawn(command, args, options) {',
  '    if (Array.isArray(args) || args === undefined) {',
  '      return original.call(this, command, args, addWindowsHide(options));',
  '    }',
  '    return original.call(this, command, addWindowsHide(args));',
  '  });',
  '',
  '  patch(\'spawnSync\', (original) => function patchedSpawnSync(command, args, options) {',
  '    if (Array.isArray(args) || args === undefined) {',
  '      return original.call(this, command, args, addWindowsHide(options));',
  '    }',
  '    return original.call(this, command, addWindowsHide(args));',
  '  });',
  '',
  '  patch(\'fork\', (original) => function patchedFork(modulePath, args, options) {',
  '    if (Array.isArray(args) || args === undefined) {',
  '      return original.call(this, modulePath, args, addWindowsHide(options));',
  '    }',
  '    return original.call(this, modulePath, addWindowsHide(args));',
  '  });',
  '',
  '  patch(\'exec\', (original) => function patchedExec(command, options, callback) {',
  '    if (typeof options === \'function\' || options === undefined) {',
  '      return original.call(this, command, addWindowsHide(undefined), options);',
  '    }',
  '    return original.call(this, command, addWindowsHide(options), callback);',
  '  });',
  '',
  '  patch(\'execFile\', (original) => function patchedExecFile(file, args, options, callback) {',
  '    if (Array.isArray(args) || args === undefined) {',
  '      if (typeof options === \'function\' || options === undefined) {',
  '        return original.call(this, file, args, addWindowsHide(undefined), options);',
  '      }',
  '      return original.call(this, file, args, addWindowsHide(options), callback);',
  '    }',
  '    if (typeof args === \'function\' || args === undefined) {',
  '      return original.call(this, file, addWindowsHide(undefined), args);',
  '    }',
  '    return original.call(this, file, addWindowsHide(args), options);',
  '  });',
  '}',
  '',
].join('\n');

export function ensureWindowsChildProcessHideInitScript(): string | null {
  if (process.platform !== 'win32') {
    return null;
  }

  try {
    const initDir = path.join(app.getPath('userData'), 'cowork', 'bin');
    fs.mkdirSync(initDir, { recursive: true });
    const initScriptPath = path.join(initDir, WINDOWS_HIDE_INIT_SCRIPT_NAME);

    const existing = fs.existsSync(initScriptPath)
      ? fs.readFileSync(initScriptPath, 'utf8')
      : '';
    if (existing !== WINDOWS_HIDE_INIT_SCRIPT_CONTENT) {
      fs.writeFileSync(initScriptPath, WINDOWS_HIDE_INIT_SCRIPT_CONTENT, 'utf8');
    }
    return initScriptPath;
  } catch (error) {
    coworkLog(
      'WARN',
      'runClaudeCodeLocal',
      `Failed to prepare Windows child-process hide init script: ${error instanceof Error ? error.message : String(error)}`
    );
    return null;
  }
}

export function prependNodeRequireArg(args: string[], scriptPath: string): string[] {
  for (let i = 0; i < args.length - 1; i++) {
    if (args[i] === '--require' && args[i + 1] === scriptPath) {
      return args;
    }
  }
  return ['--require', scriptPath, ...args];
}

export function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function isPathWithin(basePath: string, targetPath: string): boolean {
  if (process.platform === 'win32') {
    const normalizedBase = basePath.toLowerCase();
    const normalizedTarget = targetPath.toLowerCase();
    return normalizedTarget === normalizedBase || normalizedTarget.startsWith(`${normalizedBase}${path.sep}`);
  }
  return targetPath === basePath || targetPath.startsWith(`${basePath}${path.sep}`);
}

export function detectBinaryMagic(filePath: string): string {
  try {
    const buffer = fs.readFileSync(filePath, { encoding: null, flag: 'r' }).subarray(0, 4);
    if (buffer.length >= 2 && buffer[0] === 0x1f && buffer[1] === 0x8b) return 'gzip';
    if (
      buffer.length >= 4
      && buffer[0] === 0x7f
      && buffer[1] === 0x45
      && buffer[2] === 0x4c
      && buffer[3] === 0x46
    ) {
      return 'elf';
    }
    if (buffer.length >= 4 && buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && buffer[3] === 0xce) return 'macho-32';
    if (buffer.length >= 4 && buffer[0] === 0xfe && buffer[1] === 0xed && buffer[2] === 0xfa && buffer[3] === 0xcf) return 'macho-64';
    if (buffer.length >= 4 && buffer[0] === 0xca && buffer[1] === 0xfe && buffer[2] === 0xba && buffer[3] === 0xbe) return 'macho-fat';
    if (buffer.length >= 2 && buffer[0] === 0x4d && buffer[1] === 0x5a) return 'pe';
  } catch {
    return 'unreadable';
  }
  return 'unknown';
}

export function summarizeRuntimeBinary(runtimeBinary: string): string {
  const exists = fs.existsSync(runtimeBinary);
  if (!exists) return `runtimeBinary=${runtimeBinary} (missing)`;
  try {
    const stat = fs.statSync(runtimeBinary);
    const mode = process.platform === 'win32' ? 'n/a' : `0o${(stat.mode & 0o777).toString(8)}`;
    const exec = process.platform === 'win32' ? 'n/a' : (stat.mode & 0o111) ? 'yes' : 'no';
    const magic = detectBinaryMagic(runtimeBinary);
    return `runtimeBinary=${runtimeBinary} (size=${stat.size}, mode=${mode}, exec=${exec}, magic=${magic})`;
  } catch (error) {
    return `runtimeBinary=${runtimeBinary} (stat failed: ${error instanceof Error ? error.message : String(error)})`;
  }
}

export function persistSandboxSpawnDiagnostics(
  runtimeInfo: SandboxRuntimeInfo,
  details: string
): string | null {
  try {
    if (!runtimeInfo.baseDir) return null;
    fs.mkdirSync(runtimeInfo.baseDir, { recursive: true });
    const logPath = path.join(runtimeInfo.baseDir, 'last-spawn-error.txt');
    fs.writeFileSync(logPath, details);
    return logPath;
  } catch {
    return null;
  }
}

export function formatSandboxSpawnError(
  error: unknown,
  runtimeInfo: SandboxRuntimeInfo
): string {
  const runtimeSummary = summarizeRuntimeBinary(runtimeInfo.runtimeBinary);
  const err = error && typeof error === 'object'
    ? (error as NodeJS.ErrnoException & { spawnargs?: string[] })
    : null;
  const details: string[] = [];
  if (err?.code) details.push(`code=${err.code}`);
  if (typeof err?.errno === 'number') details.push(`errno=${err.errno}`);
  if (err?.syscall) details.push(`syscall=${err.syscall}`);
  if (err?.path) details.push(`path=${err.path}`);
  if (Array.isArray(err?.spawnargs) && err.spawnargs.length > 0) {
    details.push(`args=${err.spawnargs.join(' ')}`);
  }
  const detailString = details.length ? ` (${details.join(', ')})` : '';
  const baseMessage = err?.message || 'Sandbox VM spawn failed';
  const hint = err?.code === 'ENOEXEC' || err?.errno === -8
    ? ' Possible exec format mismatch (wrong arch or compressed binary).'
    : '';
  const diagnostics = `${baseMessage}${detailString}.${hint} ${runtimeSummary}`;
  const logPath = persistSandboxSpawnDiagnostics(runtimeInfo, diagnostics);
  return logPath ? `${diagnostics} Diagnostics saved to: ${logPath}` : diagnostics;
}

export function summarizeEndpointForLog(rawValue: string | undefined): string | null {
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

export function extractHostFromUrl(rawValue: string | undefined): string | null {
  if (!rawValue) return null;
  const trimmed = rawValue.trim();
  if (!trimmed) return null;
  try {
    return new URL(trimmed).hostname || null;
  } catch {
    return null;
  }
}

export function mergeNoProxyList(currentValue: string | undefined, requiredHosts: string[]): string {
  const seen = new Set<string>();
  const items: string[] = [];

  const addEntry = (entry: string) => {
    const normalized = entry.trim();
    if (!normalized) return;
    const dedupeKey = normalized.toLowerCase();
    if (seen.has(dedupeKey)) return;
    seen.add(dedupeKey);
    items.push(normalized);
  };

  if (currentValue) {
    for (const part of currentValue.split(',')) {
      addEntry(part);
    }
  }
  for (const host of requiredHosts) {
    addEntry(host);
  }

  return items.join(',');
}

export function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const CONTENT_TRUNCATED_HINT = '\n...[truncated to prevent memory pressure]';

export function truncateLargeContent(content: string, maxChars: number): string {
  if (content.length <= maxChars) {
    return content;
  }
  return `${content.slice(0, maxChars)}${CONTENT_TRUNCATED_HINT}`;
}

export function extractText(value: unknown): string | null {
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
      return extractText(record.content);
    }
  }

  return null;
}

export function formatToolResultContent(record: Record<string, unknown>, maxChars = 120_000): string {
  const raw = record.content ?? record;
  const text = extractText(raw);
  if (text !== null) {
    return truncateLargeContent(text, maxChars);
  }
  try {
    return truncateLargeContent(JSON.stringify(raw, null, 2), maxChars);
  } catch {
    return truncateLargeContent(String(raw), maxChars);
  }
}
