const useColor = process.stdout.isTTY && process.env['NO_COLOR'] !== '1';

function ansi(code: string): (s: string) => string {
  return useColor ? (s: string) => `\x1b[${code}m${s}\x1b[0m` : (s: string) => s;
}

export const color = {
  bold:    ansi('1'),
  dim:     ansi('2'),
  red:     ansi('31'),
  green:   ansi('32'),
  yellow:  ansi('33'),
  blue:    ansi('34'),
  magenta: ansi('35'),
  cyan:    ansi('36'),
  gray:    ansi('90'),
};

export function table(rows: Array<Record<string, string | number>>, columns?: string[]): string {
  if (rows.length === 0) return color.dim('(no rows)');
  const cols = columns ?? Object.keys(rows[0] ?? {});
  const widths = cols.map((c) =>
    Math.max(c.length, ...rows.map((r) => String(r[c] ?? '').length)),
  );
  const fmtRow = (cells: string[]) =>
    cells.map((cell, i) => cell.padEnd(widths[i] ?? 0)).join('  ');
  const header = color.bold(fmtRow(cols));
  const body = rows.map((r) => fmtRow(cols.map((c) => String(r[c] ?? ''))));
  return [header, ...body].join('\n');
}

export function uptime(startedAt: string | Date | null | undefined): string {
  if (!startedAt) return '-';
  const start = startedAt instanceof Date ? startedAt : new Date(startedAt);
  const ms = Date.now() - start.getTime();
  if (Number.isNaN(ms) || ms < 0) return '-';
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d${h % 24}h`;
}

export function stateColor(state: string): string {
  switch (state) {
    case 'resumed':
    case 'started':  return color.green(state);
    case 'paused':
    case 'stopped':  return color.yellow(state);
    case 'error':
    case 'destroyed': return color.red(state);
    default:          return color.dim(state);
  }
}

export function ok(msg: string): void {
  console.log(`${color.green('✓')} ${msg}`);
}

export function info(msg: string): void {
  console.log(`${color.blue('•')} ${msg}`);
}

export function warn(msg: string): void {
  console.error(`${color.yellow('!')} ${msg}`);
}

export function fail(msg: string): never {
  console.error(`${color.red('✗')} ${msg}`);
  process.exit(1);
}
