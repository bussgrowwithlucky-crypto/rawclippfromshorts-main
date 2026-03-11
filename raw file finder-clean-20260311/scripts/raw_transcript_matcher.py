import argparse
import hashlib
import json
import re
import sys
from pathlib import Path
from typing import Any

from faster_whisper import WhisperModel

VIDEO_EXTENSIONS = {".mp4", ".mov", ".mxf", ".m4v", ".avi", ".mkv", ".wmv", ".webm"}

STOP_WORDS = {
    "a", "an", "the", "and", "or", "but", "in", "on", "at", "to", "for",
    "of", "with", "by", "from", "is", "it", "its", "was", "are", "were",
    "be", "been", "being", "have", "has", "had", "do", "does", "did",
    "will", "would", "shall", "should", "may", "might", "can", "could",
    "not", "no", "nor", "so", "if", "as", "that", "this", "these", "those",
    "he", "she", "we", "they", "you", "i", "me", "my", "his", "her", "our",
    "their", "your", "all", "any", "each", "more", "some", "what", "when",
    "com", "shorts", "youtube", "youtu", "http", "https", "www", "watch", "views",
}

MODEL_CACHE: dict[str, WhisperModel] = {}


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("--input-json", required=True)
    return parser.parse_args()


def load_input(path_str: str) -> dict[str, Any]:
    return json.loads(Path(path_str).read_text(encoding="utf-8"))


def tokenize(text: str) -> list[str]:
    return [t for t in re.findall(r"\b[a-z0-9]+\b", text.lower()) if len(t) >= 3 and t not in STOP_WORDS]


def walk_raw_files(folder: Path) -> list[Path]:
    files = []
    for f in folder.rglob("*"):
        if f.is_file() and f.suffix.lower() in VIDEO_EXTENSIONS:
            files.append(f)
    return sorted(files)


def get_whisper_model(model_name: str) -> WhisperModel:
    if model_name not in MODEL_CACHE:
        MODEL_CACHE[model_name] = WhisperModel(model_name, device="cpu", compute_type="int8")
    return MODEL_CACHE[model_name]


def transcribe_raw_file(
    file_path: Path, model_name: str, cache_dir: Path, force_refresh: bool
) -> tuple[str, str]:
    """Returns (status, transcript_text). Status: 'transcribed', 'cached', 'failed'."""
    stats = file_path.stat()
    cache_key = hashlib.sha1(
        f"{file_path.as_posix()}|{stats.st_size}|{stats.st_mtime_ns}|{model_name}".encode("utf-8")
    ).hexdigest()
    cache_path = cache_dir / f"{cache_key}.json"

    if cache_path.exists() and not force_refresh:
        cached = json.loads(cache_path.read_text(encoding="utf-8"))
        return "cached", cached.get("text", "")

    try:
        model = get_whisper_model(model_name)
        segments, _info = model.transcribe(
            str(file_path),
            beam_size=1,
            vad_filter=True,
            condition_on_previous_text=False,
        )
        text = re.sub(
            r"\s+", " ", " ".join(seg.text.strip() for seg in segments if seg.text.strip())
        ).strip()
        payload = {
            "filePath": file_path.as_posix(),
            "model": model_name,
            "text": text,
        }
        cache_path.write_text(json.dumps(payload, ensure_ascii=True, indent=2), encoding="utf-8")
        return "transcribed", text
    except Exception:  # noqa: BLE001
        return "failed", ""


