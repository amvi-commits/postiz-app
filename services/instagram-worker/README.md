# SNS Studio Instagram Worker

This FastAPI service owns Instagram credentials and `instagrapi` session settings. Credentials and session data are encrypted with Fernet before they are written to the persistent data directory. The worker returns only account status and publication identifiers to the Postiz backend.

## Local run

```powershell
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
$env:IG_DATA_DIR = "$env:LOCALAPPDATA\SNSStudio\instagram-worker"
$env:IG_MEDIA_ROOT = "C:\path\to\shared\uploads"
$env:IG_WORKER_API_TOKEN = "set-a-long-random-secret"
uvicorn app.main:app --host 127.0.0.1 --port 8000
```

The encryption key is generated once under `IG_DATA_DIR/.credentials.key` and must remain with the encrypted records. Back up both together. `IG_CREDENTIALS_KEY` can be supplied instead when the key is managed externally.

## API

- `GET /health`
- `POST /accounts/login`
- `POST /accounts/{accountId}/validate`
- `GET /accounts/{accountId}/info`
- `GET /accounts/{accountId}/trial-reel-eligibility`
- `POST /media/preflight/story` (local media check; no Instagram client or session access)
- `POST /publish/reel`
- `POST /publish/story`
- `GET /insights/media/{mediaId}?accountId=...`
- `GET /accounts/{accountId}/health`

All endpoints except health require `Authorization: Bearer <IG_WORKER_API_TOKEN>` when a token is configured. Media paths must resolve inside `IG_MEDIA_ROOT`.

## Instagram behavior

This uses Instagram's unofficial private API through `instagrapi`; it is separate from Postiz's existing official-API Providers. Instagram can require a challenge or two-factor code, and can change or reject private API operations. The worker does not rotate proxies, spoof device identities, bypass challenges, or retry failed publications automatically. Story link stickers are requested through the library's `StoryLink` support, but the upstream project has reports of link stickers not appearing; a successful upload response alone does not prove the sticker rendered.

## Visible links for video Stories (2026-10-04)

Video Stories now use the installed MoviePy 2.2.1 standard `VideoFileClip`,
`TextClip`, `CompositeVideoClip`, and `write_videofile` APIs to add two lines:

```text
OPEN LINK
example.com
```

The hostname comes from Python's `urllib.parse.urlparse`; path and query strings
are not displayed. The original URL is still passed to the unchanged instagrapi
`StoryLink` / `video_upload_to_story(..., links=[link])` path. This is text baked
into the video, not an Instagram Native Sticker. No Native payload fields,
custom graphics, new dependencies, or font files are added. `font=None` uses
Pillow's default font, with white text and a black background.

The existing sticker x/y/width/height values remain the only placement settings.
x/y are the rectangle center; MoviePy receives their conversion to video pixels.
V1 requires rotation=0 and rejects rectangles outside the frame. The renderer
retains source resolution, fps, and audio, using libx264/AAC through MoviePy.
Audio is re-encoded using MoviePy's standard defaults, not copied bit for bit.
Photo Story uploads retain their existing behavior.

Both the derived MP4 and the existing thumbnail are written inside the existing
`TemporaryDirectory(prefix="sns-instagram-story-")`. The thumbnail generator is
unchanged and receives the derived video. Nothing is written beside the source.
MoviePy readers/clips close in finally, and the caller's temporary directory
cleans up on success or failure. A render failure stops before upload with
`IG_STORY_VISUAL_RENDER_FAILED`; there is no automatic retry.

Backend `POST /api/sns-studio/media/preflight/story` calls the Worker's local
`POST /media/preflight/story` for video rendering, output decode, and StoryLink
construction. The local route does not create an Instagram client or access a
saved account session. Backend only requests existing account health after all
local checks pass. Preflight creates no publish record or persistent output.

Official implementations checked before this change:

- instagrapi 3.0.14: [README](https://github.com/subzeroid/instagrapi/blob/3.0.14/README.md), [Story guide](https://github.com/subzeroid/instagrapi/blob/3.0.14/docs/usage-guide/story.md), [upload example](https://github.com/subzeroid/instagrapi/blob/3.0.14/examples/upload_story.py), [live Story tests](https://github.com/subzeroid/instagrapi/blob/3.0.14/tests/live/test_story.py).
- MoviePy 2.2.1: [README](https://github.com/Zulko/moviepy/blob/v2.2.1/README.md), [TextClip implementation](https://github.com/Zulko/moviepy/blob/v2.2.1/moviepy/video/VideoClip.py), [CompositeVideoClip](https://github.com/Zulko/moviepy/blob/v2.2.1/moviepy/video/compositing/CompositeVideoClip.py), [TextClip tests, including test_no_font](https://github.com/Zulko/moviepy/blob/v2.2.1/tests/test_TextClip.py), [compositing tests](https://github.com/Zulko/moviepy/blob/v2.2.1/tests/test_compositing.py).

The earlier custom rendering experiment under tests is historical investigation
only and is never used by this production implementation. The latest user choice
is standard MoviePy composition, with no Native/fallback mode selector or new
coordinate model. Schema, migrations, and common publishing models are unchanged.
