import type { Command } from 'commander';
import { existsSync, readFileSync, readdirSync, readlinkSync, statSync } from 'node:fs';
import { hostname, networkInterfaces, totalmem, freemem, uptime as osUptime, userInfo } from 'node:os';
import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { color } from '../lib/format.js';

function safeRead(path: string): string | null {
  try { return readFileSync(path, 'utf-8'); } catch { return null; }
}
function safeReadLink(path: string): string | null {
  try { return readlinkSync(path); } catch { return null; }
}
function safeReadFirstLine(path: string): string | null {
  const text = safeRead(path);
  return text ? text.split('\n')[0]?.trim() ?? null : null;
}
function safeSh(cmd: string): string | null {
  try { return execSync(cmd, { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim(); }
  catch { return null; }
}
function fmtBytes(n: number): string {
  const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(v < 10 ? 2 : v < 100 ? 1 : 0)} ${units[i]}`;
}
function fmtDuration(seconds: number): string {
  const s = Math.floor(seconds);
  const d = Math.floor(s / 86400);
  const h = Math.floor((s % 86400) / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const parts: string[] = [];
  if (d) parts.push(`${d}d`);
  if (h) parts.push(`${h}h`);
  if (m) parts.push(`${m}m`);
  parts.push(`${sec}s`);
  return parts.join(' ');
}

function detectProot(): { inside: boolean; tracerPid: number; tracerCmdline: string | null; rootfs: string | null } {
  const status = safeRead('/proc/self/status') ?? '';
  const m = status.match(/^TracerPid:\s+(\d+)/m);
  const tracerPid = m ? Number(m[1]) : 0;
  if (tracerPid === 0) return { inside: false, tracerPid: 0, tracerCmdline: null, rootfs: null };
  const cmdline = safeRead(`/proc/${tracerPid}/cmdline`)?.replace(/\0/g, ' ').trim() ?? null;
  const isProot = !!cmdline && /(^|\/)proot(\s|$)/.test(cmdline);
  const rootfsMatch = cmdline?.match(/--rootfs=([^\s]+)/);
  return { inside: isProot, tracerPid, tracerCmdline: cmdline, rootfs: rootfsMatch?.[1] ?? null };
}

function detectContainer(): { inside: boolean; kind: string; signals: string[] } {
  const signals: string[] = [];
  let kind = 'none';
  if (existsSync('/.dockerenv'))         { signals.push('/.dockerenv');         kind = 'docker';   }
  if (existsSync('/run/.containerenv'))  { signals.push('/run/.containerenv');  kind = 'podman';   }
  const cgroup = safeRead('/proc/1/cgroup') ?? '';
  if (/docker/.test(cgroup))     { signals.push('cgroup:docker');     kind = kind === 'none' ? 'docker'     : kind; }
  if (/kubepods/.test(cgroup))   { signals.push('cgroup:kubepods');   kind = 'kubernetes'; }
  if (/containerd/.test(cgroup)) { signals.push('cgroup:containerd'); }
  if (/lxc/.test(cgroup))        { signals.push('cgroup:lxc');        kind = kind === 'none' ? 'lxc'        : kind; }
  const pid1Comm = safeReadFirstLine('/proc/1/comm');
  if (pid1Comm && pid1Comm !== 'systemd' && pid1Comm !== 'init') signals.push(`pid1=${pid1Comm}`);
  const host = hostname();
  if (/^[0-9a-f]{12}$/.test(host)) signals.push(`hostname=${host} (Docker hex)`);
  const inside = signals.length > 0 && (kind !== 'none' || /docker|kubepods|containerd|lxc/.test(cgroup));
  return { inside, kind, signals };
}

function detectVirt(): { hypervisor: boolean; vendor: string | null; product: string | null } {
  const cpuinfo = safeRead('/proc/cpuinfo') ?? '';
  return {
    hypervisor: /\bhypervisor\b/.test(cpuinfo),
    vendor:  safeReadFirstLine('/sys/class/dmi/id/sys_vendor'),
    product: safeReadFirstLine('/sys/class/dmi/id/product_name'),
  };
}

function osInfo(): Record<string, string> {
  const out: Record<string, string> = {};
  const rel = safeRead('/etc/os-release') ?? '';
  const get = (k: string) => rel.match(new RegExp(`^${k}=("?)(.*?)\\1$`, 'm'))?.[2];
  const pretty = get('PRETTY_NAME');
  if (pretty) out['distro'] = pretty;
  const kernel = safeSh('uname -srm');
  if (kernel) out['kernel'] = kernel;
  out['hostname'] = hostname();
  return out;
}

function cpuInfo(): Record<string, string> {
  const text = safeRead('/proc/cpuinfo') ?? '';
  const model   = text.match(/^model name\s*:\s*(.+)$/m)?.[1] ?? null;
  const vendor  = text.match(/^vendor_id\s*:\s*(.+)$/m)?.[1] ?? null;
  const cores   = (text.match(/^processor\s*:/gm) ?? []).length;
  const flagsM  = text.match(/^flags\s*:\s*(.+)$/m)?.[1] ?? '';
  const flags   = flagsM.split(/\s+/).filter(Boolean);
  const noted   = ['hypervisor', 'vmx', 'svm', 'avx', 'avx2', 'avx512f', 'aes'].filter((f) => flags.includes(f));
  const out: Record<string, string> = {};
  if (model)  out['model'] = model;
  if (vendor) out['vendor'] = vendor;
  out['cores'] = String(cores);
  if (noted.length) out['notable flags'] = noted.join(', ');
  return out;
}

function memInfo(): Record<string, string> {
  const out: Record<string, string> = {};
  out['total'] = fmtBytes(totalmem());
  out['free']  = fmtBytes(freemem());
  out['used']  = fmtBytes(totalmem() - freemem());
  const meminfo = safeRead('/proc/meminfo') ?? '';
  const available = meminfo.match(/^MemAvailable:\s+(\d+)\s+kB/m)?.[1];
  if (available) out['available'] = fmtBytes(Number(available) * 1024);
  return out;
}

function netInfo(): Record<string, string> {
  const out: Record<string, string> = {};
  const ifs = networkInterfaces();
  const lines: string[] = [];
  for (const [name, addrs] of Object.entries(ifs)) {
    if (!addrs) continue;
    for (const a of addrs) {
      if (a.internal) continue;
      lines.push(`${name} ${a.family} ${a.address}${a.cidr ? '/' + a.cidr.split('/')[1] : ''}`);
    }
  }
  if (lines.length) out['addresses'] = lines.join('  |  ');
  const route = safeSh('ip route show default 2>/dev/null | head -1');
  if (route) out['default route'] = route;
  const resolv = safeRead('/etc/resolv.conf') ?? '';
  const dns = [...resolv.matchAll(/^nameserver\s+(\S+)/gm)].map((m) => m[1]).filter(Boolean);
  if (dns.length) out['dns'] = dns.join(', ');
  return out;
}

function namespaces(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const ns of ['mnt', 'pid', 'net', 'user', 'ipc', 'uts', 'cgroup', 'time']) {
    const v = safeReadLink(`/proc/self/ns/${ns}`);
    if (v) out[ns] = v;
  }
  return out;
}

function procContext(): Record<string, string> {
  const out: Record<string, string> = {};
  const u = userInfo();
  out['user'] = `${u.username} (uid=${u.uid}, gid=${u.gid})`;
  out['pid'] = String(process.pid);
  out['ppid'] = String(process.ppid);
  out['cwd'] = process.cwd();
  out['shell'] = process.env['SHELL'] ?? '(unset)';
  out['$PATH first 3'] = (process.env['PATH'] ?? '').split(':').slice(0, 3).join(':');
  return out;
}

function auraContext(): Record<string, string> {
  const out: Record<string, string> = {};
  const keys = [
    'APP_ID', 'APP_INSTANCE_ID', 'APP_PORT',
    'OS_API_BASE',
    'AURA_APPS_DIR', 'AURA_DATA_DIR', 'AURA_BASE_ROOTFS', 'AURA_TOOLCHAIN_DIR',
    'AURA_USE_PROOT', 'AURA_AUTH_MODE',
    'AURA_APP_PORT_START', 'AURA_APP_PORT_END',
    'AURA_SHELL_URL',
  ];
  for (const k of keys) {
    if (process.env[k]) out[k] = process.env[k] as string;
  }
  return out;
}

function timeInfo(): Record<string, string> {
  const out: Record<string, string> = {};
  out['now'] = new Date().toISOString();
  out['process uptime'] = fmtDuration(process.uptime());
  out['kernel uptime']  = fmtDuration(osUptime());
  return out;
}

function mountsOfInterest(): Record<string, string> {
  const out: Record<string, string> = {};
  const text = safeRead('/proc/self/mounts') ?? '';
  for (const line of text.split('\n')) {
    const parts = line.split(/\s+/);
    const [src, dst, fs] = parts;
    if (!dst) continue;
    if (dst === '/' || dst.startsWith('/workspace') || dst.startsWith('/data') || dst === '/proc' || dst === '/sys' || dst === '/dev') {
      out[dst] = `${src} (${fs})`;
    }
  }
  return out;
}

function capabilitiesPresent(): Record<string, string> {
  const out: Record<string, string> = {};
  const tools = ['bash', 'node', 'git', 'curl', 'ssh', 'rg', 'jq', 'htop', 'fzf', 'gh', 'bun', 'claude', 'aura'];
  for (const t of tools) {
    const path = safeSh(`command -v ${t} 2>/dev/null`);
    if (path) {
      let version: string | null = null;
      try {
        const v = execSync(`${t} --version 2>&1`, { stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 }).toString();
        version = v.split('\n')[0]?.slice(0, 60) ?? null;
      } catch { /* tools that need args / hang */ }
      out[t] = `${path}${version ? '  → ' + version : ''}`;
    }
  }
  return out;
}

function diskUsage(paths: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of paths) {
    if (!existsSync(p)) continue;
    try {
      const s = statSync(p);
      out[p] = s.isDirectory() ? `dir, mode=${(s.mode & 0o7777).toString(8)}` : `${fmtBytes(s.size)} mode=${(s.mode & 0o7777).toString(8)}`;
    } catch { /* skip */ }
  }
  return out;
}

