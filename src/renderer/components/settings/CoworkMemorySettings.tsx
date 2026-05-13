import type {
  CoworkUserMemoryEntry,
  CoworkMemoryStats,
} from '../../types/cowork';
import { i18nService } from '../../services/i18n';
import PlusCircleIcon from '../icons/PlusCircleIcon';

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

function getMemoryStatusLabel(status: CoworkUserMemoryEntry['status']): string {
  if (status === 'created') return i18nService.t('coworkMemoryStatusActive');
  if (status === 'stale') return i18nService.t('coworkMemoryStatusInactive');
  return i18nService.t('coworkMemoryStatusDeleted');
}

function formatMemoryUpdatedAt(timestamp: number): string {
  if (!Number.isFinite(timestamp) || timestamp <= 0) return '-';
  try {
    return new Date(timestamp).toLocaleString();
  } catch {
    return '-';
  }
}

export function CoworkMemorySettings({
  coworkMemoryEnabled,
  coworkMemoryLlmJudgeEnabled,
  coworkMemoryEntries,
  coworkMemoryStats,
  coworkMemoryQuery,
  coworkMemoryListLoading,
  onEnabledChange,
  onLlmJudgeEnabledChange,
  onQueryChange,
  onOpenModal,
  onEditEntry,
  onDeleteEntry,
}: CoworkMemorySettingsProps) {
  return (
    <div className="space-y-6">
      <div className="space-y-3 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
        <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
          {i18nService.t('coworkMemoryTitle')}
        </div>
        <label className="flex items-start gap-3 cursor-pointer">
          <input
            type="checkbox"
            checked={coworkMemoryEnabled}
            onChange={(event) => onEnabledChange(event.target.checked)}
            className="mt-1"
          />
          <span>
            <span className="block text-sm dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkMemoryEnabled')}
            </span>
            <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkMemoryEnabledHint')}
            </span>
            <span className="mt-1 block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkMemorySimpleHint')}
            </span>
          </span>
        </label>
        <label className={`flex items-start gap-3 ${coworkMemoryEnabled ? 'cursor-pointer' : 'cursor-not-allowed opacity-60'}`}>
          <input
            type="checkbox"
            checked={coworkMemoryLlmJudgeEnabled}
            onChange={(event) => onLlmJudgeEnabledChange(event.target.checked)}
            disabled={!coworkMemoryEnabled}
            className="mt-1"
          />
          <span>
            <span className="block text-sm dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkMemoryLlmJudgeEnabled')}
            </span>
            <span className="block text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkMemoryLlmJudgeEnabledHint')}
            </span>
          </span>
        </label>
      </div>

      <div className="space-y-4 rounded-xl border px-4 py-4 dark:border-claude-darkBorder border-claude-border">
        <div className="flex items-center justify-between">
          <div className="space-y-1">
            <div className="text-sm font-medium dark:text-claude-darkText text-claude-text">
              {i18nService.t('coworkMemoryCrudTitle')}
            </div>
            <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkMemoryManageHint')}
            </div>
          </div>
          <button
            type="button"
            onClick={onOpenModal}
            className="inline-flex items-center justify-center px-3 py-1.5 rounded-lg bg-claude-accent hover:bg-claude-accentHover text-white text-sm transition-colors active:scale-[0.98]"
          >
            <PlusCircleIcon className="h-4 w-4 mr-1.5" />
            {i18nService.t('coworkMemoryCrudCreate')}
          </button>
        </div>

        {coworkMemoryStats && (
          <div className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {`${i18nService.t('coworkMemoryTotalLabel')}: ${coworkMemoryStats.created + coworkMemoryStats.stale} · ${i18nService.t('coworkMemoryActiveLabel')}: ${coworkMemoryStats.created} · ${i18nService.t('coworkMemoryInactiveLabel')}: ${coworkMemoryStats.stale}`}
          </div>
        )}

        <input
          type="text"
          value={coworkMemoryQuery}
          onChange={(event) => onQueryChange(event.target.value)}
          placeholder={i18nService.t('coworkMemorySearchPlaceholder')}
          className="w-full rounded-lg border px-3 py-2 text-sm dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface"
        />

        <div className="max-h-[500px] overflow-auto rounded-lg border dark:border-claude-darkBorder border-claude-border">
          {coworkMemoryListLoading ? (
            <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('loading')}
            </div>
          ) : coworkMemoryEntries.length === 0 ? (
            <div className="px-3 py-3 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkMemoryEmpty')}
            </div>
          ) : (
            <div className="divide-y dark:divide-claude-darkBorder divide-claude-border">
              {coworkMemoryEntries.map((entry) => (
                <div key={entry.id} className="px-3 py-3 text-xs hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors">
                  <div className="flex items-start justify-between gap-3">
                    <div className="flex-1 space-y-1 min-w-0">
                      <div className="font-medium dark:text-claude-darkText text-claude-text break-words">
                        {entry.text}
                      </div>
                      <div className="flex flex-wrap items-center gap-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">
                        <span className="rounded-full border px-2 py-0.5 dark:border-claude-darkBorder border-claude-border">
                          {getMemoryStatusLabel(entry.status)}
                        </span>
                        <span>
                          {`${i18nService.t('coworkMemoryUpdatedAt')}: ${formatMemoryUpdatedAt(entry.updatedAt)}`}
                        </span>
                      </div>
                    </div>
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <button
                        type="button"
                        onClick={() => onEditEntry(entry)}
                        className="rounded border px-2 py-1 dark:border-claude-darkBorder border-claude-border dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
                      >
                        {i18nService.t('edit')}
                      </button>
                      <button
                        type="button"
                        onClick={() => { void onDeleteEntry(entry); }}
                        className="rounded border px-2 py-1 text-red-500 dark:border-claude-darkBorder border-claude-border hover:bg-red-50 dark:hover:bg-red-900/20 disabled:opacity-60 transition-colors"
                        disabled={coworkMemoryListLoading}
                      >
                        {i18nService.t('delete')}
                      </button>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

    </div>
  );
}
