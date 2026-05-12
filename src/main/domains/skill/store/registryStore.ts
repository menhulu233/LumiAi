import { app } from 'electron';
import fs from 'fs';
import path from 'path';
import yaml from 'js-yaml';
import { KvStore } from '../../../system/store/kvStore';
import { cpRecursiveSync } from '../../../utils/fsCompat';
import {
  SkillRecord,
  SkillStateMap,
  SkillDefaultConfig,
  SkillsConfig,
} from '../types';

export const SKILLS_DIR_NAME = 'skills';
export const SKILL_FILE_NAME = 'SKILL.md';
export const SKILLS_CONFIG_FILE = 'skills.config.json';
export const SKILL_STATE_KEY = 'skills_state';
export const CLAUDE_SKILLS_DIR_NAME = '.claude';
export const CLAUDE_SKILLS_SUBDIR = 'skills';
export const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;

export const parseFrontmatter = (raw: string): { frontmatter: Record<string, unknown>; content: string } => {
  const normalized = raw.replace(/^\uFEFF/, '');
  const match = normalized.match(FRONTMATTER_RE);
  if (!match) {
    return { frontmatter: {}, content: normalized };
  }

  let frontmatter: Record<string, unknown> = {};
  try {
    const parsed = yaml.load(match[1]);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      frontmatter = parsed as Record<string, unknown>;
    }
  } catch (e) {
    console.warn('[skills] Failed to parse YAML frontmatter:', e);
  }

  const content = normalized.slice(match[0].length);
  return { frontmatter, content };
};

export const isTruthy = (value?: unknown): boolean => {
  if (value === true) return true;
  if (!value) return false;
  if (typeof value !== 'string') return false;
  const normalized = value.trim().toLowerCase();
  return normalized === 'true' || normalized === 'yes' || normalized === '1';
};

export const extractDescription = (content: string): string => {
  const lines = content.split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    return trimmed.replace(/^#+\s*/, '');
  }
  return '';
};

export const normalizeFolderName = (name: string): string => {
  const normalized = name.replace(/[^a-zA-Z0-9-_]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || 'skill';
};

export const isZipFile = (filePath: string): boolean => path.extname(filePath).toLowerCase() === '.zip';

export const cleanupPathSafely = (targetPath: string | null): void => {
  if (!targetPath) return;
  try {
    fs.rmSync(targetPath, {
      recursive: true,
      force: true,
      maxRetries: process.platform === 'win32' ? 5 : 0,
      retryDelay: process.platform === 'win32' ? 200 : 0,
    });
  } catch (error) {
    console.warn('[skills] Failed to cleanup temporary directory:', targetPath, error);
  }
};

/**
 * Compare two semver-like version strings (e.g. "1.0.0" vs "1.0.1").
 * Returns 1 if a > b, -1 if a < b, 0 if equal.
 * Non-numeric segments are treated as 0.
 */
export const compareVersions = (a: string, b: string): number => {
  const pa = a.split('.').map(s => parseInt(s, 10) || 0);
  const pb = b.split('.').map(s => parseInt(s, 10) || 0);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const na = pa[i] || 0;
    const nb = pb[i] || 0;
    if (na > nb) return 1;
    if (na < nb) return -1;
  }
  return 0;
};

export const resolveWithin = (root: string, target: string): string => {
  const resolvedRoot = path.resolve(root);
  const resolvedTarget = path.resolve(root, target);
  if (resolvedTarget === resolvedRoot) return resolvedTarget;
  if (!resolvedTarget.startsWith(resolvedRoot + path.sep)) {
    throw new Error('Invalid target path');
  }
  return resolvedTarget;
};

export const listSkillDirs = (root: string): string[] => {
  if (!fs.existsSync(root)) return [];
  const skillFile = path.join(root, SKILL_FILE_NAME);
  if (fs.existsSync(skillFile)) {
    return [root];
  }

  const entries = fs.readdirSync(root);
  return entries
    .map(entry => path.join(root, entry))
    .filter((entryPath) => {
      try {
        const stat = fs.lstatSync(entryPath);
        if (!stat.isDirectory() && !stat.isSymbolicLink()) {
          return false;
        }
        return fs.existsSync(path.join(entryPath, SKILL_FILE_NAME));
      } catch {
        return false;
      }
    });
};

