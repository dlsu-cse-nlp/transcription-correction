"""Remove the stress marker (') from single-syllable words in a manifest's "text".

    python scripts/unstress_monosyllables.py manifest.jsonl [-o out.jsonl]

A word is one syllable if it contains exactly one vowel symbol. Lines whose
text doesn't change are copied verbatim; changed lines keep their key order.
"""

import argparse
import json
from pathlib import Path

STRESS = "'"
VOWELS = set("aeiouəɛɔɪʊɐ")


def unstress(word):
    return (
        word.replace(STRESS, "")
        if STRESS in word and sum(c in VOWELS for c in word) == 1
        else word
    )


ap = argparse.ArgumentParser()
ap.add_argument("manifest")
ap.add_argument("-o", "--output", help="default: <manifest>_unstressed<ext>")
args = ap.parse_args()

manifest = Path(args.manifest)
out = (
    Path(args.output)
    if args.output
    else manifest.with_name(f"{manifest.stem}_unstressed{manifest.suffix}")
)
if out.resolve() == manifest.resolve():
    ap.error("output must differ from the input manifest")

changed = words = bad = total = 0
with (
    open(manifest, encoding="utf-8-sig") as src,
    open(out, "w", encoding="utf-8") as dst,
):
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
            dst.write(line if line.endswith("\n") else f"{line}\n")
            continue
        total += 1
        parts = text.split(" ")
        new = [unstress(w) for w in parts]
        n = sum(a != b for a, b in zip(parts, new))
        if n:
            rec["text"] = " ".join(new)
            dst.write(json.dumps(rec, ensure_ascii=False) + "\n")
            changed += 1
            words += n
        else:
            dst.write(line if line.endswith("\n") else f"{line}\n")

print(
    f"{total} entries, {changed} changed ({words} words unstressed), {bad} unreadable passed through -> {out}"
)
