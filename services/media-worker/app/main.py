from __future__ import annotations

import os
import re
import secrets
import shutil
import subprocess
import tempfile
from pathlib import Path
from uuid import uuid4

import httpx
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field
from .tts_provider import get_tts_provider


class RenderRequest(BaseModel):
    sourcePath: str = Field(min_length=1, max_length=2048)
    outputName: str = Field(default="sns-studio-render.mp4", min_length=1, max_length=100)
    trimStartSeconds: float = Field(default=0, ge=0, le=3600)
    trimEndSeconds: float = Field(default=0, ge=0, le=3600)
    playbackSpeed: float = Field(default=1, ge=0.5, le=2)
    cropPercent: float = Field(default=100, ge=95, le=100)
    width: int = Field(default=1080, ge=320, le=2160)
    height: int = Field(default=1920, ge=320, le=3840)
    fps: int = Field(default=30, ge=15, le=60)
    sourceAudioVolume: float = Field(default=1, ge=0, le=2)
    bgmPath: str | None = Field(default=None, max_length=2048)
    bgmVolume: float = Field(default=0.15, ge=0, le=1)
    subtitlesPath: str | None = Field(default=None, max_length=2048)
    subtitleFontSize: int = Field(default=48, ge=18, le=120)
    textOverlay: str | None = Field(default=None, max_length=300)
    textX: float = Field(default=0.5, ge=0, le=1)
    textY: float = Field(default=0.8, ge=0, le=1)
    textFontSize: int = Field(default=64, ge=18, le=160)


class ComicDialogue(BaseModel):
    text: str = Field(min_length=1, max_length=1000)
    speakerSlot: str | None = Field(default=None, max_length=40)
    speakerId: int | None = Field(default=None, ge=0)


class ComicPage(BaseModel):
    imagePath: str = Field(min_length=1, max_length=2048)
    dialogues: list[ComicDialogue] = Field(min_length=1, max_length=30)


class ComicRenderRequest(BaseModel):
    pages: list[ComicPage] = Field(min_length=1, max_length=60)
    outputName: str = Field(default="sns-studio-comic.mp4", min_length=1, max_length=100)
    width: int = Field(default=1080, ge=320, le=2160)
    height: int = Field(default=1920, ge=320, le=3840)
    fps: int = Field(default=30, ge=15, le=60)
    subtitles: bool = True
    subtitleFontSize: int = Field(default=48, ge=18, le=120)
    subtitlePosition: int = Field(default=2, ge=1, le=9)
    subtitleOutline: int = Field(default=2, ge=0, le=10)
    maxSubtitleChars: int = Field(default=22, ge=4, le=42)
    pagePaddingSeconds: float = Field(default=0.3, ge=0, le=5)
    voiceSlots: dict[str, int] = Field(default_factory=dict)
    bgmPath: str | None = Field(default=None, max_length=2048)
    bgmVolume: float = Field(default=0.1, ge=0, le=1)


class ConcatenateRequest(BaseModel):
    paths: list[str] = Field(min_length=2, max_length=20)
    outputName: str = Field(default="sns-studio-concatenated.mp4", min_length=1, max_length=100)
    width: int = Field(default=1080, ge=320, le=2160)
    height: int = Field(default=1920, ge=320, le=3840)
    fps: int = Field(default=30, ge=15, le=60)


class ProbeRequest(BaseModel):
    path: str = Field(min_length=1, max_length=2048)


class TTSRequest(BaseModel):
    text: str = Field(min_length=1, max_length=5000)
    speakerId: int = Field(ge=0)


class TTSResponse(BaseModel):
    path: str
    fileName: str
    sizeBytes: int


def format_srt_timestamp(seconds: float) -> str:
    milliseconds = max(0, round(seconds * 1000))
    hours, remainder = divmod(milliseconds, 3_600_000)
    minutes, remainder = divmod(remainder, 60_000)
    whole_seconds, millis = divmod(remainder, 1000)
    return f"{hours:02}:{minutes:02}:{whole_seconds:02},{millis:03}"


def build_srt(lines: list[tuple[float, float, str]], max_chars: int = 22) -> str:
    import textwrap

    blocks = []
    for index, (start, end, text) in enumerate(lines, start=1):
        clean_text = text.replace("\r", " ").replace("\n", " ")
        wrapped = "\n".join(textwrap.wrap(clean_text, width=max_chars, break_long_words=True, break_on_hyphens=False))
        blocks.append(f"{index}\n{format_srt_timestamp(start)} --> {format_srt_timestamp(end)}\n{wrapped}")
    return "\n\n".join(blocks) + ("\n" if blocks else "")


