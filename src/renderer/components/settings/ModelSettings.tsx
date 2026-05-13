import React from 'react';
import { i18nService } from '../../services/i18n';
import { ProviderType, providerRequiresApiKey } from '../../config/providerMeta';
import {
  getEffectiveApiFormat,
  shouldShowApiFormatSelector,
  getCodingPlanUrl,
  isBaseUrlLockedByCodingPlan,
  getProviderDefaultBaseUrl,
} from '../../utils/providerUtils';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';
import { XCircleIcon as XCircleIconSolid } from '@heroicons/react/20/solid';
import { SignalIcon } from '@heroicons/react/24/outline';
import PlusCircleIcon from '../icons/PlusCircleIcon';
import TrashIcon from '../icons/TrashIcon';
import PencilIcon from '../icons/PencilIcon';
import type { AppConfig } from '../../config';

type ProvidersConfig = NonNullable<AppConfig['providers']>;
type ProviderConfig = ProvidersConfig[string];

export interface ModelSettingsProps {
  providers: ProvidersConfig;
  activeProvider: ProviderType;
  showApiKey: boolean;
  isTesting: boolean;
  isImportingProviders: boolean;
  isExportingProviders: boolean;
  visibleProviders: Partial<ProvidersConfig>;
  providerMeta: Record<ProviderType, { label: string; icon: React.ReactNode }>;
  onProviderChange: (provider: ProviderType) => void;
  onProviderConfigChange: (provider: ProviderType, key: string, value: unknown) => void;
  onToggleProviderEnabled: (provider: ProviderType) => void;
  onTestConnection: () => Promise<void>;
  onImportProviders: (event: React.ChangeEvent<HTMLInputElement>) => void;
  onExportProviders: () => Promise<void>;
  onShowApiKeyToggle: () => void;
  onImportProvidersClick: () => void;
  // Model CRUD
  onAddModel: () => void;
  onEditModel: (id: string, name: string, supportsImage: boolean) => void;
  onDeleteModel: (id: string) => void;
  importInputRef: React.LegacyRef<HTMLInputElement>;
}

