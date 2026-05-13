import React, { useEffect, useState } from 'react';
import { coworkService } from '../../../services/cowork';
import { i18nService } from '../../../services/i18n';
import {
  sanitizeExportFileName,
  formatExportTimestamp,
  loadImageFromBase64,
  domRectToCaptureRect,
  MAX_EXPORT_CANVAS_HEIGHT,
  MAX_EXPORT_SEGMENTS,
  waitForNextFrame,
} from '../utils/coworkPathUtils';
import type { CaptureRect } from '../utils/coworkPathUtils';
import type { CoworkSession } from '../../../types/cowork';

interface ExportOptionsModalProps {
  isOpen: boolean;
  currentSession: CoworkSession | null;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  onClose: () => void;
}

const ExportOptionsModal: React.FC<ExportOptionsModalProps> = ({
  isOpen,
  currentSession,
  scrollContainerRef,
  onClose,
}) => {
  const [isExportingImage, setIsExportingImage] = useState(false);

  // Watch for isOpen to trigger export
  useEffect(() => {
    if (!isOpen || !currentSession || isExportingImage) return;

    setIsExportingImage(true);

    window.requestAnimationFrame(() => {
      void (async () => {
        try {
          const scrollContainer = scrollContainerRef.current;
          if (!scrollContainer) {
            throw new Error('Capture target not found');
          }
          const initialScrollTop = scrollContainer.scrollTop;
          try {
            const scrollRect = domRectToCaptureRect(scrollContainer.getBoundingClientRect());
            if (scrollRect.width <= 0 || scrollRect.height <= 0) {
              throw new Error('Invalid capture area');
            }

            const scrollContentHeight = Math.max(scrollContainer.scrollHeight, scrollContainer.clientHeight);
            if (scrollContentHeight <= 0) {
              throw new Error('Invalid content height');
            }

            const toContentY = (viewportY: number): number => {
              const y = scrollContainer.scrollTop + (viewportY - scrollRect.y);
              return Math.max(0, Math.min(scrollContentHeight, y));
            };

            const userAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="user-message"]');
            const assistantAnchors = scrollContainer.querySelectorAll<HTMLElement>('[data-export-role="assistant-block"]');

            let contentStart = 0;
            let contentEnd = scrollContentHeight;

            if (userAnchors.length > 0) {
              contentStart = toContentY(userAnchors[0].getBoundingClientRect().top);
            } else if (assistantAnchors.length > 0) {
              contentStart = toContentY(assistantAnchors[0].getBoundingClientRect().top);
            }

            if (assistantAnchors.length > 0) {
              const lastAssistant = assistantAnchors[assistantAnchors.length - 1];
              contentEnd = toContentY(lastAssistant.getBoundingClientRect().bottom);
            } else if (userAnchors.length > 0) {
              const lastUser = userAnchors[userAnchors.length - 1];
              contentEnd = toContentY(lastUser.getBoundingClientRect().bottom);
            }

            const maxStart = Math.max(0, scrollContentHeight - 1);
            contentStart = Math.max(0, Math.min(maxStart, Math.round(contentStart)));
            contentEnd = Math.max(contentStart + 1, Math.min(scrollContentHeight, Math.round(contentEnd)));

            const outputHeight = contentEnd - contentStart;

            if (outputHeight > MAX_EXPORT_CANVAS_HEIGHT) {
              throw new Error(`Export image is too tall (${outputHeight}px)`);
            }

            const segmentsEstimate = Math.ceil(outputHeight / Math.max(1, scrollRect.height)) + 1;
            if (segmentsEstimate > MAX_EXPORT_SEGMENTS) {
              throw new Error('Export image is too long');
            }

            const canvas = document.createElement('canvas');
            canvas.width = scrollRect.width;
            canvas.height = outputHeight;
            const context = canvas.getContext('2d');
            if (!context) {
              throw new Error('Canvas context unavailable');
            }

            const captureAndLoad = async (rect: CaptureRect): Promise<HTMLImageElement> => {
              const chunk = await coworkService.captureSessionImageChunk({ rect });
              if (!chunk.success || !chunk.pngBase64) {
                throw new Error(chunk.error || 'Failed to capture image chunk');
              }
              return loadImageFromBase64(chunk.pngBase64);
            };

            scrollContainer.scrollTop = Math.min(
              contentStart,
              Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight),
            );
            await waitForNextFrame();
            await waitForNextFrame();

            const maxScrollTop = Math.max(0, scrollContainer.scrollHeight - scrollContainer.clientHeight);
            let contentOffset = contentStart;
            while (contentOffset < contentEnd) {
              const targetScrollTop = Math.min(contentOffset, maxScrollTop);
              scrollContainer.scrollTop = targetScrollTop;
              await waitForNextFrame();
              await waitForNextFrame();

              const chunkImage = await captureAndLoad(scrollRect);
              const sourceYOffset = Math.max(0, contentOffset - targetScrollTop);
              const drawableHeight = Math.min(scrollRect.height - sourceYOffset, contentEnd - contentOffset);
              if (drawableHeight <= 0) {
                throw new Error('Failed to stitch export image');
              }
              const scaleY = chunkImage.naturalHeight / scrollRect.height;
              const sourceYInImage = Math.max(0, Math.round(sourceYOffset * scaleY));
              const sourceHeightInImage = Math.max(
                1,
                Math.min(
                  chunkImage.naturalHeight - sourceYInImage,
                  Math.round(drawableHeight * scaleY),
                ),
              );

              context.drawImage(
                chunkImage,
                0,
                sourceYInImage,
                chunkImage.naturalWidth,
                sourceHeightInImage,
                0,
                contentOffset - contentStart,
                scrollRect.width,
                drawableHeight,
              );

              contentOffset += drawableHeight;
            }

            const pngDataUrl = canvas.toDataURL('image/png');
            const base64Index = pngDataUrl.indexOf(',');
            if (base64Index < 0) {
              throw new Error('Failed to encode export image');
            }

            const timestamp = formatExportTimestamp(new Date());
            const saveResult = await coworkService.saveSessionResultImage({
              pngBase64: pngDataUrl.slice(base64Index + 1),
              defaultFileName: sanitizeExportFileName(`${currentSession.title}-${timestamp}.png`),
            });
            if (saveResult.success && !saveResult.canceled) {
              window.dispatchEvent(
                new CustomEvent('app:showToast', {
                  detail: i18nService.t('coworkExportImageSuccess'),
                }),
              );
              onClose();
              return;
            }
            if (!saveResult.success) {
              throw new Error(saveResult.error || 'Failed to export image');
            }
          } finally {
            scrollContainer.scrollTop = initialScrollTop;
          }
        } catch (error) {
          console.error('Failed to export session image:', error);
          window.dispatchEvent(
            new CustomEvent('app:showToast', {
              detail: i18nService.t('coworkExportImageFailed'),
            }),
          );
        } finally {
          setIsExportingImage(false);
          onClose();
        }
      })();
    });
  }, [isOpen, currentSession, scrollContainerRef, isExportingImage, onClose]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center modal-backdrop">
      <div
        className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-modal overflow-hidden modal-content"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center gap-3 px-5 py-4">
          <div className="p-2 rounded-full bg-blue-100 dark:bg-blue-900/30">
            <svg
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
              strokeWidth={1.5}
              stroke="currentColor"
              className="h-5 w-5 text-blue-600 dark:text-blue-500"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                d="M9 15.75v-2.25m0 0a3.001 3.001 0 013 3.5m3-8.75a3.001 3.001 0 01-3 3.5M13.5 3h-3.75M13.5 3H6m9 0a3 3 0 00-3-3M9 3a3 3 0 00-3 3m0 4.5a3 3 0 006 0m0 0v2.25m0-2.25v2.25m0-2.25h2.25m-2.25 0H15m-3 0V3m0 3.75v2.25m0-2.25H15m3 0h2.25M15 6a3 3 0 013 3m0 4.5a3 3 0 00-3 3m3 0a3 3 0 013-3m-4.5 0h4.5"
              />
            </svg>
          </div>
          <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
            {i18nService.t('coworkExportImageTitle') || 'Exporting Session Image'}
          </h2>
        </div>

        {/* Content - Loading State */}
        <div className="px-5 pb-4">
          <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            {i18nService.t('coworkExportImageMessage') || 'Capturing and exporting your session as an image...'}
          </p>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-center px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
          <div className="flex items-center gap-2">
            <svg
              className="animate-spin h-4 w-4 text-blue-500"
              xmlns="http://www.w3.org/2000/svg"
              fill="none"
              viewBox="0 0 24 24"
            >
              <circle
                className="opacity-25"
                cx="12"
                cy="12"
                r="10"
                stroke="currentColor"
                strokeWidth="4"
              />
              <path
                className="opacity-75"
                fill="currentColor"
                d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
              />
            </svg>
            <span className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
              {i18nService.t('coworkExportImageProcessing') || 'Processing...'}
            </span>
          </div>
        </div>
      </div>
    </div>
  );
};

export default ExportOptionsModal;
