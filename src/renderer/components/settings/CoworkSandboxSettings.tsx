import type {
  CoworkExecutionMode,
  CoworkSandboxProgress,
  CoworkSandboxStatus,
} from '../../types/cowork';
import { i18nService } from '../../services/i18n';

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

export function CoworkSandboxSettings({
  coworkExecutionMode,
  coworkSandboxStatus,
  coworkSandboxProgress,
  coworkSandboxDisabled,
  coworkSandboxInstalling,
  coworkSandboxLoading,
  coworkSandboxStatusHint,
  coworkSandboxPercent,
  coworkSandboxStageLabel,
  onExecutionModeChange,
  onInstallSandbox,
}: CoworkSandboxSettingsProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-3">
        <label className="block text-sm font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('coworkExecutionMode')}
        </label>
        <div className="space-y-2">
          {([
            {
              value: 'auto',
              label: i18nService.t('coworkExecutionModeAuto'),
              hint: i18nService.t('coworkExecutionModeAutoHint'),
            },
            {
              value: 'local',
              label: i18nService.t('coworkExecutionModeLocal'),
              hint: i18nService.t('coworkExecutionModeLocalHint'),
            },
            {
              value: 'sandbox',
              label: i18nService.t('coworkExecutionModeSandbox'),
              hint: i18nService.t('coworkExecutionModeSandboxHint'),
            },
          ] as Array<{ value: CoworkExecutionMode; label: string; hint: string }>).map((option) => {
            const isDisabled = option.value === 'sandbox' && coworkSandboxDisabled;
            return (
              <label
                key={option.value}
                className={`flex items-start gap-3 rounded-xl border px-3 py-2 text-sm transition-colors ${
                  isDisabled
                    ? 'cursor-not-allowed opacity-60 dark:border-claude-darkBorder border-claude-border'
                    : 'cursor-pointer dark:border-claude-darkBorder border-claude-border hover:border-claude-accent'
                }`}
              >
                <input
                  type="radio"
                  name="cowork-execution-mode"
                  value={option.value}
                  checked={coworkExecutionMode === option.value}
                  onChange={() => onExecutionModeChange(option.value)}
                  disabled={isDisabled}
                  className="mt-1"
                />
                <span>
                  <span className="block font-medium dark:text-claude-darkText text-claude-text">
                    {option.label}
                  </span>
                  <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
                    {option.hint}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {coworkSandboxStatusHint && (
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {coworkSandboxStatusHint}
          </div>
        )}

        {coworkSandboxProgress && (
          <div className="space-y-2">
            <div className="flex items-center justify-between text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              <span>
                {coworkSandboxStageLabel}
              </span>
              {coworkSandboxPercent !== null && (
                <span>{coworkSandboxPercent}%</span>
              )}
            </div>
            <div className="h-2 rounded-full dark:bg-claude-darkBorder bg-claude-border overflow-hidden">
              <div
                className="h-full bg-claude-accent transition-all"
                style={{ width: `${coworkSandboxPercent ?? 0}%` }}
              />
            </div>
          </div>
        )}

        {coworkSandboxDisabled && coworkSandboxStatus?.supported && (
          <button
            type="button"
            onClick={onInstallSandbox}
            disabled={coworkSandboxInstalling || coworkSandboxLoading}
            className="inline-flex items-center justify-center px-4 py-2 rounded-xl bg-claude-accent hover:bg-claude-accentHover text-white text-sm font-medium transition-colors disabled:opacity-50 active:scale-[0.98]"
          >
            {coworkSandboxInstalling ? i18nService.t('coworkSandboxInstalling') : i18nService.t('coworkSandboxInstall')}
          </button>
        )}

        {coworkSandboxDisabled && !coworkSandboxStatus?.supported && (
          <div className="text-xs text-blue-500 dark:text-blue-400">
            {i18nService.t('coworkSandboxSelectionBlocked')}
          </div>
        )}
      </div>
    </div>
  );
}
