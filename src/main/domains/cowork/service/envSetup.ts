import { app } from 'electron';
import { spawnSync } from 'child_process';
import { existsSync, mkdirSync, writeFileSync, chmodSync } from 'fs';
import { delimiter, join } from 'path';
import { coworkLog } from './coworkLogger';
import { appendPythonRuntimeToEnv } from '../../skill/service/pythonRuntime';
import { ensureWindowsRegistryPathEntries } from './windowsRuntime';
import { getElectronNodeRuntimePath, resolveWindowsGitBashPath } from './windowsRuntime';
import { checkWindowsGitBashHealth, truncateDiagnostic, normalizeWindowsPath, getWindowsGitToolDirs } from './windowsRuntime';
import { appendEnvPath, hasCommandInEnv } from './windowsRuntime';
import { resolveUserShellPath, ensureElectronNodeShim } from './windowsRuntime';

/**
 * Windows system directories that must be in PATH for built-in commands
 * (ipconfig, systeminfo, netstat, ping, nslookup, etc.) to work.
 */
const WINDOWS_SYSTEM_PATH_ENTRIES = [
  'System32',
  'System32\\Wbem',
  'System32\\WindowsPowerShell\\v1.0',
  'System32\\OpenSSH',
];

/**
 * Critical Windows environment variables that some system commands and DLLs depend on.
 * Without these, commands like ipconfig may fail even if System32 is in PATH.
 */
const WINDOWS_CRITICAL_ENV_VARS: Record<string, () => string | undefined> = {
  SystemRoot: () => process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\windows',
  windir: () => process.env.windir || process.env.WINDIR || process.env.SystemRoot || process.env.SYSTEMROOT || 'C:\\windows',
  COMSPEC: () => process.env.COMSPEC || process.env.comspec || 'C:\\windows\\system32\\cmd.exe',
  SYSTEMDRIVE: () => process.env.SYSTEMDRIVE || process.env.SystemDrive || 'C:',
};

/**
 * Ensure critical Windows system environment variables are present in the env object.
 *
 * Packaged Electron apps or certain launch contexts may strip environment variables
 * like SystemRoot, windir, COMSPEC, and SYSTEMDRIVE. Many Windows system commands
 * and DLLs depend on these variables to locate system resources.
 *
 * Additionally, the Claude Agent SDK's shell snapshot mechanism runs `echo $PATH`
 * via `shell: true`, which on Windows uses cmd.exe. The captured PATH is then
 * baked into the snapshot file. If these critical variables are missing, the shell
 * environment may be broken and commands fail silently.
 */
function ensureWindowsSystemEnvVars(env: Record<string, string | undefined>): void {
  const injected: string[] = [];

  for (const [key, resolver] of Object.entries(WINDOWS_CRITICAL_ENV_VARS)) {
    // Check both the exact case and common variants (Windows env vars are case-insensitive
    // but Node.js process.env on Windows normalizes to the original casing)
    if (!env[key]) {
      const value = resolver();
      if (value) {
        env[key] = value;
        injected.push(`${key}=${value}`);
      }
    }
  }

  if (injected.length > 0) {
    coworkLog('INFO', 'ensureWindowsSystemEnvVars', `Injected missing Windows system env vars: ${injected.join(', ')}`);
  }
}

/**
 * Ensure Windows system directories (System32, etc.) are present in PATH.
 *
 * When the Electron app launches, process.env.PATH normally includes System32.
 * However, the Claude Agent SDK creates a "shell snapshot" by running git-bash
 * with `-c -l` (login shell). The git-bash `/etc/profile` rebuilds PATH based on
 * MSYS2_PATH_TYPE (default: "inherit"), which preserves ORIGINAL_PATH from the
 * inherited environment. If System32 entries are somehow missing from the inherited
 * PATH, they won't appear in the snapshot either.
 *
 * This function ensures that essential Windows system directories are always
 * present in PATH before the environment is handed to the SDK.
 */
