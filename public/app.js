'use strict';

/* ---------------- state ---------------- */
const S = {
  view: 'dashboard',
  builds: [],
  models: [],
  runs: [],
  system: null,
  presets: [],
  config: null,
  chat: { runId: null, messages: [], streaming: false },
  logModal: { runId: null, timer: null },
};
// Set when the Launch form was opened from a preset's Edit button: "Save as preset" then updates it.
let editingPreset = null;

/* ---------------- helpers ---------------- */
const $ = (sel, el = document) => el.querySelector(sel);
const $$ = (sel, el = document) => [...el.querySelectorAll(sel)];

function esc(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
}

async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status} ${res.statusText}`);
  return data;
}

function fmtBytes(n) {
  if (n == null) return '–';
  if (n >= 1024 ** 3) return (n / 1024 ** 3).toFixed(1) + ' GiB';
  if (n >= 1024 ** 2) return (n / 1024 ** 2).toFixed(0) + ' MiB';
  if (n >= 1024) return (n / 1024).toFixed(0) + ' KiB';
  return n + ' B';
}

function fmtDur(ms) {
  if (ms == null || ms < 0) return '–';
  const s = Math.floor(ms / 1000);
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s % 60}s`;
  return `${s}s`;
}

function fmtTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

let toastTimer = null;
function toast(msg, kind = 'ok') {
  const el = $('#toast');
  el.textContent = msg;
  el.className = `toast ${kind}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3500);
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('Copied to clipboard');
  } catch {
    toast('Copy failed — select the text manually', 'err');
  }
}

function lanIp() {
  return S.system?.lanIps?.[0] || location.hostname;
}

/* ---------------- data loading ---------------- */
async function loadBuilds(refresh = false) {
  S.builds = await api(`/api/builds${refresh ? '?refresh=1' : ''}`);
}
async function loadModels() { S.models = await api('/api/models'); }
async function loadRuns() { S.runs = await api('/api/runs'); }
async function loadSystem() { S.system = await api('/api/system'); }
async function loadPresets() { S.presets = await api('/api/presets'); }
async function loadConfig() { S.config = await api('/api/config'); }

/* ---------------- tabs ---------------- */
// opts.prefill: initial values for the Launch form; opts.editPreset: preset being edited.
function switchView(view, opts = {}) {
  S.view = view;
  $$('.tab').forEach((t) => t.classList.toggle('active', t.dataset.view === view));
  $$('.view').forEach((v) => v.classList.toggle('hidden', v.id !== `view-${view}`));
  enterView(view, opts);
}

function enterView(view, opts = {}) {
  const enter = {
    dashboard: async () => { await Promise.all([loadRuns(), loadSystem()]); renderDashboard(); },
    launch: async () => {
      editingPreset = opts.editPreset || null;
      await Promise.all([loadBuilds(), loadModels(), loadConfig()]);
      renderLaunch(opts.prefill || null);
      if (editingPreset) $('#presetName').value = editingPreset.name || '';
    },
    presets: async () => { await loadPresets(); renderPresets(); },
    models: async () => { await loadModels(); renderModels(); },
    chat: async () => { await loadRuns(); renderChat(); },
    settings: async () => { await loadConfig(); renderSettings(); },
  }[view];
  Promise.resolve(enter()).catch((err) => toast(err.message, 'err'));
}

$('#tabs').addEventListener('click', (e) => {
  const tab = e.target.closest('.tab');
  if (tab) switchView(tab.dataset.view);
});

/* ---------------- dashboard ---------------- */
function statusBadge(run) {
  const map = {
    loading: ['loading', '⏳ loading'],
    ready: ['ready', '✓ ready'],
    running_error: ['running_error', '✗ error'],
    exited: ['exited', `exited${run.exitCode != null ? ' (' + run.exitCode + ')' : ''}`],
    stopped: ['stopped', 'stopped'],
  };
  const [cls, label] = map[run.status] || ['stopped', run.status];
  return `<span class="badge ${cls}">${esc(label)}</span>`;
}

function renderDashboard() {
  const el = $('#view-dashboard');
  const runs = S.runs;
  const alive = runs.filter((r) => r.alive);
  const ready = runs.filter((r) => r.status === 'ready');

  if (!runs.length) {
    el.innerHTML = `
      <div class="card empty">
        <p>No server runs yet.</p>
        <p>Go to <b>Launch</b> to start a model with one of your llama.cpp builds,<br>
        or create a <b>Preset</b> for one-click starts later.</p>
      </div>`;
    return;
  }

  el.innerHTML = `
    <div class="view-head">
      <h2>Servers (${alive.length} running, ${ready.length} ready)</h2>
      <button class="btn small" id="dashRefresh">Refresh</button>
    </div>
    <div class="card-grid">${runs.map(runCard).join('')}</div>`;

  $('#dashRefresh').onclick = () => enterView('dashboard');
  wireRunCards(el);
}

function runCard(run) {
  const base = `http://${lanIp()}:${run.port}`;
  const canChat = run.status === 'ready';
  return `
  <div class="card run-card" data-run="${esc(run.id)}">
    <div class="run-head">
      <div>
        <div class="run-title">${esc(run.modelName)}</div>
        <div class="run-sub">
          ${statusBadge(run)}
          <span class="badge info">${esc(run.buildBackend || '')}</span>
          ${run.mmprojUsed ? '<span class="badge purple">vision (mmproj)</span>' : ''}
          ${run.presetName ? `<span class="badge info">preset: ${esc(run.presetName)}</span>` : ''}
        </div>
      </div>
      <span class="muted small mono">${esc(run.id)}</span>
    </div>
    <div class="run-sub">${esc(run.buildName)}${run.buildVersion ? ` <span class="muted">·</span> ${esc(run.buildVersion)}` : ''}</div>
    <dl class="run-meta">
      <dt>Port</dt><dd class="mono">${run.port} (${esc(run.host)})</dd>
      <dt>PID</dt><dd class="mono">${run.pid}${run.alive ? '' : ' <span class="muted">(dead)</span>'}</dd>
      <dt>Uptime</dt><dd>${fmtDur(run.uptimeMs)}</dd>
      <dt>Started</dt><dd>${fmtTime(run.startedAt)}</dd>
    </dl>
    <div class="endpoint-row">
      <span class="endpoint-box mono" title="OpenAI-compatible endpoint">${esc(base)}/v1</span>
      <button class="btn small" data-copy="${esc(base)}/v1">Copy URL</button>
    </div>
    ${run.logTail ? `<pre class="log-preview">${esc(run.logTail)}</pre>` : ''}
    <div class="actions">
      <button class="btn small primary" data-act="chat" ${canChat ? '' : 'disabled'}>Chat</button>
      <button class="btn small" data-act="logs">Logs</button>
      ${run.alive
        ? `<button class="btn small danger" data-act="stop">Stop</button>
           <button class="btn small danger" data-act="kill" title="SIGKILL the process group">Force stop</button>`
        : `<button class="btn small" data-act="forget">Remove from list</button>`}
    </div>
  </div>`;
}

