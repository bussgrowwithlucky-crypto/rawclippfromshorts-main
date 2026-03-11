#!/usr/bin/env python3
from __future__ import annotations

import json
import os
import re
import shutil
import socket
import subprocess
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

MODEL_NAME = os.environ.get("OLLAMA_MODEL", "qwen3.5:9b")
OLLAMA_HOST = os.environ.get("OLLAMA_HOST", "127.0.0.1:11434")
OLLAMA_HTTP_URL = f"http://{OLLAMA_HOST}"
WORKDIR = Path("/content/colab-ollama")
LOGDIR = WORKDIR / "logs"
CLOUDFLARED_BIN = Path("/usr/local/bin/cloudflared")
TUNNEL_PATTERN = re.compile(r"https://[a-z0-9-]+\.trycloudflare\.com")


def run_command(args: list[str], *, env: dict[str, str] | None = None, check: bool = True) -> subprocess.CompletedProcess[str]:
  printable = " ".join(args)
  print(f"$ {printable}", flush=True)
  return subprocess.run(args, env=env, check=check, text=True, capture_output=False)


def ensure_dirs() -> None:
  LOGDIR.mkdir(parents=True, exist_ok=True)


def print_gpu_details() -> None:
  print("Inspecting GPU...", flush=True)
  try:
    run_command(["nvidia-smi"])
  except Exception as error:  # noqa: BLE001
    print(f"Unable to read GPU details: {error}", flush=True)


def ensure_ollama_installed() -> None:
  if shutil.which("ollama"):
    print("Ollama is already installed.", flush=True)
    return

  run_command(["bash", "-lc", "curl -fsSL https://ollama.com/install.sh | sh"])


def ensure_cloudflared_installed() -> None:
  if shutil.which("cloudflared") or CLOUDFLARED_BIN.exists():
    print("cloudflared is already installed.", flush=True)
    return

  run_command([
    "curl",
    "-L",
    "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64",
    "-o",
    str(CLOUDFLARED_BIN),
  ])
  run_command(["chmod", "+x", str(CLOUDFLARED_BIN)])


def stop_previous_processes() -> None:
  run_command(["bash", "-lc", "pkill -f 'ollama serve' || true"], check=False)
  run_command(["bash", "-lc", "pkill -f 'cloudflared tunnel --url http://127.0.0.1:11434' || true"], check=False)


def wait_for_port(host: str, port: int, timeout_seconds: int = 60) -> None:
  deadline = time.time() + timeout_seconds
  while time.time() < deadline:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
      sock.settimeout(1)
      if sock.connect_ex((host, port)) == 0:
        return
    time.sleep(1)

  raise RuntimeError(f"Ollama did not start on {host}:{port} within {timeout_seconds} seconds.")


def start_ollama_server() -> None:
  server_env = os.environ.copy()
  server_env["OLLAMA_HOST"] = OLLAMA_HOST
  server_env["OLLAMA_KEEP_ALIVE"] = "24h"
  log_path = LOGDIR / "ollama.log"
  with log_path.open("a", encoding="utf8") as log_file:
    subprocess.Popen(  # noqa: S603
      ["ollama", "serve"],
      env=server_env,
      stdout=log_file,
      stderr=subprocess.STDOUT,
      start_new_session=True,
    )

  wait_for_port("127.0.0.1", 11434, timeout_seconds=60)


def pull_model() -> None:
  pull_env = os.environ.copy()
  pull_env["OLLAMA_HOST"] = OLLAMA_HOST
  run_command(["ollama", "pull", MODEL_NAME], env=pull_env)
  run_command(["ollama", "list"], env=pull_env)


def read_tunnel_url(log_path: Path, timeout_seconds: int = 60) -> str:
  deadline = time.time() + timeout_seconds
  while time.time() < deadline:
    content = log_path.read_text(encoding="utf8", errors="ignore")
    match = TUNNEL_PATTERN.search(content)
    if match:
      return match.group(0)
    time.sleep(1)

  raise RuntimeError(f"Cloudflare tunnel URL was not found in {log_path} within {timeout_seconds} seconds.")


def start_cloudflare_tunnel() -> str:
  log_path = LOGDIR / "cloudflared.log"
  log_path.write_text("", encoding="utf8")

  with log_path.open("a", encoding="utf8") as log_file:
    subprocess.Popen(  # noqa: S603
      [
        str(CLOUDFLARED_BIN if CLOUDFLARED_BIN.exists() else "cloudflared"),
        "tunnel",
        "--url",
        OLLAMA_HTTP_URL,
        "--no-autoupdate",
      ],
      stdout=log_file,
      stderr=subprocess.STDOUT,
      start_new_session=True,
    )

  return read_tunnel_url(log_path)


def post_json(url: str, payload: dict[str, object], timeout_seconds: int = 120) -> dict[str, object]:
  request = urllib.request.Request(
    url,
    data=json.dumps(payload).encode("utf8"),
    headers={"Content-Type": "application/json"},
  )
  with urllib.request.urlopen(request, timeout=timeout_seconds) as response:
    return json.loads(response.read().decode("utf8"))


def fetch_json(url: str, timeout_seconds: int = 30) -> dict[str, object]:
  with urllib.request.urlopen(url, timeout=timeout_seconds) as response:
    return json.loads(response.read().decode("utf8"))


def warm_model() -> None:
  try:
    post_json(
      f"{OLLAMA_HTTP_URL}/api/generate",
      {
        "model": MODEL_NAME,
        "prompt": "OK",
        "stream": False,
        "think": False,
        "options": {
          "num_predict": 1,
          "temperature": 0,
        },
        "keep_alive": "24h",
      },
    )
  except urllib.error.URLError as error:
    raise RuntimeError(f"Model warmup failed: {error}") from error


def main() -> int:
  ensure_dirs()
  print_gpu_details()
  ensure_ollama_installed()
  ensure_cloudflared_installed()
  stop_previous_processes()
  start_ollama_server()
  pull_model()
  warm_model()
  public_url = start_cloudflare_tunnel()
  tags = fetch_json(f"{OLLAMA_HTTP_URL}/api/tags")

  print("", flush=True)
  print("Colab Ollama endpoint is ready.", flush=True)
  print(json.dumps({
    "ollamaBaseUrl": public_url,
    "ollamaModel": MODEL_NAME,
    "installedModels": [model.get("name") for model in tags.get("models", []) if isinstance(model, dict)],
    "logs": {
      "ollama": str(LOGDIR / "ollama.log"),
      "cloudflared": str(LOGDIR / "cloudflared.log"),
    },
  }, indent=2), flush=True)
  print("", flush=True)
  print("Paste `ollamaBaseUrl` into the app's saved Ollama endpoint field.", flush=True)
  print("Keep this Colab runtime open. If Colab disconnects, the tunnel URL changes and the app must be updated.", flush=True)
  return 0


if __name__ == "__main__":
  try:
    raise SystemExit(main())
  except Exception as error:  # noqa: BLE001
    print(f"FAILED: {error}", file=sys.stderr, flush=True)
    raise
