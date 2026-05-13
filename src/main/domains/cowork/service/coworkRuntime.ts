import { app } from 'electron';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import { buildEnvForConfig, getCurrentApiConfig, resolveCurrentApiConfig } from './claudeSettings';
import type { OpenAICompatProxyTarget } from './coworkOpenAICompatProxy';
import { getInternalApiBaseURL } from './coworkOpenAICompatProxy';
import { coworkLog } from './coworkLogger';
import { isSystemProxyEnabled, resolveSystemProxyUrl } from '../../../system/service/systemProxy';
import { applyPackagedEnvOverrides } from './envSetup';
import { getElectronNodeRuntimePath } from './windowsRuntime';

/**
 * Get skills directory path (handles both development and production)
 */
export function getSkillsRoot(): string {
  if (app.isPackaged) {
    // In production, skills are copied to userData
    return join(app.getPath('userData'), 'skills');
  }

  // In development, __dirname can vary with bundling output (e.g. dist-electron/ or dist-electron/libs/).
  // Resolve from several stable anchors and pick the first existing skills directory.
  const envRoots = [process.env.LUMIAI_SKILLS_ROOT, process.env.SKILLS_ROOT]
    .map((value) => value?.trim())
    .filter((value): value is string => Boolean(value));
  const candidates = [
    ...envRoots,
    join(app.getAppPath(), 'skills'),
    join(process.cwd(), 'skills'),
    join(__dirname, '..', 'skills'),
    join(__dirname, '..', '..', 'skills'),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  // Final fallback for first-run dev environments where skills may not exist yet.
  return join(app.getAppPath(), 'skills');
}

/**
 * Get enhanced environment variables (including proxy configuration)
 * Async function to fetch system proxy and inject into environment variables
 */
export async function getEnhancedEnv(target: OpenAICompatProxyTarget = 'local'): Promise<Record<string, string | undefined>> {
  const config = getCurrentApiConfig(target);
  const env = config
    ? buildEnvForConfig(config)
    : { ...process.env };

  applyPackagedEnvOverrides(env);

  // Inject skills directory path for skill scripts.
  // On Windows, normalise backslashes to forward slashes so the value is usable
  // in both Node.js (which accepts forward slashes) and bash (which treats
  // backslashes as escape characters).
  const skillsRoot = getSkillsRoot().replace(/\\/g, '/');
  env.SKILLS_ROOT = skillsRoot;
  env.LUMIAI_SKILLS_ROOT = skillsRoot; // Alternative name for clarity
  if (process.platform === 'win32' || env.LUMIAI_NODE_SHIM_ACTIVE === '1') {
    env.LUMIAI_ELECTRON_PATH = getElectronNodeRuntimePath().replace(/\\/g, '/');
  } else {
    delete env.LUMIAI_ELECTRON_PATH;
  }

  // Inject internal API base URL for skill scripts (e.g. scheduled-task creation)
  const internalApiBaseURL = getInternalApiBaseURL();
  if (internalApiBaseURL) {
    env.LUMIAI_API_BASE_URL = internalApiBaseURL;
  }

  // Skip system proxy resolution if proxy env vars already exist
  if (env.http_proxy || env.HTTP_PROXY || env.https_proxy || env.HTTPS_PROXY) {
    return env;
  }

  // User can disable system proxy from settings.
  if (!isSystemProxyEnabled()) {
    return env;
  }

  // Resolve proxy from system settings
  const proxyUrl = await resolveSystemProxyUrl('https://openrouter.ai');
  if (proxyUrl) {
    env.http_proxy = proxyUrl;
    env.https_proxy = proxyUrl;
    env.HTTP_PROXY = proxyUrl;
    env.HTTPS_PROXY = proxyUrl;
    console.log('Injected system proxy for subprocess:', proxyUrl);
  }

  return env;
}

/**
 * Ensure the cowork temp directory exists in the given working directory
 * @param cwd Working directory path
 * @returns Path to the temp directory
 */
export function ensureCoworkTempDir(cwd: string): string {
  const tempDir = join(cwd, '.cowork-temp');
  if (!existsSync(tempDir)) {
    try {
      mkdirSync(tempDir, { recursive: true });
      console.log('Created cowork temp directory:', tempDir);
    } catch (error) {
      console.error('Failed to create cowork temp directory:', error);
      // Fall back to cwd if we can't create the temp dir
      return cwd;
    }
  }
  return tempDir;
}

/**
 * Get enhanced environment variables with TMPDIR set to the cowork temp directory
 * This ensures Claude Agent SDK creates temporary files in the user's working directory
 * @param cwd Working directory path
 */
export async function getEnhancedEnvWithTmpdir(
  cwd: string,
  target: OpenAICompatProxyTarget = 'local'
): Promise<Record<string, string | undefined>> {
  const env = await getEnhancedEnv(target);
  const tempDir = ensureCoworkTempDir(cwd);

  // Set temp directory environment variables for all platforms
  env.TMPDIR = tempDir;  // macOS, Linux
  env.TMP = tempDir;     // Windows
  env.TEMP = tempDir;   // Windows

  return env;
}

const SESSION_TITLE_FALLBACK = 'New Session';
const SESSION_TITLE_MAX_CHARS = 50;
const SESSION_TITLE_TIMEOUT_MS = 8000;
const COWORK_MODEL_PROBE_TIMEOUT_MS = 20000;
const API_ERROR_SNIPPET_MAX_CHARS = 240;

function buildAnthropicMessagesUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) {
    return '/v1/messages';
  }
  if (normalized.endsWith('/v1/messages')) {
    return normalized;
  }
  if (normalized.endsWith('/v1')) {
    return `${normalized}/messages`;
  }
  return `${normalized}/v1/messages`;
}

