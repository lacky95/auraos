/**
 * Today's home, behind the Home Resolver contract (Phase 5 Stage 1).
 *
 * Every app process gets the one user home (`aura/home/<userId>`, owned by
 * root), whatever the request: exactly what the runners mount before stream
 * H. Stream H replaces this with the real resolver (App Homes, Private Home
 * only in sessions, fail closed).
 */
import { userHomeDir, userHomeSubpath } from '../scopes/home.js';
import { LOGICAL_HOME_PATH, type HomeResolver, type ResolvedHome } from './types.js';

export function legacyHomeResolver(dataDir: string): HomeResolver {
  return {
    resolve: async (): Promise<ResolvedHome> => ({
      kind: 'private',
      hostPath: userHomeDir(dataDir),
      volumeSubpath: userHomeSubpath(),
      logicalPath: LOGICAL_HOME_PATH,
      uid: 0,
      gid: 0,
      mode: 0o755,
    }),
  };
}
