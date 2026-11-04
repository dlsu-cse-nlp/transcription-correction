# Manual phoneme transcription correction for FLEURS, etc.

## Setup

1. Copy the `data` directory from the main project repository to this repository
2. Perform the usual setup with `uv sync`.
3. Run with `python server.py`

## Comparing two outputs

Open <http://127.0.0.1:8000/compare.html>. It matches two `.jsonl` outputs on `audio_filepath`, counts the conflicts, writes everything that agrees to a new output file, then lets you pick A, pick B, edit by hand, or raise the entry to an expert (`"raise_to_expert": true` plus `text_a` / `text_b`).

To speed up review, each conflict is split into word-level differences. Pick A or B per difference (`Alt+1` / `Alt+2`), apply the suggestions (`Alt+S`), or accept them and save in one go (`Alt+A`). Suggestions come from the phoneme chart rules and from a lexicon of words both files agree on; a pair you have already decided is pre-filled the next time it appears. `triage.py` holds the alignment and suggestion logic.

### Blind adjudication

The compare page hides which annotator wrote what:

- Nothing in the review screen shows a file name. Transcriptions are labelled **Version 1** (left) and **Version 2** (right), and the A/B reasons behind suggestions are rewritten to match.
- Which annotator's transcription is on the left is pseudo-random per `audio_filepath` (a hash of the path), so it is stable when you resume or reload. `Alt+1` / `Alt+2` always mean "left" / "right"; the page maps your choice back to the real file when it saves.
- The review bar shows **Sent to expert** (entries currently flagged `raise_to_expert`, including ones from a resumed output) and **Edited beyond picking**.
- Every entry where the saved text cannot be built by choosing version 1 or 2 for each word-level difference (free edits, including edited expert entries) has its `audio_filepath` written to `<output name>_edited.txt` next to the output file, one per line. Pure picks, whole-version picks and per-difference merges are not listed. The file is rewritten on every save (so re-deciding an entry updates it) and rebuilt from the output when you resume.