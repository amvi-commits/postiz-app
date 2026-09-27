# SNS Studio V1 (local Windows)

日本語版: [SNS_STUDIO.ja.md](SNS_STUDIO.ja.md)

SNS Studio adds a local Instagram creation and immediate publishing workspace to Postiz. It keeps the existing Postiz providers and license notices. Instagram sign-in and publishing use the separate Python `instagrapi` worker; they do not use Meta Graph API.

## Start it on Windows

1. Install and start Docker Desktop, then open PowerShell in this repository folder.
2. Copy `.env.example` to `.env`. Keep `.env` private. Set `SNS_STUDIO_SERVICE_TOKEN` to a long random value before starting. Google Drive and OpenAI settings are optional until those features are used.
3. Start the local stack:

   ```powershell
   docker compose up -d --build
   docker compose ps
   ```

   The first start builds Postiz and the two workers and downloads the CPU VOICEVOX image. Postgres, Redis, Temporal and the existing Postiz services stay in the stack. Prisma applies the additive SNS Studio schema when Postiz starts.
4. Open [http://localhost:4007](http://localhost:4007), create the local Postiz user, and open **SNS Studio** from the navigation.

The Postiz UI is bound to `127.0.0.1:4007`. The root Compose file does not publish worker ports. `docker-compose.dev.yaml` is for development and publishes worker health/API ports on loopback only.

## Connect Google Drive

For local validation without Google credentials, set `SNS_STUDIO_GOOGLE_DRIVE_MOCK=true` in `.env`. The mock lists and syncs files from `uploads/sns-studio/mock-drive/inbox/`, and writes queued jobs/results under the same `mock-drive/jobs/` and `mock-drive/results/` directories. It does not contact Google OAuth. The default is `false`.

1. In Google Cloud Console, enable the Google Drive API and create an OAuth client for a Web application.
2. Add this exact authorized redirect URI to that client:

   `http://localhost:4007/api/sns-studio/drive/callback`

3. Put `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_CLIENT_SECRET`, and the same `GOOGLE_DRIVE_REDIRECT_URI` in `.env`, then recreate the Postiz service:

   ```powershell
   docker compose up -d --force-recreate postiz
   ```

4. In SNS Studio → Settings, connect Google Drive, choose a folder, and run Sync.

The OAuth flow requests the Google Drive `drive` scope because the app lists a chosen folder and writes generation jobs/results there. This grants broad Drive read/write access to the local app. Review Google's current scope details before granting it: [Drive API scopes](https://developers.google.com/workspace/drive/api/guides/api-specific-auth).

OAuth tokens are encrypted in the persistent `sns-studio-data` volume. The encryption key is generated there on first use unless `GOOGLE_DRIVE_TOKEN_KEY` is set. The Instagram worker creates its own credential key in `sns-instagram-data` unless `IG_CREDENTIALS_KEY` is configured. Back up the relevant volumes and any configured keys together; without the matching key, saved sessions cannot be decrypted.

## Connect Instagram

In SNS Studio → Accounts, sign in with the Instagram account you own or administer. Passwords and session data are encrypted in the worker's persistent storage; they are not saved in the Postgres account row. Add an optional account-specific static HTTP(S) or SOCKS5 proxy and test it before login if needed.

If Instagram asks for 2FA or a challenge, the account is marked **NEEDS_USER_ACTION**. Complete that step through the UI and validate the session again. The worker does not rotate proxies, bypass challenges, or retry a failed publish automatically. Instagram can change the private endpoints used by `instagrapi`; publishing and Story link sticker behavior should be checked in the Instagram app after the first post.

## Create and publish

1. Sync assets from the selected Drive folder into Content Inbox.
2. Select a saved Recipe and run it, or use Create to render, concatenate, or make a comic slideshow.
3. Follow the run in Queue. Review its video/image preview, then approve it.
4. Load the approved result into Create, select the Instagram account, edit the caption or Story link/sticker, and use **Preflight and publish now**.

Publishing is immediate. There is no scheduled posting, calendar, PC-off posting, or batch posting in SNS Studio V1. Failed publishing stays in history; a user can manually retry the same completed media. Preflight checks session health and readable media before the worker calls Instagram.

For comic slides, save speaker IDs in Settings → Voice Presets. VOICEVOX runs locally in Docker. Check the voice/style terms and attribution conditions for the selected speakers before publishing.

## Optional services

- **AI Caption:** set `OPENAI_API_KEY` in `.env` to enable the account-level caption helper. The suggested caption remains editable and is never published without the user's action.
- **Colab generation:** `services/colab/sns_studio_worker.ipynb` is a Drive job-queue sample. The model-specific adapter is intentionally a stub until a generation model is selected. Implement `sns_studio_model_adapter.generate(job, output_dir)` in the notebook environment, then write output files and the result manifest to the job folder.
- **Retention:** Settings can keep final videos for 7 days, 30 days, or indefinitely. Original assets and database/history records are retained. Only successfully published final renders under the SNS Studio render directory are cleanup candidates.

## Check the local stack

After `docker compose up`, run:

```powershell
.scripts\sns-studio-smoke.ps1
```

It checks the required Compose services, Postgres, Redis, Instagram/Media worker health endpoints, and the local UI routes. It does not authenticate to Instagram or post a test item.

To exercise mock Drive generation end to end, queue a Generation Job in Settings, get its latest ID from Postgres, run `scripts/sns-studio-mock-colab.py` inside the Media Worker, then click **結果を同期**. The script copies a local Inbox fixture to mock Drive results and does not contact Google.

## Data and known limits

- Local state lives in Docker volumes, including `postgres-volume`, `postiz-uploads`, `sns-studio-data`, and `sns-instagram-data`. Back up data before making schema or volume changes. Do not use `docker compose down -v` unless you intend to delete those volumes.
- This branch is based on Postiz commit `374fb202334a4b6db183f2e44c52c83a9db58a8b` and retains its AGPL-3.0 notices. Review the license obligations before redistributing a modified build.
- `SNS_STUDIO_INSTAGRAM_MOCK=true` enables credential-free local Instagram login, publish, and analytics paths in the worker. The default is `false`; mock calls do not connect to a real account.
- Instagram authentication/publishing, Google OAuth, and model-specific Colab generation require the user's own credentials or account-side setup.