def _media_root() -> Path:
    return Path(os.getenv("MEDIA_ROOT", "/uploads")).resolve()


def resolve_media_path(value: str) -> Path:
    root = _media_root()
    requested = Path(value)
    path = requested if requested.is_absolute() else root / requested
    resolved = path.resolve()
    try:
        resolved.relative_to(root)
    except ValueError:
        raise HTTPException(status_code=400, detail={"code": "MEDIA_PATH_INVALID"}) from None
    if not resolved.is_file():
        raise HTTPException(status_code=404, detail={"code": "MEDIA_NOT_FOUND"})
    return resolved


def _ensure_service_token() -> str | None:
    token = os.getenv("SNS_STUDIO_SERVICE_TOKEN") or os.getenv("IG_WORKER_API_TOKEN")
    if token:
        return token
    token_path_setting = os.getenv("MEDIA_WORKER_TOKEN_FILE") or os.getenv("SNS_STUDIO_SERVICE_TOKEN_FILE")
    if not token_path_setting:
        return None
    token_path = Path(token_path_setting)
    token_path.parent.mkdir(parents=True, exist_ok=True)
    try:
        fd = os.open(token_path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError:
        return token_path.read_text(encoding="utf-8").strip()
    token = secrets.token_urlsafe(32)
    with os.fdopen(fd, "w", encoding="utf-8") as token_file:
        token_file.write(token + "\n")
        token_file.flush()
        os.fsync(token_file.fileno())
    return token


def probe(path: Path) -> dict:
    try:
        result = subprocess.run(
            ["ffprobe", "-v", "error", "-show_format", "-show_streams", "-of", "json", str(path)],
            capture_output=True,
            text=True,
            check=True,
            timeout=30,
        )
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail={"code": "FFPROBE_UNAVAILABLE"}) from None
    except subprocess.CalledProcessError:
        raise HTTPException(status_code=422, detail={"code": "MEDIA_INVALID"}) from None
    except subprocess.TimeoutExpired:
        raise HTTPException(status_code=504, detail={"code": "MEDIA_PROBE_TIMEOUT"}) from None
    import json

    data = json.loads(result.stdout)
    streams = data.get("streams", [])
    video = next((s for s in streams if s.get("codec_type") == "video"), None)
    audio = next((s for s in streams if s.get("codec_type") == "audio"), None)
    if not video:
        raise HTTPException(status_code=422, detail={"code": "MEDIA_VIDEO_REQUIRED"})
    kind = "image" if path.suffix.lower() in {".jpg", ".jpeg", ".png", ".webp", ".bmp"} else "video"
    return {
        "fileName": path.name,
        "kind": kind,
        "sizeBytes": path.stat().st_size,
        "durationSeconds": float(data.get("format", {}).get("duration") or 0),
        "container": data.get("format", {}).get("format_name"),
        "video": {
            "codec": video.get("codec_name"),
            "width": video.get("width"),
            "height": video.get("height"),
            "frameRate": video.get("avg_frame_rate"),
            "pixelFormat": video.get("pix_fmt"),
        },
        "audio": None if audio is None else {"codec": audio.get("codec_name"), "sampleRate": audio.get("sample_rate")},
        "hasAudio": audio is not None,
    }


def _escape_filter_path(path: Path) -> str:
    value = str(path).replace("\\", "\\\\").replace(":", "\\:").replace("'", "\\'")
    return value.replace(",", "\\,").replace("[", "\\[").replace("]", "\\]")


