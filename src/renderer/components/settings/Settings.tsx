import React, { useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { configService } from '../../services/config';
import { apiService } from '../../services/api';
import { checkForAppUpdate } from '../../services/appUpdate';
import type { AppUpdateInfo } from '../../services/appUpdate';
import { themeService } from '../../services/theme';
import { i18nService, LanguageType } from '../../services/i18n';
import { decryptSecret, encryptWithPassword, decryptWithPassword, EncryptedPayload, PasswordEncryptedPayload } from '../../services/encryption';
import { coworkService } from '../../services/cowork';
import { APP_ID, EXPORT_FORMAT_TYPE, EXPORT_PASSWORD } from '../../constants/app';
import ErrorMessage from '../ErrorMessage';
import { XMarkIcon, Cog6ToothIcon, CheckCircleIcon, XCircleIcon, CubeIcon, ChatBubbleLeftIcon, ShieldCheckIcon, EnvelopeIcon, InformationCircleIcon } from '@heroicons/react/24/outline';
import BrainIcon from '../icons/BrainIcon';
import { useDispatch, useSelector } from 'react-redux';
import { setAvailableModels } from '../../store/slices/modelSlice';
import { RootState } from '../../store';
import type {
  CoworkExecutionMode,
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
  CoworkSandboxProgress,
  CoworkSandboxStatus,
} from '../../types/cowork';
import IMSettings from '../im/IMSettings';
import EmailSkillConfig from '../skills/EmailSkillConfig';
import { type AppConfig, getVisibleProviders } from '../../config';
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
} from '../icons/providers';
import { providerKeys, type ProviderType } from '../../config/providerMeta';
import {
  getEffectiveApiFormat,
  getCodingPlanUrl,
  getProviderDefaultBaseUrl,
  resolveBaseUrl,
  shouldAutoSwitchProviderBaseUrl,
  buildOpenAICompatibleChatCompletionsUrl,
  buildOpenAIResponsesUrl,
  shouldUseOpenAIResponsesForProvider,
  shouldUseMaxCompletionTokensForOpenAI,
  getDefaultProviders,
  getDefaultActiveProvider,
  copyTextToClipboard,
  CONNECTIVITY_TEST_TOKEN_BUDGET,
} from '../../utils/providerUtils';

// Tab components
import GeneralSettings from './GeneralSettings';
import ModelSettings from './ModelSettings';
import { CoworkSandboxSettings } from './CoworkSandboxSettings';
import { CoworkMemorySettings } from './CoworkMemorySettings';
import ShortcutsSettings from './ShortcutsSettings';
import AboutSettings from './AboutSettings';

type TabType = 'general' | 'model' | 'coworkSandbox' | 'coworkMemory' | 'shortcuts' | 'im' | 'email' | 'about';

export type SettingsOpenOptions = {
  initialTab?: TabType;
  notice?: string;
};

interface SettingsProps extends SettingsOpenOptions {
  onClose: () => void;
  onUpdateFound?: (info: AppUpdateInfo) => void;
}

type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];
type Model = NonNullable<ProviderConfig['models']>[number];
type ProviderConnectionTestResult = {
  success: boolean;
  message: string;
  provider: ProviderType;
};

interface ProviderExportEntry {
  enabled: boolean;
  apiKey: PasswordEncryptedPayload;
  baseUrl: string;
  apiFormat?: 'anthropic' | 'openai';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersExportPayload {
  type: typeof EXPORT_FORMAT_TYPE;
  version: 2;
  exportedAt: string;
  encryption: {
    algorithm: 'AES-GCM';
    keySource: 'password';
    keyDerivation: 'PBKDF2';
  };
  providers: Record<string, ProviderExportEntry>;
}

interface ProvidersImportEntry {
  enabled?: boolean;
  apiKey?: EncryptedPayload | PasswordEncryptedPayload | string;
  apiKeyEncrypted?: string;
  apiKeyIv?: string;
  baseUrl?: string;
  apiFormat?: 'anthropic' | 'openai' | 'native';
  codingPlanEnabled?: boolean;
  models?: Model[];
}

interface ProvidersImportPayload {
  type?: string;
  version?: number;
  encryption?: {
    algorithm?: string;
    keySource?: string;
    keyDerivation?: string;
  };
  providers?: Record<string, ProvidersImportEntry>;
}

const providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }> = {
  openai: { label: 'OpenAI', icon: <OpenAIIcon /> },
  deepseek: { label: 'DeepSeek', icon: <DeepSeekIcon /> },
  gemini: { label: 'Gemini', icon: <GeminiIcon /> },
  anthropic: { label: 'Anthropic', icon: <AnthropicIcon /> },
  moonshot: { label: 'Moonshot', icon: <MoonshotIcon /> },
  zhipu: { label: 'Zhipu', icon: <ZhipuIcon /> },
  minimax: { label: 'MiniMax', icon: <MiniMaxIcon /> },
  youdaozhiyun: { label: 'Youdao', icon: <YouDaoZhiYunIcon /> },
  qwen: { label: 'Qwen', icon: <QwenIcon /> },
  xiaomi: { label: 'Xiaomi', icon: <XiaomiIcon /> },
  stepfun: { label: 'StepFun', icon: <StepfunIcon /> },
  volcengine: { label: 'Volcengine', icon: <VolcengineIcon /> },
  openrouter: { label: 'OpenRouter', icon: <OpenRouterIcon /> },
  ollama: { label: 'Ollama', icon: <OllamaIcon /> },
  custom: { label: 'Custom', icon: <CustomProviderIcon /> },
};

const ABOUT_CONTACT_EMAIL = 'lumiai.project@rd.netease.com';
const ABOUT_USER_MANUAL_URL = 'https://lumiai.youdao.com/#/docs/lumiai_user_manual';
const ABOUT_SERVICE_TERMS_URL = 'https://c.youdao.com/dict/hardware/lumiai/lumiai_service.html';

// ============================================================================
// Context Definitions
// ============================================================================

