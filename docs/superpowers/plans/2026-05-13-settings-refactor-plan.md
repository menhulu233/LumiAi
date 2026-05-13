# Settings 模块拆分实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 将 3,317 行的 `Settings.tsx` 按 Tab 拆分为 8 个独立组件，提取 Provider 工具函数到共享模块。

**Architecture:** Phase 1 提取纯函数到 `providerMeta.ts`（纯数据）、`providerIcons.tsx`（JSX）、`providerUtils.ts`（工具函数）；Phase 2 按 Tab 拆分组件；Phase 3 创建容器并更新引用。

**Tech Stack:** React + TypeScript + Redux Toolkit

---

## 文件结构

```
src/renderer/
├── components/
│   └── settings/
│       ├── index.ts                        # 统一导出
│       ├── Settings.tsx                     # 容器（~450行）
│       ├── GeneralSettings.tsx              # (~230行)
│       ├── ModelSettings.tsx                # (~480行)
│       ├── CoworkSandboxSettings.tsx         # (~115行)
│       ├── CoworkMemorySettings.tsx          # (~150行)
│       ├── ShortcutsSettings.tsx             # (~60行)
│       └── AboutSettings.tsx                 # (~220行)
├── config/
│   ├── providerMeta.ts                      # 纯数据 (~100行)
│   └── providerIcons.tsx                    # JSX icon (~80行)
└── utils/
    └── providerUtils.ts                     # 纯函数 (~200行)
```

**修改的文件：**
- `src/renderer/components/Settings.tsx` → 删除，拆分内容
- `src/renderer/App.tsx` → 更新 import 路径
- `src/renderer/components/cowork/CoworkView.tsx` → 更新 type import 路径

---

## Phase 1: 提取基础设施

### Task 1: 创建 `providerMeta.ts`（纯数据，不含 React）

**Files:**
- Create: `src/renderer/config/providerMeta.ts`

- [ ] **Step 1: 创建 providerMeta.ts**

```ts
// src/renderer/config/providerMeta.ts

export const providerKeys = [
  'openai',
  'gemini',
  'anthropic',
  'deepseek',
  'moonshot',
  'zhipu',
  'minimax',
  'volcengine',
  'qwen',
  'youdaozhiyun',
  'stepfun',
  'xiaomi',
  'openrouter',
  'ollama',
  'custom',
] as const;

export type ProviderType = (typeof providerKeys)[number];

export const providerLabels: Record<ProviderType, string> = {
  openai: 'OpenAI',
  deepseek: 'DeepSeek',
  gemini: 'Gemini',
  anthropic: 'Anthropic',
  moonshot: 'Moonshot',
  zhipu: 'Zhipu',
  minimax: 'MiniMax',
  volcengine: 'Volcengine',
  qwen: 'Qwen',
  youdaozhiyun: 'Youdao',
  stepfun: 'StepFun',
  xiaomi: 'Xiaomi',
  openrouter: 'OpenRouter',
  ollama: 'Ollama',
  custom: 'Custom',
};

export const providerSwitchableDefaultBaseUrls: Partial<Record<ProviderType, { anthropic: string; openai: string }>> = {
  deepseek: {
    anthropic: 'https://api.deepseek.com/anthropic',
    openai: 'https://api.deepseek.com',
  },
  moonshot: {
    anthropic: 'https://api.moonshot.cn/anthropic',
    openai: 'https://api.moonshot.cn/v1',
  },
  zhipu: {
    anthropic: 'https://open.bigmodel.cn/api/anthropic',
    openai: 'https://open.bigmodel.cn/api/paas/v4',
  },
  minimax: {
    anthropic: 'https://api.minimaxi.com/anthropic',
    openai: 'https://api.minimaxi.com/v1',
  },
  qwen: {
    anthropic: 'https://dashscope.aliyuncs.com/apps/anthropic',
    openai: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  xiaomi: {
    anthropic: 'https://api.xiaomimimo.com/anthropic',
    openai: 'https://api.xiaomimimo.com/v1/chat/completions',
  },
  volcengine: {
    anthropic: 'https://ark.cn-beijing.volces.com/api/compatible',
    openai: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  openrouter: {
    anthropic: 'https://openrouter.ai/api',
    openai: 'https://openrouter.ai/api/v1',
  },
  ollama: {
    anthropic: 'http://localhost:11434',
    openai: 'http://localhost:11434/v1',
  },
  custom: {
    anthropic: '',
    openai: '',
  },
};

export const providerRequiresApiKey = (provider: ProviderType): boolean => provider !== 'ollama';
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: 无 providerMeta.ts 相关错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/config/providerMeta.ts
git commit -m "refactor(settings): extract providerMeta as pure data config

- providerKeys as readonly const array
- providerLabels (不含 icon)
- providerSwitchableDefaultBaseUrls
- providerRequiresApiKey helper"
```

