import re

with open('src/main/domains/cowork/service/coworkRunner.ts', 'r', encoding='utf-8') as f:
    content = f.read()

# 1. Add import block after coworkRunnerAttachment import
import_block = """import {
  buildSandboxEnv,
  buildPromptPrefix,
  composeEffectiveSystemPrompt,
  enforceSandboxWorkspacePrompt,
  findSkillsMarkerIndex,
  resolveSkillPathFromRoots,
  type SandboxSkillRewriteOptions,
  type SandboxSkillEntry,
  type SandboxSkillRootMount,
  SANDBOX_SKILLS_MOUNT_TAG,
  SANDBOX_SKILLS_GUEST_PATH,
  SANDBOX_SKILLS_GUEST_PATH_WINDOWS,
  LEGACY_SKILLS_ROOT_HINTS,
  SKILLS_MARKER,
} from './coworkRunnerPrompt';"""

old_import = """import {
  parseAttachmentEntries,
  resolveAttachmentPath,
  toWorkspaceRelativePromptPath,
  preparePromptForSandbox,
  pushStagedAttachmentsToSandbox,
  findAttachmentsOutsideCwd,
} from './coworkRunnerAttachment';"""

content = content.replace(old_import, old_import + '\n' + import_block)

# 2. Remove constants/functions that are now imported
remove_block = """const SANDBOX_SKILLS_MOUNT_TAG = 'skills';
// On macOS/Linux, keep sandbox skills outside the project workspace mount to
// avoid creating skills directories in the user's selected host folder.
// On Windows, keep historical path for compatibility with serial-mode flows.
const SANDBOX_SKILLS_GUEST_PATH = '/workspace/skills';
const SANDBOX_SKILLS_GUEST_PATH_WINDOWS = '/workspace/project/skills';
"""
content = content.replace(remove_block, '')

remove_block2 = """const LEGACY_SKILLS_ROOT_HINTS = [
  '/home/ubuntu/skills',
  '/mnt/skills',
  '/tmp/workspace/skills',
  '/workspace/skills',
  '/workspace/skills',
];
"""
content = content.replace(remove_block2, '')

remove_block3 = """const SKILLS_MARKER = '/skills/';
"""
content = content.replace(remove_block3, '')

# 3. Remove findSkillsMarkerIndex and resolveSkillPathFromRoots functions
func_remove = """function findSkillsMarkerIndex(value: string): number {
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

  const normalized = trimmed.replace(/\\\\/g, '/');
  const markerIndex = findSkillsMarkerIndex(normalized);
  if (markerIndex >= 0) {
    const relative = normalized.slice(markerIndex + SKILLS_MARKER.length).replace(/^\\/+/, '');
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

// Event types emitted by the runner"""

content = content.replace(func_remove, '// Event types emitted by the runner')

# 4. Remove type definitions now imported
remove_types = """type SandboxSkillRewriteOptions = {
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

"""
content = content.replace(remove_types, '')

# 5. Replace this.buildSandboxEnv(...) -> buildSandboxEnv(...)
content = re.sub(r'this\.buildSandboxEnv\(', 'buildSandboxEnv(', content)

# 6. Replace prompt-building method calls
content = re.sub(r'this\.buildLocalTimeContextPrompt\(\)', 'buildLocalTimeContextPrompt()', content)
content = re.sub(r'this\.buildWindowsEncodingPrompt\(\)', 'buildWindowsEncodingPrompt()', content)
content = re.sub(r'this\.buildWindowsBundledRuntimePrompt\(\)', 'buildWindowsBundledRuntimePrompt()', content)
content = re.sub(r'this\.buildWorkspaceSafetyPrompt\(', 'buildWorkspaceSafetyPrompt(', content)
content = re.sub(r'this\.composeEffectiveSystemPrompt\(', 'composeEffectiveSystemPrompt(', content)
content = re.sub(r'this\.enforceSandboxWorkspacePrompt\(', 'enforceSandboxWorkspacePrompt(', content)

