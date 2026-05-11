import { Database } from 'sql.js';
import { CoworkSessionStore } from './sessionStore';
import { CoworkMessageStore } from './messageStore';
import { CoworkMemoryStore } from './memoryStore';
import { CoworkConfigStore } from './configStore';
import type {
  CoworkSession,
  CoworkSessionSummary,
  CoworkMessage,
  CoworkMessageMetadata,
  CoworkExecutionMode,
  CoworkUserMemory,
  CoworkUserMemoryStatus,
  CoworkUserMemorySourceInput,
  CoworkUserMemoryStats,
  CoworkConversationSearchRecord,
  CoworkConfig,
  CoworkConfigUpdate,
  ApplyTurnMemoryUpdatesOptions,
  ApplyTurnMemoryUpdatesResult,
} from '../types';

export { CoworkSessionStore, CoworkMessageStore, CoworkMemoryStore, CoworkConfigStore };
export * from '../types';

export class CoworkStore {
  session: CoworkSessionStore;
  message: CoworkMessageStore;
  memory: CoworkMemoryStore;
  config: CoworkConfigStore;
  private saveDb: () => void;

  constructor(db: Database, saveFn: () => void) {
    this.db = db;
    this.saveDb = saveFn;
    this.session = new CoworkSessionStore(db, saveFn);
    this.message = new CoworkMessageStore(db, saveFn);
    this.memory = new CoworkMemoryStore(db, saveFn);
    this.config = new CoworkConfigStore(db, saveFn);
  }

  private db: Database;

  // Session convenience wrappers
  createSession(
    title: string,
    cwd: string,
    systemPrompt: string = '',
    executionMode: CoworkExecutionMode = 'local',
    activeSkillIds: string[] = []
  ): CoworkSession {
    return this.session.create(title, cwd, systemPrompt, executionMode, activeSkillIds);
  }

  getSession(id: string): CoworkSession | null {
    const session = this.session.findById(id);
    if (session) {
      session.messages = this.message.findBySessionId(id);
    }
    return session;
  }

  updateSession(
    id: string,
    updates: Partial<Pick<CoworkSession, 'title' | 'claudeSessionId' | 'status' | 'cwd' | 'systemPrompt' | 'executionMode'>>
  ): void {
    this.session.update(id, updates);
  }

  deleteSession(id: string): void {
    this.memory.markSourcesInactiveBySession(id);
    this.session.delete(id);
    this.memory.markOrphanImplicitStale();
    this.saveDb();
  }

  deleteSessions(ids: string[]): void {
    for (const id of ids) {
      this.memory.markSourcesInactiveBySession(id);
    }
    this.session.deleteMany(ids);
    this.memory.markOrphanImplicitStale();
    this.saveDb();
  }

  setSessionPinned(id: string, pinned: boolean): void {
    this.session.setPinned(id, pinned);
  }

  listSessions(): CoworkSessionSummary[] {
    return this.session.listAll();
  }

  resetRunningSessions(): number {
    return this.session.resetRunningToIdle();
  }

  listRecentCwds(limit?: number): string[] {
    return this.session.listRecentCwds(limit);
  }

  // Message convenience wrappers
  getSessionMessages(sessionId: string): CoworkMessage[] {
    return this.message.findBySessionId(sessionId);
  }

  addMessage(sessionId: string, message: Omit<CoworkMessage, 'id' | 'timestamp'>): CoworkMessage {
    return this.message.create(sessionId, message);
  }

  updateMessage(sessionId: string, messageId: string, updates: { content?: string; metadata?: CoworkMessageMetadata }): void {
    this.message.update(sessionId, messageId, updates);
  }

  // Config convenience wrappers
  getConfig(): CoworkConfig {
    return this.config.get();
  }

  setConfig(config: CoworkConfigUpdate): void {
    this.config.set(config);
  }

  getAppLanguage(): 'zh' | 'en' {
    return this.config.getAppLanguage();
  }

  // Memory convenience wrappers
  createOrReviveUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: CoworkUserMemorySourceInput;
  }): { memory: CoworkUserMemory; created: boolean; updated: boolean } {
    return (this.memory as any).createOrRevive(input);
  }

  listUserMemories(options?: {
    query?: string;
    status?: CoworkUserMemoryStatus | 'all';
    limit?: number;
    offset?: number;
    includeDeleted?: boolean;
  }): CoworkUserMemory[] {
    return this.memory.list(options);
  }

  createUserMemory(input: {
    text: string;
    confidence?: number;
    isExplicit?: boolean;
    source?: CoworkUserMemorySourceInput;
  }): CoworkUserMemory {
    return this.memory.create(input);
  }

  updateUserMemory(input: {
    id: string;
    text?: string;
    confidence?: number;
    status?: CoworkUserMemoryStatus;
    isExplicit?: boolean;
  }): CoworkUserMemory | null {
    return this.memory.update(input);
  }

  deleteUserMemory(id: string): boolean {
    return this.memory.delete(id);
  }

  getUserMemoryStats(): CoworkUserMemoryStats {
    return this.memory.getStats();
  }

  autoDeleteNonPersonalMemories(): number {
    return this.memory.autoDeleteNonPersonal();
  }

  markMemorySourcesInactiveBySession(sessionId: string): void {
    this.memory.markSourcesInactiveBySession(sessionId);
  }

  markOrphanImplicitMemoriesStale(): void {
    this.memory.markOrphanImplicitStale();
  }

  applyTurnMemoryUpdates(options: ApplyTurnMemoryUpdatesOptions): Promise<ApplyTurnMemoryUpdatesResult> {
    return this.memory.applyTurnUpdates(options);
  }

  conversationSearch(options: {
    query: string;
    maxResults?: number;
    before?: string;
    after?: string;
  }): CoworkConversationSearchRecord[] {
    return this.memory.conversationSearch(options);
  }

  recentChats(options?: {
    n?: number;
    sortOrder?: 'asc' | 'desc';
    before?: string;
    after?: string;
  }): CoworkConversationSearchRecord[] {
    return this.memory.recentChats(options || {});
  }
}
