# Threads Browser Publishing Sidecar (FastAPI + Playwright)

Meta公式API（Threads Graph API）が利用できない環境や制限されている環境において、ユーザー自身が通常ブラウザ操作で認証済みのThreadsアカウントを使用し、Playwrightの永続ブラウザプロファイル（Persistent Chromium Profile）経由で投稿を代行するThreads専用マイクロサービスです。

SNS Studioの共通投稿基盤（`SnsContent`, `SnsDelivery`など）や公式APIプロバイダーを壊すことなく、安全な代替publish transportとして機能します。

---

## 主な特徴とセキュリティ設計

1. **Persistent Profile管理**:
   - `sessions/{account_name}/` 単位で個別のChromiumプロファイルを永続化。
   - `launch_persistent_context()` を利用し、Cookie・IndexedDB・ローカルストレージを丸ごと保持。
   - パス・トラバーサル防止（`^[A-Za-z0-9_-]{1,64}$` の厳格な正規表現とcanonical path検証）。
2. **アカウント単位プロセス排他制御**:
   - `filelock` によるアカウント単位の排他ロックを実装。同一アカウントへの多重並行操作によるプロファイル破損（`ACCOUNT_BUSY`, 409）を防止。
3. **セキュリティとプライバシー保護**:
   - ユーザー名・パスワード・2FA/OTP情報の取得・保存は一切行いません。
   - Cookieやアクセストークン、認証ヘッダーのログ出力およびファイル保存は禁止。
   - `X-Threads-Service-Key` によるAPIキー照合保護（`/health` を除く全エンドポイント）。
   - デフォルトで `127.0.0.1` のみにバインド（外部公開防止）。
4. **フォールバックと診断機能**:
   - UIセレクター失敗時、機密情報を除外した状態（URL、タイトル、スクリーンショット）を `diagnostics/` へ安全に保存。
   - Ghost PostはWeb UIにネイティブ機能が存在しない場合、擬似実装（投稿後24h削除）を行わず `GHOST_NOT_AVAILABLE` (409) で安全に拒絶。

---

## セットアップ

### 1. 仮想環境作成と依存ライブラリのインストール

```powershell
# ディレクトリ移動
cd services/threads-browser-worker

# 仮想環境作成
python -m venv .venv

# 仮想環境有効化 (Windows PowerShell)
.venv\Scripts\Activate.ps1

# パッケージインストール
pip install -r requirements.txt

# Playwright Chromiumブラウザのインストール
playwright install chromium
```

### 2. 環境変数設定

`.env.example` を参考に `.env` を作成します：

```bash
cp .env.example .env
```

```ini
THREADS_BROWSER_SERVICE_HOST=127.0.0.1
THREADS_BROWSER_SERVICE_PORT=8017
THREADS_BROWSER_HEADLESS=true
THREADS_BROWSER_TIMEOUT_MS=60000
THREADS_BROWSER_SERVICE_KEY=YOUR_SECURE_KEY_HERE
```

---

## 初回ログインとセッション管理

### 1. 初回ログイン（Headfulブラウザでの手動操作）

```powershell
python cli_login.py main
```

- 指定アカウント名（例: `main`）でChromiumブラウザが立ち上がり、Threadsログイン画面が表示されます。
- 通常のブラウザ操作でログインを完了させた後、ターミナルで `Enter` キーを押下するとセッションが `sessions/main/` に保存されます。

### 2. セッション有効性確認（Headlessモード）

```powershell
python cli_login.py main --check
```

- 結果として `SESSION_OK`、`AUTH_REQUIRED`、または `SESSION_UNKNOWN` が返されます。

---

## サーバー起動

```powershell
uvicorn app.main:app --host 127.0.0.1 --port 8017
```

---

## API仕様とcurl例

### 1. ヘルスチェック（認証不要）

```bash
curl http://127.0.0.1:8017/health
```

レスポンス：
```json
{
  "status": "ok",
  "playwright": true
}
```

### 2. 登録アカウント一覧

```bash
curl http://127.0.0.1:8017/api/threads/accounts \
  -H "X-Threads-Service-Key: YOUR_SECURE_KEY_HERE"
```

レスポンス例：
```json
{
  "accounts": [
    {
      "name": "main",
      "profile_exists": true
    }
  ]
}
```

