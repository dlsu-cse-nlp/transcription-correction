"""Word-level alignment and suggestions for the compare page. Pure functions, no server state."""
import difflib
import json
from collections import Counter

VOWELS = set("aeiouə")
# Symbols allowed by the phoneme chart on the review page, plus the stress mark and tie bar.
INVENTORY = set("pbkɡtdʔmŋnɾfvszʃʒhwjlaeiouə'͡")


def violations(words: list[str]) -> list[str]:
    """Rule-of-thumb problems in a run of words (from the annotation guidelines)."""
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


def align(a: str, b: str) -> list[tuple]:
    """-> [("eq", words), ("h", a_words, b_words), ...] on whitespace-separated words."""
    x, y = a.split(), b.split()
    parts: list[tuple] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, x, y, autojunk=False).get_opcodes():
        parts.append(("eq", x[i1:i2]) if tag == "equal" else ("h", x[i1:i2], y[j1:j2]))
    return parts


def pair_key(xa: list[str], ya: list[str]) -> str:
    return json.dumps(sorted([" ".join(xa), " ".join(ya)]), ensure_ascii=False)


def lexicon(aligned: list[list[tuple]], agreed_texts: list[str]) -> Counter:
    """Words both annotators wrote identically somewhere."""
    lex: Counter = Counter()
    for t in agreed_texts:
        lex.update(t.split())
    for parts in aligned:
        for p in parts:
            if p[0] == "eq":
                lex.update(p[1])
    return lex


def suggest(xa: list[str], ya: list[str], lex: Counter) -> tuple[str | None, str]:
    """-> ("a" | "b" | None, short reason). Deliberately conservative: signals that disagree give nothing."""
    picks, why = [], []
    va, vb = violations(xa), violations(ya)
    if len(va) != len(vb):
        pick = "a" if len(va) < len(vb) else "b"
        picks.append(pick)
        # {A}/{B} are placeholders; the page swaps in whatever labels it shows (blind mode)
        why.append(f"{'{B}' if pick == 'a' else '{A}'}: {(vb if pick == 'a' else va)[0]}")
    ok_a = bool(xa) and all(w in lex for w in xa)
    ok_b = bool(ya) and all(w in lex for w in ya)
    if ok_a != ok_b:
        pick = "a" if ok_a else "b"
        picks.append(pick)
        why.append(f"only {'{A}' if pick == 'a' else '{B}'}'s spelling appears in words you both agree on")
    if len(set(picks)) == 1:
        return picks[0], "; ".join(why)
    return None, ("signals disagree" if picks else "")


def annotate(aligned: dict[str, list[tuple]], lex: Counter) -> dict[str, dict]:
    """Per-entry parts with suggestions, plus a tier (0 = every difference has a suggestion)."""
    repeats = Counter(pair_key(p[1], p[2]) for parts in aligned.values() for p in parts if p[0] == "h")
    out = {}
    for key, parts in aligned.items():
        res, n, sug, hid = [], 0, 0, 0
        for p in parts:
            if p[0] == "eq":
                res.append({"t": "eq", "w": p[1]})
                continue
            pick, why = suggest(p[1], p[2], lex)
            pk = pair_key(p[1], p[2])
            res.append({"t": "h", "id": hid, "a": p[1], "b": p[2], "sug": pick, "why": why,
                        "pair": pk, "repeats": repeats[pk]})
            hid += 1
            n += 1
            sug += pick is not None
        out[key] = {"parts": res, "hunks": n, "suggested": sug,
                    "tier": 0 if n and sug == n else 1 if sug else 2}
    return out