function ensureWindowsSystemPathEntries(env: Record<string, string | undefined>): void {
  const systemRoot = env.SystemRoot || env.SYSTEMROOT || 'C:\\windows';
  const currentPath = env.PATH || '';
  const currentEntries = currentPath.split(delimiter).map((entry) => entry.toLowerCase());

  const missingDirs: string[] = [];
  for (const relDir of WINDOWS_SYSTEM_PATH_ENTRIES) {
    const fullDir = join(systemRoot, relDir);
    if (!currentEntries.includes(fullDir.toLowerCase()) && existsSync(fullDir)) {
      missingDirs.push(fullDir);
    }
  }

  // Also ensure the systemRoot itself (e.g. C:\windows) is in PATH
  if (!currentEntries.includes(systemRoot.toLowerCase()) && existsSync(systemRoot)) {
    missingDirs.push(systemRoot);
  }

  if (missingDirs.length > 0) {
    // Append system dirs at the END so they don't override user tools
    env.PATH = currentPath ? `${currentPath}${delimiter}${missingDirs.join(delimiter)}` : missingDirs.join(delimiter);
    coworkLog('INFO', 'ensureWindowsSystemPathEntries', `Appended missing Windows system PATH entries: ${missingDirs.join(', ')}`);
  }
}

/**
 * Ensure non-login git-bash invocations can resolve core MSYS commands.
 *
 * Claude Agent SDK invokes `cygpath` during Windows path normalization via
 * `execSync(..., { shell: bash.exe })`, which does NOT always run a login shell.
 * In that code path, bash may inherit Windows-format PATH directly, and command
 * lookup for `cygpath` can fail because PATH is semicolon-delimited.
 *
 * Prefixing PATH with `/usr/bin:/bin` keeps Windows PATH semantics (semicolon
 * delimiter) while giving bash a valid colon-delimited segment at the beginning.
 * This prevents errors like: `/bin/bash: line 1: cygpath: command not found`.
 */
function ensureWindowsBashBootstrapPath(env: Record<string, string | undefined>): void {
  const currentPath = env.PATH || '';
  if (!currentPath) return;

  const bootstrapToken = '/usr/bin:/bin';
  const entries = currentPath.split(delimiter).map((entry) => entry.trim()).filter(Boolean);
  if (entries.some((entry) => entry === bootstrapToken)) {
    return;
  }

  env.PATH = `${bootstrapToken}${delimiter}${currentPath}`;
  coworkLog('INFO', 'ensureWindowsBashBootstrapPath', `Prepended bash bootstrap PATH token: ${bootstrapToken}`);
}

/**
 * Convert a single Windows path to MSYS2/POSIX format.
 *
 * When the Windows path contains non-ASCII characters (e.g. Chinese usernames
 * like C:\Users\中文用户\...), MSYS2's automatic Windows→POSIX conversion may
 * corrupt the path if it runs before LANG=C.UTF-8 takes effect. Pre-converting
 * to POSIX format (/c/Users/中文用户/...) bypasses this problematic conversion
 * because MSYS2 recognises the value as already POSIX and passes it through
 * directly to its internal wide-char file APIs.
 */
function singleWindowsPathToPosix(windowsPath: string): string {
  if (!windowsPath) return windowsPath;
  const driveMatch = windowsPath.match(/^([A-Za-z]):[/\\](.*)/);
  if (driveMatch) {
    const driveLetter = driveMatch[1].toLowerCase();
    const rest = driveMatch[2].replace(/\\/g, '/').replace(/\/+$/, '');
    return `/${driveLetter}${rest ? '/' + rest : ''}`;
  }
  return windowsPath.replace(/\\/g, '/');
}

/**
 * Convert a Windows-format PATH string to MSYS2/POSIX format for git-bash.
 *
 * Windows PATH uses semicolons (;) as delimiters and backslash paths (C:\...),
 * while MSYS2 bash expects colons (:) and forward-slash POSIX paths (/c/...).
 *
 * When Node.js passes env vars to a forked process, PATH stays in Windows format.
 * If the CLI later spawns git-bash, the /etc/profile uses ORIGINAL_PATH="${PATH}"
 * and appends it to the new PATH with a colon. But since the Windows PATH still
 * has semicolons inside, it becomes one giant invalid path entry.
 *
 * This function converts each semicolon-separated Windows path entry to its
 * POSIX equivalent so that git-bash can correctly parse all entries.
 */
