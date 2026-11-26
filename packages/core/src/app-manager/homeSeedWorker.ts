/**
 * `node homeSeedWorker.js <seedDir> <home>`: the unprivileged half of
 * `seedHomeAs` (homeSeed.ts). It runs with the home owner's uid/gid and
 * prints the result as JSON.
 */
import { seedHome } from './homeSeed.js';

const [seedDir, home] = process.argv.slice(2);
if (!seedDir || !home) {
  process.stderr.write('usage: homeSeedWorker.js <seedDir> <home>\n');
  process.exit(64);
}
const warnings: string[] = [];
const r = seedHome(seedDir, home, (m) => warnings.push(m));
process.stdout.write(JSON.stringify({ ...r, warnings }));
