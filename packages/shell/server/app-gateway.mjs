// Stub so the router compiles. Stream C's app-gateway.mjs replaces this file.
export const handleAppGateway = (_req, res) => { res.writeHead(501, { 'cache-control': 'no-store' }); res.end(); };
export const serveAppRuntime = (_req, res) => { res.writeHead(501, { 'cache-control': 'no-store' }); res.end(); };