export const collectSkillDirsFromSource = (source: string): string[] => {
  const resolved = path.resolve(source);
  if (fs.existsSync(path.join(resolved, SKILL_FILE_NAME))) {
    return [resolved];
  }

  const nestedRoot = path.join(resolved, SKILLS_DIR_NAME);
  if (fs.existsSync(nestedRoot) && fs.statSync(nestedRoot).isDirectory()) {
    const nestedSkills = listSkillDirs(nestedRoot);
    if (nestedSkills.length > 0) {
      return nestedSkills;
    }
  }

  const directSkills = listSkillDirs(resolved);
  if (directSkills.length > 0) {
    return directSkills;
  }

  return collectSkillDirsRecursively(resolved);
};

export const collectSkillDirsRecursively = (root: string): string[] => {
  const resolvedRoot = path.resolve(root);
  if (!fs.existsSync(resolvedRoot)) return [];

  const matchedDirs: string[] = [];
  const queue: string[] = [resolvedRoot];
  const seen = new Set<string>();

  while (queue.length > 0) {
    const current = queue.shift();
    if (!current) continue;
    const normalized = path.resolve(current);
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(normalized);
    } catch {
      continue;
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) continue;

    if (fs.existsSync(path.join(normalized, SKILL_FILE_NAME))) {
      matchedDirs.push(normalized);
      continue;
    }

    let entries: string[] = [];
    try {
      entries = fs.readdirSync(normalized);
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry || entry === '.git' || entry === 'node_modules') continue;
      queue.push(path.join(normalized, entry));
    }
  }

  return matchedDirs;
};

export class SkillRegistryStore {
  constructor(private store: KvStore) {}

  getSkillsRoot(): string {
    return path.resolve(app.getPath('userData'), SKILLS_DIR_NAME);
  }

  ensureSkillsRoot(): string {
    const root = this.getSkillsRoot();
    if (!fs.existsSync(root)) {
      fs.mkdirSync(root, { recursive: true });
    }
    return root;
  }

  syncBundledSkillsToUserData(): void {
    if (!app.isPackaged) {
      return;
    }

    console.log('[skills] syncBundledSkillsToUserData: start');
    const userRoot = this.ensureSkillsRoot();
    console.log('[skills] syncBundledSkillsToUserData: userRoot =', userRoot);
    const bundledRoot = this.getBundledSkillsRoot();
    console.log('[skills] syncBundledSkillsToUserData: bundledRoot =', bundledRoot);
    if (!bundledRoot || bundledRoot === userRoot || !fs.existsSync(bundledRoot)) {
      console.log('[skills] syncBundledSkillsToUserData: bundledRoot skipped (missing or same as userRoot)');
      return;
    }

    try {
      const bundledSkillDirs = listSkillDirs(bundledRoot);
      console.log('[skills] syncBundledSkillsToUserData: found', bundledSkillDirs.length, 'bundled skills');
      bundledSkillDirs.forEach((dir) => {
        const id = path.basename(dir);
        const targetDir = path.join(userRoot, id);
        const targetExists = fs.existsSync(targetDir);

        // Check if skill needs repair
        let shouldRepair = false;
        let needsCleanCopy = false;
        if (targetExists) {
          // Version-based update: if bundled has a version and it's newer, force update
          const bundledVer = this.getSkillVersion(dir);
          if (bundledVer && compareVersions(bundledVer, this.getSkillVersion(targetDir) || '0.0.0') > 0) {
            shouldRepair = true;
            needsCleanCopy = true;
          }
          // web-search has specific broken checks
          else if (id === 'web-search' && isWebSearchSkillBroken(targetDir)) {
            shouldRepair = true;
          }
          // Generic check: if bundled has node_modules but target doesn't, repair it
          else if (!this.isSkillRuntimeHealthy(targetDir, dir)) {
            shouldRepair = true;
          }
        }

        if (targetExists && !shouldRepair) return;
        try {
          console.log(`[skills] syncBundledSkillsToUserData: copying "${id}" from ${dir} to ${targetDir}`);

          // Preserve .env file before clean copy
          let envBackup: Buffer | null = null;
          const envPath = path.join(targetDir, '.env');
          if (needsCleanCopy && fs.existsSync(envPath)) {
            envBackup = fs.readFileSync(envPath);
          }

          // Version-based update: delete target dir first to remove stale files
          // (e.g. old .py scripts, __pycache__, leftover package-lock.json)
          if (needsCleanCopy) {
            fs.rmSync(targetDir, { recursive: true, force: true });
          }

          cpRecursiveSync(dir, targetDir, {
            dereference: true,
            force: shouldRepair,
          });

          // Restore .env file after clean copy
          if (envBackup !== null) {
            fs.writeFileSync(envPath, envBackup);
          }

          console.log(`[skills] syncBundledSkillsToUserData: copied "${id}" successfully`);
          if (shouldRepair) {
            console.log(`[skills] Repaired bundled skill "${id}" in user data`);
          }
        } catch (error) {
          console.warn(`[skills] Failed to sync bundled skill "${id}":`, error);
        }
      });

      const bundledConfig = path.join(bundledRoot, SKILLS_CONFIG_FILE);
      const targetConfig = path.join(userRoot, SKILLS_CONFIG_FILE);
      if (fs.existsSync(bundledConfig)) {
        if (!fs.existsSync(targetConfig)) {
          console.log('[skills] syncBundledSkillsToUserData: copying skills.config.json');
          cpRecursiveSync(bundledConfig, targetConfig);
        } else {
          this.mergeSkillsConfig(bundledConfig, targetConfig);
        }
      }
      console.log('[skills] syncBundledSkillsToUserData: done');
    } catch (error) {
      console.warn('[skills] Failed to sync bundled skills:', error);
    }
  }

