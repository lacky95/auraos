/**
 * AboutDialog — the "About AuraOS" panel that opens when the user clicks the
 * AURAOS logo in the status bar. Mirrors the ViewportSettingsDialog pattern:
 * a React island that listens for a `aura.about.open` CustomEvent (dispatched
 * from the logo click in StatusBar.astro) and flips its own open state, using
 * the shared Radix Dialog primitives from @aura/ui (Esc / click-outside /
 * focus-trap for free).
 *
 * All content is fetched live from `/api/os/about` — the single source shared
 * with the Settings app's About page, so version / git / host never drift.
 * On open we also quietly poll `/api/admin/self-update?check=1` so the dialog
 * can surface a compact "update available" chip when a newer commit exists.
 */
import * as React from 'react';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogBody,
  DialogFooter,
  DialogClose,
  Button,
  Checkbox,
  Icon,
} from '@aura/ui';
import { onOpenRequest } from '../../lib/openRequest';

interface AboutData {
  name: string;
  tagline: string;
  version: string;
  git: {
    commit: string | null;
    branch: string | null;
    subject: string | null;
    committedAt: string | null;
  };
  host: {
    os: string;
    arch: string;
    hostname: string;
    node: string;
    uptimeSec: number;
    cpus: number;
    memTotalBytes: number;
    ips: Array<{ iface: string; address: string; family: string }>;
  };
}

interface Preflight {
  updateAvailable: boolean;
  clean: boolean;
  branch: string;
  behind: number;
  ahead: number;
  currentRev: string | null;
  latestRev: string | null;
  latestSubject: string | null;
  blockers?: string[];
  dirtyFiles?: string[];
}

function fmtUptime(sec: number): string {
  if (!Number.isFinite(sec) || sec <= 0) return '—';
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  return [d && `${d}d`, (d || h) && `${h}h`, `${m}m`].filter(Boolean).join(' ');
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  return `${(n / 1024 ** 3).toFixed(1)} GB`;
}

function Row({ label, children }: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <div style={{ display: 'flex', gap: '12px', padding: '5px 0', borderTop: '1px solid var(--border)' }}>
      <span style={{ flex: '0 0 92px', color: 'var(--text-muted)', letterSpacing: '0.08em', fontSize: '0.62rem' }}>
        {label}
      </span>
      <span style={{ flex: 1, color: 'var(--text-secondary)', fontSize: '0.68rem', wordBreak: 'break-all' }}>
        {children}
      </span>
    </div>
  );
}

