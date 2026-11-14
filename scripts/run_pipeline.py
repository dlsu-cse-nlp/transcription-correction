"""Run the full post-adjudication transcription pipeline across FLEURS and FSC.

python scripts/run_pipeline.py
"""

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
