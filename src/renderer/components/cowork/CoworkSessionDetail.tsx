import React, { useRef, useEffect, useState, useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../../store';
import { i18nService } from '../../services/i18n';
import type { CoworkImageAttachment } from '../../types/cowork';
import CoworkPromptInput from './CoworkPromptInput';
import { ShareIcon } from '@heroicons/react/24/outline';
import { FolderIcon } from '@heroicons/react/24/solid';
import { coworkService } from '../../services/cowork';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import ComposeIcon from '../icons/ComposeIcon';
import EllipsisHorizontalIcon from '../icons/EllipsisHorizontalIcon';
import PencilSquareIcon from '../icons/PencilSquareIcon';
import TrashIcon from '../icons/TrashIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import { getCompactFolderName } from '../../utils/path';

// Utils
import {
  AUTO_SCROLL_THRESHOLD,
  NAV_HIDE_DELAY,
  NAV_SCROLL_LOCK_DURATION,
  NAV_BOTTOM_SNAP_THRESHOLD,
  mapSandboxGuestPathToCwd,
  mapSandboxGuestPathsInText,
  parseRootRelativePath,
  normalizeLocalPath,
  toAbsolutePathFromCwd,
} from './utils/coworkPathUtils';

import {
  buildDisplayItems,
  buildConversationTurns,
  hasRenderableAssistantContent,
} from './utils/coworkMessageUtils';

// Components
import UserMessageItem from './components/UserMessageItem';
import StreamingActivityBar from './components/StreamingActivityBar';
import AssistantTurnBlock from './components/AssistantTurnBlock';

// Modals
import DeleteConfirmModal from './modals/DeleteConfirmModal';
import ExportOptionsModal from './modals/ExportOptionsModal';

interface CoworkSessionDetailProps {
  onManageSkills?: () => void;
  onContinue: (prompt: string, skillPrompt?: string, imageAttachments?: CoworkImageAttachment[]) => void;
  onStop: () => void;
  onNavigateHome?: () => void;
  isSidebarCollapsed?: boolean;
  onToggleSidebar?: () => void;
  onNewChat?: () => void;
  updateBadge?: React.ReactNode;
}

// PushPinIcon component for pin/unpin functionality
const PushPinIcon: React.FC<React.SVGProps<SVGSVGElement> & { slashed?: boolean }> = ({
  slashed,
  ...props
}) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.5}
    strokeLinecap="round"
    strokeLinejoin="round"
    {...props}
  >
    <g transform="rotate(45 12 12)">
      <path d="M9 3h6l-1 5 2 2v2H8v-2l2-2-1-5z" />
      <path d="M12 12v9" />
    </g>
    {slashed && <path d="M5 5L19 19" />}
  </svg>
);

