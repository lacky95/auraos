/**
 * Read + apply pre-registered Nexus sources (rules: nexusSeeds.ts).
 * Runs once after shell boot (middleware) and on demand
 * (POST /api/nexus/sources/seeds). Never throws; problems are reported.
 */
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
// Namespace import: the running shell may cache a core build without newer exports.
import * as core from '@aura/core';
import type { SourcesConfig } from '@aura/core';
import { dedupeSeeds, mergeSeeds, parseSeedDoc, type SeedEntry, type SeedEnv, type SeedProblem, type SeedState } from './nexusSeeds.js';
import { probeGitApp } from './nexusGitApp.js';
import { credentialsLoaded } from './nexusSourceLogin.js';

const OS_API_BASE = process.env['OS_API_BASE'] ?? 'http://localhost:3000';
const DATA_DIR    = process.env['AURA_DATA_DIR'] ?? '/data';
const STATE_KV    = '/api/kv/os/nexus/source-seeds';

export const SEED_ENV_VAR = 'AURA_NEXUS_SOURCES';
/** Lowest precedence first. */
export function seedDirs(): string[] {
  return [
    process.env['AURA_NEXUS_SEED_DIR_INSTALL'] ?? '/etc/aura/nexus/sources.d',
    join(DATA_DIR, 'nexus', 'sources.d'),
  ];
}

const io: SeedEnv = {
  env: process.env,
  readFile: (p) => readFileSync(p, 'utf8'),
  hash: (s) => createHash('sha256').update(s).digest('hex').slice(0, 32),
};

export interface SeedFileReport { origin: string; entries: string[]; problems: SeedProblem[] }
export interface SeedReport {
  files:    SeedFileReport[];
  seeds:    Array<{ name: string; policy: SeedEntry['policy']; origin: string; kind: string; url: string; login: boolean }>;
  problems: SeedProblem[];
  changes:  string[];
  appliedAt?: string;
}

/** Collect every seed, in precedence order, with per-file reports. */
export function readSeeds(): { seeds: SeedEntry[]; files: SeedFileReport[]; problems: SeedProblem[] } {
  const all: SeedEntry[] = [];
  const files: SeedFileReport[] = [];
  const problems: SeedProblem[] = [];
  const take = (text: string, origin: string) => {
    const r = parseSeedDoc(text, origin, io);
    all.push(...r.seeds);
    problems.push(...r.problems);
    files.push({ origin, entries: r.seeds.map((s) => s.entry.name), problems: r.problems });
  };
  for (const dir of seedDirs()) {
    if (!existsSync(dir)) continue;
    let names: string[] = [];
    try { names = readdirSync(dir).filter((n) => n.endsWith('.json')).sort(); }
    catch (err) { problems.push({ origin: dir, detail: `cannot list: ${(err as Error).message}` }); continue; }
    for (const n of names) {
      const p = join(dir, n);
      try { take(readFileSync(p, 'utf8'), p); }
      catch (err) { problems.push({ origin: p, detail: `cannot read: ${(err as Error).message}` }); }
    }
  }
  const envVal = process.env[SEED_ENV_VAR]?.trim();
  if (envVal) {
    const origin = `env:${SEED_ENV_VAR}`;
    if (envVal.startsWith('/')) {
      try { take(readFileSync(envVal, 'utf8'), `${origin}=${envVal}`); }
      catch (err) { problems.push({ origin, detail: `cannot read ${envVal}: ${(err as Error).message}` }); }
    } else {
      take(envVal, origin);
    }
  }
  return { seeds: dedupeSeeds(all), files, problems };
}

async function loadState(): Promise<SeedState> {
  try {
    const r = await fetch(`${OS_API_BASE}${STATE_KV}`);
    if (!r.ok) return {};
    const v = (await r.json() as { value?: unknown }).value;
    return v && typeof v === 'object' ? v as SeedState : {};
  } catch { return {}; }
}
async function saveState(state: SeedState): Promise<void> {
  await fetch(`${OS_API_BASE}${STATE_KV}`, {
    method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ value: state }),
  });
}

// On globalThis: middleware and API routes can load this module in different
// module graphs (Vite SSR vs. Node), and must share one report + one run.
const G_KEY = Symbol.for('aura.nexus.sourceSeeds');
type SeedGlobal = { last: SeedReport | null; running: Promise<SeedReport> | null };
const g = (): SeedGlobal => ((globalThis as { [G_KEY]?: SeedGlobal })[G_KEY] ??= { last: null, running: null });

/** The outcome of the last apply (for the Nexus UI). */
export function lastSeedReport(): SeedReport | null { return g().last; }

/** Read all seeds and merge them into the sources config. Serialised. */
export function applySourceSeeds(): Promise<SeedReport> {
  const st = g();
  st.running ??= (async () => {
    try { return await applyOnce(); }
    finally { st.running = null; }
  })();
  return st.running;
}

async function applyOnce(): Promise<SeedReport> {
  const { seeds, files, problems } = readSeeds();
  const report: SeedReport = {
    files,
    seeds: seeds.map((s) => ({
      name: s.entry.name, policy: s.policy, origin: s.origin, kind: s.entry.kind, url: s.entry.url, login: !!s.login,
    })),
    problems: [...problems],
    changes: [],
  };
  try {
    const cfg = await core.loadSourcesConfig(OS_API_BASE);
    const state = await loadState();
    const res = mergeSeeds(cfg, seeds, state);
    const config: SourcesConfig = res.config;

    for (const name of res.probe) {
      const src = config.sources.find((s) => s.name === name);
      if (src?.kind !== 'git-app') continue;
      try { src.appMeta = probeGitApp(src.url, src.ref); }
      catch (err) { report.problems.push({ origin: name, detail: `git-app probe failed: ${(err as Error).message}` }); }
    }
    for (const l of res.logins) {
      const src = config.sources.find((s) => s.name === l.name);
      if (src?.kind !== 'oci') continue;
      try { src.auth = await core.saveRegistryLogin(DATA_DIR, l.name, l.url, l.login); }
      catch (err) { report.problems.push({ origin: l.name, detail: `cannot seal login: ${(err as Error).message}` }); }
    }

    const before = JSON.stringify(cfg);
    if (JSON.stringify(config) !== before) {
      await core.saveSourcesConfig(OS_API_BASE, config);
      core.refreshNexusSources(config);
    }
    for (const a of res.dropAuth) await core.deleteRegistryLogin(DATA_DIR, a).catch(() => undefined);
    if (JSON.stringify(res.state) !== JSON.stringify(state)) await saveState(res.state);
    if (res.logins.length) await credentialsLoaded();
    report.changes = res.changes;
  } catch (err) {
    report.problems.push({ origin: 'apply', detail: (err as Error).message });
  }
  report.appliedAt = new Date().toISOString();
  for (const c of report.changes) console.log(`[nexus-seeds] ${c}`);
  for (const p of report.problems) console.warn(`[nexus-seeds] ${p.origin}: ${p.detail}`);
  g().last = report;
  return report;
}
