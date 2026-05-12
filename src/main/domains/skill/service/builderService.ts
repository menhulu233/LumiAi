import { app, session } from 'electron';
import { execSync, spawn, spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import extractZip from 'extract-zip';
import { getElectronNodeRuntimePath } from '../../../libs/coworkUtil';
import { appendPythonRuntimeToEnv } from '../../../libs/pythonRuntime';
import { SkillRegistryStore, cleanupPathSafely, normalizeFolderName, resolveWithin, isZipFile, compareVersions, SKILLS_DIR_NAME, SKILL_FILE_NAME } from '../store/registryStore';
import { SkillRunnerService, runScriptWithTimeout } from './runnerService';
import {
  SkillRecord,
  NormalizedGitSource,
  GithubRepoSource,
  SkillScriptRunResult,
} from '../types';

/**
 * Resolve the user's login shell PATH on macOS/Linux.
 * Packaged Electron apps on macOS don't inherit the user's shell profile,
 * so node/npm won't be in PATH unless we resolve it explicitly.
 */
function resolveUserShellPath(): string | null {
  if (process.platform === 'win32') return null;

  try {
    const shell = process.env.SHELL || '/bin/bash';
    // Use non-interactive login shell to avoid side effects in interactive startup scripts.
    const result = execSync(`${shell} -lc 'echo __PATH__=$PATH'`, {
      encoding: 'utf-8',
      timeout: 5000,
      env: { ...process.env },
    });
    const match = result.match(/__PATH__=(.+)/);
    return match ? match[1].trim() : null;
  } catch (error) {
    console.warn('[skills] Failed to resolve user shell PATH:', error);
    return null;
  }
}

/**
 * Check if a command exists in the given environment.
 */
function hasCommand(command: string, env: NodeJS.ProcessEnv): boolean {
  const isWin = process.platform === 'win32';
  const checker = isWin ? 'where' : 'which';
  // On Windows, use shell: true so cmd.exe resolves PATH correctly
  // (avoids issues with duplicated PATH/Path keys in env)
  const result = spawnSync(checker, [command], {
    stdio: 'pipe',
    env,
    shell: isWin,
    timeout: 5000,
  });
  if (result.status !== 0) {
    console.log(`[skills] hasCommand('${command}'): not found (status=${result.status}, error=${result.error?.message || 'none'})`);
  }
  return result.status === 0;
}

/**
 * Normalize the PATH key in an env object on Windows.
 * Windows env vars are case-insensitive, but JS objects are case-sensitive.
 * After spreading process.env, the key might be "Path" or "PATH".
 * We normalize to "PATH" to avoid issues with duplicate keys.
 */
function normalizePathKey(env: Record<string, string | undefined>): void {
  if (process.platform !== 'win32') return;

  const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
  if (pathKeys.length <= 1) return;

  // Merge all PATH-like values (separated by ;), then remove duplicates
  const seen = new Set<string>();
  const merged: string[] = [];
  for (const key of pathKeys) {
    const value = env[key];
    if (!value) continue;
    for (const entry of value.split(';')) {
      const trimmed = entry.trim();
      if (!trimmed) continue;
      const normalized = trimmed.toLowerCase().replace(/[\\/]+$/, '');
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      merged.push(trimmed);
    }
    if (key !== 'PATH') {
      delete env[key];
    }
  }
  env.PATH = merged.join(';');
}

/**
 * Resolve the latest Windows system PATH from the registry.
 * When an Electron app is launched from Start Menu or Explorer,
 * process.env.PATH may be stale (missing tools installed after Explorer started).
 */
function resolveWindowsRegistryPath(): string | null {
  if (process.platform !== 'win32') return null;

  try {
    const machinePath = execSync(
      'reg query "HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment" /v Path',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );
    const userPath = execSync(
      'reg query "HKCU\\Environment" /v Path',
      { encoding: 'utf-8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] }
    );

    const extract = (output: string): string => {
      const match = output.match(/Path\s+REG_(?:EXPAND_)?SZ\s+(.+)/i);
      return match ? match[1].trim() : '';
    };

    const combined = [extract(machinePath), extract(userPath)].filter(Boolean).join(';');
    return combined || null;
  } catch {
    return null;
  }
}

/**
 * Build an environment for spawning skill scripts.
 * Merges the user's shell PATH with the current process environment.
 */
export function buildSkillEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };

  // Normalize PATH key casing on Windows to avoid duplicate PATH/Path issues
  normalizePathKey(env);

  if (app.isPackaged) {
    // Ensure HOME is set (crucial for npm to find its config)
    if (!env.HOME) {
      env.HOME = app.getPath('home');
    }

    if (process.platform === 'win32') {
      // On Windows, merge the latest PATH from the registry to pick up
      // tools installed after the Electron app (or Explorer) was started.
      const registryPath = resolveWindowsRegistryPath();
      if (registryPath) {
        const currentPath = env.PATH || '';
        const seen = new Set(currentPath.toLowerCase().split(';').map(s => s.trim().replace(/[\\/]+$/, '')).filter(Boolean));
        const extra: string[] = [];
        for (const entry of registryPath.split(';')) {
          const trimmed = entry.trim();
          if (!trimmed) continue;
          const key = trimmed.toLowerCase().replace(/[\\/]+$/, '');
          if (!seen.has(key)) {
            seen.add(key);
            extra.push(trimmed);
          }
        }
        if (extra.length > 0) {
          env.PATH = currentPath ? `${currentPath};${extra.join(';')}` : extra.join(';');
          console.log('[skills] Merged registry PATH entries for skill scripts');
        }
      }

      // Append common Windows Node.js installation paths as fallback
      const commonWinPaths = [
        'C:\\Program Files\\nodejs',
        'C:\\Program Files (x86)\\nodejs',
        `${env.APPDATA || ''}\\npm`,
        `${env.LOCALAPPDATA || ''}\\Programs\\nodejs`,
      ].filter(Boolean);

      const pathSet = new Set((env.PATH || '').toLowerCase().split(';').map(s => s.trim().replace(/[\\/]+$/, '')));
      const missingPaths = commonWinPaths.filter(p => !pathSet.has(p.toLowerCase().replace(/[\\/]+$/, '')));
      if (missingPaths.length > 0) {
        env.PATH = env.PATH ? `${env.PATH};${missingPaths.join(';')}` : missingPaths.join(';');
      }
    } else {
      // Resolve user's shell PATH to find npm/node (macOS/Linux)
      const userPath = resolveUserShellPath();
      if (userPath) {
        env.PATH = userPath;
        console.log('[skills] Resolved user shell PATH for skill scripts');
      } else {
        // Fallback: append common node installation paths
        const commonPaths = [
          '/usr/local/bin',
          '/opt/homebrew/bin',
          `${env.HOME}/.nvm/current/bin`,
          `${env.HOME}/.volta/bin`,
          `${env.HOME}/.fnm/current/bin`,
        ];
        env.PATH = [env.PATH, ...commonPaths].filter(Boolean).join(':');
        console.log('[skills] Using fallback PATH for skill scripts');
      }
    }
  }

  // Expose Electron executable so skill scripts can run JS with ELECTRON_RUN_AS_NODE
  // even when system Node.js is not installed.
  env.LUMIAI_ELECTRON_PATH = getElectronNodeRuntimePath();
  appendPythonRuntimeToEnv(env);

  // Re-normalize after appendPythonRuntimeToEnv may have added a PATH key
  normalizePathKey(env);

  return env;
}