function extractApiErrorSnippet(rawText: string): string {
  const trimmed = rawText.trim();
  if (!trimmed) {
    return '';
  }

  try {
    const payload = JSON.parse(trimmed) as Record<string, unknown>;
    const payloadError = payload.error;
    if (typeof payloadError === 'string' && payloadError.trim()) {
      return payloadError.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
    }
    if (payloadError && typeof payloadError === 'object') {
      const message = (payloadError as Record<string, unknown>).message;
      if (typeof message === 'string' && message.trim()) {
        return message.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
      }
    }
    const payloadMessage = payload.message;
    if (typeof payloadMessage === 'string' && payloadMessage.trim()) {
      return payloadMessage.trim().slice(0, API_ERROR_SNIPPET_MAX_CHARS);
    }
  } catch {
    // Fall through to plain-text extraction when response is not JSON.
  }

  return trimmed.replace(/\s+/g, ' ').slice(0, API_ERROR_SNIPPET_MAX_CHARS);
}

function extractTextFromAnthropicResponse(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return '';
  const record = payload as Record<string, unknown>;
  const content = record.content;
  if (Array.isArray(content)) {
    return content
      .map((item) => {
        if (!item || typeof item !== 'object') return '';
        const block = item as Record<string, unknown>;
        if (typeof block.text === 'string') {
          return block.text;
        }
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }
  if (typeof content === 'string') {
    return content.trim();
  }
  if (typeof record.output_text === 'string') {
    return record.output_text.trim();
  }
  return '';
}

function normalizeTitleToPlainText(value: string, fallback: string): string {
  if (!value.trim()) return fallback;

  let title = value.trim();
  const fenced = /```(?:[\w-]+)?\s*([\s\S]*?)```/i.exec(title);
  if (fenced?.[1]) {
    title = fenced[1].trim();
  }

  title = title
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1')
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/__([^_]+)__/g, '$1')
    .replace(/\*([^*\n]+)\*/g, '$1')
    .replace(/_([^_\n]+)_/g, '$1')
    .replace(/~~([^~]+)~~/g, '$1')
    .replace(/^\s{0,3}#{1,6}\s+/, '')
    .replace(/^\s*>\s?/, '')
    .replace(/^\s*[-*+]\s+/, '')
    .replace(/^\s*\d+\.\s+/, '')
    .replace(/\r?\n+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

  const labeledTitle = /^(?:title|标题)\s*[:：]\s*(.+)$/i.exec(title);
  if (labeledTitle?.[1]) {
    title = labeledTitle[1].trim();
  }

  title = title
    .replace(/^["'`"''']+/, '')
    .replace(/["'`"''']+$/, '')
    .trim();

  if (!title) return fallback;
  if (title.length > SESSION_TITLE_MAX_CHARS) {
    title = title.slice(0, SESSION_TITLE_MAX_CHARS).trim();
  }
  return title || fallback;
}

function buildFallbackSessionTitle(userIntent: string | null): string {
  const normalizedInput = typeof userIntent === 'string' ? userIntent.trim() : '';
  if (!normalizedInput) {
    return SESSION_TITLE_FALLBACK;
  }
  const firstLine = normalizedInput
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find(Boolean) || '';
  return normalizeTitleToPlainText(firstLine, SESSION_TITLE_FALLBACK);
}

export async function probeCoworkModelReadiness(
  timeoutMs = COWORK_MODEL_PROBE_TIMEOUT_MS
): Promise<{ ok: true } | { ok: false; error: string }> {
  const { config, error } = resolveCurrentApiConfig();
  if (!config) {
    return {
      ok: false,
      error: error || 'API configuration not found.',
    };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(buildAnthropicMessagesUrl(config.baseURL), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 1,
        temperature: 0,
        messages: [{ role: 'user', content: 'Reply with "ok".' }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      const errorSnippet = extractApiErrorSnippet(errorText);
      return {
        ok: false,
        error: errorSnippet
          ? `Model validation failed (${response.status}): ${errorSnippet}`
          : `Model validation failed with status ${response.status}.`,
      };
    }

    return { ok: true };
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      const timeoutSeconds = Math.ceil(timeoutMs / 1000);
      return {
        ok: false,
        error: `Model validation timed out after ${timeoutSeconds}s.`,
      };
    }
    return {
      ok: false,
      error: `Model validation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function generateSessionTitle(userIntent: string | null): Promise<string> {
  const normalizedInput = typeof userIntent === 'string' ? userIntent.trim() : '';
  const fallbackTitle = buildFallbackSessionTitle(normalizedInput);
  if (!normalizedInput) {
    return fallbackTitle;
  }

  const { config, error } = resolveCurrentApiConfig();
  if (!config) {
    if (error) {
      console.warn('[cowork-title] Skip title generation due to missing API config:', error);
    }
    return fallbackTitle;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), SESSION_TITLE_TIMEOUT_MS);

  try {
    const url = buildAnthropicMessagesUrl(config.baseURL);
    const prompt = `Generate a short title from this input, keep the same language, return plain text only (no markdown), and keep it within ${SESSION_TITLE_MAX_CHARS} characters: ${normalizedInput}`;

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': config.apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: config.model,
        max_tokens: 80,
        temperature: 0,
        messages: [{ role: 'user', content: prompt }],
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => '');
      console.warn(
        '[cowork-title] Failed to generate title:',
        response.status,
        errorText.slice(0, 240)
      );
      return fallbackTitle;
    }

    const payload = await response.json();
    const llmTitle = extractTextFromAnthropicResponse(payload);
    return normalizeTitleToPlainText(llmTitle, fallbackTitle);
  } catch (error) {
    console.error('Failed to generate session title:', error);
    return fallbackTitle;
  } finally {
    clearTimeout(timeoutId);
  }
}
