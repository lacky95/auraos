import type { Command } from 'commander';
import { existsSync, readFileSync, mkdirSync, writeFileSync, readdirSync, statSync, chmodSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { AppManifestSchema } from '@aura/core';
import { color, fail, info, ok, warn } from '../lib/format.js';

const TEMPLATE_DIR = (() => {
  if (process.env['AURA_TEMPLATE_DIR']) return process.env['AURA_TEMPLATE_DIR'];
  const candidates = [
    '/workspace/packages/aura-cli/src/templates/app',
    resolve(__dirname, '../templates/app'),
    resolve(__dirname, '../src/templates/app'),
  ];
  return candidates.find((c) => existsSync(c)) ?? candidates[0]!;
})();

const APPS_DIR = process.env['AURA_APPS_DIR'] ?? '/workspace/apps';

function renderTemplate(srcDir: string, destDir: string, vars: Record<string, string>): void {
  mkdirSync(destDir, { recursive: true });
  for (const entry of readdirSync(srcDir)) {
    const src = join(srcDir, entry);
    const dest = join(destDir, entry);
    const st = statSync(src);
    if (st.isDirectory()) {
      renderTemplate(src, dest, vars);
    } else {
      let body = readFileSync(src, 'utf-8');
      for (const [k, v] of Object.entries(vars)) body = body.replaceAll(`{{${k}}}`, v);
      writeFileSync(dest, body);
      if (entry.endsWith('.sh')) chmodSync(dest, 0o755);
    }
  }
}

export function registerDev(program: Command): void {
  const dev = program.command('dev').description('Developer tools: scaffold apps, validate manifests, run an app standalone.');

  dev
    .command('new <appId>')
    .option('--name <name>',           'Display name for the new app')
    .option('--instance-mode <mode>',  'single | multi', 'single')
    .option('--activity-mode <mode>',  'none | multi',   'none')
    .option('--tools <list>',          'Comma-separated capabilities to declare',  '')
    .option('--force',                 'Overwrite if target directory exists')
    .description('Scaffold a new AuraOS app under apps/<id>/ from the built-in template.')
    .action((appId: string, opts: { name?: string; instanceMode: string; activityMode: string; tools: string; force?: boolean }) => {
      if (!/^[a-z][a-z0-9]*(\.[a-z][a-z0-9]*)+$/.test(appId)) {
        fail(`Invalid app ID: ${appId}. Use reverse-domain notation like com.example.app.`);
      }
      const dest = join(APPS_DIR, appId);
      if (existsSync(dest) && !opts.force) fail(`${dest} already exists. Pass --force to overwrite.`);
      if (!existsSync(TEMPLATE_DIR)) fail(`Scaffold template missing: ${TEMPLATE_DIR}`);

      const shortName = appId.split('.').pop() ?? appId;
      const vars: Record<string, string> = {
        APP_ID:        appId,
        APP_NAME:      opts.name ?? shortName,
        APP_SHORT:     shortName,
        INSTANCE_MODE: opts.instanceMode,
        ACTIVITY_MODE: opts.activityMode,
        TOOLS_JSON:    JSON.stringify(opts.tools.split(',').map((t) => t.trim()).filter(Boolean)),
      };
      renderTemplate(TEMPLATE_DIR, dest, vars);
      ok(`scaffolded ${color.bold(appId)} at ${dest}`);
      info('Run `pnpm install` from the repo root, then `aura app start ' + appId + '`.');
    });

  dev
    .command('validate [path]')
    .option('--all', 'Validate every app under apps/')
    .description('Validate one or all app manifests against the AuraOS schema.')
    .action((path: string | undefined, opts: { all?: boolean }) => {
      const targets: string[] = [];
      if (opts.all) {
        for (const entry of readdirSync(APPS_DIR)) {
          const m = join(APPS_DIR, entry, 'app.manifest.json');
          if (existsSync(m)) targets.push(m);
        }
      } else if (path) {
        const abs = resolve(path);
        const m = abs.endsWith('.json') ? abs : join(abs, 'app.manifest.json');
        if (!existsSync(m)) fail(`Manifest not found: ${m}`);
        targets.push(m);
      } else {
        fail('Pass a path or --all.');
      }
      let failed = 0;
      for (const m of targets) {
        try {
          const data = JSON.parse(readFileSync(m, 'utf-8')) as unknown;
          const result = AppManifestSchema.safeParse(data);
          if (result.success) ok(`${m}`);
          else { warn(`${m}: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`); failed++; }
        } catch (err) { warn(`${m}: ${String(err)}`); failed++; }
      }
      if (failed > 0) process.exit(1);
    });

  dev
    .command('standalone <appId>')
    .description('Run an app directly with astro dev (no PRoot, no shell wrapper) for fast UI iteration.')
    .action((appId: string) => {
      const dir = join(APPS_DIR, appId);
      if (!existsSync(join(dir, 'package.json'))) fail(`App not found: ${dir}`);
      const child = spawn('pnpm', ['exec', 'astro', 'dev'], {
        cwd: dir,
        stdio: 'inherit',
        env: { ...process.env, APP_ID: appId },
      });
      child.on('exit', (code) => process.exit(code ?? 0));
    });
}
