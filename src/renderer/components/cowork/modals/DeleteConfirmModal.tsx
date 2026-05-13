import React from 'react';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { i18nService } from '../../../services/i18n';

interface DeleteConfirmModalProps {
  isOpen: boolean;
  onClose: () => void;
  onConfirm: () => void;
}

const DeleteConfirmModal: React.FC<DeleteConfirmModalProps> = ({
  isOpen,
  onClose,
  onConfirm,
}) => {
  if (!isOpen) return null;

  const handleConfirm = async () => {
    await onConfirm();
    onClose();
  };

  const handleBackdropClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    onClose();
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop"
      onClick={handleBackdropClick}
    >
      <div
        className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4">
          <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
            <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
          </div>
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('deleteTaskConfirmTitle')}
          </h2>
        </div>

        {/* Content */}
        <div className="px-5 pb-4">
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('deleteTaskConfirmMessage')}
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
          <button
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
          >
            {i18nService.t('cancel')}
          </button>
          <button
            onClick={handleConfirm}
            className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
          >
            {i18nService.t('deleteSession')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default DeleteConfirmModal;