---

### Task 2: 创建 `providerIcons.tsx`（JSX，不放 config/）

**Files:**
- Create: `src/renderer/config/providerIcons.tsx`

- [ ] **Step 1: 创建 providerIcons.tsx**

```tsx
// src/renderer/config/providerIcons.tsx
import React from 'react';
import {
  OpenAIIcon,
  DeepSeekIcon,
  GeminiIcon,
  AnthropicIcon,
  MoonshotIcon,
  ZhipuIcon,
  MiniMaxIcon,
  YouDaoZhiYunIcon,
  QwenIcon,
  XiaomiIcon,
  StepfunIcon,
  VolcengineIcon,
  OpenRouterIcon,
  OllamaIcon,
  CustomProviderIcon,
} from '../components/icons/providers';
import type { ProviderType } from './providerMeta';

export const ProviderIcons: Record<ProviderType, React.ReactNode> = {
  openai: <OpenAIIcon />,
  deepseek: <DeepSeekIcon />,
  gemini: <GeminiIcon />,
  anthropic: <AnthropicIcon />,
  moonshot: <MoonshotIcon />,
  zhipu: <ZhipuIcon />,
  minimax: <MiniMaxIcon />,
  volcengine: <VolcengineIcon />,
  qwen: <QwenIcon />,
  youdaozhiyun: <YouDaoZhiYunIcon />,
  stepfun: <StepfunIcon />,
  xiaomi: <XiaomiIcon />,
  openrouter: <OpenRouterIcon />,
  ollama: <OllamaIcon />,
  custom: <CustomProviderIcon />,
};
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: 无 providerIcons.tsx 相关错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/config/providerIcons.tsx
git commit -m "refactor(settings): extract providerIcons as JSX component map"
```

---

### Task 3: 创建 `providerUtils.ts`（纯函数，含 getCodingPlanUrl）

**Files:**
- Create: `src/renderer/utils/providerUtils.ts`

- [ ] **Step 1: 读取原 Settings.tsx 中所有 provider 相关纯函数**

从 Settings.tsx 第 203-341 行提取以下函数：
- `copyTextFallback`、`copyTextToClipboard`（非纯函数，但可移入 utils）
- `normalizeBaseUrl`、`normalizeApiFormat`
- `getFixedApiFormatForProvider`、`getEffectiveApiFormat`
- `shouldShowApiFormatSelector`
- `getProviderDefaultBaseUrl`、`resolveBaseUrl`、`shouldAutoSwitchProviderBaseUrl`
- `buildOpenAICompatibleChatCompletionsUrl`、`buildOpenAIResponsesUrl`
- `shouldUseOpenAIResponsesForProvider`、`shouldUseMaxCompletionTokensForOpenAI`
- `getCodingPlanUrl`（关键：消除 Zhipu/Qwen/Volcengine/Moonshot 重复逻辑）
- `getDefaultProviders`、`getDefaultActiveProvider`
- `CONNECTIVITY_TEST_TOKEN_BUDGET`（常量）

- [ ] **Step 2: 写入 providerUtils.ts**

