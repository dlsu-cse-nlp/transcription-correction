# Manual phoneme transcription correction for FLEURS, etc.

## Setup

1. Copy the `data` directory from the main project repository to this repository
2. Perform the usual setup with `uv sync`.
3. Run with `python server.py`

## Comparing two outputs

Open <http://127.0.0.1:8000/compare.html>. It matches two `.jsonl` outputs on `audio_filepath`, counts the conflicts, writes everything that agrees to a new output file, then lets you pick A, pick B, edit by hand, or raise the entry to an expert (`"raise_to_expert": true` plus `text_a` / `text_b`).
