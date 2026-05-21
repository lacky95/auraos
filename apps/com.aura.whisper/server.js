/**
 * com.aura.whisper — Express backend + sibling-container orchestrator.
 *
 * Responsibilities:
 *   1. AuraOS lifecycle contract — POST /api/lifecycle/{on*} + GET /api/lifecycle/health.
 *   2. Sibling-container management — start/stop faster-whisper-server + litellm
 *      on the aura-net Docker network, named `aura-whisper-asr` / `aura-whisper-llm`.
 *   3. Config CRUD — proxies to the OS KV store under `com.aura.whisper/config`.
 *      The settings activity (public/index.html) calls `./config` to read/write.
 *   4. Transcription API — POST /api/transcribe multipart, forwards to the
 *      whisper-server container.
 *
 * Identity headers (`X-Aura-App-Id`, `X-Aura-Instance-Id`) are stamped on every
 * response so the shell's iframe-identity guard accepts our traffic.
 */

const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const { execFile } = require('child_process');

const APP_ID      = process.env.APP_ID      || 'com.aura.whisper';
const INSTANCE_ID = process.env.APP_INSTANCE_ID || APP_ID;
const PORT        = Number(process.env.APP_PORT || 4001);
const OS_API_BASE = process.env.OS_API_BASE || 'http://localhost:3000';

// Container names — fixed because we're a singleton (instanceMode: 'single').
// If we go multi-instance later we'll suffix INSTANCE_ID.
const ASR_NAME = 'aura-whisper-asr';
const LLM_NAME = 'aura-whisper-llm';
const NETWORK  = 'aura-net';

// Default config seeded on first read. Persisted to KV under
// `<APP_ID>/config` so the settings activity and the backend share one
// source of truth.
const DEFAULT_CONFIG = {
  openrouterApiKey: '',
  whisperModel:    'Systran/faster-whisper-base',
  whisperDevice:   'cpu',         // 'cpu' | 'cuda'
  whisperCompute:  'int8',        // 'int8' | 'float16' | 'float32'
  llmModel:        'openrouter/meta-llama/llama-3.3-70b-instruct',
  llmMasterKey:    'sk-wispr-local-dev',
  language:        'en',
  cleanupOnTranscribe: false,     // Run LLM cleanup right after transcribing
};

// System prompts for the LLM cleanup pass. Loaded once at boot from
// `system_prompt.<lang>.md` next to this file — the same files the
// original whisper-tester shipped. New prompts hot-reload by adding a
// file + restarting the container (rare; not worth a watcher).
const SYSTEM_PROMPTS = Object.fromEntries(
  fs.readdirSync(__dirname)
    .map((f) => f.match(/^system_prompt\.([a-z]{2})\.md$/))
    .filter(Boolean)
    .map((m) => [m[1], fs.readFileSync(path.join(__dirname, m[0]), 'utf8')]),
);
console.log(`[whisper] system prompts: ${Object.keys(SYSTEM_PROMPTS).join(', ') || '(none)'}`);

const app = express();

// ---- Crash hardening ---------------------------------------------------
// Express 4 does NOT catch promise rejections thrown inside async handlers
// — they propagate up to Node's process-level handler, which since Node 15
// defaults to terminating the process with exit code 1. The crash chain we
// hit:  fetch to KV / docker exec rejects → handler's await unhandled →
// process exits → AuraOS marks the service crashed → respawn loop. Two
// defences:
//   1. `ah(fn)` wraps every async route so rejections forward to Express's
//      error handler (returns 500) instead of escaping.
//   2. A process-level `unhandledRejection` listener that LOGS but does NOT
//      exit, so any path we missed degrades to a noisy console line rather
//      than a hard crash.
process.on('unhandledRejection', (err) => {
  console.error('[whisper] unhandledRejection (suppressed exit):', err);
});
process.on('uncaughtException', (err) => {
  console.error('[whisper] uncaughtException (suppressed exit):', err);
});
const ah = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// ---- Identity headers --------------------------------------------------
// AuraOS iframe-identity guard: every response stamps app-id + instance-id
// so the shell's proxy verifies our origin and won't 502.
app.use((req, res, next) => {
  res.setHeader('X-Aura-App-Id',      APP_ID);
  res.setHeader('X-Aura-Instance-Id', INSTANCE_ID);
  next();
});
app.use(express.json({ limit: '1mb' }));

