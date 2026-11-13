import difflib
import json
from collections import Counter

VOWELS = set("aeiouə")
INVENTORY = set("pbkɡtdʔmŋnɾfvszʃʒhwjlaeiouə'͡")


def violations(words):
    out = []
    for w in words:
        bad = sorted({c for c in w if c not in INVENTORY})
        if bad:
            out.append(f"symbol outside the chart ({''.join(bad)})")
        if w[0] in VOWELS:
            out.append("vowel-initial word without ʔ")
        n = sum(c in VOWELS for c in w)
        if n >= 2 and "'" not in w:
            out.append("no stress mark")
        if w.count("'") > 1:
            out.append("more than one stress mark")
    return out


def align(a, b):
    x, y = a.split(), b.split()
    parts = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(
        None, x, y, autojunk=False
    ).get_opcodes():
        parts.append(("eq", x[i1:i2]) if tag == "equal" else ("h", x[i1:i2], y[j1:j2]))
    return parts


def pair_key(xa, ya):
    return json.dumps(sorted([" ".join(xa), " ".join(ya)]), ensure_ascii=False)


def lexicon(aligned, agreed_texts):
    lex = Counter()
    for t in agreed_texts:
        lex.update(t.split())
    for parts in aligned:
        for p in parts:
            if p[0] == "eq":
                lex.update(p[1])
    return lex


def suggest(xa, ya, lex):
    picks, why = [], []
    va, vb = violations(xa), violations(ya)
    if len(va) != len(vb):
        pick = "a" if len(va) < len(vb) else "b"
        picks.append(pick)
        why.append(
            f"{'{B}' if pick == 'a' else '{A}'}: {(vb if pick == 'a' else va)[0]}"
        )
    ok_a = bool(xa) and all(w in lex for w in xa)
    ok_b = bool(ya) and all(w in lex for w in ya)
    if ok_a != ok_b:
        pick = "a" if ok_a else "b"
        picks.append(pick)
        why.append(
            f"only {'{A}' if pick == 'a' else '{B}'}'s spelling appears in words you both agree on"
        )
    if len(set(picks)) == 1:
        return picks[0], "; ".join(why)
    return None, ("signals disagree" if picks else "")


def annotate(aligned, lex):
    repeats = Counter(
        pair_key(p[1], p[2]) for parts in aligned.values() for p in parts if p[0] == "h"
    )
    out = {}
    for key, parts in aligned.items():
        res, n, sug, hid = [], 0, 0, 0
        for p in parts:
            if p[0] == "eq":
                res.append({"t": "eq", "w": p[1]})
                continue
            pick, why = suggest(p[1], p[2], lex)
            pk = pair_key(p[1], p[2])
            res.append(
                {
                    "t": "h",
                    "id": hid,
                    "a": p[1],
                    "b": p[2],
                    "sug": pick,
                    "why": why,
                    "pair": pk,
                    "repeats": repeats[pk],
                }
            )
            hid += 1
            n += 1
            sug += pick is not None
        out[key] = {
            "parts": res,
            "hunks": n,
            "suggested": sug,
            "tier": 0 if n and sug == n else 1 if sug else 2,
        }
    return out
