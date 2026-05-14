import { createServer } from 'node:net';
import { readFileSync } from 'node:fs';

export class PortAllocator {
  private inUse = new Set<number>();
  private start: number;
  private end: number;

  constructor(start = 4001, end = 4999) {
    this.start = start;
    this.end = end;
  }

  /**
   * Reserve a port from the pool that's BOTH absent from our bookkeeping AND
   * actually free at the OS level. Without the OS-bind check, an orphan
   * astro server squatting an already-released port would be invisible to the
   * allocator and the next spawn would land on top of it — that's the root
   * cause of the wrong-content bug.
   *
   * On first-pass exhaustion we refresh `inUse` from /proc/net/tcp listening
   * sockets and try once more, so allocator drift across restarts can heal
   * itself.
   */
  async allocate(appId: string): Promise<number> {
    for (let pass = 0; pass < 2; pass++) {
      for (let port = this.start; port <= this.end; port++) {
        if (this.inUse.has(port)) continue;
        if (!(await isPortBindable(port))) {
          this.inUse.add(port);
          continue;
        }
        this.inUse.add(port);
        return port;
      }
      this.absorbListeningPortsFromProc();
    }
    throw new Error(`[PortAllocator] No free port available for ${appId} in range ${this.start}-${this.end}`);
  }

  release(port: number): void {
    this.inUse.delete(port);
  }

  isInUse(port: number): boolean {
    return this.inUse.has(port);
  }

  /**
   * Read /proc/net/tcp and /proc/net/tcp6 for sockets in LISTEN state and
   * fold their ports into the inUse set if they fall in our range. Cheap
   * (~kilobytes of text), only runs on allocation pressure.
   */
  private absorbListeningPortsFromProc(): void {
    for (const path of ['/proc/net/tcp', '/proc/net/tcp6']) {
      let text: string;
      try { text = readFileSync(path, 'utf-8'); }
      catch { continue; }
      const lines = text.split('\n').slice(1); // skip header
      for (const line of lines) {
        const cols = line.trim().split(/\s+/);
        const local = cols[1];
        const state = cols[3];
        if (state !== '0A' || !local) continue; // 0A = TCP_LISTEN
        const portHex = local.split(':')[1];
        if (!portHex) continue;
        const port = parseInt(portHex, 16);
        if (port >= this.start && port <= this.end) this.inUse.add(port);
      }
    }
  }
}

function isPortBindable(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const srv = createServer();
    let settled = false;
    const done = (v: boolean) => { if (!settled) { settled = true; resolve(v); } };
    srv.once('error', () => { try { srv.close(); } catch { /* ignore */ } done(false); });
    srv.listen({ port, host: '0.0.0.0', exclusive: true }, () => {
      srv.close(() => done(true));
    });
    setTimeout(() => done(false), 500); // never block the allocator forever
  });
}
