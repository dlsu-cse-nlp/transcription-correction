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
├── resolved_expert_a.jsonl
├── resolved_expert_b.jsonl
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

## Dictée recording datasets and manifest merge

Two notebooks generate speech prompt datasets for acoustic evaluation and recording with [Dictée](https://github.com/benjaminbellamy/Dictee):
- `notebooks/g2p_error_simulation.ipynb`: Generates 100 samples (50 clean sentences + 50 sentences with simulated phoneme errors: stress shift, vowel confusion, r/l confusion, glottal deletion).
- `notebooks/wikipron_dual_pronunciations.ipynb`: Generates 100 samples (50 words x 2 valid pronunciation variants contrasting stress, glottal stop, or both).

Both notebooks export prompts formatted for Dictée into `output/dictee/<dataset>/sentences.txt` alongside companion metadata. Prompt entries in `sentences.txt` are strictly formatted as IPA phonemic transcriptions (rather than orthographic graphemes) so the speaker articulates the exact phonetic sequence and stress pattern.

### Recording with Dictée

Run Dictée pointing to the exported `sentences.txt`:

```bash
flatpak run fr.benjaminbellamy.dictee output/dictee/g2p_error_simulation/sentences.txt
# or
flatpak run fr.benjaminbellamy.dictee output/dictee/wikipron_dual_pronunciations/sentences.txt
```

Dictée records 16 kHz mono WAV files (`audio_00.wav`, `audio_01.wav`, ...) and writes a TSV manifest (`trans.txt`) into a `sentences/` subfolder.

### Merging back into manifest JSONL

Use `scripts/merge_dictee.py` (or the merger cells directly inside each notebook) to pair the recorded audio files with their metadata and calculate durations:

```bash
# Merge G2P error simulation recordings
python scripts/merge_dictee.py \
    --dictee-dir output/dictee/g2p_error_simulation/sentences \
    --metadata output/dictee/g2p_error_simulation/metadata.csv \
    --output output/dictee/g2p_error_simulation/manifest.jsonl

# Merge WikiPron dual-pronunciation recordings
python scripts/merge_dictee.py \
    --dictee-dir output/dictee/wikipron_dual_pronunciations/sentences \
    --metadata output/dictee/wikipron_dual_pronunciations/metadata.csv \
    --output output/dictee/wikipron_dual_pronunciations/manifest.jsonl
```

Pass `--dry-run` to build placeholder manifests before recording begins.

