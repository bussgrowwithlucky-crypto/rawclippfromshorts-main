# Google Colab T4 + Ollama + Qwen 3.5 9B

This app can now point Ollama at a remote endpoint, so the archive discovery still runs on your PC while Qwen inference runs on Google Colab's GPU.

## What You Run In Colab

1. Open a new Google Colab notebook.
2. Set the runtime to `GPU`.
3. Upload or copy [`scripts/colab_ollama_qwen35_9b.py`](../scripts/colab_ollama_qwen35_9b.py) into the notebook environment.
4. Run:

```python
!python /content/colab_ollama_qwen35_9b.py
```

The script will:

- install Ollama
- install `cloudflared`
- start `ollama serve`
- pull `qwen3.5:9b`
- open a Cloudflare quick tunnel to the Ollama HTTP server
- print a JSON block with `ollamaBaseUrl` and `ollamaModel`

## What You Set In This App

In the app's `Model` panel:

1. Set `Provider` to `Ollama (local or remote)`.
2. In `Saved endpoint for Colab or another GPU host`:
   - paste the printed `ollamaBaseUrl`
   - set `Saved Ollama model` to `qwen3.5:9b`
3. Click `Save Ollama Settings`.
4. Start processing.

After that, Ollama requests go to Colab instead of your PC.

## Important Limits

- Keep the Colab runtime open while the app is using it.
- If Colab disconnects, the quick tunnel URL changes. Save the new URL in the app again.
- The app still indexes local files on your PC. Only model inference moves to Colab.
- Quick tunnels are fine for testing and personal use. They are not a stable production deployment.

## Logs

The Colab script writes logs to:

- `/content/colab-ollama/logs/ollama.log`
- `/content/colab-ollama/logs/cloudflared.log`