const ModelSettings: React.FC<ModelSettingsProps> = ({
  providers,
  activeProvider,
  showApiKey,
  isTesting,
  isImportingProviders,
  isExportingProviders,
  visibleProviders,
  providerMeta,
  onProviderChange,
  onProviderConfigChange,
  onToggleProviderEnabled,
  onTestConnection,
  onImportProviders,
  onExportProviders,
  onShowApiKeyToggle,
  onImportProvidersClick,
  onAddModel,
  onEditModel,
  onDeleteModel,
  importInputRef,
}) => {
  const activeProviderConfig = providers[activeProvider] as ProviderConfig & { codingPlanEnabled?: boolean };
  const codingPlanUrl = getCodingPlanUrl(
    activeProvider,
    getEffectiveApiFormat(activeProvider, activeProviderConfig.apiFormat),
    activeProviderConfig.codingPlanEnabled ?? false
  );
  const isBaseUrlLocked = isBaseUrlLockedByCodingPlan(
    activeProvider,
    activeProviderConfig.codingPlanEnabled ?? false
  );

  return (
    <div className="flex h-full">
      {/* Provider List - Left Side */}
      <div className="w-2/5 border-r dark:border-claude-darkBorder border-claude-border pr-3 space-y-1.5 overflow-y-auto">
        <div className="flex items-center justify-between mb-2 px-1">
          <h3 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
            {i18nService.t('modelProviders')}
          </h3>
          <div className="flex items-center space-x-1">
            <button
              type="button"
              onClick={onImportProvidersClick}
              disabled={isImportingProviders || isExportingProviders}
              className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
            >
              {i18nService.t('import')}
            </button>
            <button
              type="button"
              onClick={onExportProviders}
              disabled={isImportingProviders || isExportingProviders}
              className="inline-flex items-center px-2 py-1 text-[11px] font-medium rounded-lg border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
            >
              {i18nService.t('export')}
            </button>
          </div>
        </div>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json"
          className="hidden"
          onChange={onImportProviders}
        />
        {Object.entries(visibleProviders).map(([provider, config]) => {
          const providerKey = provider as ProviderType;
          const providerInfo = providerMeta[providerKey];
          const typedConfig = config as ProviderConfig;
          const missingApiKey = providerRequiresApiKey(providerKey) && !typedConfig.apiKey.trim();
          const canToggleProvider = typedConfig.enabled || !missingApiKey;
          return (
            <div
              key={provider}
              onClick={() => onProviderChange(providerKey)}
              className={`flex items-center p-2 rounded-xl cursor-pointer transition-colors ${
                activeProvider === provider
                  ? 'bg-claude-accent/10 dark:bg-claude-accent/20 border border-claude-accent/30 shadow-subtle'
                  : 'dark:bg-claude-darkSurface/50 bg-claude-surface hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover border border-transparent'
              }`}
            >
              <div className="flex flex-1 items-center">
                <div className="mr-2 flex h-7 w-7 items-center justify-center">
                  <span className="dark:text-claude-darkText text-claude-text">
                    {providerInfo?.icon}
                  </span>
                </div>
                <span className={`text-sm font-medium truncate ${
                  activeProvider === provider
                    ? 'text-claude-accent'
                    : 'dark:text-claude-darkText text-claude-text'
                }`}>
                  {providerInfo?.label ?? provider.charAt(0).toUpperCase() + provider.slice(1)}
                </span>
              </div>
              <div className="flex items-center ml-2">
                <div
                  title={!canToggleProvider ? i18nService.t('configureApiKey') : undefined}
                  className={`w-7 h-4 rounded-full flex items-center transition-colors ${
                    typedConfig.enabled ? 'bg-claude-accent' : 'dark:bg-claude-darkBorder bg-claude-border'
                  } ${
                    canToggleProvider ? 'cursor-pointer' : 'cursor-not-allowed opacity-50'
                  }`}
                  onClick={(e) => {
                    e.stopPropagation();
                    if (!canToggleProvider) {
                      return;
                    }
                    onToggleProviderEnabled(providerKey);
                  }}
                >
                  <div
                    className={`w-3 h-3 rounded-full bg-white shadow-md transform transition-transform ${
                      typedConfig.enabled ? 'translate-x-3.5' : 'translate-x-0.5'
                    }`}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* Provider Settings - Right Side */}
      <div className="w-3/5 pl-4 pr-2 space-y-4 overflow-y-auto [scrollbar-gutter:stable]">
        <div className="flex items-center justify-between pb-2 border-b dark:border-claude-darkBorder border-claude-border">
          <h3 className="text-base font-medium dark:text-claude-darkText text-claude-text">
            {(providerMeta[activeProvider]?.label ?? activeProvider.charAt(0).toUpperCase() + activeProvider.slice(1))} {i18nService.t('providerSettings')}
          </h3>
          <div
            className={`px-2 py-0.5 rounded-lg text-xs font-medium ${
              providers[activeProvider].enabled
                ? 'bg-green-500/20 text-green-600 dark:text-green-400'
                : 'bg-red-500/20 text-red-600 dark:text-red-400'
            }`}
          >
            {providers[activeProvider].enabled ? i18nService.t('providerStatusOn') : i18nService.t('providerStatusOff')}
          </div>
        </div>

        {providerRequiresApiKey(activeProvider) && (
          <div>
            <label htmlFor={`${activeProvider}-apiKey`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
              {i18nService.t('apiKey')}
            </label>
            <div className="relative">
              <input
                type={showApiKey ? 'text' : 'password'}
                id={`${activeProvider}-apiKey`}
                value={providers[activeProvider].apiKey}
                onChange={(e) => onProviderConfigChange(activeProvider, 'apiKey', e.target.value)}
                className="block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-16 text-xs"
                placeholder={i18nService.t('apiKeyPlaceholder')}
              />
              <div className="absolute right-2 inset-y-0 flex items-center gap-1">
                {providers[activeProvider].apiKey && (
                  <button
                    type="button"
                    onClick={() => onProviderConfigChange(activeProvider, 'apiKey', '')}
                    className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                    title={i18nService.t('clear') || 'Clear'}
                  >
                    <XCircleIconSolid className="h-4 w-4" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={onShowApiKeyToggle}
                  className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                  title={showApiKey ? (i18nService.t('hide') || 'Hide') : (i18nService.t('show') || 'Show')}
                >
                  {showApiKey ? <EyeIcon className="h-4 w-4" /> : <EyeSlashIcon className="h-4 w-4" />}
                </button>
              </div>
            </div>
          </div>
        )}

        <div>
          <label htmlFor={`${activeProvider}-baseUrl`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
            {i18nService.t('baseUrl')}
          </label>
          <div className="relative">
            <input
              type="text"
              id={`${activeProvider}-baseUrl`}
              value={
                isBaseUrlLocked && codingPlanUrl
                  ? codingPlanUrl
                  : providers[activeProvider].baseUrl
              }
              onChange={(e) => onProviderConfigChange(activeProvider, 'baseUrl', e.target.value)}
              disabled={isBaseUrlLocked}
              className={`block w-full rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-2 pr-8 text-xs ${isBaseUrlLocked ? 'opacity-50 cursor-not-allowed' : ''}`}
              placeholder={getProviderDefaultBaseUrl(activeProvider, getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat)) || providers[activeProvider]?.baseUrl || i18nService.t('baseUrlPlaceholder')}
            />
            {providers[activeProvider].baseUrl && !isBaseUrlLocked && (
              <div className="absolute right-2 inset-y-0 flex items-center">
                <button
                  type="button"
                  onClick={() => onProviderConfigChange(activeProvider, 'baseUrl', '')}
                  className="p-0.5 rounded text-claude-textSecondary dark:text-claude-darkTextSecondary hover:text-claude-accent transition-colors"
                  title={i18nService.t('clear') || 'Clear'}
                >
                  <XCircleIconSolid className="h-4 w-4" />
                </button>
              </div>
            )}
          </div>
          {activeProvider === 'custom' && (
            <div className="mt-1.5 space-y-0.5 text-[11px] text-claude-secondaryText dark:text-claude-darkSecondaryText">
              <p>
                <span className="text-sm text-claude-accent/50 mr-1">•</span>
                {i18nService.t('baseUrlHint1')}
                <code className="ml-1 text-claude-accent/80 dark:text-claude-accent/70 break-all">{i18nService.t('baseUrlHintExample1')}</code>
              </p>
              <p>
                <span className="text-sm text-claude-accent/50 mr-1">•</span>
                {i18nService.t('baseUrlHint2')}
                <code className="ml-1 text-claude-accent/80 dark:text-claude-accent/70 break-all">{i18nService.t('baseUrlHintExample2')}</code>
              </p>
            </div>
          )}
          {/* GLM Coding Plan 提示 */}
          {activeProvider === 'zhipu' && providers.zhipu.codingPlanEnabled && (
            <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
              <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                <span className="font-medium">GLM Coding Plan:</span> {i18nService.t('zhipuCodingPlanEndpointHint')}
              </p>
            </div>
          )}
          {/* Qwen Coding Plan 提示 */}
          {activeProvider === 'qwen' && providers.qwen.codingPlanEnabled && (
            <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
              <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                <span className="font-medium">Coding Plan:</span> {i18nService.t('qwenCodingPlanEndpointHint')}
              </p>
            </div>
          )}
          {/* Volcengine Coding Plan 提示 */}
          {activeProvider === 'volcengine' && providers.volcengine.codingPlanEnabled && (
            <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
              <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                <span className="font-medium">Coding Plan:</span> {i18nService.t('volcengineCodingPlanEndpointHint')}
              </p>
            </div>
          )}
          {/* Moonshot Coding Plan 提示 */}
          {activeProvider === 'moonshot' && providers.moonshot.codingPlanEnabled && (
            <div className="mt-1.5 p-2 rounded-lg bg-claude-accent/10 border border-claude-accent/20">
              <p className="text-[11px] text-claude-accent dark:text-claude-accent">
                <span className="font-medium">Coding Plan:</span> {i18nService.t('moonshotCodingPlanEndpointHint')}
              </p>
            </div>
          )}
        </div>

        {/* API 格式选择器 */}
        {shouldShowApiFormatSelector(activeProvider) && (
          <div>
            <label htmlFor={`${activeProvider}-apiFormat`} className="block text-xs font-medium dark:text-claude-darkText text-claude-text mb-1">
              {i18nService.t('apiFormat')}
            </label>
            <div className="flex items-center space-x-4">
              <label className="flex items-center">
                <input
                  type="radio"
                  name={`${activeProvider}-apiFormat`}
                  value="anthropic"
                  checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) !== 'openai'}
                  onChange={() => onProviderConfigChange(activeProvider, 'apiFormat', 'anthropic')}
                  className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                />
                <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                  {i18nService.t('apiFormatNative')}
                </span>
              </label>
              <label className="flex items-center">
                <input
                  type="radio"
                  name={`${activeProvider}-apiFormat`}
                  value="openai"
                  checked={getEffectiveApiFormat(activeProvider, providers[activeProvider].apiFormat) === 'openai'}
                  onChange={() => onProviderConfigChange(activeProvider, 'apiFormat', 'openai')}
                  className="h-3.5 w-3.5 text-claude-accent focus:ring-claude-accent dark:bg-claude-darkSurface bg-claude-surface"
                />
                <span className="ml-2 text-xs dark:text-claude-darkText text-claude-text">
                  {i18nService.t('apiFormatOpenAI')}
                </span>
              </label>
            </div>
            <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('apiFormatHint')}
            </p>
          </div>
        )}

        {/* GLM Coding Plan 开关 (仅 Zhipu) */}
        {activeProvider === 'zhipu' && (
          <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                  GLM Coding Plan
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                  Beta
                </span>
              </div>
              <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('zhipuCodingPlanHint')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer ml-3">
              <input
                type="checkbox"
                checked={providers.zhipu.codingPlanEnabled ?? false}
                onChange={(e) => onProviderConfigChange('zhipu', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
            </label>
          </div>
        )}

        {/* Qwen Coding Plan 开关 (仅 Qwen) */}
        {activeProvider === 'qwen' && (
          <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                  Coding Plan
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                  订阅套餐
                </span>
              </div>
              <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('qwenCodingPlanHint')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer ml-3">
              <input
                type="checkbox"
                checked={providers.qwen.codingPlanEnabled ?? false}
                onChange={(e) => onProviderConfigChange('qwen', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
            </label>
          </div>
        )}

        {/* Volcengine Coding Plan 开关 (仅 Volcengine) */}
        {activeProvider === 'volcengine' && (
          <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                  Coding Plan
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                  Beta
                </span>
              </div>
              <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('volcengineCodingPlanHint')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer ml-3">
              <input
                type="checkbox"
                checked={providers.volcengine.codingPlanEnabled ?? false}
                onChange={(e) => onProviderConfigChange('volcengine', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
            </label>
          </div>
        )}

        {/* Moonshot Coding Plan 开关 (仅 Moonshot) */}
        {activeProvider === 'moonshot' && (
          <div className="flex items-center justify-between p-3 rounded-xl dark:bg-claude-darkSurface/50 bg-claude-surface/50 border dark:border-claude-darkBorder border-claude-border">
            <div className="flex-1">
              <div className="flex items-center space-x-2">
                <span className="text-xs font-medium dark:text-claude-darkText text-claude-text">
                  Coding Plan
                </span>
                <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                  Beta
                </span>
              </div>
              <p className="mt-0.5 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('moonshotCodingPlanHint')}
              </p>
            </div>
            <label className="relative inline-flex items-center cursor-pointer ml-3">
              <input
                type="checkbox"
                checked={providers.moonshot.codingPlanEnabled ?? false}
                onChange={(e) => onProviderConfigChange('moonshot', 'codingPlanEnabled', e.target.checked ? 'true' : 'false')}
                className="sr-only peer"
              />
              <div className="w-9 h-5 bg-gray-200 peer-focus:outline-none peer-focus:ring-2 peer-focus:ring-claude-accent/50 rounded-full peer dark:bg-gray-700 peer-checked:after:translate-x-full peer-checked:after:border-white after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:border-gray-300 after:border after:rounded-full after:h-4 after:w-4 after:transition-all dark:border-gray-600 peer-checked:bg-claude-accent"></div>
            </label>
          </div>
        )}

        {/* 测试连接按钮 */}
        <div className="flex items-center space-x-3">
          <button
            type="button"
            onClick={onTestConnection}
            disabled={isTesting || (providerRequiresApiKey(activeProvider) && !providers[activeProvider].apiKey)}
            className="inline-flex items-center px-3 py-1.5 text-xs font-medium rounded-xl border dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover disabled:opacity-50 disabled:cursor-not-allowed transition-colors active:scale-[0.98]"
          >
            <SignalIcon className="h-3.5 w-3.5 mr-1.5" />
            {isTesting ? i18nService.t('testing') : i18nService.t('testConnection')}
          </button>
        </div>

        <div>
          <div className="flex items-center justify-between mb-1.5">
            <h3 className="text-xs font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('availableModels')}
            </h3>
            <button
              type="button"
              onClick={onAddModel}
              className="inline-flex items-center text-xs text-claude-accent hover:text-claude-accentHover"
            >
              <PlusCircleIcon className="h-3.5 w-3.5 mr-1" />
              {i18nService.t('addModel')}
            </button>
          </div>

          {/* Models List */}
          <div className="space-y-1.5 max-h-60 overflow-y-auto">
            {providers[activeProvider].models?.map(model => (
              <div
                key={model.id}
                className="dark:bg-claude-darkSurface/50 bg-claude-surface/50 p-2 rounded-xl dark:border-claude-darkBorder border-claude-border border transition-colors hover:border-claude-accent group"
              >
                <div className="flex items-center justify-between">
                  <div className="flex items-center space-x-1.5">
                    <div className="w-1.5 h-1.5 rounded-full bg-green-400"></div>
                    <span className="dark:text-claude-darkText text-claude-text font-medium text-[11px]">{model.name}</span>
                  </div>
                  <div className="flex items-center space-x-1">
                    <span className="text-[10px] px-1.5 py-0.5 bg-claude-surfaceHover dark:bg-claude-darkSurfaceHover rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary">{model.id}</span>
                    {model.supportsImage && (
                      <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-claude-accent/10 text-claude-accent">
                        {i18nService.t('imageInput')}
                      </span>
                    )}
                    <button
                      type="button"
                      onClick={() => onEditModel(model.id, model.name, model.supportsImage ?? false)}
                      className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <PencilIcon className="h-3.5 w-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => onDeleteModel(model.id)}
                      className="p-0.5 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-red-500 opacity-0 group-hover:opacity-100 transition-opacity"
                    >
                      <TrashIcon className="h-3.5 w-3.5" />
                    </button>
                  </div>
                </div>
              </div>
            ))}

            {(!providers[activeProvider].models || providers[activeProvider].models.length === 0) && (
              <div className="dark:bg-claude-darkSurface/20 bg-claude-surface/20 p-2.5 rounded-xl border dark:border-claude-darkBorder/50 border-claude-border/50 text-center">
                <p className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">{i18nService.t('noModelsAvailable')}</p>
                <button
                  type="button"
                  onClick={onAddModel}
                  className="mt-1.5 inline-flex items-center text-[11px] font-medium text-claude-accent hover:text-claude-accentHover"
                >
                  <PlusCircleIcon className="h-3 w-3 mr-1" />
                  {i18nService.t('addFirstModel')}
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default ModelSettings;
