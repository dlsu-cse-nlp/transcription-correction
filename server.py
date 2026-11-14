import argparse
import hashlib
import json
import os
import threading
import unicodedata
import webbrowser
from functools import lru_cache
from pathlib import Path

import pandas as pd
import uvicorn
from fastapi import FastAPI, HTTPException, Response
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import comparisons

_parquet_cache = {}
HERE = Path(__file__).resolve().parent
ROOT = Path.cwd().resolve()

app = FastAPI(title="Manifest reviewer")


class Session:
    def __init__(self):
        self.entries = {}
        self.done = {}
        self.out = None
        self.lock = threading.Lock()


session = Session()


class LoadRequest(BaseModel):
    mode: str
    out_path: str
    manifest_path: str | None = None
    manifest_text: str | None = None


class SaveRequest(BaseModel):
    key: str
    text: str


class CompareLoadRequest(BaseModel):
    mode: str
    out_path: str
    a_path: str | None = None
    a_text: str | None = None
    b_path: str | None = None
    b_text: str | None = None
    include_unpaired: bool = True
    order: str = "easy"


class CompareSaveRequest(BaseModel):
    key: str
    choice: str
    text: str | None = None


def fail(msg, code=400):
    raise HTTPException(status_code=code, detail=msg)


def norm(p):
    return p.replace("\\", "/").removeprefix("./")


def inside_root(path):
    path = path.resolve()
    return path if path.is_relative_to(ROOT) else None


def in_root(rel):
    if not rel:
        fail("A file path is required.")
    return inside_root(ROOT / norm(rel)) or fail(
        f"'{rel}' is outside the server root ({ROOT})."
    )


def resolve_audio(rel):
    return inside_root(ROOT / norm(rel))


def split_parquet(rel):
    """'a/b.parquet/sample_000012.wav' -> (parquet path inside ROOT, 12)."""
    parquet, _, sample = norm(rel).rpartition("/")
    path = inside_root(ROOT / parquet) if parquet.endswith(".parquet") else None
    idx = sample.removeprefix("sample_").removesuffix(".wav")
    return (path, int(idx)) if path and idx.isdigit() else None


def audio_exists(rel):
    if pq := split_parquet(rel):
        return pq[0].is_file()
    path = resolve_audio(rel)
    return bool(path and path.is_file())


def parquet_audio(path, idx):
    if path not in _parquet_cache:
        _parquet_cache[path] = pd.read_parquet(path, columns=["audio"])
    df = _parquet_cache[path]
    return df.loc[idx, "audio"]["bytes"] if idx in df.index else None


def read_records(text):
    text = text.lstrip("\ufeff")
    if text.lstrip().startswith("["):
        try:
            return [r for r in json.loads(text) if isinstance(r, dict)], 0
        except json.JSONDecodeError as e:
            fail(f"Not valid JSON: {e}")
    records, bad = [], 0
    for line in filter(str.strip, text.splitlines()):
        try:
            r = json.loads(line)
        except json.JSONDecodeError:
            r = None
        if isinstance(r, dict):
            records.append(r)
        else:
            bad += 1
    return records, bad


def dump(rec):
    return (json.dumps(rec, ensure_ascii=False) + "\n").encode("utf-8")


def append_record(path, rec):
    with open(path, "ab+") as f:
        if f.seek(0, os.SEEK_END) > 0:
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                f.write(b"\n")
        f.write(dump(rec))
        f.flush()
        os.fsync(f.fileno())


def rewrite_all(path, records):
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.writelines(dump(r) for r in records)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def list_json_files(max_depth=3):
    found = []
    for dirpath, dirs, files in os.walk(ROOT):
        rel = Path(dirpath).relative_to(ROOT)
        dirs[:] = (
            []
            if len(rel.parts) >= max_depth
            else [
                d for d in dirs if not d.startswith((".", "__")) and d != "node_modules"
            ]
        )
        found += [
            (rel / f).as_posix() for f in files if f.endswith((".json", ".jsonl"))
        ]
    return sorted(found)[:500]


@app.get("/api/files")
def files():
    return {"root": str(ROOT), "files": list_json_files()}


@app.get("/audio")
def audio(p):
    if not audio_exists(p):
        fail("Audio file not found", 404)
    if pq := split_parquet(p):
        data = parquet_audio(*pq)
        if data is None:
            fail("Sample not found in parquet file", 404)
        return Response(data, media_type="audio/wav")
    return FileResponse(resolve_audio(p))


