"""Complete one queued SNS Studio job in the local Drive mock, without Google OAuth."""

from __future__ import annotations

import json
import shutil
import sys
from datetime import datetime, timezone
from pathlib import Path


def complete_job(job_id: str) -> Path:
    root = Path("/uploads/sns-studio/mock-drive")
    jobs = root / "jobs" / f"SNSStudio_job_{job_id}"
    job_file = jobs / "job.json"
    if not job_file.is_file():
        raise FileNotFoundError(f"Queued job manifest not found: {job_file.name}")

    job = json.loads(job_file.read_text(encoding="utf-8"))
    if job.get("jobId") != job_id:
        raise ValueError("Queued manifest jobId does not match the requested local job.")
    media_type = str((job.get("input") or {}).get("mediaType") or "video").lower()
    suffix = ".png" if media_type == "image" else ".mp4"
    candidates = sorted((root / "inbox").glob(f"*{suffix}"))
    if not candidates:
        raise FileNotFoundError(f"No local mock Drive {media_type} is available in inbox/.")

    results = root / "results"
    results.mkdir(parents=True, exist_ok=True)
    output_name = f"sns-studio-colab-{job_id}{suffix}"
    output_path = results / output_name
    shutil.copyfile(candidates[0], output_path)
    result = {
        "jobId": job_id,
        "status": "COMPLETE",
        "outputs": [
            {
                "fileId": f"mockdrive:results/{output_name}",
                "name": output_name,
                "mimeType": "image/png" if suffix == ".png" else "video/mp4",
            }
        ],
        "completedAt": datetime.now(timezone.utc).isoformat(),
    }
    manifest_path = results / f"sns-studio-result-{job_id}.json"
    manifest_path.write_text(json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return manifest_path


if __name__ == "__main__":
    if len(sys.argv) != 2:
        raise SystemExit("Usage: sns-studio-mock-colab.py <job-id>")
    completed = complete_job(sys.argv[1])
    print(f"Local Colab mock wrote {completed.name}")
