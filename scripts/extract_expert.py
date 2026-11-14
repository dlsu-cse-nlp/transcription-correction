"""Split a manifest into raise_to_expert entries and non-expert entries.

python scripts/extract_expert.py manifest.jsonl [-o expert.jsonl] [-n no_expert.jsonl]
"""

import argparse
import json
from pathlib import Path

ap = argparse.ArgumentParser()
ap.add_argument("manifest")
ap.add_argument("-o", "--output", help="default: <manifest>_expert<ext>")
ap.add_argument("-n", "--no-expert", help="default: <manifest>_no_expert<ext>")
args = ap.parse_args()

manifest = Path(args.manifest)
out_exp = (
    Path(args.output)
    if args.output
    else manifest.with_name(f"{manifest.stem}_expert{manifest.suffix}")
)
out_no_exp = (
    Path(args.no_expert)
    if args.no_expert
    else manifest.with_name(f"{manifest.stem}_no_expert{manifest.suffix}")
)
if manifest.resolve() in {out_exp.resolve(), out_no_exp.resolve()}:
    ap.error("output files must differ from the input manifest")

total = exp = no_exp = 0
with (
    open(manifest, encoding="utf-8-sig") as src,
    open(out_exp, "w", encoding="utf-8") as dst_exp,
    open(out_no_exp, "w", encoding="utf-8") as dst_no_exp,
):
    for line in src:
        if not line.strip():
            continue
        try:
            rec = json.loads(line)
        except (json.JSONDecodeError, KeyError, TypeError):
            continue
        total += 1
        out_line = line if line.endswith("\n") else f"{line}\n"
        if rec.get("raise_to_expert"):
            dst_exp.write(out_line)
            exp += 1
        else:
            dst_no_exp.write(out_line)
            no_exp += 1

print(
    f"{total} entries -> {exp} expert ({out_exp}), {no_exp} non-expert ({out_no_exp})"
)
