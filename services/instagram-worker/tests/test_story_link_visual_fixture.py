"""Network-free tests of the proposed visible fallback, not a publishing path."""

import hashlib
from pathlib import Path
import subprocess

import imageio_ffmpeg
import pytest

from story_link_visual_fixture import LinkPlacement, display_host, overlay_image, temporary_visual_video


def test_visible_overlay_uses_the_same_normalized_center_and_size():
    placement = LinkPlacement()
    left, top, width, height = placement.pixel_box(1080, 1920)
    assert (left + width / 2) / 1080 == pytest.approx(0.5)
    assert (top + height / 2) / 1920 == pytest.approx(0.5)
    assert width / 1080 == pytest.approx(0.51)
    assert height / 1920 == pytest.approx(0.26)
    assert (left, top, width, height) == pytest.approx((264.6, 710.4, 550.8, 499.2))


@pytest.mark.parametrize("values", [dict(x=0), dict(y=1), dict(width=0), dict(height=1.1),
                                     dict(x=float("nan")), dict(rotation=float("inf")),
                                     dict(x=0.1, rotation=45)])
def test_invalid_or_rotated_out_of_bounds_placements_are_rejected(values):
    with pytest.raises(ValueError):
        LinkPlacement(**values).pixel_box(1080, 1920)


def test_url_label_uses_hostname_and_never_query_parameters():
    assert display_host("https://example.com/?token=private-value") == "example.com"
    for url in ("javascript:alert(1)", "https://user:secret@example.com/", "not-a-url"):
        with pytest.raises(ValueError):
            display_host(url)


@pytest.fixture
def offline_font(tmp_path):
    # Use Pillow's embedded font for geometry tests without adding system fonts.
    # The Japanese media preview uses the media Worker's existing Noto CJK font.
    from PIL import ImageFont
    path = tmp_path / "offline-font.ttf"
    path.write_bytes(ImageFont.load_default(size=12).font_bytes)
    return path


def test_overlay_alpha_box_matches_tap_box_with_subpixel_rounding(offline_font):
    image = overlay_image(1080, 1920, LinkPlacement(), "https://example.com/", offline_font, "Open link")
    assert image.size == (1080, 1920)
    assert image.getbbox() == (265, 710, 816, 1209)
    assert image.getpixel((540, 740))[3] == 255
    assert image.getpixel((50, 50))[3] == 0


def test_temp_render_leaves_source_unchanged_and_cleans_up(offline_font, tmp_path):
    ffmpeg = imageio_ffmpeg.get_ffmpeg_exe()
    source = tmp_path / "source.mp4"
    subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-nostdin", "-f", "lavfi",
                    "-i", "color=c=purple:s=108x192:d=0.3:r=10", "-c:v", "libx264",
                    "-pix_fmt", "yuv420p", str(source)], check=True, capture_output=True)
    digest = hashlib.sha256(source.read_bytes()).hexdigest()
    size = source.stat().st_size
    with temporary_visual_video(source, 108, 192, LinkPlacement(width=0.8, height=0.5),
                                "https://example.com/", offline_font, ffmpeg, tmp_path) as output:
        assert output.is_file() and output.stat().st_size > 0
        parent = output.parent
        subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-i", str(output),
                        "-f", "null", "-"], check=True, capture_output=True)
    assert not parent.exists()
    assert hashlib.sha256(source.read_bytes()).hexdigest() == digest
    assert source.stat().st_size == size
    assert not Path(str(source) + ".jpg").exists()


def test_render_failure_and_consumer_failure_cleanup(offline_font, tmp_path, monkeypatch):
    source = tmp_path / "source.mp4"
    source.write_bytes(b"offline mock")
    monkeypatch.setattr(subprocess, "run", lambda *_args, **_kwargs: subprocess.CompletedProcess([], 1))
    with pytest.raises(RuntimeError, match="Offline Story visual render failed"):
        with temporary_visual_video(source, 1080, 1920, LinkPlacement(), "https://example.com/",
                                    offline_font, "offline-ffmpeg", tmp_path):
            pytest.fail("A failed render must not yield a media file")
    assert not list(tmp_path.glob("sns-story-link-preview-*"))

    def rendered(args, **kwargs):
        Path(args[-1]).write_bytes(b"rendered mock")
        return subprocess.CompletedProcess(args, 0)

    monkeypatch.setattr(subprocess, "run", rendered)
    with pytest.raises(ValueError, match="consumer failure"):
        with temporary_visual_video(source, 1080, 1920, LinkPlacement(), "https://example.com/",
                                    offline_font, "offline-ffmpeg", tmp_path) as output:
            parent = output.parent
            raise ValueError("consumer failure")
    assert not parent.exists()
    assert source.read_bytes() == b"offline mock"
