import { WebSocketServer, WebSocket } from 'ws';
import pty from 'node-pty';

let ptyWss: WebSocketServer | null = null;

export function getPtyWss(): WebSocketServer {
  if (ptyWss) return ptyWss;

  ptyWss = new WebSocketServer({ noServer: true });

  ptyWss.on('connection', (ws: WebSocket) => {
    const shell = process.env['SHELL'] ?? '/bin/bash';
    const term = pty.spawn(shell, [], {
      name: 'xterm-256color',
      cols: 80,
      rows: 24,
      cwd: process.env['HOME'] ?? '/app',
      env: process.env as Record<string, string>,
    });

    term.onData((data) => ws.readyState === WebSocket.OPEN && ws.send(data));
    term.onExit(() => ws.close());

    ws.on('message', (msg: Buffer | string) => {
      const raw = msg.toString();
      try {
        const parsed = JSON.parse(raw) as { type: string; cols?: number; rows?: number; data?: string };
        if (parsed.type === 'resize') {
          term.resize(parsed.cols ?? 80, parsed.rows ?? 24);
        } else if (parsed.type === 'data') {
          term.write(parsed.data ?? '');
        }
      } catch {
        term.write(raw);
      }
    });

    ws.on('close', () => term.kill());
  });

  return ptyWss;
}
