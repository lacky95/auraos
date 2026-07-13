import type { APIRoute } from 'astro';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * GET /api/os/about — the single source of truth for the About panel.
 *
 * Everything is read DYNAMICALLY at request time so it always reflects the
 * running system:
 *   • version — repo root package.json
 *   • git     — current HEAD commit / branch of the AuraOS checkout at /workspace
 *   • host    — OS / hostname / IPs / node / uptime via node:os
 *
 * Consumed by BOTH the shell's About dialog (logo click) and the Settings app's
 * About page, so the two never drift.
 */

const WORKSPACE = process.env['AURA_APPS_DIR']
  ? join(process.env['AURA_APPS_DIR'], '..')
  : '/workspace';

interface GitInfo {
  commit: string | null;
  commitFull: string | null;
  branch: string | null;
  subject: string | null;
  committedAt: string | null;
}

function resolveVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(WORKSPACE, 'package.json'), 'utf-8')) as { version?: string };
    return typeof pkg.version === 'string' ? pkg.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function git(args: string[]): string | null {
  try {
    const out = execFileSync('git', ['-C', WORKSPACE, ...args], {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 2000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

function resolveGit(): GitInfo {
  // One call for the commit fields (unit-separated), one for the branch.
  const line = git(['log', '-1', '--format=%h%x1f%H%x1f%cI%x1f%s']);
  const [commit, commitFull, committedAt, subject] = line ? line.split('\x1f') : [];
  return {
    commit: commit ?? null,
    commitFull: commitFull ?? null,
    branch: git(['rev-parse', '--abbrev-ref', 'HEAD']),
    subject: subject ?? null,
    committedAt: committedAt ?? null,
  };
}

function resolveHost() {
  const ips: Array<{ iface: string; address: string; family: string }> = [];
  for (const [iface, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.internal) continue;
      ips.push({ iface, address: a.address, family: String(a.family) });
    }
  }
  return {
    os: `${os.type()} ${os.release()}`,
    platform: os.platform(),
    arch: os.arch(),
    hostname: os.hostname(),
    node: process.version,
    uptimeSec: Math.round(os.uptime()),
    cpus: os.cpus().length,
    memTotalBytes: os.totalmem(),
    ips,
  };
}

export const GET: APIRoute = () => {
  const body = {
    name: 'AuraOS',
    tagline: 'A WEB OS WITH ANDROID DNA',
    version: resolveVersion(),
    git: resolveGit(),
    host: resolveHost(),
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
};
