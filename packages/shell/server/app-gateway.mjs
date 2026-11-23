// Stub so the router compiles. Stream C's app-gateway.mjs replaces this file.
export const handleAppGateway = (_req, res) => { res.writeHead(501, { 'cache-control': 'no-store' }); res.end(); };
export const handleAppGatewayUpgrade = (_req, socket) => { socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n'); };
export const serveAppRuntime = (_req, res) => { res.writeHead(501, { 'cache-control': 'no-store' }); res.end(); };
