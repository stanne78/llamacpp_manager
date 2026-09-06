'use strict';

const fs = require('fs');
const net = require('net');
const path = require('path');
const { spawn } = require('child_process');
const { LOGS_DIR, loadState, saveState } = require('./config');

// In-memory map of live runs: id -> { meta, child }
const runs = new Map();

function newId() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const rand = Math.random().toString(36).slice(2, 6);
  return `run-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}-${rand}`;
}

// Minimal shell-like splitter for the "extra args" field (supports "quoted phrases").
function splitArgs(str) {
  const out = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(str)) !== null) {
    out.push(m[1] ?? m[2] ?? m[3]);
  }
  return out;
}

function buildArgv({ modelPath, host, port, ctxSize, ngl, jinja, flashAttention, useMmproj, mmprojPath,
  specType, specDraftNMax, chatTemplateFile, loadMode,
  cacheTypeK, cacheTypeV, cacheTypeKD, cacheTypeVD, ngld,
  temp, topP, minP, topK, extraArgs }) {
  const argv = ['-m', modelPath, '--host', host, '--port', String(port)];
  if (Number.isFinite(ngl) && ngl !== '' && ngl !== null) argv.push('-ngl', String(ngl));
  if (ngld !== '' && ngld !== null && ngld !== undefined) argv.push('-ngld', String(ngld));
  if (flashAttention) argv.push('-fa', 'on');
  if (jinja) argv.push('--jinja');
  if (ctxSize && Number(ctxSize) > 0) argv.push('-c', String(ctxSize));
  if (useMmproj && mmprojPath) argv.push('--mmproj', mmprojPath);
  if (specType) argv.push('--spec-type', specType);
  if (specDraftNMax !== '' && specDraftNMax !== null && specDraftNMax !== undefined) {
    argv.push('--spec-draft-n-max', String(specDraftNMax));
  }
  if (cacheTypeK) argv.push('--cache-type-k', cacheTypeK);
  if (cacheTypeV) argv.push('--cache-type-v', cacheTypeV);
  if (cacheTypeKD) argv.push('-ctkd', cacheTypeKD);
  if (cacheTypeVD) argv.push('-ctvd', cacheTypeVD);
  if (chatTemplateFile) argv.push('--chat-template-file', chatTemplateFile);
  if (loadMode) argv.push('--load-mode', loadMode);
  if (temp !== '' && temp !== null && temp !== undefined) argv.push('--temp', String(temp));
  if (topP !== '' && topP !== null && topP !== undefined) argv.push('--top-p', String(topP));
  if (minP !== '' && minP !== null && minP !== undefined) argv.push('--min-p', String(minP));
  if (topK !== '' && topK !== null && topK !== undefined) argv.push('--top-k', String(topK));
  if (extraArgs && extraArgs.trim()) argv.push(...splitArgs(extraArgs.trim()));
  return argv;
}

function mergeEnv(buildEnv) {
  const env = { ...process.env };
  if (buildEnv.LD_LIBRARY_PATH) {
    env.LD_LIBRARY_PATH = [buildEnv.LD_LIBRARY_PATH, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':');
  }
  delete env.LD_PRELOAD;
  return env;
}

async function isPortFree(port) {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(false));
    srv.once('listening', () => srv.close(() => resolve(true)));
    srv.listen(port, '0.0.0.0');
  });
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function isLlamaServerPid(pid) {
  try {
    const cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    return cmdline.includes('llama-server');
  } catch {
    return false;
  }
}

function persist() {
  saveState({
    runs: [...runs.values()].map((r) => r.meta),
  });
}

function logTail(logFile, maxLines = 300) {
  try {
    const st = fs.statSync(logFile);
    const start = Math.max(0, st.size - 512 * 1024);
    const fd = fs.openSync(logFile, 'r');
    const buf = Buffer.alloc(st.size - start);
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    const lines = buf.toString('utf8').split('\n');
    return lines.slice(-maxLines).join('\n').trimEnd();
  } catch {
    return '';
  }
}

function healthOf(run) {
  return fetch(`http://127.0.0.1:${run.meta.port}/health`, { signal: AbortSignal.timeout(2500) })
    .then(async (res) => ({ http: res.status, body: await res.text() }))
    .catch(() => null);
}

function serializeRun(run) {
  const meta = run.meta;
  return {
    ...meta,
    alive: meta.pid ? pidAlive(meta.pid) : false,
    uptimeMs: meta.endedAt ? meta.endedAt - meta.startedAt : Date.now() - meta.startedAt,
    logTail: logTail(path.join(LOGS_DIR, meta.logFile), 15),
  };
}

// Periodic health poll: promotes loading -> ready, detects crashed runs started by previous webapp sessions.
function startPolling(run) {
  if (run.pollTimer) return;
  run.pollTimer = setInterval(async () => {
    const meta = run.meta;
    if (['stopped', 'exited', 'running_error'].includes(meta.status)) {
      clearInterval(run.pollTimer);
      run.pollTimer = null;
      return;
    }
    if (meta.pid && !pidAlive(meta.pid)) {
      meta.status = 'exited';
      meta.endedAt = Date.now();
      persist();
      clearInterval(run.pollTimer);
      run.pollTimer = null;
      return;
    }
    const res = await healthOf(run);
    if (res && res.http === 200) {
      if (meta.status !== 'ready') {
        meta.status = 'ready';
        meta.readyAt = Date.now();
        persist();
      }
    } else if (meta.status === 'ready' && res && res.http === 503) {
      // Server went back to 503 (e.g. model reloading) — reflect it.
      meta.status = 'loading';
      persist();
    }
    // 503 "Loading model" and connection-refused-while-alive both mean loading.
    // Hard failures surface through the child's exit handler instead.
  }, 3000);
  run.pollTimer.unref();
}