function wireRunCards(el) {
  $$('[data-copy]', el).forEach((b) => (b.onclick = () => copyText(b.dataset.copy)));
  $$('.run-card', el).forEach((card) => {
    const id = card.dataset.run;
    $$('[data-act]', card).forEach((b) => {
      b.onclick = async () => {
        const act = b.dataset.act;
        try {
          if (act === 'chat') { S.chat.runId = id; switchView('chat'); }
          else if (act === 'logs') openLogModal(id);
          else if (act === 'stop') { b.disabled = true; await api(`/api/runs/${id}`, { method: 'DELETE' }); toast('Stop signal sent'); setTimeout(() => enterView('dashboard'), 500); }
          else if (act === 'kill') { b.disabled = true; await api(`/api/runs/${id}?force=1`, { method: 'DELETE' }); toast('SIGKILL sent'); setTimeout(() => enterView('dashboard'), 500); }
          else if (act === 'forget') { await api(`/api/runs/${id}?forget=1`, { method: 'DELETE' }); enterView('dashboard'); }
        } catch (err) { toast(err.message, 'err'); b.disabled = false; }
      };
    });
  });
}

/* ---------------- launch ---------------- */
function modelLabel(m) {
  const parts = [m.name];
  if (m.quant) parts.push(m.quant);
  parts.push(fmtBytes(m.sizeBytes));
  if (m.shards > 1) parts.push(`${m.shards} shards`);
  return parts.join(' · ');
}

function buildLabel(b) {
  return `${b.name} · ${b.version} [${b.backend.label}]`;
}