  /**
   * Check if a skill's runtime is healthy by comparing with bundled version.
   * Returns false if bundled has dependencies but target doesn't.
   */
  isSkillRuntimeHealthy(targetDir: string, bundledDir: string): boolean {
    const bundledNodeModules = path.join(bundledDir, 'node_modules');
    const targetNodeModules = path.join(targetDir, 'node_modules');
    const targetPackageJson = path.join(targetDir, 'package.json');

    // If target has no package.json, it's a simple skill (no deps needed)
    if (!fs.existsSync(targetPackageJson)) {
      return true;
    }

    // If bundled doesn't have node_modules, no deps to sync
    if (!fs.existsSync(bundledNodeModules)) {
      return true;
    }

    // If bundled has node_modules but target doesn't, needs repair
    if (!fs.existsSync(targetNodeModules)) {
      return false;
    }

    return true;
  }

  getSkillVersion(skillDir: string): string {
    try {
      const raw = fs.readFileSync(path.join(skillDir, SKILL_FILE_NAME), 'utf8');
      const { frontmatter } = parseFrontmatter(raw);
      return typeof frontmatter.version === 'string' ? frontmatter.version
        : typeof frontmatter.version === 'number' ? String(frontmatter.version)
        : '';
    } catch {
      return '';
    }
  }

  mergeSkillsConfig(bundledPath: string, targetPath: string): void {
    try {
      const bundled = JSON.parse(fs.readFileSync(bundledPath, 'utf-8'));
      const target = JSON.parse(fs.readFileSync(targetPath, 'utf-8'));
      if (!bundled.defaults || !target.defaults) return;
      let changed = false;
      for (const [id, config] of Object.entries(bundled.defaults)) {
        if (!(id in target.defaults)) {
          target.defaults[id] = config;
          changed = true;
        }
      }
      if (changed) {
        // Write to temp file first, then rename for atomic update
        const tmpPath = targetPath + '.tmp';
        fs.writeFileSync(tmpPath, JSON.stringify(target, null, 2) + '\n', 'utf-8');
        fs.renameSync(tmpPath, targetPath);
        console.log('[skills] mergeSkillsConfig: merged new skill entries into user config');
      }
    } catch (e) {
      console.warn('[skills] Failed to merge skills config:', e);
    }
  }

  listSkills(): SkillRecord[] {
    const primaryRoot = this.ensureSkillsRoot();
    const state = this.loadSkillStateMap();
    const roots = this.getSkillRoots(primaryRoot);
    const orderedRoots = roots.filter(root => root !== primaryRoot).concat(primaryRoot);
    const defaults = this.loadSkillsDefaults(roots);
    const builtInSkillIds = this.listBuiltInSkillIds();
    const skillMap = new Map<string, SkillRecord>();

    orderedRoots.forEach(root => {
      if (!fs.existsSync(root)) return;
      const skillDirs = listSkillDirs(root);
      skillDirs.forEach(dir => {
        const skill = this.parseSkillDir(dir, state, defaults, builtInSkillIds.has(path.basename(dir)));
        if (!skill) return;
        skillMap.set(skill.id, skill);
      });
    });

    const skills = Array.from(skillMap.values());

    skills.sort((a, b) => {
      const orderA = defaults[a.id]?.order ?? 999;
      const orderB = defaults[b.id]?.order ?? 999;
      if (orderA !== orderB) return orderA - orderB;
      return a.name.localeCompare(b.name);
    });
    return skills;
  }

