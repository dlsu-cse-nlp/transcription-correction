"""Keep only the last stress marker (') in any word that has more than one.

    python scripts/keep_last_stress.py manifest.jsonl [-o out.jsonl]

"Last" means closest to the end of the word. Lines whose text doesn't change
are copied verbatim; changed lines keep their key order.
"""

import argparse
import json
from pathlib import Path

STRESS = "'"


def keep_last(word):
    if word.count(STRESS) < 2:
        return word
    head, _, tail = word.rpartition(STRESS)
    return head.replace(STRESS, "") + STRESS + tail


ap = argparse.ArgumentParser()
ap.add_argument("manifest")
ap.add_argument("-o", "--output", help="default: <manifest>_dedup<ext>")
args = ap.parse_args()

manifest = Path(args.manifest)
out = (
    Path(args.output)
    if args.output
    else manifest.with_name(f"{manifest.stem}_dedup{manifest.suffix}")
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
        new = [keep_last(w) for w in parts]
        n = sum(a != b for a, b in zip(parts, new))
        if n:
            rec["text"] = " ".join(new)
            dst.write(json.dumps(rec, ensure_ascii=False) + "\n")
            changed += 1
            words += n
        else:
            dst.write(line if line.endswith("\n") else f"{line}\n")

print(
    f"{total} entries, {changed} changed ({words} words fixed), {bad} unreadable passed through -> {out}"
)
