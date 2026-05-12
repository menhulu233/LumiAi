import http from 'http';
import { BrowserWindow, session } from 'electron';
import {
  anthropicToOpenAI,
  openAIToAnthropic,
} from './coworkFormatTransform';
import type { ScheduledTaskStore, ScheduledTaskInput } from '../../scheduled-task/store/scheduledTaskStore';
import type { Scheduler } from '../../scheduled-task/service/scheduler';
import {
  writeJSON,
  readRequestBody,
  createAnthropicErrorBody,
  extractErrorMessage,
  estimateAnthropicCountTokensRequestInputTokens,
  normalizeScheduledTaskWorkingDirectory,
  resolveUpstreamAPIType,
  buildUpstreamTargetUrls,
  filterOpenAIToolsForProvider,
  remapMessageRolesForMiniMax,
  hydrateOpenAIRequestToolCalls,
  normalizeMaxTokensFieldForOpenAIProvider,
  mergeSystemMessagesForProvider,
  isMaxTokensUnsupportedError,
  isToolsUnsupportedError,
  stripToolsFromRequest,
  convertMaxTokensToMaxCompletionTokens,
  clampMaxTokensFromError,
  convertChatCompletionsRequestToResponsesRequest,
  handleResponsesStreamResponse,
  handleChatCompletionsStreamResponse,
  createStreamState,
  createResponsesStreamContext,
  findSSEPacketBoundary,
  processResponsesStreamEvent,
  convertResponsesToOpenAIResponse,
  cacheToolCallExtraContentFromOpenAIResponse,
  cacheToolCallExtraContentFromResponsesResponse,
} from './coworkOpenAICompatUtils';

export type OpenAICompatUpstreamConfig = {
  baseURL: string;
  apiKey?: string;
  model: string;
  provider?: string;
};

export type OpenAICompatProxyTarget = 'local' | 'sandbox';

export type OpenAICompatProxyStatus = {
  running: boolean;
  baseURL: string | null;
  hasUpstream: boolean;
  upstreamBaseURL: string | null;
  upstreamModel: string | null;
  lastError: string | null;
};

const PROXY_BIND_HOST = '127.0.0.1';
const LOCAL_HOST = '127.0.0.1';
const SANDBOX_HOST = '10.0.2.2';

let proxyServer: http.Server | null = null;
let proxyPort: number | null = null;
let upstreamConfig: OpenAICompatUpstreamConfig | null = null;
let lastProxyError: string | null = null;

// --- Scheduled task API dependencies ---
interface ScheduledTaskDeps {
  getScheduledTaskStore: () => ScheduledTaskStore;
  getScheduler: () => Scheduler;
}
let scheduledTaskDeps: ScheduledTaskDeps | null = null;

export function setScheduledTaskDeps(deps: ScheduledTaskDeps): void {
  scheduledTaskDeps = deps;
}