# 7. Replace this.buildPromptPrefix() -> buildPromptPrefix(this.buildUserMemoriesXml())
content = re.sub(r'this\.buildPromptPrefix\(\)', 'buildPromptPrefix(this.buildUserMemoriesXml())', content)

# 8. Remove private methods that were extracted
# Remove formatLocalDateTime
content = re.sub(
    r"  private formatLocalDateTime\(date: Date\): string \{\n    const pad = \(value: number\): string => String\(value\)\.padStart\(2, '0'\);\n    return `\$\{date\.getFullYear\(\)\}-\$\{pad\(date\.getMonth\(\) \+ 1\)\}-\$\{pad\(date\.getDate\(\)\)\} \$\{pad\(date\.getHours\(\)\)\}:\$\{pad\(date\.getMinutes\(\)\)\}:\$\{pad\(date\.getSeconds\(\)\)\}`;\n  \}\n\n",
    "",
    content
)

# Remove formatLocalIsoWithoutTimezone
content = re.sub(
    r"  private formatLocalIsoWithoutTimezone\(date: Date\): string \{\n    const pad = \(value: number\): string => String\(value\)\.padStart\(2, '0'\);\n    return `\$\{date\.getFullYear\(\)\}-\$\{pad\(date\.getMonth\(\) \+ 1\)\}-\$\{pad\(date\.getDate\(\)\)\}T\$\{pad\(date\.getHours\(\)\)\}:\$\{pad\(date\.getMinutes\(\)\)\}:\$\{pad\(date\.getSeconds\(\)\)\}`;\n  \}\n\n",
    "",
    content
)

# Remove formatUtcOffset
content = re.sub(
    r"  private formatUtcOffset\(date: Date\): string \{\n    const offsetMinutes = -date\.getTimezoneOffset\(\);\n    const sign = offsetMinutes >= 0 \? '\+' : '-';\n    const absMinutes = Math\.abs\(offsetMinutes\);\n    const hours = Math\.floor\(absMinutes / 60\);\n    const minutes = absMinutes % 60;\n    return `\$\{sign\}\$\{String\(hours\)\.padStart\(2, '0'\)\}:\$\{String\(minutes\)\.padStart\(2, '0'\)\}`;\n  \}\n\n",
    "",
    content
)

# Remove buildLocalTimeContextPrompt
content = re.sub(
    r"  private buildLocalTimeContextPrompt\(\): string \{[\s\S]*?\n  \}\n\n",
    "",
    content
)

# Remove buildWindowsEncodingPrompt
content = re.sub(
    r"  private buildWindowsEncodingPrompt\(\): string \{[\s\S]*?\n  \}\n\n",
    "",
    content
)

# Remove buildWindowsBundledRuntimePrompt
content = re.sub(
    r"  private buildWindowsBundledRuntimePrompt\(\): string \{[\s\S]*?\n  \}\n\n",
    "",
    content
)

# Remove buildWorkspaceSafetyPrompt
content = re.sub(
    r"  private buildWorkspaceSafetyPrompt\([\s\S]*?\n  \}\n\n",
    "",
    content
)

# Remove composeEffectiveSystemPrompt
content = re.sub(
    r"  private composeEffectiveSystemPrompt\([\s\S]*?\n  \}\n\n",
    "",
    content
)

# Remove buildPromptPrefix
content = re.sub(
    r"  /\*\*\n   \* Build a dynamic prompt prefix[\s\S]*?\n  \}\n\n",
    "",
    content
)

# Remove buildSandboxEnv
content = re.sub(
    r"  private buildSandboxEnv\([\s\S]*?\n  \}\n\n",
    "",
    content
)

# Remove enforceSandboxWorkspacePrompt
content = re.sub(
    r"  private enforceSandboxWorkspacePrompt\([\s\S]*?\n  \}\n\n",
    "",
    content
)

with open('src/main/domains/cowork/service/coworkRunner.ts', 'w', encoding='utf-8') as f:
    f.write(content)

print('Done')
