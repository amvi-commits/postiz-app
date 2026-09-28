# SNS Studio 共通投稿・配信基盤

## 目的

SNS Studioの制作機能とPostizの投稿エンジンを役割分担し、Instagram / TikTok / YouTube / Threads / Xなどへ共通の投稿作成フローから配信できるようにする。

基本構成:

```text
SNS Studio UI
  ├─ 共通素材・加工・AI制作
  └─ 共通投稿・配信
        ↓
SNS Studio / Postiz shared backend
        ↓
Postiz posts + provider + workflow
        ↓
各SNS API
```

SNS StudioのUI上ではPostizを意識させない。Postizに既に存在する投稿・予約・SNS provider機能は再実装しない。

## 現状調査

### 1. 既存の共通機能

Postiz本体に既に存在し、そのまま再利用する。

- `new-launch` の共通投稿作成UI
- 接続済みIntegrationの複数選択
- 共通本文 / メディア
- integration単位の本文 / メディア上書き
- provider固有設定
- provider固有プレビュー
- 投稿前サーバー検証 `/posts/valid`
- 下書き `type=draft`
- 即時投稿 `type=now`
- 予約投稿 `type=schedule`
- 投稿カレンダー
- Post / Integration / provider / Temporal workflow
- 投稿履歴・状態管理
- 既存Media uploader / library

既存 `useLaunchStore` は、`global` を共通値、`internal` をintegration別上書きとして持つため、今回の「共通値を継承し、必要な配信先だけ上書き」という考え方と一致している。

### 2. Instagram側にあるが共通化する機能

`feature/sns-studio-v1` の以下はInstagram専用として複製せず、SNS Studio共通制作機能として維持する。

- `services/media-worker`
  - trim
  - crop
  - aspect / output size
  - playback speed
  - subtitles
  - text overlay
  - source audio / BGM
  - concat
  - variant generation
  - comic render
- `SnsMediaAsset`
- `SnsContentInboxItem`
- `SnsEditingPreset`
- `SnsVariantPreset`
- Google Drive import / generation job
- 制作pipeline / approval前の制作工程

media-worker自体はFFmpeg中心でInstagram APIに依存していないため、名称上・責務上も「共通加工エンジン」として扱う。

### 3. Postizですでに利用可能なSNS固有機能

共通投稿UI内で既存provider設定をそのまま利用する。

- Instagram
  - Post / Reel / Story
  - collaborators
  - audio
  - Trial Reel
- TikTok
  - 通常TikTok
  - TikTok Business
  - 公開範囲
  - Direct Post / Upload
  - comments
  - Duet
  - Stitch
  - AI生成コンテンツ
  - disclosure
  - Business music / location
- YouTube
  - title
  - visibility
  - made for kids
  - tags
  - thumbnail
- Threads
- X

SNS固有パラメータはproviderコンポーネントとprovider DTO / backend providerを正本にし、SNS Studio側へコピーしない。

### 4. 新規実装が必要な機能

- SNS Studio加工済み素材 → Postiz投稿メディアへの安全な受け渡し
- 共通コンテンツIDとPostiz投稿groupの紐付け
- 共通コンテンツ → 加工バリエーション → 配信バリエーションの明示的なデータモデル
- 投稿文 / ハッシュタグの階層上書き
  - 共通
  - SNS
  - アカウント
- 投稿時刻の階層上書き
  - 共通
  - SNS
  - アカウント
- 承認状態と自動投稿ON/OFFの共通ポリシー
- アカウント単位の投稿上限
- 同一コンテンツ再投稿禁止期間
- 共通投稿キュー表示
- Postiz投稿状態をSNS Studio履歴へ集約
- 共通Analyticsへのリンク
- 失敗時の再試行UI統合

## 移行方針

現在のSNS Studio V1にはInstagram Workerへ直接投稿する `/sns-studio/publish/reel` と `/sns-studio/publish/story` がある。

これは既存Instagram機能を壊さないため当面残すが、新しい共通投稿フローでは使用しない。

新規配信は原則:

```text
SNS Studio common publisher
→ /posts/valid
→ /posts
→ PostsService
→ SocialProvider
→ Temporal workflow
→ SNS
```

へ統一する。

Instagram direct worker経路は、Postiz provider経路で必要機能をすべて確認した後に段階的にlegacy化・削除判断する。

## 実装フェーズ

### Phase 1 — 共通投稿入口

- SNS Studioに `Publish` タブを追加
- `/integrations/list` の接続済みアカウントを利用
- 既存 `NewPost` / `AddEditModal` / `ManageModal` を再利用
- 複数SNS・複数アカウント、provider固有設定、draft / now / scheduleをそのまま利用
- 既存Instagram direct publishは変更しない

### Phase 2 — 素材ブリッジ

- `SnsMediaAsset` からPostiz投稿用Mediaへ変換 / 登録する共通adapterを追加
- 加工結果から「共通投稿で使用」を1クリックで起動
- 元素材は複製せず参照関係を保持
- Postiz providerが外部取得可能なURLを必ず利用

### Phase 3 — 共通コンテンツ / 配信バリエーション

推奨構造:

```text
SnsContent
  ├─ originalAsset
  ├─ SnsContentVariant[]
  │    └─ mediaAsset
  └─ SnsDelivery[]
       ├─ integrationId
       ├─ providerIdentifier
       ├─ postGroup
       ├─ copyOverride
       ├─ hashtagsOverride
       ├─ settingsOverride
       └─ scheduledAtOverride
```

Postiz `Post` を投稿実行の正本、SNS Studio側はコンテンツと配信計画の正本にする。

### Phase 4 — 階層上書き

優先順位:

```text
account override
  > SNS override
    > common default
```

対象:

- caption / body
- hashtags
- scheduledAt
- autoPost
- approval policy
- platform settings

現在のPostizは本文・メディアについてglobal → integration overrideを既に持つため、その仕組みを拡張する。

投稿時刻は現状body単位で1つのため、異なる実効時刻になった配信先を同一画面から複数の既存 `/posts` scheduleリクエストへ分割するadapterを追加する。Postizの投稿サービス自体は変更しない。

### Phase 5 — 配信ポリシー

共通のaccount policyとして実装し、SNS固有画面へ重複させない。

TikTok初期値:

- maxPostsPerDay: 2
- configurable per account
- autoPostEnabled: account override
- sameContentCooldownDays: 30

他SNSにも同じpolicy frameworkを再利用できるようにする。

### Phase 6 — 履歴 / Queue / Analytics統合

- Postiz Post stateをSNS Studioで集約表示
- DRAFT / QUEUE / PUBLISHED / ERRORを共通表示
- providerごとのエラーを共通retry UIへ統合
- SNS Studio独自PublishRecordはlegacy Instagram経路だけに限定
- 新規共通配信はPostiz Post / groupを参照
- Analyticsは共通ダッシュボードからSNS別詳細へ遷移

## 非目標

- SNSごとに同じ投稿UIを作る
- TikTok / YouTube Shorts用に別の動画加工エンジンを作る
- Postizのprovider処理をSNS Studio backendへコピーする
- 一度に既存Instagram direct publishを削除する
- Postiz Post / Integrationを置き換える

## Phase 1 実装状況

`feature/sns-studio-common-publishing` で以下を実装済み。

- `apps/frontend/src/components/sns-studio/common-publisher.tsx`
- SNS Studio `Publish` タブ
- 接続済み Instagram / TikTok / TikTok Business / YouTube / Threads / X の抽出
- 既存Postiz共通投稿モーダルの再利用

次の実装対象はPhase 2の「SNS Studio加工済み素材 → 共通投稿」ブリッジ。
