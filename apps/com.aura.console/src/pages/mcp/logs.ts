import { createMcpRoute } from '../../mcp/serve';
import { buildLogsServer } from '../../mcp/logs';

export const ALL = createMcpRoute(buildLogsServer);