### 3. セッション確認

```bash
curl -X POST http://127.0.0.1:8017/api/threads/session/check \
  -H "Content-Type: application/json" \
  -H "X-Threads-Service-Key: YOUR_SECURE_KEY_HERE" \
  -d '{"account": "main"}'
```

### 4. ドライラン投稿（投稿ボタンを押さずにテキスト入力まで検証）

```bash
curl -X POST http://127.0.0.1:8017/api/threads/post \
  -H "Content-Type: application/json" \
  -H "X-Threads-Service-Key: YOUR_SECURE_KEY_HERE" \
  -d '{
    "account": "main",
    "text": "Threadsブラウザ投稿ドライランテストです。",
    "dry_run": true,
    "request_id": "dryrun-req-001"
  }'
```

レスポンス：
```json
{
  "status": "dry_run_ok",
  "account": "main",
  "post_id": null,
  "request_id": "dryrun-req-001",
  "url": null
}
```

### 5. メディア添付投稿（画像・カルーセル）

`media_urls`（公開画像URL）または `media_paths`（ローカル/ボリューム上のファイルパス）を指定して投稿できます。
- 対応拡張子: `.jpg`, `.jpeg`, `.png`, `.webp`
- 最大添付枚数: 10枚（カルーセル対応）

```bash
curl -X POST http://127.0.0.1:8017/api/threads/post \
  -H "Content-Type: application/json" \
  -H "X-Threads-Service-Key: YOUR_SECURE_KEY_HERE" \
  -d '{
    "account": "main",
    "text": "メディア添付テストです。",
    "media_urls": [
      "https://images.unsplash.com/photo-1579783902614-a3fb3927b675.jpg"
    ],
    "dry_run": true
  }'
```

### 6. 本番実投稿（ユーザー明示実行）

※ 注意: `dry_run: false` を指定すると、実際にThreadsへ公開されます。

```bash
curl -X POST http://127.0.0.1:8017/api/threads/post \
  -H "Content-Type: application/json" \
  -H "X-Threads-Service-Key: YOUR_SECURE_KEY_HERE" \
  -d '{
    "account": "main",
    "text": "本番投稿メッセージ",
    "is_ghost": false,
    "dry_run": false
  }'
```

---

## 実機検証用サポートCLI (`verify_post.py`)

CLIから安全にセッション認証状態の確認やテキスト・メディア添付投稿（デフォルトで安全な `dry_run` モード）をテストできます。

```bash
# ヘルプ確認
python verify_post.py --help

# 1. 安全なドライラン検証（テキストのみ）
python verify_post.py --account main --text "テスト投稿です"

# 2. メディア添付ドライラン検証（画像URLまたはローカルパス、複数指定可）
python verify_post.py --account main --text "写真添付テスト" --media "https://example.com/photo.jpg"

# 3. 実投稿（--real フラグを明示した場合のみ実際に投稿）
python verify_post.py --account main --text "本番投稿" --real
```

- セッションが切れている（`AUTH_REQUIRED`）場合は、自動的に `cli_login.py` の実行を促して安全に終了します。
- 失敗時は `diagnostics/` 内に保存されたスクリーンショット等のパスを案内します。

---

## Docker および Docker Compose 統合

ルートの `docker-compose.yaml` に `threads-browser-worker` が統合されています。

### 起動方法
```bash
docker compose up -d threads-browser-worker
```

### ボリュームマウントと永続化
- `./services/threads-browser-worker/sessions:/app/sessions`: ホスト上のセッションプロファイルを保持し、コンテナ再起動後もログイン状態が維持されます。
- `./services/threads-browser-worker/diagnostics:/app/diagnostics`: 障害発生時のスクリーンショットと診断ログをホスト側で確認可能。

### SNS Studio（Postiz）とのコンテナ間通信設定
同一 Docker ネットワーク（`postiz-network`）内で自動疎通します。

```env
THREADS_PUBLISH_TRANSPORT=browser
THREADS_BROWSER_SERVICE_URL=http://threads-browser-worker:8017
THREADS_BROWSER_SERVICE_KEY=secret-key
```

※ `THREADS_PUBLISH_TRANSPORT=official_api`（または未指定）に設定すると、既存のMeta公式API経由での投稿動作が100%維持されます。
