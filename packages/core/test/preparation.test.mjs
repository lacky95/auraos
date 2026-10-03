import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync, cpSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { AppPreparation, preparationCommand, runPreparationCommand } from '../dist/app-manager/preparation.js';
import { StartupWatch } from '../dist/app-manager/startup-watch.js';

function write(file, value) { mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, typeof value === 'string' ? value : JSON.stringify(value)); }
function fixture(t, { native = true, lockedNative = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'aura-preparation-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const app = join(dir, 'app'), state = join(dir, 'state'), bin = join(dir, 'bin'), source = join(dir, 'packages');
  mkdirSync(app); mkdirSync(state); mkdirSync(bin); mkdirSync(source);
  write(join(app, 'package.json'), { name: 'test-app', version: '1.0.0', dependencies: { astro: '6.0.0', rollup: '4.0.0' } });
  const nativeName = '@rollup/rollup-linux-x64-gnu';
  const nativeMeta = { version: '4.0.0', os: ['linux'], cpu: ['x64'], libc: ['glibc'], dist: { integrity: 'sha512-test', tarball: 'https://registry.invalid/native.tgz' } };
  const lock = { name: 'test-app', lockfileVersion: 3, packages: {
    '': { name: 'test-app', version: '1.0.0', dependencies: { astro: '6.0.0', rollup: '4.0.0' } },
    'node_modules/astro': { version: '6.0.0' },
    'node_modules/rollup': { version: '4.0.0', optionalDependencies: { [nativeName]: '4.0.0' } },
    ...(lockedNative ? { [`node_modules/${nativeName}`]: { version: '4.0.0', optional: true } } : {}),
  } };
  write(join(app, 'package-lock.json'), lock);
  write(join(source, 'astro/package.json'), { name: 'astro', version: '6.0.0', bin: { astro: 'cli.js' } });
  write(join(source, 'astro/cli.js'), 'console.log("astro v6.0.0");');
  write(join(source, 'rollup/package.json'), { name: 'rollup', version: '4.0.0', main: 'index.cjs' });
  write(join(source, 'rollup/index.cjs'), `module.exports=require('${nativeName}');`);
  cpSync(source, join(app, 'node_modules'), { recursive: true });
  const installNative = where => { write(join(where, nativeName, 'package.json'), { name: nativeName, version: '4.0.0', main: 'index.cjs' }); write(join(where, nativeName, 'index.cjs'), 'module.exports = {};'); };
  if (native) installNative(join(app, 'node_modules'));
  // Package-manager adapter: deterministic registry/install outcomes. Runtime
  // validation still uses real Node processes and real module resolution.
  const npm = `#!/usr/bin/env node
const fs=require('node:fs'),p=require('node:path');
fs.appendFileSync(process.env.TEST_COMMANDS,process.argv.slice(2).join(' ')+'\\n');
const cmd=process.argv[2];
if(cmd==='ls'){console.log(JSON.stringify({dependencies:{astro:{version:'6.0.0',invalid:!!process.env.TEST_INVALID},rollup:{version:'4.0.0'}}}));process.exit(0)}
if(cmd==='view'){if(process.env.TEST_OFFLINE){console.error('registry offline');process.exit(1)}console.log(process.env.TEST_META);process.exit(0)}
if(cmd==='ci'||cmd==='install'){
 fs.rmSync('node_modules',{recursive:true,force:true});fs.cpSync(process.env.TEST_SOURCE,'node_modules',{recursive:true});
 if(process.env.TEST_INSTALL_FAIL){console.error('registry offline');process.exit(1)}
 const lock=JSON.parse(fs.readFileSync('package-lock.json'));const name='${nativeName}';
 if(lock.packages['node_modules/'+name]&&!process.env.TEST_OMIT_NATIVE){
 const dir=p.join('node_modules',name);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(p.join(dir,'package.json'),JSON.stringify({name,version:'4.0.0',main:'index.cjs'}));fs.writeFileSync(p.join(dir,'index.cjs'),'module.exports={}');
 }process.exit(0)
}console.error('unexpected npm command '+cmd);process.exit(1);`;
  writeFileSync(join(bin, 'npm'), npm, { mode: 0o755 });
  const commands = join(dir, 'commands'); writeFileSync(commands, '');
  const env = { ...process.env, PATH: bin + ':' + process.env.PATH, TEST_SOURCE: source, TEST_COMMANDS: commands, TEST_META: JSON.stringify(nativeMeta) };
  const prepare = (opts = {}, extraEnv = {}) => {
    const req = { stateDir: state, mutable: true, allowChanges: true, ...opts };
    const [cmd, ...args] = preparationCommand(req, state, opts.runtime ?? 'fixture-runtime');
    return runPreparationCommand(cmd, args, req, { cwd: app, env: { ...env, ...extraEnv } });
  };
  return { app, state, prepare, commands, nativeName, lock };
}

test('Astro exists but its native Rollup dependency is absent: repair and verify', async t => {
  const f = fixture(t, { native: false });
  const result = await f.prepare();
  assert.equal(result.action, 'installed');
  assert.ok(existsSync(join(f.app, 'node_modules', f.nativeName)));
  assert.match(readFileSync(f.commands, 'utf8'), /ci --include=dev --include=optional/);
  assert.ok(!existsSync(join(f.state, 'repair.json')));
});

test('missing native lock entry is repaired without changing selected versions', async t => {
  const f = fixture(t, { native: false, lockedNative: false });
  const result = await f.prepare();
  assert.equal(result.action, 'repaired');
  const lock = JSON.parse(readFileSync(join(f.app, 'package-lock.json')));
  for (const [key, value] of Object.entries(f.lock.packages)) assert.deepEqual(lock.packages[key], value);
  assert.equal(lock.packages[`node_modules/${f.nativeName}`].version, '4.0.0');
});

test('verified preparation is offline and probes again when native files disappear', async t => {
  const f = fixture(t);
  assert.equal((await f.prepare()).action, 'verified');
  assert.equal((await f.prepare({}, { TEST_OFFLINE: '1' })).cached, true);
  assert.doesNotMatch(readFileSync(f.commands, 'utf8'), /(?:ci|install|view) /);
  rmSync(join(f.app, 'node_modules', f.nativeName), { recursive: true });
  assert.equal((await f.prepare()).action, 'installed');
});

test('runtime fingerprint changes invalidate readiness', async t => {
  const f = fixture(t); await f.prepare();
  assert.equal((await f.prepare({ runtime: 'different-image' })).action, 'installed');
});

test('running instances block repair without changing dependencies', async t => {
  const f = fixture(t, { native: false });
  await assert.rejects(f.prepare({ allowChanges: false }), /Stop the app/);
  assert.ok(!existsSync(join(f.state, 'repair.json')));
  assert.doesNotMatch(readFileSync(f.commands, 'utf8'), /ci /);
});

test('workspace validation never installs dependencies', async t => {
  const f = fixture(t, { native: false });
  await assert.rejects(f.prepare({ mutable: false }), /Workspace dependencies/);
  assert.doesNotMatch(readFileSync(f.commands, 'utf8'), /ci /);
});

test('npm success with invalid dependencies never records readiness', async t => {
  const f = fixture(t, { native: false });
  const originalLock = readFileSync(join(f.app, 'package-lock.json'), 'utf8');
  await assert.rejects(f.prepare({}, { TEST_OMIT_NATIVE: '1' }), /Cannot find module/);
  assert.equal(readFileSync(join(f.app, 'package-lock.json'), 'utf8'), originalLock);
  assert.ok(!existsSync(join(f.state, 'ready.json')));
  assert.ok(!existsSync(join(f.app, 'node_modules', f.nativeName)));
});

test('failed installation restores previous modules and retains logs', async t => {
  const f = fixture(t, { native: false });
  write(join(f.app, 'node_modules/user-file'), 'preserve me');
  await assert.rejects(f.prepare({}, { TEST_INSTALL_FAIL: '1' }), /registry offline/);
  assert.equal(readFileSync(join(f.app, 'node_modules/user-file'), 'utf8'), 'preserve me');
  assert.ok(existsSync(join(f.state, 'preparation.log')));
});

test('interrupted repair restores its backup before validating', async t => {
  const f = fixture(t);
  renameSync(join(f.app, 'node_modules'), join(f.app, '.aura-preparation-node_modules'));
  write(join(f.state, 'lock-backup.json'), f.lock);
  write(join(f.state, 'repair.json'), { hadModules: true, lockBackup: join(f.state, 'lock-backup.json') });
  write(join(f.app, 'node_modules/partial'), 'partial');
  assert.equal((await f.prepare()).action, 'verified');
  assert.ok(!existsSync(join(f.app, 'node_modules/partial')));
});

test('preparation joins concurrent calls and launch holds the same lock', async t => {
  const f = fixture(t); const coordinator = new AppPreparation(); let calls = 0;
  const work = async () => { calls++; return f.prepare(); };
  const [a, b] = await Promise.all([coordinator.prepare(f.app, work), coordinator.prepare(f.app, work)]);
  assert.equal(calls, 1); assert.deepEqual(a, b);
  const order = [];
  await Promise.all([coordinator.exclusive(f.app, async () => { order.push('launch'); await new Promise(r => setTimeout(r, 20)); order.push('registered'); }), coordinator.prepare(f.app, async () => { order.push('prepare'); return a; })]);
  assert.deepEqual(order, ['launch', 'registered', 'prepare']);
});

test('immediate startup exit rejects promptly and redacts retained logs', async t => {
  const f = fixture(t); const log = join(f.state, 'startup.log');
  const watch = new StartupWatch('console2', log, ['my-secret-value']);
  watch.observe('missing Rollup; password=my-secret-value');
  watch.exit(1);
  await assert.rejects(watch.race(new Promise(() => {})), /code 1.*missing Rollup/s);
  assert.doesNotMatch(readFileSync(log, 'utf8'), /my-secret-value/);
  assert.ok(watch.signal.aborted);
});

test('native lock repair refuses metadata that changes the requested version', async t => {
  const f = fixture(t, { native: false, lockedNative: false });
  const before = readFileSync(join(f.app, 'package-lock.json'), 'utf8');
  await assert.rejects(f.prepare({}, { TEST_META: JSON.stringify({ version: '4.0.1', os: ['linux'], cpu: ['x64'], dist: { integrity: 'sha512-other', tarball: 'https://registry.invalid/other.tgz' } }) }), /without changing dependency resolution/);
  assert.equal(readFileSync(join(f.app, 'package-lock.json'), 'utf8'), before);
});

test('a partial SDK directory cannot hide a required SDK install failure', async t => {
  const f = fixture(t);
  const pkg = JSON.parse(readFileSync(join(f.app, 'package.json')));
  pkg.auraDependencies = { '@aura/app-sdk': '^0.0.1' };
  write(join(f.app, 'package.json'), pkg);
  mkdirSync(join(f.app, 'node_modules/@aura'), { recursive: true });
  writeFileSync(join(f.app, '../bin/aura'), '#!/usr/bin/env node\nconsole.error("SDK registry unavailable");process.exit(7);', { mode: 0o755 });
  await assert.rejects(f.prepare(), /SDK registry unavailable/);
  assert.ok(!existsSync(join(f.state, 'ready.json')));
  assert.ok(existsSync(join(f.app, 'node_modules/@aura')));
});

test('an interrupted repair is not rolled back while the app is running', async t => {
  const f = fixture(t);
  renameSync(join(f.app, 'node_modules'), join(f.app, '.aura-preparation-node_modules'));
  write(join(f.app, 'node_modules/current'), 'running');
  write(join(f.state, 'repair.json'), { hadModules: true, lockBackup: null });
  await assert.rejects(f.prepare({ allowChanges: false }), /stop the app before recovery/);
  assert.equal(readFileSync(join(f.app, 'node_modules/current'), 'utf8'), 'running');
  assert.ok(existsSync(join(f.app, '.aura-preparation-node_modules')));
  assert.ok(existsSync(join(f.state, 'repair.json')));
});