  buildAutoRoutingPrompt(): string | null {
    const skills = this.listSkills();
    const enabled = skills.filter(s => s.enabled && s.prompt);
    if (enabled.length === 0) return null;

    const skillEntries = enabled
      .map(s => `  <skill><id>${s.id}</id><name>${s.name}</name><description>${s.description}</description><location>${s.skillPath}</location></skill>`)
      .join('\n');

    return [
      '## Skills (mandatory)',
      'Before replying: scan <available_skills> <description> entries.',
      '- If exactly one skill clearly applies: read its SKILL.md at <location> with the Read tool, then follow it.',
      '- If multiple could apply: choose the most specific one, then read/follow it.',
      '- If none clearly apply: do not read any SKILL.md.',
      '- IMPORTANT: If a description contains "Do NOT use" constraints, strictly respect them. If the user\'s request falls into a "Do NOT" category, treat that skill as non-matching — do NOT read its SKILL.md.',
      '- For the selected skill, treat <location> as the canonical SKILL.md path.',
      '- Resolve relative paths mentioned by that SKILL.md against its directory (dirname(<location>)), not the workspace root.',
      'Constraints: never read more than one skill up front; only read additional skills if the first one explicitly references them.',
      '',
      '<available_skills>',
      skillEntries,
      '</available_skills>',
    ].join('\n');
  }

  setSkillEnabled(id: string, enabled: boolean): SkillRecord[] {
    const state = this.loadSkillStateMap();
    state[id] = { enabled };
    this.saveSkillStateMap(state);
    return this.listSkills();
  }

  deleteSkill(id: string): SkillRecord[] {
    const root = this.ensureSkillsRoot();
    if (id !== path.basename(id)) {
      throw new Error('Invalid skill id');
    }
    if (this.isBuiltInSkillId(id)) {
      throw new Error('Built-in skills cannot be deleted');
    }

    const targetDir = resolveWithin(root, id);
    if (!fs.existsSync(targetDir)) {
      throw new Error('Skill not found');
    }

    fs.rmSync(targetDir, { recursive: true, force: true });
    const state = this.loadSkillStateMap();
    delete state[id];
    this.saveSkillStateMap(state);
    return this.listSkills();
  }

  loadSkillStateMap(): SkillStateMap {
    const store = this.store;
    const raw = store.get(SKILL_STATE_KEY) as SkillStateMap | SkillRecord[] | undefined;
    if (Array.isArray(raw)) {
      const migrated: SkillStateMap = {};
      raw.forEach(skill => {
        migrated[skill.id] = { enabled: skill.enabled };
      });
      store.set(SKILL_STATE_KEY, migrated);
      return migrated;
    }
    return raw ?? {};
  }

  saveSkillStateMap(map: SkillStateMap): void {
    this.store.set(SKILL_STATE_KEY, map);
  }

  loadSkillsDefaults(roots: string[]): Record<string, SkillDefaultConfig> {
    const merged: Record<string, SkillDefaultConfig> = {};

    // Load from roots in reverse order so higher priority roots override lower ones
    // roots[0] is user directory (highest priority), roots[1] is app-bundled (lower priority)
    const reversedRoots = [...roots].reverse();

    for (const root of reversedRoots) {
      const configPath = path.join(root, SKILLS_CONFIG_FILE);
      if (!fs.existsSync(configPath)) continue;

      try {
        const raw = fs.readFileSync(configPath, 'utf8');
        const config = JSON.parse(raw) as SkillsConfig;
        if (config.defaults && typeof config.defaults === 'object') {
          for (const [id, settings] of Object.entries(config.defaults)) {
            merged[id] = { ...merged[id], ...settings };
          }
        }
      } catch (error) {
        console.warn('[skills] Failed to load skills config:', configPath, error);
      }
    }

    return merged;
  }

  getSkillRoots(primaryRoot?: string): string[] {
    const resolvedPrimary = primaryRoot ?? this.getSkillsRoot();
    const roots: string[] = [resolvedPrimary];

    const claudeSkillsRoot = this.getClaudeSkillsRoot();
    if (claudeSkillsRoot && fs.existsSync(claudeSkillsRoot)) {
      roots.push(claudeSkillsRoot);
    }

    const appRoot = this.getBundledSkillsRoot();
    if (appRoot !== resolvedPrimary && fs.existsSync(appRoot)) {
      roots.push(appRoot);
    }
    return roots;
  }

