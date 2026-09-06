'use strict';

const os = require('os');
const path = require('path');
const fs = require('fs');
const { Readable } = require('stream');
const { execFile } = require('child_process');
const { promisify } = require('util');
const express = require('express');

const { loadConfig, saveConfig, loadPresets, savePresets } = require('./lib/config');
const { scanBuilds } = require('./lib/builds');
const { scanModels } = require('./lib/models');
const runner = require('./lib/runner');

const execFileAsync = promisify(execFile);

const config = loadConfig();
let presets = loadPresets();

// Build scanning probes each binary (--version/--help), so cache the result and refresh on demand.
let buildsCache = null;
let buildsCachedAt = 0;

async function getBuilds({ refresh = false } = {}) {
  if (!refresh && buildsCache && Date.now() - buildsCachedAt < 60000) return buildsCache;
  buildsCache = await scanBuilds(config);
  buildsCachedAt = Date.now();
  return buildsCache;
}

function getModels() {
  return scanModels(config.paths.modelsRoot);
}

async function gpuInfo() {
  try {
    // Flag set validated against rocm-smi 7.x: -u/--showuse takes no argument on this version.
    const { stdout } = await execFileAsync(
      'rocm-smi',
      ['--json', '-u', '--showmemuse', '--showmeminfo', 'vram', '--showproductname'],
      { timeout: 5000 }
    );
    const data = JSON.parse(stdout);
    const cards = [];
    for (const [key, value] of Object.entries(data)) {
      if (typeof value !== 'object' || value === null) continue;
      const total = parseInt(value['VRAM Total Memory (B)'], 10);
      const used = parseInt(value['VRAM Total Used Memory (B)'], 10);
      cards.push({
        card: key,
        name: value['Card Series'] || '',
        gfx: value['GFX Version'] || '',
        utilPercent: parseFloat(value['GPU use (%)']) || 0,
        vramPercent: parseFloat(value['GPU Memory Allocated (VRAM%)']) || 0,
        vramTotalBytes: Number.isNaN(total) ? null : total,
        vramUsedBytes: Number.isNaN(used) ? null : used,
      });
    }
    return cards.length ? cards : null;
  } catch {
    return null;
  }
}

function lanIps() {
  const out = [];
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces || []) {
      if (iface.family === 'IPv4' && !iface.internal) out.push(iface.address);
    }
  }
  return out;
}

const app = express();
app.use(express.json({ limit: '2mb' }));

