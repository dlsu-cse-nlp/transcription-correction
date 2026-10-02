import argparse
import json
import os
import threading
import webbrowser
from dataclasses import dataclass, field
from pathlib import Path
from typing import Literal

import uvicorn
from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

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
    path = resolve_audio(p)
    if not path or not path.is_file():
        fail("Audio file not found", 404)
    return FileResponse(path)


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
    for key, entry in entries.items():
        if key not in done:
            audio_file = resolve_audio(entry["audio_filepath"])
            queue.append(
                {
                    "key": key,
                    "entry": entry,
                    "audio_ok": bool(audio_file and audio_file.is_file()),
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
