import React, { useCallback } from 'react';
import { i18nService, type LanguageType } from '../../services/i18n';
import { copyTextToClipboard } from '../../utils/providerUtils';

export interface AboutSettingsProps {
  appVersion: string;
  updateCheckStatus: 'idle' | 'checking' | 'upToDate' | 'error';
  emailCopied: boolean;
  isExportingLogs: boolean;
  testMode: boolean;
  testModeUnlocked: boolean;
  logoClickCount: number;
  language: LanguageType;
  onLogoClick: (count: number) => void;
  onCheckUpdate: () => void;
  onOpenUserManual: () => void;
  onOpenServiceTerms: () => void;
  onExportLogs: () => void;
  onSetTestMode: (value: boolean) => void;
  onSetTestModeUnlocked: (value: boolean) => void;
  onSetEmailCopied: (value: boolean) => void;
}

const ABOUT_CONTACT_EMAIL = 'lumiai.project@rd.netease.com';
const ABOUT_USER_MANUAL_URL = 'https://lumiai.youdao.com/#/docs/lumiai_user_manual';

const AboutSettings: React.FC<AboutSettingsProps> = ({
  appVersion,
  updateCheckStatus,
  emailCopied,
  isExportingLogs,
  testMode,
  testModeUnlocked,
  logoClickCount,
  language,
  onLogoClick,
  onCheckUpdate,
  onOpenUserManual,
  onOpenServiceTerms,
  onExportLogs,
  onSetTestMode,
  onSetTestModeUnlocked,
  onSetEmailCopied,
}) => {
  const handleCopyContactEmail = useCallback(async () => {
    const copied = await copyTextToClipboard(ABOUT_CONTACT_EMAIL);
    if (copied) {
      onSetEmailCopied(true);
    }
  }, [onSetEmailCopied]);

  return (
    <div className="flex min-h-full flex-col items-center pt-6 pb-3">
      {/* Logo & App Name */}
      <img
        src="logo.png"
        alt="LumiAi"
        className="w-16 h-16 mb-3 cursor-pointer select-none"
        onClick={() => {
          const next = logoClickCount + 1;
          onLogoClick(next);
          if (next >= 10 && !testModeUnlocked) {
            onSetTestModeUnlocked(true);
          }
        }}
      />
      <h3 className="text-lg font-semibold dark:text-claude-darkText text-claude-text">LumiAi</h3>
      <span className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary mt-1">v{appVersion}</span>

      {/* Info Card */}
      <div className="w-full mt-8 rounded-xl overflow-hidden">
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('aboutVersion')}</span>
          <div className="flex items-center gap-2">
            <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">{appVersion}</span>
            <button
              type="button"
              disabled={updateCheckStatus === 'checking'}
              onClick={(e) => {
                e.stopPropagation();
                onCheckUpdate();
              }}
              className="text-xs px-2 py-0.5 rounded-md dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {updateCheckStatus === 'checking' && i18nService.t('updateChecking')}
              {updateCheckStatus === 'upToDate' && i18nService.t('updateUpToDate')}
              {updateCheckStatus === 'error' && i18nService.t('updateCheckFailed')}
              {updateCheckStatus === 'idle' && i18nService.t('checkForUpdate')}
            </button>
          </div>
        </div>
        <div className="flex items-center justify-between px-4 py-3">
          <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('aboutContactEmail')}</span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                void handleCopyContactEmail();
              }}
              title={i18nService.t('copyToClipboard')}
              className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary bg-transparent border-none appearance-none p-0 m-0 cursor-pointer focus:outline-none"
            >
              {ABOUT_CONTACT_EMAIL}
            </button>
            {emailCopied && (
              <span className="text-[11px] leading-4 text-emerald-600 dark:text-emerald-400">
                {language === 'zh' ? '已复制' : 'Copied'}
              </span>
            )}
          </div>
        </div>
        <div className={`flex items-center justify-between px-4 py-3${testModeUnlocked ? '' : ''}`}>
          <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('aboutUserManual')}</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenUserManual();
            }}
            className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer focus:outline-none dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {ABOUT_USER_MANUAL_URL}
          </button>
        </div>
        {testModeUnlocked && (
          <div className="flex items-center justify-between px-4 py-3">
            <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('testMode')}</span>
            <button
              type="button"
              role="switch"
              aria-checked={testMode}
              onClick={() => onSetTestMode(!testMode)}
              className={`relative inline-flex h-6 w-11 flex-shrink-0 items-center rounded-full transition-colors ${
                testMode ? 'bg-claude-accent' : 'bg-gray-300 dark:bg-gray-600'
              }`}
            >
              <span
                className={`inline-block h-4 w-4 transform rounded-full bg-white transition-transform ${
                  testMode ? 'translate-x-6' : 'translate-x-1'
                }`}
              />
            </button>
          </div>
        )}
      </div>

      {/* Footer */}
      <div className="mt-auto w-full pt-14 pb-2 flex flex-col items-center">
        <div className="flex items-center justify-center text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onOpenServiceTerms();
            }}
            className="bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer hover:text-claude-accent dark:hover:text-claude-accent transition-colors"
          >
            {i18nService.t('aboutServiceTerms')}
          </button>
          <span className="mx-3 text-xs opacity-40">|</span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onExportLogs();
            }}
            disabled={isExportingLogs}
            className="bg-transparent border-none appearance-none px-1.5 py-0.5 -mx-1.5 -my-0.5 rounded-md cursor-pointer hover:text-claude-accent dark:hover:text-claude-accent transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {isExportingLogs ? i18nService.t('aboutExportingLogs') : i18nService.t('aboutExportLogs')}
          </button>
        </div>

        <p className="mt-5 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {language === 'zh' ? 'LumiAi 版权所有' : 'LumiAi. All rights reserved.'}
        </p>
        <p className="mt-1 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          Copyright &copy; {new Date().getFullYear()} LumiAi. All Rights Reserved.
        </p>
      </div>
    </div>
  );
};

export default AboutSettings;
