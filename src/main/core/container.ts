import type { KvStore } from '../system/store/kvStore';
import type { CoworkStore } from '../domains/cowork/store';
import type { CoworkRunner } from '../libs/coworkRunner';
import type { SkillManager } from '../domains/skill/skillManager';
import type { McpStore } from '../domains/mcp/store/mcpStore';
import type { IMGatewayManager } from '../domains/im/service/imGatewayManager';
import type { ScheduledTaskStore } from '../domains/scheduled-task/store/scheduledTaskStore';
import type { Scheduler } from '../domains/scheduled-task/service/scheduler';

export interface Container {
  store: KvStore;
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
