// /mcp/interfaces — the Interface Registry MCP server. Advertised by the
// `provides` entry of the same name in app.manifest.json.
import { createMcpRoute } from '../../mcp/serve';
import { buildInterfacesServer } from '../../mcp/interfaces';

export const ALL = createMcpRoute(buildInterfacesServer);
