import { app } from 'electron';
import { execSync, spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync, statSync, readdirSync } from 'fs';
import { delimiter, dirname, join } from 'path';
import { coworkLog } from './coworkLogger';

function appendEnvPath(current: string | undefined, additions: string[]): string | undefined {
  const items = new Set<string>();

  for (const entry of additions) {
    if (entry) {
      items.add(entry);
    }
  }

  if (current) {
    for (const entry of current.split(delimiter)) {
      if (entry) {
        items.add(entry);
      }
    }
  }

  return items.size > 0 ? Array.from(items).join(delimiter) : current;
}

function hasCommandInEnv(command: string, env: Record<string, string | undefined>): boolean {
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  try {
    const result = spawnSync(whichCmd, [command], {
      env: { ...env } as NodeJS.ProcessEnv,
      encoding: 'utf-8',
      timeout: 5000,
      windowsHide: process.platform === 'win32',
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

let cachedElectronNodeRuntimePath: string | null = null;

function resolveElectronNodeRuntimePath(): string {
  if (!app.isPackaged || process.platform !== 'darwin') {
    return process.execPath;
  }

  try {
    const appName = app.getName();
    const frameworksDir = join(process.resourcesPath, '..', 'Frameworks');
    if (!existsSync(frameworksDir)) {
      return process.execPath;
    }

    const helperApps = readdirSync(frameworksDir)
      .filter((entry) => entry.startsWith(`${appName} Helper`) && entry.endsWith('.app'))
      .sort((a, b) => {
        const score = (name: string): number => {
          if (name === `${appName} Helper.app`) return 0;
          if (name === `${appName} Helper (Renderer).app`) return 1;
          if (name === `${appName} Helper (Plugin).app`) return 2;
          if (name === `${appName} Helper (GPU).app`) return 3;
          return 10;
        };
        return score(a) - score(b);
      });

    for (const helperApp of helperApps) {
      const helperExeName = helperApp.replace(/\.app$/, '');
      const helperExePath = join(frameworksDir, helperApp, 'Contents', 'MacOS', helperExeName);
      if (existsSync(helperExePath)) {
        coworkLog('INFO', 'resolveNodeShim', `Using Electron helper runtime for node shim: ${helperExePath}`);
        return helperExePath;
      }
    }
  } catch (error) {
    coworkLog('WARN', 'resolveNodeShim', `Failed to resolve Electron helper runtime: ${error instanceof Error ? error.message : String(error)}`);
  }

  return process.execPath;
}

export function getElectronNodeRuntimePath(): string {
  if (!cachedElectronNodeRuntimePath) {
    cachedElectronNodeRuntimePath = resolveElectronNodeRuntimePath();
  }
  return cachedElectronNodeRuntimePath;
}

/**
 * Cached user shell PATH. Resolved once and reused across calls.
 */
let cachedUserShellPath: string | null | undefined;

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm and other tools won't be in PATH unless we resolve it.
 */
function resolveUserShellPath(): string | null {
  if (cachedUserShellPath !== undefined) return cachedUserShellPath;

  if (process.platform === 'win32') {
    cachedUserShellPath = null;
    return null;
  }

  try {
    const shell = process.env.SHELL || '/bin/bash';
    // Prefer non-interactive login shell first to avoid potential side effects
    // from interactive startup scripts (which may launch extra GUI processes).
    const pathProbes = [
      `${shell} -lc 'echo __PATH__=$PATH'`,
    ];

    let resolved: string | null = null;
    for (const probe of pathProbes) {
      try {
        const result = execSync(probe, {
          encoding: 'utf-8',
          timeout: 5000,
          env: { ...process.env },
        });
        const match = result.match(/__PATH__=(.+)/);
        if (match?.[1]) {
          resolved = match[1].trim();
          break;
        }
      } catch {
        // Try next probe.
      }
    }
    cachedUserShellPath = resolved;
  } catch (error) {
    console.warn('[coworkUtil] Failed to resolve user shell PATH:', error);
    cachedUserShellPath = null;
  }

  return cachedUserShellPath;
}

/**
 * Cached Windows registry PATH. Resolved once and reused.
 */
let cachedWindowsRegistryPath: string | null | undefined;

function readWindowsRegistryPathValue(registryKey: string): string {
  try {
    const output = execSync(`reg query "${registryKey}" /v Path`, {
      encoding: 'utf-8',
      timeout: 8000,
      windowsHide: true,
    });

    for (const line of output.split(/\r?\n/)) {
      const match = line.match(/^\s*Path\s+REG_\w+\s+(.+)$/i);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
  } catch {
    // Ignore missing keys or access-denied errors.
  }

  return '';
}

/**
 * Resolve the latest PATH from the Windows registry (Machine + User).
 *
 * When a packaged Electron app is launched from the Start Menu, desktop shortcut,
 * or Explorer, its `process.env.PATH` is inherited from the Explorer shell process.
 * If the user installed tools (Python, Node.js, npm, pip, etc.) after Explorer started
 * — or without restarting Explorer — those new PATH entries won't be in
 * `process.env.PATH`. This causes commands like `python`, `npm`, `pip` to be
 * missing from the cowork session even though they work fine in a freshly opened
 * terminal (which reads the latest registry values).
 *
 * This function reads the current Machine and User PATH directly from the registry
 * to get the most up-to-date values, similar to how `resolveUserShellPath()` works
 * for macOS/Linux.
 */
function resolveWindowsRegistryPath(): string | null {
  if (cachedWindowsRegistryPath !== undefined) return cachedWindowsRegistryPath;

  if (process.platform !== 'win32') {
    cachedWindowsRegistryPath = null;
    return null;
  }

  try {
    const machinePath = readWindowsRegistryPathValue('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment');
    const userPath = readWindowsRegistryPathValue('HKCU\\Environment');
    const registryPath = [machinePath, userPath].filter(Boolean).join(';');
    if (registryPath.trim()) {
      // Deduplicate and remove empty entries
      const entries = registryPath
        .split(';')
        .map((entry) => entry.trim())
        .filter(Boolean);
      const unique = Array.from(new Set(entries));
      cachedWindowsRegistryPath = unique.join(';');
      coworkLog('INFO', 'resolveWindowsRegistryPath', `Resolved ${unique.length} PATH entries from Windows registry`);
    } else {
      cachedWindowsRegistryPath = null;
    }
  } catch (error) {
    coworkLog('WARN', 'resolveWindowsRegistryPath', `Failed to read PATH from Windows registry: ${error instanceof Error ? error.message : String(error)}`);
    cachedWindowsRegistryPath = null;
  }

  return cachedWindowsRegistryPath;
}

/**
 * Merge the current process PATH with registry-resolved PATH on Windows.
 *
 * This ensures that any PATH entries the user has added (e.g. Python, Node.js,
 * npm, pip) are available even if the Electron app inherited a stale PATH from
 * Explorer. The registry PATH entries are appended after the current entries
 * so that any overrides already in the env (like Git toolchain, shims) take priority.
 */
function ensureWindowsRegistryPathEntries(env: Record<string, string | undefined>): void {
  const registryPath = resolveWindowsRegistryPath();
  if (!registryPath) return;

  const currentPath = env.PATH || '';
  const currentEntriesLower = new Set(
    currentPath.split(delimiter).map((entry) => entry.toLowerCase().replace(/\\$/, ''))
  );

  const missingEntries: string[] = [];
  for (const entry of registryPath.split(';')) {
    const trimmed = entry.trim();
    if (!trimmed) continue;
    // Normalize: remove trailing backslash for comparison
    const normalizedLower = trimmed.toLowerCase().replace(/\\$/, '');
    if (!currentEntriesLower.has(normalizedLower)) {
      missingEntries.push(trimmed);
      currentEntriesLower.add(normalizedLower); // prevent duplicates within registry entries
    }
  }

  if (missingEntries.length > 0) {
    // Append registry entries at the END so existing overrides (Git, shims) take priority
    env.PATH = currentPath ? `${currentPath}${delimiter}${missingEntries.join(delimiter)}` : missingEntries.join(delimiter);
    coworkLog('INFO', 'ensureWindowsRegistryPathEntries', `Appended ${missingEntries.length} missing PATH entries from Windows registry: ${missingEntries.join(', ')}`);
  }
}

/**
 * Cached git-bash path on Windows. Resolved once and reused.
 */
let cachedGitBashPath: string | null | undefined;
let cachedGitBashResolutionError: string | null | undefined;

function normalizeWindowsPath(input: string | undefined): string | null {
  if (!input) return null;
  const trimmed = input.trim().replace(/\r/g, '');
  if (!trimmed) return null;

  const unquoted = trimmed.replace(/^["']+|["']+$/g, '');
  if (!unquoted) return null;

  return unquoted.replace(/\//g, '\\');
}

function listWindowsCommandPaths(command: string): string[] {
  try {
    const output = execSync(command, { encoding: 'utf-8', timeout: 5000 });
    const parsed = output
      .split(/\r?\n/)
      .map((line) => normalizeWindowsPath(line))
      .filter((line): line is string => Boolean(line && existsSync(line)));
    return Array.from(new Set(parsed));
  } catch {
    return [];
  }
}

function listGitInstallPathsFromRegistry(): string[] {
  const registryKeys = [
    'HKCU\\Software\\GitForWindows',
    'HKLM\\Software\\GitForWindows',
    'HKLM\\Software\\WOW6432Node\\GitForWindows',
  ];

  const installRoots: string[] = [];

  for (const key of registryKeys) {
    try {
      const output = execSync(`reg query "${key}" /v InstallPath`, { encoding: 'utf-8', timeout: 5000 });
      for (const line of output.split(/\r?\n/)) {
        const match = line.match(/InstallPath\s+REG_\w+\s+(.+)$/i);
        const root = normalizeWindowsPath(match?.[1]);
        if (root) {
          installRoots.push(root);
        }
      }
    } catch {
      // registry key might not exist
    }
  }

  return Array.from(new Set(installRoots));
}

function getBundledGitBashCandidates(): string[] {
  const bundledRoots = app.isPackaged
    ? [join(process.resourcesPath, 'mingit')]
    : [
      join(__dirname, '..', '..', 'resources', 'mingit'),
      join(process.cwd(), 'resources', 'mingit'),
    ];

  const candidates: string[] = [];
  for (const root of bundledRoots) {
    // Prefer bin/bash.exe on Windows; invoking usr/bin/bash.exe directly may miss Git toolchain PATH.
    candidates.push(join(root, 'bin', 'bash.exe'));
    candidates.push(join(root, 'usr', 'bin', 'bash.exe'));
  }

  return candidates;
}

function checkWindowsGitBashHealth(bashPath: string): { ok: boolean; reason?: string } {
  try {
    if (!existsSync(bashPath)) {
      return { ok: false, reason: 'path does not exist' };
    }

    // Use a minimal env for the health check to avoid interference from
    // BASH_ENV, MSYS2_PATH_TYPE, or other env vars that could slow startup.
    // Only pass PATH + SYSTEMROOT (required for Windows DLL loading) + HOME.
    const healthEnv: Record<string, string> = {
      PATH: process.env.PATH || '',
      SYSTEMROOT: process.env.SYSTEMROOT || process.env.SystemRoot || 'C:\\Windows',
      HOME: process.env.HOME || process.env.USERPROFILE || '',
    };

    // Try non-login shell first (-c instead of -lc) for speed.
    // Login shells source /etc/profile which can be slow on some systems.
    // cygpath is a standalone binary and does not require a login shell.
    const fastResult = spawnSync(
      bashPath,
      ['-c', 'cygpath -u "C:\\\\Windows"'],
      {
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: true,
        env: healthEnv,
      }
    );

    const result = (fastResult.error || (typeof fastResult.status === 'number' && fastResult.status !== 0))
      // Non-login shell failed — retry with login shell and a longer timeout.
      // Some Git Bash builds require login shell to set up PATH for cygpath.
      ? spawnSync(
        bashPath,
        ['-lc', 'cygpath -u "C:\\\\Windows"'],
        {
          encoding: 'utf-8',
          timeout: 15000,
          windowsHide: true,
          env: healthEnv,
        }
      )
      : fastResult;

    if (result.error) {
      return { ok: false, reason: result.error.message };
    }

    if (typeof result.status === 'number' && result.status !== 0) {
      const stderr = (result.stderr || '').trim();
      const stdout = (result.stdout || '').trim();
      return {
        ok: false,
        reason: `exit ${result.status}${stderr ? `, stderr: ${stderr}` : ''}${stdout ? `, stdout: ${stdout}` : ''}`,
      };
    }

    const stdout = (result.stdout || '').trim();
    const stderr = (result.stderr || '').trim();
    const lines = stdout
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
    const lastNonEmptyLine = lines.length > 0 ? lines[lines.length - 1] : '';

    // Some Git Bash builds may print runtime warnings before the actual cygpath
    // output (for example, missing /dev/shm or /dev/mqueue directories).
    // Accept the check when the final non-empty line is a valid POSIX path.
    if (!/^\/[a-zA-Z]\//.test(lastNonEmptyLine)) {
      const diagnosticStdout = truncateDiagnostic(stdout || '(empty)');
      const diagnosticStderr = stderr ? `, stderr: ${truncateDiagnostic(stderr)}` : '';
      return { ok: false, reason: `unexpected cygpath output: ${diagnosticStdout}${diagnosticStderr}` };
    }

    return { ok: true };
  } catch (error) {
    return { ok: false, reason: error instanceof Error ? error.message : String(error) };
  }
}

function truncateDiagnostic(message: string, maxLength = 500): string {
  if (message.length <= maxLength) return message;
  return `${message.slice(0, maxLength - 3)}...`;
}

function getWindowsGitToolDirs(bashPath: string): string[] {
  const normalized = bashPath.replace(/\//g, '\\');
  const lower = normalized.toLowerCase();
  let gitRoot: string | null = null;

  if (lower.endsWith('\\usr\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\usr\\bin\\bash.exe'.length);
  } else if (lower.endsWith('\\bin\\bash.exe')) {
    gitRoot = normalized.slice(0, -'\\bin\\bash.exe'.length);
  }

  if (!gitRoot) {
    const bashDir = dirname(normalized);
    return [bashDir].filter((dir) => existsSync(dir));
  }

  const candidates = [
    join(gitRoot, 'cmd'),
    join(gitRoot, 'mingw64', 'bin'),
    join(gitRoot, 'usr', 'bin'),
    join(gitRoot, 'bin'),
  ];

  return candidates.filter((dir) => existsSync(dir));
}

function ensureElectronNodeShim(electronPath: string, npmBinDir?: string): string | null {
  try {
    const shimDir = join(app.getPath('userData'), 'cowork', 'bin');
    mkdirSync(shimDir, { recursive: true });
    coworkLog('INFO', 'resolveNodeShim', `Shim directory: ${shimDir}, electronPath: ${electronPath}, npmBinDir: ${npmBinDir || '(none)'}`);

    // --- node shim ---
    // Shell script (macOS/Linux/Windows git-bash)
    const nodeSh = join(shimDir, 'node');
    const nodeShContent = [
      '#!/usr/bin/env bash',
      'if [ -z "${LUMIAI_ELECTRON_PATH:-}" ]; then',
      '  echo "LUMIAI_ELECTRON_PATH is not set" >&2',
      '  exit 127',
      'fi',
      'exec env ELECTRON_RUN_AS_NODE=1 "${LUMIAI_ELECTRON_PATH}" "$@"',
      '',
    ].join('\n');

    writeFileSync(nodeSh, nodeShContent, 'utf8');
    try {
      chmodSync(nodeSh, 0o755);
    } catch {
      // Ignore chmod errors on file systems that do not support POSIX modes.
    }
    coworkLog('INFO', 'resolveNodeShim', `Created node bash shim: ${nodeSh}`);

    // Windows .cmd wrapper (only needed on Windows)
    if (process.platform === 'win32') {
      const nodeCmd = join(shimDir, 'node.cmd');
      const nodeCmdContent = [
        '@echo off',
        'if "%LUMIAI_ELECTRON_PATH%"=="" (',
        '  echo LUMIAI_ELECTRON_PATH is not set 1>&2',
        '  exit /b 127',
        ')',
        'set ELECTRON_RUN_AS_NODE=1',
        '"%LUMIAI_ELECTRON_PATH%" %*',
        '',
      ].join('\r\n');
      writeFileSync(nodeCmd, nodeCmdContent, 'utf8');
      coworkLog('INFO', 'resolveNodeShim', `Created node.cmd shim: ${nodeCmd}`);
    }

    // --- npx / npm shims ---
    // Create shims that invoke npx-cli.js / npm-cli.js from the bundled npm
    // package via the node shim above. This avoids relying on symlinks in
    // node_modules/.bin which do not work on Windows cross-platform builds.
    if (npmBinDir && existsSync(npmBinDir)) {
      const npxCliJs = join(npmBinDir, 'npx-cli.js');
      const npmCliJs = join(npmBinDir, 'npm-cli.js');

      // Convert to POSIX path for bash scripts on Windows (git-bash)
      const npxCliJsPosix = npxCliJs.replace(/\\/g, '/');
      const npmCliJsPosix = npmCliJs.replace(/\\/g, '/');

      coworkLog('INFO', 'resolveNodeShim', `npmBinDir exists: true, npx-cli.js exists: ${existsSync(npxCliJs)}, npm-cli.js exists: ${existsSync(npmCliJs)}`);

      if (existsSync(npxCliJs)) {
        // npx bash shim
        const npxSh = join(shimDir, 'npx');
        const npxShContent = [
          '#!/usr/bin/env bash',
          'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
          `exec "$SCRIPT_DIR/node" "${npxCliJsPosix}" "$@"`,
          '',
        ].join('\n');
        writeFileSync(npxSh, npxShContent, 'utf8');
        try { chmodSync(npxSh, 0o755); } catch { /* ignore */ }
        coworkLog('INFO', 'resolveNodeShim', `Created npx bash shim: ${npxSh} -> ${npxCliJsPosix}`);

        // npx.cmd for Windows — uses %LUMIAI_NPM_BIN_DIR% env var to avoid
        // hardcoding paths that may contain non-ASCII chars (breaks GBK cmd.exe).
        if (process.platform === 'win32') {
          const npxCmd = join(shimDir, 'npx.cmd');
          const npxCmdContent = [
            '@echo off',
            '"%~dp0node.cmd" "%LUMIAI_NPM_BIN_DIR%\\npx-cli.js" %*',
            '',
          ].join('\r\n');
          writeFileSync(npxCmd, npxCmdContent, 'utf8');
          coworkLog('INFO', 'resolveNodeShim', `Created npx.cmd shim: ${npxCmd} (using env var LUMIAI_NPM_BIN_DIR)`);
        }
      } else {
        coworkLog('WARN', 'resolveNodeShim', `npx-cli.js not found at: ${npxCliJs}`);
      }

      if (existsSync(npmCliJs)) {
        // npm bash shim
        const npmSh = join(shimDir, 'npm');
        const npmShContent = [
          '#!/usr/bin/env bash',
          'SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"',
          `exec "$SCRIPT_DIR/node" "${npmCliJsPosix}" "$@"`,
          '',
        ].join('\n');
        writeFileSync(npmSh, npmShContent, 'utf8');
        try { chmodSync(npmSh, 0o755); } catch { /* ignore */ }
        coworkLog('INFO', 'resolveNodeShim', `Created npm bash shim: ${npmSh} -> ${npmCliJsPosix}`);

        // npm.cmd for Windows — uses %LUMIAI_NPM_BIN_DIR% env var to avoid
        // hardcoding paths that may contain non-ASCII chars (breaks GBK cmd.exe).
        if (process.platform === 'win32') {
          const npmCmd = join(shimDir, 'npm.cmd');
          const npmCmdContent = [
            '@echo off',
            '"%~dp0node.cmd" "%LUMIAI_NPM_BIN_DIR%\\npm-cli.js" %*',
            '',
          ].join('\r\n');
          writeFileSync(npmCmd, npmCmdContent, 'utf8');
          coworkLog('INFO', 'resolveNodeShim', `Created npm.cmd shim: ${npmCmd} (using env var LUMIAI_NPM_BIN_DIR)`);
        }
      } else {
        coworkLog('WARN', 'resolveNodeShim', `npm-cli.js not found at: ${npmCliJs}`);
      }

      coworkLog('INFO', 'resolveNodeShim', `Created npx/npm shims pointing to: ${npmBinDir}`);
    } else {
      coworkLog('WARN', 'resolveNodeShim', `npmBinDir not available: ${npmBinDir || '(not provided)'}, exists: ${npmBinDir ? existsSync(npmBinDir) : 'N/A'}`);
    }

    // Verify shim files exist and are executable
    const shimFiles = ['node', 'npx', 'npm'];
    for (const name of shimFiles) {
      const shimPath = join(shimDir, name);
      const exists = existsSync(shimPath);
      if (exists) {
        try {
          const stat = statSync(shimPath);
          coworkLog('INFO', 'resolveNodeShim', `Shim verify: ${name} exists, mode=0o${stat.mode.toString(8)}, size=${stat.size}`);
        } catch (e) {
          coworkLog('WARN', 'resolveNodeShim', `Shim verify: ${name} exists but stat failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        coworkLog('WARN', 'resolveNodeShim', `Shim verify: ${name} NOT found at ${shimPath}`);
      }
    }

    return shimDir;
  } catch (error) {
    coworkLog('WARN', 'resolveNodeShim', `Failed to prepare Electron Node shim: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Resolve git-bash path on Windows.
 * Claude Code CLI requires git-bash for shell tool execution.
 * Priority: env var override > bundled PortableGit > installed Git > PATH lookup.
 * Every candidate must pass a health check (`cygpath -u`) before use.
 */
function resolveWindowsGitBashPath(): string | null {
  if (cachedGitBashPath !== undefined) return cachedGitBashPath;

  if (process.platform !== 'win32') {
    cachedGitBashPath = null;
    cachedGitBashResolutionError = null;
    return null;
  }

  const candidates: Array<{ path: string; source: string }> = [];
  const seen = new Set<string>();
  const failedCandidates: string[] = [];

  const pushCandidate = (candidatePath: string | null, source: string): void => {
    if (!candidatePath) return;
    const normalized = normalizeWindowsPath(candidatePath);
    if (!normalized) return;
    const key = normalized.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    candidates.push({ path: normalized, source });
  };

  // 1. Explicit env var (user override)
  pushCandidate(process.env.CLAUDE_CODE_GIT_BASH_PATH ?? null, 'env:CLAUDE_CODE_GIT_BASH_PATH');

  // 2. Bundled PortableGit (preferred default in LumiAi package)
  for (const bundledCandidate of getBundledGitBashCandidates()) {
    pushCandidate(bundledCandidate, 'bundled:resources/mingit');
  }

  // 3. Common Git for Windows installation paths
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const installCandidates = [
    join(programFiles, 'Git', 'bin', 'bash.exe'),
    join(programFiles, 'Git', 'usr', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'bin', 'bash.exe'),
    join(programFilesX86, 'Git', 'usr', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'bin', 'bash.exe'),
    join(localAppData, 'Programs', 'Git', 'usr', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'bash.exe'),
    join(userProfile, 'scoop', 'apps', 'git', 'current', 'usr', 'bin', 'bash.exe'),
    'C:\\Git\\bin\\bash.exe',
    'C:\\Git\\usr\\bin\\bash.exe',
  ];

  for (const installCandidate of installCandidates) {
    pushCandidate(installCandidate, 'installed:common-paths');
  }

  // 4. Query Git for Windows install root from registry
  const registryInstallRoots = listGitInstallPathsFromRegistry();
  for (const installRoot of registryInstallRoots) {
    const registryCandidates = [
      join(installRoot, 'bin', 'bash.exe'),
      join(installRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const registryCandidate of registryCandidates) {
      pushCandidate(registryCandidate, `registry:${installRoot}`);
    }
  }

  // 5. Try `where bash`
  const bashPaths = listWindowsCommandPaths('where bash');
  for (const bashPath of bashPaths) {
    if (bashPath.toLowerCase().endsWith('\\bash.exe')) {
      pushCandidate(bashPath, 'path:where bash');
    }
  }

  // 6. Try `where git` and derive bash from git location
  const gitPaths = listWindowsCommandPaths('where git');
  for (const gitPath of gitPaths) {
    const gitRoot = dirname(dirname(gitPath));
    const bashCandidates = [
      join(gitRoot, 'bin', 'bash.exe'),
      join(gitRoot, 'usr', 'bin', 'bash.exe'),
    ];
    for (const bashCandidate of bashCandidates) {
      pushCandidate(bashCandidate, `path:where git (${gitPath})`);
    }
  }

  for (const candidate of candidates) {
    if (!existsSync(candidate.path)) {
      continue;
    }

    const health = checkWindowsGitBashHealth(candidate.path);
    if (health.ok) {
      coworkLog('INFO', 'resolveGitBash', `Selected git-bash (${candidate.source}): ${candidate.path}`);
      cachedGitBashPath = candidate.path;
      cachedGitBashResolutionError = null;
      return candidate.path;
    }

    const failure = `${candidate.path} [${candidate.source}] failed health check (${health.reason || 'unknown reason'})`;
    failedCandidates.push(failure);
    coworkLog('WARN', 'resolveGitBash', failure);
  }

  const diagnostic = failedCandidates.length > 0
    ? `No healthy git-bash found. Failures: ${failedCandidates.join('; ')}`
    : 'No git-bash candidates found on this system';
  coworkLog('WARN', 'resolveGitBash', diagnostic);
  cachedGitBashPath = null;
  cachedGitBashResolutionError = truncateDiagnostic(diagnostic);
  return null;
}

// Re-export for use by other modules
export { ensureWindowsRegistryPathEntries, resolveWindowsGitBashPath };
export { checkWindowsGitBashHealth, truncateDiagnostic, normalizeWindowsPath, getWindowsGitToolDirs, ensureElectronNodeShim };
export { resolveUserShellPath };
export { appendEnvPath, hasCommandInEnv };