function renderLaunch(prefill = null) {
  const el = $('#view-launch');
  const cfg = S.config.defaults;

  // group models by publisher/repo for optgroups
  const groups = new Map();
  for (const m of S.models) {
    const key = `${m.publisher}/${m.repo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }

  el.innerHTML = `
  <div class="view-head"><h2>Launch a server</h2></div>
  <div class="card">
    <form id="launchForm">
      <div class="form-grid">
        <div class="field" style="grid-column: 1 / -1;">
          <label for="fModel">Model</label>
          <select id="fModel" size="1">
            <option value="">Loading models…</option>
          </select>
          <span class="hint" id="modelHint"></span>
        </div>
        <div class="field" style="grid-column: 1 / -1;">
          <label for="fBuild">llama.cpp build</label>
          <select id="fBuild">
            <option value="">Loading builds…</option>
          </select>
          <span class="hint" id="buildHint"></span>
        </div>
        <div class="field">
          <label for="fPort">Port</label>
          <input id="fPort" type="number" min="1" max="65535" value="${cfg.port}" />
        </div>
        <div class="field">
          <label for="fHost">Bind host</label>
          <select id="fHost">
            <option value="0.0.0.0" ${cfg.host === '0.0.0.0' ? 'selected' : ''}>0.0.0.0 — all interfaces (LAN)</option>
            <option value="127.0.0.1" ${cfg.host === '127.0.0.1' ? 'selected' : ''}>127.0.0.1 — localhost only</option>
          </select>
        </div>
        <div class="field">
          <label for="fCtx">Context size <span class="muted">(empty = model default)</span></label>
          <input id="fCtx" type="number" min="0" placeholder="auto" value="${cfg.ctxSize > 0 ? cfg.ctxSize : ''}" />
        </div>
        <div class="field">
          <label for="fNgl">GPU layers (-ngl)</label>
          <input id="fNgl" type="number" min="0" max="999" value="${cfg.ngl}" />
        </div>
        <div class="field">
          <label for="fSpec">Speculative decoding (--spec-type)</label>
          <select id="fSpec">
            <option value="">none</option>
            <option value="draft-mtp">draft-mtp (MTP draft)</option>
            <option value="draft-dspark">draft-dspark (dspark draft model)</option>
          </select>
        </div>
        <div class="field">
          <label for="fSpecNMax">Draft steps (--spec-draft-n-max)</label>
          <input id="fSpecNMax" type="number" min="1" placeholder="not set" />
        </div>
        <div class="field" style="grid-column: 1 / -1;">
          <label for="fExtra">Extra arguments <span class="muted">(appended verbatim, quotes allowed)</span></label>
          <input id="fExtra" type="text" placeholder="e.g. --no-mmap --override-tensor exps=CPU" value="${esc(cfg.extraArgs || '')}" />
        </div>
      </div>
      <h2 style="margin-top:4px;">Model loading &amp; cache</h2>
      <div class="form-grid">
        <div class="field" style="grid-column: 1 / -1;">
          <label for="fChatTemplate">Chat template file (--chat-template-file)</label>
          <input id="fChatTemplate" type="text" placeholder="/path/to/chat_template.jinja" />
        </div>
        <div class="field">
          <label for="fCtk">K cache quant (--cache-type-k)</label>
          <input id="fCtk" type="text" list="quantList" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fCtv">V cache quant (--cache-type-v)</label>
          <input id="fCtv" type="text" list="quantList" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fCtkd">Draft K cache quant (-ctkd)</label>
          <input id="fCtkd" type="text" list="quantList" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fCtvd">Draft V cache quant (-ctvd)</label>
          <input id="fCtvd" type="text" list="quantList" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fNgld">Draft GPU layers (-ngld)</label>
          <input id="fNgld" type="number" min="0" max="999" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fLoadMode">Load mode (--load-mode)</label>
          <input id="fLoadMode" type="text" list="loadModeList" placeholder="not set" />
          <span class="hint">e.g. dio (direct I/O)</span>
        </div>
      </div>
      <h2 style="margin-top:4px;">Sampling defaults</h2>
      <div class="form-grid">
        <div class="field">
          <label for="fTemp">Temperature (--temp)</label>
          <input id="fTemp" type="number" step="0.05" min="0" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fTopP">top-p (--top-p)</label>
          <input id="fTopP" type="number" step="0.01" min="0" max="1" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fMinP">min-p (--min-p)</label>
          <input id="fMinP" type="number" step="0.01" min="0" max="1" placeholder="not set" />
        </div>
        <div class="field">
          <label for="fTopK">top-k (--top-k)</label>
          <input id="fTopK" type="number" step="1" min="0" placeholder="not set" />
        </div>
      </div>
      <span class="hint">Empty fields are omitted — llama-server defaults apply.</span>
      <datalist id="quantList">
        <option value="f32"></option><option value="f16"></option><option value="bf16"></option>
        <option value="q8_0"></option><option value="q6_0"></option><option value="q5_1"></option>
        <option value="q5_0"></option><option value="q4_1"></option><option value="q4_0"></option>
        <option value="iq4_nl"></option>
      </datalist>
      <datalist id="loadModeList"><option value="dio"></option></datalist>
      <div class="checks">
        <label class="check"><input type="checkbox" id="fJinja" ${cfg.jinja ? 'checked' : ''} /> --jinja</label>
        <label class="check"><input type="checkbox" id="fFa" ${cfg.flashAttention ? 'checked' : ''} /> flash attention (-fa on)</label>
        <label class="check"><input type="checkbox" id="fMmproj" ${cfg.useMmproj ? 'checked' : ''} disabled /> use mmproj (vision)</label>
      </div>
      <div class="actions">
        <button type="submit" class="btn primary" id="launchBtn">🚀 Launch</button>
        <button type="button" class="btn" id="savePresetBtn">${editingPreset ? 'Update preset' : 'Save as preset'}</button>
        <input type="text" id="presetName" placeholder="preset name" style="background:var(--bg-3);border:1px solid var(--border);border-radius:8px;color:var(--text);padding:7px 10px;font-size:0.85rem;" />
      </div>
      <div id="launchMsg"></div>
    </form>
  </div>`;

  // populate model select
  const modelSel = $('#fModel');
  modelSel.innerHTML = [...groups.entries()].map(([g, ms]) =>
    `<optgroup label="${esc(g)}">${ms.map((m) =>
      `<option value="${esc(m.id)}">${esc(modelLabel(m))}</option>`).join('')}</optgroup>`
  ).join('');

  // populate build select
  const buildSel = $('#fBuild');
  buildSel.innerHTML = S.builds.map((b) =>
    `<option value="${esc(b.id)}">${esc(buildLabel(b))}</option>`).join('');

  function currentModel() { return S.models.find((m) => m.id === modelSel.value); }
  function currentBuild() { return S.builds.find((b) => b.id === buildSel.value); }

  function updateHints() {
    const m = currentModel();
    const b = currentBuild();
    const mmprojCheck = $('#fMmproj');
    if (m) {
      const bits = [`${m.publisher}/${m.repo}`, fmtBytes(m.sizeBytes)];
      if (m.shards > 1) bits.push(`${m.shards} shard files`);
      if (m.mmproj) bits.push(`mmproj available: ${m.mmproj.name}`);
      $('#modelHint').textContent = bits.join(' · ');
      mmprojCheck.disabled = !m.mmproj;
      if (!m.mmproj) mmprojCheck.checked = false;
    }
    if (b) {
      const caps = [
        b.flags?.mmproj && 'mmproj', b.flags?.jinja && 'jinja', b.flags?.flashAttn && 'fa',
        b.flags?.specType && 'spec-type',
      ].filter(Boolean);
      $('#buildHint').textContent = `${b.binary} · supports: ${caps.join(', ') || 'unknown'}`;
      const specSel = $('#fSpec');
      if (b.flags && !b.flags.specType) specSel.value = '';
      $$('option', specSel).forEach((o) => { if (o.value) o.disabled = Boolean(b.flags && !b.flags.specType); });
    }
  }
  modelSel.onchange = updateHints;
  buildSel.onchange = updateHints;

  const strOrN = (sel) => { const v = $(sel).value.trim(); return v || null; };
  const numOrN = (sel) => {
    const v = $(sel).value.trim();
    if (!v) return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };

  function formValues() {
    return {
      modelId: modelSel.value,
      buildId: buildSel.value,
      port: parseInt($('#fPort').value, 10),
      host: $('#fHost').value,
      ctxSize: $('#fCtx').value ? parseInt($('#fCtx').value, 10) : 0,
      ngl: $('#fNgl').value === '' ? null : parseInt($('#fNgl').value, 10),
      jinja: $('#fJinja').checked,
      flashAttention: $('#fFa').checked,
      useMmproj: $('#fMmproj').checked,
      specType: $('#fSpec').value || null,
      specDraftNMax: numOrN('#fSpecNMax'),
      chatTemplateFile: strOrN('#fChatTemplate'),
      loadMode: strOrN('#fLoadMode'),
      cacheTypeK: strOrN('#fCtk'),
      cacheTypeV: strOrN('#fCtv'),
      cacheTypeKD: strOrN('#fCtkd'),
      cacheTypeVD: strOrN('#fCtvd'),
      ngld: numOrN('#fNgld'),
      temp: numOrN('#fTemp'),
      topP: numOrN('#fTopP'),
      minP: numOrN('#fMinP'),
      topK: numOrN('#fTopK'),
      extraArgs: $('#fExtra').value,
    };
  }

  $('#launchForm').onsubmit = async (e) => {
    e.preventDefault();
    const msg = $('#launchMsg');
    const btn = $('#launchBtn');
    btn.disabled = true;
    msg.innerHTML = '<div class="callout ok"><span class="spin"></span>Starting llama-server — large models can take minutes to load. Watch the Dashboard.</div>';
    try {
      const run = await api('/api/runs', { method: 'POST', body: formValues() });
      toast(`Started ${run.modelName} (pid ${run.pid}) on port ${run.port}`);
      switchView('dashboard');
    } catch (err) {
      msg.innerHTML = `<div class="callout err">${esc(err.message)}</div>`;
      btn.disabled = false;
    }
  };

  $('#savePresetBtn').onclick = async () => {
    const name = $('#presetName').value.trim();
    if (!name) { toast('Enter a preset name first', 'err'); $('#presetName').focus(); return; }
    try {
      if (editingPreset) {
        const updated = await api(`/api/presets/${editingPreset.id}`, { method: 'PUT', body: { name, ...formValues() } });
        editingPreset = updated;
        $('#savePresetBtn').textContent = 'Update preset';
        toast(`Preset "${name}" updated`);
      } else {
        await api('/api/presets', { method: 'POST', body: { name, ...formValues() } });
        toast(`Preset "${name}" saved`);
        $('#presetName').value = '';
      }
    } catch (err) { toast(err.message, 'err'); }
  };

  updateHints();

  if (prefill) {
    if (prefill.modelId && [...modelSel.options].some((o) => o.value === prefill.modelId)) modelSel.value = prefill.modelId;
    if (prefill.buildId && [...buildSel.options].some((o) => o.value === prefill.buildId)) buildSel.value = prefill.buildId;
    if (prefill.port) $('#fPort').value = prefill.port;
    if (prefill.host) $('#fHost').value = prefill.host;
    if (prefill.ctxSize !== undefined && prefill.ctxSize !== null) $('#fCtx').value = prefill.ctxSize > 0 ? prefill.ctxSize : '';
    if (prefill.ngl !== undefined && prefill.ngl !== null) $('#fNgl').value = prefill.ngl;
    if (prefill.jinja !== undefined) $('#fJinja').checked = prefill.jinja;
    if (prefill.flashAttention !== undefined) $('#fFa').checked = prefill.flashAttention;
    if (prefill.useMmproj !== undefined) $('#fMmproj').checked = prefill.useMmproj;
    if (prefill.specType) $('#fSpec').value = prefill.specType;
    if (prefill.specDraftNMax != null) $('#fSpecNMax').value = prefill.specDraftNMax;
    if (prefill.chatTemplateFile) $('#fChatTemplate').value = prefill.chatTemplateFile;
    if (prefill.loadMode) $('#fLoadMode').value = prefill.loadMode;
    const advMap = {
      cacheTypeK: '#fCtk', cacheTypeV: '#fCtv', cacheTypeKD: '#fCtkd', cacheTypeVD: '#fCtvd',
      ngld: '#fNgld', temp: '#fTemp', topP: '#fTopP', minP: '#fMinP', topK: '#fTopK',
    };
    for (const [key, sel] of Object.entries(advMap)) {
      if (prefill[key] !== undefined && prefill[key] !== null) $(sel).value = prefill[key];
    }
    if (prefill.extraArgs) $('#fExtra').value = prefill.extraArgs;
    updateHints();
  }
}

/* ---------------- presets ---------------- */
function presetSummary(p) {
  const bits = [];
  if (p.port) bits.push(`port ${p.port}`);
  if (p.host === '127.0.0.1') bits.push('localhost');
  if (p.ctxSize > 0) bits.push(`ctx ${p.ctxSize}`);
  if (p.useMmproj) bits.push('vision');
  if (p.specType) bits.push(p.specType);
  if (p.cacheTypeK || p.cacheTypeV) bits.push(`cache ${p.cacheTypeK || '–'}/${p.cacheTypeV || '–'}`);
  if (p.temp !== undefined && p.temp !== null) bits.push(`temp ${p.temp}`);
  if (p.loadMode) bits.push(`load ${p.loadMode}`);
  if (p.extraArgs) bits.push(`+ ${p.extraArgs}`);
  return bits.join(', ');
}

function renderPresets() {
  const el = $('#view-presets');
  if (!S.presets.length) {
    el.innerHTML = `
      <div class="view-head"><h2>Presets</h2></div>
      <div class="card empty">
        <p>No presets yet.</p>
        <p>Configure a launch and click <b>Save as preset</b> for one-click starts.</p>
      </div>`;
    return;
  }
  const modelNames = new Map(S.models.map((m) => [m.id, m]));
  const buildNames = new Map(S.builds.map((b) => [b.id, b]));

  el.innerHTML = `
    <div class="view-head"><h2>Presets (${S.presets.length})</h2></div>
    <div class="card" style="padding:0; overflow-x:auto;">
      <table>
        <thead><tr><th>Name</th><th>Model</th><th>Build</th><th>Options</th><th style="width:220px;"></th></tr></thead>
        <tbody>
          ${S.presets.map((p) => {
            const m = modelNames.get(p.modelId);
            const b = buildNames.get(p.buildId);
            const stale = [];
            if (!m) stale.push('model missing');
            if (!b) stale.push('build missing');
            return `<tr>
              <td><b>${esc(p.name)}</b>${stale.length ? `<br><span class="badge running_error">${stale.join(' & ')}</span>` : ''}</td>
              <td>${m ? esc(m.name) : `<span class="muted mono">${esc(p.modelId)}</span>`}</td>
              <td>${b ? esc(b.name) : `<span class="muted mono">${esc(p.buildId)}</span>`}</td>
              <td class="muted small">${esc(presetSummary(p))}</td>
              <td>
                <div class="actions">
                  <button class="btn small primary" data-launch="${esc(p.id)}" ${stale.length ? 'disabled' : ''}>Launch</button>
                  <button class="btn small" data-load="${esc(p.id)}">Edit</button>
                  <button class="btn small danger" data-del="${esc(p.id)}">Delete</button>
                </div>
              </td>
            </tr>`;
          }).join('')}
        </tbody>
      </table>
    </div>`;

  $$('[data-launch]', el).forEach((b) => (b.onclick = async () => {
    const p = S.presets.find((x) => x.id === b.dataset.launch);
    try {
      const { presetName, name, ...opts } = p;
      const run = await api('/api/runs', { method: 'POST', body: { ...opts, presetName: p.name } });
      toast(`Started ${run.modelName} on port ${run.port}`);
      switchView('dashboard');
    } catch (err) { toast(err.message, 'err'); }
  }));
  $$('[data-load]', el).forEach((b) => (b.onclick = () => {
    const p = S.presets.find((x) => x.id === b.dataset.load);
    if (p) switchView('launch', { prefill: p, editPreset: p });
  }));
  $$('[data-del]', el).forEach((b) => (b.onclick = async () => {
    try { await api(`/api/presets/${b.dataset.del}`, { method: 'DELETE' }); enterView('presets'); }
    catch (err) { toast(err.message, 'err'); }
  }));
}

/* ---------------- models ---------------- */
function renderModels() {
  const el = $('#view-models');
  const groups = new Map();
  for (const m of S.models) {
    const key = `${m.publisher}/${m.repo}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(m);
  }
  const totalBytes = S.models.reduce((s, m) => s + m.sizeBytes, 0);

  el.innerHTML = `
    <div class="view-head">
      <h2>Models — ${S.models.length} · ${fmtBytes(totalBytes)} total</h2>
      <div class="inline">
        <button class="btn small" id="modelsRefresh">Rescan</button>
      </div>
    </div>
    <div class="card" style="padding:0; overflow-x:auto;">
      <table>
        <thead><tr><th>Name</th><th>Quant</th><th>Size</th><th>Shards</th><th>Vision</th><th>Path</th><th></th></tr></thead>
        <tbody>
          ${[...groups.entries()].map(([g, ms]) => `
            <tr class="publisher-head"><td colspan="7">${esc(g)}</td></tr>
            ${ms.map((m) => `
              <tr>
                <td><b>${esc(m.name)}</b>${m.warning ? `<br><span class="badge running_error">${esc(m.warning)}</span>` : ''}</td>
                <td>${esc(m.quant || '–')}</td>
                <td>${fmtBytes(m.sizeBytes)}</td>
                <td>${m.shards > 1 ? m.shards : '–'}</td>
                <td>${m.mmproj ? `<span class="badge purple" title="${esc(m.mmproj.path)}">mmproj ${fmtBytes(m.mmproj.sizeBytes)}</span>` : '–'}</td>
                <td class="muted small mono">${esc(m.path)}</td>
                <td><button class="btn small" data-launchmodel="${esc(m.id)}">Launch</button></td>
              </tr>`).join('')}
          `).join('')}
        </tbody>
      </table>
    </div>`;

  $('#modelsRefresh').onclick = () => enterView('models');
  $$('[data-launchmodel]', el).forEach((b) => (b.onclick = () => {
    switchView('launch', { prefill: { modelId: b.dataset.launchmodel } });
  }));
}

