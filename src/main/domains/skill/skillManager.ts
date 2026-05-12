import { SkillRegistryStore } from './store/registryStore';
import { SkillConfigStore } from './store/configStore';
import { SkillBuilderService } from './service/builderService';
import { SkillWatcherService } from './service/watcherService';
import { KvStore } from '../../system/store/kvStore';
import type { SkillRecord, EmailConnectivityTestResult } from './types';

export class SkillManager {
  private registry: SkillRegistryStore;
  private config: SkillConfigStore;
  private builder: SkillBuilderService;
  private watcher: SkillWatcherService;

  constructor(store: KvStore) {
    this.registry = new SkillRegistryStore(store);
    this.config = new SkillConfigStore(this.registry);
    this.builder = new SkillBuilderService(this.registry);
    this.watcher = new SkillWatcherService();
  }

  getSkillsRoot(): string {
    return this.registry.getSkillsRoot();
  }

  ensureSkillsRoot(): string {
    return this.registry.ensureSkillsRoot();
  }

  syncBundledSkillsToUserData(): void {
    this.registry.syncBundledSkillsToUserData();
  }

  listSkills(): SkillRecord[] {
    return this.registry.listSkills();
  }

  buildAutoRoutingPrompt(): string | null {
    return this.registry.buildAutoRoutingPrompt();
  }

  setSkillEnabled(id: string, enabled: boolean): SkillRecord[] {
    const result = this.registry.setSkillEnabled(id, enabled);
    this.watcher.notifySkillsChanged();
    return result;
  }

  deleteSkill(id: string): SkillRecord[] {
    const result = this.registry.deleteSkill(id);
    this.watcher.notifySkillsChanged();
    return result;
  }

  downloadSkill(source: string): Promise<{ success: boolean; skills?: SkillRecord[]; error?: string }> {
    return this.builder.downloadSkill(source);
  }

  getSkillConfig(skillId: string): { success: boolean; config?: Record<string, string>; error?: string } {
    return this.config.getSkillConfig(skillId);
  }

  setSkillConfig(skillId: string, config: Record<string, string>): { success: boolean; error?: string } {
    return this.config.setSkillConfig(skillId, config);
  }

  testEmailConnectivity(
    skillId: string,
    config: Record<string, string>
  ): Promise<{ success: boolean; result?: EmailConnectivityTestResult; error?: string }> {
    return this.builder.testEmailConnectivity(skillId, config);
  }

  startWatching(): void {
    const primaryRoot = this.registry.ensureSkillsRoot();
    const roots = this.registry.getSkillRoots(primaryRoot);
    this.watcher.startWatching(roots);
  }

  stopWatching(): void {
    this.watcher.stopWatching();
  }

  handleWorkingDirectoryChange(): void {
    const primaryRoot = this.registry.ensureSkillsRoot();
    const roots = this.registry.getSkillRoots(primaryRoot);
    this.watcher.startWatching(roots);
    this.watcher.notifySkillsChanged();
  }
}