// ---- Lifecycle ---------------------------------------------------------
// AuraOS contract: POST /api/lifecycle/{onCreate,onStart,onResume,onPause,
// onStop,onDestroy} + GET /api/lifecycle/health. Sibling-container boot
// runs in onStart (after onCreate's port allocation has settled).

app.get('/api/lifecycle/health', (_req, res) => {
  res.json({ ok: true, appId: APP_ID, instanceId: INSTANCE_ID });
});

app.post('/api/lifecycle/onCreate',  (_req, res) => res.json({ ok: true }));

// IMPORTANT: respond to onStart immediately. ensureSidecarContainers can
// take minutes on first run (LiteLLM image is ~1 GB, faster-whisper is
// ~500 MB). The AppManager's lifecycle-hook RPC has a much shorter
// timeout — if we await the docker pulls here, the AppManager FSM gets
// stuck in `starting` even though the service is healthy, and the
// Process Manager UI then shows the app as "BOOT" forever. Boot the
// sidecars in the background; the settings activity surfaces their
// readiness via /api/status.
app.post('/api/lifecycle/onStart', (_req, res) => {
  res.json({ ok: true });
  ensureSidecarContainers().catch((e) => {
    console.error('[whisper] background sidecar boot failed:', e?.message || e);
  });
});

app.post('/api/lifecycle/onResume',  (_req, res) => res.json({ ok: true }));
app.post('/api/lifecycle/onPause',   (_req, res) => res.json({ ok: true }));
app.post('/api/lifecycle/onStop',    (_req, res) => res.json({ ok: true }));

app.post('/api/lifecycle/onDestroy', ah(async (_req, res) => {
  try { await teardownSidecarContainers(); } catch (e) {
    console.warn('[whisper] onDestroy sidecar teardown:', e?.message || e);
  }
  res.json({ ok: true });
}));

// No activity hooks — this is a `componentType: 'service'` app, headless
// by design. UI lives in com.aura.whisper.config.

// ---- Config (KV-backed) ------------------------------------------------
// Per-app KV bucket. The shell's `/api/kv/[...path]` accepts two namespace
// shapes:
//   • /api/kv/os/<key>           — public read, scoped write permissions
//   • /api/kv/app/<appId>/<key>  — per-app private bucket, same-app only
// Using the bare appId as the first segment (e.g. /api/kv/com.aura.whisper/
// config) returns 400 "Invalid namespace '…'" — that was the bug behind
// "Save failed: kv write failed: kv PUT … → HTTP 400". The `app/` prefix
// is mandatory and the shell's `identifySource()` matches our caller via
// the `/api/proxy/com.aura.whisper/…` referer to gate same-app writes.
const KV_PATH = `/api/kv/app/${encodeURIComponent(APP_ID)}/config`;

// Empty strings / null / undefined in the stored value must NOT override
// DEFAULT_CONFIG — otherwise a UI save that forwarded every form field
// (some of them blank) would zero out `llmModel`, `whisperModel`, etc.
// and the next sidecar boot would `docker run --model '' --port 4000`
// which exits immediately. Treat blanks as "use the default".
function defined(v) { return v !== '' && v !== undefined && v !== null; }
function withDefaults(stored) {
  const clean = Object.fromEntries(
    Object.entries(stored ?? {}).filter(([, v]) => defined(v)),
  );
  return { ...DEFAULT_CONFIG, ...clean };
}

async function kvGet() {
  try {
    const r = await fetch(`${OS_API_BASE}${KV_PATH}`);
    if (!r.ok) return { ...DEFAULT_CONFIG };
    const body = await r.json();
    return withDefaults(body?.value);
  } catch {
    return { ...DEFAULT_CONFIG };
  }
}

