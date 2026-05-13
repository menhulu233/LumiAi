// src/main/domains/cowork/service/execution/sandboxSkills.ts
// Skill directory mounting and path rewriting for sandbox execution

import path from 'path';
import fs from 'fs';
import {
  rewriteSkillReferencesForSandbox,
  rewriteSkillLocationForSandbox,
} from '../coworkRunnerPrompt';
import {
  type SandboxCwdMapping,
  type SandboxExtraMount,
} from '../coworkVmRunner';
import { getSkillsRoot } from '../coworkUtil';

const SANDBOX_SKILLS_MOUNT_TAG = 'skills';
const SANDBOX_SKILLS_GUEST_PATH = '/workspace/skills';
const SANDBOX_SKILLS_GUEST_PATH_WINDOWS = '/workspace/project/skills';

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

export interface SandboxSkillsConfig {
  guestSkillsRoot: string | null;
  skillEntries: SandboxSkillEntry[];
  extraMounts: SandboxExtraMount[];
  skillMounts: Record<string, { tag: string; guestPath: string }>;
  rootMounts: SandboxSkillRootMount[];
}

export function collectHostSkillsRoots(
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
  for (const root of extractHostSkillRootsFromPrompt(systemPrompt)) {
    pushCandidate(root);
  }
  pushCandidate(getSkillsRoot());

  if (process.platform === 'win32') {
    pushCandidate(path.join(process.resourcesPath ?? '', 'skills'));
    pushCandidate(path.join(process.resourcesPath ?? '', 'skills'));
    pushCandidate(path.join(process.cwd?.() ?? '', 'skills'));
  } else {
    pushCandidate(path.join(process.resourcesPath ?? '', 'skills'));
    pushCandidate(path.join(process.cwd?.() ?? '', 'skills'));
  }

  pushCandidate(path.join(cwdMapping.hostPath, 'skills'));
  pushCandidate(path.join(cwdMapping.hostPath, 'skills'));

  return candidates.filter((candidate) => isDirectory(candidate));
}

export function collectSandboxSkillEntries(
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
    if (!isDirectory(resolvedRoot)) {
      continue;
    }

    // Root itself can be a skill directory.
    collectFromSkillDir(resolvedRoot);

    let entries: fs.Dirent[];
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

export function resolveSandboxSkillsConfig(
  hostSkillsRoots: string[],
  runtimePlatform: string
): SandboxSkillsConfig {
  const guestSkillsRoot = runtimePlatform === 'win32'
    ? SANDBOX_SKILLS_GUEST_PATH_WINDOWS
    : SANDBOX_SKILLS_GUEST_PATH;
  const skillEntries = collectSandboxSkillEntries(hostSkillsRoots, guestSkillsRoot);
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
    if (!entryRoots.has(resolved) || !isDirectory(resolved)) {
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

function isDirectory(target: string): boolean {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function extractHostSkillRootsFromPrompt(prompt: string): string[] {
  const roots: string[] = [];
  const patterns = [
    /Skill root:\s*([^\s\n]+)/gi,
    /技能根目录[：:]\s*([^\s\n]+)/gi,
    /Skills directory:\s*([^\s\n]+)/gi,
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(prompt)) !== null) {
      if (match[1]) {
        roots.push(match[1]);
      }
    }
  }
  return roots;
}

export function enforceSandboxWorkspacePrompt(systemPrompt: string, guestPath: string): string {
  if (!guestPath || guestPath === '/workspace' || guestPath === '/workspace/project') {
    return systemPrompt;
  }
  // Only add the workspace note if not already present
  const workspaceNote = `Working directory: ${guestPath}`;
  if (systemPrompt.includes(workspaceNote)) {
    return systemPrompt;
  }
  return `${workspaceNote}\n\n${systemPrompt}`;
}

export function resolveAutoRoutingForSandbox(
  systemPrompt: string,
  options: {
    guestSkillsRoot?: string | null;
    hostSkillsRoots?: string[];
    hostSkillsRootMounts?: SandboxSkillRootMount[];
  } = {}
): string | undefined {
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

  return rewrittenPrompt;
}
