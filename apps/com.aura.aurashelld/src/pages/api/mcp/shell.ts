import { createMcpRoute } from '../../../mcp/serve';
import { buildShellServer } from '../../../mcp/shell';

// Under /api/ on purpose: the OS proxy exposes a SERVICE's /api/* surface
// only — a service has no UI, so `/mcp/shell` would be refused with
// "service-has-no-ui". The manifest's `provides` address matches this path.
export const ALL = createMcpRoute(buildShellServer);
