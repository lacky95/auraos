/**
 * Whisper settings UI — talks to the headless com.aura.whisper service
 * cross-app through the AuraOS proxy. Two backends, one origin:
 *
 *   GET  /api/proxy/com.aura.whisper/api/config   — read current config
 *   POST /api/proxy/com.aura.whisper/api/config   — write + restart sidecars
 *   GET  /api/proxy/com.aura.whisper/api/status   — sidecar health
 *
 * Status is refreshed every 5 s + immediately after Save (with a small
 * delay to let the sidecar restart settle).
 */
(() => {
  const SERVICE = '/api/proxy/com.aura.whisper';

  const textFields = ['openrouterApiKey', 'whisperModel', 'whisperDevice',
                      'whisperCompute', 'llmModel', 'llmMasterKey', 'language'];
  const boolFields = ['cleanupOnTranscribe'];

  const status      = document.getElementById('status');
  const lastRefresh = document.getElementById('last-refresh');
  const startBtn    = document.getElementById('svc-start');

  const setStatus = (text, state = '') => {
    status.textContent = text;
    if (state) status.dataset.state = state; else delete status.dataset.state;
  };

  // ─── Status cards ─────────────────────────────────────────────────────
  // Each card has a single composite state derived from the live data:
  //   • 'ok'   — container running AND HTTP health green
  //   • 'warn' — container running but HTTP unhealthy (still booting?)
  //   • 'err'  — container missing / exited / error
  //   • 'skip' — sidecar intentionally not started (e.g. no API key)

  function formatUptime(sec) {
    if (!sec || sec < 0) return '—';
    if (sec < 60) return `${sec}s`;
    if (sec < 3600) return `${Math.floor(sec / 60)}m ${sec % 60}s`;
    const h = Math.floor(sec / 3600);
    const m = Math.floor((sec % 3600) / 60);
    return `${h}h ${m}m`;
  }

  function cardState(sidecar) {
    if (!sidecar) return 'err';
    if (sidecar.skipped) return 'skip';
    if (sidecar.state === 'missing' || sidecar.state === 'exited') return 'err';
    if (sidecar.state === 'running' && sidecar.http?.ok) return 'ok';
    if (sidecar.state === 'running') return 'warn';
    return 'err';
  }

  function applyCard(prefix, sidecar, runningLabel = 'running') {
    const card  = document.getElementById(`card-${prefix}`);
    const badge = document.getElementById(`badge-${prefix}`);
    const st = cardState(sidecar);
    card.dataset.state  = st;
    badge.dataset.state = st;
    badge.textContent =
      st === 'ok'   ? runningLabel.toUpperCase() :
      st === 'warn' ? 'BOOTING' :
      st === 'skip' ? 'SKIPPED' :
                      'DOWN';

    if (sidecar?.skipped) {
      document.getElementById(`${prefix}-state`).textContent  = 'skipped';
      document.getElementById(`${prefix}-http`).textContent   = sidecar.reason ?? '—';
      document.getElementById(`${prefix}-uptime`).textContent = '—';
      return;
    }
    document.getElementById(`${prefix}-state`).textContent  = sidecar?.state ?? '—';
    const http = sidecar?.http;
    document.getElementById(`${prefix}-http`).textContent =
      !http        ? '—' :
      http.ok      ? `${http.status} ok` :
      http.error   ? http.error :
                     `${http.status} fail`;
    document.getElementById(`${prefix}-uptime`).textContent = formatUptime(sidecar?.uptimeSec);
  }

  function applyService(svc) {
    const card  = document.getElementById('card-service');
    const badge = document.getElementById('badge-service');
    if (svc) {
      card.dataset.state  = 'ok';
      badge.dataset.state = 'ok';
      badge.textContent   = 'RUNNING';
      document.getElementById('svc-uptime').textContent   = formatUptime(svc.uptimeSec);
      document.getElementById('svc-pid').textContent      = svc.pid ?? '—';
      document.getElementById('svc-instance').textContent = svc.instanceId ?? '—';
      if (startBtn) startBtn.hidden = true;
    } else {
      card.dataset.state  = 'err';
      badge.dataset.state = 'err';
      badge.textContent   = 'STOPPED';
      document.getElementById('svc-uptime').textContent   = '—';
      document.getElementById('svc-pid').textContent      = '—';
      document.getElementById('svc-instance').textContent = '—';
      // Surface the start button so the user can manually boot the
      // service from this activity when AppManager hasn't respawned
      // (e.g. they hit Stop in Process Manager).
      if (startBtn) {
        startBtn.hidden = false;
        startBtn.disabled = false;
        startBtn.textContent = 'Start service';
      }
    }
  }

  async function startService() {
    if (!startBtn) return;
    startBtn.disabled = true;
    startBtn.textContent = 'Starting…';
    try {
      const r = await fetch('/api/apps/com.aura.whisper/start', { method: 'POST' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      // Give AppManager + the container a beat to boot, then refresh.
      // First refresh fires immediately to give visual feedback; second
      // refresh after 2.5 s catches the steady-state once the container
      // has finished its npm install / Node boot.
      setTimeout(loadStatus,  500);
      setTimeout(loadStatus, 2500);
      setStatus('Service starting…', 'ok');
    } catch (e) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start service';
      setStatus(`Start failed: ${e.message}`, 'err');
    }
  }

  async function loadStatus() {
    try {
      const r = await fetch(`${SERVICE}/api/status`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = await r.json();
      applyService(data.service);
      applyCard('asr', data.whisper);
      applyCard('llm', data.litellm);
      lastRefresh.textContent = `LIVE ${new Date().toLocaleTimeString()}`;
      lastRefresh.dataset.state = 'ok';
    } catch (e) {
      applyService(null);
      applyCard('asr', null);
      applyCard('llm', null);
      lastRefresh.textContent = `STALE ${new Date().toLocaleTimeString()}`;
      lastRefresh.dataset.state = 'err';
    }
  }

  // ─── Config form ──────────────────────────────────────────────────────

  async function loadConfig() {
    setStatus('Loading…');
    try {
      const r = await fetch(`${SERVICE}/api/config`);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const cfg = await r.json();
      for (const f of textFields) {
        const el = document.getElementById(f);
        if (el && cfg[f] != null) el.value = cfg[f];
      }
      for (const f of boolFields) {
        const el = document.getElementById(f);
        if (el) el.checked = !!cfg[f];
      }
      setStatus('Loaded.', 'ok');
    } catch (e) {
      setStatus(`Failed to load: ${e.message}`, 'err');
    }
  }

  async function save() {
    const payload = {};
    for (const f of textFields) {
      const el = document.getElementById(f);
      if (el) payload[f] = el.value;
    }
    for (const f of boolFields) {
      const el = document.getElementById(f);
      if (el) payload[f] = el.checked;
    }
    setStatus('Saving & restarting sidecars…');
    try {
      const r = await fetch(`${SERVICE}/api/config`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      const body = await r.json().catch(() => null);
      if (!r.ok || body?.ok === false) {
        throw new Error(body?.error ?? `HTTP ${r.status}`);
      }
      setStatus(`Saved at ${new Date().toLocaleTimeString()}.`, 'ok');
      // Sidecars take a beat to restart — surface that visibly in the
      // status cards rather than letting the user wonder.
      setTimeout(loadStatus,  500);
      setTimeout(loadStatus, 2500);
    } catch (e) {
      setStatus(`Save failed: ${e.message}`, 'err');
    }
  }

  document.getElementById('save').addEventListener('click', save);
  document.getElementById('reload').addEventListener('click', () => { loadConfig(); loadStatus(); });
  if (startBtn) startBtn.addEventListener('click', startService);

  loadConfig();
  loadStatus();
  setInterval(loadStatus, 5000);
})();