async function kvPut(value) {
  const r = await fetch(`${OS_API_BASE}${KV_PATH}`, {
    method:  'PUT',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ value }),
  });
  if (!r.ok) {
    const detail = await r.text().catch(() => '');
    throw new Error(`kv PUT ${KV_PATH} → HTTP ${r.status}${detail ? ` — ${detail}` : ''}`);
  }
}

// All config endpoints live under /api/* because the shell's proxy
// returns 403 with `service-has-no-ui` for non-API paths on
// componentType=service apps. The com.aura.whisper.config activity hits
// these URLs cross-app through /api/proxy/com.aura.whisper/api/config.
app.get('/api/config', ah(async (_req, res) => {
  const cfg = await kvGet();
  res.json(cfg);
}));

app.post('/api/config', ah(async (req, res) => {
  // Drop blank fields from the incoming patch so the UI form never
  // overwrites a sensible default with an empty string. The user clears
  // a field by submitting an explicit `null` (we don't expose that path
  // in the UI today; we can add a `reset` endpoint later if needed).
  const incoming = Object.fromEntries(
    Object.entries(req.body ?? {}).filter(([, v]) => defined(v) || typeof v === 'boolean'),
  );
  const merged = withDefaults({ ...(await kvGet()), ...incoming });
  try {
    await kvPut(merged);
  } catch (e) {
    return res.status(500).json({ ok: false, error: `kv write failed: ${String(e?.message || e)}` });
  }
  // Containers may have config baked into env — restart them so the
  // change takes effect. ensureSidecarContainers is idempotent and
  // re-creates with the new config.
  try { await teardownSidecarContainers(); } catch { /* ignore */ }
  try { await ensureSidecarContainers(); } catch (e) {
    return res.status(500).json({ ok: false, error: String(e?.message || e) });
  }
  res.json({ ok: true, value: merged });
}));

// ---- Transcribe API ----------------------------------------------------
// Multipart audio → forward to the whisper-server container. Same shape
// as the original whisper-tester's /api/transcribe so existing clients
// keep working.

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 50 * 1024 * 1024 } });

app.post('/api/transcribe', upload.single('audio'), ah(async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'no audio file in field "audio"' });
  const cfg = await kvGet();
  const model    = req.body.model    || cfg.whisperModel;
  const language = req.body.language || cfg.language;
  // Per-request override of the KV-level `cleanupOnTranscribe` toggle.
  // Accepts string 'true'/'false' (multipart bodies are strings) or boolean.
  const cleanupParam = req.body.cleanup;
  const wantCleanup = (cleanupParam === undefined)
    ? !!cfg.cleanupOnTranscribe
    : (cleanupParam === true || cleanupParam === 'true' || cleanupParam === '1');
  const llmModelOverride = req.body.llmModel;
  const filename = req.file.originalname
    || `audio.${(req.file.mimetype.split('/')[1] || 'webm').split(';')[0]}`;
  try {
    const fd = new FormData();
    fd.append('file', new Blob([req.file.buffer], { type: req.file.mimetype }), filename);
    fd.append('model', model);
    fd.append('language', language);
    fd.append('response_format', 'json');
    const t0 = Date.now();
    const r  = await fetch(`http://${ASR_NAME}:8000/v1/audio/transcriptions`, { method: 'POST', body: fd });
    const bodyText = await r.text();
    if (!r.ok) return res.status(r.status).json({ error: 'whisper failed', detail: bodyText });
    let text;
    try { text = JSON.parse(bodyText).text; } catch { text = bodyText; }
    const transcript = (text || '').trim();
    const out = { text: transcript, ms: Date.now() - t0, model };
    // Optional LLM cleanup chain — runs only when the toggle is on AND
    // we have something to clean. The clean step's errors are reported
    // alongside the original transcript so the caller still gets the raw
    // text even if the LLM hop fails.
    if (wantCleanup && transcript) {
      try {
        const cleaned = await runLlmCleanup(transcript, language, llmModelOverride ?? cfg.llmModel, cfg);
        out.clean = cleaned;
      } catch (e) {
        out.cleanError = String(e?.message || e);
      }
    }
    res.json(out);
  } catch (e) {
    res.status(502).json({ error: 'whisper unreachable', detail: String(e?.message || e) });
  }
}));

