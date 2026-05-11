import type { Container } from '../core/container';
import { registerSystemIPC } from '../system/ipc';
import { registerCoworkIPC } from '../domains/cowork/ipc';
import { registerSkillIPC } from '../domains/skill/ipc';
import { registerMcpIPC } from '../domains/mcp/ipc';
import { registerImIPC } from '../domains/im/ipc';
import { registerScheduledTaskIPC } from '../domains/scheduled-task/ipc';
import { registerWindowIPC } from '../core/window';
import { registerApiIPC } from '../core/api';

export function registerIPCHandlers(container: Container): void {
  registerSystemIPC(container);
  registerCoworkIPC(container);
  registerSkillIPC(container);
  registerMcpIPC(container);
  registerImIPC(container);
  registerScheduledTaskIPC(container);
  registerWindowIPC();
  registerApiIPC();
}