function convertWindowsPathToMsys(windowsPath: string): string {
  if (!windowsPath) return windowsPath;

  const entries = windowsPath.split(';').filter(Boolean);
  const converted: string[] = [];

  for (const entry of entries) {
    const trimmed = entry.trim();
    if (!trimmed) continue;

    // Convert Windows path to POSIX: C:\foo\bar → /c/foo/bar
    // Drive letter pattern: X:\ or X:/
    const driveMatch = trimmed.match(/^([A-Za-z]):[/\\](.*)/);
    if (driveMatch) {
      const driveLetter = driveMatch[1].toLowerCase();
      const rest = driveMatch[2].replace(/\\/g, '/').replace(/\/+$/, '');
      converted.push(`/${driveLetter}${rest ? '/' + rest : ''}`);
    } else if (trimmed.startsWith('/')) {
      // Already POSIX-style
      converted.push(trimmed);
    } else {
      // Relative path or unknown format, convert backslashes
      converted.push(trimmed.replace(/\\/g, '/'));
    }
  }

  return converted.join(':');
}

/**
 * Set ORIGINAL_PATH with POSIX-converted PATH for git-bash to inherit.
 *
 * Git-bash's /etc/profile (with MSYS2_PATH_TYPE=inherit) reads ORIGINAL_PATH
 * and appends it to the MSYS2 PATH. However, if ORIGINAL_PATH contains
 * Windows-format paths (semicolons, backslashes), bash treats them as a single
 * invalid entry because it uses colons as the PATH delimiter.
 *
 * By pre-setting ORIGINAL_PATH to the POSIX-converted version of our PATH,
 * we ensure that /etc/profile appends properly formatted, colon-separated
 * paths that bash can actually use.
 */
function ensureWindowsOriginalPath(env: Record<string, string | undefined>): void {
  const currentPath = env.PATH || '';
  if (!currentPath) return;

  const posixPath = convertWindowsPathToMsys(currentPath);
  env.ORIGINAL_PATH = posixPath;
  coworkLog('INFO', 'ensureWindowsOriginalPath', `Set ORIGINAL_PATH with ${posixPath.split(':').length} POSIX-format entries`);
}

/**
 * Create a bash init script that sets the Windows console code page to UTF-8 (65001).
 *
 * On Chinese Windows, the default console code page is GBK (936). When git-bash
 * executes Windows native commands (dir, ipconfig, systeminfo, net, type, etc.),
 * they output text encoded in the active console code page. If the code page is GBK,
 * the output contains GBK-encoded bytes, but the Claude Agent SDK reads them as UTF-8,
 * producing garbled characters (mojibake).
 *
 * By setting BASH_ENV to this script, every non-interactive bash session spawned by
 * the Claude Agent SDK will automatically switch the console code page to UTF-8
 * before executing any commands.
 */