export interface SettingsStateValue {
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

export interface SettingsActionsValue {
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
  handleSubmit: (e: React.FormEvent<HTMLFormElement>) => Promise<void>;
}

export const SettingsStateContext = React.createContext<SettingsStateValue | null>(null);
export const SettingsActionsContext = React.createContext<SettingsActionsValue | null>(null);

export const useSettingsState = () => {
  const ctx = React.useContext(SettingsStateContext);
  if (!ctx) throw new Error('useSettingsState must be used within SettingsStateContext.Provider');
  return ctx;
};

export const useSettingsActions = () => {
  const ctx = React.useContext(SettingsActionsContext);
  if (!ctx) throw new Error('useSettingsActions must be used within SettingsActionsContext.Provider');
  return ctx;
};

// ============================================================================
// Settings Component
// ============================================================================

const Settings: React.FC<SettingsProps> = ({ onClose, initialTab, notice, onUpdateFound }) => {
  const dispatch = useDispatch();

  // State declarations
  const [activeTab, setActiveTab] = useState<TabType>(initialTab ?? 'general');
  const [theme, setTheme] = useState<'light' | 'dark' | 'system'>('system');
  const [language, setLanguage] = useState<LanguageType>('zh');
  const [autoLaunch, setAutoLaunchState] = useState(false);
  const [useSystemProxy, setUseSystemProxy] = useState(false);
  const [isUpdatingAutoLaunch] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [noticeMessage, setNoticeMessage] = useState<string | null>(notice ?? null);
  const [testResult, setTestResult] = useState<ProviderConnectionTestResult | null>(null);
  const [isTestResultModalOpen, setIsTestResultModalOpen] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  const [isImportingProviders, setIsImportingProviders] = useState(false);
  const [isExportingProviders, setIsExportingProviders] = useState(false);
  const initialThemeRef = useRef<'light' | 'dark' | 'system'>(themeService.getTheme());
  const initialLanguageRef = useRef<LanguageType>(i18nService.getLanguage());
  const didSaveRef = useRef(false);

  const [activeProvider, setActiveProvider] = useState<ProviderType>(getDefaultActiveProvider());
  const [showApiKey, setShowApiKey] = useState(false);
  const [providers, setProviders] = useState<ProvidersConfig>(() => getDefaultProviders());

  const importInputRef = useRef<HTMLInputElement>(null);
  const emailCopiedTimerRef = useRef<number | null>(null);
  const updateCheckTimerRef = useRef<number | null>(null);

  // Shortcuts
  const [shortcuts, setShortcuts] = useState({
    newChat: 'Ctrl+N',
    search: 'Ctrl+F',
    settings: 'Ctrl+,',
  });

  // Model editing
  const [isAddingModel, setIsAddingModel] = useState(false);
  const [isEditingModel, setIsEditingModel] = useState(false);
  const [editingModelId, setEditingModelId] = useState<string | null>(null);
  const [newModelName, setNewModelName] = useState('');
  const [newModelId, setNewModelId] = useState('');
  const [newModelSupportsImage, setNewModelSupportsImage] = useState(false);
  const [modelFormError, setModelFormError] = useState<string | null>(null);

  // About tab
  const [appVersion, setAppVersion] = useState('');
  const [emailCopied, setEmailCopied] = useState(false);
  const [isExportingLogs, setIsExportingLogs] = useState(false);
  const [testMode, setTestMode] = useState(false);
  const [logoClickCount, setLogoClickCount] = useState(0);
  const [testModeUnlocked, setTestModeUnlocked] = useState(false);
  const [updateCheckStatus, setUpdateCheckStatus] = useState<'idle' | 'checking' | 'upToDate' | 'error'>('idle');

  const contentRef = useRef<HTMLDivElement>(null);

  // Cowork config
  const coworkConfig = useSelector((state: RootState) => state.cowork.config);
  const [coworkExecutionMode, setCoworkExecutionMode] = useState<CoworkExecutionMode>(coworkConfig.executionMode || 'local');
  const [coworkMemoryEnabled, setCoworkMemoryEnabled] = useState<boolean>(coworkConfig.memoryEnabled ?? true);
  const [coworkMemoryLlmJudgeEnabled, setCoworkMemoryLlmJudgeEnabled] = useState<boolean>(coworkConfig.memoryLlmJudgeEnabled ?? false);
  const [coworkMemoryEntries, setCoworkMemoryEntries] = useState<CoworkUserMemoryEntry[]>([]);
  const [coworkMemoryStats, setCoworkMemoryStats] = useState<CoworkMemoryStats | null>(null);
  const [coworkMemoryListLoading, setCoworkMemoryListLoading] = useState<boolean>(false);
  const [coworkMemoryQuery, setCoworkMemoryQuery] = useState<string>('');
  const [coworkMemoryEditingId, setCoworkMemoryEditingId] = useState<string | null>(null);
  const [coworkMemoryDraftText, setCoworkMemoryDraftText] = useState<string>('');
  const [showMemoryModal, setShowMemoryModal] = useState<boolean>(false);
  const [coworkSandboxStatus, setCoworkSandboxStatus] = useState<CoworkSandboxStatus | null>(null);
  const [coworkSandboxLoading, setCoworkSandboxLoading] = useState(true);
  const [coworkSandboxProgress, setCoworkSandboxProgress] = useState<CoworkSandboxProgress | null>(null);
  const [coworkSandboxInstalling, setCoworkSandboxInstalling] = useState(false);

  // Computed values

  const coworkSandboxDisabled = !coworkSandboxStatus?.supported
    || !coworkSandboxStatus?.runtimeReady
    || !coworkSandboxStatus?.imageReady;

  const coworkSandboxStatusHint = useMemo(() => {
    if (coworkSandboxLoading) return i18nService.t('coworkSandboxChecking');
    if (!coworkSandboxStatus?.supported) return i18nService.t('coworkSandboxUnsupported');
    if (coworkSandboxStatus?.downloading) return i18nService.t('coworkSandboxDownloading');
    if (!coworkSandboxStatus?.runtimeReady) return i18nService.t('coworkSandboxRuntimeMissing');
    if (!coworkSandboxStatus?.imageReady) return i18nService.t('coworkSandboxImageMissing');
    return '';
  }, [coworkSandboxLoading, coworkSandboxStatus]);

  const coworkSandboxPercent = useMemo(() => {
    if (!coworkSandboxProgress) return null;
    if (coworkSandboxProgress.percent !== undefined && Number.isFinite(coworkSandboxProgress.percent)) {
      return Math.min(100, Math.max(0, Math.round(coworkSandboxProgress.percent * 100)));
    }
    if (coworkSandboxProgress.total && coworkSandboxProgress.total > 0) {
      return Math.min(100, Math.max(0, Math.round((coworkSandboxProgress.received / coworkSandboxProgress.total) * 100)));
    }
    return null;
  }, [coworkSandboxProgress]);

  const coworkSandboxStageLabel = coworkSandboxProgress?.stage === 'image'
    ? (i18nService.getLanguage() === 'zh' ? '镜像' : 'Image')
    : (i18nService.getLanguage() === 'zh' ? '运行时' : 'Runtime');

  const visibleProviders = useMemo(() => {
    const visibleKeys = getVisibleProviders(language);
    const filtered: Partial<ProvidersConfig> = {};
    for (const key of visibleKeys) {
      if (providers[key as keyof ProvidersConfig]) {
        filtered[key as keyof ProvidersConfig] = providers[key as keyof ProvidersConfig];
      }
    }
    return filtered as ProvidersConfig;
  }, [language, providers]);

  // ============================================================================
  // Effects
  // ============================================================================

  useEffect(() => {
    window.electron.appInfo.getVersion().then(setAppVersion);
  }, []);

  useEffect(() => {
    setShowApiKey(false);
  }, [activeProvider]);

  useEffect(() => () => {
    if (emailCopiedTimerRef.current != null) {
      window.clearTimeout(emailCopiedTimerRef.current);
    }
    if (updateCheckTimerRef.current != null) {
      window.clearTimeout(updateCheckTimerRef.current);
    }
  }, []);

  useEffect(() => {
    if (contentRef.current) {
      contentRef.current.scrollTop = 0;
    }
  }, [activeTab]);

  useEffect(() => {
    setNoticeMessage(notice ?? null);
  }, [notice]);

  useEffect(() => {
    if (initialTab) {
      setActiveTab(initialTab);
    }
  }, [initialTab]);

  useEffect(() => {
    const unsubscribe = i18nService.subscribe(() => {
      setLanguage(i18nService.getLanguage());
    });
    return unsubscribe;
  }, []);

  // Ensure activeProvider is always in visibleProviders when language changes
  useEffect(() => {
    const visibleKeys = Object.keys(visibleProviders) as ProviderType[];
    if (visibleKeys.length > 0 && !visibleKeys.includes(activeProvider)) {
      const firstEnabledVisible = visibleKeys.find(key => visibleProviders[key]?.enabled);
      setActiveProvider(firstEnabledVisible ?? visibleKeys[0]);
    }
  }, [visibleProviders, activeProvider]);

  useEffect(() => {
    setCoworkExecutionMode(coworkConfig.executionMode || 'local');
    setCoworkMemoryEnabled(coworkConfig.memoryEnabled ?? true);
    setCoworkMemoryLlmJudgeEnabled(coworkConfig.memoryLlmJudgeEnabled ?? false);
  }, [
    coworkConfig.executionMode,
    coworkConfig.memoryEnabled,
    coworkConfig.memoryLlmJudgeEnabled,
  ]);

  useEffect(() => {
    return () => {
      if (didSaveRef.current) {
        return;
      }
      themeService.setTheme(initialThemeRef.current);
      i18nService.setLanguage(initialLanguageRef.current, { persist: false });
    };
  }, []);

  // Cowork sandbox status
  const loadCoworkSandboxStatus = useCallback(async () => {
    setCoworkSandboxLoading(true);
    try {
      const status = await coworkService.getSandboxStatus();
      setCoworkSandboxStatus(status);
      if (status?.progress) {
        setCoworkSandboxProgress(status.progress);
      }
    } catch (loadError) {
      console.error('Failed to load cowork sandbox status:', loadError);
      setCoworkSandboxStatus(null);
    } finally {
      setCoworkSandboxLoading(false);
    }
  }, []);

  useEffect(() => {
    loadCoworkSandboxStatus();
  }, [loadCoworkSandboxStatus]);

  useEffect(() => {
    const unsubscribe = coworkService.onSandboxDownloadProgress((progress) => {
      setCoworkSandboxProgress(progress);
      if (progress.percent !== undefined && progress.percent >= 1) {
        void loadCoworkSandboxStatus();
      }
    });
    return () => unsubscribe();
  }, [loadCoworkSandboxStatus]);

  // Load config on mount
  useEffect(() => {
    try {
      const config = configService.getConfig();

      initialThemeRef.current = config.theme;
      initialLanguageRef.current = config.language;
      setTheme(config.theme);
      setLanguage(config.language);
      setUseSystemProxy(config.useSystemProxy ?? false);
      const savedTestMode = config.app?.testMode ?? false;
      setTestMode(savedTestMode);
      if (savedTestMode) setTestModeUnlocked(true);

      window.electron.autoLaunch.get().then(({ enabled }) => {
        setAutoLaunchState(enabled);
      }).catch(err => {
        console.error('Failed to load auto-launch setting:', err);
      });

      if (config.api) {
        const normalizedApiBaseUrl = config.api.baseUrl.toLowerCase();
        if (normalizedApiBaseUrl.includes('openai')) {
          setActiveProvider('openai');
          setProviders(prev => ({
            ...prev,
            openai: { ...prev.openai, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('deepseek')) {
          setActiveProvider('deepseek');
          setProviders(prev => ({
            ...prev,
            deepseek: { ...prev.deepseek, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('moonshot.ai') || normalizedApiBaseUrl.includes('moonshot.cn')) {
          setActiveProvider('moonshot');
          setProviders(prev => ({
            ...prev,
            moonshot: { ...prev.moonshot, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('bigmodel.cn')) {
          setActiveProvider('zhipu');
          setProviders(prev => ({
            ...prev,
            zhipu: { ...prev.zhipu, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('minimax')) {
          setActiveProvider('minimax');
          setProviders(prev => ({
            ...prev,
            minimax: { ...prev.minimax, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('openapi.youdao.com')) {
          setActiveProvider('youdaozhiyun');
          setProviders(prev => ({
            ...prev,
            youdaozhiyun: { ...prev.youdaozhiyun, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('dashscope')) {
          setActiveProvider('qwen');
          setProviders(prev => ({
            ...prev,
            qwen: { ...prev.qwen, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('stepfun')) {
          setActiveProvider('stepfun');
          setProviders(prev => ({
            ...prev,
            stepfun: { ...prev.stepfun, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('openrouter.ai')) {
          setActiveProvider('openrouter');
          setProviders(prev => ({
            ...prev,
            openrouter: { ...prev.openrouter, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('googleapis')) {
          setActiveProvider('gemini');
          setProviders(prev => ({
            ...prev,
            gemini: { ...prev.gemini, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('anthropic')) {
          setActiveProvider('anthropic');
          setProviders(prev => ({
            ...prev,
            anthropic: { ...prev.anthropic, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        } else if (normalizedApiBaseUrl.includes('ollama') || normalizedApiBaseUrl.includes('11434')) {
          setActiveProvider('ollama');
          setProviders(prev => ({
            ...prev,
            ollama: { ...prev.ollama, enabled: true, apiKey: config.api.key, baseUrl: config.api.baseUrl }
          }));
        }
      }

      if (config.providers) {
        setProviders(prev => {
          const merged = { ...prev, ...config.providers };
          const firstEnabledProvider = providerKeys.find(providerKey => merged[providerKey]?.enabled);
          if (firstEnabledProvider) {
            setActiveProvider(firstEnabledProvider);
          }
          return Object.fromEntries(
            Object.entries(merged).map(([providerKey, providerConfig]) => {
              const models = providerConfig.models?.map(model => ({
                ...model,
                supportsImage: model.supportsImage ?? false,
              }));
              return [
                providerKey,
                {
                  ...providerConfig,
                  apiFormat: getEffectiveApiFormat(providerKey, (providerConfig as ProviderConfig).apiFormat),
                  models,
                },
              ];
            })
          ) as ProvidersConfig;
        });
      }

      if (config.shortcuts) {
        setShortcuts(prev => ({ ...prev, ...config.shortcuts }));
      }
    } catch (error) {
      setError('Failed to load settings');
    }
  }, []);

  // Cowork memory
  const loadCoworkMemoryData = useCallback(async () => {
    setCoworkMemoryListLoading(true);
    try {
      const [entries, stats] = await Promise.all([
        coworkService.listMemoryEntries({
          query: coworkMemoryQuery.trim() || undefined,
        }),
        coworkService.getMemoryStats(),
      ]);
      setCoworkMemoryEntries(entries);
      setCoworkMemoryStats(stats);
    } catch (loadError) {
      console.error('Failed to load cowork memory data:', loadError);
      setCoworkMemoryEntries([]);
      setCoworkMemoryStats(null);
    } finally {
      setCoworkMemoryListLoading(false);
    }
  }, [coworkMemoryQuery]);

  useEffect(() => {
    if (activeTab !== 'coworkMemory') return;
    void loadCoworkMemoryData();
  }, [activeTab, loadCoworkMemoryData]);

  // ============================================================================
  // Handler Functions
  // ============================================================================

  const handleCopyContactEmail = useCallback(async () => {
    const copied = await copyTextToClipboard(ABOUT_CONTACT_EMAIL);
    if (copied) {
      setEmailCopied(true);
      if (emailCopiedTimerRef.current != null) {
        window.clearTimeout(emailCopiedTimerRef.current);
      }
      emailCopiedTimerRef.current = window.setTimeout(() => {
        setEmailCopied(false);
        emailCopiedTimerRef.current = null;
      }, 1200);
    }
  }, []);

  const handleCheckUpdate = useCallback(async () => {
    if (updateCheckStatus === 'checking' || !appVersion) return;
    setUpdateCheckStatus('checking');
    try {
      const info = await checkForAppUpdate(appVersion);
      if (info) {
        setUpdateCheckStatus('idle');
        onUpdateFound?.(info);
      } else {
        setUpdateCheckStatus('upToDate');
        if (updateCheckTimerRef.current != null) {
          window.clearTimeout(updateCheckTimerRef.current);
        }
        updateCheckTimerRef.current = window.setTimeout(() => {
          setUpdateCheckStatus('idle');
          updateCheckTimerRef.current = null;
        }, 3000);
      }
    } catch {
      setUpdateCheckStatus('error');
      if (updateCheckTimerRef.current != null) {
        window.clearTimeout(updateCheckTimerRef.current);
      }
      updateCheckTimerRef.current = window.setTimeout(() => {
        setUpdateCheckStatus('idle');
        updateCheckTimerRef.current = null;
      }, 3000);
    }
  }, [appVersion, updateCheckStatus, onUpdateFound]);

  const handleOpenUserManual = useCallback(() => {
    void window.electron.shell.openExternal(ABOUT_USER_MANUAL_URL);
  }, []);

  const handleOpenServiceTerms = useCallback(() => {
    void window.electron.shell.openExternal(ABOUT_SERVICE_TERMS_URL);
  }, []);

  const handleExportLogs = useCallback(async () => {
    if (isExportingLogs) return;
    setError(null);
    setNoticeMessage(null);
    setIsExportingLogs(true);
    try {
      const result = await window.electron.log.exportZip();
      if (!result.success) {
        setError(result.error || i18nService.t('aboutExportLogsFailed'));
        return;
      }
      if (result.canceled) return;
      if (result.path) {
        await window.electron.shell.showItemInFolder(result.path);
      }
      if ((result.missingEntries?.length ?? 0) > 0) {
        const missingList = result.missingEntries?.join(', ') || '';
        setNoticeMessage(`${i18nService.t('aboutExportLogsPartial')}: ${missingList}`);
      } else {
        setNoticeMessage(i18nService.t('aboutExportLogsSuccess'));
      }
    } catch (exportError) {
      setError(exportError instanceof Error ? exportError.message : i18nService.t('aboutExportLogsFailed'));
    } finally {
      setIsExportingLogs(false);
    }
  }, [isExportingLogs]);

  const handleInstallCoworkSandbox = async () => {
    setCoworkSandboxInstalling(true);
    try {
      const result = await coworkService.installSandbox();
      if (result?.status) {
        setCoworkSandboxStatus(result.status);
        if (result.status.progress) {
          setCoworkSandboxProgress(result.status.progress);
        }
      }
    } finally {
      setCoworkSandboxInstalling(false);
    }
  };

  const resetCoworkMemoryEditor = () => {
    setCoworkMemoryEditingId(null);
    setCoworkMemoryDraftText('');
    setShowMemoryModal(false);
  };

  const handleSaveCoworkMemoryEntry = async () => {
    const text = coworkMemoryDraftText.trim();
    if (!text) return;
    setCoworkMemoryListLoading(true);
    try {
      if (coworkMemoryEditingId) {
        await coworkService.updateMemoryEntry({
          id: coworkMemoryEditingId,
          text,
          status: 'created',
          isExplicit: true,
        });
      } else {
        await coworkService.createMemoryEntry({
          text,
          isExplicit: true,
        });
      }
      resetCoworkMemoryEditor();
      await loadCoworkMemoryData();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : i18nService.t('coworkMemoryCrudSaveFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleEditCoworkMemoryEntry = (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryEditingId(entry.id);
    setCoworkMemoryDraftText(entry.text);
    setShowMemoryModal(true);
  };

  const handleDeleteCoworkMemoryEntry = async (entry: CoworkUserMemoryEntry) => {
    setCoworkMemoryListLoading(true);
    try {
      await coworkService.deleteMemoryEntry({ id: entry.id });
      if (coworkMemoryEditingId === entry.id) {
        resetCoworkMemoryEditor();
      }
      await loadCoworkMemoryData();
    } catch (deleteError) {
      setError(deleteError instanceof Error ? deleteError.message : i18nService.t('coworkMemoryCrudDeleteFailed'));
    } finally {
      setCoworkMemoryListLoading(false);
    }
  };

  const handleOpenCoworkMemoryModal = () => {
    resetCoworkMemoryEditor();
    setShowMemoryModal(true);
  };

  const handleProviderChange = (provider: ProviderType) => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
    setActiveProvider(provider);
    setIsTestResultModalOpen(false);
    setTestResult(null);
  };

  const handleProviderConfigChange = (provider: ProviderType, field: string, value: unknown) => {
    setProviders(prev => {
      if (field === 'apiFormat') {
        const nextApiFormat = getEffectiveApiFormat(provider, value);
        const nextProviderConfig: ProviderConfig = { ...prev[provider], apiFormat: nextApiFormat };
        if (shouldAutoSwitchProviderBaseUrl(provider, prev[provider].baseUrl)) {
          const defaultBaseUrl = getProviderDefaultBaseUrl(provider, nextApiFormat);
          if (defaultBaseUrl) {
            nextProviderConfig.baseUrl = defaultBaseUrl;
          }
        }
        return { ...prev, [provider]: nextProviderConfig };
      }

      // Handle codingPlanEnabled toggles
      if (field === 'codingPlanEnabled') {
        const codingPlanEnabled = value === 'true';
        return { ...prev, [provider]: { ...prev[provider], codingPlanEnabled } };
      }

      return { ...prev, [provider]: { ...prev[provider], [field]: value } };
    });
  };

  const toggleProviderEnabled = (provider: ProviderType) => {
    const providerConfig = providers[provider];
    const isEnabling = !providerConfig.enabled;
    const missingApiKey = providerKeys.includes(provider) && provider !== 'ollama' && !providerConfig.apiKey.trim();

    if (isEnabling && missingApiKey) {
      setError(i18nService.t('apiKeyRequired'));
      return;
    }

    setProviders(prev => ({
      ...prev,
      [provider]: { ...prev[provider], enabled: !prev[provider].enabled }
    }));
  };

  const enableProvider = (provider: ProviderType) => {
    setProviders(prev => {
      if (prev[provider].enabled) return prev;
      return { ...prev, [provider]: { ...prev[provider], enabled: true } };
    });
  };

  const hasCoworkConfigChanges = coworkExecutionMode !== coworkConfig.executionMode
    || coworkMemoryEnabled !== coworkConfig.memoryEnabled
    || coworkMemoryLlmJudgeEnabled !== coworkConfig.memoryLlmJudgeEnabled;

  const handleSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    setIsSaving(true);
    setError(null);

    try {
      const normalizedProviders = Object.fromEntries(
        Object.entries(providers).map(([providerKey, providerConfig]) => {
          const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
          return [
            providerKey,
            {
              ...providerConfig,
              apiFormat,
              baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
            },
          ];
        })
      ) as ProvidersConfig;

      const firstEnabledProvider = Object.entries(normalizedProviders).find(([_, config]) => config.enabled);
      const primaryProvider = firstEnabledProvider ? firstEnabledProvider[1] : normalizedProviders[activeProvider];

      await configService.updateConfig({
        api: { key: primaryProvider.apiKey, baseUrl: primaryProvider.baseUrl },
        providers: normalizedProviders,
        theme,
        language,
        useSystemProxy,
        shortcuts,
        app: { ...configService.getConfig().app, testMode },
      });

      themeService.setTheme(theme);
      i18nService.setLanguage(language, { persist: false });

      apiService.setConfig({ apiKey: primaryProvider.apiKey, baseUrl: primaryProvider.baseUrl });

      const allModels: { id: string; name: string; provider?: string; providerKey?: string; supportsImage?: boolean }[] = [];
      Object.entries(normalizedProviders).forEach(([providerName, config]) => {
        if (config.enabled && config.models) {
          config.models.forEach(model => {
            allModels.push({
              id: model.id,
              name: model.name,
              provider: providerName.charAt(0).toUpperCase() + providerName.slice(1),
              providerKey: providerName,
              supportsImage: model.supportsImage ?? false,
            });
          });
        }
      });
      dispatch(setAvailableModels(allModels));

      if (hasCoworkConfigChanges) {
        await coworkService.updateConfig({
          executionMode: coworkExecutionMode,
          memoryEnabled: coworkMemoryEnabled,
          memoryLlmJudgeEnabled: coworkMemoryLlmJudgeEnabled,
        });
      }

      didSaveRef.current = true;
      onClose();
    } catch (error) {
      setError(error instanceof Error ? error.message : 'Failed to save settings');
    } finally {
      setIsSaving(false);
    }
  };

  const handleTabChange = (tab: TabType) => {
    if (tab !== 'model') {
      setIsAddingModel(false);
      setIsEditingModel(false);
      setEditingModelId(null);
      setNewModelName('');
      setNewModelId('');
      setNewModelSupportsImage(false);
      setModelFormError(null);
    }
    setActiveTab(tab);
  };

  const handleShortcutChange = (key: string, value: string) => {
    setShortcuts(prev => ({ ...prev, [key]: value }));
  };

  const handleSettingsClick = (e: React.MouseEvent) => {
    e.stopPropagation();
  };

  const handleAddModel = () => {
    setIsAddingModel(true);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleEditModel = (modelId: string, modelName: string, supportsImage?: boolean) => {
    setIsAddingModel(false);
    setIsEditingModel(true);
    setEditingModelId(modelId);
    setNewModelName(modelName);
    setNewModelId(modelId);
    setNewModelSupportsImage(!!supportsImage);
    setModelFormError(null);
  };

  const handleDeleteModel = (modelId: string) => {
    if (!providers[activeProvider].models) return;
    const updatedModels = providers[activeProvider].models.filter(model => model.id !== modelId);
    setProviders(prev => ({
      ...prev,
      [activeProvider]: { ...prev[activeProvider], models: updatedModels }
    }));
  };

  const handleSaveNewModel = () => {
    const modelId = newModelId.trim();

    if (activeProvider === 'ollama') {
      if (!modelId) {
        setModelFormError(i18nService.t('ollamaModelNameRequired'));
        return;
      }
    } else {
      const modelName = newModelName.trim();
      if (!modelName || !modelId) {
        setModelFormError(i18nService.t('modelNameAndIdRequired'));
        return;
      }
    }

    const modelName = activeProvider === 'ollama'
      ? (newModelName.trim() && newModelName.trim() !== modelId ? newModelName.trim() : modelId)
      : newModelName.trim();

    const currentModels = providers[activeProvider].models ?? [];
    const duplicateModel = currentModels.find(
      model => model.id === modelId && (!isEditingModel || model.id !== editingModelId)
    );
    if (duplicateModel) {
      setModelFormError(i18nService.t('modelIdExists'));
      return;
    }

    const nextModel = { id: modelId, name: modelName, supportsImage: newModelSupportsImage };
    const updatedModels = isEditingModel && editingModelId
      ? currentModels.map(model => (model.id === editingModelId ? nextModel : model))
      : [...currentModels, nextModel];

    setProviders(prev => ({
      ...prev,
      [activeProvider]: { ...prev[activeProvider], models: updatedModels }
    }));

    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleCancelModelEdit = () => {
    setIsAddingModel(false);
    setIsEditingModel(false);
    setEditingModelId(null);
    setNewModelName('');
    setNewModelId('');
    setNewModelSupportsImage(false);
    setModelFormError(null);
  };

  const handleModelDialogKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      handleCancelModelEdit();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      handleSaveNewModel();
    }
  };

  const showTestResultModal = (result: Omit<ProviderConnectionTestResult, 'provider'>, provider: ProviderType) => {
    setTestResult({ ...result, provider });
    setIsTestResultModalOpen(true);
  };

  const handleTestConnection = async () => {
    const testingProvider = activeProvider;
    const providerConfig = providers[testingProvider];
    setIsTesting(true);
    setIsTestResultModalOpen(false);
    setTestResult(null);

    if (providerKeys.includes(testingProvider) && testingProvider !== 'ollama' && !providerConfig.apiKey) {
      showTestResultModal({ success: false, message: i18nService.t('apiKeyRequired') }, testingProvider);
      setIsTesting(false);
      return;
    }

    const firstModel = providerConfig.models?.[0];
    if (!firstModel) {
      showTestResultModal({ success: false, message: i18nService.t('noModelsConfigured') }, testingProvider);
      setIsTesting(false);
      return;
    }

    try {
      let response: Awaited<ReturnType<typeof window.electron.api.fetch>>;
      let effectiveBaseUrl = resolveBaseUrl(testingProvider, providerConfig.baseUrl, getEffectiveApiFormat(testingProvider, providerConfig.apiFormat));
      let effectiveApiFormat = getEffectiveApiFormat(testingProvider, providerConfig.apiFormat);

      // Coding Plan endpoint switch
      const codingPlanUrl = getCodingPlanUrl(testingProvider, effectiveApiFormat, (providerConfig as ProviderConfig & { codingPlanEnabled?: boolean }).codingPlanEnabled ?? false);
      if (codingPlanUrl) {
        effectiveBaseUrl = codingPlanUrl;
        if (testingProvider === 'zhipu' || testingProvider === 'qwen' || testingProvider === 'volcengine' || testingProvider === 'moonshot') {
          effectiveApiFormat = 'openai';
        }
      }

      const normalizedBaseUrl = effectiveBaseUrl.replace(/\/+$/, '');
      const useAnthropicFormat = effectiveApiFormat === 'anthropic';

      if (useAnthropicFormat) {
        const anthropicUrl = normalizedBaseUrl.endsWith('/v1')
          ? `${normalizedBaseUrl}/messages`
          : `${normalizedBaseUrl}/v1/messages`;
        response = await window.electron.api.fetch({
          url: anthropicUrl,
          method: 'POST',
          headers: {
            'x-api-key': providerConfig.apiKey,
            'anthropic-version': '2023-06-01',
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: firstModel.id,
            max_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET,
            messages: [{ role: 'user', content: 'Hi' }],
          }),
        });
      } else {
        const useResponsesApi = shouldUseOpenAIResponsesForProvider(testingProvider);
        const openaiUrl = useResponsesApi
          ? buildOpenAIResponsesUrl(normalizedBaseUrl)
          : buildOpenAICompatibleChatCompletionsUrl(normalizedBaseUrl, testingProvider);
        const headers: Record<string, string> = { 'Content-Type': 'application/json' };
        if (providerConfig.apiKey) {
          headers.Authorization = `Bearer ${providerConfig.apiKey}`;
        }
        const openAIRequestBody: Record<string, unknown> = useResponsesApi
          ? { model: firstModel.id, input: [{ role: 'user', content: [{ type: 'input_text', text: 'Hi' }] }], max_output_tokens: CONNECTIVITY_TEST_TOKEN_BUDGET }
          : { model: firstModel.id, messages: [{ role: 'user', content: 'Hi' }] };
        if (!useResponsesApi && shouldUseMaxCompletionTokensForOpenAI(testingProvider, firstModel.id)) {
          openAIRequestBody.max_completion_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
        } else {
          if (!useResponsesApi) {
            openAIRequestBody.max_tokens = CONNECTIVITY_TEST_TOKEN_BUDGET;
          }
        }
        response = await window.electron.api.fetch({
          url: openaiUrl,
          method: 'POST',
          headers,
          body: JSON.stringify(openAIRequestBody),
        });
      }

      if (response.ok) {
        enableProvider(testingProvider);
        showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
      } else {
        const data = response.data || {};
        const errorMessage = data.error?.message || data.message || `${i18nService.t('connectionFailed')}: ${response.status}`;
        if (typeof errorMessage === 'string' && errorMessage.toLowerCase().includes('model output limit was reached')) {
          enableProvider(testingProvider);
          showTestResultModal({ success: true, message: i18nService.t('connectionSuccess') }, testingProvider);
          return;
        }
        showTestResultModal({ success: false, message: errorMessage }, testingProvider);
      }
    } catch (err) {
      showTestResultModal({
        success: false,
        message: err instanceof Error ? err.message : i18nService.t('connectionFailed'),
      }, testingProvider);
    } finally {
      setIsTesting(false);
    }
  };

  const buildProvidersExport = async (password: string): Promise<ProvidersExportPayload> => {
    const entries = await Promise.all(
      Object.entries(providers).map(async ([providerKey, providerConfig]) => {
        const apiKey = await encryptWithPassword(providerConfig.apiKey, password);
        const apiFormat = getEffectiveApiFormat(providerKey, providerConfig.apiFormat);
        return [
          providerKey,
          {
            enabled: providerConfig.enabled,
            apiKey,
            baseUrl: resolveBaseUrl(providerKey as ProviderType, providerConfig.baseUrl, apiFormat),
            apiFormat,
            codingPlanEnabled: (providerConfig as ProviderConfig).codingPlanEnabled,
            models: providerConfig.models,
          },
        ] as const;
      })
    );
    return {
      type: EXPORT_FORMAT_TYPE,
      version: 2,
      exportedAt: new Date().toISOString(),
      encryption: { algorithm: 'AES-GCM', keySource: 'password', keyDerivation: 'PBKDF2' },
      providers: Object.fromEntries(entries),
    };
  };

  const DEFAULT_EXPORT_PASSWORD = EXPORT_PASSWORD;

  const normalizeModels = (models?: Model[]) =>
    models?.map(model => ({
      ...model,
      supportsImage: model.supportsImage ?? false,
    }));

  const handleExportProviders = async () => {
    setError(null);
    setIsExportingProviders(true);
    try {
      const payload = await buildProvidersExport(DEFAULT_EXPORT_PASSWORD);
      const json = JSON.stringify(payload, null, 2);
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const date = new Date().toISOString().slice(0, 10);
      const link = document.createElement('a');
      link.href = url;
      link.download = `${APP_ID}-providers-${date}.json`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (err) {
      console.error('Failed to export providers:', err);
      setError(i18nService.t('exportProvidersFailed'));
    } finally {
      setIsExportingProviders(false);
    }
  };

  const handleImportProvidersClick = () => {
    importInputRef.current?.click();
  };

  const handleImportProviders = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';
    if (!file) return;

    setError(null);

    try {
      const raw = await file.text();
      let payload: ProvidersImportPayload;
      try {
        payload = JSON.parse(raw) as ProvidersImportPayload;
      } catch (parseError) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      if (!payload || payload.type !== EXPORT_FORMAT_TYPE || !payload.providers) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      if (payload.version === 2 && payload.encryption?.keySource === 'password') {
        await processImportPayloadWithPassword(payload);
        return;
      }

      if (payload.version === 1) {
        await processImportPayloadWithLocalKey(payload);
        return;
      }

      setError(i18nService.t('invalidProvidersFile'));
    } catch (err) {
      console.error('Failed to import providers:', err);
      setError(i18nService.t('importProvidersFailed'));
    }
  };

  const processImportPayloadWithLocalKey = async (payload: ProvidersImportPayload) => {
    setIsImportingProviders(true);
    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;
      for (const providerKey of providerKeys) {
        const providerData = payload.providers?.[providerKey];
        if (!providerData) continue;

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          try {
            apiKey = await decryptSecret(providerData.apiKey as EncryptedPayload);
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        } else if (typeof providerData.apiKeyEncrypted === 'string' && typeof providerData.apiKeyIv === 'string') {
          try {
            apiKey = await decryptSecret({ encrypted: providerData.apiKeyEncrypted, iv: providerData.apiKeyIv });
          } catch (error) {
            hadDecryptFailure = true;
            console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
          }
        }

        const models = normalizeModels(providerData.models);
        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? providers[providerKey].apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = { ...prev[providerKey], ...update };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError ? i18nService.t('decryptProvidersFailed') : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  const processImportPayloadWithPassword = async (payload: ProvidersImportPayload) => {
    if (!payload.providers) return;

    setIsImportingProviders(true);

    try {
      const providerUpdates: Partial<ProvidersConfig> = {};
      let hadDecryptFailure = false;

      for (const providerKey of providerKeys) {
        const providerData = payload.providers[providerKey];
        if (!providerData) continue;

        let apiKey: string | undefined;
        if (typeof providerData.apiKey === 'string') {
          apiKey = providerData.apiKey;
        } else if (providerData.apiKey && typeof providerData.apiKey === 'object') {
          const apiKeyObj = providerData.apiKey as PasswordEncryptedPayload;
          if (apiKeyObj.salt) {
            try {
              apiKey = await decryptWithPassword(apiKeyObj, DEFAULT_EXPORT_PASSWORD);
            } catch (error) {
              hadDecryptFailure = true;
              console.warn(`Failed to decrypt provider key for ${providerKey}`, error);
            }
          }
        }

        const models = normalizeModels(providerData.models);
        providerUpdates[providerKey] = {
          enabled: typeof providerData.enabled === 'boolean' ? providerData.enabled : providers[providerKey].enabled,
          apiKey: apiKey ?? providers[providerKey].apiKey,
          baseUrl: typeof providerData.baseUrl === 'string' ? providerData.baseUrl : providers[providerKey].baseUrl,
          apiFormat: getEffectiveApiFormat(providerKey, providerData.apiFormat ?? providers[providerKey].apiFormat),
          codingPlanEnabled: typeof providerData.codingPlanEnabled === 'boolean' ? providerData.codingPlanEnabled : (providers[providerKey] as ProviderConfig).codingPlanEnabled,
          models: models ?? providers[providerKey].models,
        };
      }

      if (Object.keys(providerUpdates).length === 0) {
        setError(i18nService.t('invalidProvidersFile'));
        return;
      }

      const anyKeyDecrypted = Object.entries(providerUpdates).some(
        ([key, update]) => update?.apiKey && update.apiKey !== providers[key]?.apiKey
      );

      if (!anyKeyDecrypted && hadDecryptFailure) {
        setError(i18nService.t('decryptProvidersFailed'));
        return;
      }

      setProviders(prev => {
        const next = { ...prev };
        Object.entries(providerUpdates).forEach(([providerKey, update]) => {
          next[providerKey] = { ...prev[providerKey], ...update };
        });
        return next;
      });
      setIsTestResultModalOpen(false);
      setTestResult(null);
      if (hadDecryptFailure) {
        setNoticeMessage(i18nService.t('decryptProvidersPartial'));
      }
    } catch (err) {
      console.error('Failed to import providers:', err);
      const isDecryptError = err instanceof Error && (err.message === 'Invalid encrypted payload' || err.name === 'OperationError');
      const message = isDecryptError ? i18nService.t('decryptProvidersFailed') : i18nService.t('importProvidersFailed');
      setError(message);
    } finally {
      setIsImportingProviders(false);
    }
  };

  const handleClearError = () => setError(null);

  // ============================================================================
  // Tab Sidebar Definition
  // ============================================================================

  const sidebarTabs = useMemo(() => [
    { key: 'general' as TabType, label: i18nService.t('general'), icon: <Cog6ToothIcon className="h-5 w-5" /> },
    { key: 'model' as TabType, label: i18nService.t('model'), icon: <CubeIcon className="h-5 w-5" /> },
    { key: 'im' as TabType, label: i18nService.t('imBot'), icon: <ChatBubbleLeftIcon className="h-5 w-5" /> },
    { key: 'email' as TabType, label: i18nService.t('emailTab'), icon: <EnvelopeIcon className="h-5 w-5" /> },
    { key: 'coworkMemory' as TabType, label: i18nService.t('coworkMemoryTitle'), icon: <BrainIcon className="h-5 w-5" /> },
    { key: 'coworkSandbox' as TabType, label: i18nService.t('coworkSandbox'), icon: <ShieldCheckIcon className="h-5 w-5" /> },
    { key: 'shortcuts' as TabType, label: i18nService.t('shortcuts'), icon: <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={1.5} stroke="currentColor" className="h-5 w-5"><rect x="2" y="4" width="20" height="14" rx="2" /><line x1="6" y1="8" x2="8" y2="8" /><line x1="10" y1="8" x2="12" y2="8" /><line x1="14" y1="8" x2="16" y2="8" /><line x1="6" y1="12" x2="8" y2="12" /><line x1="10" y1="12" x2="14" y2="12" /><line x1="16" y1="12" x2="18" y2="12" /><line x1="8" y1="15.5" x2="16" y2="15.5" /></svg> },
    { key: 'about' as TabType, label: i18nService.t('about'), icon: <InformationCircleIcon className="h-5 w-5" /> },
  ], [language]);

  const activeTabLabel = useMemo(() => sidebarTabs.find(t => t.key === activeTab)?.label ?? '', [activeTab, sidebarTabs]);

  // ============================================================================
  // Tab Content Rendering
  // ============================================================================

  const renderTabContent = () => {
    switch (activeTab) {
      case 'general':
        return (
          <GeneralSettings
            language={language}
            autoLaunch={autoLaunch}
            useSystemProxy={useSystemProxy}
            isUpdatingAutoLaunch={isUpdatingAutoLaunch}
            theme={theme}
            onLanguageChange={(lang) => {
              setLanguage(lang);
              i18nService.setLanguage(lang, { persist: false });
            }}
            onAutoLaunchChange={(enabled) => {
              setAutoLaunchState(enabled);
            }}
            onUseSystemProxyChange={setUseSystemProxy}
            onThemeChange={(t) => {
              setTheme(t);
              themeService.setTheme(t);
            }}
          />
        );

      case 'model':
        return (
          <ModelSettings
            providers={providers}
            activeProvider={activeProvider}
            showApiKey={showApiKey}
            isTesting={isTesting}
            isImportingProviders={isImportingProviders}
            isExportingProviders={isExportingProviders}
            visibleProviders={visibleProviders}
            providerMeta={providerMeta}
            onProviderChange={handleProviderChange}
            onProviderConfigChange={handleProviderConfigChange}
            onToggleProviderEnabled={toggleProviderEnabled}
            onTestConnection={handleTestConnection}
            onImportProviders={handleImportProviders}
            onExportProviders={handleExportProviders}
            onShowApiKeyToggle={() => setShowApiKey(!showApiKey)}
            onImportProvidersClick={handleImportProvidersClick}
            onAddModel={handleAddModel}
            onEditModel={handleEditModel}
            onDeleteModel={handleDeleteModel}
            importInputRef={importInputRef}
          />
        );

      case 'coworkSandbox':
        return (
          <CoworkSandboxSettings
            coworkExecutionMode={coworkExecutionMode}
            coworkSandboxStatus={coworkSandboxStatus}
            coworkSandboxProgress={coworkSandboxProgress}
            coworkSandboxDisabled={coworkSandboxDisabled}
            coworkSandboxInstalling={coworkSandboxInstalling}
            coworkSandboxLoading={coworkSandboxLoading}
            coworkSandboxStatusHint={coworkSandboxStatusHint}
            coworkSandboxPercent={coworkSandboxPercent}
            coworkSandboxStageLabel={coworkSandboxStageLabel}
            onExecutionModeChange={setCoworkExecutionMode}
            onInstallSandbox={handleInstallCoworkSandbox}
          />
        );

      case 'coworkMemory':
        return (
          <CoworkMemorySettings
            coworkMemoryEnabled={coworkMemoryEnabled}
            coworkMemoryLlmJudgeEnabled={coworkMemoryLlmJudgeEnabled}
            coworkMemoryEntries={coworkMemoryEntries}
            coworkMemoryStats={coworkMemoryStats}
            coworkMemoryQuery={coworkMemoryQuery}
            coworkMemoryListLoading={coworkMemoryListLoading}
            onEnabledChange={setCoworkMemoryEnabled}
            onLlmJudgeEnabledChange={setCoworkMemoryLlmJudgeEnabled}
            onQueryChange={setCoworkMemoryQuery}
            onOpenModal={handleOpenCoworkMemoryModal}
            onEditEntry={handleEditCoworkMemoryEntry}
            onDeleteEntry={handleDeleteCoworkMemoryEntry}
          />
        );

      case 'shortcuts':
        return (
          <ShortcutsSettings
            shortcuts={shortcuts}
            onShortcutChange={handleShortcutChange}
          />
        );

      case 'about':
        return (
          <AboutSettings
            appVersion={appVersion}
            updateCheckStatus={updateCheckStatus}
            emailCopied={emailCopied}
            isExportingLogs={isExportingLogs}
            testMode={testMode}
            testModeUnlocked={testModeUnlocked}
            logoClickCount={logoClickCount}
            language={language}
            onLogoClick={(count) => {
              setLogoClickCount(count);
              if (count >= 10 && !testModeUnlocked) {
                setTestModeUnlocked(true);
              }
            }}
            onCheckUpdate={handleCheckUpdate}
            onOpenUserManual={handleOpenUserManual}
            onOpenServiceTerms={handleOpenServiceTerms}
            onExportLogs={handleExportLogs}
            onSetTestMode={setTestMode}
            onSetTestModeUnlocked={setTestModeUnlocked}
            onSetEmailCopied={setEmailCopied}
          />
        );

      case 'email':
        return <EmailSkillConfig />;

      case 'im':
        return <IMSettings />;

      default:
        return null;
    }
  };

  // ============================================================================
  // Context Value
  // ============================================================================

  const stateValue: SettingsStateValue = {
    activeTab,
    providers,
    activeProvider,
    showApiKey,
    language,
    autoLaunch,
    useSystemProxy,
    isUpdatingAutoLaunch,
    coworkExecutionMode,
    coworkSandboxStatus,
    coworkSandboxProgress,
    coworkSandboxDisabled,
    coworkSandboxInstalling,
    coworkSandboxLoading,
    coworkSandboxStatusHint,
    coworkSandboxPercent,
    coworkSandboxStageLabel,
    coworkMemoryEnabled,
    coworkMemoryLlmJudgeEnabled,
    coworkMemoryEntries,
    coworkMemoryStats,
    coworkMemoryQuery,
    coworkMemoryListLoading,
    shortcuts,
    appVersion,
    emailCopied,
    updateCheckStatus,
    testResult,
    isTestResultModalOpen,
    isAddingModel,
    isEditingModel,
    editingModelId,
    error,
    noticeMessage,
  };

  const actionsValue: SettingsActionsValue = {
    setActiveTab,
    handleProviderChange,
    handleProviderConfigChange,
    toggleProviderEnabled,
    handleTestConnection,
    handleImportProviders,
    handleExportProviders,
    setShowApiKey,
    handleAddModel,
    handleEditModel,
    handleSaveNewModel,
    handleCancelModelEdit,
    handleDeleteModel,
    setCoworkExecutionMode,
    handleInstallCoworkSandbox,
    setCoworkMemoryEnabled,
    setCoworkMemoryLlmJudgeEnabled,
    setCoworkMemoryQuery,
    handleOpenCoworkMemoryModal,
    handleEditCoworkMemoryEntry,
    handleDeleteCoworkMemoryEntry,
    handleSaveCoworkMemoryEntry,
    handleShortcutChange,
    setLanguage,
    setAutoLaunchState,
    setUseSystemProxy,
    handleCopyContactEmail,
    handleCheckUpdate,
    handleOpenUserManual,
    handleOpenServiceTerms,
    handleExportLogs,
    setTestResult,
    setIsTestResultModalOpen,
    handleClearError,
    handleSubmit,
  };

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <SettingsStateContext.Provider value={stateValue}>
      <SettingsActionsContext.Provider value={actionsValue}>
        <div
          className="fixed inset-0 z-50 modal-backdrop flex items-center justify-center"
          onClick={onClose}
        >
          <div
            className="relative flex w-[900px] h-[80vh] rounded-2xl shadow-modal overflow-hidden modal-content"
            onClick={handleSettingsClick}
          >
            {/* Left sidebar */}
            <div className="w-[220px] shrink-0 flex flex-col dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted rounded-l-2xl overflow-y-auto">
              <div className="px-5 pt-5 pb-3">
                <h2 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{i18nService.t('settings')}</h2>
              </div>
              <nav className="flex flex-col gap-0.5 px-3 pb-4">
                {sidebarTabs.map((tab) => (
                  <button
                    key={tab.key}
                    onClick={() => handleTabChange(tab.key)}
                    className={`flex items-center gap-3 px-3 py-2 rounded-lg text-sm font-medium transition-colors text-left ${
                      activeTab === tab.key
                        ? 'bg-claude-accent/10 text-claude-accent'
                        : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover'
                    }`}
                  >
                    {tab.icon}
                    <span>{tab.label}</span>
                  </button>
                ))}
              </nav>
            </div>

            {/* Right content */}
            <div className="relative flex-1 flex flex-col min-w-0 overflow-hidden dark:bg-claude-darkBg bg-claude-bg rounded-r-2xl">
              {/* Content header */}
              <div className="flex justify-between items-center px-6 pt-5 pb-3 shrink-0">
                <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">{activeTabLabel}</h3>
                <button
                  onClick={onClose}
                  className="dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text p-1.5 dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-lg transition-colors"
                >
                  <XMarkIcon className="h-5 w-5" />
                </button>
              </div>

              {noticeMessage && (
                <div className="px-6">
                  <ErrorMessage message={noticeMessage} onClose={() => setNoticeMessage(null)} />
                </div>
              )}

              {error && (
                <div className="px-6">
                  <ErrorMessage message={error} onClose={handleClearError} />
                </div>
              )}

              <form onSubmit={handleSubmit} className="flex flex-col flex-1 overflow-hidden">
                {/* Tab content */}
                <div
                  ref={contentRef}
                  className="px-6 py-4 flex-1 overflow-y-auto"
                  style={{ scrollbarGutter: 'stable' }}
                >
                  {renderTabContent()}
                </div>

                {/* Footer buttons */}
                <div className="flex justify-end space-x-4 p-4 dark:bg-claude-darkBg bg-claude-bg shrink-0">
                  <button
                    type="button"
                    onClick={onClose}
                    className="px-4 py-2 dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl transition-colors text-sm font-medium border dark:border-claude-darkBorder border-claude-border active:scale-[0.98]"
                  >
                    {i18nService.t('cancel')}
                  </button>
                  <button
                    type="submit"
                    disabled={isSaving}
                    className="px-4 py-2 bg-claude-accent hover:bg-claude-accentHover text-white rounded-xl transition-colors text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed active:scale-[0.98]"
                  >
                    {isSaving ? i18nService.t('saving') : i18nService.t('save')}
                  </button>
                </div>
              </form>
            </div>

            {/* ========================================================================== */}
            {/* Modals */}
            {/* ========================================================================== */}

            {/* Test Result Modal */}
            {isTestResultModalOpen && testResult && (
              <div
                className="absolute inset-0 z-30 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
                onClick={() => setIsTestResultModalOpen(false)}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={i18nService.t('connectionTestResult')}
                  onClick={(e) => e.stopPropagation()}
                  className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                      {i18nService.t('connectionTestResult')}
                    </h4>
                    <button
                      type="button"
                      onClick={() => setIsTestResultModalOpen(false)}
                      className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>

                  <div className="flex items-center gap-2 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    <span>{providerMeta[testResult.provider]?.label ?? testResult.provider}</span>
                    <span className="text-[11px]">•</span>
                    <span className={`inline-flex items-center gap-1 ${testResult.success ? 'text-green-600 dark:text-green-400' : 'text-red-600 dark:text-red-400'}`}>
                      {testResult.success ? <CheckCircleIcon className="h-4 w-4" /> : <XCircleIcon className="h-4 w-4" />}
                      {testResult.success ? i18nService.t('connectionSuccess') : i18nService.t('connectionFailed')}
                    </span>
                  </div>

                  <p className="mt-3 text-xs leading-5 dark:text-claude-darkText text-claude-text whitespace-pre-wrap break-words max-h-56 overflow-y-auto">
                    {testResult.message}
                  </p>

                  <div className="mt-4 flex justify-end">
                    <button
                      type="button"
                      onClick={() => setIsTestResultModalOpen(false)}
                      className="px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors active:scale-[0.98]"
                    >
                      {i18nService.t('close')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Model Add/Edit Dialog */}
            {(isAddingModel || isEditingModel) && (
              <div
                className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
                onClick={handleCancelModelEdit}
              >
                <div
                  role="dialog"
                  aria-modal="true"
                  aria-label={isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                  onClick={(e) => e.stopPropagation()}
                  onKeyDown={handleModelDialogKeyDown}
                  className="w-full max-w-md rounded-2xl dark:bg-claude-darkSurface bg-claude-bg dark:border-claude-darkBorder border-claude-border border shadow-modal p-4"
                >
                  <div className="flex items-center justify-between mb-3">
                    <h4 className="text-sm font-semibold dark:text-claude-darkText text-claude-text">
                      {isEditingModel ? i18nService.t('editModel') : i18nService.t('addNewModel')}
                    </h4>
                    <button
                      type="button"
                      onClick={handleCancelModelEdit}
                      className="p-1 dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:text-claude-darkText hover:text-claude-text rounded-md dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover"
                    >
                      <XMarkIcon className="h-4 w-4" />
                    </button>
                  </div>

                  {modelFormError && (
                    <p className="mb-3 text-xs text-red-600 dark:text-red-400">{modelFormError}</p>
                  )}

                  <div className="space-y-3">
                    {activeProvider === 'ollama' ? (
                      <>
                        <div>
                          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                            {i18nService.t('ollamaModelName')}
                          </label>
                          <input
                            autoFocus
                            type="text"
                            value={newModelId}
                            onChange={(e) => {
                              setNewModelId(e.target.value);
                              if (!newModelName || newModelName === newModelId) {
                                setNewModelName(e.target.value);
                              }
                              if (modelFormError) setModelFormError(null);
                            }}
                            className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                            placeholder={i18nService.t('ollamaModelNamePlaceholder')}
                          />
                          <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                            {i18nService.t('ollamaModelNameHint')}
                          </p>
                        </div>
                        <div>
                          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                            {i18nService.t('ollamaDisplayName')}
                          </label>
                          <input
                            type="text"
                            value={newModelName === newModelId ? '' : newModelName}
                            onChange={(e) => {
                              setNewModelName(e.target.value || newModelId);
                              if (modelFormError) setModelFormError(null);
                            }}
                            className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                            placeholder={i18nService.t('ollamaDisplayNamePlaceholder')}
                          />
                          <p className="mt-1 text-[11px] dark:text-claude-darkTextSecondary/70 text-claude-textSecondary/70">
                            {i18nService.t('ollamaDisplayNameHint')}
                          </p>
                        </div>
                      </>
                    ) : (
                      <>
                        <div>
                          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                            {i18nService.t('modelName')}
                          </label>
                          <input
                            autoFocus
                            type="text"
                            value={newModelName}
                            onChange={(e) => {
                              setNewModelName(e.target.value);
                              if (modelFormError) setModelFormError(null);
                            }}
                            className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                            placeholder="GPT-4"
                          />
                        </div>
                        <div>
                          <label className="block text-xs font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary mb-1">
                            {i18nService.t('modelId')}
                          </label>
                          <input
                            type="text"
                            value={newModelId}
                            onChange={(e) => {
                              setNewModelId(e.target.value);
                              if (modelFormError) setModelFormError(null);
                            }}
                            className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 text-xs"
                            placeholder="gpt-4"
                          />
                        </div>
                      </>
                    )}
                    <div className="flex items-center space-x-2">
                      <input
                        id={`${activeProvider}-supportsImage`}
                        type="checkbox"
                        checked={newModelSupportsImage}
                        onChange={(e) => setNewModelSupportsImage(e.target.checked)}
                        className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface border-claude-border dark:border-claude-darkBorder rounded"
                      />
                      <label
                        htmlFor={`${activeProvider}-supportsImage`}
                        className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary"
                      >
                        {i18nService.t('supportsImageInput')}
                      </label>
                    </div>
                  </div>

                  <div className="flex justify-end space-x-2 mt-4">
                    <button
                      type="button"
                      onClick={handleCancelModelEdit}
                      className="px-3 py-1.5 text-xs dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border"
                    >
                      {i18nService.t('cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={handleSaveNewModel}
                      className="px-3 py-1.5 text-xs text-white bg-claude-accent hover:bg-claude-accentHover rounded-xl active:scale-[0.98]"
                    >
                      {i18nService.t('save')}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Memory Modal */}
            {showMemoryModal && (
              <div
                className="absolute inset-0 z-20 flex items-center justify-center bg-black/35 px-4 rounded-2xl"
                onClick={resetCoworkMemoryEditor}
              >
                <div
                  className="dark:bg-claude-darkSurface bg-claude-surface dark:border-claude-darkBorder border-claude-border border rounded-2xl shadow-xl w-full max-w-md"
                  onClick={(e) => e.stopPropagation()}
                >
                  <div className="px-5 pt-5 pb-4 border-b dark:border-claude-darkBorder border-claude-border">
                    <h3 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                      {coworkMemoryEditingId ? i18nService.t('coworkMemoryCrudUpdate') : i18nService.t('coworkMemoryCrudCreate')}
                    </h3>
                  </div>

                  <div className="px-5 py-4 space-y-4">
                    {coworkMemoryEditingId && (
                      <div className="rounded-lg border px-2 py-1 text-xs dark:border-claude-darkBorder border-claude-border dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        {i18nService.t('coworkMemoryEditingTag')}
                      </div>
                    )}
                    <textarea
                      value={coworkMemoryDraftText}
                      onChange={(event) => setCoworkMemoryDraftText(event.target.value)}
                      placeholder={i18nService.t('coworkMemoryCrudTextPlaceholder')}
                      autoFocus
                      className="min-h-[200px] w-full rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface dark:text-claude-darkText text-claude-text focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30"
                    />
                  </div>

                  <div className="flex justify-end space-x-2 px-5 pb-5">
                    <button
                      type="button"
                      onClick={resetCoworkMemoryEditor}
                      className="px-3 py-1.5 text-sm dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover rounded-xl border dark:border-claude-darkBorder border-claude-border transition-colors"
                    >
                      {i18nService.t('cancel')}
                    </button>
                    <button
                      type="button"
                      onClick={() => { void handleSaveCoworkMemoryEntry(); }}
                      disabled={!coworkMemoryDraftText.trim() || coworkMemoryListLoading}
                      className="px-3 py-1.5 text-sm text-white bg-claude-accent hover:bg-claude-accentHover rounded-xl disabled:opacity-60 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
                    >
                      {coworkMemoryEditingId ? i18nService.t('save') : i18nService.t('coworkMemoryCrudCreate')}
                    </button>
                  </div>
                </div>
              </div>
            )}
          </div>
        </div>
      </SettingsActionsContext.Provider>
    </SettingsStateContext.Provider>
  );
};

export default Settings;