const CoworkSessionDetail: React.FC<CoworkSessionDetailProps> = ({
  onManageSkills,
  onContinue,
  onStop,
  onNavigateHome,
  isSidebarCollapsed,
  onToggleSidebar,
  onNewChat,
  updateBadge,
}) => {
  const isMac = window.electron.platform === 'darwin';
  const currentSession = useSelector((state: RootState) => state.cowork.currentSession);
  const isStreaming = useSelector((state: RootState) => state.cowork.isStreaming);
  const skills = useSelector((state: RootState) => state.skill.skills);
  const detailRootRef = useRef<HTMLDivElement>(null);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const [shouldAutoScroll, setShouldAutoScroll] = useState(true);

  // Turn navigation states
  // currentTurnIndex (state) drives UI rendering; currentTurnIndexRef (ref) provides
  // up-to-date value inside callbacks (avoids stale closure). Both must be updated together.
  const [currentTurnIndex, setCurrentTurnIndex] = useState(0);
  const currentTurnIndexRef = useRef(0);
  const [showTurnNav, setShowTurnNav] = useState(false);
  const hideNavTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isNavigatingRef = useRef(false);
  const navigatingTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const turnElsCacheRef = useRef<HTMLElement[]>([]);
  const [isScrollable, setIsScrollable] = useState(false);

  // Menu and action states
  const [menuPosition, setMenuPosition] = useState<{ x: number; y: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const actionButtonRef = useRef<HTMLButtonElement>(null);
  const [showConfirmDelete, setShowConfirmDelete] = useState(false);
  const [isExportingImage, setIsExportingImage] = useState(false);

  // Rename states
  const [isRenaming, setIsRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameInputRef = useRef<HTMLInputElement>(null);
  const ignoreNextBlurRef = useRef(false);

  // Reset rename value when session changes
  useEffect(() => {
    if (!isRenaming && currentSession) {
      setRenameValue(currentSession.title);
      ignoreNextBlurRef.current = false;
    }
  }, [isRenaming, currentSession?.title]);

  useEffect(() => {
    setShouldAutoScroll(true);
  }, [currentSession?.id]);

  // Focus rename input when entering rename mode
  useEffect(() => {
    if (!isRenaming) return;
    requestAnimationFrame(() => {
      renameInputRef.current?.focus();
      renameInputRef.current?.select();
    });
  }, [isRenaming]);

  // Cleanup nav timers on unmount
  useEffect(() => {
    return () => {
      if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
      if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    };
  }, []);

  // Reset nav state when session changes
  useEffect(() => {
    setShowTurnNav(false);
    setIsScrollable(false);
    setCurrentTurnIndex(0);
    currentTurnIndexRef.current = 0;
    isNavigatingRef.current = false;
    turnElsCacheRef.current = [];
    if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
  }, [currentSession?.id]);

  // Close menu on outside click
  useEffect(() => {
    if (!menuPosition) return;
    const handleClickOutside = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!menuRef.current?.contains(target) && !actionButtonRef.current?.contains(target)) {
        closeMenu();
      }
    };
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        closeMenu();
      }
    };
    const handleScroll = () => closeMenu();
    document.addEventListener('mousedown', handleClickOutside);
    document.addEventListener('keydown', handleEscape);
    window.addEventListener('scroll', handleScroll, true);
    window.addEventListener('resize', handleScroll);
    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      document.removeEventListener('keydown', handleEscape);
      window.removeEventListener('scroll', handleScroll, true);
      window.removeEventListener('resize', handleScroll);
    };
  }, [menuPosition]);

  // Helper: truncate path for display
  const truncatePath = (path: string, maxLength = 20): string => {
    if (!path) return i18nService.t('noFolderSelected');
    return getCompactFolderName(path, maxLength) || i18nService.t('noFolderSelected');
  };

  // Menu position calculator
  const calculateMenuPosition = (height: number) => {
    const rect = actionButtonRef.current?.getBoundingClientRect();
    if (!rect) return null;
    const menuWidth = 180;
    const padding = 8;
    const x = Math.min(
      Math.max(padding, rect.right - menuWidth),
      window.innerWidth - menuWidth - padding
    );
    const y = Math.min(rect.bottom + 8, window.innerHeight - height - padding);
    return { x, y };
  };

  const openMenu = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isRenaming) return;
    if (menuPosition) {
      closeMenu();
      return;
    }
    const menuHeight = 160;
    const position = calculateMenuPosition(menuHeight);
    if (position) {
      setMenuPosition(position);
    }
    setShowConfirmDelete(false);
  };

  const closeMenu = () => {
    setMenuPosition(null);
    setShowConfirmDelete(false);
  };

  // Open folder in Finder/Explorer
  const handleOpenFolder = useCallback(async () => {
    if (!currentSession?.cwd) return;
    try {
      await window.electron.shell.openPath(currentSession.cwd);
    } catch (error) {
      console.error('Failed to open folder:', error);
    }
  }, [currentSession?.cwd]);

  // Rename handlers
  const handleRenameClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession) return;
    ignoreNextBlurRef.current = false;
    setIsRenaming(true);
    setShowConfirmDelete(false);
    setRenameValue(currentSession.title);
    setMenuPosition(null);
  };

  const handleRenameSave = async (e?: React.SyntheticEvent) => {
    e?.stopPropagation();
    if (!currentSession) return;
    ignoreNextBlurRef.current = true;
    const nextTitle = renameValue.trim();
    if (nextTitle && nextTitle !== currentSession.title) {
      await coworkService.renameSession(currentSession.id, nextTitle);
    }
    setIsRenaming(false);
  };

  const handleRenameCancel = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    ignoreNextBlurRef.current = true;
    if (currentSession) {
      setRenameValue(currentSession.title);
    }
    setIsRenaming(false);
  };

  const handleRenameBlur = (event: React.FocusEvent<HTMLInputElement>) => {
    if (ignoreNextBlurRef.current) {
      ignoreNextBlurRef.current = false;
      return;
    }
    handleRenameSave(event);
  };

  // Pin/unpin handler
  const handleTogglePin = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession) return;
    await coworkService.setSessionPinned(currentSession.id, !currentSession.pinned);
    closeMenu();
  };

  // Delete handlers
  const handleDeleteClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    setShowConfirmDelete(true);
    setMenuPosition(null);
  };

  const handleShareClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!currentSession || isExportingImage) return;
    closeMenu();
    setIsExportingImage(true);
  };

  const handleConfirmDelete = async () => {
    if (!currentSession) return;
    await coworkService.deleteSession(currentSession.id);
    setShowConfirmDelete(false);
    if (onNavigateHome) {
      onNavigateHome();
    }
  };

  const handleCancelDelete = (e?: React.MouseEvent) => {
    e?.stopPropagation();
    setShowConfirmDelete(false);
  };

  const handleMessagesScroll = useCallback(() => {
    const container = scrollContainerRef.current;
    if (!container) return;
    const distanceToBottom = container.scrollHeight - container.scrollTop - container.clientHeight;
    const isNearBottom = distanceToBottom <= AUTO_SCROLL_THRESHOLD;
    setShouldAutoScroll((prev) => (prev === isNearBottom ? prev : isNearBottom));

    // Check if content overflows the container (use functional updater to avoid redundant re-renders)
    const scrollable = container.scrollHeight > container.clientHeight;
    setIsScrollable((prev) => (prev === scrollable ? prev : scrollable));
    if (!scrollable) return;

    // Show turn nav and reset hide timer
    setShowTurnNav(true);
    if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
    hideNavTimerRef.current = setTimeout(() => setShowTurnNav(false), NAV_HIDE_DELAY);

    // Skip index recalculation during programmatic navigation
    if (isNavigatingRef.current) return;

    // Update current turn index based on cached turn elements
    const turnEls = turnElsCacheRef.current;
    if (turnEls.length === 0) return;

    // If at very bottom, snap to last turn (use smaller threshold than auto-scroll)
    if (distanceToBottom <= NAV_BOTTOM_SNAP_THRESHOLD) {
      const lastIndex = turnEls.length - 1;
      currentTurnIndexRef.current = lastIndex;
      setCurrentTurnIndex(lastIndex);
      return;
    }

    const scrollTop = container.scrollTop;
    let visibleIndex = 0;
    for (let i = 0; i < turnEls.length; i++) {
      if (turnEls[i].offsetTop <= scrollTop + 80) {
        visibleIndex = i;
      } else {
        break;
      }
    }
    currentTurnIndexRef.current = visibleIndex;
    setCurrentTurnIndex(visibleIndex);
  }, []);

  const navigateToTurn = useCallback((direction: 'prev' | 'next') => {
    const turnEls = turnElsCacheRef.current;
    if (turnEls.length === 0) return;
    const idx = currentTurnIndexRef.current;
    const targetIndex = direction === 'prev' ? idx - 1 : idx + 1;
    if (targetIndex < 0 || targetIndex >= turnEls.length) return;

    // Block scroll handler from overriding index during smooth scroll
    isNavigatingRef.current = true;
    if (navigatingTimerRef.current) clearTimeout(navigatingTimerRef.current);
    navigatingTimerRef.current = setTimeout(() => { isNavigatingRef.current = false; }, NAV_SCROLL_LOCK_DURATION);

    turnEls[targetIndex].scrollIntoView({ behavior: 'smooth', block: 'start' });
    currentTurnIndexRef.current = targetIndex;
    setCurrentTurnIndex(targetIndex);
    // Reset hide timer
    setShowTurnNav(true);
    if (hideNavTimerRef.current) clearTimeout(hideNavTimerRef.current);
    hideNavTimerRef.current = setTimeout(() => setShowTurnNav(false), NAV_HIDE_DELAY);
  }, []);

  // Get the last message content for auto-scroll on streaming updates
  const lastMessage = currentSession?.messages?.[currentSession.messages.length - 1];
  const lastMessageContent = lastMessage?.content;

  const resolveLocalFilePath = useCallback((href: string, text: string) => {
    const hrefValue = typeof href === 'string' ? href.trim() : '';
    const textValue = typeof text === 'string' ? text.trim() : '';
    if (!hrefValue && !textValue) return null;

    // In sandbox mode, translate VM guest paths to host paths.
    const mapSandboxPath = (filePath: string): string => {
      if (
        currentSession?.executionMode !== 'sandbox' ||
        !currentSession?.cwd
      ) {
        return filePath;
      }
      const mapped = mapSandboxGuestPathToCwd(filePath, currentSession.cwd);
      return mapped ?? filePath;
    };

    const hrefRootRelative = hrefValue ? parseRootRelativePath(hrefValue) : null;
    if (hrefRootRelative) {
      return mapSandboxPath(hrefRootRelative);
    }

    const hrefPath = hrefValue ? normalizeLocalPath(hrefValue) : null;
    if (hrefPath) {
      if (hrefPath.isRelative && currentSession?.cwd) {
        return mapSandboxPath(toAbsolutePathFromCwd(hrefPath.path, currentSession.cwd));
      }
      if (hrefPath.isAbsolute) {
        return mapSandboxPath(hrefPath.path);
      }
    }

    const textRootRelative = textValue ? parseRootRelativePath(textValue) : null;
    if (textRootRelative) {
      return mapSandboxPath(textRootRelative);
    }

    const textPath = textValue ? normalizeLocalPath(textValue) : null;
    if (textPath) {
      if (textPath.isRelative && currentSession?.cwd) {
        return mapSandboxPath(toAbsolutePathFromCwd(textPath.path, currentSession.cwd));
      }
      if (textPath.isAbsolute) {
        return mapSandboxPath(textPath.path);
      }
    }

    return null;
  }, [currentSession?.cwd, currentSession?.executionMode]);

  const mapDisplayText = useCallback((value: string): string => {
    if (currentSession?.executionMode !== 'sandbox') {
      return value;
    }
    return mapSandboxGuestPathsInText(value, currentSession?.cwd);
  }, [currentSession?.cwd, currentSession?.executionMode]);

  const messages = currentSession?.messages;
  const displayItems = useMemo(() => messages ? buildDisplayItems(messages) : [], [messages]);
  const turns = useMemo(() => buildConversationTurns(displayItems), [displayItems]);

  // Cache turn DOM elements when turns change
  useEffect(() => {
    const container = scrollContainerRef.current;
    if (!container) { turnElsCacheRef.current = []; return; }
    // DOM is already committed when useEffect runs, query synchronously
    turnElsCacheRef.current = Array.from(
      container.querySelectorAll<HTMLElement>('[data-turn-index]')
    );
  }, [turns]);

  // Auto scroll to bottom when new messages arrive or content updates (streaming)
  useEffect(() => {
    if (!shouldAutoScroll) {
      return;
    }
    const container = scrollContainerRef.current;
    if (container) {
      container.scrollTop = container.scrollHeight;
      setIsScrollable(container.scrollHeight > container.clientHeight);
    }
    // Sync turn index to last when auto-scrolled to bottom
    if (turns.length > 0) {
      const lastIndex = turns.length - 1;
      currentTurnIndexRef.current = lastIndex;
      setCurrentTurnIndex(lastIndex);
    }
  }, [currentSession?.messages?.length, lastMessageContent, isStreaming, shouldAutoScroll, turns.length]);

  if (!currentSession) {
    return null;
  }

  const renderConversationTurns = () => {
    if (turns.length === 0) {
      if (!isStreaming) return null;
      return (
        <div data-export-role="assistant-block">
          <AssistantTurnBlock
            turn={{
              id: 'streaming-only',
              userMessage: null,
              assistantItems: [],
            }}
            resolveLocalFilePath={resolveLocalFilePath}
            showTypingIndicator
            showCopyButtons={!isStreaming}
          />
        </div>
      );
    }

    return turns.map((turn, index) => {
      const isLastTurn = index === turns.length - 1;
      const showTypingIndicator = isStreaming && isLastTurn && !hasRenderableAssistantContent(turn);
      const showAssistantBlock = turn.assistantItems.length > 0 || showTypingIndicator;

      return (
        <div key={turn.id} data-turn-index={index}>
          {turn.userMessage && (
            <div data-export-role="user-message">
              <UserMessageItem message={turn.userMessage} skills={skills} />
            </div>
          )}
          {showAssistantBlock && (
            <div data-export-role="assistant-block">
              <AssistantTurnBlock
                turn={turn}
                resolveLocalFilePath={resolveLocalFilePath}
                mapDisplayText={mapDisplayText}
                showTypingIndicator={showTypingIndicator}
                showCopyButtons={!isStreaming}
              />
            </div>
          )}
        </div>
      );
    });
  };

  return (
    <div ref={detailRootRef} className="flex-1 flex flex-col dark:bg-claude-darkBg bg-claude-bg h-full">
      {/* Header */}
      <div className="draggable flex h-12 items-center justify-between px-4 dark:bg-claude-darkSurface/50 bg-claude-surface/50 shrink-0">
        {/* Left side: Toggle buttons (when collapsed) + Title + Sandbox badge */}
        <div className="flex h-full items-center gap-2 min-w-0">
          {isSidebarCollapsed && (
            <div className={`non-draggable flex items-center gap-1 ${isMac ? 'pl-[68px]' : ''}`}>
              <button
                type="button"
                onClick={onToggleSidebar}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
              </button>
              <button
                type="button"
                onClick={onNewChat}
                className="h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
              >
                <ComposeIcon className="h-4 w-4" />
              </button>
              {updateBadge}
            </div>
          )}
          {isRenaming ? (
            <input
              ref={renameInputRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onClick={(e) => e.stopPropagation()}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  handleRenameSave(e);
                }
                if (e.key === 'Escape') {
                  handleRenameCancel(e);
                }
              }}
              onBlur={handleRenameBlur}
              className="non-draggable min-w-0 max-w-[300px] rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkBg bg-claude-bg px-2 py-1 text-sm font-medium dark:text-claude-darkText text-claude-text focus:outline-none focus:ring-2 focus:ring-claude-accent"
            />
          ) : (
            <h1 className="text-sm leading-none font-medium dark:text-claude-darkText text-claude-text truncate max-w-[360px]">
              {currentSession.title || i18nService.t('coworkNewSession')}
            </h1>
          )}
          {currentSession.executionMode === 'sandbox' && (
            <span className="inline-flex items-center rounded-full bg-emerald-500/10 text-emerald-500 dark:text-emerald-400 border border-emerald-500/30 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
              {i18nService.t('coworkSandboxBadge')}
            </span>
          )}
          {currentSession.executionMode === 'local' && (
            <span className="inline-flex items-center rounded-full bg-amber-500/10 text-amber-600 dark:text-amber-400 border border-amber-500/30 px-2 py-0.5 text-xs font-semibold uppercase tracking-wide">
              {i18nService.t('coworkLocalBadge')}
            </span>
          )}
        </div>

        {/* Right side: Folder + Menu */}
        <div className="non-draggable flex items-center gap-1">
          {/* Folder button */}
          <button
            type="button"
            onClick={handleOpenFolder}
            className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover dark:hover:text-claude-darkText hover:text-claude-text transition-colors"
            aria-label={i18nService.t('coworkOpenFolder')}
          >
            <FolderIcon className="h-4 w-4" />
            <span className="max-w-[120px] truncate text-xs">
              {truncatePath(currentSession.cwd)}
            </span>
          </button>

          {/* Menu button */}
          <button
            ref={actionButtonRef}
            type="button"
            onClick={openMenu}
            className="p-1.5 rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
            aria-label={i18nService.t('coworkSessionActions')}
          >
            <EllipsisHorizontalIcon className="h-5 w-5" />
          </button>
          <WindowTitleBar inline className="ml-1" />
        </div>
      </div>

      {/* Floating Menu */}
      {menuPosition && (
        <div
          ref={menuRef}
          className="fixed z-50 min-w-[180px] rounded-xl border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface shadow-popover popover-enter overflow-hidden"
          style={{ top: menuPosition.y, left: menuPosition.x }}
          role="menu"
        >
          <button
            type="button"
            onClick={handleRenameClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <PencilSquareIcon className="h-4 w-4" />
            {i18nService.t('renameConversation')}
          </button>
          <button
            type="button"
            onClick={handleTogglePin}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
          >
            <PushPinIcon
              slashed={currentSession.pinned}
              className={`h-4 w-4 ${currentSession.pinned ? 'opacity-60' : ''}`}
            />
            {currentSession.pinned ? i18nService.t('coworkUnpinSession') : i18nService.t('coworkPinSession')}
          </button>
          <button
            type="button"
            onClick={handleShareClick}
            disabled={isExportingImage}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <ShareIcon className="h-4 w-4" />
            {i18nService.t('coworkShareSession')}
          </button>
          <button
            type="button"
            onClick={handleDeleteClick}
            className="w-full flex items-center gap-2 px-3 py-2 text-left text-sm text-red-500 hover:bg-red-500/10 transition-colors"
          >
            <TrashIcon className="h-4 w-4" />
            {i18nService.t('deleteSession')}
          </button>
        </div>
      )}

      {/* Delete Confirmation Modal */}
      <DeleteConfirmModal
        isOpen={showConfirmDelete}
        onClose={handleCancelDelete}
        onConfirm={handleConfirmDelete}
      />

      {/* Export Options Modal */}
      <ExportOptionsModal
        isOpen={isExportingImage}
        currentSession={currentSession}
        scrollContainerRef={scrollContainerRef}
        onClose={() => setIsExportingImage(false)}
      />

      {/* Messages */}
      <div className="relative flex-1 min-h-0">
        <div
          ref={scrollContainerRef}
          onScroll={handleMessagesScroll}
          className="h-full min-h-0 overflow-y-auto pt-3"
        >
          {renderConversationTurns()}
          <div className="h-20" />
        </div>

        {/* Turn Navigation Buttons */}
        {turns.length > 1 && isScrollable && (
          <div
            className={`absolute right-4 top-1/2 -translate-y-1/2 flex flex-col rounded-lg overflow-hidden shadow-elevated transition-opacity duration-300 z-10
              dark:bg-claude-darkSurface/90 bg-claude-surface/90 backdrop-blur-sm
              border dark:border-claude-darkBorder border-claude-border
              ${showTurnNav ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'}`}
          >
            <button
              type="button"
              onClick={() => currentTurnIndex > 0 && navigateToTurn('prev')}
              className={`px-1.5 py-3 transition-colors dark:text-claude-darkText text-claude-text
                ${currentTurnIndex <= 0
                  ? 'opacity-30 cursor-default'
                  : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M4.5 15.75l7.5-7.5 7.5 7.5" />
              </svg>
            </button>
            <div className="dark:border-claude-darkBorder border-claude-border border-t" />
            <button
              type="button"
              onClick={() => currentTurnIndex < turns.length - 1 && navigateToTurn('next')}
              className={`px-1.5 py-3 transition-colors dark:text-claude-darkText text-claude-text
                ${currentTurnIndex >= turns.length - 1
                  ? 'opacity-30 cursor-default'
                  : 'dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover cursor-pointer'}`}
            >
              <svg xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24" strokeWidth={2.5} stroke="currentColor" className="w-4 h-4">
                <path strokeLinecap="round" strokeLinejoin="round" d="M19.5 8.25l-7.5 7.5-7.5-7.5" />
              </svg>
            </button>
          </div>
        )}
      </div>

      {/* Streaming Activity Bar */}
      {isStreaming && <StreamingActivityBar messages={currentSession.messages} />}

      {/* Input Area */}
      <div className="p-4 shrink-0">
        <div className="max-w-3xl mx-auto">
          <CoworkPromptInput
            onSubmit={onContinue}
            onStop={onStop}
            isStreaming={isStreaming}
            placeholder={i18nService.t('coworkContinuePlaceholder')}
            disabled={false}
            onManageSkills={onManageSkills}
            size="large"
            showModelSelector={true}
          />
        </div>
      </div>
    </div>
  );
};

export default CoworkSessionDetail;