```ts
// src/renderer/utils/providerUtils.ts
import type { ProviderType } from '../config/providerMeta';
import type { ProvidersConfig, ProviderConfig } from '../config';
import { defaultConfig } from '../config';

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
  const { providerSwitchableDefaultBaseUrls } = require('../config/providerMeta');
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
  const { providerSwitchableDefaultBaseUrls } = require('../config/providerMeta');
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

// ========== Coding Plan URL ==========
// 关键函数：消除 Zhipu/Qwen/Volcengine/Moonshot 的 Coding Plan URL 重复逻辑

export interface CodingPlanUrlResult {
  url: string;
  isLocked: boolean;
}

/**
 * 获取 Coding Plan URL。
 * 如果 codingPlanEnabled 为 true，返回 provider 的 Coding Plan 专用 URL；否则返回 null。
 */
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

/**
 * 判断 baseUrl 是否因 Coding Plan 而被锁定。
 */
export const isBaseUrlLockedByCodingPlan = (provider: ProviderType, codingPlanEnabled: boolean): boolean => {
  return (
    (provider === 'zhipu' ||
      provider === 'qwen' ||
      provider === 'volcengine' ||
      provider === 'moonshot') &&
    codingPlanEnabled
  );
};

// ========== Defaults ==========

export const getDefaultProviders = (): ProvidersConfig => {
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const entries = Object.entries(providers) as Array<[string, ProviderConfig]>;
  return Object.fromEntries(
    entries.map(([providerKey, providerConfig]) => [
      providerKey,
      {
        ...providerConfig,
        models: providerConfig.models?.map(model => ({
          ...model,
          supportsImage: model.supportsImage ?? false,
        })),
      },
    ])
  ) as ProvidersConfig;
};

export const getDefaultActiveProvider = (): ProviderType => {
  const { providerKeys } = require('../config/providerMeta');
  const providers = (defaultConfig.providers ?? {}) as ProvidersConfig;
  const firstEnabledProvider = providerKeys.find(
    (providerKey: ProviderType) => providers[providerKey]?.enabled
  );
  return firstEnabledProvider ?? providerKeys[0];
};

// ========== Clipboard ==========

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
```

- [ ] **Step 3: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: 无 providerUtils.ts 相关错误

- [ ] **Step 4: Commit**

```bash
git add src/renderer/utils/providerUtils.ts
git commit -m "refactor(settings): extract providerUtils with getCodingPlanUrl

- All provider-related pure functions
- getCodingPlanUrl eliminates duplicate coding plan URL logic
- Clipboard helpers moved from Settings.tsx"
```

---

## Phase 2: 按 Tab 拆分组件

### Task 4: 创建 `settings/AboutSettings.tsx`

**Files:**
- Create: `src/renderer/components/settings/AboutSettings.tsx`
- Read: `Settings.tsx` 第 2817-2940 行（约 123 行）

- [ ] **Step 1: 从 Settings.tsx 提取 About Tab 内容**

从 `case 'about':` 提取 JSX 内容到 `AboutSettings.tsx`。

Props 接口：
```tsx
interface AboutSettingsProps {
  appVersion: string;
  emailCopied: boolean;
  updateCheckStatus: 'idle' | 'checking' | 'upToDate' | 'error';
  onCopyContactEmail: () => Promise<void>;
  onCheckUpdate: () => void;
  onOpenUserManual: () => void;
  onOpenServiceTerms: () => void;
  onExportLogs: () => Promise<void>;
}
```

- [ ] **Step 2: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -30`
Expected: AboutSettings.tsx 无错误

- [ ] **Step 3: Commit**

```bash
git add src/renderer/components/settings/AboutSettings.tsx
git commit -m "refactor(settings): extract AboutSettings tab component"
```

---

### Task 5: 创建 `settings/ShortcutsSettings.tsx`

**Files:**
- Create: `src/renderer/components/settings/ShortcutsSettings.tsx`
- Read: `Settings.tsx` 第 2771-2813 行（约 42 行）

- [ ] **Step 1: 从 Settings.tsx 提取 Shortcuts Tab 内容**

```tsx
interface ShortcutsSettingsProps {
  shortcuts: { newChat: string; search: string; settings: string };
  onShortcutChange: (key: string, value: string) => void;
}
```

- [ ] **Step 2: 验证编译**

- [ ] **Step 3: Commit**

---

### Task 6: 创建 `settings/GeneralSettings.tsx`

**Files:**
- Create: `src/renderer/components/settings/GeneralSettings.tsx`
- Read: `Settings.tsx` 第 1825-2055 行（约 230 行）

- [ ] **Step 1: 从 Settings.tsx 提取 General Tab 内容**

```tsx
interface GeneralSettingsProps {
  language: 'zh' | 'en';
  autoLaunch: boolean;
  useSystemProxy: boolean;
  isUpdatingAutoLaunch: boolean;
  onLanguageChange: (lang: 'zh' | 'en') => void;
  onAutoLaunchChange: (enabled: boolean) => void;
  onUseSystemProxyChange: (enabled: boolean) => void;
}
```

- [ ] **Step 2: 验证编译**

- [ ] **Step 3: Commit**

---

### Task 7: 创建 `settings/CoworkSandboxSettings.tsx`

**Files:**
- Create: `src/renderer/components/settings/CoworkSandboxSettings.tsx`
- Read: `Settings.tsx` 第 2058-2159 行（约 101 行）

- [ ] **Step 1: 从 Settings.tsx 提取 CoworkSandbox Tab 内容**

```tsx
import type {
  CoworkExecutionMode,
  CoworkSandboxProgress,
  CoworkSandboxStatus,
} from '../../types/cowork';

