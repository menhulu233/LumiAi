import fs from 'fs';
import { broadcastToAllWindows } from '../../../core/broadcaster';

const WATCH_DEBOUNCE_MS = 250;

export class SkillWatcherService {
  private watchers: fs.FSWatcher[] = [];
  private notifyTimer: NodeJS.Timeout | null = null;

  startWatching(roots: string[]): void {
    this.stopWatching();

    const watchHandler = () => this.scheduleNotify();
    roots.forEach(root => {
      if (!fs.existsSync(root)) return;
      try {
        this.watchers.push(fs.watch(root, watchHandler));
      } catch (error) {
        console.warn('[skills] Failed to watch skills root:', root, error);
      }

      // Watch individual skill directories too
      try {
        const entries = fs.readdirSync(root);
        entries.forEach(entry => {
          const dir = require('path').join(root, entry);
          try {
            const stat = fs.lstatSync(dir);
            if (stat.isDirectory() || stat.isSymbolicLink()) {
              this.watchers.push(fs.watch(dir, watchHandler));
            }
          } catch (error) {
            console.warn('[skills] Failed to watch skill directory:', dir, error);
          }
        });
      } catch (error) {
        console.warn('[skills] Failed to list skill directories for watching:', root, error);
      }
    });
  }

  stopWatching(): void {
    this.watchers.forEach(watcher => watcher.close());
    this.watchers = [];
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
      this.notifyTimer = null;
    }
  }

  notifySkillsChanged(): void {
    broadcastToAllWindows('skills:changed');
  }

  private scheduleNotify(): void {
    if (this.notifyTimer) {
      clearTimeout(this.notifyTimer);
    }
    this.notifyTimer = setTimeout(() => {
      this.notifySkillsChanged();
    }, WATCH_DEBOUNCE_MS);
  }
}