// ---------- builds ----------
app.get('/api/builds', async (req, res) => {
  try {
    res.json(await getBuilds({ refresh: req.query.refresh === '1' }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- models ----------
app.get('/api/models', (req, res) => {
  try {
    res.json(getModels());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ---------- runs ----------
app.get('/api/runs', (req, res) => {
  res.json(runner.listRuns());
});

// Optional launch options: empty/absent -> null -> flag omitted from argv.
const optStr = (v) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const optInt = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : null;
};
const optFloat = (v) => {
  if (v === '' || v === null || v === undefined) return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

app.post('/api/runs', async (req, res) => {
  try {
    const { buildId, modelId, ...userOpts } = req.body || {};
    if (!buildId) return res.status(400).json({ error: 'buildId is required' });
    if (!modelId) return res.status(400).json({ error: 'modelId is required' });

    const builds = await getBuilds();
    const build = builds.find((b) => b.id === buildId);
    if (!build) return res.status(400).json({ error: `unknown build: ${buildId}` });

    const model = getModels().find((m) => m.id === modelId);
    if (!model) return res.status(400).json({ error: `unknown model: ${modelId}` });

    const d = config.defaults;
    const options = {
      host: userOpts.host || d.host,
      port: parseInt(userOpts.port || d.port, 10),
      ctxSize: userOpts.ctxSize !== undefined ? Number(userOpts.ctxSize) : d.ctxSize,
      ngl: userOpts.ngl !== undefined ? userOpts.ngl : d.ngl,
      jinja: userOpts.jinja !== undefined ? Boolean(userOpts.jinja) : d.jinja,
      flashAttention: userOpts.flashAttention !== undefined ? Boolean(userOpts.flashAttention) : d.flashAttention,
      useMmproj: userOpts.useMmproj !== undefined ? Boolean(userOpts.useMmproj) : d.useMmproj,
      specType: userOpts.specType || null,
      specDraftNMax: optInt(userOpts.specDraftNMax),
      chatTemplateFile: optStr(userOpts.chatTemplateFile),
      loadMode: optStr(userOpts.loadMode),
      cacheTypeK: optStr(userOpts.cacheTypeK),
      cacheTypeV: optStr(userOpts.cacheTypeV),
      cacheTypeKD: optStr(userOpts.cacheTypeKD),
      cacheTypeVD: optStr(userOpts.cacheTypeVD),
      ngld: optInt(userOpts.ngld),
      temp: optFloat(userOpts.temp),
      topP: optFloat(userOpts.topP),
      minP: optFloat(userOpts.minP),
      topK: optInt(userOpts.topK),
      extraArgs: userOpts.extraArgs || '',
      presetName: userOpts.presetName || null,
    };

    if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
      return res.status(400).json({ error: `invalid port: ${options.port}` });
    }
    if (options.host !== '0.0.0.0' && options.host !== '127.0.0.1' && options.host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(options.host)) {
      return res.status(400).json({ error: `invalid host: ${options.host}` });
    }
    if (options.useMmproj && !model.mmproj) {
      return res.status(400).json({ error: 'model has no mmproj file in its folder' });
    }
    if ((options.specType || options.specDraftNMax !== null) && build.flags && !build.flags.specType) {
      return res.status(400).json({ error: `build ${build.name} does not support --spec-type` });
    }

    const run = await runner.launch({ build, model, options });
    res.status(201).json(run);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/runs/:id', (req, res) => {
  const run = runner.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'not found' });
  res.json(run);
});

app.delete('/api/runs/:id', async (req, res) => {
  try {
    const run = runner.getRun(req.params.id);
    if (!run) return res.status(404).json({ error: 'not found' });
    if (run.alive) {
      await runner.stop(req.params.id, { force: req.query.force === '1' });
    }
    if (req.query.forget === '1') {
      const after = runner.getRun(req.params.id);
      if (after && after.alive) return res.status(409).json({ error: 'run is still alive' });
      runner.remove(req.params.id);
    }
    res.json(runner.getRun(req.params.id) || { removed: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/runs/:id/logs', (req, res) => {
  try {
    const lines = Math.min(parseInt(req.query.lines || '300', 10) || 300, 10000);
    res.json({ id: req.params.id, lines, text: runner.getLogs(req.params.id, lines) });
  } catch (err) {
    res.status(404).json({ error: err.message });
  }
});

// Chat completions proxy: avoids CORS issues so the playground works from any LAN device.
app.post('/api/runs/:id/chat', async (req, res) => {
  const run = runner.getRun(req.params.id);
  if (!run) return res.status(404).json({ error: 'run not found' });
  if (run.status !== 'ready') {
    return res.status(409).json({ error: `run is ${run.status}, not ready` });
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (req.headers.authorization) headers.Authorization = req.headers.authorization;
    const upstream = await fetch(`http://127.0.0.1:${run.port}/v1/chat/completions`, {
      method: 'POST',
      headers,
      body: JSON.stringify(req.body),
      signal: AbortSignal.timeout(600000),
    });
    res.status(upstream.status);
    const contentType = upstream.headers.get('content-type');
    if (contentType) res.set('Content-Type', contentType);
    res.set('Cache-Control', 'no-cache');
    if (upstream.body) {
      Readable.fromWeb(upstream.body).pipe(res);
    } else {
      res.end();
    }
  } catch (err) {
    res.status(502).json({ error: `upstream failed: ${err.message}` });
  }
});

// ---------- presets ----------
app.get('/api/presets', (req, res) => {
  res.json(presets);
});

app.post('/api/presets', (req, res) => {
  const { name, ...rest } = req.body || {};
  if (!name || !name.trim()) return res.status(400).json({ error: 'preset name is required' });
  if (!rest.buildId || !rest.modelId) {
    return res.status(400).json({ error: 'preset needs buildId and modelId' });
  }
  const preset = { id: `preset-${Date.now().toString(36)}`, name: name.trim(), ...rest };
  presets.push(preset);
  savePresets(presets);
  res.status(201).json(preset);
});

app.put('/api/presets/:id', (req, res) => {
  const idx = presets.findIndex((p) => p.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'not found' });
  const { id, ...rest } = req.body || {};
  presets[idx] = { ...presets[idx], ...rest, id: presets[idx].id };
  savePresets(presets);
  res.json(presets[idx]);
});

app.delete('/api/presets/:id', (req, res) => {
  const before = presets.length;
  presets = presets.filter((p) => p.id !== req.params.id);
  if (presets.length === before) return res.status(404).json({ error: 'not found' });
  savePresets(presets);
  res.json({ deleted: req.params.id });
});

// ---------- config / system ----------
app.get('/api/config', (req, res) => {
  res.json(config);
});

app.put('/api/config', (req, res) => {
  const body = req.body || {};
  const allowed = ['web', 'paths', 'defaults'];
  let restartRequired = false;
  for (const section of allowed) {
    if (body[section] && typeof body[section] === 'object') {
      if (section === 'web') restartRequired = true;
      Object.assign(config[section], body[section]);
    }
  }
  saveConfig(config);
  buildsCache = null; // paths may have changed
  res.json({ ok: true, restartRequired });
});

app.get('/api/system', async (req, res) => {
  res.json({
    hostname: os.hostname(),
    lanIps: lanIps(),
    gpu: await gpuInfo(),
    serverTime: Date.now(),
  });
});

// ---------- static frontend ----------
app.use(express.static(path.join(__dirname, 'public')));

app.use((req, res) => {
  if (req.path.startsWith('/api/')) {
    res.status(404).json({ error: `no such endpoint: ${req.method} ${req.path}` });
  } else {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
  }
});

runner.reconcile();

const server = app.listen(config.web.port, config.web.host, () => {
  const addrs = lanIps();
  console.log(`llama-manager listening on http://${config.web.host}:${config.web.port}`);
  for (const ip of addrs) console.log(`  LAN: http://${ip}:${config.web.port}`);
});

server.on('error', (err) => {
  console.error(`failed to listen on ${config.web.host}:${config.web.port}: ${err.message}`);
  process.exit(1);
});
