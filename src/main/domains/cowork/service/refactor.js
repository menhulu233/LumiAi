const fs = require('fs');
const path = require('path');

const filePath = path.join(__dirname, 'coworkRunner.ts');
let content = fs.readFileSync(filePath, 'utf8');

// 1. Add import block after the last import
const importBlock = `import {
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
} from './coworkRunnerPrompt';`;

// Find the last import statement and add after it
const lastImportMatch = content.match(/import\s+.*?from\s+['"].*?['"];\s*\n(?=const\s+SANDBOX_ALLOWED)/);
if (lastImportMatch) {
  const insertPos = lastImportMatch.index + lastImportMatch[0].length;
  content = content.slice(0, insertPos) + importBlock + '\n' + content.slice(insertPos);
}

// 2. Remove constants that are now imported
content = content.replace(/const SANDBOX_SKILLS_MOUNT_TAG = 'skills';\n\/\/ On macOS\/Linux, keep sandbox skills outside the project workspace mount to\n\/\/ avoid creating skills directories in the user's selected host folder\.\n\/\/ On Windows, keep historical path for compatibility with serial-mode flows\.\nconst SANDBOX_SKILLS_GUEST_PATH = '\/workspace\/skills';\nconst SANDBOX_SKILLS_GUEST_PATH_WINDOWS = '\/workspace\/project\/skills';\n/, '');

content = content.replace(/const LEGACY_SKILLS_ROOT_HINTS = \[\n  '\/home\/ubuntu\/skills',\n  '\/mnt\/skills',\n  '\/tmp\/workspace\/skills',\n  '\/workspace\/skills',\n  '\/workspace\/skills',\n\];\n/, '');

content = content.replace(/const SKILLS_MARKER = '\/skills\/';\n/, '');

// 3. Remove findSkillsMarkerIndex and resolveSkillPathFromRoots functions
const funcPattern = /function findSkillsMarkerIndex\(value: string\): number \{\n  return value\.toLowerCase\(\)\.lastIndexOf\(SKILLS_MARKER\);\n\}\n\nfunction resolveSkillPathFromRoots\(\n  rawPath: string,\n  hostSkillsRoots: string\[\]\n\): string \| null \{[\s\S]*?return null;\n\}\n/;
content = content.replace(funcPattern, '');

// 4. Remove type definitions now imported
const typesPattern = /type SandboxSkillRewriteOptions = \{\n  guestSkillsRoot\?: string \| null;\n  hostSkillsRoots\?: string\[\];\n  hostSkillsRootMounts\?: SandboxSkillRootMount\[\];\n\};\n\ntype SandboxSkillEntry = \{\n  skillId: string;\n  hostPath: string;\n  guestPath: string;\n  mountTag: string;\n\};\n\ntype SandboxSkillRootMount = \{\n  hostRoot: string;\n  guestRoot: string;\n  mountTag: string;\n\};\n/;
content = content.replace(typesPattern, '');

// 5. Replace this.buildSandboxEnv(...) -> buildSandboxEnv(...)
content = content.replace(/this\.buildSandboxEnv\(/g, 'buildSandboxEnv(');

// 6. Replace prompt-building method calls
content = content.replace(/this\.buildLocalTimeContextPrompt\(\)/g, 'buildLocalTimeContextPrompt()');
content = content.replace(/this\.buildWindowsEncodingPrompt\(\)/g, 'buildWindowsEncodingPrompt()');
content = content.replace(/this\.buildWindowsBundledRuntimePrompt\(\)/g, 'buildWindowsBundledRuntimePrompt()');
content = content.replace(/this\.buildWorkspaceSafetyPrompt\(/g, 'buildWorkspaceSafetyPrompt(');
content = content.replace(/this\.composeEffectiveSystemPrompt\(/g, 'composeEffectiveSystemPrompt(');
content = content.replace(/this\.enforceSandboxWorkspacePrompt\(/g, 'enforceSandboxWorkspacePrompt(');

// 7. Replace this.buildPromptPrefix() -> buildPromptPrefix(this.buildUserMemoriesXml())
content = content.replace(/this\.buildPromptPrefix\(\)/g, 'buildPromptPrefix(this.buildUserMemoriesXml())');

// 8. Remove private methods that were extracted
// These are multi-line replacements - use regex with [\s\S]*?

// Remove formatLocalDateTime
content = content.replace(/  private formatLocalDateTime\(date: Date\): string \{\n    const pad = \(value: number\): string => String\(value\)\.padStart\(2, '0'\);\n    return `\$\{date\.getFullYear\(\)\}-\$\{pad\(date\.getMonth\(\) \+ 1\)\}-\$\{pad\(date\.getDate\(\)\)\} \$\{pad\(date\.getHours\(\)\)\}:\$\{pad\(date\.getMinutes\(\)\)\}:\$\{pad\(date\.getSeconds\(\)\)\}`;\n  \}\n\n/, '');

// Remove formatLocalIsoWithoutTimezone
content = content.replace(/  private formatLocalIsoWithoutTimezone\(date: Date\): string \{\n    const pad = \(value: number\): string => String\(value\)\.padStart\(2, '0'\);\n    return `\$\{date\.getFullYear\(\)\}-\$\{pad\(date\.getMonth\(\) \+ 1\)\}-\$\{pad\(date\.getDate\(\)\)\}T\$\{pad\(date\.getHours\(\)\)\}:\$\{pad\(date\.getMinutes\(\)\)\}:\$\{pad\(date\.getSeconds\(\)\)\}`;\n  \}\n\n/, '');

// Remove formatUtcOffset
content = content.replace(/  private formatUtcOffset\(date: Date\): string \{\n    const offsetMinutes = -date\.getTimezoneOffset\(\);\n    const sign = offsetMinutes >= 0 \? '\+' : '-';\n    const absMinutes = Math\.abs\(offsetMinutes\);\n    const hours = Math\.floor\(absMinutes \/ 60\);\n    const minutes = absMinutes % 60;\n    return `\$\{sign\}\$\{String\(hours\)\.padStart\(2, '0'\)\}:\$\{String\(minutes\)\.padStart\(2, '0'\)\}`;\n  \}\n\n/, '');

// Remove buildLocalTimeContextPrompt
content = content.replace(/  private buildLocalTimeContextPrompt\(\): string \{[\s\S]*?\n  \}\n\n/, '');

// Remove buildWindowsEncodingPrompt
content = content.replace(/  private buildWindowsEncodingPrompt\(\): string \{[\s\S]*?\n  \}\n\n/, '');

// Remove buildWindowsBundledRuntimePrompt
content = content.replace(/  private buildWindowsBundledRuntimePrompt\(\): string \{[\s\S]*?\n  \}\n\n/, '');

// Remove buildWorkspaceSafetyPrompt
content = content.replace(/  private buildWorkspaceSafetyPrompt\([\s\S]*?\n  \}\n\n/, '');

// Remove composeEffectiveSystemPrompt
content = content.replace(/  private composeEffectiveSystemPrompt\([\s\S]*?\n  \}\n\n/, '');

// Remove buildPromptPrefix with its JSDoc
content = content.replace(/  \/\*\*\n   \* Build a dynamic prompt prefix[\s\S]*?\n  \}\n\n/, '');

// Remove buildSandboxEnv
content = content.replace(/  private buildSandboxEnv\([\s\S]*?\n  \}\n\n/, '');

// Remove enforceSandboxWorkspacePrompt
content = content.replace(/  private enforceSandboxWorkspacePrompt\([\s\S]*?\n  \}\n\n/, '');

fs.writeFileSync(filePath, content, 'utf8');
console.log('Refactoring complete');
