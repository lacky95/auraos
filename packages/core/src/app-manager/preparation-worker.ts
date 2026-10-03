/** Runs in the target runtime. Keep dependencies inside this function: runners
 * serialize the compiled function into a one-shot Node process. */
export async function preparationWorker(): Promise<void> {
  const fs = await import('node:fs');
  const path = await import('node:path');
  const crypto = await import('node:crypto');
  const { createRequire } = await import('node:module');
  const { pathToFileURL } = await import('node:url');
  const { spawn } = await import('node:child_process');
  const options = JSON.parse(process.argv[1]!) as {
    stateDir: string; mutable: boolean; allowChanges: boolean; runtime: string;
    implementation: string; timeoutMs: number;
  };
  const root = process.cwd();
  const state = options.stateDir;
  fs.mkdirSync(state, { recursive: true });
  const deadline = Date.now() + options.timeoutMs;
  const started = Date.now();
  let phase = 'checking';
  let ownsRepair = false;
  const logPath = path.join(state, 'preparation.log');
  const recordPath = path.join(state, 'ready.json');
  const journalPath = path.join(state, 'repair.json');
  const modules = path.join(root, 'node_modules');
  const backupModules = path.join(root, '.aura-preparation-node_modules');
  const lockPath = path.join(root, 'package-lock.json');
  let log = '';
  const secrets = Object.entries(process.env).filter(([k, v]) => /token|password|secret|api.?key/i.test(k) && v && v.length > 4).map(([, v]) => v!);
  function redact(s: string): string {
    for (const secret of secrets) s = s.split(secret).join('<REDACTED>');
    return s.replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/g, '$1<REDACTED>@')
      .replace(/((?:_authToken|authorization|password)\s*[=:]\s*)\S+/gi, '$1<REDACTED>');
  }
  function emit(s: string): void {
    const line = redact(s);
    log = (log + line + '\n').slice(-65536);
    fs.writeFileSync(logPath, log);
    process.stdout.write(JSON.stringify({ type: 'progress', phase, line }) + '\n');
  }
  function json(file: string): any { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  function atomic(file: string, value: unknown): void {
    fs.writeFileSync(file + '.tmp', JSON.stringify(value, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
  }
  async function run(command: string, args: string[], quiet = false, cwd = root): Promise<string> {
    if (Date.now() >= deadline) throw new Error('Dependency preparation timed out');
    return new Promise((resolve, reject) => {
      const child = spawn(command, args, { cwd, env: { ...process.env, ASTRO_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let out = ''; let err = ''; let timedOut = false;
      const timer = setTimeout(() => { timedOut = true; child.kill('SIGKILL'); }, deadline - Date.now());
      child.stdout.on('data', (b: Buffer) => { out = (out + b).slice(-4 * 1024 * 1024); if (!quiet) emit(b.toString()); });
      child.stderr.on('data', (b: Buffer) => { err = (err + b).slice(-65536); if (!quiet) emit(b.toString()); });
      child.on('error', (error) => { clearTimeout(timer); reject(error); });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0 && !timedOut) resolve(out);
        else reject(Object.assign(new Error(`${command} failed${timedOut ? ' (timeout)' : ` (exit ${code})`}: ${redact(err || out).slice(-6000)}`), { exitCode: code }));
      });
    });
  }
  const pkg = json(path.join(root, 'package.json'));
  function packageFile(name: string, from = root): string | undefined {
    let dir = from;
    for (;;) {
      const candidate = path.join(dir, 'node_modules', name, 'package.json');
      if (fs.existsSync(candidate)) return candidate;
      const parent = path.dirname(dir);
      if (parent === dir) return undefined;
      dir = parent;
    }
  }
  const sdk = { ...Object.fromEntries(Object.entries(pkg.dependencies ?? {}).filter(([name]) => name.startsWith('@aura/'))), ...pkg.auraDependencies };
  async function validate(): Promise<void> {
    phase = 'validating';
    emit('Checking declared packages and native build tools');
    // npm ls validates selected versions and peer relationships without fetching.
    // OCI SDK packages may be extraneous to npm, so inspect problem kinds rather
    // than treating that expected non-zero exit as an installation failure.
    let treeText: string;
    try { treeText = await run('npm', ['ls', '--json', '--all', '--include=dev', '--include=optional'], true); }
    catch {
      treeText = await run(process.execPath, ['-e', `const{spawnSync}=require('node:child_process');const r=spawnSync('npm',['ls','--json','--all','--include=dev','--include=optional'],{encoding:'utf8',maxBuffer:4194304});if(r.error)throw r.error;process.stdout.write(r.stdout||'{}')`], true);
    }
    const tree = JSON.parse(treeText);
    if (tree.error && !tree.dependencies) throw new Error(`Unable to validate npm dependency tree: ${JSON.stringify(tree.error)}`);
    const problems: string[] = [];
    function checkTree(node: any, name: string): void {
      if (node.missing || node.invalid) problems.push(`Invalid or missing npm dependency ${name}: ${JSON.stringify(node).slice(0, 500)}`);
      for (const [childName, child] of Object.entries(node.dependencies ?? {})) checkTree(child, childName);
    }
    // npm cannot interpret workspace ranges inside OCI SDK manifests. Validate
    // that graph separately; do not discard missing/invalid npm dependencies.
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      if (!name.startsWith('@aura/')) {
        if (!tree.dependencies?.[name]) problems.push(`Missing declared npm dependency ${name}`);
        else checkTree(tree.dependencies[name], name);
      }
    }
    if (problems.length) throw new Error(problems.join('\n'));
    for (const [name, range] of Object.entries({ ...pkg.dependencies, ...pkg.devDependencies, ...sdk })) {
      const file = packageFile(name);
      if (!file) throw new Error(`Missing declared package ${name}`);
      const installed = json(file);
      if (name in sdk && !String(range).startsWith('workspace:')) {
        // Use npm's own semver implementation, avoiding a dependency on the app.
        const npmBin = fs.realpathSync((await run('sh', ['-c', 'command -v npm'], true)).trim());
        const semver = createRequire(npmBin)('semver');
        if (!semver.satisfies(installed.version, range)) throw new Error(`Invalid SDK version ${name}@${installed.version}; expected ${range}`);
      }
    }
    const sdkSeen = new Set<string>();
    const sdkQueue = Object.keys(sdk);
    let semver: any;
    for (const name of sdkQueue) {
      if (sdkSeen.has(name)) continue;
      sdkSeen.add(name);
      const file = packageFile(name);
      if (!file) throw new Error(`Missing SDK dependency ${name}`);
      const metadata = json(file);
      for (const [dep, node] of Object.entries(tree.dependencies?.[name]?.dependencies ?? {})) if (!dep.startsWith('@aura/')) checkTree(node, dep);
      if (problems.length) throw new Error(problems.join('\n'));
      for (const [dep, range] of Object.entries({ ...metadata.dependencies, ...metadata.peerDependencies })) {
        const depFile = packageFile(dep, path.dirname(file));
        if (!depFile && metadata.peerDependenciesMeta?.[dep]?.optional && !(dep in (metadata.dependencies ?? {}))) continue;
        if (!depFile) throw new Error(`Missing SDK dependency ${dep}, required by ${name}`);
        if (!String(range).startsWith('workspace:')) {
          if (!semver) {
            const npmBin = fs.realpathSync((await run('sh', ['-c', 'command -v npm'], true)).trim());
            semver = createRequire(npmBin)('semver');
          }
          if (!semver.satisfies(json(depFile).version, range)) throw new Error(`Invalid SDK dependency ${dep}, required by ${name}@${range}`);
        }
        if (dep.startsWith('@aura/')) sdkQueue.push(dep);
      }
    }
    const astro = packageFile('astro');
    if (!astro) throw new Error('Missing declared package astro');
    const astroPkg = json(astro);
    const bin = typeof astroPkg.bin === 'string' ? astroPkg.bin : astroPkg.bin.astro;
    await run(process.execPath, [path.resolve(path.dirname(astro), bin), '--version'], true);
    // Probe from each owning package, so nested Vite/native-tool versions are
    // checked too. Never import app code or browser-only package entrypoints.
    const seen = new Set<string>();
    const queue = [root, path.dirname(astro)];
    for (const from of queue) {
      for (const name of ['vite', 'rollup', 'esbuild', 'lightningcss', '@tailwindcss/oxide', '@tailwindcss/vite', '@astrojs/react']) {
        const file = packageFile(name, from);
        if (!file || seen.has(file)) continue;
        seen.add(file); queue.push(path.dirname(file));
        if (name === '@astrojs/react' || name === '@tailwindcss/vite') continue;
        const resolved = createRequire(path.join(from, 'package.json')).resolve(name);
        const action = name === 'esbuild' ? `await m.transform('const x=1',{loader:'js'});`
          : name === 'lightningcss' ? `m.transform({filename:'probe.css',code:Buffer.from('a{color:red}')});` : '';
        await run(process.execPath, ['--input-type=module', '-e', `const m=await import(${JSON.stringify(pathToFileURL(resolved).href)});${action}`], true);
      }
    }
  }
  function fingerprint(): string {
    const hash = crypto.createHash('sha256');
    const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
    hash.update(JSON.stringify({ implementation: options.implementation, runtime: options.runtime, node: process.version,
      abi: process.versions.modules, platform: process.platform, arch: process.arch, libc: report.header.glibcVersionRuntime ?? 'musl-or-other' }));
    for (const file of ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', '.npmrc']) {
      hash.update(file); if (fs.existsSync(path.join(root, file))) hash.update(fs.readFileSync(path.join(root, file)));
    }
    const sdkDir = path.join(modules, '@aura');
    if (fs.existsSync(sdkDir)) for (const name of fs.readdirSync(sdkDir).sort()) {
      for (const file of ['package.json', 'package-lock.json']) {
        const entry = path.join(sdkDir, name, file);
        if (fs.existsSync(entry)) hash.update(fs.readFileSync(entry));
      }
    }
    for (const file of [path.join(process.env.HOME ?? '', '.npmrc'), '/etc/npmrc']) {
      if (fs.existsSync(file)) hash.update(fs.readFileSync(file));
    }
    for (const [key, value] of Object.entries(process.env).sort()) if (/^npm_config_/i.test(key)) hash.update(key + '=' + value);
    return hash.digest('hex');
  }
  function restore(): void {
    if (!fs.existsSync(journalPath)) return;
    const journal = json(journalPath);
    if (fs.existsSync(backupModules)) {
      fs.rmSync(modules, { recursive: true, force: true });
      fs.renameSync(backupModules, modules);
    } else if (!journal.hadModules) fs.rmSync(modules, { recursive: true, force: true });
    if (journal.lockBackup) fs.copyFileSync(path.join(state, path.basename(journal.lockBackup)), lockPath);
    else fs.rmSync(lockPath, { force: true });
    fs.rmSync(recordPath, { force: true });
    fs.rmSync(journalPath, { force: true });
  }
  async function installSdkDependencies(): Promise<void> {
    const seen = new Set<string>();
    const queue = Object.keys(sdk);
    const sdkState = path.join(state, 'sdk');
    fs.mkdirSync(sdkState, { recursive: true });
    for (const name of queue) {
      if (seen.has(name)) continue;
      seen.add(name);
      const file = packageFile(name);
      if (!file) throw new Error(`Missing SDK package ${name}`);
      const metadata = json(file);
      const publicDeps: Record<string, unknown> = {};
      for (const [dep, range] of Object.entries(metadata.dependencies ?? {})) {
        if (!dep.startsWith('@aura/')) { publicDeps[dep] = range; continue; }
        if (!packageFile(dep)) {
          let version = String(range);
          if (version.startsWith('workspace:')) {
            const workspaceFile = path.join('/workspace/packages', dep === '@aura/cli' ? 'aura-cli' : dep.slice(6), 'package.json');
            if (!fs.existsSync(workspaceFile)) throw new Error(`Cannot resolve published version of ${dep} (${version})`);
            version = json(workspaceFile).version;
          }
          const staging = path.join(sdkState, 'download');
          fs.mkdirSync(staging, { recursive: true });
          atomic(path.join(staging, 'package.json'), { auraDependencies: { [dep]: version } });
          await run('aura', ['sdk', 'install', '--quiet'], false, staging);
          fs.cpSync(path.join(staging, 'node_modules', dep), path.join(modules, dep), { recursive: true, verbatimSymlinks: true });
        }
        queue.push(dep);
      }
      if (!Object.keys(publicDeps).length) continue;
      const dir = path.dirname(file);
      const savedLock = path.join(sdkState, name.slice(6) + '.lock.json');
      const nestedLock = path.join(dir, 'package-lock.json');
      const previousLock = path.join(backupModules, name, 'package-lock.json');
      if (fs.existsSync(previousLock)) fs.copyFileSync(previousLock, savedLock);
      const original = fs.readFileSync(file);
      // Install only runtime npm dependencies. OCI/workspace dependencies are
      // handled above; peers resolve from the app to avoid duplicate Reacts.
      atomic(file, { name: metadata.name, version: metadata.version, private: true, dependencies: publicDeps });
      if (fs.existsSync(savedLock)) fs.copyFileSync(savedLock, nestedLock);
      try {
        await run('npm', [fs.existsSync(nestedLock) ? 'ci' : 'install', '--omit=dev', '--include=optional', '--legacy-peer-deps', '--no-audit', '--no-fund'], false, dir);
        fs.copyFileSync(nestedLock, savedLock);
      } finally { fs.writeFileSync(file, original); }
    }
  }
  async function install(): Promise<void> {
    phase = 'installing'; emit('Installing npm dependencies, including optional and development packages');
    await run('npm', [fs.existsSync(lockPath) ? 'ci' : 'install', '--include=dev', '--include=optional', '--prefer-offline', '--no-audit', '--no-fund']);
    if (Object.keys(sdk).length) {
      phase = 'sdk'; emit('Installing declared Aura SDK packages');
      await run('aura', ['sdk', 'install', '--quiet']);
      await installSdkDependencies();
    }
  }
  async function repairNativeLock(): Promise<boolean> {
    if (!fs.existsSync(lockPath)) return false;
    const lock = json(lockPath);
    if (![2, 3].includes(lock.lockfileVersion) || !lock.packages) throw new Error('Unsupported npm lockfile; expected lockfileVersion 2 or 3');
    let changed = false;
    // Repair only leaf native packages with exact versions in selected parent
    // metadata. Existing entries are never rewritten or re-resolved.
    for (const [location, value] of Object.entries(lock.packages) as Array<[string, any]>) {
      for (const [name, version] of Object.entries(value.optionalDependencies ?? {})) {
        if (!/^(?:@rollup\/rollup-|@esbuild\/|@tailwindcss\/oxide-|lightningcss-)/.test(name)) continue;
        if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(String(version))) continue;
        let parent = location; let found = false;
        for (;;) {
          if (lock.packages[path.posix.join(parent, 'node_modules', name)]) { found = true; break; }
          const next = path.posix.dirname(parent);
          if (!parent || next === '.' || next === parent) { if (lock.packages[`node_modules/${name}`]) found = true; break; }
          parent = next;
        }
        if (found) continue;
        const meta = JSON.parse(await run('npm', ['view', `${name}@${version}`, '--json'], true));
        const matches = (list: string[] | undefined, actual: string) => !list || ((!list.some(v => !v.startsWith('!')) || list.includes(actual)) && !list.includes('!' + actual));
        const report = process.report.getReport() as { header: { glibcVersionRuntime?: string } };
        if (!matches(meta.os, process.platform) || !matches(meta.cpu, process.arch) || !matches(meta.libc, report.header.glibcVersionRuntime ? 'glibc' : 'musl')) continue;
        if (meta.version !== version || !meta.dist?.integrity || !meta.dist?.tarball || Object.keys(meta.dependencies ?? {}).length) {
          throw new Error(`Cannot repair ${name} without changing dependency resolution`);
        }
        const target = lock.packages[`node_modules/${name}`] ? path.posix.join(location, 'node_modules', name) : `node_modules/${name}`;
        if (lock.packages[target]) throw new Error(`Conflicting locked native dependency ${name}`);
        lock.packages[target] = { version, resolved: meta.dist.tarball, integrity: meta.dist.integrity, optional: true,
          ...(meta.os ? { os: meta.os } : {}), ...(meta.cpu ? { cpu: meta.cpu } : {}), ...(meta.libc ? { libc: meta.libc } : {}), ...(meta.engines ? { engines: meta.engines } : {}) };
        // npm v2's compatibility tree must agree with the packages map.
        if (lock.lockfileVersion === 2) {
          if (target !== `node_modules/${name}` || lock.dependencies?.[name]) throw new Error(`Nested v2 lock repair needs manual intervention: ${name}`);
          lock.dependencies ??= {};
          lock.dependencies[name] = { version, resolved: meta.dist.tarball, integrity: meta.dist.integrity, optional: true };
        }
        changed = true; emit(`Repaired missing lock entry ${name}@${version}`);
      }
    }
    if (changed) atomic(lockPath, lock);
    return changed;
  }
  try {
    if (fs.existsSync(journalPath)) {
      if (!options.allowChanges || !options.mutable) throw new Error('Interrupted dependency repair; stop the app before recovery');
      phase = 'recovering'; emit('Restoring interrupted dependency repair'); ownsRepair = true; restore(); ownsRepair = false;
    }
    const before = fingerprint();
    let cached = false;
    try { cached = json(recordPath).fingerprint === before; } catch { /* first verification */ }
    let invalid: unknown;
    try { await validate(); } catch (error) { invalid = error; }
    if (!invalid && (!fs.existsSync(recordPath) || cached || !options.mutable)) {
      atomic(recordPath, { fingerprint: before, verifiedAt: new Date().toISOString() });
      process.stdout.write(JSON.stringify({ type: 'result', status: 'ready', action: 'verified', cached, durationMs: Date.now() - started }) + '\n'); return;
    }
    if (!options.mutable) throw new Error(`Workspace dependencies require repair with the workspace package manager: ${invalid ?? 'runtime or dependency inputs changed'}`);
    if (!options.allowChanges) throw new Error(`Stop the app before repairing its dependencies: ${invalid ?? 'dependency inputs changed'}`);
    if (fs.existsSync(path.join(root, 'npm-shrinkwrap.json')) || (!fs.existsSync(lockPath) && ['pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb'].some(f => fs.existsSync(path.join(root, f))))) {
      throw new Error('Unsupported app lockfile; prepare this app with its declared package manager');
    }
    if (fs.existsSync(lockPath) && ![2, 3].includes(json(lockPath).lockfileVersion)) throw new Error('Unsupported npm lockfile version; expected 2 or 3');
    if (fs.existsSync(backupModules)) throw new Error('A dependency backup exists without a recovery journal; manual recovery required');
    fs.rmSync(recordPath, { force: true });
    const lockBackup = fs.existsSync(lockPath) ? path.join(state, `package-lock.${Date.now()}.json`) : null;
    if (lockBackup) fs.copyFileSync(lockPath, lockBackup);
    atomic(journalPath, { hadModules: fs.existsSync(modules), lockBackup: lockBackup ? path.basename(lockBackup) : null });
    ownsRepair = true;
    if (fs.existsSync(modules)) fs.renameSync(modules, backupModules);
    let repaired = false;
    await install();
    try { await validate(); } catch (error) {
      phase = 'repairing'; emit(`Validation failed after installation: ${String(error)}`);
      if (!await repairNativeLock()) throw error;
      repaired = true; await install(); await validate();
    }
    atomic(recordPath, { fingerprint: fingerprint(), verifiedAt: new Date().toISOString() });
    // Commit journal removal first: a crash during backup cleanup must not roll
    // a verified installation back. Leftover backups are safe to clean later.
    fs.rmSync(journalPath, { force: true });
    ownsRepair = false;
    try { fs.rmSync(backupModules, { recursive: true, force: true }); } catch { emit('Verified dependencies; old backup cleanup is pending'); }
    process.stdout.write(JSON.stringify({ type: 'result', status: 'ready', action: repaired ? 'repaired' : 'installed', cached: false, durationMs: Date.now() - started }) + '\n');
  } catch (error) {
    const failedPhase = phase;
    try { if (ownsRepair) restore(); } catch (recoveryError) { emit(`Recovery requires attention: ${String(recoveryError)}`); }
    const message = redact(error instanceof Error ? error.message : String(error));
    emit(message);
    process.stdout.write(JSON.stringify({ type: 'failure', phase: failedPhase, message, exitCode: (error as { exitCode?: number }).exitCode, logPath }) + '\n');
    process.exitCode = 1;
  }
}