@app.post("/api/load")
def load(req: LoadRequest):
    manifest_file = None
    if req.manifest_text is not None:
        text = req.manifest_text
    else:
        manifest_file = in_root(req.manifest_path or "")
        if not manifest_file.is_file():
            fail(f"Manifest not found: {req.manifest_path}")
        text = manifest_file.read_text(encoding="utf-8-sig")

    records, _ = read_records(text)
    valid = [r for r in records if isinstance(r.get("audio_filepath"), str)]
    entries = {}
    for r in valid:
        entries.setdefault(norm(r["audio_filepath"]), r)
    if not entries:
        fail("No entries with an 'audio_filepath' were found in the manifest.")

    out = in_root(req.out_path)
    if out == manifest_file:
        fail("The progress file can't be the manifest itself.")

    ignored, done = 0, {}
    if req.mode == "resume":
        if not out.is_file():
            fail(f"Progress file not found: {req.out_path}")
        prev_text = out.read_text(encoding="utf-8-sig")
        if prev_text.lstrip().startswith("["):
            fail(
                "That progress file is a JSON array. Progress is saved as JSON Lines (one entry per line) so each save is a single write."
            )
        prev, ignored = read_records(prev_text)
        done = {
            norm(r["audio_filepath"]): r
            for r in prev
            if isinstance(r.get("audio_filepath"), str)
        }
    else:
        if out.exists():
            fail(
                f"'{req.out_path}' already exists. Pick another name, or choose 'Resume' to continue it.",
                409,
            )
        out.parent.mkdir(parents=True, exist_ok=True)
        out.touch()

    queue = []
    for key, entry in entries.items():
        if key not in done:
            queue.append(
                {
                    "key": key,
                    "entry": entry,
                    "audio_ok": audio_exists(entry["audio_filepath"]),
                }
            )
    with session.lock:
        session.entries, session.done, session.out = entries, done, out
    return {
        "queue": queue,
        "total": len(entries),
        "already_done": len(entries) - len(queue),
        "missing_audio": sum(not q["audio_ok"] for q in queue),
        "ignored_lines": ignored,
        "invalid_entries": len(records) - len(valid),
        "out": out.relative_to(ROOT).as_posix(),
    }


@app.post("/api/save")
def save(req: SaveRequest):
    with session.lock:
        if session.out is None or req.key not in session.entries:
            fail(
                "No manifest is loaded for that entry. Reload the page and start again."
            )
        rec = {**session.entries[req.key], "text": req.text}
        is_edit = req.key in session.done
        session.done[req.key] = rec
        if is_edit:
            rewrite_all(session.out, session.done.values())
        else:
            append_record(session.out, rec)
        return {"ok": True, "saved": len(session.done)}


class CompareSession:
    def __init__(self):
        self.agreed = {}
        self.conflicts = {}
        self.done = {}
        self.out = None
        self.mode = "new"
        self.committed = False
        self.annotations = {}
        self.order = "easy"
        self.stats = {}
        self.edited = set()
        self.edit_log = None
        self.lock = threading.Lock()


compare = CompareSession()


def canon(text):
    """Texts that differ only in whitespace / Unicode normalisation don't conflict."""
    return unicodedata.normalize("NFC", " ".join(str(text or "").split()))


def swapped(key):
    """Blind review: whether this entry shows B on the left. Pseudo-random per entry but stable
    across sessions / resumes, so the same sample always appears the same way round."""
    return hashlib.sha256(("side:" + key).encode("utf-8")).digest()[0] & 1 == 1


def is_pick(text, parts):
    """True if `text` can be built purely by choosing A or B for each word-level difference
    (this includes 'all A', 'all B' and any merge of the two). Anything else is a further edit.
    """
    toks = canon(text).split()

    @lru_cache(maxsize=None)
    def go(i, j):
        if i == len(parts):
            return j == len(toks)
        p = parts[i]
        options = [p["w"]] if p["t"] == "eq" else [p["a"], p["b"]]
        return any(toks[j : j + len(w)] == w and go(i + 1, j + len(w)) for w in options)

    return go(0, 0)


def counts():
    """Live tallies for the review page."""
    return {
        "expert": sum(
            bool(compare.done[k].get("raise_to_expert"))
            for k in compare.conflicts
            if k in compare.done
        ),
        "edited": len(compare.edited),
    }


