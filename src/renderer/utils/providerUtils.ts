import type { ProviderType } from '../config/providerMeta';
import { providerSwitchableDefaultBaseUrls, providerKeys } from '../config/providerMeta';
import type { AppConfig } from '../config';
import { defaultConfig } from '../config';

type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type Model = NonNullable<ProviderConfig['models']>[number];

export const CONNECTIVITY_TEST_TOKEN_BUDGET = 64;

export const normalizeBaseUrl = (baseUrl: string): string =>
  baseUrl.trim().replace(/\/+$/, '').toLowerCase();

export const normalizeApiFormat = (value: unknown): 'anthropic' | 'openai' =>
  value === 'openai' ? 'openai' : 'anthropic';

export const getFixedApiFormatForProvider = (provider: string): 'anthropic' | 'openai' | null => {
  if (provider === 'openai' || provider === 'gemini' || provider === 'stepfun') return 'openai';
  if (provider === 'youdaozhiyun') return 'openai';
  if (provider === 'anthropic') return 'anthropic';
  return null;
};

export const getEffectiveApiFormat = (
  provider: string,
  value: unknown
): 'anthropic' | 'openai' =>
  getFixedApiFormatForProvider(provider) ?? normalizeApiFormat(value);

export const shouldShowApiFormatSelector = (provider: string): boolean =>
  getFixedApiFormatForProvider(provider) === null;

export const getProviderDefaultBaseUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai'
): string | null => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  return defaults ? defaults[apiFormat] : null;
};

export const resolveBaseUrl = (
  provider: ProviderType,
  baseUrl: string,
  apiFormat: 'anthropic' | 'openai'
): string => {
  if (baseUrl.trim()) return baseUrl;
  return (
    getProviderDefaultBaseUrl(provider, apiFormat) ||
    defaultConfig.providers?.[provider]?.baseUrl ||
    ''
  );
};

export const shouldAutoSwitchProviderBaseUrl = (
  provider: ProviderType,
  currentBaseUrl: string
): boolean => {
  const defaults = providerSwitchableDefaultBaseUrls[provider];
  if (!defaults) return false;
  const normalizedCurrent = normalizeBaseUrl(currentBaseUrl);
  return (
    normalizedCurrent === normalizeBaseUrl(defaults.anthropic) ||
    normalizedCurrent === normalizeBaseUrl(defaults.openai)
  );
};

export const buildOpenAICompatibleChatCompletionsUrl = (
  baseUrl: string,
  provider: string
): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '/v1/chat/completions';
  if (normalized.endsWith('/chat/completions')) return normalized;

  const isGeminiLike =
    provider === 'gemini' || normalized.includes('generativelanguage.googleapis.com');
  if (isGeminiLike) {
    if (normalized.endsWith('/v1beta/openai') || normalized.endsWith('/v1/openai')) {
      return `${normalized}/chat/completions`;
    }
    if (normalized.endsWith('/v1beta') || normalized.endsWith('/v1')) {
      const betaBase = normalized.endsWith('/v1')
        ? normalized.slice(0, -3) + 'v1beta'
        : normalized;
      return `${betaBase}/openai/chat/completions`;
    }
    return `${normalized}/v1beta/openai/chat/completions`;
  }

  if (/\/v\d+$/.test(normalized)) {
    return `${normalized}/chat/completions`;
  }
  return `${normalized}/v1/chat/completions`;
};

export const buildOpenAIResponsesUrl = (baseUrl: string): string => {
  const normalized = baseUrl.trim().replace(/\/+$/, '');
  if (!normalized) return '/v1/responses';
  if (normalized.endsWith('/responses')) return normalized;
  if (normalized.endsWith('/v1')) return `${normalized}/responses`;
  return `${normalized}/v1/responses`;
};

export const shouldUseOpenAIResponsesForProvider = (provider: string): boolean =>
  provider === 'openai';

export const shouldUseMaxCompletionTokensForOpenAI = (
  provider: string,
  modelId?: string
): boolean => {
  if (provider !== 'openai') return false;
  const normalizedModel = (modelId ?? '').toLowerCase();
  const resolvedModel = normalizedModel.includes('/')
    ? normalizedModel.slice(normalizedModel.lastIndexOf('/') + 1)
    : normalizedModel;
  return (
    resolvedModel.startsWith('gpt-5') ||
    resolvedModel.startsWith('o1') ||
    resolvedModel.startsWith('o3') ||
    resolvedModel.startsWith('o4')
  );
};

// KEY: getCodingPlanUrl eliminates duplicate Zhipu/Qwen/Volcengine/Moonshot logic
export const getCodingPlanUrl = (
  provider: ProviderType,
  apiFormat: 'anthropic' | 'openai',
  codingPlanEnabled: boolean
): string | null => {
  if (!codingPlanEnabled) return null;

  switch (provider) {
    case 'zhipu':
      return apiFormat === 'anthropic'
        ? 'https://open.bigmodel.cn/api/anthropic'
        : 'https://open.bigmodel.cn/api/coding/paas/v4';
    case 'qwen':
      return apiFormat === 'anthropic'
        ? 'https://coding.dashscope.aliyuncs.com/apps/anthropic'
        : 'https://coding.dashscope.aliyuncs.com/v1';
    case 'volcengine':
      return apiFormat === 'anthropic'
        ? 'https://ark.cn-beijing.volces.com/api/coding'
        : 'https://ark.cn-beijing.volces.com/api/coding/v3';
    case 'moonshot':
      return apiFormat === 'anthropic'
        ? 'https://api.kimi.com/coding'
        : 'https://api.kimi.com/coding/v1';
    default:
      return null;
  }
};

export const isBaseUrlLockedByCodingPlan = (
  provider: ProviderType,
  codingPlanEnabled: boolean
): boolean => {
  return (
    (provider === 'zhipu' ||
      provider === 'qwen' ||
      provider === 'volcengine' ||
      provider === 'moonshot') &&
    codingPlanEnabled
  );
};

export const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map((model: Model) => ({
          ...model,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ])
  ) as ProvidersConfig;
};

export const getDefaultActiveProvider = (): ProviderType => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = providerKeys.find(
    (providerKey: ProviderType) => providers[providerKey]?.enabled
  );
  return firstEnabledProvider ?? providerKeys[0];
};

// Clipboard helpers
export const copyTextFallback = (text: string): boolean => {
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.setAttribute('readonly', '');
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  textarea.style.pointerEvents = 'none';
  document.body.appendChild(textarea);
  textarea.focus();
  textarea.select();
  textarea.setSelectionRange(0, text.length);
  const copied = document.execCommand('copy');
  document.body.removeChild(textarea);
  return copied;
};

export const copyTextToClipboard = async (text: string): Promise<boolean> => {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch (clipboardError) {
      console.warn('Navigator clipboard write failed, trying fallback:', clipboardError);
    }
  }
  try {
    return copyTextFallback(text);
  } catch (fallbackError) {
    console.error('Fallback clipboard copy failed:', fallbackError);
    return false;
  }
};
