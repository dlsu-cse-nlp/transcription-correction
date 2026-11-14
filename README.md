# Manual phoneme transcription correction for FLEURS, etc.

## Setup

1. Copy the `data` directory from the main project repository to this repository
2. Perform the usual setup with `uv sync`.
3. Run with `python server.py`

## Comparing two outputs

Open <http://127.0.0.1:8000/compare.html>. It matches two `.jsonl` outputs on `audio_filepath`, counts the conflicts, writes everything that agrees to a new output file, then lets you pick A, pick B, edit by hand, or raise the entry to an expert (`"raise_to_expert": true` plus `text_a` / `text_b`).

To speed up review, each conflict is split into word-level differences. Pick A or B per difference (`Alt+1` / `Alt+2`), apply the suggestions (`Alt+S`), or accept them and save in one go (`Alt+A`). Suggestions come from the phoneme chart rules and from a lexicon of words both files agree on; a pair you have already decided is pre-filled the next time it appears. `comparisons.py` holds the alignment and suggestion logic.

## Output datasets and processing pipeline

The `output/` directory contains annotation files across different processing stages for FLEURS and FSC datasets.

```
output/
├── fleurs/
│   ├── test/
│   │   ├── fleurs_test_raw_lorenz.jsonl
│   │   ├── fleurs_test_raw_paulo.jsonl
│   │   ├── fleurs_test_resolved_raw.jsonl
│   │   ├── fleurs_test_resolved.jsonl
│   │   ├── fleurs_test_resolved_audit.jsonl
│   │   ├── fleurs_test_resolved_expert.jsonl
│   │   └── fleurs_test_resolved_no_expert.jsonl
│   └── valid/
│       ├── fleurs_valid_raw_lorenz.jsonl
│       ├── fleurs_valid_raw_paulo.jsonl
│       ├── fleurs_valid_resolved_raw.jsonl
│       ├── fleurs_valid_resolved.jsonl
│       ├── fleurs_valid_resolved_audit.jsonl
│       ├── fleurs_valid_resolved_expert.jsonl
│       └── fleurs_valid_resolved_no_expert.jsonl
└── fsc/
    ├── test/
    │   ├── fsc_test_raw_lorenz.jsonl
    │   ├── fsc_test_raw_paulo.jsonl
    │   ├── fsc_test_resolved_raw.jsonl
    │   ├── fsc_test_resolved.jsonl
    │   ├── fsc_test_resolved_audit.jsonl
    │   ├── fsc_test_resolved_expert.jsonl
    │   └── fsc_test_resolved_no_expert.jsonl
    └── valid/
        ├── fsc_valid_raw_lorenz.jsonl
        ├── fsc_valid_raw_paulo.jsonl
        ├── fsc_valid_resolved_raw.jsonl
        ├── fsc_valid_resolved.jsonl
        ├── fsc_valid_resolved_audit.jsonl
        ├── fsc_valid_resolved_expert.jsonl
        └── fsc_valid_resolved_no_expert.jsonl
```

### Reproduction

#### Remove single-word utterances from FSC

Filter single-word utterances from raw source manifests before annotation using `scripts/remove_single_word.py`:

```bash
python scripts/remove_single_word.py data/fsc/test_manifest.json -o data/fsc/test_manifest_multiword.json
python scripts/remove_single_word.py data/fsc/valid_manifest.json -o data/fsc/valid_manifest_multiword_clean.json
```

#### Manual correction

1. Start the local server (`python server.py`) and complete per-annotator phoneme corrections at <http://127.0.0.1:8000/> to produce `output/<dataset>/<split>/<prefix>_raw_{lorenz,paulo}.jsonl`.
2. Resolve conflicts between the two annotators at <http://127.0.0.1:8000/compare.html> (`comparisons.py`) and save the merged output as `output/<dataset>/<split>/<prefix>_resolved_raw.jsonl`.

#### Pipeline
To regenerate all `*_resolved.jsonl`, `*_resolved_audit.jsonl`, `*_resolved_expert.jsonl`, and `*_resolved_no_expert.jsonl` manifests across `fleurs/test`, `fleurs/valid`, `fsc/test`, and `fsc/valid` from `*_resolved_raw.jsonl`:

```bash
python scripts/run_pipeline.py
```

Or run each stage manually for a single split:

```bash
# Remove monosyllabic stress and deduplicate multi-stress words
python scripts/unstress_monosyllables.py output/<dataset>/<split>/<prefix>_resolved_raw.jsonl -o /tmp/<prefix>_unstressed.jsonl
python scripts/keep_last_stress.py /tmp/<prefix>_unstressed.jsonl -o output/<dataset>/<split>/<prefix>_resolved.jsonl
rm /tmp/<prefix>_unstressed.jsonl

# Apply audit rule fixes (inventory, tie bars, glottal stops, stress)
python scripts/audit_transcriptions.py output/<dataset>/<split>/<prefix>_resolved.jsonl -o output/<dataset>/<split>/<prefix>_resolved_audit.jsonl

# Split into expert-flagged and non-expert manifests
python scripts/extract_expert.py output/<dataset>/<split>/<prefix>_resolved_audit.jsonl \
    -o output/<dataset>/<split>/<prefix>_resolved_expert.jsonl \
    -n output/<dataset>/<split>/<prefix>_resolved_no_expert.jsonl
```

### Pipeline overview

```
[Annotator Raw Reviews]
(*_raw_{lorenz,paulo}.jsonl)
                 │
                 ▼
[Blind Adjudication]
(compare.html / comparisons.py)
                 │
                 ▼
[Raw Adjudicated Merge]
(*_resolved_raw.jsonl)
                 │
                 ▼
[scripts/unstress_monosyllables.py]
+ [scripts/keep_last_stress.py]
(*_resolved.jsonl)
                 │
                 ▼
[scripts/audit_transcriptions.py]
(*_resolved_audit.jsonl)
                 │
                 ▼
[scripts/extract_expert.py]
  ┌──────────────┴──────────────┐
  ▼                             ▼
 (*_resolved_expert.jsonl)  (*_resolved_no_expert.jsonl)
```
