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
├── resolved_expert_a_grouped.jsonl
├── resolved_expert_b_grouped.jsonl
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

### Expert review manifests and `error_type` legend

All 102 entries flagged with `"raise_to_expert": true` across FLEURS and FSC are combined into `output/resolved_expert_{a,b}.jsonl` (in split order) and `output/resolved_expert_{a,b}_grouped.jsonl` (grouped by conflict type and sub-clustered by recurring word/pattern for `compare.html`). Each entry carries an `"error_type"` key:

| `error_type` | Description | Representative Conflicts | Samples | Grouped Lines |
| :--- | :--- | :--- | :-: | :-: |
| `glottal_deletion` | Word-internal glottal stop deletion & `VʔV` $\rightarrow$ `V` syllable contraction | `maʔa'ʔaɾi(ŋ)` vs. `ma'ʔaɾi(ŋ)` (19), prefix reduplication `CVʔV-` $\rightarrow$ `CV-` (`naɡʔaʔa'lok` vs. `naɡaʔa'lok`, `pinaʔaʔan'daɾ` vs. `pinaʔan'daɾ`, `naʔuʔu'nahan` vs. `naʔu'nahan`) (8), `majɾo'ʔon(ɡ)` vs. `maj'ɾon(ɡ)` (3), `pa'ʔano` vs. `'pano` (2), `'ʔoʔo` vs. `ʔo` / `do'ʔon` vs. `don` (3) | 35 | `L1–L35` |
| `glottal_retention_and_blending` | Word-boundary glottal stop retention (`-ʔ` in *malumi*/*maragsa* words) & cross-word glottal/clitic blending | `<word> + ʔa'ko` $\rightarrow$ `ŋa ko` / `'nako` / `ko` (7), `pa/na + ʔa'koŋ` $\rightarrow$ `koŋ` (3), `sa + 'ʔakiŋ/'ʔamin` $\rightarrow$ `sa kiŋ`/`'samin` & `ma'kita + ʔaŋ` $\rightarrow$ `ma'kitaŋ` (4), word-final `-ʔ` retention (`'pusoʔ`, `'punoʔ`, `ba'haɡiʔ`, `si'laʔ`, `diʔ`) (6) | 20 | `L36–L55` |
| `stress_shift` | Primary stress placement shifts on identical phoneme sequences | `ka'ɾotenojd` vs. `kaɾote'nojd` (1), `'paɾaŋ` vs. `pa'ɾaŋ` / `'paɾa` / `'peɾo` (6), `(pinaka)maɡan'daŋ` vs. `'(pinaka)maɡandaŋ` / `ɡin'toŋ` (3), `'ʔinteɾnet` vs. `ʔinteɾ'net` (2), other polysyllabic/loanword shifts (`ʔeskandi'nabo`, `'bihaɡ`, `heneti'ko`, `'ministɾi`, `ʔispesi'men`) (5) | 17 | `L56–L72` |
| `glottal_glide_hiatus` | Glottal stop vs. epenthetic palatal glide at vowel hiatus (`ʔ` vs. `j`) | `paɡʔiʔis'kiʔiŋ` vs. `paɡʔiʔis'kijiŋ` (2), `kaʔuɡali'ʔan` vs. `kaʔuɡali'jan` (1), `ba'baʔe` vs. `ba'baji` (1) | 4 | `L73–L76` |
| `vowel_alternation` | Vowel height/quality alternations (`/e/` $\leftrightarrow$ `/i/`, `/o/` $\leftrightarrow$ `/u/`) & diphthong reduction | `'keɾi` vs. `'kuɾi` (3), `/o/` $\leftrightarrow$ `/u/` (`paʔon'ti` vs. `paʔun'ti`, `konda'lini` vs. `kunda'lini`, `taɡapaɡ'tuɾo` vs. `taɡapaɡ'tuɾu`) (3), `/e/` $\leftrightarrow$ `/i/` & diphthong reductions (`'ʔeposed` vs. `ʔepi'sod`, `ɡɾa'jib` vs. `ɡɾe'jib`, `ʔiniʔimbestiɡa'han`, `medita'ʃoŋ`, `ɡwen` vs. `ɡa'win`, `ki` vs. `kaj`) (6) | 12 | `L77–L88` |
| `segmental_and_lexical` | Affrication, palatalization, consonant cluster deletion & lexical/morphological differences | `kaw pa'ɾejd` & `pinakamala'ki` (2), palatalization/affricates (`'pɾansja` vs. `'pɾanʃa`, `'t͡ʃina` vs. `'t͡sina`, `'ʃwaʃiniɡeɾ`) (3), cluster reduction & syncope (`ʔa'paɾtment` vs. `ʔa'paɾtmen`, `an'taɾktik` vs. `an'taɾtik`, `ɾehijo'nal` vs. `ɾehi'nal`, `pɾo'ɡɾama`) (4), reduplication & segmental disputes (`nakikipaɡtuŋɡa'liʔ`, `naki'kita`, `'metɾoplas`, `ma'ŋa` vs. `ba'ŋa`, `ʔak'tibuɡo`) (5) | 14 | `L89–L102` |
