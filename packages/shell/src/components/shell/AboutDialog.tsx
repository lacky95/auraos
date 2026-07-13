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
} from '@aura/ui';

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

  React.useEffect(() => {
    const onOpen = () => {
      setOpen(true);
      setError(false);
      fetch('/api/os/about')
        .then((r) => (r.ok ? r.json() : Promise.reject(new Error(String(r.status)))))
        .then((d: AboutData) => setData(d))
        .catch(() => setError(true));
    };
    window.addEventListener('aura.about.open', onOpen);
    return () => window.removeEventListener('aura.about.open', onOpen);
  }, []);

  const git = data?.git;
  const host = data?.host;

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent aria-describedby={undefined} className="max-w-md gap-0 p-0 flex flex-col">
        <DialogHeader className="shrink-0 border-b border-[var(--border)] px-4 py-3">
          <DialogTitle className="flex items-center gap-2 text-[var(--color-green)] text-sm tracking-widest uppercase">
            <span aria-hidden="true">ⓘ</span> ABOUT
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

          {/* Details */}
          <div style={{ padding: '0 16px 12px', fontFamily: 'var(--font-mono)' }}>
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

        <DialogFooter className="shrink-0 border-t border-[var(--border)] px-4 py-3">
          <DialogClose asChild>
            <Button variant="EXEC" size="SM">DONE</Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export default AboutDialog;
