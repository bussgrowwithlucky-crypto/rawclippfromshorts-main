import argparse
import hashlib
import json
import re
import shutil
import sys
from pathlib import Path
from typing import Any

import imageio_ffmpeg
from faster_whisper import WhisperModel
from yt_dlp import YoutubeDL

URL_PATTERN = re.compile(
    r"https?://(?:www\.)?(?:youtube\.com/shorts/[^\s)]+|youtube\.com/watch\?[^\s)]+|youtu\.be/[^\s)]+)",
    re.IGNORECASE,
)
ITEM_PREFIX_PATTERN = re.compile(r"^\s*(\d+[\).\:-]|\-|\*)\s+")

MODEL_CACHE: dict[str, WhisperModel] = {}


class QuietLogger:
    def debug(self, message: str) -> None:
        if message.startswith("[debug]"):
            return

    def warning(self, message: str) -> None:
        return

    def error(self, message: str) -> None:
        return


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-json", required=True)
    return parser.parse_args()


def load_input(path_str: str) -> dict[str, Any]:
    return json.loads(Path(path_str).read_text(encoding="utf-8"))


def normalize_space(value: str) -> str:
    return re.sub(r"\s+", " ", value).strip()


def strip_item_prefix(value: str) -> str:
    return ITEM_PREFIX_PATTERN.sub("", value).strip()


def split_reference_groups(raw_text: str) -> list[list[str]]:
    groups: list[list[str]] = []
    current: list[str] = []

    for raw_line in raw_text.splitlines():
      line = raw_line.strip()
      if not line:
        if current:
          groups.append(current)
          current = []
        continue

      if ITEM_PREFIX_PATTERN.match(line) and current:
        groups.append(current)
        current = [line]
        continue

      current.append(line)

    if current:
      groups.append(current)

    return groups


def extract_title(lines: list[str], urls: list[str]) -> str:
    for line in lines:
      if any(url in line for url in urls):
        candidate = normalize_space(URL_PATTERN.sub("", line))
        if candidate:
          return strip_item_prefix(candidate)
        continue

      cleaned = strip_item_prefix(line)
      if cleaned:
        return cleaned

    return strip_item_prefix(lines[0]) if lines else "Reference clip"


def parse_reference_entries(raw_text: str, max_items: int) -> list[dict[str, Any]]:
    entries: list[dict[str, Any]] = []

    for group in split_reference_groups(raw_text):
      group_text = "\n".join(group)
      urls = URL_PATTERN.findall(group_text)
      if not urls:
        continue

      title = extract_title(group, urls)
      context = normalize_space(URL_PATTERN.sub("", group_text))
      source_hash = hashlib.sha1(urls[0].encode("utf-8")).hexdigest()[:16]

      entries.append(
        {
          "id": source_hash,
          "referenceUrl": urls[0],
          "title": title or "Reference clip",
          "context": context or title or "Reference clip",
          "sourceText": group_text,
        }
      )

      if len(entries) >= max_items:
        break

    return entries


def find_downloaded_media(media_dir: Path) -> Path | None:
    for candidate in sorted(media_dir.glob("*")):
      if candidate.is_file() and candidate.suffix.lower() in {".mp4", ".m4a", ".webm", ".mov", ".mkv"}:
        return candidate
    return None


def download_reference_media(entry: dict[str, Any], media_root: Path, force_refresh: bool) -> tuple[str, Path | None, str | None]:
    media_dir = media_root / entry["id"]
    info_path = media_dir / "info.json"

    if force_refresh and media_dir.exists():
      shutil.rmtree(media_dir)

    media_dir.mkdir(parents=True, exist_ok=True)

    cached_media = find_downloaded_media(media_dir)
    if cached_media and info_path.exists():
      return "cached", cached_media, None

    ffmpeg_path = imageio_ffmpeg.get_ffmpeg_exe()
    ydl_opts: dict[str, Any] = {
      "outtmpl": str(media_dir / "%(id)s.%(ext)s"),
      "format": "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]/best",
      "merge_output_format": "mp4",
      "ffmpeg_location": ffmpeg_path,
      "quiet": True,
      "no_warnings": True,
      "noprogress": True,
      "noplaylist": True,
      "retries": 3,
      "overwrites": force_refresh,
      "concurrent_fragment_downloads": 4,
      "logger": QuietLogger(),
    }

    try:
      with YoutubeDL(ydl_opts) as ydl:
        info = ydl.extract_info(entry["referenceUrl"], download=True)
      info_path.write_text(json.dumps(info, ensure_ascii=True, indent=2, default=str), encoding="utf-8")
    except Exception as error:  # noqa: BLE001
      return "failed", None, f"Download failed: {error}"

    downloaded_media = find_downloaded_media(media_dir)
    if not downloaded_media:
      return "failed", None, "Download completed but no local media file was found."

    return "downloaded", downloaded_media, None


