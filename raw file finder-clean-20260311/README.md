# Raw File Finder

Local-host archive indexing app for mirrored Frame.io archives and Frame.io folder/share links, with AI transcript-to-raw matching.

## Features

- Local archive mode via filesystem path input.
- Local archive folder selection from the UI on Windows.
- Frame.io link mode with recursive folder traversal.
- Metadata-first indexing with local cache files for faster reruns.
- Resumable Frame.io sync state.
- Frame.io authentication via env vars or browser-session credentials saved in the UI.
- Transcript paste/upload plus ranked text upload.
- AI matching through Ollama, Gemini CLI, NVIDIA API, or OpenRouter.
- Search UI over indexed media metadata.

## Prerequisites

- Node.js 24+
- npm 11+
- Optional Frame.io credentials in `.env`
- Optional local Ollama runtime, Gemini CLI access, or NVIDIA/OpenRouter API access for AI matching

## Credentials

- This repository does not include API keys, cookies, tokens, or saved runtime credentials.
- Copy `.env.example` to `.env` on your own machine and fill in only your own credentials.
- If you use the app UI to save provider credentials at runtime, those stay in local generated files and are ignored by git.

## Run

```bash
npm install
npm run dev
```

- Client: `http://localhost:5173`
- Server: `http://localhost:4000`

## Frame.io Notes

- The app accepts Frame.io URLs and attempts to resolve the root folder or asset automatically.
- For authenticated content, set `FRAMEIO_BEARER_TOKEN` and optionally `FRAMEIO_SESSION_COOKIE`, or save the same values in the UI for the current browser session.
- Sync state is stored under `data/cache/frameio/`.

## AI Matching Notes

- Default local provider: Ollama at `http://127.0.0.1:11434`
- Recommended local model on this machine: `qwen3.5:latest`
- Remote Ollama is supported through the app UI, so Ollama can run on Google Colab or another GPU host while this app stays on your PC.
- Gemini CLI is also supported if `gemini` is installed and authenticated.
- NVIDIA and OpenRouter are also supported through API keys in env vars or the app runtime settings.
- The app first discovers and indexes archive metadata, then sends the transcript plus top-ranked candidate media into the selected AI provider and returns matched raw files with reasons and direct links.

## Google Colab Setup

- Use [`scripts/colab_ollama_qwen35_9b.py`](./scripts/colab_ollama_qwen35_9b.py) in a Colab GPU runtime to start Ollama and expose it through a quick tunnel.
- Full setup notes: [`docs/google-colab-ollama-qwen35-9b.md`](./docs/google-colab-ollama-qwen35-9b.md)
