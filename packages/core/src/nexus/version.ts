/**
 * Compare two app versions: semver-style `x.y.z[-pre][+build]`, compared
 * numerically per part; a pre-release sorts before its release. Anything
 * that isn't a version compares as equal (0), so a missing or odd version
 * never claims an update.
 */
export function compareVersions(a: string | null | undefined, b: string | null | undefined): number {
  const pa = parse(a);
  const pb = parse(b);
  if (!pa || !pb) return 0;
  for (let i = 0; i < Math.max(pa.nums.length, pb.nums.length); i++) {
    const d = (pa.nums[i] ?? 0) - (pb.nums[i] ?? 0);
    if (d) return d > 0 ? 1 : -1;
  }
  if (pa.pre === pb.pre) return 0;
  if (!pa.pre) return 1;           // 1.0.0 > 1.0.0-beta
  if (!pb.pre) return -1;
  return pa.pre.localeCompare(pb.pre, undefined, { numeric: true }) > 0 ? 1 : -1;
}

function parse(v: string | null | undefined): { nums: number[]; pre: string } | null {
  const m = /^v?(\d+(?:\.\d+)*)(?:-([0-9A-Za-z.-]+))?(?:\+.*)?$/.exec((v ?? '').trim());
  return m ? { nums: m[1]!.split('.').map(Number), pre: m[2] ?? '' } : null;
}
