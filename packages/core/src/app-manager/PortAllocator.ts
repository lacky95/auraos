export class PortAllocator {
  private inUse = new Set<number>();
  private start: number;
  private end: number;

  constructor(start = 4001, end = 4999) {
    this.start = start;
    this.end = end;
  }

  allocate(appId: string): number {
    for (let port = this.start; port <= this.end; port++) {
      if (!this.inUse.has(port)) {
        this.inUse.add(port);
        return port;
      }
    }
    throw new Error(`[PortAllocator] No free port available for ${appId} in range ${this.start}-${this.end}`);
  }

  release(port: number): void {
    this.inUse.delete(port);
  }

  isInUse(port: number): boolean {
    return this.inUse.has(port);
  }
}
