"""Normalize IPA inventory, affricate tie bars, glottal stops, and stress placement.

    python scripts/audit_transcriptions.py manifest.jsonl [-o out.jsonl]

Lines whose text doesn't change are copied verbatim; changed lines keep their
key order.
"""

import argparse
import json
import re
from pathlib import Path

VOWELS = "aeiou"
CHAR_MAP = str.maketrans({"g": "ɡ", "r": "ɾ", "ʊ": "u", "]": ""})


def clean_word(w):
    w = w.translate(CHAR_MAP)
    w = re.sub(r"pit(͡s|s)bʌɾɡ", "pit͡sbeɾɡ", w).replace("ʌ", "a")
    w = re.sub(r"([^aeiou'])y$", r"\1i", w).replace("y", "j")
    w = w.replace("ts", "t͡s").replace("tʃ", "t͡ʃ").replace("dʒ", "d͡ʒ")
    w = w.replace("nɡ", "ŋ")
    w = re.sub(r"^('?)ʔ(?=[pbkɡtdmŋnɾfvszʃʒθhwjl])", r"\1", w)
    w = re.sub(r"ʔ'([aeiou])", r"'ʔ\1", w)
    w = re.sub(r"([aeiou])([^aeiou'])'([aeiou])", r"\1'\2\3", w)
    if "'" in w and not any(c in VOWELS for c in w.partition("'")[2]):
        w = "'" + w.replace("'", "")
    return w


def clean_text(text):
    return " ".join(clean_word(w) for w in text.split())


ap = argparse.ArgumentParser()
ap.add_argument("manifest")
ap.add_argument("-o", "--output", help="default: <manifest>_audit<ext>")
args = ap.parse_args()

manifest = Path(args.manifest)
out = (
    Path(args.output)
    if args.output
    else manifest.with_name(f"{manifest.stem}_audit{manifest.suffix}")
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
        new_text = clean_text(text)
        if new_text != text:
            old_parts = text.split()
            new_parts = new_text.split()
            n = (
                sum(a != b for a, b in zip(old_parts, new_parts))
                if len(old_parts) == len(new_parts)
                else 1
            )
            rec["text"] = new_text
            dst.write(json.dumps(rec, ensure_ascii=False) + "\n")
            changed += 1
            words += max(n, 1)
        else:
            dst.write(line if line.endswith("\n") else f"{line}\n")

print(
    f"{total} entries, {changed} changed ({words} words fixed), {bad} unreadable passed through -> {out}"
)
