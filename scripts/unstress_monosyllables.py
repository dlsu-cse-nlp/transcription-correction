"""Remove the stress marker (') from single-syllable words in a manifest's "text".

    python scripts/unstress_monosyllables.py manifest.jsonl [-o out.jsonl]

A word is one syllable if it contains exactly one vowel symbol. Lines whose
text doesn't change are copied verbatim; changed lines keep their key order.
"""
import argparse
import json
from pathlib import Path

STRESS = "'"
VOWELS = set("aeiouəɛɔɪʊɐ")  # add symbols here if your transcriptions use others


def unstress(word: str) -> str:
    if STRESS in word and sum(ch in VOWELS for ch in word) == 1:
        return word.replace(STRESS, "")
    return word


ap = argparse.ArgumentParser()
ap.add_argument("manifest", type=Path)
ap.add_argument("-o", "--output", type=Path, help="default: <manifest>_unstressed<ext>")
args = ap.parse_args()
out = args.output or args.manifest.with_name(f"{args.manifest.stem}_unstressed{args.manifest.suffix}")
if out.resolve() == args.manifest.resolve():
    ap.error("output must differ from the input manifest")

changed = words = bad = total = 0
with open(args.manifest, encoding="utf-8-sig") as src, open(out, "w", encoding="utf-8") as dst:
    for line in src:
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
            text = rec["text"]
            if not isinstance(text, str):
                raise TypeError
        except (json.JSONDecodeError, KeyError, TypeError):
            bad += 1
            dst.write(line if line.endswith("\n") else line + "\n")  # pass through untouched
            continue
        total += 1
        parts = text.split(" ")  # split on single spaces so spacing is preserved exactly
        new = [unstress(w) for w in parts]
        n = sum(a != b for a, b in zip(parts, new))
        if n:
            rec["text"] = " ".join(new)
            dst.write(json.dumps(rec, ensure_ascii=False) + "\n")
            changed += 1
            words += n
        else:
            dst.write(line if line.endswith("\n") else line + "\n")

print(f"{total} entries, {changed} changed ({words} words unstressed), {bad} unreadable passed through -> {out}")
