import type { AppManifest } from '../types/manifest.js';

export type ScopeId = 'system' | 'global' | 'user';

export interface ScopeDefinition {
  id:        ScopeId;
  appsDir:   string;
  dataDir:   string;
  immutable: boolean;
  priority:  0 | 1 | 2;
}

/** In-memory only — NOT persisted to app.manifest.json. */
export interface ScopedManifest extends AppManifest {
  scopeId: ScopeId;
  /** Absolute path: <scope.appsDir>/<appId> */
  appDir:  string;
}

/** Passed to runner.spawn() so scope-aware paths flow from AppManager. */
export interface SpawnContext {
  /** Absolute path: <scope.appsDir>/<appId> */
  appDir:          string;
  /** Absolute path: <scope.dataDir>/apps/<appId>/<instanceId> */
  instanceDataDir: string;
}