  getClaudeSkillsRoot(): string | null {
    const homeDir = app.getPath('home');
    return path.join(homeDir, CLAUDE_SKILLS_DIR_NAME, CLAUDE_SKILLS_SUBDIR);
  }

  getBundledSkillsRoot(): string {
    if (app.isPackaged) {
      // In production, bundled skills should be in Resources/skills.
      const resourcesRoot = path.resolve(process.resourcesPath, SKILLS_DIR_NAME);
      if (fs.existsSync(resourcesRoot)) {
        return resourcesRoot;
      }

      // Fallback for older packages where skills are inside app.asar.
      return path.resolve(app.getAppPath(), SKILLS_DIR_NAME);
    }

    // In development, use the project root (parent of dist-electron).
    // __dirname is dist-electron/, so we need to go up one level to get to project root
    const projectRoot = path.resolve(__dirname, '..');
    return path.resolve(projectRoot, SKILLS_DIR_NAME);
  }

  listBuiltInSkillIds(): Set<string> {
    const builtInRoot = this.getBundledSkillsRoot();
    if (!builtInRoot || !fs.existsSync(builtInRoot)) {
      return new Set();
    }
    return new Set(listSkillDirs(builtInRoot).map(dir => path.basename(dir)));
  }

  isBuiltInSkillId(id: string): boolean {
    return this.listBuiltInSkillIds().has(id);
  }

  resolveSkillDir(skillId: string): string {
    const skills = this.listSkills();
    const skill = skills.find(s => s.id === skillId);
    if (!skill) {
      throw new Error('Skill not found');
    }
    return path.dirname(skill.skillPath);
  }

  repairSkillFromBundled(skillId: string, skillPath: string): boolean {
    if (!app.isPackaged) return false;

    const bundledRoot = this.getBundledSkillsRoot();
    if (!bundledRoot || !fs.existsSync(bundledRoot)) {
      return false;
    }

    const bundledPath = path.join(bundledRoot, skillId);
    if (!fs.existsSync(bundledPath) || bundledPath === skillPath) {
      return false;
    }

    // Check if bundled version has node_modules
    const bundledNodeModules = path.join(bundledPath, 'node_modules');
    if (!fs.existsSync(bundledNodeModules)) {
      console.log(`[skills] Bundled ${skillId} does not have node_modules, skipping repair`);
      return false;
    }

    try {
      console.log(`[skills] Repairing ${skillId} from bundled resources...`);
      fs.cpSync(bundledPath, skillPath, {
        recursive: true,
        dereference: true,
        force: true,
        errorOnExist: false,
      });
      console.log(`[skills] Repaired ${skillId} from bundled resources`);
      return true;
    } catch (error) {
      console.warn(`[skills] Failed to repair ${skillId} from bundled resources:`, error);
      return false;
    }
  }

  private parseSkillDir(
    dir: string,
    state: SkillStateMap,
    defaults: Record<string, SkillDefaultConfig>,
    isBuiltIn: boolean
  ): SkillRecord | null {
    const skillFile = path.join(dir, SKILL_FILE_NAME);
    if (!fs.existsSync(skillFile)) return null;
    try {
      const raw = fs.readFileSync(skillFile, 'utf8');
      const { frontmatter, content } = parseFrontmatter(raw);
      const name = (String(frontmatter.name || '') || path.basename(dir)).trim() || path.basename(dir);
      const description = (String(frontmatter.description || '') || extractDescription(content) || name).trim();
      const isOfficial = isTruthy(frontmatter.official) || isTruthy(frontmatter.isOfficial);
      const version = typeof frontmatter.version === 'string' ? frontmatter.version
        : typeof frontmatter.version === 'number' ? String(frontmatter.version)
        : undefined;
      const updatedAt = fs.statSync(skillFile).mtimeMs;
      const id = path.basename(dir);
      const prompt = content.trim();
      const defaultEnabled = defaults[id]?.enabled ?? true;
      const enabled = state[id]?.enabled ?? defaultEnabled;
      return { id, name, description, enabled, isOfficial, isBuiltIn, updatedAt, prompt, skillPath: skillFile, version };
    } catch (error) {
      console.warn('[skills] Failed to parse skill:', dir, error);
      return null;
    }
  }
}

function isWebSearchSkillBroken(skillRoot: string): boolean {
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
}