function section(title: string, body: Record<string, string>): void {
  console.log(color.bold(title));
  const maxKey = Math.max(0, ...Object.keys(body).map((k) => k.length));
  for (const [k, v] of Object.entries(body)) {
    console.log(`  ${k.padEnd(maxKey)}  ${v}`);
  }
  if (Object.keys(body).length === 0) console.log(`  ${color.dim('(none)')}`);
  console.log();
}

export function registerWhereami(program: Command): void {
  program
    .command('whereami')
    .description('Detailed snapshot of the current execution context: layers, OS, CPU, memory, namespaces, AuraOS env, mounts, tools.')
    .option('--json', 'Emit raw JSON instead of the formatted report')
    .action((opts: { json?: boolean }) => {
      const proot     = detectProot();
      const container = detectContainer();
      const virt      = detectVirt();
      const data = {
        proot,
        container,
        virt,
        os: osInfo(),
        cpu: cpuInfo(),
        mem: memInfo(),
        net: netInfo(),
        namespaces: namespaces(),
        process: procContext(),
        aura: auraContext(),
        time: timeInfo(),
        mounts: mountsOfInterest(),
        capabilities: capabilitiesPresent(),
        paths: diskUsage(['/data', '/workspace', '/os/base-rootfs', '/os/toolchain']),
      };

      if (opts.json) {
        console.log(JSON.stringify(data, null, 2));
        return;
      }

      console.log(color.bold('AuraOS — whereami'));
      console.log(color.dim('  snapshot at ' + data.time['now']));
      console.log();

      console.log(color.bold('Layers'));
      console.log(`  PRoot      ${proot.inside ? color.green('yes') : color.dim('no')}`);
      if (proot.inside) {
        console.log(`    tracer pid     ${proot.tracerPid}`);
        if (proot.rootfs) console.log(`    rootfs         ${proot.rootfs}`);
        if (proot.tracerCmdline) {
          const short = proot.tracerCmdline.length > 220 ? proot.tracerCmdline.slice(0, 217) + '…' : proot.tracerCmdline;
          console.log(`    tracer cmdline ${color.dim(short)}`);
        }
      }
      console.log(`  Container  ${container.inside ? color.green(container.kind) : color.dim('no')}`);
      for (const s of container.signals) console.log(`    ${color.dim(s)}`);
      console.log(`  Virt/Host  ${virt.hypervisor ? color.yellow('VM/hypervisor present') : color.green('bare metal (or hidden)')}`);
      if (virt.vendor)  console.log(`    sys_vendor     ${virt.vendor}`);
      if (virt.product) console.log(`    product_name   ${virt.product}`);
      console.log();

      section('OS', data.os);
      section('CPU', data.cpu);
      section('Memory', data.mem);
      section('Network', data.net);
      section('Namespaces', data.namespaces);
      section('Process', data.process);
      section('AuraOS env', data.aura);
      section('Time', data.time);
      section('Mounts of interest', data.mounts);
      section('Paths', data.paths);
      section('Capabilities on PATH', data.capabilities);
    });
}