/* ---------------- chat ---------------- */
function renderChat() {
  const el = $('#view-chat');
  const readyRuns = S.runs.filter((r) => r.status === 'ready');
  if (S.chat.runId && !readyRuns.some((r) => r.id === S.chat.runId)) S.chat.runId = null;
  if (!S.chat.runId && readyRuns.length) S.chat.runId = readyRuns[0].id;

  el.innerHTML = `
    <div class="view-head"><h2>Chat playground</h2></div>
    <div class="chat-layout">
      <div class="card">
        <form id="chatSettings" style="gap:10px;">
          <div class="field">
            <label>Server</label>
            <select id="chatRun">
              ${readyRuns.length
                ? readyRuns.map((r) => `<option value="${esc(r.id)}" ${r.id === S.chat.runId ? 'selected' : ''}>${esc(r.modelName)} :${r.port}</option>`).join('')
                : '<option value="">no ready servers</option>'}
            </select>
            <span class="hint">Only servers with status <b>ready</b> are listed.</span>
          </div>
          <div class="field">
            <label>System prompt</label>
            <textarea id="chatSystem" rows="4" placeholder="You are a helpful assistant."></textarea>
          </div>
          <div class="field">
            <label>Temperature: <span id="chatTempVal">0.7</span></label>
            <input type="range" id="chatTemp" min="0" max="2" step="0.1" value="0.7" />
          </div>
          <div class="actions">
            <button type="button" class="btn small danger" id="chatClear">Clear conversation</button>
          </div>
        </form>
      </div>
      <div class="card">
        <div class="chat-thread" id="chatThread">
          <div class="msg system">Messages you send go straight to this server's OpenAI-compatible endpoint. The conversation is kept in this browser tab only.</div>
        </div>
        <div class="chat-input">
          <textarea id="chatInput" placeholder="Type a message… (Enter to send, Shift+Enter for newline)" rows="2"></textarea>
          <button class="btn primary" id="chatSend">Send</button>
        </div>
      </div>
    </div>`;

  $('#chatRun').onchange = (e) => {
    if (S.chat.streaming) { toast('Wait for the current reply to finish', 'err'); e.target.value = S.chat.runId; return; }
    S.chat.runId = e.target.value;
    S.chat.messages = [];
    renderChatThread();
  };
  $('#chatTemp').oninput = (e) => { $('#chatTempVal').textContent = e.target.value; };
  $('#chatClear').onclick = () => { S.chat.messages = []; renderChatThread(); };
  $('#chatSend').onclick = sendChat;
  $('#chatInput').onkeydown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendChat(); }
  };
  renderChatThread();
}

