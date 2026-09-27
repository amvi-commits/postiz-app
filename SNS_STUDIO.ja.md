# SNS Studio V1（Windowsローカル版）

SNS StudioはPostizに追加した、Windows上で使うInstagram制作・即時投稿ワークスペースです。Postiz既存のProviderとライセンス表示は維持しています。Instagramへのログインと投稿は、独立したPython `instagrapi` Workerが処理し、Meta Graph APIは使用しません。

## Windowsで起動する

1. Docker Desktopをインストールして起動し、このリポジトリでPowerShellを開きます。
2. `.env.example` を `.env` にコピーします。`.env` は共有しないでください。起動前に `SNS_STUDIO_SERVICE_TOKEN` を十分に長いランダム値へ変更します。Google DriveとOpenAIの設定は、機能を使う時点まで省略できます。
3. ローカル一式を起動します。

   ```powershell
   docker compose up -d --build
   docker compose ps
   ```

   初回はPostizと2つのWorkerをビルドし、CPU版VOICEVOXイメージを取得します。既存のPostgres、Redis、Temporal、PostizサービスはComposeに残しています。Postiz起動時にSNS Studioの追加スキーマを適用します。
4. [http://localhost:4007](http://localhost:4007) を開き、ローカルPostizユーザーを作成して、ナビゲーションの **SNS Studio** を開きます。

Postiz画面は `127.0.0.1:4007` のみで待ち受けます。通常の `docker-compose.yaml` はWorkerのポートをホストへ公開しません。`docker-compose.dev.yaml` は開発用で、Workerのポートをloopbackに限って公開します。

## Google Driveを接続する

外部Google認証なしでローカル検証する場合は `.env` で `SNS_STUDIO_GOOGLE_DRIVE_MOCK=true` にします。Drive一覧と同期対象は `uploads/sns-studio/mock-drive/inbox/`、Colab Jobと結果は同じ `mock-drive` の `jobs/`・`results/` に保存します。モックを使う間はGoogle OAuthへ接続しません。既定値は `false` です。

1. Google Cloud ConsoleでGoogle Drive APIを有効化し、Web application型のOAuthクライアントを作成します。
2. 次のURIを、クライアントの承認済みリダイレクトURIへ正確に登録します。

   `http://localhost:4007/api/sns-studio/drive/callback`

3. `.env` に `GOOGLE_DRIVE_CLIENT_ID`、`GOOGLE_DRIVE_CLIENT_SECRET`、同じ `GOOGLE_DRIVE_REDIRECT_URI` を設定し、Postizサービスを再作成します。

   ```powershell
   docker compose up -d --force-recreate postiz
   ```

4. SNS Studio → SettingsでGoogle Driveを接続し、フォルダを選んで同期します。

アプリは選択フォルダを一覧し、そこへGeneration Jobや結果を書き込むため、Google Driveの `drive` scopeを要求します。これはDrive全体への広い読み書き権限です。許可する前に[Googleの現在のscope説明](https://developers.google.com/workspace/drive/api/guides/api-specific-auth)を確認してください。

OAuthトークンは `sns-studio-data` Docker volume内で暗号化されます。`GOOGLE_DRIVE_TOKEN_KEY` を指定しない場合、初回に同volume内へ鍵を作成します。Instagram Workerも `IG_CREDENTIALS_KEY` を指定しない場合、`sns-instagram-data` volume内に鍵を作成します。暗号化データと対応する鍵を一緒にバックアップしてください。鍵を失うと保存済みセッションを復号できません。

## Instagramを接続する

SNS Studio → Accountsで、自分が所有または管理するInstagramアカウントへログインします。パスワードとセッションはWorkerの永続領域で暗号化し、Postgresのアカウント行には保存しません。必要ならアカウント専用の固定HTTP(S)/SOCKS5 Proxyを設定して、ログイン前に接続テストを行います。

Instagramが2FAやchallengeを求めた場合、アカウントは **NEEDS_USER_ACTION** になります。UIから本人確認を完了し、セッションを再検証してください。WorkerはProxyローテーション、challenge回避、投稿の自動再送を行いません。`instagrapi` が使う非公開Instagram APIは変更される可能性があります。初回投稿後はInstagramアプリ側でも投稿とStory Link Stickerの表示を確認してください。

## 制作して投稿する

1. 選択したDriveフォルダをContent Inboxへ同期します。
2. InboxからRecipeを選んで実行するか、Create画面で動画加工・結合・漫画スライドを作ります。
3. Queueの進捗を確認します。完成した動画/画像をPreviewし、承認します。
4. 承認済み結果をCreateへ読み込み、Instagramアカウントを選び、CaptionやStory URL/Stickerを確認・編集して **Preflight and publish now** を押します。

投稿は即時です。SNS Studio V1には予約、カレンダー、PC停止中の投稿、一括投稿はありません。投稿に失敗した場合は履歴へ保存し、同じ完成素材を人が手動で再送できます。PreflightはSessionとメディアの状態を確認してからInstagram Workerを呼びます。

漫画スライドではSettings → Voice PresetsにVOICEVOX speaker/style IDを登録します。利用する声の利用条件とクレジット表記の要否を確認してから投稿してください。

## 任意機能

- **AI Caption:** `.env` の `OPENAI_API_KEY` を設定すると、アカウント設定に応じたCaption候補を作れます。候補は編集可能で、ユーザーの操作なしに投稿されません。
- **Colab生成:** `services/colab/sns_studio_worker.ipynb` はDriveを使うGeneration Job Queueのサンプルです。モデル固有Adapterはまだ決まっていません。Colab環境に `sns_studio_model_adapter.generate(job, output_dir)` を実装し、生成ファイルと結果manifestをJobフォルダへ書き込みます。
- **保持期間:** Settingsで完成動画を7日、30日、または無期限で保持できます。元素材とDB/投稿履歴は残します。Cleanup対象はSNS Studioのrenderフォルダ内で投稿成功済みの完成動画だけです。

## ローカル動作確認

`docker compose up` の後、リポジトリ直下で実行します。

```powershell
.\scripts\sns-studio-smoke.ps1
```

Composeサービス、Postgres、Redis、Instagram/Media Workerのhealth endpoint、ローカルUIを確認します。Instagramへのログインやテスト投稿は行いません。

Google DriveモックのGeneration Jobを往復確認するには、SettingsでJobを登録し、Postgresから最新Job IDを取得して `scripts/sns-studio-mock-colab.py` をMedia Worker内で実行した後、**結果を同期**します。このスクリプトはInboxのローカル素材を結果としてコピーし、Googleへ接続しません。

## データと制限

- ローカルデータはDocker volume（`postgres-volume`、`postiz-uploads`、`sns-studio-data`、`sns-instagram-data`など）に保存されます。schemaやvolumeの変更前にバックアップしてください。volumeを削除する場合以外は `docker compose down -v` を実行しないでください。
- このブランチはPostiz commit `374fb202334a4b6db183f2e44c52c83a9db58a8b` を基にし、AGPL-3.0の表示を保持しています。改変版を再配布する場合はライセンス条件を確認してください。
- `SNS_STUDIO_INSTAGRAM_MOCK=true` は認証情報なしでInstagram Workerのログイン・投稿・Analytics経路を試すローカル専用モードです。既定値は `false` で、実アカウントには接続しません。
- Instagram本人認証、Google OAuth、モデル固有Colab生成にはユーザー自身のアカウントや設定が必要です。