def write_edit_log():
    """Rewrite the txt file of audio_filepaths where the adjudicator edited beyond picking."""
    if compare.edit_log is None:
        return
    lines = [
        pair["a"]["audio_filepath"]
        for k, pair in compare.conflicts.items()
        if k in compare.edited
    ]
    tmp = compare.edit_log.with_name(compare.edit_log.name + ".tmp")
    with open(tmp, "w", encoding="utf-8", newline="\n") as f:
        f.writelines(line + "\n" for line in lines)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, compare.edit_log)


def load_side(path, text, name):
    if text is None:
        f = in_root(path or "")
        if not f.is_file():
            fail(f"File {name} not found: {path}")
        text = f.read_text(encoding="utf-8-sig")
    records, _ = read_records(text)
    entries = {}
    invalid = dupes = 0
    for r in records:
        if not isinstance(r.get("audio_filepath"), str):
            invalid += 1
            continue
        k = norm(r["audio_filepath"])
        if k in entries:
            dupes += 1
        else:
            entries[k] = r
    if not entries:
        fail(f"No entries with an 'audio_filepath' were found in file {name}.")
    return entries, invalid, dupes


@app.post("/api/compare/load")
def compare_load(req: CompareLoadRequest):
    a, a_bad, a_dup = load_side(req.a_path, req.a_text, "A")
    b, b_bad, b_dup = load_side(req.b_path, req.b_text, "B")

    out = in_root(req.out_path)
    for p in (req.a_path, req.b_path):
        if p and in_root(p) == out:
            fail("The output file can't be one of the input files.")

    done, ignored = {}, 0
    if req.mode == "resume":
        if not out.is_file():
            fail(f"Output file not found: {req.out_path}")
        prev_text = out.read_text(encoding="utf-8-sig")
        if prev_text.lstrip().startswith("["):
            fail("That output file is a JSON array; it must be JSON Lines.")
        prev, ignored = read_records(prev_text)
        done = {
            norm(r["audio_filepath"]): r
            for r in prev
            if isinstance(r.get("audio_filepath"), str)
        }
    elif out.exists():
        fail(
            f"'{req.out_path}' already exists. Pick another name, or choose 'Resume' to continue it.",
            409,
        )

    agreed, conflicts = {}, {}
    for k in [*a, *(k for k in b if k not in a)]:
        ra, rb = a.get(k), b.get(k)
        if ra is not None and rb is not None:
            if canon(ra.get("text")) == canon(rb.get("text")):
                agreed[k] = ra
            else:
                conflicts[k] = {"a": ra, "b": rb}
        elif req.include_unpaired:
            agreed[k] = ra or rb

    aligned = {
        k: comparisons.align(p["a"].get("text") or "", p["b"].get("text") or "")
        for k, p in conflicts.items()
    }
    agreed_texts = [(a[k].get("text") or "") for k in agreed if k in a and k in b]
    notes = comparisons.annotate(
        aligned, comparisons.lexicon(list(aligned.values()), agreed_texts)
    )
    pending = [notes[k] for k in conflicts if k not in done]

    stats = {
        "total_a": len(a),
        "total_b": len(b),
        "matched": sum(k in b for k in a),
        "only_a": sum(k not in b for k in a),
        "only_b": sum(k not in a for k in b),
        "agreed": sum(k in a and k in b for k in agreed),
        "unpaired_included": len(agreed) - sum(k in a and k in b for k in agreed),
        "conflicts": len(conflicts),
        "conflicts_left": sum(k not in done for k in conflicts),
        "already_done": sum(k in done for k in [*agreed, *conflicts]),
        "invalid": a_bad + b_bad,
        "duplicates": a_dup + b_dup,
        "ignored_lines": ignored,
        "include_unpaired": req.include_unpaired,
        "hunks": sum(n["hunks"] for n in pending),
        "hunks_suggested": sum(n["suggested"] for n in pending),
        "unique_pairs": len(
            {h["pair"] for n in pending for h in n["parts"] if h["t"] == "h"}
        ),
        "tier0": sum(n["tier"] == 0 for n in pending),
        "tier1": sum(n["tier"] == 1 for n in pending),
        "tier2": sum(n["tier"] == 2 for n in pending),
    }
    with compare.lock:
        compare.annotations, compare.order = notes, req.order
        compare.agreed, compare.conflicts, compare.done = agreed, conflicts, done
        compare.out, compare.mode, compare.committed = out, req.mode, False
        compare.stats = stats
        compare.edited = set()
        compare.edit_log = out.with_name(f"{out.stem}_edited.txt")
    return {**stats, "out": out.relative_to(ROOT).as_posix()}