function renderChatThread() {
  const thread = $('#chatThread');
  if (!thread) return;
  const system = $('#chatSystem')?.value?.trim();
  const msgs = S.chat.messages.map((m) => `
    <div class="msg ${m.role}">
      <div class="meta">${m.role === 'user' ? 'you' : 'assistant'} · ${fmtTime(m.ts)}</div>
      ${m.reasoning ? `<div class="reasoning">${esc(m.reasoning)}</div>` : ''}
      ${esc(m.content) || (m.role === 'assistant' && !m.done ? '<span class="muted"><span class="spin"></span></span>' : '')}
    </div>`).join('');
  thread.innerHTML =
    `<div class="msg system">${system ? 'system: ' + esc(system) : 'No system prompt set.'}</div>${msgs}`;
  thread.scrollTop = thread.scrollHeight;
}

function renderStreamBubble(asstMsg, bubble) {
  bubble.innerHTML =
    `<div class="meta">assistant · ${fmtTime(asstMsg.ts)}</div>` +
    (asstMsg.reasoning ? `<div class="reasoning">${esc(asstMsg.reasoning)}</div>` : '') +
    (asstMsg.content ? esc(asstMsg.content) : '<span class="muted"><span class="spin"></span></span>');
  const thread = $('#chatThread');
  thread.scrollTop = thread.scrollHeight;
}

