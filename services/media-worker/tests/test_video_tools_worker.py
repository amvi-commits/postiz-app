from hashlib import sha256
from pathlib import Path
import subprocess
import pytest
from fastapi import HTTPException
from app.main import AnalyzeRequest, EditPlanRequest, EditPlanSegment, TextOverlayItem, analyze_video, render_edit_plan, probe


@pytest.fixture
def source(tmp_path, monkeypatch):
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path))
    video = tmp_path / "source.mp4"
    subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "testsrc2=size=320x568:rate=15:duration=2", "-f", "lavfi", "-i", "sine=frequency=440:duration=2", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", "-shortest", str(video)], check=True)
    return video


def test_analyze_real_video_contract(source):
    # HTTP contract is {path}; the function receives a resolved Path.
    req = AnalyzeRequest(path=str(source))
    result = analyze_video(Path(req.path))
    assert result["durationSeconds"] == pytest.approx(2, abs=0.1)
    assert result["width"] == 320
    assert result["height"] == 568
    assert result["hasAudio"] is True
    assert result["aspectRatio"] == "9:16"
    assert result["scenes"]


def test_render_real_plan_contract_and_non_destructive_source(source, tmp_path):
    before = sha256(source.read_bytes()).hexdigest()
    body = EditPlanRequest(sourcePath=str(source), width=320, height=568, fps=15,
        segments=[EditPlanSegment(trimStartSeconds=0, trimEndSeconds=1, order=0), EditPlanSegment(trimStartSeconds=1, trimEndSeconds=2, order=1)])
    result = render_edit_plan(body, root=tmp_path / "renders")
    rendered = Path(result["path"])
    assert rendered.is_file()
    assert result["sizeBytes"] == rendered.stat().st_size > 0
    assert probe(rendered)["hasAudio"] is True
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(rendered), "-f", "null", "-"], check=True)
    assert sha256(source.read_bytes()).hexdigest() == before


def test_render_plan_rejects_path_outside_root(source, tmp_path):
    with pytest.raises(HTTPException):
        render_edit_plan(EditPlanRequest(sourcePath=str(tmp_path.parent / "foreign.mp4")))


def test_silent_source_and_overlay_temp_cleanup(source, tmp_path):
    silent = tmp_path / "silent.mp4"
    subprocess.run(["ffmpeg", "-v", "error", "-i", str(source), "-an", "-c:v", "copy", str(silent)], check=True)
    before_segments = set(Path("/tmp").glob("sns-plan-*"))
    before_text = set(Path("/tmp/sns-studio-text").glob("*.txt"))
    result = render_edit_plan(EditPlanRequest(sourcePath=str(silent), width=320, height=568, fps=15,
        textOverlays=[TextOverlayItem(text="PREVIEW", fontSize=20)]), root=tmp_path / "renders")
    assert result["hasAudio"] is True
    assert Path(result["path"]).stat().st_size > 0
    assert set(Path("/tmp").glob("sns-plan-*")) == before_segments
    assert set(Path("/tmp/sns-studio-text").glob("*.txt")) == before_text
