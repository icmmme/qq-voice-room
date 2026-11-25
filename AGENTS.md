# qq-voice-room — Engineering Guide

## Project Overview

QQ Voice Room runs a standalone local OneBot v11 reverse-WebSocket bridge (`127.0.0.1:3011`) hosting two AI characters with independent public personas, optional Fish Audio TTS, and a SQLite delivery ledger (`room.sqlite`, schema v9).

## Standard Verification

Use PowerShell with `npm.cmd` (if `npm.ps1` is blocked):

```powershell
npm.cmd ci --ignore-scripts --no-audit --no-fund
npm.cmd run build
node --test dist/tests/voice-room-request-lifecycle.test.js
node dist/scripts/demo.js
```

GitHub Actions (`Product CI`, `.github/workflows/product-ci.yml`) runs the same install, build, and full lifecycle test suite on PRs targeting `main`.

## Safety Boundaries

- Never read or commit `.env` files, API keys, OneBot tokens, Fish reference IDs, or private personas.
- Never run tests against production `room.sqlite` or restart a live service without explicit Owner authorization.
- Keep `room.sqlite` schema v9 backwards-compatible; back up before any schema migration.
- Treat platform ACKs and real QQ client playback separately; synthetic tests do not substitute for real-client verification.