// Standalone LLM cleanup — takes already-transcribed text and re-runs it
// through the litellm sidecar with the language-matched system prompt.
// Body: { text, language?, model? }.
app.post('/api/clean', ah(async (req, res) => {
  const text = String(req.body?.text || '').trim();
  if (!text) return res.status(400).json({ error: 'empty text' });
  const cfg = await kvGet();
  const language = req.body.language || cfg.language;
  const model    = req.body.model    || cfg.llmModel;
  try {
    const out = await runLlmCleanup(text, language, model, cfg);
    res.json(out);
  } catch (e) {
    if (e.status) return res.status(e.status).json({ error: 'litellm failed', detail: e.detail });
    res.status(502).json({ error: 'litellm unreachable', detail: String(e?.message || e) });
  }
}));

// Health probe for both sidecars — used by the settings UI to render
// per-container status panels. Each sidecar gets:
//   • `containerState` from `docker inspect` (running/exited/missing/…)
//   • `uptimeSec` since the container started
//   • `httpOk` from a live HTTP ping to the container's health endpoint
//   • `skipped` for the LLM when the openrouterApiKey is empty — the
//     sidecar is intentionally not started; the UI should explain that
//     instead of showing a hard-red "down" state.
app.get('/api/status', ah(async (_req, res) => {
  const cfg = await kvGet();
  const ping = async (url) => {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { ok: r.ok, status: r.status };
    } catch (e) { return { ok: false, error: String(e?.message || e) }; }
  };
  res.json({
    service: {
      pid:        process.pid,
      uptimeSec:  Math.round(process.uptime()),
      instanceId: INSTANCE_ID,
    },
    whisper: {
      ...(await inspectContainer(ASR_NAME)),
      http: await ping(`http://${ASR_NAME}:8000/health`),
    },
    litellm: cfg.openrouterApiKey
      ? {
          ...(await inspectContainer(LLM_NAME)),
          http: await ping(`http://${LLM_NAME}:4000/health/liveliness`),
        }
      : { skipped: true, reason: 'openrouterApiKey is empty' },
  });
}));

/** Read `docker inspect` JSON for a single container; degrades gracefully
 *  to `{ state: 'missing' }` when the container isn't there. */
async function inspectContainer(name) {
  try {
    const out = await dockerExec([
      'inspect',
      '--format', '{{.State.Status}}|{{.State.StartedAt}}|{{.State.ExitCode}}|{{.State.Error}}',
      name,
    ]);
    const [state, startedAt, exitCodeStr, errMsg] = out.split('|');
    const exitCode  = Number(exitCodeStr);
    const uptimeSec = state === 'running' && startedAt
      ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000))
      : 0;
    return {
      state,
      startedAt: startedAt || null,
      uptimeSec,
      exitCode: Number.isFinite(exitCode) ? exitCode : null,
      ...(errMsg ? { error: errMsg } : {}),
    };
  } catch {
    return { state: 'missing' };
  }
}

async function runLlmCleanup(text, language, model, cfg) {
  const systemPrompt = SYSTEM_PROMPTS[language] || SYSTEM_PROMPTS['en'];
  if (!systemPrompt) {
    const err = new Error(`no system prompt for language "${language}"`);
    err.status = 500;
    throw err;
  }
  if (!cfg.openrouterApiKey) {
    const err = new Error('openrouterApiKey is empty — set it in the Whisper settings');
    err.status = 503;
    throw err;
  }
  const t0 = Date.now();
  const r = await fetch(`http://${LLM_NAME}:4000/v1/chat/completions`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${cfg.llmMasterKey || 'sk-wispr-local-dev'}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user',   content: text },
      ],
    }),
  });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(`litellm ${r.status}`);
    err.status = r.status;
    err.detail = data;
    throw err;
  }
  return {
    text: data.choices?.[0]?.message?.content || '',
    ms: Date.now() - t0,
    model,
    language,
  };
}

