from pathlib import Path
from subprocess import CompletedProcess
import io
import json
import math
import struct
import subprocess
import wave

import pytest
from fastapi import HTTPException

from app.main import ComicRenderRequest, ConcatenateRequest, RenderRequest, build_srt, concatenate, probe, render, render_comic, resolve_media_path


def test_path_must_stay_under_media_root(tmp_path, monkeypatch):
    monkeypatch.setenv("MEDIA_ROOT", str(tmp_path / "uploads"))
    (tmp_path / "uploads").mkdir()
    outside = tmp_path / "secret.mp4"
    outside.write_bytes(b"x")
    with pytest.raises(HTTPException) as error:
        resolve_media_path(str(outside))
    assert error.value.status_code == 400


def test_render_parameters_reject_unbounded_speed_and_crop():
    with pytest.raises(ValueError):
        RenderRequest(sourcePath="/uploads/in.mp4", playbackSpeed=0.1)
    with pytest.raises(ValueError):
        RenderRequest(sourcePath="/uploads/in.mp4", cropPercent=50)


def test_render_filename_rejects_path_traversal(tmp_path, monkeypatch):
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    source = upload_root / "in.mp4"
    source.write_bytes(b"mock")
    monkeypatch.setenv("MEDIA_ROOT", str(upload_root))
    request = RenderRequest(sourcePath=str(source), outputName="../outside.mp4")
    with pytest.raises(HTTPException) as error:
        render(request)
    assert error.value.status_code == 422
    assert error.value.detail["code"] == "OUTPUT_NAME_INVALID"


def test_comic_subtitles_keep_dialogue_order_and_timing():
    srt = build_srt([(0, 1.25, "Hello"), (1.25, 2.5, "こんにちは\n次の行")])
    assert "00:00:00,000 --> 00:00:01,250" in srt
    assert "00:00:01,250 --> 00:00:02,500" in srt
    assert "こんにちは 次の行" in srt


def test_probe_identifies_still_image_for_story_preflight(tmp_path, monkeypatch):
    image = tmp_path / "story.jpg"
    image.write_bytes(b"image")
    payload = {
        "format": {"format_name": "jpeg_pipe", "duration": "0"},
        "streams": [{"codec_type": "video", "codec_name": "mjpeg", "width": 1080, "height": 1920}],
    }
    monkeypatch.setattr("app.main.subprocess.run", lambda *args, **kwargs: CompletedProcess(args[0], 0, stdout=json.dumps(payload), stderr=""))
    result = probe(image)
    assert result["kind"] == "image"
    assert result["video"]["width"] == 1080


def _make_test_video(path: Path, duration: float = 1.6):
    subprocess.run(
        [
            "ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "lavfi", "-i", f"color=c=blue:s=320x568:r=15:d={duration}",
            "-f", "lavfi", "-i", f"sine=frequency=440:sample_rate=48000:duration={duration}",
            "-shortest", "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac", str(path),
        ],
        check=True,
        capture_output=True,
        timeout=60,
    )


def _make_test_wav(duration: float = 0.25) -> bytes:
    sample_rate = 22050
    frames = b"".join(
        struct.pack("<h", int(4000 * math.sin(2 * math.pi * 440 * index / sample_rate)))
        for index in range(round(sample_rate * duration))
    )
    output = io.BytesIO()
    with wave.open(output, "wb") as audio:
        audio.setnchannels(1)
        audio.setsampwidth(2)
        audio.setframerate(sample_rate)
        audio.writeframes(frames)
    return output.getvalue()


def test_ffmpeg_render_with_bgm_overlay_and_concat_real_media(tmp_path, monkeypatch):
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    monkeypatch.setenv("MEDIA_ROOT", str(upload_root))
    source = upload_root / "source.mp4"
    _make_test_video(source)
    bgm = upload_root / "bgm.wav"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "sine=frequency=220:duration=2", str(bgm)],
        check=True,
        capture_output=True,
        timeout=60,
    )

    rendered = render(
        RenderRequest(
            sourcePath=str(source),
            outputName="rendered.mp4",
            trimStartSeconds=0.1,
            trimEndSeconds=0.1,
            playbackSpeed=1.25,
            cropPercent=98,
            width=320,
            height=568,
            fps=15,
            sourceAudioVolume=0.8,
            bgmPath=str(bgm),
            bgmVolume=0.1,
            textOverlay="日本語テスト",
            textX=0.5,
            textY=0.8,
            textFontSize=22,
        )
    )
    rendered_path = Path(rendered["path"])
    assert rendered_path.is_file()
    assert rendered["width"] == 320
    assert rendered["height"] == 568
    assert rendered["hasAudio"] is True
    assert 0.9 < rendered["durationSeconds"] < 1.5

    joined = concatenate(
        ConcatenateRequest(paths=[str(source), str(rendered_path)], outputName="joined.mp4", width=320, height=568, fps=15)
    )
    assert Path(joined["path"]).is_file()
    assert joined["inputCount"] == 2
    assert joined["hasAudio"] is True
    assert joined["durationSeconds"] >= 2.4


def test_comic_render_with_mock_tts_builds_japanese_subtitled_video(tmp_path, monkeypatch):
    upload_root = tmp_path / "uploads"
    upload_root.mkdir()
    monkeypatch.setenv("MEDIA_ROOT", str(upload_root))
    page = upload_root / "page.png"
    subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "lavfi", "-i", "color=c=yellow:s=320x568:d=0.1", "-frames:v", "1", str(page)],
        check=True,
        capture_output=True,
        timeout=60,
    )

    class FakeTTS:
        def list_voices(self):
            return [{"name": "Local mock", "styles": [{"id": 1, "name": "normal"}]}]

        def synthesize(self, text, voice_id):
            assert text == "テスト音声です"
            assert voice_id == "1"
            return _make_test_wav()

    monkeypatch.setattr("app.main.get_tts_provider", lambda: FakeTTS())
    result = render_comic(
        ComicRenderRequest(
            pages=[{"imagePath": str(page), "dialogues": [{"text": "テスト音声です", "speakerSlot": "narrator"}]}],
            outputName="comic.mp4",
            width=320,
            height=568,
            fps=15,
            subtitles=True,
            subtitleFontSize=20,
            voiceSlots={"narrator": 1},
            pagePaddingSeconds=0.1,
        )
    )
    assert Path(result["path"]).is_file()
    assert result["pageCount"] == 1
    assert result["hasAudio"] is True
    assert result["width"] == 320
    assert result["height"] == 568
