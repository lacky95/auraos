// /mcp/notes — the Notepad MCP server (open tabs + saved notes). Advertised
// by the `provides` entry of the same name in app.manifest.json.
import { createMcpRoute } from '../../mcp/serve';
import { buildNotesServer } from '../../mcp/notes';

export const ALL = createMcpRoute(buildNotesServer);