def render(body: RenderRequest, root: Path | None = None) -> dict:
    source = resolve_media_path(body.sourcePath)
    bgm = resolve_media_path(body.bgmPath) if body.bgmPath else None
    subtitles = resolve_media_path(body.subtitlesPath) if body.subtitlesPath else None
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.mp4", body.outputName, re.IGNORECASE):
        raise HTTPException(status_code=422, detail={"code": "OUTPUT_NAME_INVALID"})
    root = root or _media_root() / "sns-studio" / "renders"
    root.mkdir(parents=True, exist_ok=True)
    output = root / f"{uuid4().hex[:12]}-{body.outputName}"
    media = probe(source)
    if media["kind"] != "video":
        raise HTTPException(status_code=422, detail={"code": "VIDEO_SOURCE_REQUIRED"})
    source_duration = media["durationSeconds"] - body.trimStartSeconds - body.trimEndSeconds
    if source_duration <= 0:
        raise HTTPException(status_code=422, detail={"code": "MEDIA_TRIM_INVALID"})
    output_duration = source_duration / body.playbackSpeed
    crop_width = max(1, int(body.width * body.cropPercent / 100))
    crop_height = max(1, int(body.height * body.cropPercent / 100))
    video_filter = (
        f"scale={body.width}:{body.height}:force_original_aspect_ratio=increase,"
        f"crop={crop_width}:{crop_height},scale={body.width}:{body.height},setsar=1,"
        f"fps={body.fps},setpts=PTS/{body.playbackSpeed}"
    )
    if subtitles:
        video_filter += (
            f",subtitles=filename='{_escape_filter_path(subtitles)}':"
            f"force_style='FontName=Noto Sans CJK JP,FontSize={body.subtitleFontSize},"
            "Outline=2,Shadow=0,Alignment=2,MarginV=100'"
        )
    overlay_file: Path | None = None
    if body.textOverlay:
        overlay_dir = Path(tempfile.gettempdir()) / "sns-studio-text"
        overlay_dir.mkdir(parents=True, exist_ok=True)
        overlay_file = overlay_dir / f"{uuid4().hex}.txt"
        overlay_file.write_text(body.textOverlay.replace("\x00", "")[:300], encoding="utf-8")
        overlay_filter = (
            f",drawtext=fontfile='/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc':"
            f"textfile='{_escape_filter_path(overlay_file)}':x=w*{body.textX}-text_w/2:"
            f"y=h*{body.textY}-text_h/2:fontsize={body.textFontSize}:fontcolor=white:"
            "box=1:boxcolor=black@0.45:boxborderw=18"
        )
        video_filter += overlay_filter
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    if body.trimStartSeconds:
        command.extend(["-ss", str(body.trimStartSeconds)])
    command.extend(["-i", str(source)])
    if bgm:
        command.extend(["-stream_loop", "-1", "-i", str(bgm)])
    command.extend(["-t", str(output_duration), "-filter_complex", f"[0:v]{video_filter}[v]"])
    if media["hasAudio"] and bgm:
        command[-1] += (
            f";[0:a]volume={body.sourceAudioVolume},atempo={body.playbackSpeed}[source_audio]"
            f";[1:a]volume={body.bgmVolume}[bgm_audio]"
            ";[source_audio][bgm_audio]amix=inputs=2:duration=first:dropout_transition=2[a]"
        )
        command.extend(["-map", "[a]"])
    elif media["hasAudio"]:
        command[-1] += f";[0:a]volume={body.sourceAudioVolume},atempo={body.playbackSpeed}[a]"
        command.extend(["-map", "[a]"])
    elif bgm:
        command[-1] += f";[1:a]volume={body.bgmVolume}[a]"
        command.extend(["-map", "[a]"])
    else:
        command.extend(["-an"])
    command.extend(["-map", "[v]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-movflags", "+faststart", str(output)])
    try:
        subprocess.run(command, capture_output=True, text=True, check=True, timeout=1800)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail={"code": "FFMPEG_UNAVAILABLE"}) from None
    except subprocess.CalledProcessError:
        output.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail={"code": "FFMPEG_FAILED"}) from None
    except subprocess.TimeoutExpired:
        output.unlink(missing_ok=True)
        raise HTTPException(status_code=504, detail={"code": "FFMPEG_TIMEOUT"}) from None
    finally:
        if overlay_file:
            overlay_file.unlink(missing_ok=True)
    rendered = probe(output)
    return {"path": str(output), "fileName": output.name, "sizeBytes": output.stat().st_size, "durationSeconds": rendered["durationSeconds"], "width": rendered["video"]["width"], "height": rendered["video"]["height"], "hasAudio": rendered["hasAudio"]}