async function sendChat() {
  if (S.chat.streaming) return;
  const input = $('#chatInput');
  const text = input.value.trim();
  if (!text) return;
  if (!S.chat.runId) { toast('No ready server selected', 'err'); return; }

  input.value = '';
  S.chat.messages.push({ role: 'user', content: text, ts: Date.now() });
  const asstMsg = { role: 'assistant', content: '', ts: Date.now() };
  S.chat.messages.push(asstMsg);
  S.chat.streaming = true;
  $('#chatSend').disabled = true;
  renderChatThread();

  const system = $('#chatSystem').value.trim();
  const temperature = parseFloat($('#chatTemp').value);
  const payload = {
    messages: [
      ...(system ? [{ role: 'system', content: system }] : []),
      ...S.chat.messages.filter((m) => m.content !== '' || m !== asstMsg).map(({ role, content }) => ({ role, content })),
    ],
    stream: true,
    temperature,
  };

  try {
    const res = await fetch(`/api/runs/${S.chat.runId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || `${res.status} ${res.statusText}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    let bubble = null;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx;
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim();
        buf = buf.slice(idx + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const json = JSON.parse(data);
          const delta = json.choices?.[0]?.delta || {};
          const text = delta.content || '';
          const reasoning = delta.reasoning_content || '';
          if (text || reasoning) {
            asstMsg.content += text;
            asstMsg.reasoning = (asstMsg.reasoning || '') + reasoning;
            if (!bubble) {
              renderChatThread();
              bubble = $('#chatThread').lastElementChild;
            }
            renderStreamBubble(asstMsg, bubble);
          }
        } catch { /* partial JSON, wait for more */ }
      }
    }
  } catch (err) {
    asstMsg.content += `\n[error: ${err.message}]`;
  } finally {
    S.chat.streaming = false;
    asstMsg.done = true;
    $('#chatSend').disabled = false;
    renderChatThread();
  }
}

