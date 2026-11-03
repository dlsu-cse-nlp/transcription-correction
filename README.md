# Manual phoneme transcription correction for FLEURS, etc.

## Setup

1. Copy the `data` directory from the main project repository to this repository
2. Perform the usual setup with `uv sync`.
3. Run with `python server.py`

## Comparing two outputs

Open <http://127.0.0.1:8000/compare.html>. It matches two `.jsonl` outputs on `audio_filepath`, counts the conflicts, writes everything that agrees to a new output file, then lets you pick A, pick B, edit by hand, or raise the entry to an expert (`"raise_to_expert": true` plus `text_a` / `text_b`).

To speed up review, each conflict is split into word-level differences. Pick A or B per difference (`Alt+1` / `Alt+2`), apply the suggestions (`Alt+S`), or accept them and save in one go (`Alt+A`). Suggestions come from the phoneme chart rules and from a lexicon of words both files agree on; a pair you have already decided is pre-filled the next time it appears. `triage.py` holds the alignment and suggestion logic.
