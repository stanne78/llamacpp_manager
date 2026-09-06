'use strict';

const fs = require('fs');
const path = require('path');

const SHARD_RE = /^(.+)-(\d{5})-of-(\d{5})\.gguf$/i;
const QUANT_RE = /(IQ\d_[A-Z0-9]+|Q\d[_A-Z0-9]*|F16|BF16|F32|UD-[A-Z0-9_]+)/i;

function listDir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

function walkGgufs(root, out) {
  for (const ent of listDir(root)) {
    const full = path.join(root, ent.name);
    if (ent.isDirectory()) {
      walkGgufs(full, out);
    } else if (ent.isFile() && ent.name.toLowerCase().endsWith('.gguf')) {
      out.push(full);
    }
  }
}

function fileSize(file) {
  try {
    return fs.statSync(file).size;
  } catch {
    return 0;
  }
}

function scanModels(modelsRoot) {
  const all = [];
  if (modelsRoot && fs.existsSync(modelsRoot)) {
    walkGgufs(modelsRoot, all);
  }

  // mmproj files are vision projectors, offered as an option on models in the same folder.
  const mmprojByDir = new Map();
  const modelFiles = [];
  for (const file of all) {
    if (path.basename(file).toLowerCase().startsWith('mmproj')) {
      mmprojByDir.set(path.dirname(file), file);
    } else {
      modelFiles.push(file);
    }
  }

  // Group sharded GGUFs (-00001-of-00002) into single models keyed by (dir, base).
  const groups = new Map();
  for (const file of modelFiles) {
    const dir = path.dirname(file);
    const base = path.basename(file);
    const m = base.match(SHARD_RE);
    if (m) {
      const key = path.join(dir, m[1]);
      if (!groups.has(key)) groups.set(key, { shardGroup: true, files: [] });
      groups.get(key).files.push({ file, index: parseInt(m[2], 10), total: parseInt(m[3], 10) });
    } else {
      groups.set(file, { shardGroup: false, files: [{ file }] });
    }
  }

  const models = [];
  for (const [key, group] of groups) {
    let files = group.files;
    let displayName;
    let entryFile;
    let warning = null;

    if (group.shardGroup) {
      files.sort((a, b) => a.index - b.index);
      entryFile = files[0].file;
      displayName = path.basename(key);
      const expected = files[0].total;
      if (files[0].index !== 1) {
        warning = `first shard is ${String(files[0].index).padStart(5, '0')}, llama-server needs shard 00001`;
      } else if (files.length !== expected) {
        warning = `found ${files.length} of ${expected} shards`;
      }
    } else {
      entryFile = files[0].file;
      displayName = path.basename(entryFile, '.gguf');
    }

    const dir = path.dirname(entryFile);
    const rel = path.relative(modelsRoot, entryFile);
    const relParts = rel.split(path.sep);
    const sizeBytes = files.reduce((sum, f) => sum + fileSize(f.file), 0);
    const quantMatch = displayName.match(QUANT_RE);

    const mmprojFile = mmprojByDir.get(dir);
    models.push({
      id: rel,
      name: displayName,
      publisher: relParts.length > 1 ? relParts[0] : '',
      repo: relParts.length > 1 ? relParts[1] : '',
      path: entryFile,
      dir: path.relative(modelsRoot, dir),
      sizeBytes,
      shards: files.length,
      quant: quantMatch ? quantMatch[1] : null,
      mmproj: mmprojFile
        ? { path: mmprojFile, name: path.basename(mmprojFile), sizeBytes: fileSize(mmprojFile) }
        : null,
      warning,
    });
  }

  models.sort((a, b) =>
    (a.publisher + a.repo + a.name).localeCompare(b.publisher + b.repo + b.name)
  );
  return models;
}

module.exports = { scanModels };