interface CoworkSandboxSettingsProps {
  coworkExecutionMode: CoworkExecutionMode;
  coworkSandboxStatus: CoworkSandboxStatus | null;
  coworkSandboxProgress: CoworkSandboxProgress | null;
  coworkSandboxDisabled: boolean;
  coworkSandboxInstalling: boolean;
  coworkSandboxLoading: boolean;
  coworkSandboxStatusHint: string | null;
  coworkSandboxPercent: number | null;
  coworkSandboxStageLabel: string;
  onExecutionModeChange: (mode: CoworkExecutionMode) => void;
  onInstallSandbox: () => void;
}
```

- [ ] **Step 2: 验证编译**

- [ ] **Step 3: Commit**

---

### Task 8: 创建 `settings/CoworkMemorySettings.tsx`

**Files:**
- Create: `src/renderer/components/settings/CoworkMemorySettings.tsx`
- Read: `Settings.tsx` 第 2160-2293 行（约 133 行）

- [ ] **Step 1: 从 Settings.tsx 提取 CoworkMemory Tab 内容**

```tsx
import type {
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
} from '../../types/cowork';

interface CoworkMemorySettingsProps {
  coworkMemoryEnabled: boolean;
  coworkMemoryLlmJudgeEnabled: boolean;
  coworkMemoryEntries: CoworkUserMemoryEntry[];
  coworkMemoryStats: CoworkMemoryStats | null;
  coworkMemoryQuery: string;
  coworkMemoryListLoading: boolean;
  onEnabledChange: (enabled: boolean) => void;
  onLlmJudgeEnabledChange: (enabled: boolean) => void;
  onQueryChange: (query: string) => void;
  onOpenModal: () => void;
  onEditEntry: (entry: CoworkUserMemoryEntry) => void;
  onDeleteEntry: (entry: CoworkUserMemoryEntry) => Promise<void>;
}
```

- [ ] **Step 2: 验证编译**

- [ ] **Step 3: Commit**

---

### Task 9: 创建 `settings/ModelSettings.tsx`

**Files:**
- Create: `src/renderer/components/settings/ModelSettings.tsx`
- Read: `Settings.tsx` 第 2294-2770 行（约 476 行）
- Dependencies: `providerUtils.ts`, `providerMeta.ts`, `providerIcons.tsx`

- [ ] **Step 1: 从 Settings.tsx 提取 Model Tab 内容**

这个 Tab 是最复杂的，包含：
- Provider 列表（左侧）
- Provider 配置面板（右侧）：apiKey、baseUrl、apiFormat、Coding Plan 开关、模型列表
- 导入/导出功能
- 连接测试

关键：使用 `getCodingPlanUrl()` 替代原有的两处重复逻辑。

```tsx
import type { ProviderType, ProvidersConfig } from '../../config/providerMeta';
import type { AppConfig } from '../../config';
import {
  ProviderIcons,
  providerRequiresApiKey,
} from '../../config/providerMeta';
import {
  getEffectiveApiFormat,
  shouldShowApiFormatSelector,
  resolveBaseUrl,
  getCodingPlanUrl,
  isBaseUrlLockedByCodingPlan,
  buildOpenAICompatibleChatCompletionsUrl,
  copyTextToClipboard,
  CONNECTIVITY_TEST_TOKEN_BUDGET,
} from '../../utils/providerUtils';

