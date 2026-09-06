# llama.cpp Manager

A small web app to manage your llama.cpp builds in `/opt/llamacpp` and launch
LLM servers (from `~/.lmstudio/models`) for local-network inferencing.

## Quick start

```bash
cd ~/Documents/zcode/myllm
npm start          # or: node server.js
```

Then open **http://localhost:3000** (from other machines on your LAN:
`http://<host-ip>:3000` — the exact LAN URL is printed on startup and shown in
the header).

## Features

- **Build discovery** — scans `/opt/llamacpp` (configurable) for `llama-server`
  binaries, reports version, backend (ROCm/HIP/Vulkan/ROCmFPX) and supported
  flags. Add new builds (e.g. extract another nightly zip) and hit *Rescan
  builds now* in Settings.
- **Model discovery** — scans `~/.lmstudio/models`, groups sharded GGUFs
  (`-00001-of-0000N`) into single entries, detects `mmproj` vision projectors.
- **Launch** — pick model + build + port; options: bind host, context size,
  `-ngl`, `--jinja`, `-fa on`, `--mmproj`, `--spec-type draft-mtp`, and a
  free-text *extra args* field (anything your start scripts use, e.g.
  `--cache-reuse 256 -b 6144`, goes there verbatim).
- **Runtime management** — status (`loading → ready`), uptime, live log viewer,
  copyable OpenAI-compatible endpoint URL, Stop (SIGINT) and Force stop
  (SIGKILL). Runs are detached: they keep serving if the webapp restarts, and
  are re-adopted on startup.
- **Presets** — save a launch config under a name, then one-click launch.
- **Chat playground** — streaming test chat against any ready server
  (proxied through the webapp, works from any LAN device). Shows
  `reasoning_content` from thinking models.
- **GPU strip** — AMD GPU utilisation/VRAM via `rocm-smi` when available.

## Notes

- The HIP source builds under `rocm7.14/` and the ROCmFPX fork need
  `LD_LIBRARY_PATH=/opt/rocm/lib:<build>/bin`; this is applied automatically
  when launching them.
- The `dspark-DeepSeek…-Q8_0.gguf` file is a **draft model** (used with
  `-md`/`--spec-type draft-dspark`); it cannot run standalone.
- No authentication: anyone on your LAN can use this UI and the API. Change
  the bind host to `127.0.0.1` in Settings if that matters.
- Changing the webapp's own host/port in Settings takes effect after restart.

## Files

```
server.js        Express app + REST API
lib/builds.js    build discovery/version probing
lib/models.js    model scanning/shard grouping
lib/runner.js    process spawn/stop/monitor, state, logs
lib/config.js    persistence
public/          single-page frontend (no build step)
data/            config.json, presets.json, state.json, logs/
```

## REST API (summary)

| Method & path | Purpose |
|---|---|
| `GET /api/builds[?refresh=1]` | discovered builds |
| `GET /api/models` | discovered models |
| `GET/POST /api/runs`, `GET/DELETE /api/runs/:id[?force=1&forget=1]` | manage runs |
| `GET /api/runs/:id/logs?lines=N` | log tail |
| `POST /api/runs/:id/chat` | OpenAI-compatible proxy (streaming) |
| `GET/POST/PUT/DELETE /api/presets[/:id]` | presets CRUD |
| `GET/PUT /api/config` | configuration |
| `GET /api/system` | hostname, LAN IPs, GPU info |
