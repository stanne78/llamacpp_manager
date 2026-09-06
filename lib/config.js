'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const CONFIG_FILE = path.join(DATA_DIR, 'config.json');
const PRESETS_FILE = path.join(DATA_DIR, 'presets.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const LOGS_DIR = path.join(DATA_DIR, 'logs');

const DEFAULT_CONFIG = {
  web: {
    host: '0.0.0.0',
    port: 3000,
  },
  paths: {
    buildsRoot: '/opt/llamacpp',
    modelsRoot: '/home/stanne/.lmstudio/models',
    extraBuildDirs: [],
  },
  defaults: {
    host: '0.0.0.0',
    port: 8080,
    ctxSize: 0, // 0 = omit (let llama-server decide)
    ngl: 99,
    jinja: true,
    flashAttention: true,
    useMmproj: false,
    extraArgs: '',
  },
};

function ensureDirs() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.mkdirSync(LOGS_DIR, { recursive: true });
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    if (err.code !== 'ENOENT') {
      console.warn(`[config] failed to read ${file}: ${err.message}`);
    }
    return fallback;
  }
}

function writeJson(file, obj) {
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, file);
}

function loadConfig() {
  ensureDirs();
  const stored = readJson(CONFIG_FILE, {});
  // Deep-merge stored over defaults so new keys appear after upgrades.
  const merged = JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  for (const section of Object.keys(stored)) {
    if (merged[section] && typeof merged[section] === 'object' && !Array.isArray(merged[section])) {
      Object.assign(merged[section], stored[section]);
    } else {
      merged[section] = stored[section];
    }
  }
  return merged;
}

function saveConfig(config) {
  ensureDirs();
  writeJson(CONFIG_FILE, config);
}

function loadPresets() {
  ensureDirs();
  return readJson(PRESETS_FILE, []);
}

function savePresets(presets) {
  ensureDirs();
  writeJson(PRESETS_FILE, presets);
}

function loadState() {
  ensureDirs();
  return readJson(STATE_FILE, { runs: [] });
}

function saveState(state) {
  ensureDirs();
  writeJson(STATE_FILE, state);
}

module.exports = {
  DATA_DIR,
  LOGS_DIR,
  loadConfig,
  saveConfig,
  loadPresets,
  savePresets,
  loadState,
  saveState,
  ensureDirs,
};