@app.post("/api/compare/commit")
def compare_commit():
    with compare.lock:
        if compare.out is None:
            fail("Nothing analysed yet. Analyse the files first.")
        out = compare.out
        if not compare.committed:
            if compare.mode == "new":
                if out.exists():
                    fail(f"'{out.name}' already exists now. Pick another name.", 409)
                out.parent.mkdir(parents=True, exist_ok=True)
                out.touch()
            todo = [r for k, r in compare.agreed.items() if k not in compare.done]
            if todo:
                with open(out, "ab+") as f:
                    if f.seek(0, os.SEEK_END) > 0:
                        f.seek(-1, os.SEEK_END)
                        if f.read(1) != b"\n":
                            f.write(b"\n")
                    f.writelines(dump(r) for r in todo)
                    f.flush()
                    os.fsync(f.fileno())
            for k in compare.agreed:
                compare.done.setdefault(k, compare.agreed[k])
            compare.committed = True
            compare.stats["written_agreed"] = len(todo)
            compare.edited = {
                k
                for k in compare.conflicts
                if k in compare.done
                and not is_pick(
                    compare.done[k].get("text"), compare.annotations[k]["parts"]
                )
            }
            write_edit_log()
        queue = []
        for k, pair in compare.conflicts.items():
            if k in compare.done:
                continue
            queue.append(
                {
                    "key": k,
                    "path": pair["a"]["audio_filepath"],
                    "a": pair["a"].get("text") or "",
                    "b": pair["b"].get("text") or "",
                    "audio_ok": audio_exists(pair["a"]["audio_filepath"]),
                    "parts": compare.annotations[k]["parts"],
                    "tier": compare.annotations[k]["tier"],
                    "swap": swapped(k),
                }
            )
        if compare.order == "easy":
            queue.sort(key=lambda q: q["tier"])
        return {
            "queue": queue,
            "total_conflicts": len(compare.conflicts),
            "already_done": len(compare.conflicts) - len(queue),
            "written_agreed": compare.stats.get("written_agreed", 0),
            "out": out.relative_to(ROOT).as_posix(),
            "edit_log": compare.edit_log.relative_to(ROOT).as_posix(),
            **counts(),
        }


@app.post("/api/compare/save")
def compare_save(req: CompareSaveRequest):
    with compare.lock:
        if not compare.committed or req.key not in compare.conflicts:
            fail(
                "No comparison is loaded for that entry. Reload the page and start again."
            )
        pair = compare.conflicts[req.key]
        ta, tb = pair["a"].get("text") or "", pair["b"].get("text") or ""
        base = {**pair["a"]}
        if "duration" not in base and "duration" in pair["b"]:
            base["duration"] = pair["b"]["duration"]
        if req.choice == "a":
            rec = {**base, "text": ta}
        elif req.choice == "b":
            rec = {**base, "text": tb}
        elif req.text is None:
            fail("No text was provided.")
        elif req.choice in ("manual", "merge"):
            rec = {**base, "text": req.text}
        else:
            rec = {
                **base,
                "text": req.text,
                "raise_to_expert": True,
                "text_a": ta,
                "text_b": tb,
            }
        is_edit = req.key in compare.done
        compare.done[req.key] = rec
        if is_edit:
            rewrite_all(compare.out, compare.done.values())
        else:
            append_record(compare.out, rec)
        if req.choice in ("manual", "expert") and not is_pick(
            rec["text"], compare.annotations[req.key]["parts"]
        ):
            compare.edited.add(req.key)
        else:
            compare.edited.discard(req.key)
        write_edit_log()
        left = sum(k not in compare.done for k in compare.conflicts)
        return {"ok": True, "left": left, **counts()}


app.mount("/", StaticFiles(directory=HERE / "static", html=True), name="static")


def main():
    global ROOT
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--root",
        default=".",
        help="folder audio_filepath is relative to (default: current dir)",
    )
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--no-browser", action="store_true")
    args = ap.parse_args()
    ROOT = Path(args.root).resolve()
    url = f"http://127.0.0.1:{args.port}/"
    print(f"Root: {ROOT}\nOpen {url}  (Ctrl+C to stop)")
    if not args.no_browser:
        threading.Timer(1.0, webbrowser.open, [url]).start()
    uvicorn.run(app, host="127.0.0.1", port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
