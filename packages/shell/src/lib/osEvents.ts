/**
 * Single shared Socket.IO channel for OS events — replaces the
 * previous fan-out of 5 parallel `/api/apps/events` SSE streams (theme,
 * kv, app/activity, workspaces, kvClient). Firefox capped us at 6
 * HTTP/1.1 connections per origin and silently dropped the lowest-
 * priority SSE on every reload.
 *
 *   import { osEvents } from '@/lib/osEvents';
 *
 *   const off = osEvents.subscribe('theme:*', (ev) => { ... });
 *   off();                                       // unsubscribe
 *
 *   osEvents.subscribe(['app:*', 'activity:*'], cb);   // multi-topic
 *   osEvents.subscribe('*', cb);                       // firehose
 *
 * Each listener registers a topic pattern (`*` wildcard, `:` separators).
 * The singleton ref-counts patterns and only ever sends the union to
 * the server, so a thousand subscribers cost one WS frame.
 */

import { io, type Socket } from 'socket.io-client';
import { createLogger } from '@aura/core/logger';

const log = createLogger('os-events');

export type TopicPattern = string;
export type OsEvent      = { type: string; [k: string]: unknown };
export type EventHandler = (ev: OsEvent) => void;

interface Subscription {
  patterns: TopicPattern[];
  handler:  EventHandler;
  matchers: RegExp[];
}

function patternToRegExp(p: TopicPattern): RegExp {
  const esc = p.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + esc + '$');
}

class OsEventClient {
  private sock: Socket | null = null;
  private subs = new Set<Subscription>();
  /** Ref-counted topic-pattern union: pattern → number of active subs. */
  private topicRefs = new Map<TopicPattern, number>();
  private lastTopicsSent: string[] = [];

  /**
   * Subscribe to one or more topic patterns. Returns an unsubscribe
   * function. Handler fires for every event whose `type` matches ANY of
   * the patterns. Patterns can be exact (`theme:changed`) or use `*`
   * (`theme:*`, `*`, `kv:*`).
   */
  subscribe(patterns: TopicPattern | TopicPattern[], handler: EventHandler): () => void {
    const list = Array.isArray(patterns) ? patterns : [patterns];
    const sub: Subscription = {
      patterns: list,
      handler,
      matchers: list.map(patternToRegExp),
    };
    this.subs.add(sub);
    for (const p of list) this.topicRefs.set(p, (this.topicRefs.get(p) ?? 0) + 1);
    this.ensureConnected();
    this.maybeResubscribe();
    return () => this.unsubscribe(sub);
  }

  /** Force open the socket without subscribing — useful for warming the connection at boot. */
  warm(): void { this.ensureConnected(); }

  private unsubscribe(sub: Subscription): void {
    if (!this.subs.delete(sub)) return;
    for (const p of sub.patterns) {
      const n = (this.topicRefs.get(p) ?? 0) - 1;
      if (n <= 0) this.topicRefs.delete(p);
      else        this.topicRefs.set(p, n);
    }
    this.maybeResubscribe();
  }

  private ensureConnected(): void {
    if (this.sock) return;
    if (typeof window === 'undefined') return;   // no-op in SSR
    log.info('connecting');
    // path mirrors the server side; transports: ['websocket'] skips the
    // HTTP polling fallback so we don't pile through Astro's request
    // routing and risk a double-response.
    this.sock = io({
      path:        '/os-events',
      transports:  ['websocket'],
      reconnection: true,
      reconnectionDelay:    500,
      reconnectionDelayMax: 4000,
      // Heartbeat-ish: socket.io has its own ping/pong, no work needed.
    });
    this.sock.on('connect',    () => { log.info('open', this.sock?.id); this.maybeResubscribe(true); });
    this.sock.on('disconnect', (r) => log.info('close', r));
    this.sock.on('connect_error', (e) => log.warn('connect-error', e?.message ?? String(e)));
    this.sock.on('event', (ev: OsEvent) => this.dispatch(ev));
  }

  /**
   * Recompute the topic union from `topicRefs` and tell the server only
   * if it actually changed since last send (or `force` is set, used on
   * reconnect to re-establish state on a fresh socket).
   */
  private maybeResubscribe(force = false): void {
    if (!this.sock?.connected) return;
    const topics = [...this.topicRefs.keys()].sort();
    if (!force && sameList(topics, this.lastTopicsSent)) return;
    this.lastTopicsSent = topics;
    // Empty list → unsubscribe from all (server clears matcher; nothing fires).
    // `*` collapses to firehose server-side via parseTopicsParam.
    log.debug('sub', topics.length ? topics : '(none)');
    this.sock.emit('sub', topics);
  }

  private dispatch(ev: OsEvent): void {
    if (!ev || typeof ev.type !== 'string') return;
    for (const sub of this.subs) {
      for (const re of sub.matchers) {
        if (re.test(ev.type)) { try { sub.handler(ev); } catch (err) { log.warn('handler threw', err); } break; }
      }
    }
  }
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

declare global { interface Window { __auraOsEvents?: OsEventClient } }

/**
 * Singleton accessor. Pinned on `window` so the multiple inline scripts
 * in OSLayout / index.astro / ProcessManager all share one Socket.IO
 * connection instead of opening their own.
 */
export function getOsEvents(): OsEventClient {
  if (typeof window === 'undefined') throw new Error('osEvents is browser-only');
  if (!window.__auraOsEvents) window.__auraOsEvents = new OsEventClient();
  return window.__auraOsEvents;
}

export const osEvents = typeof window === 'undefined'
  ? (null as unknown as OsEventClient)   // SSR: importing the module is OK, calling methods is not
  : getOsEvents();
