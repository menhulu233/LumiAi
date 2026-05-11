import fs from 'fs';
import path from 'path';
import { SkillRegistryStore } from './registryStore';

export class SkillConfigStore {
  constructor(private registry: SkillRegistryStore) {}

  getSkillConfig(skillId: string): { success: boolean; config?: Record<string, string>; error?: string } {
    try {
      const skillDir = this.registry.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      if (!fs.existsSync(envPath)) {
        return { success: true, config: {} };
      }
      const raw = fs.readFileSync(envPath, 'utf8');
      const config: Record<string, string> = {};
      for (const line of raw.split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#')) continue;
        const eqIdx = trimmed.indexOf('=');
        if (eqIdx < 0) continue;
        const key = trimmed.slice(0, eqIdx).trim();
        const value = trimmed.slice(eqIdx + 1).trim();
        config[key] = value;
      }
      return { success: true, config };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to read skill config' };
    }
  }

  setSkillConfig(skillId: string, config: Record<string, string>): { success: boolean; error?: string } {
    try {
      const skillDir = this.registry.resolveSkillDir(skillId);
      const envPath = path.join(skillDir, '.env');
      const lines = Object.entries(config)
        .filter(([key]) => key.trim())
        .map(([key, value]) => `${key}=${value}`);
      fs.writeFileSync(envPath, lines.join('\n') + '\n', 'utf8');
      return { success: true };
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : 'Failed to write skill config' };
    }
  }
}