export function AboutDialog(): React.JSX.Element {
  const [open, setOpen] = React.useState(false);
  const [data, setData] = React.useState<AboutData | null>(null);
  const [error, setError] = React.useState(false);
  const [preflight, setPreflight] = React.useState<Preflight | null>(null);

  React.useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setError(false);
      setPreflight(null);
      fetch('/api/os/about')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: AboutData) => setData(d))
        .catch(() => setError(true));
      // Preflight runs in parallel. Failures are silent — if the shell can't
      // talk to its own self-update endpoint, we just don't show the chip.
      fetch('/api/admin/self-update?check=1', { cache: 'no-store' })
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((s: { preflight?: Preflight }) => setPreflight(s.preflight ?? null))
        .catch(() => setPreflight(null));
    };
    return onOpenRequest('aura.about.open', onOpen);
  }, []);

  const git = data?.git;
  const host = data?.host;

  // Planned restart (POST /api/admin/restart → lib/plannedRestart.ts): the
  // desktop is saved and comes back after the restart unless unticked. Two
  // clicks — the first arms it — since it takes every activity down.
  const [restore, setRestore] = React.useState(true);
  const [armed, setArmed] = React.useState(false);
  const [restartMsg, setRestartMsg] = React.useState<string | null>(null);
  const [restarting, setRestarting] = React.useState(false);
  React.useEffect(() => { if (!open) { setArmed(false); setRestartMsg(null); } }, [open]);
  const restartOs = async () => {
    if (!armed) { setArmed(true); return; }
    setRestarting(true);
    setRestartMsg(null);
    try {
      const r = await fetch('/api/admin/restart', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ restore }),
      });
      const j = await r.json().catch(() => ({})) as { ok?: boolean; error?: string; activities?: number };
      if (!r.ok || !j.ok) {
        setRestartMsg(j.error ?? (r.status === 401 ? 'needs admin — unlock admin first' : `failed (${r.status})`));
        setRestarting(false);
        setArmed(false);
        return;
      }
      setRestartMsg(restore ? `restarting — your work comes back in a moment (${j.activities ?? 0} activities)` : 'restarting into an empty desktop');
    } catch {
      setRestartMsg('could not reach the shell');
      setRestarting(false);
      setArmed(false);
    }
  };

  // Clicking the chip opens Settings → About (where the actual update happens)
  // and closes this dialog. Two-step so we work whether or not Settings is
  // already running: /start is idempotent — it returns the existing instance
  // if one is up — and /activities uses the Settings app's onActivityCreate
  // dispatcher (section:'about' → /about) to land on the right page.
  const openSettingsAbout = async () => {
    try {
      const r1 = await fetch('/api/apps/com.aura.settings/start', { method: 'POST' });
      const j = await r1.json().catch(() => ({})) as { instanceId?: string };
      if (!r1.ok || !j.instanceId) return;
      await fetch(`/api/instances/${encodeURIComponent(j.instanceId)}/activities`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ data: { section: 'about' } }),
      });
    } finally {
      setOpen(false);
    }
  };

  // Compact preflight chip. Two faces:
  //   • Update available — primary glow, clickable; opens Settings → About.
  //   • Up to date       — dim border, non-interactive; reassurance line.
  // Deliberately smaller than the Settings page banner since this dialog has
  // less room and the actual update action lives on the Settings page.
  const updateChip = (() => {
    if (!preflight) return null;
    if (preflight.updateAvailable) {
      return (
        <button
          type="button"
          onClick={() => { void openSettingsAbout(); }}
          title="Open Settings → About to apply this update"
          style={{
            display: 'block',
            width: 'calc(100% - 32px)',
            textAlign: 'left',
            margin: '12px 16px 0',
            padding: '6px 10px',
            border: '1px solid var(--color-green)',
            boxShadow: 'var(--glow-green)',
            background: 'rgba(0, 255, 65, 0.06)',
            fontFamily: 'var(--font-mono)',
            cursor: 'pointer',
            appearance: 'none',
            outline: 'none',
          }}
        >
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
            <span style={{ color: 'var(--color-green)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: '0.6rem', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
              <Icon name="arrow-up" /> Update available
            </span>
            <span style={{ color: 'var(--text-muted)', fontSize: '0.56rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
              {preflight.behind} new · {preflight.branch}
            </span>
          </div>
          <div style={{ marginTop: '3px', display: 'flex', alignItems: 'baseline', gap: '6px', fontSize: '0.62rem' }}>
            <span style={{ color: 'var(--text-muted)' }}>{(preflight.currentRev ?? '').slice(0, 7)}</span>
            <span style={{ color: 'var(--color-green)' }}>→</span>
            <span style={{ color: 'var(--color-green)' }}>{(preflight.latestRev ?? '').slice(0, 7)}</span>
            {preflight.latestSubject ? (
              <span
                style={{
                  color: 'var(--text-secondary)',
                  opacity: 0.75,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  flex: 1,
                  minWidth: 0,
                }}
                title={preflight.latestSubject}
              >
                · {preflight.latestSubject}
              </span>
            ) : null}
          </div>
        </button>
      );
    }
    // Up to date — same layout as the "available" chip but dimmed and static.
    const cur = (preflight.currentRev ?? '').slice(0, 7);
    const detail = cur
      ? `${cur} · ${preflight.branch}${preflight.ahead ? ` · ${preflight.ahead} ahead` : ''}`
      : preflight.branch;
    return (
      <div
        style={{
          margin: '12px 16px 0',
          padding: '6px 10px',
          border: '1px solid var(--border)',
          background: 'transparent',
          fontFamily: 'var(--font-mono)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px' }}>
          <span style={{ color: 'var(--text-muted)', fontWeight: 700, letterSpacing: '0.12em', textTransform: 'uppercase', fontSize: '0.6rem', display: 'inline-flex', alignItems: 'center', gap: '6px' }}>
            <Icon name="check" /> Up to date
          </span>
          <span style={{ color: 'var(--text-muted)', fontSize: '0.56rem', letterSpacing: '0.06em', textTransform: 'uppercase' }}>
            {detail}
          </span>
        </div>
      </div>
    );
  })();

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="max-w-md gap-0 p-0 flex flex-col">
        <DialogHeader className="shrink-0 border-b border-[var(--border)] px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[var(--color-green)] text-sm tracking-widest uppercase">
            <span aria-hidden="true"><svg className="aura-icon" aria-hidden="true"><use href="/api/os/icons.svg#lucide-info"/></svg></span> ABOUT
          </DialogTitle>
        </DialogHeader>

        <DialogBody className="p-0">
          {/* Hero */}
          <div style={{ textAlign: 'center', padding: '26px 16px 18px' }}>
            <div
              style={{
                fontSize: '2.2rem',
                fontWeight: 700,
                color: 'var(--color-green)',
                textShadow: 'var(--glow-green)',
                letterSpacing: '0.18em',
              }}
            >
              AURAOS
            </div>
            <div
              style={{
                marginTop: '8px',
                fontSize: '0.66rem',
                color: 'var(--text-secondary)',
                letterSpacing: '0.16em',
                textTransform: 'uppercase',
              }}
            >
              {data?.tagline ?? 'A WEB OS WITH ANDROID DNA'}
            </div>
            <div style={{ marginTop: '10px', fontSize: '0.72rem', color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}>
              {data ? `v${data.version}` : error ? 'unavailable' : '…'}
            </div>
          </div>

          {updateChip}

          {/* Details */}
          <div style={{ padding: '12px 16px 12px', fontFamily: 'var(--font-mono)' }}>
            <Row label="OS">{host ? `${host.os} · ${host.arch}` : '—'}</Row>
            <Row label="HOSTNAME">{host?.hostname ?? '—'}</Row>
            <Row label="IP">
              {host?.ips.length
                ? host.ips.map((ip) => (
                    <div key={`${ip.iface}-${ip.address}`}>
                      {ip.address}
                      <span style={{ color: 'var(--text-muted)' }}> · {ip.iface}</span>
                    </div>
                  ))
                : '—'}
            </Row>
            <Row label="NODE">{host?.node ?? '—'}</Row>
            <Row label="UPTIME">{host ? fmtUptime(host.uptimeSec) : '—'}</Row>
            <Row label="MACHINE">{host ? `${host.cpus} CPU · ${fmtBytes(host.memTotalBytes)} RAM` : '—'}</Row>
            <Row label="COMMIT">
              {git?.commit ? (
                <>
                  {git.commit}
                  {git.branch ? <span style={{ color: 'var(--text-muted)' }}> · {git.branch}</span> : null}
                </>
              ) : (
                '—'
              )}
            </Row>
            {git?.subject ? <Row label="MESSAGE">{git.subject}</Row> : null}
          </div>

          {error ? (
            <div style={{ padding: '0 16px 14px', color: 'var(--color-red)', fontSize: '0.66rem' }}>
              Could not load system info.
            </div>
          ) : null}
        </DialogBody>

        <DialogFooter className="shrink-0 border-t border-[var(--border)] px-4 py-3" style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: '10px' }}>
          <div style={{ marginRight: 'auto', fontFamily: 'var(--font-mono)' }}>
            <Checkbox
              id="about-restore"
              checked={restore}
              disabled={restarting}
              onCheckedChange={(v) => setRestore(v === true)}
              label="BRING MY WORK BACK"
            />
          </div>
          <Button variant="EXEC" size="SM" disabled={restarting} onClick={() => { void restartOs(); }}
            title="Save the desktop, restart AuraOS and the Shell Daemon, restore the desktop">
            {restarting ? 'RESTARTING…' : armed ? 'CONFIRM RESTART' : 'RESTART AURAOS'}
          </Button>
          <DialogClose asChild>
            <Button variant="EXEC" size="SM">DONE</Button>
          </DialogClose>
          {restartMsg ? (
            <div style={{ flexBasis: '100%', fontSize: '0.64rem', fontFamily: 'var(--font-mono)', color: restarting ? 'var(--color-green)' : 'var(--color-red)' }}>
              {restartMsg}
            </div>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AboutDialog;
