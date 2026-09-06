'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const CACHE_FILE = path.join(__dirname, '..', 'data', 'builds.json');
const MAX_DEPTH = 6;
const SKIP_DIRS = new Set(['.git', 'node_modules', 'rocblas', 'hipblaslt']);

// In-memory cache: binDir -> {mtimeMs, info}. Persisted to disk for fast restarts.
let cache = new Map();

function loadCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    cache = new Map(Object.entries(raw));
  } catch {
    cache = new Map();
  }
}

function persistCache() {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify(Object.fromEntries(cache), null, 2));
  } catch (err) {
    console.warn(`[builds] cache persist failed: ${err.message}`);
  }
}

function isExecutable(filePath) {
  try {
    const st = fs.statSync(filePath);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Walk looking for directories that contain an executable llama-server.
function findBinDirs(root, found, depthLeft) {
  if (depthLeft < 0) return;
  for (const ent of listDir(root)) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      if (SKIP_DIRS.has(ent.name)) continue;
      if (isExecutable(path.join(full, 'llama-server'))) {
        found.add(full);
      }
      findBinDirs(full, found, depthLeft - 1);
    }
  }
}

function detectBackend(binDir, entries) {
  const names = new Set(entries.map((e) => e.name));
  const lowerPath = binDir.toLowerCase();
  const has = (n) => names.has(n);
  const backends = [];
  if (has('libggml-hip.so') || has('libggml-hip.so.0')) backends.push('hip');
  if (has('libggml-vulkan.so') || has('libggml-vulkan.so.0')) backends.push('vulkan');
  if (has('libggml-cuda.so') || has('libggml-cuda.so.0')) backends.push('cuda');
  if (backends.length > 1 && lowerPath.includes('rocmfpx')) {
    return { id: 'rocmfpx', label: 'ROCmFPX fork' };
  }
  if (backends.length === 2) {
    return { id: 'hip+vulkan', label: 'HIP + Vulkan' };
  }
  if (backends.length === 1) {
    const map = { hip: 'HIP / ROCm', vulkan: 'Vulkan', cuda: 'CUDA' };
    return { id: backends[0], label: map[backends[0]] };
  }
  // Prebuilt ROCm zips bundle their own runtime but ship no libggml-hip.so next to binaries.
  const bundledRocm =
    has('libhipblas.so') || has('librocblas.so') || has('libamdhip64.so') ||
    entries.some((e) => e.name === 'rocblas' || e.name === 'hipblaslt');
  if (bundledRocm) return { id: 'rocm-prebuilt', label: 'ROCm (prebuilt)' };
  return { id: 'cpu', label: 'CPU' };
}

// Builds that link libggml-hip need the ROCm runtime resolvable: /opt/rocm/lib + the build's own bin dir.
function computeEnv(binDir, backendId, entries) {
  const names = new Set(entries.map((e) => e.name));
  const parts = [];
  if (backendId === 'hip' || backendId === 'hip+vulkan' || backendId === 'rocmfpx') {
    if (fs.existsSync('/opt/rocm/lib')) parts.push('/opt/rocm/lib');
  }
  parts.push(binDir);
  const selfContained = names.has('libhipblas.so') || names.has('librocblas.so');
  const env = {};
  if (parts.length) env.LD_LIBRARY_PATH = parts.join(':');
  return { env, selfContained };
}

function friendlyName(binDir, buildsRoot, extraRoots) {
  let rel = binDir;
  for (const root of [buildsRoot, ...extraRoots]) {
    if (binDir.startsWith(root + path.sep)) {
      rel = path.relative(root, binDir);
      break;
    }
  }
  const parts = rel.split(path.sep).filter(Boolean);
  // Strip trailing "bin" and a plain "build" component — they carry no information.
  if (parts[parts.length - 1] === 'bin') parts.pop();
  if (parts[parts.length - 1] === 'build') parts.pop();
  return parts.join(' / ') || path.basename(binDir);
}

async function probeBinary(binDir) {
  const bin = path.join(binDir, 'llama-server');
  const st = fs.statSync(bin);
  const cached = cache.get(binDir);
  if (cached && cached.mtimeMs === st.mtimeMs) return cached.info;

  const entries = listDir(binDir);
  const backend = detectBackend(binDir, entries);
  const { env, selfContained } = computeEnv(binDir, backend.id, entries);
  const fullEnv = { ...process.env, ...env };

  let version = 'unknown';
  let flags = {};
  try {
    // llama.cpp prints --version to stderr, --help to stdout.
    const { stdout, stderr } = await execFileAsync(bin, ['--version'], { timeout: 20000, env: fullEnv });
    const m = `${stdout}\n${stderr}`.match(/version:\s*(.+)/i);
    if (m) version = m[1].trim();
  } catch (err) {
    version = `error: ${err.message.split('\n')[0]}`;
  }
  try {
    const { stdout } = await execFileAsync(bin, ['--help'], { timeout: 20000, env: fullEnv });
    flags = {
      mmproj: /--mmproj/.test(stdout),
      jinja: /--jinja/.test(stdout),
      flashAttn: /--flash-attn|-fa\b/.test(stdout),
      specType: /--spec-type/.test(stdout),
      draftMax: /--draft-max/.test(stdout),
    };
  } catch {
    flags = {};
  }

  const info = { version, backend, env, selfContained, flags };
  cache.set(binDir, { mtimeMs: st.mtimeMs, info });
  return info;
}

async function scanBuilds(config) {
  loadCache();
  const { buildsRoot, extraBuildDirs } = config.paths;
  const roots = [buildsRoot, ...extraBuildDirs].filter((r) => r && fs.existsSync(r));
  const found = new Set();
  for (const root of roots) {
    // A configured root may itself be a bin dir.
    if (isExecutable(path.join(root, 'llama-server'))) found.add(root);
    findBinDirs(root, found, MAX_DEPTH);
  }

  const binDirs = [...found].sort();
  const probed = await Promise.all(binDirs.map((binDir) => probeBinary(binDir)));
  const builds = binDirs.map((binDir, i) => ({
    id: binDir,
    name: friendlyName(binDir, buildsRoot, extraBuildDirs),
    binDir,
    binary: path.join(binDir, 'llama-server'),
    version: probed[i].version,
    backend: probed[i].backend,
    env: probed[i].env,
    flags: probed[i].flags,
  }));
  persistCache();
  return builds;
}

module.exports = { scanBuilds };