def render_comic(body: ComicRenderRequest) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.mp4", body.outputName, re.IGNORECASE):
        raise HTTPException(status_code=422, detail={"code": "OUTPUT_NAME_INVALID"})
    root = _media_root()
    work_root = root / "sns-studio" / "tmp"
    output_root = root / "sns-studio" / "renders"
    work_root.mkdir(parents=True, exist_ok=True)
    output_root.mkdir(parents=True, exist_ok=True)
    output = output_root / f"{uuid4().hex[:12]}-{body.outputName}"
    bgm = resolve_media_path(body.bgmPath) if body.bgmPath else None
    tts = get_tts_provider()
    try:
        with tempfile.TemporaryDirectory(prefix="comic-", dir=work_root) as temporary:
            temporary_root = Path(temporary)
            segments: list[Path] = []
            for page_index, page in enumerate(body.pages):
                image = resolve_media_path(page.imagePath)
                audio_files: list[Path] = []
                subtitle_lines: list[tuple[float, float, str]] = []
                cursor = 0.0
                for dialogue_index, dialogue in enumerate(page.dialogues):
                    speaker_id = body.voiceSlots.get(dialogue.speakerSlot) if dialogue.speakerSlot else dialogue.speakerId
                    if speaker_id is None:
                        raise HTTPException(status_code=422, detail={"code": "TTS_SPEAKER_REQUIRED"})
                    audio_path = temporary_root / f"p{page_index}-d{dialogue_index}.wav"
                    audio_path.write_bytes(tts.synthesize(dialogue.text, str(speaker_id)))
                    duration_result = subprocess.run(
                        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "default=noprint_wrappers=1:nokey=1", str(audio_path)],
                        capture_output=True, text=True, check=True, timeout=30,
                    )
                    duration = float(duration_result.stdout.strip())
                    if duration <= 0:
                        raise HTTPException(status_code=422, detail={"code": "TTS_AUDIO_INVALID"})
                    audio_files.append(audio_path)
                    subtitle_lines.append((cursor, cursor + duration, dialogue.text))
                    cursor += duration

                audio_list = temporary_root / f"p{page_index}-audio.txt"
                audio_list.write_text("".join(f"file '{path.as_posix()}'\n" for path in audio_files), encoding="utf-8")
                combined_audio = temporary_root / f"p{page_index}-audio.wav"
                subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(audio_list), "-c:a", "pcm_s16le", str(combined_audio)], capture_output=True, check=True, timeout=300)
                video_filter = f"scale={body.width}:{body.height}:force_original_aspect_ratio=increase,crop={body.width}:{body.height},setsar=1,fps={body.fps}"
                if body.subtitles:
                    subtitle_file = temporary_root / f"p{page_index}.srt"
                    subtitle_file.write_text(build_srt(subtitle_lines, body.maxSubtitleChars), encoding="utf-8-sig")
                    video_filter += f",subtitles=filename='{_escape_filter_path(subtitle_file)}':force_style='FontName=Noto Sans CJK JP,FontSize={body.subtitleFontSize},Outline={body.subtitleOutline},Shadow=0,Alignment={body.subtitlePosition},MarginV=100'"
                segment = temporary_root / f"page-{page_index:04}.mp4"
                command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", str(body.fps), "-i", str(image), "-i", str(combined_audio)]
                if bgm:
                    command.extend(["-stream_loop", "-1", "-i", str(bgm), "-filter_complex", f"[0:v]{video_filter}[v];[1:a]volume=1[voice];[2:a]volume={body.bgmVolume}[music];[voice][music]amix=inputs=2:duration=first:dropout_transition=2[a]", "-map", "[v]", "-map", "[a]"])
                else:
                    command.extend(["-vf", video_filter, "-map", "0:v:0", "-map", "1:a:0"])
                command.extend(["-t", str(cursor + body.pagePaddingSeconds), "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", str(segment)])
                subprocess.run(command, capture_output=True, check=True, timeout=900)
                segments.append(segment)

            video_list = temporary_root / "videos.txt"
            video_list.write_text("".join(f"file '{path.as_posix()}'\n" for path in segments), encoding="utf-8")
            subprocess.run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", str(video_list), "-c", "copy", "-movflags", "+faststart", str(output)], capture_output=True, check=True, timeout=900)
    except HTTPException:
        output.unlink(missing_ok=True)
        raise
    except httpx.HTTPError:
        output.unlink(missing_ok=True)
        raise HTTPException(status_code=503, detail={"code": "VOICEVOX_SYNTHESIS_FAILED"}) from None
    except (FileNotFoundError, subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError):
        output.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail={"code": "COMIC_RENDER_FAILED"}) from None
    result = probe(output)
    return {"path": str(output), "fileName": output.name, "sizeBytes": output.stat().st_size, "durationSeconds": result["durationSeconds"], "width": result["video"]["width"], "height": result["video"]["height"], "hasAudio": result["hasAudio"], "pageCount": len(body.pages)}


