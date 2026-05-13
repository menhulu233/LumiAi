import React from 'react';
import { i18nService, type LanguageType } from '../../services/i18n';
import { themeService } from '../../services/theme';
import ThemedSelect from '../ui/ThemedSelect';

type ThemeType = 'light' | 'dark' | 'system';

export interface GeneralSettingsProps {
  language: LanguageType;
  autoLaunch: boolean;
  useSystemProxy: boolean;
  isUpdatingAutoLaunch: boolean;
  theme: ThemeType;
  onLanguageChange: (lang: LanguageType) => void;
  onAutoLaunchChange: (enabled: boolean) => void;
  onUseSystemProxyChange: (enabled: boolean) => void;
  onThemeChange: (theme: ThemeType) => void;
}

const GeneralSettings: React.FC<GeneralSettingsProps> = ({
  language,
  autoLaunch,
  useSystemProxy,
  isUpdatingAutoLaunch,
  theme,
  onLanguageChange,
  onAutoLaunchChange,
  onUseSystemProxyChange,
  onThemeChange,
}) => {
  return (
    <div className="space-y-8">
      {/* Language Section */}
      <div className="flex items-center justify-between">
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('language')}
        </h4>
        <div className="w-[140px] shrink-0">
          <ThemedSelect
            id="language"
            value={language}
            onChange={(value) => {
              const nextLanguage = value as LanguageType;
              onLanguageChange(nextLanguage);
              i18nService.setLanguage(nextLanguage, { persist: false });
            }}
            options={[
              { value: 'zh', label: i18nService.t('chinese') },
              { value: 'en', label: i18nService.t('english') }
            ]}
          />
        </div>
      </div>

      {/* Auto-launch Section */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
          {i18nService.t('autoLaunch')}
        </h4>
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
            {i18nService.t('autoLaunchDescription')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={autoLaunch}
            onClick={async () => {
              if (isUpdatingAutoLaunch) return;
              const next = !autoLaunch;
              try {
                const result = await window.electron.autoLaunch.set(next);
                if (result.success) {
                  onAutoLaunchChange(next);
                } else {
                  console.error('Failed to update auto-launch setting:', result.error);
                }
              } catch (err) {
                console.error('Failed to set auto-launch:', err);
              }
            }}
            disabled={isUpdatingAutoLaunch}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
              isUpdatingAutoLaunch ? 'opacity-50 cursor-not-allowed' : ''
            } ${
              autoLaunch
                ? 'bg-claude-accent'
                : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                autoLaunch ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>
      </div>

      {/* System proxy Section */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
          {i18nService.t('useSystemProxy')}
        </h4>
        <label className="flex items-center justify-between cursor-pointer">
          <span className="text-sm dark:text-claude-darkSecondaryText text-claude-secondaryText">
            {i18nService.t('useSystemProxyDescription')}
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={useSystemProxy}
            onClick={() => {
              onUseSystemProxyChange(!useSystemProxy);
            }}
            className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
              useSystemProxy
                ? 'bg-claude-accent'
                : 'bg-gray-300 dark:bg-gray-600'
            }`}
          >
            <span
              className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                useSystemProxy ? 'translate-x-6' : 'translate-x-1'
              }`}
            />
          </button>
        </label>
      </div>

      {/* Appearance Section */}
      <div>
        <h4 className="text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
          {i18nService.t('appearance')}
        </h4>
        <div className="grid grid-cols-3 gap-4">
          {([
            { value: 'light' as const, label: i18nService.t('light') },
            { value: 'dark' as const, label: i18nService.t('dark') },
            { value: 'system' as const, label: i18nService.t('system') },
          ]).map((option) => {
            const isSelected = theme === option.value;
            return (
              <button
                key={option.value}
                type="button"
                onClick={() => {
                  onThemeChange(option.value);
                  themeService.setTheme(option.value);
                }}
                className={`flex flex-col items-center rounded-xl border-2 p-3 transition-colors cursor-pointer ${
                  isSelected
                    ? 'border-claude-accent bg-claude-accent/5 dark:bg-claude-accent/10'
                    : 'dark:border-claude-darkBorder border-claude-border hover:border-claude-accent/50 dark:hover:border-claude-accent/50'
                }`}
              >
                <svg viewBox="0 0 120 80" className="w-full h-auto rounded-md mb-2 overflow-hidden" xmlns="http://www.w3.org/2000/svg">
                  {option.value === 'light' && (
                    <>
                      <rect width="120" height="80" fill="#F8F9FB" />
                      <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                      <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                      <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                      <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                      <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                      <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                      <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#E2E4E7" />
                    </>
                  )}
                  {option.value === 'dark' && (
                    <>
                      <rect width="120" height="80" fill="#0F1117" />
                      <rect x="0" y="0" width="30" height="80" fill="#151820" />
                      <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                      <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                      <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                      <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                      <rect x="42" y="60" width="58" height="3" rx="1.5" fill="#252930" />
                    </>
                  )}
                  {option.value === 'system' && (
                    <>
                      <defs>
                        <clipPath id="left-half">
                          <rect x="0" y="0" width="60" height="80" />
                        </clipPath>
                        <clipPath id="right-half">
                          <rect x="60" y="0" width="60" height="80" />
                        </clipPath>
                      </defs>
                      {/* Light half */}
                      <g clipPath="url(#left-half)">
                        <rect width="120" height="80" fill="#F8F9FB" />
                        <rect x="0" y="0" width="30" height="80" fill="#EBEDF0" />
                        <rect x="4" y="8" width="22" height="4" rx="2" fill="#C8CBD0" />
                        <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#D5D7DB" />
                        <rect x="36" y="8" width="78" height="64" rx="4" fill="#FFFFFF" />
                        <rect x="42" y="16" width="50" height="4" rx="2" fill="#D5D7DB" />
                        <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#E2E4E7" />
                        <rect x="42" y="46" width="40" height="4" rx="2" fill="#D5D7DB" />
                        <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#E2E4E7" />
                      </g>
                      {/* Dark half */}
                      <g clipPath="url(#right-half)">
                        <rect width="120" height="80" fill="#0F1117" />
                        <rect x="0" y="0" width="30" height="80" fill="#151820" />
                        <rect x="4" y="8" width="22" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="4" y="16" width="18" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="4" y="22" width="20" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="4" y="28" width="16" height="3" rx="1.5" fill="#2A2F3A" />
                        <rect x="36" y="8" width="78" height="64" rx="4" fill="#1A1D27" />
                        <rect x="42" y="16" width="50" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="42" y="24" width="66" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="30" width="60" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="36" width="55" height="3" rx="1.5" fill="#252930" />
                        <rect x="42" y="46" width="40" height="4" rx="2" fill="#3A3F4B" />
                        <rect x="42" y="54" width="66" height="3" rx="1.5" fill="#252930" />
                      </g>
                      {/* Divider line */}
                      <line x1="60" y1="0" x2="60" y2="80" stroke="#888" strokeWidth="0.5" />
                    </>
                  )}
                </svg>
                <span className={`text-xs font-medium ${
                  isSelected
                    ? 'text-claude-accent'
                    : 'dark:text-claude-darkText text-claude-text'
                }`}>
                  {option.label}
                </span>
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
};

export default GeneralSettings;