async function handleCreateScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid request body' } as any);
    return;
  }

  let input: any;
  try {
    input = JSON.parse(body);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid JSON' } as any);
    return;
  }

  // Validate required fields
  if (!input.name?.trim()) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: name' } as any);
    return;
  }
  if (!input.prompt?.trim()) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: prompt' } as any);
    return;
  }
  if (!input.schedule?.type) {
    writeJSON(res, 400, { success: false, error: 'Missing required field: schedule.type' } as any);
    return;
  }
  if (!['at', 'interval', 'cron'].includes(input.schedule.type)) {
    writeJSON(res, 400, { success: false, error: 'Invalid schedule type. Must be: at, interval, cron' } as any);
    return;
  }
  if (input.schedule.type === 'cron' && !input.schedule.expression) {
    writeJSON(res, 400, { success: false, error: 'Cron schedule requires expression field' } as any);
    return;
  }
  if (input.schedule.type === 'at' && !input.schedule.datetime) {
    writeJSON(res, 400, { success: false, error: 'At schedule requires datetime field' } as any);
    return;
  }

  // Validate: "at" type must be in the future
  if (input.schedule.type === 'at' && input.schedule.datetime) {
    const targetMs = new Date(input.schedule.datetime).getTime();
    if (targetMs <= Date.now()) {
      writeJSON(res, 400, { success: false, error: 'Execution time must be in the future for one-time (at) tasks' } as any);
      return;
    }
  }

  // Validate: expiresAt must not be in the past
  if (input.expiresAt) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (input.expiresAt <= todayStr) {
      writeJSON(res, 400, { success: false, error: 'Expiration date must be in the future' } as any);
      return;
    }
  }

  // Build ScheduledTaskInput with defaults
  const taskInput: ScheduledTaskInput = {
    name: input.name.trim(),
    description: input.description || '',
    schedule: input.schedule,
    prompt: input.prompt.trim(),
    workingDirectory: normalizeScheduledTaskWorkingDirectory(input.workingDirectory),
    systemPrompt: input.systemPrompt || '',
    executionMode: input.executionMode || 'auto',
    expiresAt: input.expiresAt || null,
    notifyPlatforms: input.notifyPlatforms || [],
    enabled: input.enabled !== false,
  };

  try {
    const task = scheduledTaskDeps.getScheduledTaskStore().createTask(taskInput);
    scheduledTaskDeps.getScheduler().reschedule();

    // Notify renderer to refresh task list
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('scheduledTask:statusUpdate', {
        taskId: task.id,
        state: task.state,
      });
    }

    console.log(`[CoworkProxy] Scheduled task created via API: ${task.id} "${task.name}"`);
    writeJSON(res, 201, { success: true, task } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to create scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleListScheduledTasks(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }
  try {
    const tasks = scheduledTaskDeps.getScheduledTaskStore().listTasks();
    writeJSON(res, 200, { success: true, tasks } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to list scheduled tasks:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleGetScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }
  try {
    const task = scheduledTaskDeps.getScheduledTaskStore().getTask(id);
    if (!task) {
      writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
      return;
    }
    writeJSON(res, 200, { success: true, task } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to get scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleUpdateScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }

  // Verify task exists first
  const existing = scheduledTaskDeps.getScheduledTaskStore().getTask(id);
  if (!existing) {
    writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid request body' } as any);
    return;
  }

  let input: any;
  try {
    input = JSON.parse(body);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid JSON' } as any);
    return;
  }

  // Validate schedule if provided
  if (input.schedule !== undefined) {
    if (!input.schedule?.type) {
      writeJSON(res, 400, { success: false, error: 'schedule.type is required when schedule is provided' } as any);
      return;
    }
    if (!['at', 'interval', 'cron'].includes(input.schedule.type)) {
      writeJSON(res, 400, { success: false, error: 'Invalid schedule type. Must be: at, interval, cron' } as any);
      return;
    }
    if (input.schedule.type === 'cron' && !input.schedule.expression) {
      writeJSON(res, 400, { success: false, error: 'Cron schedule requires expression field' } as any);
      return;
    }
    if (input.schedule.type === 'at') {
      if (!input.schedule.datetime) {
        writeJSON(res, 400, { success: false, error: 'At schedule requires datetime field' } as any);
        return;
      }
      if (new Date(input.schedule.datetime).getTime() <= Date.now()) {
        writeJSON(res, 400, { success: false, error: 'Execution time must be in the future for one-time (at) tasks' } as any);
        return;
      }
    }
  }

  // Validate expiresAt if provided
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    const todayStr = new Date().toISOString().slice(0, 10);
    if (input.expiresAt <= todayStr) {
      writeJSON(res, 400, { success: false, error: 'Expiration date must be in the future' } as any);
      return;
    }
  }

  // Normalize workingDirectory if provided
  const updateInput: Partial<ScheduledTaskInput> = { ...input };
  if (input.workingDirectory !== undefined) {
    updateInput.workingDirectory = normalizeScheduledTaskWorkingDirectory(input.workingDirectory);
  }

  try {
    const task = scheduledTaskDeps.getScheduledTaskStore().updateTask(id, updateInput);
    if (!task) {
      writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
      return;
    }
    scheduledTaskDeps.getScheduler().reschedule();

    // Notify renderer to refresh task list
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('scheduledTask:statusUpdate', {
        taskId: task.id,
        state: task.state,
      });
    }

    console.log(`[CoworkProxy] Scheduled task updated via API: ${task.id} "${task.name}"`);
    writeJSON(res, 200, { success: true, task } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to update scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleDeleteScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }

  const existing = scheduledTaskDeps.getScheduledTaskStore().getTask(id);
  if (!existing) {
    writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
    return;
  }

  try {
    scheduledTaskDeps.getScheduledTaskStore().deleteTask(id);
    scheduledTaskDeps.getScheduler().reschedule();

    // Notify renderer to refresh task list
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('scheduledTask:statusUpdate', {
        taskId: id,
        state: null,
      });
    }

    console.log(`[CoworkProxy] Scheduled task deleted via API: ${id} "${existing.name}"`);
    writeJSON(res, 200, { success: true } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to delete scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleToggleScheduledTask(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  id: string
): Promise<void> {
  if (!scheduledTaskDeps) {
    writeJSON(res, 503, { success: false, error: 'Scheduled task service not available' } as any);
    return;
  }

  let body: string;
  try {
    body = await readRequestBody(req);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid request body' } as any);
    return;
  }

  let input: any;
  try {
    input = JSON.parse(body);
  } catch {
    writeJSON(res, 400, { success: false, error: 'Invalid JSON' } as any);
    return;
  }

  if (typeof input.enabled !== 'boolean') {
    writeJSON(res, 400, { success: false, error: 'Field "enabled" (boolean) is required' } as any);
    return;
  }

  try {
    const { task, warning } = scheduledTaskDeps.getScheduledTaskStore().toggleTask(id, input.enabled);
    if (!task) {
      writeJSON(res, 404, { success: false, error: `Task not found: ${id}` } as any);
      return;
    }
    scheduledTaskDeps.getScheduler().reschedule();

    // Notify renderer to refresh task list
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send('scheduledTask:statusUpdate', {
        taskId: task.id,
        state: task.state,
      });
    }

    console.log(`[CoworkProxy] Scheduled task toggled via API: ${task.id} "${task.name}" enabled=${input.enabled}`);
    writeJSON(res, 200, { success: true, task, warning } as any);
  } catch (err: any) {
    console.error('[CoworkProxy] Failed to toggle scheduled task:', err);
    writeJSON(res, 500, { success: false, error: err.message } as any);
  }
}

async function handleRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse
): Promise<void> {
  const method = (req.method || 'GET').toUpperCase();
  const url = new URL(req.url || '/', `http://${LOCAL_HOST}`);

  if (method === 'GET' && url.pathname === '/healthz') {
    writeJSON(res, 200, {
      ok: true,
      running: Boolean(proxyServer),
      hasUpstream: Boolean(upstreamConfig),
      lastError: lastProxyError,
    });
    return;
  }

  // Scheduled task API
  const TASK_LIST_PATH = '/api/scheduled-tasks';
  const TASK_ITEM_RE = /^\/api\/scheduled-tasks\/([^/]+)$/;
  const TASK_TOGGLE_RE = /^\/api\/scheduled-tasks\/([^/]+)\/toggle$/;

  if (method === 'GET' && url.pathname === TASK_LIST_PATH) {
    await handleListScheduledTasks(req, res);
    return;
  }
  if (method === 'POST' && url.pathname === TASK_LIST_PATH) {
    await handleCreateScheduledTask(req, res);
    return;
  }

  // Toggle check BEFORE item check (more specific path)
  const toggleMatch = TASK_TOGGLE_RE.exec(url.pathname);
  if (method === 'POST' && toggleMatch) {
    await handleToggleScheduledTask(req, res, toggleMatch[1]);
    return;
  }

  const itemMatch = TASK_ITEM_RE.exec(url.pathname);
  if (itemMatch) {
    const id = itemMatch[1];
    if (method === 'GET') { await handleGetScheduledTask(req, res, id); return; }
    if (method === 'PUT') { await handleUpdateScheduledTask(req, res, id); return; }
    if (method === 'DELETE') { await handleDeleteScheduledTask(req, res, id); return; }
  }
  console.log(`[CoworkProxy] ${method} ${url.pathname}`);

  if (method === 'POST' && url.pathname === '/api/event_logging/batch') {
    writeJSON(res, 200, { ok: true });
    return;
  }

  if (method === 'POST' && url.pathname === '/v1/messages/count_tokens') {
    let requestBodyRaw = '';
    try {
      requestBodyRaw = await readRequestBody(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Invalid request body';
      writeJSON(res, 400, createAnthropicErrorBody(message, 'invalid_request_error'));
      return;
    }

    let parsedRequestBody: unknown;
    try {
      parsedRequestBody = JSON.parse(requestBodyRaw);
    } catch {
      writeJSON(res, 400, createAnthropicErrorBody('Request body must be valid JSON', 'invalid_request_error'));
      return;
    }

    writeJSON(res, 200, {
      input_tokens: estimateAnthropicCountTokensRequestInputTokens(parsedRequestBody),
    });
    return;
  }

  if (method !== 'POST' || url.pathname !== '/v1/messages') {
    writeJSON(res, 404, createAnthropicErrorBody('Not found', 'not_found_error'));
    return;
  }

  if (!upstreamConfig) {
    writeJSON(
      res,
      503,
      createAnthropicErrorBody('OpenAI compatibility proxy is not configured', 'service_unavailable')
    );
    return;
  }

  let requestBodyRaw = '';
  try {
    requestBodyRaw = await readRequestBody(req);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Invalid request body';
    writeJSON(res, 400, createAnthropicErrorBody(message, 'invalid_request_error'));
    return;
  }

  let parsedRequestBody: unknown;
  try {
    parsedRequestBody = JSON.parse(requestBodyRaw);
  } catch {
    writeJSON(res, 400, createAnthropicErrorBody('Request body must be valid JSON', 'invalid_request_error'));
    return;
  }

  const upstreamAPIType = resolveUpstreamAPIType(upstreamConfig.provider);
  const openAIRequest = anthropicToOpenAI(parsedRequestBody);
  if (!openAIRequest.model) {
    openAIRequest.model = upstreamConfig.model;
  }

  // Force-remap model name to the user-configured upstream model.
  // The Claude Agent SDK may emit internal model names (e.g. claude-haiku-4-5-20251001)
  // for probe/warmup requests, which non-Anthropic providers don't recognize.
  if (upstreamConfig.provider && upstreamConfig.provider !== 'anthropic' && upstreamConfig.provider !== 'openai') {
    const requestModel = typeof openAIRequest.model === 'string' ? openAIRequest.model : '';
    if (requestModel !== upstreamConfig.model) {
      console.info(
        `[CoworkProxy] Remapping model: ${requestModel} -> ${upstreamConfig.model} (provider: ${upstreamConfig.provider})`
      );
      openAIRequest.model = upstreamConfig.model;
    }
  }
  filterOpenAIToolsForProvider(openAIRequest, upstreamConfig.provider);
  remapMessageRolesForMiniMax(openAIRequest, upstreamConfig.provider);
  hydrateOpenAIRequestToolCalls(openAIRequest, upstreamConfig.provider, upstreamConfig.baseURL);

  if (upstreamAPIType === 'chat_completions') {
    normalizeMaxTokensFieldForOpenAIProvider(openAIRequest, upstreamConfig.provider);
  }

  // Some providers (e.g. MiniMax) reject requests with multiple system messages.
  // Merge all system messages into one before sending to these providers.
  // This fix applies to both chat_completions and responses API types.
  mergeSystemMessagesForProvider(openAIRequest);

  const upstreamRequest = upstreamAPIType === 'responses'
    ? convertChatCompletionsRequestToResponsesRequest(openAIRequest)
    : openAIRequest;
  const stream = Boolean(upstreamRequest.stream);

  console.log(`[CoworkProxy] Upstream: apiType=${upstreamAPIType}, model=${upstreamRequest.model}, stream=${stream}, provider=${upstreamConfig.provider}`);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (upstreamConfig.apiKey) {
    headers.Authorization = `Bearer ${upstreamConfig.apiKey}`;
  }

  const targetURLs = buildUpstreamTargetUrls(upstreamConfig.baseURL, upstreamAPIType);
  let currentTargetURL = targetURLs[0];

  const sendUpstreamRequest = async (
    payload: Record<string, unknown>,
    targetURL: string
  ): Promise<Response> => {
    currentTargetURL = targetURL;
    console.log(`[CoworkProxy] Sending upstream request to: ${targetURL}`);
    return session.defaultSession.fetch(targetURL, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });
  };

  let upstreamResponse: Response;
  const fetchStartTime = Date.now();
  try {
    console.log(`[CoworkProxy] Awaiting upstream fetch (stream=${stream}, model=${upstreamRequest.model})...`);
    upstreamResponse = await sendUpstreamRequest(upstreamRequest, targetURLs[0]);
    const fetchDuration = Date.now() - fetchStartTime;
    console.log(`[CoworkProxy] Upstream response: status=${upstreamResponse.status}, ok=${upstreamResponse.ok}, fetchTime=${fetchDuration}ms, stream=${stream}`);
  } catch (error) {
    const fetchDuration = Date.now() - fetchStartTime;
    const message = error instanceof Error ? error.message : 'Network error';
    console.error(`[CoworkProxy] Upstream fetch error after ${fetchDuration}ms (stream=${stream}): ${message}`);
    lastProxyError = message;
    writeJSON(res, 502, createAnthropicErrorBody(message));
    return;
  }

  if (!upstreamResponse.ok) {
    if (upstreamResponse.status === 404 && targetURLs.length > 1) {
      for (let i = 1; i < targetURLs.length; i += 1) {
        const retryURL = targetURLs[i];
        try {
          upstreamResponse = await sendUpstreamRequest(upstreamRequest, retryURL);
        } catch (error) {
          const message = error instanceof Error ? error.message : 'Network error';
          lastProxyError = message;
          writeJSON(res, 502, createAnthropicErrorBody(message));
          return;
        }
        if (upstreamResponse.ok || upstreamResponse.status !== 404) {
          break;
        }
      }
    }

    if (!upstreamResponse.ok) {
      const firstErrorText = await upstreamResponse.text();
      console.error(`[CoworkProxy] Upstream error: status=${upstreamResponse.status}, body=${firstErrorText.slice(0, 500)}`);
      let firstErrorMessage = extractErrorMessage(firstErrorText);
      if (firstErrorMessage === 'Upstream API request failed') {
        firstErrorMessage = `Upstream API request failed (${upstreamResponse.status}) ${currentTargetURL}`;
      }

      if (upstreamAPIType === 'chat_completions' && upstreamResponse.status === 400) {
        // Some Ollama models do not support tool calling.
        // When the upstream returns "does not support tools", strip tools and retry.
        if (isToolsUnsupportedError(firstErrorMessage)) {
          const stripped = stripToolsFromRequest(upstreamRequest);
          if (stripped) {
            try {
              upstreamResponse = await sendUpstreamRequest(upstreamRequest, currentTargetURL);
              if (!upstreamResponse.ok) {
                const retryErrorText = await upstreamResponse.text();
                firstErrorMessage = extractErrorMessage(retryErrorText);
              } else {
                console.info(
                  '[CoworkProxy] Retried request after stripping unsupported tools'
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Network error';
              lastProxyError = message;
              writeJSON(res, 502, createAnthropicErrorBody(message));
              return;
            }
          }
        }

        if (isMaxTokensUnsupportedError(firstErrorMessage)) {
          const convertResult = convertMaxTokensToMaxCompletionTokens(upstreamRequest);
          if (convertResult.changed) {
            try {
              upstreamResponse = await sendUpstreamRequest(upstreamRequest, currentTargetURL);
              if (!upstreamResponse.ok) {
                const retryErrorText = await upstreamResponse.text();
                firstErrorMessage = extractErrorMessage(retryErrorText);
              } else {
                console.info(
                  '[cowork-openai-compat-proxy] Retried request with max_completion_tokens '
                    + `converted from max_tokens=${convertResult.convertedTo}`
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Network error';
              lastProxyError = message;
              writeJSON(res, 502, createAnthropicErrorBody(message));
              return;
            }
          }
        }

        // Some OpenAI-compatible providers (e.g. DeepSeek) enforce strict max_tokens ranges.
        // Retry once with a clamped value when the upstream response includes the allowed range.
        if (!upstreamResponse.ok) {
          const clampResult = clampMaxTokensFromError(upstreamRequest, firstErrorMessage);
          if (clampResult.changed) {
            try {
              upstreamResponse = await sendUpstreamRequest(upstreamRequest, currentTargetURL);
              if (!upstreamResponse.ok) {
                const retryErrorText = await upstreamResponse.text();
                firstErrorMessage = extractErrorMessage(retryErrorText);
              } else {
                console.info(
                  `[cowork-openai-compat-proxy] Retried request with clamped max_tokens=${clampResult.clampedTo}`
                );
              }
            } catch (error) {
              const message = error instanceof Error ? error.message : 'Network error';
              lastProxyError = message;
              writeJSON(res, 502, createAnthropicErrorBody(message));
              return;
            }
          }
        }
      }

      if (!upstreamResponse.ok) {
        lastProxyError = firstErrorMessage;
        writeJSON(res, upstreamResponse.status, createAnthropicErrorBody(firstErrorMessage));
        return;
      }
    }
  }

  lastProxyError = null;

  if (stream) {
    console.log(`[CoworkProxy] Handling streaming response (type=${upstreamAPIType})`);
    if (upstreamAPIType === 'responses') {
      await handleResponsesStreamResponse(upstreamResponse, res);
    } else {
      await handleChatCompletionsStreamResponse(upstreamResponse, res);
    }
    console.log('[CoworkProxy] Streaming response completed');
    return;
  }

  console.log('[CoworkProxy] Handling non-streaming response');
  let upstreamJSON: unknown;
  try {
    upstreamJSON = await upstreamResponse.json();
  } catch {
    lastProxyError = 'Failed to parse upstream JSON response';
    writeJSON(res, 502, createAnthropicErrorBody('Failed to parse upstream JSON response'));
    return;
  }

  if (upstreamAPIType === 'responses') {
    const syntheticOpenAIResponse = convertResponsesToOpenAIResponse(upstreamJSON);
    cacheToolCallExtraContentFromOpenAIResponse(syntheticOpenAIResponse);
    cacheToolCallExtraContentFromResponsesResponse(upstreamJSON);
    const anthropicResponse = openAIToAnthropic(syntheticOpenAIResponse);
    writeJSON(res, 200, anthropicResponse);
    return;
  }

  cacheToolCallExtraContentFromOpenAIResponse(upstreamJSON);

  const anthropicResponse = openAIToAnthropic(upstreamJSON);
  writeJSON(res, 200, anthropicResponse);
}

export const __openAICompatProxyTestUtils = {
  createStreamState,
  createResponsesStreamContext,
  findSSEPacketBoundary,
  processResponsesStreamEvent,
  convertChatCompletionsRequestToResponsesRequest,
  filterOpenAIToolsForProvider,
};

export async function startCoworkOpenAICompatProxy(): Promise<void> {
  if (proxyServer) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    const server = http.createServer((req, res) => {
      void handleRequest(req, res).catch((error) => {
        const message = error instanceof Error ? error.message : 'Internal proxy error';
        lastProxyError = message;
        if (!res.headersSent) {
          writeJSON(res, 500, createAnthropicErrorBody(message));
        } else {
          res.end();
        }
      });
    });

    server.on('error', (error) => {
      lastProxyError = error.message;
      reject(error);
    });

    server.listen(0, PROXY_BIND_HOST, () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('Failed to bind OpenAI compatibility proxy port'));
        return;
      }

      proxyServer = server;
      proxyPort = addr.port;
      lastProxyError = null;
      resolve();
    });
  });
}

