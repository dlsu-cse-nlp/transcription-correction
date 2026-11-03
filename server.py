import argparse
import json
import os
import threading
import unicodedata
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import pandas as pd
from fastapi import FastAPI, HTTPException, Response

_parquet_cache: dict[Path, pd.DataFrame] = {}

HERE = Path(__file__).resolve().parent
ROOT = Path.cwd().resolve()

app = FastAPI(title="Manifest reviewer")


@dataclass
class Session:
    entries: dict = field(default_factory=dict)
    done: dict = field(default_factory=dict)
    out: Path | None = None
    lock: threading.Lock = field(default_factory=threading.Lock)


session = Session()


class LoadRequest(BaseModel):
    mode: Literal["new", "resume"]
    out_path: str
    manifest_path: str | None = None
    manifest_text: str | None = None


class SaveRequest(BaseModel):
    key: str
    text: str


def fail(msg: str, code: int = 400):
    raise HTTPException(status_code=code, detail=msg)


def norm(p: str) -> str:
    return p.replace("\\", "/").removeprefix("./")


def inside_root(path: Path) -> Path | None:
    path = path.resolve()
    return path if path.is_relative_to(ROOT) else None


def in_root(rel: str) -> Path:
    if not rel:
        fail("A file path is required.")
    return inside_root(ROOT / norm(rel)) or fail(
        f"'{rel}' is outside the server root ({ROOT})."
    )


def resolve_audio(rel: str) -> Path | None:
    return inside_root(
        ROOT / norm(rel)
    ) 

def split_parquet(rel: str) -> tuple[Path, int] | None:
    """'a/b.parquet/sample_000012.wav' -> (parquet path inside ROOT, 12)."""
    parquet, _, sample = norm(rel).rpartition("/")
    path = inside_root(ROOT / parquet) if parquet.endswith(".parquet") else None
    idx = sample.removeprefix("sample_").removesuffix(".wav")
    return (path, int(idx)) if path and idx.isdigit() else None


def audio_exists(rel: str) -> bool:
    if pq := split_parquet(rel):
        return pq[0].is_file()  # the sample itself is only checked when played
    path = resolve_audio(rel)
    return bool(path and path.is_file())


def parquet_audio(path: Path, idx: int) -> bytes | None:
    if path not in _parquet_cache:
        _parquet_cache[path] = pd.read_parquet(path, columns=["audio"])
    df = _parquet_cache[path]
    return df.loc[idx, "audio"]["bytes"] if idx in df.index else None

def read_records(text: str) -> tuple[list[dict], int]:
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


def dump(rec: dict) -> bytes:
    return (json.dumps(rec, ensure_ascii=False) + "\n").encode("utf-8")


def append_record(path: Path, rec: dict) -> None:
    with open(path, "ab+") as f:
        if f.seek(0, os.SEEK_END) > 0:
            f.seek(-1, os.SEEK_END)
            if f.read(1) != b"\n":
                f.write(b"\n")
        f.write(dump(rec))
        f.flush()
        os.fsync(f.fileno())


def rewrite_all(path: Path, records) -> None:
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "wb") as f:
        f.writelines(dump(r) for r in records)
        f.flush()
        os.fsync(f.fileno())
    os.replace(tmp, path)


def list_json_files(max_depth: int = 3) -> list[str]:
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

# API endpoints
# TODO: Cleanup

@app.get("/api/files")
def files():
    return {"root": str(ROOT), "files": list_json_files()}

@app.get("/audio")
def audio(p: str):
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
    entries: dict[str, dict] = {}
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
    for key, entry in list(entries.items()):  # bottom-up
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


# ---------------------------------------------------------------------------
# Compare two manifests (static/compare.html)
# ---------------------------------------------------------------------------


