import { createMcpRoute } from '../../mcp/serve';
import { buildTerminalServer } from '../../mcp/terminal';

export const ALL = createMcpRoute(buildTerminalServer);
