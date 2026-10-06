"""Offline visual fallback prototype. Never imported by the production Worker.

This draws pixels into a temporary video, not an Instagram Native Sticker.
It deliberately has no Instagram client, login, HTTP, or publish code.
"""

from contextlib import contextmanager
from dataclasses import dataclass
import math
from pathlib import Path
import subprocess
import tempfile
from urllib.parse import urlsplit

from PIL import Image, ImageDraw, ImageFont


@dataclass(frozen=True)
class LinkPlacement:
    x: float = 0.5
    y: float = 0.5
    width: float = 0.51
    height: float = 0.26
    rotation: float = 0.0

    def pixel_box(self, canvas_width: int, canvas_height: int):
        values = (self.x, self.y, self.width, self.height, self.rotation)
        if not all(math.isfinite(v) for v in values):
            raise ValueError("Sticker values must be finite")
        if canvas_width <= 0 or canvas_height <= 0:
            raise ValueError("Canvas dimensions must be positive")
        if not (0 < self.width <= 1 and 0 < self.height <= 1):
            raise ValueError("Sticker size must be within (0, 1]")
        w, h = self.width * canvas_width, self.height * canvas_height
        cx, cy = self.x * canvas_width, self.y * canvas_height
        angle = math.radians(self.rotation)
        # Evaluate rotation in pixel space, including the canvas aspect ratio.
        extent_x = (abs(w * math.cos(angle)) + abs(h * math.sin(angle))) / 2
        extent_y = (abs(w * math.sin(angle)) + abs(h * math.cos(angle))) / 2
        if cx - extent_x < -1e-7 or cx + extent_x > canvas_width + 1e-7:
            raise ValueError("Sticker extends beyond horizontal bounds")
        if cy - extent_y < -1e-7 or cy + extent_y > canvas_height + 1e-7:
            raise ValueError("Sticker extends beyond vertical bounds")
        return cx - w / 2, cy - h / 2, w, h


def display_host(url: str) -> str:
    parts = urlsplit(url)
    if parts.scheme not in {"https", "http"} or not parts.hostname or parts.username or parts.password:
        raise ValueError("A public HTTP(S) Link URL without credentials is required")
    # Show only the hostname, never query parameters or a tracking token.
    return parts.hostname


def overlay_image(canvas_width: int, canvas_height: int, placement: LinkPlacement,
                  url: str, font_path: Path, label: str = "リンクを開く") -> Image.Image:
    left, top, width, height = placement.pixel_box(canvas_width, canvas_height)
    host = display_host(url)
    card_width, card_height = max(1, round(width)), max(1, round(height))
    card = Image.new("RGBA", (card_width, card_height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(card)
    draw.rounded_rectangle((0, 0, card_width - 1, card_height - 1),
                           radius=min(card_width, card_height) // 8,
                           fill="white", outline="#dadce0", width=max(1, card_width // 180))
    font_size = max(8, int(min(card_width / 9, card_height / 5)))
    text = label + "\n" + host
    while True:
        font = ImageFont.truetype(str(font_path), font_size)
        bounds = draw.multiline_textbbox((0, 0), text, font=font, spacing=font_size // 3)
        if bounds[2] - bounds[0] <= card_width * 0.86 and bounds[3] - bounds[1] <= card_height * 0.8:
            break
        font_size -= 1
        if font_size < 8:
            raise ValueError("Sticker is too small to display the link label")
    draw.multiline_text(((card_width - (bounds[2] - bounds[0])) / 2 - bounds[0],
                         (card_height - (bounds[3] - bounds[1])) / 2 - bounds[1]),
                        text, font=font, spacing=font_size // 3, align="center", fill="#185abc")
    # Positive Story angles are treated as clockwise in this prototype.
    # The production integration must verify this convention before enabling rotation.
    if placement.rotation:
        card = card.rotate(-placement.rotation, expand=True, resample=Image.Resampling.BICUBIC)
        left = placement.x * canvas_width - card.width / 2
        top = placement.y * canvas_height - card.height / 2
    canvas = Image.new("RGBA", (canvas_width, canvas_height), (0, 0, 0, 0))
    canvas.alpha_composite(card, (round(left), round(top)))
    return canvas


@contextmanager
def temporary_visual_video(source: Path, canvas_width: int, canvas_height: int,
                           placement: LinkPlacement, url: str, font_path: Path,
                           ffmpeg_path: str, temp_root: Path | None = None):
    """Render one derived file and remove all temporary files on success or failure.

    The caller supplies already probed, upright 9:16 dimensions. This prototype
    does not crop, rescale, publish, change account defaults, or modify source.
    """
    if not source.is_file() or source.stat().st_size == 0:
        raise ValueError("Story source is missing or empty")
    if abs(canvas_width / canvas_height - 9 / 16) > 0.001:
        raise ValueError("The prototype requires an upright 9:16 source")
    placement.pixel_box(canvas_width, canvas_height)
    with tempfile.TemporaryDirectory(prefix="sns-story-link-preview-", dir=temp_root) as directory:
        directory = Path(directory)
        overlay = directory / "visible-link.png"
        output = directory / "story-visual-fallback.mp4"
        overlay_image(canvas_width, canvas_height, placement, url, font_path).save(overlay)
        result = subprocess.run([
            ffmpeg_path, "-hide_banner", "-loglevel", "error", "-nostdin", "-n",
            "-i", str(source), "-loop", "1", "-i", str(overlay),
            "-filter_complex", "[0:v][1:v]overlay=0:0:shortest=1[v]",
            "-map", "[v]", "-map", "0:a?", "-c:v", "libx264", "-crf", "20",
            "-preset", "fast", "-pix_fmt", "yuv420p", "-c:a", "copy",
            "-movflags", "+faststart", str(output),
        ], capture_output=True, timeout=120)
        if result.returncode or not output.is_file() or output.stat().st_size == 0:
            raise RuntimeError("Offline Story visual render failed")
        yield output
