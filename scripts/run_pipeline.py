"""Run the full post-adjudication transcription pipeline across FLEURS and FSC.

python scripts/run_pipeline.py
"""

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCRIPTS = ROOT / "scripts"
SPLITS = [
    ("fleurs/test", "fleurs_test"),
    ("fleurs/valid", "fleurs_valid"),
    ("fsc/test", "fsc_test"),
    ("fsc/valid", "fsc_valid"),
]


def run_script(script, *args):
    subprocess.run([sys.executable, str(SCRIPTS / script), *map(str, args)], check=True)


for rel_dir, prefix in SPLITS:
    d = ROOT / "output" / rel_dir
    raw_res = d / f"{prefix}_resolved_raw.jsonl"
    res = d / f"{prefix}_resolved.jsonl"
    tmp_uns = d / f"{prefix}_resolved_unstressed.jsonl"
    audit = d / f"{prefix}_resolved_audit.jsonl"
    expert = d / f"{prefix}_resolved_expert.jsonl"
    no_expert = d / f"{prefix}_resolved_no_expert.jsonl"

    if not raw_res.exists() and res.exists():
        shutil.copyfile(res, raw_res)

    run_script("unstress_monosyllables.py", raw_res, "-o", tmp_uns)
    run_script("keep_last_stress.py", tmp_uns, "-o", res)
    tmp_uns.unlink(missing_ok=True)

    run_script("audit_transcriptions.py", res, "-o", audit)
    run_script("extract_expert.py", audit, "-o", expert, "-n", no_expert)

    for p in d.glob("*.jsonl"):
        if any(
            tag in p.name
            for tag in ("_unstressed_", "_dedup_", "_cleaned_", "_transfer")
        ):
            p.unlink()

lines_a, lines_b = [], []
for rel_dir, prefix in SPLITS:
    exp_path = ROOT / "output" / rel_dir / f"{prefix}_resolved_expert.jsonl"
    for l in exp_path.read_text(encoding="utf-8").splitlines():
        if not l.strip():
            continue
        r = json.loads(l)
        base = {"audio_filepath": r["audio_filepath"], "duration": r["duration"]}
        lines_a.append(json.dumps({**base, "text": r["text_a"]}, ensure_ascii=False))
        lines_b.append(json.dumps({**base, "text": r["text_b"]}, ensure_ascii=False))

exp_a = ROOT / "output/resolved_expert_a.jsonl"
exp_b = ROOT / "output/resolved_expert_b.jsonl"
exp_a.write_text("\n".join(lines_a) + "\n", encoding="utf-8")
exp_b.write_text("\n".join(lines_b) + "\n", encoding="utf-8")
(ROOT / "output/resolved_expert.jsonl").unlink(missing_ok=True)
print(f"{len(lines_a)} expert entries -> {exp_a} and {exp_b}")
