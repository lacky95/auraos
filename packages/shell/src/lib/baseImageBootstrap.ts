/**
 * Make sure the `aura-base` image exists, and show the user when it doesn't.
 *
 * `docker compose up` builds the image (the build-only `aura-base` service),
 * so on a normal install this finds it and does nothing. When the shell comes
 * up without it — compose run with `--no-deps`, the image pruned, an older
 * checkout — `ensureBaseImage()` builds it in the background and every
 * container spawn waits for it (`ContainerRunner.spawn`). This file is the
 * user-facing half: a locked, pinned AuraOS notification with a progress bar
 * that follows the build, turns into the error plus a Retry button when it
 * fails, and goes away a few seconds after it succeeds.
 *
 *   • NON-FATAL and DETACHED: boot never waits for the build, so the desktop
 *     comes up and can show the notification.
 *   • Locked notifications can't be dismissed, so the id is kept in
 *     `<dataDir>/aura/first-boot/notification-id` and a stale one from a shell
 *     that died mid-build is removed on the next boot.
 *
 * Status and the full build log: GET /api/admin/first-boot (`?log=1`).
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';

type State = import('@aura/core').BaseImageState;

const RETRY_ID = 'retry';
const PROGRESS_ID = 'build';
const UPDATE_EVERY_MS = 1_000;
const READY_LINGER_MS = 6_000;
const LOG_LINES_ON_FAILURE = 40;

const KEY = Symbol.for('aura.baseImageBootstrap');
type G = typeof globalThis & { [KEY]?: true };

export function ensureBaseImageWithNotification(dataDir: string): void {
  const g = globalThis as G;
  // Once per process: soft restarts re-run the middleware bootstrap.
  if (g[KEY]) return;
  if (typeof core.getBaseImage !== 'function') return;
  g[KEY] = true;

  const base = core.getBaseImage({ dataDir });
  const idFile = join(dataDir, 'aura', 'first-boot', 'notification-id');
  const svc = () => core.getNotificationService();

  let notifId: string | null = null;
  let lastSent = 0;
  let pending: ReturnType<typeof setTimeout> | null = null;
  let chain: Promise<unknown> = Promise.resolve();
  // Serialise every notification call: create must land before the first update.
  const queue = (fn: () => Promise<unknown>) => {
    chain = chain.then(fn).catch((err: unknown) => {
      console.warn(`[base-image] notification: ${(err as Error).message}`);
    });
  };

  // A locked notification left by a shell that died mid-build.
  if (existsSync(idFile)) {
    const stale = readFileSync(idFile, 'utf-8').trim();
    rmSync(idFile, { force: true });
    if (stale) queue(() => svc().removeBySender(stale, core.SYSTEM_CALLER));
  }

  const progressComponent = (s: State) => ({
    kind: 'progress' as const, id: PROGRESS_ID, value: s.progress, label: s.step ?? 'Preparing the build…',
  });

  const sendBuilding = (s: State) => queue(async () => {
    const text = `AuraOS is building ${s.image}, the image every app container runs from. This happens once and takes a few minutes; apps start when it is ready.`;
    if (!notifId) {
      const r = await svc().create({
        type: 'locked',
        title: 'Setting up AuraOS',
        text,
        priority: 'high',
        visibility: 'public',
        pinned: true,
        context: { kind: 'installation', id: 'aura-base', label: 'AuraOS setup' },
        components: [progressComponent(s)],
      }, core.SYSTEM_CALLER);
      notifId = r.notification.id;
      try { mkdirSync(join(dataDir, 'aura', 'first-boot'), { recursive: true }); writeFileSync(idFile, notifId); } catch { /* best effort */ }
    } else {
      await svc().update(notifId, {
        title: 'Setting up AuraOS', text, priority: 'high', components: [progressComponent(s)],
      }, core.SYSTEM_CALLER);
    }
    lastSent = Date.now();
  });

  const logTail = (): string => {
    const lines = (base.readLog() ?? '').trimEnd().split('\n');
    return lines.slice(-LOG_LINES_ON_FAILURE).join('\n').replace(/```/g, "'''");
  };

  base.onChange((s) => {
    if (s.phase === 'building') {
      // Throttle step updates; the first one (create) goes out at once.
      if (!notifId || Date.now() - lastSent >= UPDATE_EVERY_MS) { sendBuilding(s); return; }
      if (pending) clearTimeout(pending);
      pending = setTimeout(() => { pending = null; sendBuilding(base.current); }, UPDATE_EVERY_MS);
      return;
    }
    if (pending) { clearTimeout(pending); pending = null; }
    if (s.phase === 'failed' && s.built) {
      if (!notifId) sendBuilding(s); // failed before the first progress line
      queue(async () => {
        if (!notifId) return;
        await svc().update(notifId, {
          title: 'AuraOS setup failed',
          text: `Building ${s.image} failed: ${s.error ?? 'unknown error'}. Apps that run in a container can't start until it is built. Retry, or run \`docker compose build aura-base\` on the host. Full log: /api/admin/first-boot?log=1`,
          priority: 'urgent',
          components: [
            { kind: 'markdown', id: 'log', label: 'Last lines of the build log', text: '```\n' + logTail() + '\n```', maxHeight: 320 },
            { kind: 'button', id: RETRY_ID, label: 'Retry', variant: 'primary' },
          ],
        }, core.SYSTEM_CALLER);
      });
      return;
    }
    if (s.phase === 'ready' && s.built && notifId) {
      const id = notifId;
      queue(() => svc().update(id, {
        title: 'AuraOS is ready',
        text: `${s.image} is built. Apps are starting.`,
        priority: 'medium',
        components: [{ kind: 'progress', id: PROGRESS_ID, value: 1, label: 'Done' }],
      }, core.SYSTEM_CALLER));
      setTimeout(() => queue(async () => {
        await svc().removeBySender(id, core.SYSTEM_CALLER);
        if (notifId === id) notifId = null;
        rmSync(idFile, { force: true });
      }), READY_LINGER_MS);
    }
  });

  // Retry button: the only interactive component on the failed notification.
  core.OsEventBus.on('notification:interacted', (ev) => {
    if (!notifId || ev.id !== notifId || base.current.phase !== 'failed') return;
    void svc().get(ev.id).then((n) => {
      if (n?.lastInteraction?.componentId !== RETRY_ID) return;
      console.log('[base-image] retry requested from the notification');
      void base.ensure().catch(() => undefined);
    }).catch(() => undefined);
  });

  void base.ensure().catch(() => undefined);
}