/* ---------------- settings ---------------- */
function renderSettings() {
  const el = $('#view-settings');
  const c = S.config;
  el.innerHTML = `
    <div class="view-head"><h2>Settings</h2></div>
    <div class="card">
      <form id="settingsForm">
        <h2>Webapp</h2>
        <div class="form-grid">
          <div class="field">
            <label>Bind host</label>
            <select id="sWebHost">
              <option value="0.0.0.0" ${c.web.host === '0.0.0.0' ? 'selected' : ''}>0.0.0.0 — all interfaces (LAN)</option>
              <option value="127.0.0.1" ${c.web.host === '127.0.0.1' ? 'selected' : ''}>127.0.0.1 — localhost only</option>
            </select>
          </div>
          <div class="field">
            <label>Port</label>
            <input type="number" id="sWebPort" min="1" max="65535" value="${c.web.port}" />
            <span class="hint">Changing host/port takes effect after restarting the webapp.</span>
          </div>
        </div>
        <h2 style="margin-top:10px;">Paths</h2>
        <div class="form-grid">
          <div class="field">
            <label>Builds root (scanned for llama-server)</label>
            <input type="text" id="sBuildsRoot" value="${esc(c.paths.buildsRoot)}" />
          </div>
          <div class="field">
            <label>Models root</label>
            <input type="text" id="sModelsRoot" value="${esc(c.paths.modelsRoot)}" />
          </div>
          <div class="field" style="grid-column: 1 / -1;">
            <label>Extra build directories (one per line)</label>
            <textarea id="sExtraDirs" rows="2">${esc((c.paths.extraBuildDirs || []).join('\n'))}</textarea>
          </div>
        </div>
        <h2 style="margin-top:10px;">Launch defaults</h2>
        <div class="form-grid">
          <div class="field">
            <label>Port</label>
            <input type="number" id="sDefPort" min="1" max="65535" value="${c.defaults.port}" />
          </div>
          <div class="field">
            <label>Bind host</label>
            <select id="sDefHost">
              <option value="0.0.0.0" ${c.defaults.host === '0.0.0.0' ? 'selected' : ''}>0.0.0.0 — LAN</option>
              <option value="127.0.0.1" ${c.defaults.host === '127.0.0.1' ? 'selected' : ''}>127.0.0.1 — localhost</option>
            </select>
          </div>
          <div class="field">
            <label>GPU layers (-ngl)</label>
            <input type="number" id="sDefNgl" min="0" max="999" value="${c.defaults.ngl}" />
          </div>
          <div class="field">
            <label>Context size (0 = auto)</label>
            <input type="number" id="sDefCtx" min="0" value="${c.defaults.ctxSize}" />
          </div>
        </div>
        <div class="checks">
          <label class="check"><input type="checkbox" id="sDefJinja" ${c.defaults.jinja ? 'checked' : ''} /> --jinja by default</label>
          <label class="check"><input type="checkbox" id="sDefFa" ${c.defaults.flashAttention ? 'checked' : ''} /> flash attention by default</label>
        </div>
        <div class="actions">
          <button type="submit" class="btn primary">Save settings</button>
          <button type="button" class="btn" id="rescanBuilds">Rescan builds now</button>
        </div>
        <div id="settingsMsg"></div>
      </form>
    </div>`;

  $('#settingsForm').onsubmit = async (e) => {
    e.preventDefault();
    try {
      const body = {
        web: { host: $('#sWebHost').value, port: parseInt($('#sWebPort').value, 10) },
        paths: {
          buildsRoot: $('#sBuildsRoot').value.trim(),
          modelsRoot: $('#sModelsRoot').value.trim(),
          extraBuildDirs: $('#sExtraDirs').value.split('\n').map((s) => s.trim()).filter(Boolean),
        },
        defaults: {
          port: parseInt($('#sDefPort').value, 10),
          host: $('#sDefHost').value,
          ngl: parseInt($('#sDefNgl').value, 10),
          ctxSize: parseInt($('#sDefCtx').value, 10) || 0,
          jinja: $('#sDefJinja').checked,
          flashAttention: $('#sDefFa').checked,
        },
      };
      const res = await api('/api/config', { method: 'PUT', body });
      $('#settingsMsg').innerHTML = `<div class="callout ok">Saved.${res.restartRequired ? ' Restart the webapp to apply host/port.' : ''}</div>`;
      toast('Settings saved');
    } catch (err) {
      $('#settingsMsg').innerHTML = `<div class="callout err">${esc(err.message)}</div>`;
    }
  };

  $('#rescanBuilds').onclick = async () => {
    try {
      const builds = await api('/api/builds?refresh=1');
      toast(`Found ${builds.length} builds`);
    } catch (err) { toast(err.message, 'err'); }
  };
}