def get_whisper_model(model_name: str) -> WhisperModel:
    if model_name not in MODEL_CACHE:
      MODEL_CACHE[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8")
    return MODEL_CACHE[model_name]


def transcribe_media(entry: dict[str, Any], media_path: Path, transcript_root: Path, model_name: str, force_refresh: bool) -> tuple[str, Path | None, str, str | None]:
    transcript_root.mkdir(parents=True, exist_ok=True)
    media_stats = media_path.stat()
    transcript_key = hashlib.sha1(
      f"{entry['referenceUrl']}|{media_stats.st_size}|{media_stats.st_mtime_ns}|{model_name}".encode("utf-8")
    ).hexdigest()
    transcript_path = transcript_root / f"{transcript_key}.json"

    if transcript_path.exists() and not force_refresh:
      cached = json.loads(transcript_path.read_text(encoding="utf-8"))
      return "cached", transcript_path, cached.get("text", ""), None

    try:
      model = get_whisper_model(model_name)
      segments, info = model.transcribe(
        str(media_path),
        beam_size=1,
        vad_filter=True,
        condition_on_previous_text=False,
      )
      text = normalize_space(" ".join(segment.text.strip() for segment in segments if segment.text.strip()))
      payload = {
        "referenceUrl": entry["referenceUrl"],
        "title": entry["title"],
        "context": entry["context"],
        "mediaPath": str(media_path),
        "model": model_name,
        "language": getattr(info, "language", None),
        "duration": getattr(info, "duration", None),
        "text": text,
      }
      transcript_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
      return "transcribed", transcript_path, text, None
    except Exception as error:  # noqa: BLE001
      return "failed", None, "", f"Transcription failed: {error}"


def build_output(input_payload: dict[str, Any]) -> dict[str, Any]:
    media_root = Path(input_payload["mediaCacheDir"])
    transcript_root = Path(input_payload["transcriptCacheDir"])
    force_refresh = bool(input_payload.get("forceRefresh"))
    whisper_model = input_payload.get("model") or "base"
    max_items = int(input_payload.get("maxItems") or 40)

    entries = parse_reference_entries(input_payload.get("text", ""), max_items)
    results: list[dict[str, Any]] = []
    summary = {
      "total": len(entries),
      "downloaded": 0,
      "cachedMedia": 0,
      "transcribed": 0,
      "cachedTranscripts": 0,
      "failed": 0,
    }

    for entry in entries:
      download_status, media_path, download_error = download_reference_media(entry, media_root, force_refresh)
      if download_status == "downloaded":
        summary["downloaded"] += 1
      elif download_status == "cached":
        summary["cachedMedia"] += 1

      transcript_status = "failed"
      transcript_path: Path | None = None
      transcript_text = ""
      failure_message = download_error

      if media_path:
        transcript_status, transcript_path, transcript_text, transcript_error = transcribe_media(
          entry,
          media_path,
          transcript_root,
          whisper_model,
          force_refresh,
        )
        if transcript_status == "transcribed":
          summary["transcribed"] += 1
        elif transcript_status == "cached":
          summary["cachedTranscripts"] += 1
        if transcript_error:
          failure_message = transcript_error

      if failure_message:
        summary["failed"] += 1

      results.append(
        {
          **entry,
          "mediaPath": str(media_path) if media_path else None,
          "transcriptPath": str(transcript_path) if transcript_path else None,
          "downloadStatus": download_status,
          "transcriptStatus": transcript_status,
          "transcriptText": transcript_text,
          "failureMessage": failure_message,
        }
      )

    return {
      "summary": summary,
      "references": results,
    }


def main() -> int:
    args = parse_args()
    payload = load_input(args.input_json)
    result = build_output(payload)
    json.dump(result, sys.stdout, ensure_ascii=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