const listWindowsCommandPaths = (command: string): string[] => {
  if (process.platform !== 'win32') return [];

  try {
    const result = spawnSync('cmd.exe', ['/d', '/s', '/c', command], {
      encoding: 'utf8',
      windowsHide: true,
    });
    if (result.status !== 0) return [];
    return result.stdout
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
};

const resolveWindowsGitExecutable = (): string | null => {
  if (process.platform !== 'win32') return null;

  const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
  const localAppData = process.env.LOCALAPPDATA || '';
  const userProfile = process.env.USERPROFILE || '';

  const installedCandidates = [
    path.join(programFiles, 'Git', 'cmd', 'git.exe'),
    path.join(programFiles, 'Git', 'bin', 'git.exe'),
    path.join(programFilesX86, 'Git', 'cmd', 'git.exe'),
    path.join(programFilesX86, 'Git', 'bin', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'cmd', 'git.exe'),
    path.join(localAppData, 'Programs', 'Git', 'bin', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'cmd', 'git.exe'),
    path.join(userProfile, 'scoop', 'apps', 'git', 'current', 'bin', 'git.exe'),
    'C:\\Git\\cmd\\git.exe',
    'C:\\Git\\bin\\git.exe',
  ];

  for (const candidate of installedCandidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const whereCandidates = listWindowsCommandPaths('where git');
  for (const candidate of whereCandidates) {
    const normalized = candidate.trim();
    if (!normalized) continue;
    if (normalized.toLowerCase().endsWith('git.exe') && fs.existsSync(normalized)) {
      return normalized;
    }
  }

  const bundledRoots = app.isPackaged
    ? [path.join(process.resourcesPath, 'mingit')]
    : [
      path.join(__dirname, '..', '..', 'resources', 'mingit'),
      path.join(process.cwd(), 'resources', 'mingit'),
    ];

  for (const root of bundledRoots) {
    const bundledCandidates = [
      path.join(root, 'cmd', 'git.exe'),
      path.join(root, 'bin', 'git.exe'),
      path.join(root, 'mingw64', 'bin', 'git.exe'),
      path.join(root, 'usr', 'bin', 'git.exe'),
    ];
    for (const candidate of bundledCandidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
};

const resolveGitCommand = (): { command: string; env?: NodeJS.ProcessEnv } => {
  if (process.platform !== 'win32') {
    return { command: 'git' };
  }

  const gitExe = resolveWindowsGitExecutable();
  if (!gitExe) {
    return { command: 'git' };
  }

  const env: NodeJS.ProcessEnv = { ...process.env };
  const gitDir = path.dirname(gitExe);
  const gitRoot = path.dirname(gitDir);
  const candidateDirs = [
    gitDir,
    path.join(gitRoot, 'cmd'),
    path.join(gitRoot, 'bin'),
    path.join(gitRoot, 'mingw64', 'bin'),
    path.join(gitRoot, 'usr', 'bin'),
  ].filter(dir => fs.existsSync(dir));

  env.PATH = appendEnvPath(env.PATH, candidateDirs);
  return { command: gitExe, env };
};

const runCommand = (
  command: string,
  args: string[],
  options?: { cwd?: string; env?: NodeJS.ProcessEnv }
): Promise<void> => new Promise((resolve, reject) => {
  const child = spawn(command, args, {
    cwd: options?.cwd,
    env: options?.env,
    windowsHide: true,
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  let stderr = '';
  child.stderr.on('data', chunk => {
    stderr += chunk.toString();
  });
  child.on('error', error => reject(error));
  child.on('close', code => {
    if (code === 0) {
      resolve();
      return;
    }
    reject(new Error(stderr.trim() || `Command failed with exit code ${code}`));
  });
});

const extractErrorMessage = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
};

const appendEnvPath = (current: string | undefined, entries: string[]): string => {
  const delimiter = process.platform === 'win32' ? ';' : ':';
  const existing = (current || '').split(delimiter).filter(Boolean);
  const merged = [...existing];
  entries.forEach(entry => {
    if (!entry || merged.includes(entry)) return;
    merged.push(entry);
  });
  return merged.join(delimiter);
};

const deriveRepoName = (source: string): string => {
  const cleaned = source.replace(/[#?].*$/, '');
  const base = cleaned.split('/').filter(Boolean).pop() || 'skill';
  return normalizeFolderName(base.replace(/\.git$/, ''));
};

const isRemoteZipUrl = (source: string): boolean => {
  try {
    const url = new URL(source);
    return (url.protocol === 'http:' || url.protocol === 'https:')
      && url.pathname.toLowerCase().endsWith('.zip');
  } catch {
    return false;
  }
};

const parseGithubRepoSource = (repoUrl: string): GithubRepoSource | null => {
  const trimmed = repoUrl.trim();

  const sshMatch = trimmed.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?\/?$/i);
  if (sshMatch) {
    return {
      owner: sshMatch[1],
      repo: sshMatch[2],
    };
  }

  try {
    const parsedUrl = new URL(trimmed);
    if (!['github.com', 'www.github.com'].includes(parsedUrl.hostname.toLowerCase())) {
      return null;
    }

    const segments = parsedUrl.pathname
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);
    if (segments.length < 2) {
      return null;
    }

    return {
      owner: segments[0],
      repo: segments[1],
    };
  } catch {
    return null;
  }
};

const downloadGithubArchive = async (
  source: GithubRepoSource,
  tempRoot: string,
  ref?: string
): Promise<string> => {
  const encodedRef = ref ? encodeURIComponent(ref) : '';
  const archiveUrlCandidates: Array<{ url: string; headers: Record<string, string> }> = [];

  if (encodedRef) {
    archiveUrlCandidates.push(
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/refs/heads/${encodedRef}.zip`,
        headers: { 'User-Agent': 'LumiAi Skill Downloader' },
      },
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/refs/tags/${encodedRef}.zip`,
        headers: { 'User-Agent': 'LumiAi Skill Downloader' },
      },
      {
        url: `https://github.com/${source.owner}/${source.repo}/archive/${encodedRef}.zip`,
        headers: { 'User-Agent': 'LumiAi Skill Downloader' },
      }
    );
  }

  archiveUrlCandidates.push({
    url: `https://api.github.com/repos/${source.owner}/${source.repo}/zipball${encodedRef ? `/${encodedRef}` : ''}`,
    headers: {
      Accept: 'application/vnd.github+json',
      'User-Agent': 'LumiAi Skill Downloader',
      'X-GitHub-Api-Version': '2022-11-28',
    },
  });

  let buffer: Buffer | null = null;
  let lastError: string | null = null;

  for (const candidate of archiveUrlCandidates) {
    try {
      const response = await session.defaultSession.fetch(candidate.url, {
        method: 'GET',
        headers: candidate.headers,
      });

      if (!response.ok) {
        const detail = (await response.text()).trim();
        lastError = `Archive download failed (${response.status} ${response.statusText})${detail ? `: ${detail}` : ''}`;
        continue;
      }

      buffer = Buffer.from(await response.arrayBuffer());
      break;
    } catch (error) {
      lastError = extractErrorMessage(error);
    }
  }

  if (!buffer) {
    throw new Error(lastError || 'Archive download failed');
  }

  const zipPath = path.join(tempRoot, 'github-archive.zip');
  const extractRoot = path.join(tempRoot, 'github-archive');
  fs.writeFileSync(zipPath, buffer);
  fs.mkdirSync(extractRoot, { recursive: true });
  await extractZip(zipPath, { dir: extractRoot });

  const extractedDirs = fs.readdirSync(extractRoot)
    .map(entry => path.join(extractRoot, entry))
    .filter(entryPath => {
      try {
        return fs.statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    });

  if (extractedDirs.length === 1) {
    return extractedDirs[0];
  }

  return extractRoot;
};

const downloadZipUrl = async (zipUrl: string, tempRoot: string): Promise<string> => {
  const response = await session.defaultSession.fetch(zipUrl, {
    method: 'GET',
    headers: { 'User-Agent': 'LumiAi Skill Downloader' },
  });

  if (!response.ok) {
    throw new Error(`Download failed (${response.status} ${response.statusText})`);
  }

  const buffer = Buffer.from(await response.arrayBuffer());
  const zipPath = path.join(tempRoot, 'remote-skill.zip');
  const extractRoot = path.join(tempRoot, 'remote-skill');
  fs.writeFileSync(zipPath, buffer);
  fs.mkdirSync(extractRoot, { recursive: true });
  await extractZip(zipPath, { dir: extractRoot });

  const extractedDirs = fs.readdirSync(extractRoot)
    .map(entry => path.join(extractRoot, entry))
    .filter(entryPath => {
      try {
        return fs.statSync(entryPath).isDirectory();
      } catch {
        return false;
      }
    });

  if (extractedDirs.length === 1) {
    return extractedDirs[0];
  }

  return extractRoot;
};

const normalizeGithubSubpath = (value: string): string | null => {
  const trimmed = value.trim().replace(/^\/+|\/+$/g, '');
  if (!trimmed) return null;
  const segments = trimmed
    .split('/')
    .filter(Boolean)
    .map(segment => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    });
  if (segments.some(segment => segment === '.' || segment === '..')) {
    return null;
  }
  return segments.join('/');
};

const parseGithubTreeOrBlobUrl = (source: string): NormalizedGitSource | null => {
  try {
    const parsedUrl = new URL(source);
    if (!['github.com', 'www.github.com'].includes(parsedUrl.hostname)) {
      return null;
    }

    const segments = parsedUrl.pathname.split('/').filter(Boolean);
    if (segments.length < 5) {
      return null;
    }

    const [owner, repoRaw, mode, ref, ...rest] = segments;
    if (!owner || !repoRaw || !ref || (mode !== 'tree' && mode !== 'blob')) {
      return null;
    }

    const repo = repoRaw.replace(/\.git$/i, '');
    const sourceSubpath = normalizeGithubSubpath(rest.join('/'));
    if (!repo || !sourceSubpath) {
      return null;
    }

    return {
      repoUrl: `https://github.com/${owner}/${repo}.git`,
      sourceSubpath,
      ref: decodeURIComponent(ref),
      repoNameHint: repo,
    };
  } catch {
    return null;
  }
};

const isWebSearchSkillBroken = (skillRoot: string): boolean => {
  const startServerScript = path.join(skillRoot, 'scripts', 'start-server.sh');
  const searchScript = path.join(skillRoot, 'scripts', 'search.sh');
  const serverEntry = path.join(skillRoot, 'dist', 'server', 'index.js');
  const requiredPaths = [
    startServerScript,
    searchScript,
    serverEntry,
    path.join(skillRoot, 'node_modules', 'iconv-lite', 'encodings', 'index.js'),
  ];

  if (requiredPaths.some(requiredPath => !fs.existsSync(requiredPath))) {
    return true;
  }

  try {
    const startScript = fs.readFileSync(startServerScript, 'utf-8');
    const searchScriptContent = fs.readFileSync(searchScript, 'utf-8');
    const serverEntryContent = fs.readFileSync(serverEntry, 'utf-8');
    if (!startScript.includes('WEB_SEARCH_FORCE_REPAIR')) {
      return true;
    }
    if (!startScript.includes('detect_healthy_bridge_server')) {
      return true;
    }
    if (!searchScriptContent.includes('ACTIVE_SERVER_URL')) {
      return true;
    }
    if (!searchScriptContent.includes('try_switch_to_local_server')) {
      return true;
    }
    if (!searchScriptContent.includes('build_search_payload')) {
      return true;
    }
    if (!searchScriptContent.includes('@query_file')) {
      return true;
    }
    if (!serverEntryContent.includes('decodeJsonRequestBody')) {
      return true;
    }
    if (!serverEntryContent.includes("TextDecoder('gb18030'")) {
      return true;
    }
    if (serverEntryContent.includes('scoreDecodedJsonText') && serverEntryContent.includes('Request body decoded using gb18030 (score')) {
      return true;
    }
  } catch {
    return true;
  }

  return false;
};

const normalizeGitSource = (source: string): NormalizedGitSource | null => {
  const githubTreeOrBlob = parseGithubTreeOrBlobUrl(source);
  if (githubTreeOrBlob) {
    return githubTreeOrBlob;
  }

  if (/^[\w.-]+\/[\w.-]+$/.test(source)) {
    return {
      repoUrl: `https://github.com/${source}.git`,
    };
  }
  if (source.startsWith('http://') || source.startsWith('https://') || source.startsWith('git@')) {
    return {
      repoUrl: source,
    };
  }
  if (source.endsWith('.git')) {
    return {
      repoUrl: source,
    };
  }
  return null;
};

export class SkillBuilderService {
  private runner: SkillRunnerService;

  constructor(private registry: SkillRegistryStore) {
    this.runner = new SkillRunnerService();
  }

  async downloadSkill(source: string): Promise<{ success: boolean; skills?: SkillRecord[]; error?: string }> {
    let cleanupPath: string | null = null;
    try {
      const trimmed = source.trim();
      if (!trimmed) {
        return { success: false, error: 'Missing skill source' };
      }

      const root = this.registry.ensureSkillsRoot();
      let localSource = trimmed;
      if (fs.existsSync(localSource)) {
        const stat = fs.statSync(localSource);
        if (stat.isFile()) {
          if (isZipFile(localSource)) {
            const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lumiai-skill-zip-'));
            await extractZip(localSource, { dir: tempRoot });
            localSource = tempRoot;
            cleanupPath = tempRoot;
          } else if (path.basename(localSource) === SKILL_FILE_NAME) {
            localSource = path.dirname(localSource);
          } else {
            return { success: false, error: 'Skill source must be a directory, zip file, or SKILL.md file' };
          }
        }
      } else if (isRemoteZipUrl(trimmed)) {
        const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lumiai-skill-zip-'));
        cleanupPath = tempRoot;
        localSource = await downloadZipUrl(trimmed, tempRoot);
      } else {
        const normalized = normalizeGitSource(trimmed);
        if (!normalized) {
          return { success: false, error: 'Invalid skill source. Use owner/repo, repo URL, or a GitHub tree/blob URL.' };
        }
        const tempRoot = fs.mkdtempSync(path.join(app.getPath('temp'), 'lumiai-skill-'));
        cleanupPath = tempRoot;
        const repoName = normalizeFolderName(normalized.repoNameHint || deriveRepoName(normalized.repoUrl));
        const clonePath = path.join(tempRoot, repoName);
        const cloneArgs = ['clone', '--depth', '1'];
        if (normalized.ref) {
          cloneArgs.push('--branch', normalized.ref);
        }
        cloneArgs.push(normalized.repoUrl, clonePath);
        const gitRuntime = resolveGitCommand();
        const githubSource = parseGithubRepoSource(normalized.repoUrl);
        let downloadedSourceRoot = clonePath;
        try {
          await runCommand(gitRuntime.command, cloneArgs, { env: gitRuntime.env });
        } catch (error) {
          const errno = (error as NodeJS.ErrnoException | null)?.code;
          if (githubSource) {
            try {
              downloadedSourceRoot = await downloadGithubArchive(githubSource, tempRoot, normalized.ref);
            } catch (archiveError) {
              const gitMessage = extractErrorMessage(error);
              const archiveMessage = extractErrorMessage(archiveError);
              if (errno === 'ENOENT' && process.platform === 'win32') {
                throw new Error(
                  'Git executable not found. Please install Git for Windows or reinstall LumiAi with bundled PortableGit.'
                  + ` Archive fallback also failed: ${archiveMessage}`
                );
              }
              throw new Error(`Git clone failed: ${gitMessage}. Archive fallback failed: ${archiveMessage}`);
            }
          } else if (errno === 'ENOENT' && process.platform === 'win32') {
            throw new Error('Git executable not found. Please install Git for Windows or reinstall LumiAi with bundled PortableGit.');
          } else {
            throw error;
          }
        }

        if (normalized.sourceSubpath) {
          const scopedSource = resolveWithin(downloadedSourceRoot, normalized.sourceSubpath);
          if (!fs.existsSync(scopedSource)) {
            return { success: false, error: `Path "${normalized.sourceSubpath}" not found in repository` };
          }
          const scopedStat = fs.statSync(scopedSource);
          if (scopedStat.isFile()) {
            if (path.basename(scopedSource) === SKILL_FILE_NAME) {
              localSource = path.dirname(scopedSource);
            } else {
              return { success: false, error: 'GitHub path must point to a directory or SKILL.md file' };
            }
          } else {
            localSource = scopedSource;
          }
        } else {
          localSource = downloadedSourceRoot;
        }

      }

      const { collectSkillDirsFromSource } = await import('../store/registryStore');
      const skillDirs = collectSkillDirsFromSource(localSource);
      if (skillDirs.length === 0) {
        cleanupPathSafely(cleanupPath);
        cleanupPath = null;
        return { success: false, error: 'No SKILL.md found in source' };
      }

      for (const skillDir of skillDirs) {
        const folderName = normalizeFolderName(path.basename(skillDir));
        let targetDir = resolveWithin(root, folderName);
        let suffix = 1;
        while (fs.existsSync(targetDir)) {
          targetDir = resolveWithin(root, `${folderName}-${suffix}`);
          suffix += 1;
        }
        const { cpRecursiveSync } = await import('../../../utils/fsCompat');
        cpRecursiveSync(skillDir, targetDir);
      }

      cleanupPathSafely(cleanupPath);
      cleanupPath = null;

      return { success: true, skills: this.registry.listSkills() };
    } catch (error) {
      cleanupPathSafely(cleanupPath);
      return { success: false, error: error instanceof Error ? error.message : 'Failed to download skill' };
    }
  }

  async testEmailConnectivity(
    skillId: string,
    config: Record<string, string>
  ): Promise<{ success: boolean; result?: import('../types').EmailConnectivityTestResult; error?: string }> {
    try {
      const skillDir = this.registry.resolveSkillDir(skillId);

      // Ensure dependencies are installed before running scripts
      const depsResult = this.ensureSkillDependencies(skillDir);
      if (!depsResult.success) {
        console.error('[email-connectivity] Dependency install failed:', depsResult.error);
        return { success: false, error: depsResult.error };
      }

      const imapScript = path.join(skillDir, 'scripts', 'imap.js');
      const smtpScript = path.join(skillDir, 'scripts', 'smtp.js');
      if (!fs.existsSync(imapScript) || !fs.existsSync(smtpScript)) {
        console.error('[email-connectivity] Scripts not found:', { imapScript, smtpScript });
        return { success: false, error: 'Email connectivity scripts not found' };
      }

      // Mask password for logging
      const safeConfig = { ...config };
      if (safeConfig.IMAP_PASS) safeConfig.IMAP_PASS = '***';
      if (safeConfig.SMTP_PASS) safeConfig.SMTP_PASS = '***';
      console.log('[email-connectivity] Testing with config:', JSON.stringify(safeConfig, null, 2));

      const envOverrides = Object.fromEntries(
        Object.entries(config ?? {})
          .filter(([key]) => key.trim())
          .map(([key, value]) => [key, String(value ?? '')])
      );

      console.log('[email-connectivity] Running IMAP test (list-mailboxes)...');
      const imapResult = await this.runSkillScriptWithEnv(
        skillDir,
        imapScript,
        ['list-mailboxes'],
        envOverrides,
        20000
      );
      console.log('[email-connectivity] IMAP result:', JSON.stringify({
        success: imapResult.success,
        exitCode: imapResult.exitCode,
        timedOut: imapResult.timedOut,
        durationMs: imapResult.durationMs,
        stdout: imapResult.stdout?.slice(0, 500),
        stderr: imapResult.stderr?.slice(0, 500),
        error: imapResult.error,
        spawnErrorCode: imapResult.spawnErrorCode,
      }, null, 2));

      console.log('[email-connectivity] Running SMTP test (verify)...');
      const smtpResult = await this.runSkillScriptWithEnv(
        skillDir,
        smtpScript,
        ['verify'],
        envOverrides,
        20000
      );
      console.log('[email-connectivity] SMTP result:', JSON.stringify({
        success: smtpResult.success,
        exitCode: smtpResult.exitCode,
        timedOut: smtpResult.timedOut,
        durationMs: smtpResult.durationMs,
        stdout: smtpResult.stdout?.slice(0, 500),
        stderr: smtpResult.stderr?.slice(0, 500),
        error: smtpResult.error,
        spawnErrorCode: smtpResult.spawnErrorCode,
      }, null, 2));

      const checks: import('../types').EmailConnectivityCheck[] = [
        this.runner.buildEmailConnectivityCheck('imap_connection', imapResult),
        this.runner.buildEmailConnectivityCheck('smtp_connection', smtpResult),
      ];
      const verdict: import('../types').EmailConnectivityVerdict = checks.every(check => check.level === 'pass') ? 'pass' : 'fail';

      console.log('[email-connectivity] Final verdict:', verdict, 'checks:', JSON.stringify(checks, null, 2));

      return {
        success: true,
        result: {
          testedAt: Date.now(),
          verdict,
          checks,
        },
      };
    } catch (error) {
      console.error('[email-connectivity] Unexpected error:', error);
      return {
        success: false,
        error: error instanceof Error ? error.message : 'Failed to test email connectivity',
      };
    }
  }

  ensureSkillDependencies(skillDir: string): { success: boolean; error?: string } {
    const nodeModulesPath = path.join(skillDir, 'node_modules');
    const packageJsonPath = path.join(skillDir, 'package.json');
    const skillId = path.basename(skillDir);

    console.log(`[skills] Checking dependencies for ${skillId}...`);
    console.log(`[skills]   node_modules exists: ${fs.existsSync(nodeModulesPath)}`);
    console.log(`[skills]   package.json exists: ${fs.existsSync(packageJsonPath)}`);
    console.log(`[skills]   skillDir: ${skillDir}`);

    // If node_modules exists, assume dependencies are installed
    if (fs.existsSync(nodeModulesPath)) {
      console.log(`[skills] Dependencies already installed for ${skillId}`);
      return { success: true };
    }

    // If no package.json, nothing to install
    if (!fs.existsSync(packageJsonPath)) {
      console.log(`[skills] No package.json found for ${skillId}, skipping install`);
      return { success: true };
    }

    // Try to repair from bundled resources first (works without npm)
    if (this.registry.repairSkillFromBundled(skillId, skillDir)) {
      if (fs.existsSync(nodeModulesPath)) {
        console.log(`[skills] Dependencies restored from bundled resources for ${skillId}`);
        return { success: true };
      }
    }

    // Build environment with user's shell PATH (crucial for packaged apps)
    const env = buildSkillEnv() as NodeJS.ProcessEnv;
    const pathKeys = Object.keys(env).filter(k => k.toLowerCase() === 'path');
    console.log(`[skills]   PATH keys in env: ${JSON.stringify(pathKeys)}`);
    console.log(`[skills]   PATH (first 300 chars): ${env.PATH?.substring(0, 300)}`);

    // Check if npm is available
    const npmCommand = process.platform === 'win32' ? 'npm.cmd' : 'npm';
    if (!hasCommand(npmCommand, env) && !hasCommand('npm', env)) {
      const errorMsg = 'npm is not available and skill cannot be repaired from bundled resources. Please install Node.js from https://nodejs.org/';
      console.error(`[skills] ${errorMsg}`);
      return { success: false, error: errorMsg };
    }

    console.log(`[skills] npm is available`);

    // Try to install dependencies
    console.log(`[skills] Installing dependencies for ${skillId}...`);
    console.log(`[skills]   Working directory: ${skillDir}`);

    try {
      // On Windows, use shell: true so cmd.exe resolves npm.cmd correctly
      const isWin = process.platform === 'win32';
      const result = spawnSync('npm', ['install'], {
        cwd: skillDir,
        encoding: 'utf-8',
        stdio: 'pipe',
        timeout: 120000, // 2 minute timeout
        env,
        shell: isWin,
      });

      console.log(`[skills] npm install exit code: ${result.status}`);
      if (result.stdout) {
        console.log(`[skills] npm install stdout: ${result.stdout.substring(0, 500)}`);
      }
      if (result.stderr) {
        console.log(`[skills] npm install stderr: ${result.stderr.substring(0, 500)}`);
      }

      if (result.status !== 0) {
        const errorMsg = result.stderr || result.stdout || 'npm install failed';
        console.error(`[skills] Failed to install dependencies for ${skillId}:`, errorMsg);
        return { success: false, error: `Failed to install dependencies: ${errorMsg}` };
      }

      // Verify node_modules was created
      if (!fs.existsSync(nodeModulesPath)) {
        const errorMsg = 'npm install appeared to succeed but node_modules was not created';
        console.error(`[skills] ${errorMsg}`);
        return { success: false, error: errorMsg };
      }

      console.log(`[skills] Dependencies installed successfully for ${skillId}`);
      return { success: true };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      console.error(`[skills] Error installing dependencies for ${skillId}:`, errorMsg);
      return { success: false, error: `Failed to install dependencies: ${errorMsg}` };
    }
  }

  private async runSkillScriptWithEnv(
    skillDir: string,
    scriptPath: string,
    scriptArgs: string[],
    envOverrides: Record<string, string>,
    timeoutMs: number
  ): Promise<SkillScriptRunResult> {
    let lastResult: SkillScriptRunResult | null = null;

    // Build base environment with user's shell PATH
    const baseEnv = buildSkillEnv();

    for (const runtime of this.runner.getScriptRuntimeCandidates(baseEnv as NodeJS.ProcessEnv)) {
      const env: NodeJS.ProcessEnv = {
        ...baseEnv,
        ...runtime.extraEnv,
        ...envOverrides,
      };
      const result = await runScriptWithTimeout({
        command: runtime.command,
        args: [scriptPath, ...scriptArgs],
        cwd: skillDir,
        env,
        timeoutMs,
      });
      lastResult = result;

      if (result.spawnErrorCode === 'ENOENT') {
        continue;
      }
      return result;
    }

    return lastResult ?? {
      success: false,
      exitCode: null,
      stdout: '',
      stderr: '',
      durationMs: 0,
      timedOut: false,
      error: 'Failed to run skill script',
    };
  }
}