export async function stopCoworkOpenAICompatProxy(): Promise<void> {
  if (!proxyServer) {
    return;
  }

  const server = proxyServer;
  proxyServer = null;
  proxyPort = null;

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

export function configureCoworkOpenAICompatProxy(config: OpenAICompatUpstreamConfig): void {
  upstreamConfig = {
    ...config,
    baseURL: config.baseURL.trim(),
    apiKey: config.apiKey?.trim(),
  };
  lastProxyError = null;
}

export function getCoworkOpenAICompatProxyBaseURL(target: OpenAICompatProxyTarget = 'local'): string | null {
  if (!proxyServer || !proxyPort) {
    return null;
  }
  const host = target === 'sandbox' ? SANDBOX_HOST : LOCAL_HOST;
  return `http://${host}:${proxyPort}`;
}

/**
 * Get the proxy base URL for internal API use (scheduled tasks, etc.).
 * Unlike getCoworkOpenAICompatProxyBaseURL which is for the LLM proxy,
 * this always returns the local proxy URL regardless of API format.
 */
export function getInternalApiBaseURL(): string | null {
  return getCoworkOpenAICompatProxyBaseURL('local');
}

export function getCoworkOpenAICompatProxyStatus(): OpenAICompatProxyStatus {
  return {
    running: Boolean(proxyServer),
    baseURL: getCoworkOpenAICompatProxyBaseURL(),
    hasUpstream: Boolean(upstreamConfig),
    upstreamBaseURL: upstreamConfig?.baseURL || null,
    upstreamModel: upstreamConfig?.model || null,
    lastError: lastProxyError,
  };
}