def compute_overlap_score(
    short_text: str,
    raw_text: str,
    short_title: str,
    raw_filename: str,
) -> tuple[float, list[str], str]:
    """Returns (confidence, matched_tokens, evidence_snippet)."""
    short_tokens = set(tokenize(short_text))
    raw_tokens_list = tokenize(raw_text)
    raw_tokens_set = set(raw_tokens_list)

    if not short_tokens:
        return 0.0, [], ""

    matched = short_tokens & raw_tokens_set
    overlap = len(matched) / len(short_tokens)

    # Window bonus: slide a window of 2× short token count over raw tokens
    window_bonus = 0.0
    if len(matched) >= 2:
        window_size = max(1, 2 * len(short_tokens))
        best_window_overlap = 0.0
        for i in range(max(1, len(raw_tokens_list) - window_size + 1)):
            window = set(raw_tokens_list[i : i + window_size])
            wo = len(short_tokens & window) / len(short_tokens)
            if wo > best_window_overlap:
                best_window_overlap = wo
        if best_window_overlap > 0.5:
            window_bonus = 0.15

    # Title bonus: content words in short title found in raw filename (+0.05 each, cap 0.15)
    title_tokens = set(tokenize(short_title))
    filename_tokens = set(tokenize(raw_filename))
    title_bonus = min(0.15, len(title_tokens & filename_tokens) * 0.05)

    confidence = min(1.0, overlap + window_bonus + title_bonus)

    # Evidence snippet: ±40 chars around first matched token, 220 char cap
    evidence = ""
    if matched:
        first_token = sorted(matched)[0]
        idx = raw_text.lower().find(first_token)
        if idx >= 0:
            start = max(0, idx - 40)
            end = min(len(raw_text), idx + 40 + len(first_token))
            snippet = raw_text[start:end]
            if len(snippet) > 220:
                snippet = snippet[:220]
            prefix = "..." if start > 0 else ""
            suffix = "..." if end < len(raw_text) else ""
            evidence = f"{prefix}{snippet}{suffix}"

    return confidence, sorted(matched), evidence


def build_output(input_payload: dict[str, Any]) -> dict[str, Any]:
    references = input_payload.get("references", [])
    raw_folder = Path(input_payload["rawFolderPath"])
    cache_dir = Path(input_payload["rawTranscriptCacheDir"])
    model_name = input_payload.get("model") or "base"
    force_refresh = bool(input_payload.get("forceRefresh"))
    match_threshold = float(input_payload.get("matchThreshold", 0.35))
    max_matches = int(input_payload.get("maxMatchesPerReference", 3))

    cache_dir.mkdir(parents=True, exist_ok=True)

    raw_files = walk_raw_files(raw_folder)
    summary: dict[str, Any] = {
        "rawFilesFound": len(raw_files),
        "rawFilesTranscribed": 0,
        "rawFilesCached": 0,
        "rawFilesFailed": 0,
    }

    raw_file_transcripts: list[tuple[Path, str]] = []
    for file_path in raw_files:
        status, text = transcribe_raw_file(file_path, model_name, cache_dir, force_refresh)
        if status == "transcribed":
            summary["rawFilesTranscribed"] += 1
        elif status == "cached":
            summary["rawFilesCached"] += 1
        else:
            summary["rawFilesFailed"] += 1
        if status != "failed":
            raw_file_transcripts.append((file_path, text))

    reference_matches: list[dict[str, Any]] = []
    for ref in references:
        ref_id = ref.get("id", "")
        ref_url = ref.get("referenceUrl", "")
        ref_title = ref.get("title", "")
        transcript_text = ref.get("transcriptText", "").strip()
        transcript_status = ref.get("transcriptStatus", "failed")

        if not transcript_text or transcript_status == "failed":
            reference_matches.append({
                "referenceId": ref_id,
                "referenceUrl": ref_url,
                "referenceTitle": ref_title,
                "matches": [],
                "skipped": True,
                "skipReason": "No transcript available" if not transcript_text else "Transcript status failed",
            })
            continue

        scored: list[dict[str, Any]] = []
        for file_path, raw_text in raw_file_transcripts:
            confidence, matched_tokens, evidence = compute_overlap_score(
                transcript_text, raw_text, ref_title, file_path.name
            )
            if confidence >= match_threshold:
                scored.append({
                    "rawFilePath": file_path.as_posix(),
                    "confidence": round(confidence, 4),
                    "matchedTokens": matched_tokens,
                    "evidenceSnippet": evidence,
                })

        scored.sort(key=lambda x: x["confidence"], reverse=True)
        reference_matches.append({
            "referenceId": ref_id,
            "referenceUrl": ref_url,
            "referenceTitle": ref_title,
            "matches": scored[:max_matches],
        })

    return {
        "summary": summary,
        "referenceMatches": reference_matches,
    }


def main() -> int:
    args = parse_args()
    payload = load_input(args.input_json)
    result = build_output(payload)
    json.dump(result, sys.stdout, ensure_ascii=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
