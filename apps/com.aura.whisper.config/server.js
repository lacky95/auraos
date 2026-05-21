/**
 * com.aura.whisper.config — settings UI activity for the headless
 * com.aura.whisper service. The backend here only serves lifecycle
 * endpoints + the static HTML/JS; all real config CRUD is cross-app
 * HTTP to `/api/proxy/com.aura.whisper/api/config` (handled by the
 * service) and direct KV reads via `/api/kv/com.aura.whisper/config`
 * (handled by the shell).
 */
const express = require('express');
const path    = require('path');

const APP_ID      = process.env.APP_ID      || 'com.aura.whisper.config';
const INSTANCE_ID = process.env.APP_INSTANCE_ID || APP_ID;
const PORT        = Number(process.env.APP_PORT || 4001);

const app = express();
app.use((_req, res, next) => {
  res.setHeader('X-Aura-App-Id',      APP_ID);
  res.setHeader('X-Aura-Instance-Id', INSTANCE_ID);
  next();
});
app.use(express.json({ limit: '256kb' }));

app.get('/api/lifecycle/health', (_req, res) => res.json({ ok: true, appId: APP_ID, instanceId: INSTANCE_ID }));
app.post('/api/lifecycle/onCreate',  (_req, res) => res.json({ ok: true }));
app.post('/api/lifecycle/onStart',   (_req, res) => res.json({ ok: true }));
app.post('/api/lifecycle/onResume',  (_req, res) => res.json({ ok: true }));
app.post('/api/lifecycle/onPause',   (_req, res) => res.json({ ok: true }));
app.post('/api/lifecycle/onStop',    (_req, res) => res.json({ ok: true }));
app.post('/api/lifecycle/onDestroy', (_req, res) => res.json({ ok: true }));

// Activity contract — every launched activity loads `/` and gets a
// human-readable title. The settings UI lives at public/index.html.
app.post('/api/lifecycle/onActivityCreate', (req, res) => {
  const activityId = req.body?.activityId ?? '';
  res.json({ path: '/', title: `Whisper · Settings (${activityId.split('#').pop() || 'main'})` });
});
app.post('/api/lifecycle/onActivityDestroy/:activityId', (_req, res) => res.json({ ok: true }));

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => {
  console.log(`[whisper.config] listening on :${PORT} (appId=${APP_ID}, instanceId=${INSTANCE_ID})`);
});