def concatenate(body: ConcatenateRequest) -> dict:
    if not re.fullmatch(r"[A-Za-z0-9._-]+\.mp4", body.outputName, re.IGNORECASE):
        raise HTTPException(status_code=422, detail={"code": "OUTPUT_NAME_INVALID"})
    inputs = [resolve_media_path(path) for path in body.paths]
    media = [probe(path) for path in inputs]
    if any(item["kind"] != "video" for item in media):
        raise HTTPException(status_code=422, detail={"code": "VIDEO_SOURCE_REQUIRED"})
    if any(item["durationSeconds"] <= 0 for item in media):
        raise HTTPException(status_code=422, detail={"code": "VIDEO_DURATION_INVALID"})
    root = _media_root() / "sns-studio" / "renders"
    root.mkdir(parents=True, exist_ok=True)
    output = root / f"{uuid4().hex[:12]}-{body.outputName}"
    command = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y"]
    audio_indices: list[int] = []
    for index, path in enumerate(inputs):
        command.extend(["-i", str(path)])
        audio_indices.append(index if media[index]["hasAudio"] else -1)
    next_input_index = len(inputs)
    for index, media_info in enumerate(media):
        if not media_info["hasAudio"]:
            audio_indices[index] = next_input_index
            command.extend(["-f", "lavfi", "-t", str(media_info["durationSeconds"]), "-i", "anullsrc=channel_layout=stereo:sample_rate=48000"])
            next_input_index += 1
    filters: list[str] = []
    for index, audio_index in enumerate(audio_indices):
        filters.append(f"[{index}:v:0]scale={body.width}:{body.height}:force_original_aspect_ratio=decrease,pad={body.width}:{body.height}:(ow-iw)/2:(oh-ih)/2,fps={body.fps},setsar=1,format=yuv420p,setpts=PTS-STARTPTS[v{index}]")
        filters.append(f"[{audio_index}:a:0]aresample=48000,aformat=sample_fmts=fltp:channel_layouts=stereo,asetpts=PTS-STARTPTS[a{index}]")
    pads = "".join(f"[v{index}][a{index}]" for index in range(len(inputs)))
    filters.append(f"{pads}concat=n={len(inputs)}:v=1:a=1[v][a]")
    command.extend(["-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-preset", "medium", "-crf", "20", "-pix_fmt", "yuv420p", "-c:a", "aac", "-b:a", "192k", "-movflags", "+faststart", str(output)])
    try:
        subprocess.run(command, capture_output=True, text=True, check=True, timeout=1800)
    except FileNotFoundError:
        raise HTTPException(status_code=503, detail={"code": "FFMPEG_UNAVAILABLE"}) from None
    except subprocess.CalledProcessError:
        output.unlink(missing_ok=True)
        raise HTTPException(status_code=422, detail={"code": "FFMPEG_FAILED"}) from None
    except subprocess.TimeoutExpired:
        output.unlink(missing_ok=True)
        raise HTTPException(status_code=504, detail={"code": "FFMPEG_TIMEOUT"}) from None
    result = probe(output)
    return {"path": str(output), "fileName": output.name, "sizeBytes": output.stat().st_size, "durationSeconds": result["durationSeconds"], "width": result["video"]["width"], "height": result["video"]["height"], "hasAudio": result["hasAudio"], "inputCount": len(inputs)}


def create_app() -> FastAPI:
    app = FastAPI(title="SNS Studio Media Worker", version="1.0.0")
    app.state.token = _ensure_service_token()

    @app.middleware("http")
    async def require_internal_token(request: Request, call_next):
        expected = app.state.token
        if request.url.path != "/health" and expected:
            received = request.headers.get("authorization", "")
            if not secrets.compare_digest(received, f"Bearer {expected}"):
                return JSONResponse(status_code=401, content={"detail": "Unauthorized"})
        return await call_next(request)

    @app.get("/health")
    def health():
        return {"status": "ok", "service": "media-worker", "ffmpeg": bool(shutil.which("ffmpeg")), "ffprobe": bool(shutil.which("ffprobe"))}

    @app.post("/probe")
    def media_probe(body: ProbeRequest):
        return probe(resolve_media_path(body.path))

    @app.post("/render")
    def render_video(body: RenderRequest):
        return render(body)

    @app.post("/comic/render")
    def render_comic_video(body: ComicRenderRequest):
        return render_comic(body)

    @app.post("/concat")
    def concatenate_videos(body: ConcatenateRequest):
        return concatenate(body)

    @app.get("/voicevox/speakers")
    def voicevox_speakers():
        try:
            return get_tts_provider().list_voices()
        except Exception:
            raise HTTPException(status_code=503, detail={"code": "VOICEVOX_UNAVAILABLE"}) from None

    @app.post("/voicevox/audio", response_model=TTSResponse)
    def voicevox_audio(body: TTSRequest):
        try:
            audio_bytes = get_tts_provider().synthesize(body.text, str(body.speakerId))
        except Exception:
            raise HTTPException(status_code=503, detail={"code": "TTS_FAILED"}) from None
        output_dir = _media_root() / "sns-studio" / "tts"
        output_dir.mkdir(parents=True, exist_ok=True)
        output = output_dir / f"{uuid4().hex}.wav"
        output.write_bytes(audio_bytes)
        return {"path": str(output), "fileName": output.name, "sizeBytes": output.stat().st_size}

    return app


app = create_app()
