import React from 'react';
import { i18nService } from '../../services/i18n';

export interface ShortcutsSettingsProps {
  shortcuts: { newChat: string; search: string; settings: string };
  onShortcutChange: (key: string, value: string) => void;
}

const ShortcutsSettings: React.FC<ShortcutsSettingsProps> = ({
  shortcuts,
  onShortcutChange,
}) => {
  return (
    <div className="space-y-5">
      <div>
        <label className="block text-sm font-medium dark:text-claude-darkText text-claude-text mb-3">
          {i18nService.t('keyboardShortcuts')}
        </label>
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('newChat')}</span>
            <input
              type="text"
              value={shortcuts.newChat}
              onChange={(e) => onShortcutChange('newChat', e.target.value)}
              data-shortcut-input="true"
              className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('search')}</span>
            <input
              type="text"
              value={shortcuts.search}
              onChange={(e) => onShortcutChange('search', e.target.value)}
              data-shortcut-input="true"
              className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-sm dark:text-claude-darkText text-claude-text">{i18nService.t('openSettings')}</span>
            <input
              type="text"
              value={shortcuts.settings}
              onChange={(e) => onShortcutChange('settings', e.target.value)}
              data-shortcut-input="true"
              className="w-32 rounded-xl bg-claude-surfaceInset dark:bg-claude-darkSurfaceInset dark:border-claude-darkBorder border-claude-border border focus:border-claude-accent focus:ring-1 focus:ring-claude-accent/30 dark:text-claude-darkText text-claude-text px-3 py-1.5 text-sm"
            />
          </div>
        </div>
      </div>
    </div>
  );
};

export default ShortcutsSettings;
