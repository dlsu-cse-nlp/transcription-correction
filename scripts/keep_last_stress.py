"""Keep only the last stress marker (') in any word that has more than one.

    python scripts/keep_last_stress.py manifest.jsonl [-o out.jsonl]

"Last" means closest to the end of the word. Lines whose text doesn't change
are copied verbatim; changed lines keep their key order.
"""
import argparse
import json
from pathlib import Path

STRESS = "'"


def keep_last(word: str) -> str:
    if word.count(STRESS) < 2:
        return word
    head, _, tail = word.rpartition(STRESS)
    return head.replace(STRESS, "") + STRESS + tail


ap = argparse.ArgumentParser()
ap.add_argument("manifest", type=Path)
ap.add_argument("-o", "--output", type=Path, help="default: <manifest>_laststress<ext>")
args = ap.parse_args()
out = args.output or args.manifest.with_name(f"{args.manifest.stem}_laststress{args.manifest.suffix}")
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
        new = [keep_last(w) for w in parts]
        n = sum(a != b for a, b in zip(parts, new))
        if n:
            rec["text"] = " ".join(new)
            dst.write(json.dumps(rec, ensure_ascii=False) + "\n")
            changed += 1
            words += n
        else:
            dst.write(line if line.endswith("\n") else line + "\n")

print(f"{total} entries, {changed} changed ({words} words fixed), {bad} unreadable passed through -> {out}")