interface ModelSettingsProps {
  providers: ProvidersConfig;
  activeProvider: ProviderType;
  showApiKey: boolean;
  isTesting: boolean;
  isImportingProviders: boolean;
  isExportingProviders: boolean;
  onProviderChange: (provider: ProviderType) => void;
  onProviderConfigChange: (provider: ProviderType, key: string, value: unknown) => void;
  onToggleProviderEnabled: (provider: ProviderType) => void;
  onTestConnection: () => Promise<void>;
  onImportProviders: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onExportProviders: () => Promise<void>;
  onShowApiKeyToggle: () => void;
  // Model CRUD
  onAddModel: () => void;
  onEditModel: (id: string, name: string, supportsImage: boolean) => void;
  onDeleteModel: (id: string) => void;
}
```

- [ ] **Step 2: 验证编译**

- [ ] **Step 3: Commit**

---

## Phase 3: 创建 Settings 容器

### Task 10: 创建 `settings/Settings.tsx` 容器

**Files:**
- Create: `src/renderer/components/settings/Settings.tsx`
- Modify: `src/renderer/App.tsx`（更新 import）
- Modify: `src/renderer/components/cowork/CoworkView.tsx`（更新 type import）

- [ ] **Step 1: 创建 Context 定义**

在 `Settings.tsx` 顶部（或单独文件 `settings/SettingsContext.tsx`）定义两个 Context：

```tsx
// SettingsStateContext
interface SettingsStateValue {
  activeTab: TabType;
  providers: ProvidersConfig;
  activeProvider: ProviderType;
  showApiKey: boolean;
  language: LanguageType;
  autoLaunch: boolean;
  useSystemProxy: boolean;
  isUpdatingAutoLaunch: boolean;
  coworkExecutionMode: CoworkExecutionMode;
  coworkSandboxStatus: CoworkSandboxStatus | null;
  coworkSandboxProgress: CoworkSandboxProgress | null;
  coworkSandboxDisabled: boolean;
  coworkSandboxInstalling: boolean;
  coworkSandboxLoading: boolean;
  coworkSandboxStatusHint: string | null;
  coworkSandboxPercent: number | null;
  coworkSandboxStageLabel: string;
  coworkMemoryEnabled: boolean;
  coworkMemoryLlmJudgeEnabled: boolean;
  coworkMemoryEntries: CoworkUserMemoryEntry[];
  coworkMemoryStats: CoworkMemoryStats | null;
  coworkMemoryQuery: string;
  coworkMemoryListLoading: boolean;
  shortcuts: { newChat: string; search: string; settings: string };
  appVersion: string;
  emailCopied: boolean;
  updateCheckStatus: 'idle' | 'checking' | 'upToDate' | 'error';
  testResult: ProviderConnectionTestResult | null;
  isTestResultModalOpen: boolean;
  isAddingModel: boolean;
  isEditingModel: boolean;
  editingModelId: string | null;
  error: string | null;
  noticeMessage: string | null;
}

