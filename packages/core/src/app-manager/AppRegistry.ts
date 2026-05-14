import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import chokidar from 'chokidar';
import { AppManifestSchema, type AppManifest } from '../types/manifest.js';
import { OsEventBus } from '../ipc/OsEventBus.js';

export class AppRegistry {
  private manifests = new Map<string, AppManifest>();
  private appsDir: string;

  constructor(appsDir: string) {
    this.appsDir = appsDir;
  }

  async init(): Promise<void> {
    // Initial scan
    await this.scanAll();

    // Watch for new/removed apps
    const watcher = chokidar.watch(`${this.appsDir}/*/app.manifest.json`, {
      ignoreInitial: true,
      depth: 1,
    });

    watcher.on('add', (path) => this.loadManifestFile(path));
    watcher.on('change', (path) => this.loadManifestFile(path));
    watcher.on('unlink', (path) => {
      const appId = this.appIdFromPath(path);
      if (appId) {
        this.manifests.delete(appId);
        OsEventBus.emit('app:removed', { appId });
        console.log(`[AppRegistry] Removed: ${appId}`);
      }
    });
  }

  private async scanAll(): Promise<void> {
    const { readdirSync } = await import('node:fs');
    if (!existsSync(this.appsDir)) return;
    const entries = readdirSync(this.appsDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isDirectory()) {
        const manifestPath = join(this.appsDir, entry.name, 'app.manifest.json');
        this.loadManifestFile(manifestPath);
      }
    }
  }

  private loadManifestFile(manifestPath: string): void {
    if (!existsSync(manifestPath)) return;
    try {
      const raw = JSON.parse(readFileSync(manifestPath, 'utf-8'));
      const manifest = AppManifestSchema.parse(raw);
      const isNew = !this.manifests.has(manifest.id);
      this.manifests.set(manifest.id, manifest);
      if (isNew) OsEventBus.emit('app:installed', { appId: manifest.id });
      console.log(`[AppRegistry] Loaded: ${manifest.id} v${manifest.version}`);
    } catch (err) {
      console.error(`[AppRegistry] Invalid manifest at ${manifestPath}:`, err);
    }
  }

  private appIdFromPath(manifestPath: string): string | null {
    for (const [id, manifest] of this.manifests) {
      const expected = join(this.appsDir, id, 'app.manifest.json');
      if (manifestPath === expected) return id;
    }
    return null;
  }

  getAll(): AppManifest[] {
    return Array.from(this.manifests.values());
  }

  getById(id: string): AppManifest | undefined {
    return this.manifests.get(id);
  }

  has(id: string): boolean {
    return this.manifests.has(id);
  }

  getAppDir(id: string): string {
    return join(this.appsDir, id);
  }
}
