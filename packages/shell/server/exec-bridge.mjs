/**
 * The exec bridge: `WS /api/instances/:id/session`, subprotocol
 * `aura.exec.v1` (Phase 5 stream X; `aura jump`, `aura exec` without the
 * Docker socket, D74). Surface `exec-bridge` in src/lib/access/surfaceManifest.ts.
 *
 * Stage 1 hooks the path in once, so stream X replaces this file and touches
 * neither attach.mjs nor the surface list. Until then every upgrade on the
 * path is answered 501 and closed: nothing is executed.
 */

/** `/api/instances/<id>/session`, query allowed. */
export const EXEC_BRIDGE_PATH = /^\/api\/instances\/[^/?]+\/session(?:\?.*)?$/;

export function attachExecBridge(httpServer) {
  httpServer.on('upgrade', (req, socket) => {
    if (!EXEC_BRIDGE_PATH.test(req.url ?? '')) return;
    socket.end('HTTP/1.1 501 Not Implemented\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
  });
}
