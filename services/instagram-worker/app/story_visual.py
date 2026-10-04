"""Visible video link text using the installed MoviePy standard composition API."""

import math
from pathlib import Path
from urllib.parse import urlparse

from .schemas import StickerPosition


class StoryVisualInputError(ValueError):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def story_link_text(url: str) -> str:
    try:
        parsed = urlparse(url)
        hostname = parsed.hostname
        if parsed.scheme not in {"http", "https"} or not hostname:
            raise ValueError("Missing HTTP(S) hostname")
        hostname = hostname.encode("idna").decode("ascii")
    except (ValueError, UnicodeError):
        raise StoryVisualInputError("IG_STORY_LINK_INVALID", "The Story URL requires a valid hostname.") from None
    return f"OPEN LINK\n{hostname}"


def render_story_link_video(source: Path, output: Path, url: str, sticker: StickerPosition) -> dict:
    """Write a derived MP4 into the caller's existing TemporaryDirectory.

    No Instagram API, custom drawing, fonts, or FFmpeg filters are used here.
    The existing StoryLink remains the source of all normalized placement values.
    """
    text = story_link_text(url)
    if sticker.rotation != 0:
        raise StoryVisualInputError("IG_STORY_ROTATION_UNSUPPORTED", "Visible Story links require rotation=0 in V1.")
    if not all(math.isfinite(v) for v in (sticker.x, sticker.y, sticker.width, sticker.height)) or not (
        sticker.width > 0 and sticker.height > 0
        and sticker.x - sticker.width / 2 >= 0 and sticker.x + sticker.width / 2 <= 1
        and sticker.y - sticker.height / 2 >= 0 and sticker.y + sticker.height / 2 <= 1
    ):
        raise StoryVisualInputError("IG_STORY_STICKER_POSITION_INVALID", "The complete Story link rectangle must be inside the video.")
    if output.resolve() == source.resolve():
        raise ValueError("A Story overlay must not overwrite its source")

    from moviepy import CompositeVideoClip, TextClip, VideoFileClip

    video = overlay = composite = None
    try:
        video = VideoFileClip(str(source))
        if not video.duration or not video.fps:
            raise ValueError("The Story video requires duration and fps")
        width, height = video.size
        box_width = max(1, round(width * sticker.width))
        box_height = max(1, round(height * sticker.height))
        left = width * sticker.x - box_width / 2
        top = height * sticker.y - box_height / 2
        # TextClip caption sizes the two lines to this rectangle using Pillow's
        # default font. This is the standard MoviePy API, with no font file.
        overlay = TextClip(
            font=None, text=text, method="caption", size=(box_width, box_height),
            color="white", bg_color="black", text_align="center",
            horizontal_align="center", vertical_align="center",
        ).with_duration(video.duration).with_position((left, top))
        composite = CompositeVideoClip([video, overlay], size=video.size)
        composite.write_videofile(
            str(output), fps=video.fps, codec="libx264", audio_codec="aac",
            temp_audiofile=str(output.parent / "story-overlay-audio.m4a"),
            remove_temp=True, threads=2, logger=None,
        )
        if not output.is_file() or output.stat().st_size == 0:
            raise ValueError("MoviePy produced no Story video")
        with VideoFileClip(str(output)) as decoded:
            if decoded.size != video.size or abs(decoded.fps - video.fps) > 0.01:
                raise ValueError("Story dimensions or fps changed")
            if video.audio is not None and decoded.audio is None:
                raise ValueError("Story audio was lost")
            # Decode the whole output through MoviePy's standard reader.
            for _frame in decoded.iter_frames(dtype="uint8", logger=None):
                pass
        return {
            "text": text, "width": width, "height": height, "fps": video.fps,
            "durationSeconds": video.duration, "hasAudio": video.audio is not None,
            "sizeBytes": output.stat().st_size, "decode": "PASS",
            "overlayPixels": {"left": left, "top": top, "width": box_width, "height": box_height},
        }
    finally:
        for clip in (composite, overlay, video):
            if clip is not None:
                clip.close()