async function launch({ build, model, options }) {
  const { host, port } = options;
  for (const r of runs.values()) {
    if (['loading', 'ready'].includes(r.meta.status) && r.meta.port === port) {
      throw new Error(`port ${port} is already used by run ${r.meta.id} (${r.meta.modelName})`);
    }
  }
  if (!(await isPortFree(port))) {
    throw new Error(`port ${port} is already in use by another process`);
  }
  if (!fs.existsSync(model.path)) throw new Error(`model file not found: ${model.path}`);
  if (options.useMmproj && model.mmproj && !fs.existsSync(model.mmproj.path)) {
    throw new Error(`mmproj file not found: ${model.mmproj.path}`);
  }
  if (!fs.existsSync(build.binary)) throw new Error(`llama-server not found: ${build.binary}`);

  const id = newId();
  const logFile = `${id}.log`;
  const argv = buildArgv({
    modelPath: model.path,
    mmprojPath: model.mmproj ? model.mmproj.path : null,
    ...options,
  });

  // Hand the log file descriptor straight to the child: output keeps flowing even if
  // this webapp restarts or exits (no pipes to break).
  const logPath = path.join(LOGS_DIR, logFile);
  const logFd = fs.openSync(logPath, 'a');
  const env = mergeEnv(build.env || {});
  const child = spawn(build.binary, argv, {
    detached: true,
    cwd: build.binDir,
    env,
    stdio: ['ignore', logFd, logFd],
  });
  fs.closeSync(logFd);

  const meta = {
    id,
    modelName: model.name,
    modelId: model.id,
    modelPath: model.path,
    buildId: build.id,
    buildName: build.name,
    buildVersion: build.version,
    buildBackend: build.backend ? build.backend.label : '',
    argv,
    host,
    port,
    mmprojUsed: Boolean(options.useMmproj && model.mmproj),
    pid: child.pid,
    startedAt: Date.now(),
    readyAt: null,
    endedAt: null,
    status: 'loading',
    exitCode: null,
    logFile,
    presetName: options.presetName || null,
  };

  const run = { meta, child, pollTimer: null };
  runs.set(id, run);
  persist();

  child.unref();
  child.on('exit', (code) => {
    meta.endedAt = Date.now();
    meta.exitCode = code;
    if (meta.status !== 'stopped') {
      meta.status = code === 0 ? 'exited' : 'running_error';
    }
    persist();
  });

  startPolling(run);
  return serializeRun(run);
}

async function stop(id, { force = false } = {}) {
  const run = runs.get(id);
  if (!run) throw new Error(`unknown run: ${id}`);
  const { meta, child } = run;
  if (!pidAlive(meta.pid)) {
    meta.status = meta.status === 'running_error' ? 'running_error' : 'exited';
    meta.endedAt = meta.endedAt || Date.now();
    persist();
    return serializeRun(run);
  }
  meta.status = 'stopped';
  persist();
  try {
    // Negative pid signals the whole detached process group.
    process.kill(-meta.pid, force ? 'SIGKILL' : 'SIGINT');
  } catch {
    try {
      child.kill(force ? 'SIGKILL' : 'SIGINT');
    } catch { /* already gone */ }
  }
  if (!force) {
    setTimeout(() => {
      if (pidAlive(meta.pid)) {
        try {
          process.kill(-meta.pid, 'SIGKILL');
        } catch { /* already gone */ }
      }
    }, 8000).unref();
  }
  return serializeRun(run);
}

function remove(id) {
  const run = runs.get(id);
  if (!run) throw new Error(`unknown run: ${id}`);
  if (run.pollTimer) clearInterval(run.pollTimer);
  runs.delete(id);
  persist();
}

function getRun(id) {
  const run = runs.get(id);
  return run ? serializeRun(run) : null;
}

function listRuns() {
  return [...runs.values()].map(serializeRun).sort((a, b) => b.startedAt - a.startedAt);
}

function getLogs(id, maxLines = 300) {
  const run = runs.get(id);
  if (!run) throw new Error(`unknown run: ${id}`);
  return logTail(path.join(LOGS_DIR, run.meta.logFile), maxLines);
}

// After a webapp restart, re-adopt runs whose llama-server is still alive; mark the rest as gone.
function reconcile() {
  const state = loadState();
  for (const meta of state.runs || []) {
    if (meta.pid && pidAlive(meta.pid) && isLlamaServerPid(meta.pid)) {
      // Reset transient labels so polling re-determines the real state (within 3s).
      if (meta.status !== 'stopped' && meta.status !== 'exited') meta.status = 'loading';
      const run = { meta, child: null, pollTimer: null };
      runs.set(meta.id, run);
      startPolling(run);
    } else {
      if (['loading', 'ready'].includes(meta.status)) {
        meta.status = 'exited';
        meta.endedAt = meta.endedAt || Date.now();
      }
      runs.set(meta.id, { meta, child: null, pollTimer: null });
    }
  }
  persist();
  // Drop runs older than 24h that are no longer alive to keep state tidy.
  const cutoff = Date.now() - 24 * 3600 * 1000;
  for (const [id, run] of runs) {
    const dead = ['stopped', 'exited', 'running_error'].includes(run.meta.status);
    if (dead && run.meta.startedAt < cutoff) runs.delete(id);
  }
  persist();
}

module.exports = { launch, stop, remove, getRun, listRuns, getLogs, reconcile, splitArgs };