@dataclass
class CompareSession:
    agreed: dict = field(default_factory=dict)  # key -> record (to write as-is)
    conflicts: dict = field(default_factory=dict)  # key -> {"a": rec, "b": rec}
    done: dict = field(default_factory=dict)  # key -> record already in the output
    out: Path | None = None
    mode: str = "new"
    committed: bool = False
    stats: dict = field(default_factory=dict)
    lock: threading.Lock = field(default_factory=threading.Lock)


compare = CompareSession()


class CompareLoadRequest(BaseModel):
    mode: Literal["new", "resume"]
    out_path: str
    a_path: str | None = None
    a_text: str | None = None
    b_path: str | None = None
    b_text: str | None = None
    include_unpaired: bool = True


class CompareSaveRequest(BaseModel):
    key: str
    choice: Literal["a", "b", "manual", "expert"]
    text: str | None = None


def canon(text) -> str:
    """Texts that differ only in whitespace / Unicode normalisation don't conflict."""
    return unicodedata.normalize("NFC", " ".join(str(text or "").split()))


def load_side(path: str | None, text: str | None, name: str):
    """-> (entries by key, invalid count, duplicate count)"""
    if text is None:
        f = in_root(path or "")
        if not f.is_file():
            fail(f"File {name} not found: {path}")
        text = f.read_text(encoding="utf-8-sig")
    records, _ = read_records(text)
    entries: dict[str, dict] = {}
    invalid = dupes = 0
    for r in records:
        if not isinstance(r.get("audio_filepath"), str):
            invalid += 1
            continue
        k = norm(r["audio_filepath"])
        if k in entries:
            dupes += 1  # first occurrence wins, like the single-file reviewer
        else:
            entries[k] = r
    if not entries:
        fail(f"No entries with an 'audio_filepath' were found in file {name}.")
    return entries, invalid, dupes


@app.post("/api/compare/load")
def compare_load(req: CompareLoadRequest):
    """Match the two files and count conflicts. Writes nothing."""
    a, a_bad, a_dup = load_side(req.a_path, req.a_text, "A")
    b, b_bad, b_dup = load_side(req.b_path, req.b_text, "B")

    out = in_root(req.out_path)
    for p in (req.a_path, req.b_path):
        if p and in_root(p) == out:
            fail("The output file can't be one of the input files.")

    done: dict[str, dict] = {}
    ignored = 0
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

    agreed: dict[str, dict] = {}
    conflicts: dict[str, dict] = {}
    for k in [*a, *(k for k in b if k not in a)]:
        ra, rb = a.get(k), b.get(k)
        if ra is not None and rb is not None:
            if canon(ra.get("text")) == canon(rb.get("text")):
                agreed[k] = ra
            else:
                conflicts[k] = {"a": ra, "b": rb}
        elif req.include_unpaired:
            agreed[k] = ra or rb

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
    }
    with compare.lock:
        compare.agreed, compare.conflicts, compare.done = agreed, conflicts, done
        compare.out, compare.mode, compare.committed = out, req.mode, False
        compare.stats = stats
    return {**stats, "out": out.relative_to(ROOT).as_posix()}


@app.post("/api/compare/commit")
def compare_commit():
    """Write every non-conflicting entry to the output, then hand back the conflicts to resolve."""
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
                }
            )
        return {
            "queue": queue,
            "total_conflicts": len(compare.conflicts),
            "already_done": len(compare.conflicts) - len(queue),
            "written_agreed": compare.stats.get("written_agreed", 0),
            "out": out.relative_to(ROOT).as_posix(),
        }


@app.post("/api/compare/save")
def compare_save(req: CompareSaveRequest):
    with compare.lock:
        if not compare.committed or req.key not in compare.conflicts:
            fail("No comparison is loaded for that entry. Reload the page and start again.")
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
        elif req.choice == "manual":
            rec = {**base, "text": req.text}
        else:  # expert: unresolved, keep both versions; "text" is the current textbox content
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
        left = sum(k not in compare.done for k in compare.conflicts)
        return {"ok": True, "left": left}


app.mount(
    "/", StaticFiles(directory=HERE / "static", html=True), name="static"
)


def main() -> None:
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