// ---- Container orchestration ------------------------------------------
// `docker` is in our manifest tools[] so the host socket is bind-mounted
// into this sandbox; `docker run` from here creates SIBLING containers
// on the host's daemon, joined to `aura-net` so we can reach them by
// container name (e.g. http://aura-whisper-asr:8000).

function dockerExec(args, { timeout = 60_000 } = {}) {
  return new Promise((resolve, reject) => {
    execFile('docker', args, { timeout, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) {
        err.stderr = stderr;
        reject(err);
      } else {
        resolve(stdout.trim());
      }
    });
  });
}

async function isContainerRunning(name) {
  try {
    const out = await dockerExec(['ps', '--filter', `name=^${name}$`, '--format', '{{.Names}}']);
    return out.split('\n').includes(name);
  } catch { return false; }
}

async function removeContainer(name) {
  try { await dockerExec(['rm', '-f', name]); } catch { /* already gone */ }
}

async function ensureSidecarContainers() {
  const cfg = await kvGet();

  // --- faster-whisper-server ---
  // First-time pull is ~500MB; allow a generous timeout. Same reasoning
  // as the litellm container below.
  // Always force-remove — `isContainerRunning` returns false for stopped/
  // exited containers, but `docker run --name X` still 409s if such a
  // zombie exists (e.g. from a previous failed pull). `docker rm -f` is
  // a no-op if the container is gone.
  await removeContainer(ASR_NAME);
  await dockerExec([
    'run', '-d',
    '--name', ASR_NAME,
    '--network', NETWORK,
    '--restart', 'unless-stopped',
    '-e', `WHISPER__MODEL=${cfg.whisperModel}`,
    '-e', `WHISPER__INFERENCE_DEVICE=${cfg.whisperDevice}`,
    '-e', `WHISPER__COMPUTE_TYPE=${cfg.whisperCompute}`,
    '-v', 'aura-whisper-models:/root/.cache/huggingface',
    'fedirz/faster-whisper-server:latest-cpu',
  ], { timeout: 5 * 60_000 });
  console.log(`[whisper] ${ASR_NAME} up — model=${cfg.whisperModel} device=${cfg.whisperDevice}`);

  // --- litellm ---
  // Single-model CLI mode (no config.yaml mount needed). The model
  // selection comes from KV; switching models in the settings UI
  // triggers a config POST which restarts both sidecars below.
  // The image is ~1 GB on first pull, so the docker-run call gets a
  // generous timeout — otherwise the initial `docker run -d …` exits
  // with a `signal=null` error and the user thinks the save failed.
  if (cfg.openrouterApiKey) {
    await removeContainer(LLM_NAME);
    await dockerExec([
      'run', '-d',
      '--name', LLM_NAME,
      '--network', NETWORK,
      '--restart', 'unless-stopped',
      '-e', `OPENROUTER_API_KEY=${cfg.openrouterApiKey}`,
      'ghcr.io/berriai/litellm:main-stable',
      '--model', cfg.llmModel,
      '--port', '4000',
      '--host', '0.0.0.0',
    ], { timeout: 5 * 60_000 });
    console.log(`[whisper] ${LLM_NAME} up — model=${cfg.llmModel}`);
  } else {
    // No API key yet — skip the LLM container. The user will fill it in
    // via the settings activity and saving will re-run this function.
    console.log('[whisper] openrouterApiKey empty — litellm container skipped');
  }
}

async function teardownSidecarContainers() {
  await Promise.allSettled([removeContainer(ASR_NAME), removeContainer(LLM_NAME)]);
  console.log('[whisper] sidecars torn down');
}

// ---- Boot --------------------------------------------------------------
app.listen(PORT, '0.0.0.0', () => {
  console.log(`[whisper] listening on :${PORT} (appId=${APP_ID}, instanceId=${INSTANCE_ID})`);
});
