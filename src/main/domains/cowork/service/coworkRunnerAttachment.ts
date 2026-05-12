import fs from 'fs';
import path from 'path';
import { cpRecursiveSync } from '../../../utils/fsCompat';
import { coworkLog } from './coworkLogger';
import { VirtioSerialBridge } from './coworkVmRunner';

const ATTACHMENT_LINE_RE = /^\s*(?:[-*]\s*)?(输入文件|input\s*file)\s*[:：]\s*(.+?)\s*$/i;
const SANDBOX_ATTACHMENT_DIR = path.join('.cowork-temp', 'attachments');
const SANDBOX_WORKSPACE_GUEST_ROOT = '/workspace/project';

export type AttachmentEntry = {
  lineIndex: number;
  label: string;
  rawPath: string;
};

export function parseAttachmentEntries(prompt: string): AttachmentEntry[] {
  const lines = prompt.split(/\r?\n/);
  const entries: AttachmentEntry[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = line.match(ATTACHMENT_LINE_RE);
    if (!match?.[1] || !match[2]) continue;
    entries.push({
      lineIndex: i,
      label: match[1],
      rawPath: match[2].trim(),
    });
  }
  return entries;
}

export function resolveAttachmentPath(inputPath: string, cwd: string): string {
  if (inputPath.startsWith('~/')) {
    const home = process.env.HOME || process.env.USERPROFILE || '';
    return home ? path.resolve(home, inputPath.slice(2)) : path.resolve(cwd, inputPath);
  }
  return path.isAbsolute(inputPath) ? path.resolve(inputPath) : path.resolve(cwd, inputPath);
}

export function toWorkspaceRelativePromptPath(cwd: string, absolutePath: string): string {
  const relative = path.relative(cwd, absolutePath);
  const normalized = relative.split(path.sep).join('/');
  if (!normalized || normalized === '.') {
    return './';
  }
  return normalized.startsWith('.') ? normalized : `./${normalized}`;
}

export function stageExternalAttachment(
  cwd: string,
  sourcePath: string,
  sessionId: string,
  index: number
): string | null {
  if (!fs.existsSync(sourcePath)) {
    return null;
  }

  try {
    const sourceStat = fs.statSync(sourcePath);
    const stageRoot = path.join(cwd, SANDBOX_ATTACHMENT_DIR, sessionId);
    fs.mkdirSync(stageRoot, { recursive: true });

    const baseName = path.basename(sourcePath) || `attachment-${index + 1}`;
    const parsed = path.parse(baseName);
    let targetPath = path.join(stageRoot, baseName);
    let suffix = 1;
    while (fs.existsSync(targetPath)) {
      targetPath = path.join(stageRoot, `${parsed.name}-${suffix}${parsed.ext}`);
      suffix += 1;
    }

    if (sourceStat.isDirectory()) {
      cpRecursiveSync(sourcePath, targetPath, { force: true });
    } else {
      fs.copyFileSync(sourcePath, targetPath);
    }

    return toWorkspaceRelativePromptPath(cwd, targetPath);
  } catch (error) {
    console.warn('[cowork] Failed to stage sandbox attachment:', sourcePath, error);
    return null;
  }
}

/**
 * Push staged attachment files from .cowork-temp/attachments/{sessionId}/ to
 * the sandbox VM via virtio-serial bridge.  On macOS/Linux, attachments are
 * accessible via 9p mount, so this is only needed on Windows (serial mode).
 */
export function pushStagedAttachmentsToSandbox(
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
  coworkLog('INFO', 'runSandbox', 'Pushed staged attachments to sandbox', {
    sessionId,
    fileCount: files.length,
    files: files.map((f) => f.relativePath).join(', '),
  });
}

export function preparePromptForSandbox(
  prompt: string,
  cwd: string,
  sessionId: string
): {
  prompt: string;
  unresolved: string[];
} {
  const lines = prompt.split(/\r?\n/);
  const entries = parseAttachmentEntries(prompt);
  if (entries.length === 0) {
    return { prompt, unresolved: [] };
  }

  const unresolved: string[] = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i];
    const resolvedPath = resolveAttachmentPath(entry.rawPath, cwd);
    const relative = path.relative(cwd, resolvedPath);
    const isOutside = relative.startsWith('..') || path.isAbsolute(relative);

    let sandboxPath: string | null;
    if (isOutside) {
      sandboxPath = stageExternalAttachment(cwd, resolvedPath, sessionId, i);
    } else {
      sandboxPath = toWorkspaceRelativePromptPath(cwd, resolvedPath);
    }

    if (!sandboxPath) {
      unresolved.push(entry.rawPath);
      continue;
    }

    lines[entry.lineIndex] = `${entry.label}: ${sandboxPath}`;
  }

  return {
    prompt: lines.join('\n'),
    unresolved,
  };
}

export function findAttachmentsOutsideCwd(prompt: string, cwd: string): string[] {
  const attachments = parseAttachmentEntries(prompt);
  if (attachments.length === 0) {
    return [];
  }

  const resolvedCwd = path.resolve(cwd);
  const outside: string[] = [];
  for (const attachment of attachments) {
    const resolvedPath = resolveAttachmentPath(attachment.rawPath, resolvedCwd);
    const relative = path.relative(resolvedCwd, resolvedPath);
    if (relative.startsWith('..') || path.isAbsolute(relative)) {
      outside.push(attachment.rawPath);
    }
  }
  return outside;
}