// SettingsActionsContext
interface SettingsActionsValue {
  setActiveTab: (tab: TabType) => void;
  handleProviderChange: (provider: ProviderType) => void;
  handleProviderConfigChange: (provider: ProviderType, key: string, value: unknown) => void;
  toggleProviderEnabled: (provider: ProviderType) => void;
  handleTestConnection: () => Promise<void>;
  handleImportProviders: (event: React.ChangeEvent<HTMLInputElement>) => void;
  handleExportProviders: () => Promise<void>;
  setShowApiKey: (show: boolean) => void;
  handleAddModel: () => void;
  handleEditModel: (id: string, name: string, supportsImage: boolean) => void;
  handleSaveNewModel: () => void;
  handleCancelModelEdit: () => void;
  handleDeleteModel: (id: string) => void;
  setCoworkExecutionMode: (mode: CoworkExecutionMode) => void;
  handleInstallCoworkSandbox: () => void;
  setCoworkMemoryEnabled: (enabled: boolean) => void;
  setCoworkMemoryLlmJudgeEnabled: (enabled: boolean) => void;
  setCoworkMemoryQuery: (query: string) => void;
  handleOpenCoworkMemoryModal: () => void;
  handleEditCoworkMemoryEntry: (entry: CoworkUserMemoryEntry) => void;
  handleDeleteCoworkMemoryEntry: (entry: CoworkUserMemoryEntry) => Promise<void>;
  handleSaveCoworkMemoryEntry: () => Promise<void>;
  handleCancelCoworkMemoryEdit: () => void;
  handleShortcutChange: (key: string, value: string) => void;
  setLanguage: (lang: LanguageType) => void;
  setAutoLaunchState: (enabled: boolean) => void;
  setUseSystemProxy: (enabled: boolean) => void;
  handleCopyContactEmail: () => Promise<void>;
  handleCheckUpdate: () => void;
  handleOpenUserManual: () => void;
  handleOpenServiceTerms: () => void;
  handleExportLogs: () => Promise<void>;
  setTestResult: (result: ProviderConnectionTestResult | null) => void;
  setIsTestResultModalOpen: (open: boolean) => void;
  handleClearError: () => void;
  handleSubmit: () => Promise<void>;
}
```

- [ ] **Step 2: 创建 Settings.tsx 容器**

容器包含：
- 所有 state 声明
- 所有 handler 定义
- Context Provider 包裹 Tab 内容
- Tab shell（sidebar + content + footer）
- 3 个 Modal（Test Result / Model Add-Edit / Memory CRUD）—— 保留在容器中

- [ ] **Step 3: 创建 settings/index.ts**

```tsx
// src/renderer/components/settings/index.ts
export { default as Settings, type SettingsOpenOptions } from './Settings';
export { default as GeneralSettings } from './GeneralSettings';
export { default as ModelSettings } from './ModelSettings';
export { default as CoworkSandboxSettings } from './CoworkSandboxSettings';
export { default as CoworkMemorySettings } from './CoworkMemorySettings';
export { default as ShortcutsSettings } from './ShortcutsSettings';
export { default as AboutSettings } from './AboutSettings';
```

- [ ] **Step 4: 更新 App.tsx import**

```tsx
// App.tsx 第 4 行
// 改前
import Settings, { type SettingsOpenOptions } from './components/Settings';
// 改后
import Settings, { type SettingsOpenOptions } from './components/settings/Settings';
```

- [ ] **Step 5: 更新 CoworkView.tsx type import**

```tsx
// CoworkView.tsx 第 18 行
// 改前
import type { SettingsOpenOptions } from '../Settings';
// 改后
import type { SettingsOpenOptions } from '../settings/Settings';
```

- [ ] **Step 6: 验证编译**

Run: `npx tsc --noEmit 2>&1 | head -50`
Expected: 无错误

- [ ] **Step 7: 验证 lint**

Run: `npm run lint 2>&1 | head -30`
Expected: 无 error

- [ ] **Step 8: Commit**

```bash
git add -A
git commit -m "refactor(settings): complete Settings.tsx split into per-tab components

- Settings.tsx now a thin container (~450 lines)
- New components: GeneralSettings, ModelSettings, CoworkSandboxSettings,
  CoworkMemorySettings, ShortcutsSettings, AboutSettings
- Modals (TestResult, ModelForm, MemoryForm) remain in Settings.tsx
- Provider logic extracted to providerMeta.ts, providerIcons.tsx, providerUtils.ts
- Updated App.tsx and CoworkView.tsx import paths"
```

---

## Phase 4: 清理

### Task 11: 删除原 Settings.tsx 并验证

**Files:**
- Delete: `src/renderer/components/Settings.tsx`

- [ ] **Step 1: 确认所有引用已更新**

检查是否还有其他文件引用 `./components/Settings`：
```bash
grep -r "from.*components/Settings" src/renderer/ --include="*.ts" --include="*.tsx"
```
Expected: 无结果

- [ ] **Step 2: 验证编译**

- [ ] **Step 3: Commit**

```bash
git rm src/renderer/components/Settings.tsx
git commit -m "chore(settings): remove original Settings.tsx after split"
```

---

## 验收检查

- [ ] Settings.tsx 从 3,317 行减少到 ~450 行
- [ ] 每个新组件不超过 ~500 行
- [ ] `providerMeta.ts` 不含 JSX
- [ ] `providerUtils.ts` 不含 React 依赖
- [ ] Coding Plan URL 逻辑只在 `getCodingPlanUrl()` 一处
- [ ] 编译通过
- [ ] Lint 通过
- [ ] 手动测试：打开 Settings，切换 8 个 Tab，功能正常
