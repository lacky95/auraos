/**
 * An instance's own output, for runtimes without an engine log (PRoot): a
 * per-instance ring of the newest chunks, read and followed by
 * `GET /api/instances/:id/logs` (Phase 5 stream X). Container instances use
 * the engine's log instead (DockerApi `logs`).
 */

export type OutputStream = 'out' | 'err';

export interface OutputChunk {
  stream: OutputStream;
  /** ms since the epoch. */
  at: number;
  data: string;
}

export interface OutputReadOpts {
  /** The last n lines. */
  tail?: number;
  /** Only chunks at or after this time (UNIX seconds). */
  since?: number;
  timestamps?: boolean;
}

export const OUTPUT_LOG_BYTES = 256 * 1024;

export class OutputLog {
  private chunks: OutputChunk[] = [];
  private bytes = 0;
  private readonly followers = new Set<(c: OutputChunk) => void>();

  constructor(private readonly maxBytes = OUTPUT_LOG_BYTES, private readonly now: () => number = Date.now) {}

  push(stream: OutputStream, data: string): void {
    if (!data) return;
    const chunk = { stream, at: this.now(), data };
    this.chunks.push(chunk);
    this.bytes += data.length;
    while (this.bytes > this.maxBytes && this.chunks.length > 1) this.bytes -= this.chunks.shift()!.data.length;
    for (const f of this.followers) { try { f(chunk); } catch { /* a follower's own problem */ } }
  }

  /** The buffered output, line-split for `tail`, each line as one chunk. */
  read(opts: OutputReadOpts = {}): OutputChunk[] {
    const sinceMs = opts.since !== undefined ? opts.since * 1000 : -Infinity;
    const lines: OutputChunk[] = [];
    for (const c of this.chunks) {
      if (c.at < sinceMs) continue;
      for (const part of c.data.split(/(?<=\n)/)) if (part) lines.push({ ...c, data: part });
    }
    const kept = opts.tail !== undefined ? lines.slice(Math.max(0, lines.length - opts.tail)) : lines;
    return opts.timestamps ? kept.map((c) => ({ ...c, data: stamp(c) })) : kept;
  }

  /** Every new chunk until the returned function is called. */
  follow(onChunk: (c: OutputChunk) => void, opts: { timestamps?: boolean } = {}): () => void {
    const f = opts.timestamps ? (c: OutputChunk) => onChunk({ ...c, data: stamp(c) }) : onChunk;
    this.followers.add(f);
    return () => { this.followers.delete(f); };
  }
}

const stamp = (c: OutputChunk): string => `${new Date(c.at).toISOString()} ${c.data}`;
