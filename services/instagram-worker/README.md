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
- `POST /publish/reel`
- `POST /publish/story`
- `GET /insights/media/{mediaId}?accountId=...`
- `GET /accounts/{accountId}/health`

All endpoints except health require `Authorization: Bearer <IG_WORKER_API_TOKEN>` when a token is configured. Media paths must resolve inside `IG_MEDIA_ROOT`.

## Instagram behavior

This uses Instagram's unofficial private API through `instagrapi`; it is separate from Postiz's existing official-API Providers. Instagram can require a challenge or two-factor code, and can change or reject private API operations. The worker does not rotate proxies, spoof device identities, bypass challenges, or retry failed publications automatically. Story link stickers are requested through the library's `StoryLink` support, but the upstream project has reports of link stickers not appearing; a successful upload response alone does not prove the sticker rendered.