/* ---------------- log modal ---------------- */
function openLogModal(runId) {
  const run = S.runs.find((r) => r.id === runId);
  S.logModal.runId = runId;
  $('#logModalTitle').textContent = `Logs — ${run ? run.modelName : runId}`;
  $('#logModal').classList.remove('hidden');
  refreshLogModal();
  clearInterval(S.logModal.timer);
  S.logModal.timer = setInterval(refreshLogModal, 2000);
}

async function refreshLogModal() {
  if (!S.logModal.runId) return;
  try {
    const data = await api(`/api/runs/${S.logModal.runId}/logs?lines=800`);
    const body = $('#logModalBody');
    const stick = $('#logAutoScroll').checked && Math.abs(body.scrollHeight - body.scrollTop - body.clientHeight) < 80;
    body.textContent = data.text || '(no output yet)';
    if (stick) body.scrollTop = body.scrollHeight;
  } catch { /* run may be gone */ }
}

$('#logModalClose').onclick = () => {
  $('#logModal').classList.add('hidden');
  clearInterval(S.logModal.timer);
  S.logModal.runId = null;
};

/* ---------------- gpu strip / polling ---------------- */
function renderGpuStrip() {
  const el = $('#gpuStrip');
  const cards = S.system?.gpu;
  if (!cards?.length) { el.innerHTML = ''; return; }
  el.innerHTML = cards.map((c) =>
    `<span class="gpu-chip" title="${esc(c.name)} ${esc(c.gfx)} · VRAM ${c.vramUsedBytes != null ? fmtBytes(c.vramUsedBytes) + ' / ' + fmtBytes(c.vramTotalBytes) : '?'}">
      ${esc(c.name || c.card)} · GPU <b>${c.utilPercent}%</b> · VRAM <b>${c.vramPercent}%</b>
    </span>`).join('');
}

let tick = 0;
setInterval(async () => {
  if (document.hidden) return;
  try {
    await loadRuns();
    if (tick % 2 === 0) { await loadSystem(); renderGpuStrip(); }
    if (S.view === 'dashboard') renderDashboard();
    else if (S.view === 'chat' && !S.chat.streaming) {
      // keep the server selector fresh without rebuilding the thread
      const sel = $('#chatRun');
      if (sel) {
        const readyRuns = S.runs.filter((r) => r.status === 'ready');
        const current = [...sel.options].some((o) => o.value === S.chat.runId);
        if (!current || sel.options.length !== readyRuns.length) renderChat();
      }
    }
  } catch { /* transient */ }
  tick++;
}, 4000);

/* ---------------- boot ---------------- */
(async function boot() {
  $('#hostInfo').textContent = 'loading…';
  try {
    await Promise.all([loadSystem(), loadRuns()]);
    $('#hostInfo').textContent = `${S.system.hostname} · ${S.system.lanIps.join(', ')}`;
    renderGpuStrip();
    renderDashboard();
  } catch (err) {
    $('#hostInfo').textContent = `error: ${err.message}`;
  }
})();
