import type { SqliteStore } from '../sqliteStore';
import type { CoworkStore } from '../coworkStore';
import type { CoworkRunner } from '../libs/coworkRunner';
import type { SkillManager } from '../skillManager';
import type { McpStore } from '../mcpStore';
import type { IMGatewayManager } from '../im';
import type { ScheduledTaskStore } from '../scheduledTaskStore';
import type { Scheduler } from '../libs/scheduler';

export interface Container {
  store: SqliteStore;
  coworkStore: CoworkStore;
  coworkRunner: CoworkRunner;
  skillManager: SkillManager;
  mcpStore: McpStore;
  imGatewayManager: IMGatewayManager;
  scheduledTaskStore: ScheduledTaskStore;
  scheduler: Scheduler;
}

let container: Container | null = null;

export function setContainer(c: Container): void {
  container = c;
}

export function getContainer(): Container {
  if (!container) {
    throw new Error('Container not initialized. Call setContainer() first.');
  }
  return container;
}
