"""Remove manifest entries whose "text" is a single word.

    python drop_single_word.py manifest.json [-o filtered.json]

Kept lines are copied verbatim, so formatting and key order are unchanged.
"""
import argparse
import json
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("manifest", type=Path)
ap.add_argument("-o", "--output", type=Path, help="default: <manifest>_multiword<ext>")
args = ap.parse_args()
out = args.output or args.manifest.with_name(f"{args.manifest.stem}_multiword{args.manifest.suffix}")
if out.resolve() == args.manifest.resolve():
    ap.error("output must differ from the input manifest")

kept = dropped = bad = 0
with open(args.manifest, encoding="utf-8-sig") as src, open(out, "w", encoding="utf-8") as dst:
    for line in src:
        if not line.strip():
            continue
        try:
            text = json.loads(line)["text"]
        except (json.JSONDecodeError, KeyError, TypeError):
            bad += 1
            continue
        if len(str(text).split()) == 1:
            dropped += 1
        else:
            dst.write(line if line.endswith("\n") else line + "\n")
            kept += 1

print(f"kept {kept}, dropped {dropped} single-word, skipped {bad} unreadable -> {out}")