function ensureWindowsBashUtf8InitScript(): string | null {
  try {
    const initDir = join(app.getPath('userData'), 'cowork', 'bin');
    mkdirSync(initDir, { recursive: true });

    const initScript = join(initDir, 'bash_utf8_init.sh');
    const content = [
      '#!/usr/bin/env bash',
      '# Auto-generated by LumiAi – switch Windows console code page to UTF-8',
      '# to prevent garbled output from Windows native commands.',
      'if command -v chcp.com >/dev/null 2>&1; then',
      '  chcp.com 65001 >/dev/null 2>&1',
      'fi',
      '',
    ].join('\n');

    writeFileSync(initScript, content, 'utf8');
    try {
      chmodSync(initScript, 0o755);
    } catch {
      // Ignore chmod errors on file systems that do not support POSIX modes.
    }

    return initScript;
  } catch (error) {
    coworkLog('WARN', 'ensureWindowsBashUtf8InitScript', `Failed to create bash UTF-8 init script: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Verify that node/npx/npm can be resolved from the constructed environment PATH.
 * Logs diagnostic info for debugging MCP server startup issues on macOS.
 */
function verifyNodeEnvironment(env: Record<string, string | undefined>): void {
  const tag = 'verifyNodeEnv';
  const pathValue = env.PATH || '';

  // Log final PATH entries
  const pathEntries = pathValue.split(delimiter);
  coworkLog('INFO', tag, `Final PATH has ${pathEntries.length} entries:`);
  for (let i = 0; i < pathEntries.length; i++) {
    const entry = pathEntries[i];
    const exists = entry ? existsSync(entry) : false;
    coworkLog('INFO', tag, `  [${i}] ${entry} (exists: ${exists})`);
  }

  // Try to resolve node, npx, npm using 'which' (macOS/Linux) or 'where' (Windows)
  const whichCmd = process.platform === 'win32' ? 'where' : 'which';
  for (const tool of ['node', 'npx', 'npm']) {
    try {
      const result = spawnSync(whichCmd, [tool], {
        env: { ...env } as NodeJS.ProcessEnv,
        encoding: 'utf-8',
        timeout: 5000,
        windowsHide: process.platform === 'win32',
      });
      if (result.status === 0 && result.stdout) {
        const resolved = result.stdout.trim();
        coworkLog('INFO', tag, `${whichCmd} ${tool} => ${resolved}`);
        const resolvedCandidates = resolved
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean);
        const resolvedForExec = process.platform === 'win32'
          ? resolvedCandidates.find((candidate) => /\.(cmd|exe|bat)$/i.test(candidate)) || resolvedCandidates[0]
          : resolvedCandidates[0];

        // Try to get version
        if (tool === 'node' && resolvedForExec) {
          try {
            let execTarget = resolvedForExec;
            if (process.platform === 'win32' && /\.cmd$/i.test(resolvedForExec)) {
              execTarget = env.LUMIAI_ELECTRON_PATH || process.execPath;
            }
            const versionResult = spawnSync(execTarget, ['--version'], {
              env: { ...env, ELECTRON_RUN_AS_NODE: '1' } as NodeJS.ProcessEnv,
              encoding: 'utf-8',
              timeout: 5000,
              windowsHide: process.platform === 'win32',
            });
            coworkLog('INFO', tag, `node --version (${execTarget}) => ${(versionResult.stdout || '').trim()} (exit: ${versionResult.status})`);
            if (versionResult.error) {
              coworkLog('WARN', tag, `node --version spawn error: ${versionResult.error.message}`);
            }
            if (versionResult.stderr) {
              coworkLog('WARN', tag, `node --version stderr: ${versionResult.stderr.trim()}`);
            }
          } catch (e) {
            coworkLog('WARN', tag, `node --version failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      } else {
        coworkLog('WARN', tag, `${whichCmd} ${tool} => NOT FOUND (exit: ${result.status}, stderr: ${(result.stderr || '').trim()})`);
      }
    } catch (e) {
      coworkLog('WARN', tag, `${whichCmd} ${tool} threw: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // Log key env vars
  coworkLog('INFO', tag, `NODE_PATH=${env.NODE_PATH || '(not set)'}`);
  coworkLog('INFO', tag, `LUMIAI_ELECTRON_PATH=${env.LUMIAI_ELECTRON_PATH || '(not set)'}`);
  coworkLog('INFO', tag, `LUMIAI_NPM_BIN_DIR=${env.LUMIAI_NPM_BIN_DIR || '(not set)'}`);
  coworkLog('INFO', tag, `HOME=${env.HOME || '(not set)'}`);
}

export function applyPackagedEnvOverrides(env: Record<string, string | undefined>): void {
  const electronNodeRuntimePath = getElectronNodeRuntimePath();

  if (app.isPackaged && !env.LUMIAI_ELECTRON_PATH) {
    env.LUMIAI_ELECTRON_PATH = electronNodeRuntimePath;
  }

  // On Windows, resolve git-bash and ensure Git toolchain directories are available in PATH.
  if (process.platform === 'win32') {
    env.LUMIAI_ELECTRON_PATH = electronNodeRuntimePath;

    // Force UTF-8 encoding for MSYS2/git-bash.
    //
    // On Chinese (and other non-Latin) Windows systems, the default system locale
    // uses GBK (code page 936) or similar legacy encodings. Without explicit locale
    // settings, MSYS2 tools and the git-bash environment may output text in the
    // system's legacy encoding, which the Claude Agent SDK misinterprets as UTF-8,
    // producing garbled characters.
    //
    // Setting LANG and LC_ALL to C.UTF-8 tells the MSYS2 runtime to use UTF-8 for
    // all text I/O, including output from coreutils (ls, cat, grep, etc.).
    if (!env.LANG) {
      env.LANG = 'C.UTF-8';
    }
    if (!env.LC_ALL) {
      env.LC_ALL = 'C.UTF-8';
    }

    // Force Python to use UTF-8 mode (PEP 540, Python 3.7+).
    // Without this, Python on Chinese Windows defaults to GBK for stdin/stdout/stderr
    // and file I/O, causing garbled output when the SDK reads it as UTF-8.
    if (!env.PYTHONUTF8) {
      env.PYTHONUTF8 = '1';
    }
    if (!env.PYTHONIOENCODING) {
      env.PYTHONIOENCODING = 'utf-8';
    }

    // Force `less` and `git` pager output to use UTF-8.
    if (!env.LESSCHARSET) {
      env.LESSCHARSET = 'utf-8';
    }

    // Create a bash init script that switches the Windows console code page to
    // UTF-8 (65001). By setting BASH_ENV, every non-interactive bash session
    // spawned by the Claude Agent SDK will source this script before executing
    // commands, ensuring Windows native commands (dir, ipconfig, systeminfo,
    // type, etc.) output UTF-8 instead of GBK.
    if (!env.BASH_ENV) {
      const initScript = ensureWindowsBashUtf8InitScript();
      if (initScript) {
        // Convert to MSYS2 POSIX format to avoid encoding issues when the
        // path contains non-ASCII characters (e.g. Chinese Windows username).
        // MSYS2's automatic Windows→POSIX conversion can corrupt non-ASCII
        // chars if it runs before LANG=C.UTF-8 takes effect during DLL init.
        env.BASH_ENV = singleWindowsPathToPosix(initScript);
        coworkLog('INFO', 'applyPackagedEnvOverrides', `Set BASH_ENV for UTF-8 console code page: ${env.BASH_ENV}`);
      }
    }

    // Ensure critical Windows system environment variables are always present.
    // Packaged Electron apps or certain launch contexts may lack these variables,
    // which causes Windows built-in commands (ipconfig, systeminfo, netstat, etc.)
    // to fail when executed inside git-bash via the Claude Agent SDK.
    ensureWindowsSystemEnvVars(env);

    // Ensure Windows system directories (System32, etc.) are always in PATH.
    // The Claude Agent SDK's shell snapshot mechanism captures PATH and may lose
    // system directories if they were missing from the inherited environment.
    ensureWindowsSystemPathEntries(env);

    // Merge the latest PATH entries from the Windows registry (Machine + User).
    // When the Electron app is launched from Explorer/Start Menu, process.env.PATH
    // may be stale and missing tools installed after Explorer started (e.g. Python,
    // Node.js, npm). Reading from the registry ensures we get the latest values,
    // similar to how a freshly opened terminal would.
    ensureWindowsRegistryPathEntries(env);

    const configuredBashPath = normalizeWindowsPath(env.CLAUDE_CODE_GIT_BASH_PATH);
    let bashPath = configuredBashPath && existsSync(configuredBashPath)
      ? configuredBashPath
      : resolveWindowsGitBashPath();

    if (configuredBashPath && bashPath === configuredBashPath) {
      const configuredHealth = checkWindowsGitBashHealth(configuredBashPath);
      if (!configuredHealth.ok) {
        const fallbackPath = resolveWindowsGitBashPath();
        if (fallbackPath && fallbackPath !== configuredBashPath) {
          coworkLog(
            'WARN',
            'resolveGitBash',
            `Configured bash is unhealthy (${configuredBashPath}): ${configuredHealth.reason || 'unknown reason'}. Falling back to: ${fallbackPath}`
          );
          bashPath = fallbackPath;
        } else {
          const diagnostic = truncateDiagnostic(
            `Configured bash is unhealthy (${configuredBashPath}): ${configuredHealth.reason || 'unknown reason'}`
          );
          env.LUMIAI_GIT_BASH_RESOLUTION_ERROR = diagnostic;
          coworkLog('WARN', 'resolveGitBash', diagnostic);
          bashPath = null;
        }
      }
    }

    if (bashPath) {
      env.CLAUDE_CODE_GIT_BASH_PATH = bashPath;
      delete env.LUMIAI_GIT_BASH_RESOLUTION_ERROR;
      coworkLog('INFO', 'resolveGitBash', `Using Windows git-bash: ${bashPath}`);
      const gitToolDirs = getWindowsGitToolDirs(bashPath);
      env.PATH = appendEnvPath(env.PATH, gitToolDirs);
      coworkLog('INFO', 'resolveGitBash', `Injected Windows Git toolchain PATH entries: ${gitToolDirs.join(', ')}`);
      ensureWindowsBashBootstrapPath(env);
    } else {
      const diagnostic = 'git-bash not found or failed health checks';
      env.LUMIAI_GIT_BASH_RESOLUTION_ERROR = truncateDiagnostic(diagnostic);
    }

    appendPythonRuntimeToEnv(env);

    // Tell git-bash to inherit the PATH from the parent process instead of
    // rebuilding it from scratch. Without this, git-bash's /etc/profile (login
    // shell) defaults to constructing a minimal PATH containing only Windows
    // system directories + MSYS2 tools, discarding user-installed tool paths
    // like Python, Node.js, npm, pip, etc. Setting MSYS2_PATH_TYPE=inherit
    // makes git-bash preserve the full PATH we've carefully constructed above.
    if (!env.MSYS2_PATH_TYPE) {
      env.MSYS2_PATH_TYPE = 'inherit';
      coworkLog('INFO', 'applyPackagedEnvOverrides', 'Set MSYS2_PATH_TYPE=inherit to preserve PATH in git-bash');
    }

    // Pre-set ORIGINAL_PATH in POSIX format so git-bash's /etc/profile can use it.
    //
    // ROOT CAUSE: Node.js env PATH on Windows uses semicolons (;) and backslash
    // paths (C:\...). When the Claude Agent SDK's CLI spawns git-bash with this env,
    // /etc/profile reads ORIGINAL_PATH="${ORIGINAL_PATH:-${PATH}}" and appends it
    // with a colon. But the semicolons in the Windows PATH are NOT converted to
    // colons, so "C:\nodejs;C:\python" becomes one giant invalid entry instead of
    // two separate paths. This causes `npm`, `python`, `pip` etc. to be unfindable.
    //
    // By pre-setting ORIGINAL_PATH to the POSIX-converted version (/c/nodejs:/c/python),
    // /etc/profile uses it directly and bash can correctly parse all PATH entries.
    // This MUST be done AFTER all PATH modifications above so the full PATH is captured.
    ensureWindowsOriginalPath(env);
  }

  if (!app.isPackaged) {
    // In dev mode, prepend project's node_modules/.bin to PATH so bundled
    // npx/npm are found even if the user has no global Node.js installation.
    const devBinDir = join(app.getAppPath(), 'node_modules', '.bin');
    if (existsSync(devBinDir)) {
      env.PATH = [devBinDir, env.PATH].filter(Boolean).join(delimiter);
      coworkLog('INFO', 'applyPackagedEnvOverrides', `Dev mode: prepended node_modules/.bin to PATH: ${devBinDir}`);
    }
    return;
  }

  if (!env.HOME) {
    env.HOME = app.getPath('home');
  }

  // Resolve user's shell PATH so that node, npm, and other tools are findable
  const userPath = resolveUserShellPath();
  if (userPath) {
    env.PATH = userPath;
    coworkLog('INFO', 'applyPackagedEnvOverrides', `Resolved user shell PATH (${userPath.split(delimiter).length} entries)`);
    for (const entry of userPath.split(delimiter)) {
      coworkLog('INFO', 'applyPackagedEnvOverrides', `  PATH entry: ${entry} (exists: ${existsSync(entry)})`);
    }
  } else {
    // Fallback: append common node installation paths
    const home = env.HOME || app.getPath('home');
    const commonPaths = [
      '/usr/local/bin',
      '/opt/homebrew/bin',
      `${home}/.nvm/current/bin`,
      `${home}/.volta/bin`,
      `${home}/.fnm/current/bin`,
    ];
    env.PATH = [env.PATH, ...commonPaths].filter(Boolean).join(delimiter);
    coworkLog('WARN', 'applyPackagedEnvOverrides', `Failed to resolve user shell PATH, using fallback common paths`);
  }

  const resourcesPath = process.resourcesPath;
  coworkLog('INFO', 'applyPackagedEnvOverrides', `Packaged mode: resourcesPath=${resourcesPath}`);

  // Create node/npx/npm shims that wrap Electron as a Node.js runtime via
  // ELECTRON_RUN_AS_NODE=1 and point npx/npm to the bundled npm package.
  // This avoids relying on node_modules/.bin symlinks which don't work on
  // Windows cross-platform builds.
  const npmBinDir = join(resourcesPath, 'app.asar.unpacked', 'node_modules', 'npm', 'bin');
  coworkLog('INFO', 'applyPackagedEnvOverrides', `npmBinDir=${npmBinDir}, exists=${existsSync(npmBinDir)}`);

  // Set env var so .cmd shims can reference npmBinDir without hardcoding
  // non-ASCII characters (which break on Windows when cmd.exe uses GBK code page).
  env.LUMIAI_NPM_BIN_DIR = npmBinDir;

  const hasSystemNode = hasCommandInEnv('node', env);
  const hasSystemNpx = hasCommandInEnv('npx', env);
  const hasSystemNpm = hasCommandInEnv('npm', env);
  const shouldForcePackagedDarwinShim = app.isPackaged && process.platform === 'darwin';
  const shouldInjectShim = shouldForcePackagedDarwinShim
    || process.platform === 'win32'
    || !(hasSystemNode && hasSystemNpx && hasSystemNpm);
  if (shouldInjectShim) {
    const shimDir = ensureElectronNodeShim(electronNodeRuntimePath, npmBinDir);
    if (shimDir) {
      env.PATH = [shimDir, env.PATH].filter(Boolean).join(delimiter);
      env.LUMIAI_NODE_SHIM_ACTIVE = '1';
      coworkLog('INFO', 'resolveNodeShim', `Injected Electron Node/npx/npm shim PATH entry: ${shimDir}`);
      if (shouldForcePackagedDarwinShim) {
        coworkLog('INFO', 'resolveNodeShim', 'Packaged macOS build: forcing bundled Electron node/npx/npm shims to avoid stale system Node versions');
      }

      // Re-compute ORIGINAL_PATH after shim injection so that git-bash
      // also sees the bundled node/npx/npm in its PATH.
      if (process.platform === 'win32') {
        ensureWindowsOriginalPath(env);
      }
    }
  } else {
    delete env.LUMIAI_NODE_SHIM_ACTIVE;
    coworkLog('INFO', 'resolveNodeShim', 'System node/npx/npm detected; skipped Electron node shim injection');
  }

  const nodePaths = [
    join(resourcesPath, 'app.asar', 'node_modules'),
    join(resourcesPath, 'app.asar.unpacked', 'node_modules'),
  ].filter((nodePath) => existsSync(nodePath));

  if (nodePaths.length > 0) {
    env.NODE_PATH = appendEnvPath(env.NODE_PATH, nodePaths);
  }

  // Verify node/npx resolution in the constructed environment
  verifyNodeEnvironment(env);
}
