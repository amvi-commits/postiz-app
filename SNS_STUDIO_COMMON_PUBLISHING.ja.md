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

実装済み。

- `SnsMediaAsset` からPostiz投稿用Mediaへ変換 / 登録する共通adapterを追加
- Content Inboxから「共通投稿で使用」を1クリックで起動
- `SnsMediaAsset.metadata.postizMediaId` で同じbridgeを再利用
- local storageでは元ファイルを複製せず公開URLをMediaへ登録
- cloud storageではPostiz Storageへ1回だけstream転送
- 共通投稿モーダルをprefill可能にし、Mediaを直接引き継ぐ

注意: Instagram / Threadsなど外部側がURLを取得するproviderでは、local storageの`FRONTEND_URL`がインターネットから到達できる必要がある。公開URLが必要な本番運用ではCloudflare等の外部Storageを推奨する。

### Phase 3 — 共通コンテンツ / 配信バリエーション

実装済み。

データ構造:

```text
SnsContent
  ├─ originalAsset
  ├─ commonContent / commonHashtags / commonScheduledAt
  ├─ SnsContentVariant[]
  │    └─ mediaAsset
  ├─ SnsContentPlatformOverride[]
  │    └─ Instagram / TikTok / YouTube / Threads / X
  └─ SnsDelivery[]
       ├─ integrationId
       ├─ providerIdentifier
       ├─ variantId
       ├─ account override
       ├─ resolvedContent / resolvedHashtags / resolvedScheduledAt
       ├─ provider settings snapshot
       └─ Postiz postId / status
```

実装内容:

- 共通コンテンツをSNS Studio側の正本として保存
- 元素材と加工Variantを別レコードで参照し、SNSごとのファイル複製をしない
- Variant Generatorの複数結果を1つの共通コンテンツとしてPublishへ渡せる
- 配信アカウントごとに使用Variantを選択可能
- 保存済み配信計画をPublish画面から再読込可能
- Postizへ作成済みの計画は重複投稿防止のため再編集を禁止
- Postiz投稿作成後にpostIdと最終本文をSnsDeliveryへ記録
- ユーザー指定のSNS／アカウント上書きは `settingsOverride` に保持し、投稿後も変更しない
- 投稿時に確定したprovider設定は `providerSettingsSnapshot` に別保存
- Phase 3 migration は4つの共通計画テーブルと参照・indexを追加するだけのPostgreSQL SQL。Postiz `Post`、Instagram系テーブル、`SnsPublishRecord` は変更しない
- Migration SQLは初回作成と、開発DBで既に `db push` 済みの場合の再適用を考慮し、CREATE／index／FK作成を存在確認付きにする

Postiz `Post` は投稿実行の正本、SNS Studio `SnsContent / SnsDelivery` はコンテンツと配信計画・紐付けの正本とする。

### Phase 4 — 階層上書き

本文・ハッシュタグ・投稿日時について実装済み。

優先順位:

```text
account override
  > SNS override
    > common default
```

実装済み対象:

- caption / body
- hashtags
- scheduledAt
- media variant（アカウント単位）
- SNS固有設定は既存Postiz provider UIで最終設定し、実際に送ったsettingsをSnsDeliveryへ保存

投稿時刻はPostizの既存投稿サービスを変更せず、実効日時の異なる配信先だけ既存 `/posts` scheduleリクエストへ日時単位で分割するadapterを投稿UI側へ追加した。

共通日時が未指定でアカウント/SNSだけ日時指定される場合も、未指定先はPostizの既存free slotを利用し、指定先だけ個別日時で作成する。

未実装でPhase 5へ送るもの:

- autoPost
- approval policy
- アカウント別投稿上限
- 同一コンテンツ再投稿禁止期間
- SNS固有settingsの「SNS共通プリセット → アカウント上書き」UI（provider個別設定自体は既存UIで利用可能）

### Phase 5 — 配信ポリシー

共通のaccount policyとして実装し、SNS固有画面へ重複させない。

保存先と既定値:

- 既存のorganization-scoped `SnsAppSetting`を利用し、`sns:common:account-policy:v1:<integrationId>`の専用namespaceへ保存する。
- `Integration.additionalSettings`はSNS provider固有設定なので、Common Policyには使わない。
- 共通既定値は`autoPostEnabled=true`、`approvalRequired=false`、`maxPostsPerDay=null`（上限なし）、`sameContentCooldownDays=0`（無効）。
- `maxPostsPerDay`は直近24時間のPostiz `QUEUE` / `PUBLISHED`投稿数で評価する。
- cooldownは同じ`SnsMediaAsset` IDを共有するコンテンツと配信先の既存Post履歴で評価する。元素材IDがない場合は選択variantのmediaAssetIdを使う。類似度推定はしない。
- 承認時刻は`SnsDelivery.approvedAt`へ保存する。Phase 5 migrationはこのnullable列を追加するだけで、既存status、ユーザー指定settings、snapshotは変更しない。
- TikTok側の既存初期値（maxPostsPerDay 2 / sameContentCooldownDays 30）と既存`SnsAppSetting`キーはprovider-specific guardに属する。Common branchへTikTok実装はmergeせず、将来adapterへ接続する際にCommon Policyを正本にし、provider guardにはAPI固有の最終検査だけを残す。

判定と投稿接続:

- `GET/PUT /sns-studio/common/account-policies`でorganization内IntegrationごとのPolicyをread/writeする。
- `GET/POST /sns-studio/common/content-plans/:id/policy...`でDelivery単位に承認要否、上限、cooldownを判定する。
- `approvalRequired=true`または`autoPostEnabled=false`の場合、draftは許可し、now/scheduleは`SnsDelivery.approvedAt`がないと拒否する。
- Common Publish UIはPostiz投稿直前にpreflightし、`PostsController`もCommon plan ID付き投稿をserver-sideで再検査する。
- 投稿上限/cooldownは承認で解除されない。
- 決定は`allowed` / `approval_required` / `blocked`と理由コード・利用者向け説明を返す。

他SNSにも同じpolicy frameworkを再利用する。SNS固有API限界やprovider-specific validationはprovider guardの責務とする。

### Phase 6 — 履歴 / Queue / Analytics統合

実装内容:

- `SnsDelivery`を共通Queue / History / Analyticsの一覧SSOTとし、`postId`からPostiz `Post`を参照する。Postizの投稿作成・予約・workflowは変更しない。
- `GET /sns-studio/common/queue`, `/history`, `/analytics`, `/analytics/:deliveryId`を追加。全検索でDeliveryのContentとPostを現在のorganizationに限定し、platform / account / content / state / 本文検索をサポートする。
- QueueにはDelivery、Content、選択Variant、platform、account、共通状態、実効投稿日時、approval、Policy判定、Postiz link、失敗情報を表示する。
- HistoryにはPostiz `postId`、Provider `releaseId` / URL、投稿に使った最終本文、Variant、結果、時刻、エラー、`settingsOverride`と`providerSettingsSnapshot`を別項目として表示する。投稿結果を複製する履歴テーブルは作らない。
- 共通状態は`planned` / `draft` / `queued` / `scheduled` / `published` / `uploaded` / `failed` / `link_missing`へ変換する。投稿済みPostが見つからない場合は正常な公開済みとして扱わない。
- TikTok / TikTok BusinessのUPLOADはProvider Adapterが受信箱へのアップロード状態として返し、公開済みには数えない。SNS固有の状態判定をCommon schemaへ追加していない。
- AnalyticsはPostiz `PostsService.checkPostAnalytics`を使い、likes / comments / shares / views / reach / impressions / saves / clicksを共通化する。取得できない指標は`null`、未知の指標はProvider詳細に残す。未投稿、受信箱UPLOAD、Provider ID欠落、削除済みPostは取得不可として扱う。
- SNS Studio共通メニューにQueue / History / Analyticsを追加し、既存の制作QueueとInstagram Analyticsは区別して維持する。
- 失敗情報はCommon Historyで確認する。再試行処理はPostiz / Temporalの既存実行責務に残し、Common側から独自投稿jobや再送ボタンを作らない。これにより部分成功したdeliveryの二重投稿を避ける。
- Phase 6ではschema / migrationの変更なし。

#### 配信ステータス設計（Status Semantics: COMMON_DELIVERY_QUEUED_BY_DESIGN）

共通投稿基盤における各状態の責務とステータス導出ルール：

1. **実行状態のSSOT（Single Source of Truth）**:
   - Postiz `Post.state`（`QUEUE` / `PUBLISHED` / `ERROR`）が投稿実行の唯一のSSOTである。Temporalワークフローが非同期に進行・完了を更新する。
2. **配信計画・投入時の物理状態**:
   - `SnsDelivery.status` はSNS StudioからPostizへ投稿・予約投入した時点の物理状態（`QUEUED` / `SCHEDULED` / `POSTIZ_DRAFT` / `PLANNED` 等）を保持する列であり、Postiz側の実行完了（PUBLISHED等）をwrite-backしてmirrorするものではない。
   - 同様に `SnsContent.status` もコンテンツ計画全体の投入状態（`DRAFT` / `READY` / `POSTIZ_DRAFT` / `QUEUED` / `SCHEDULED` 等）であり、Postiz完了を追跡するものではない。
3. **導出される実効状態（UI・API利用者向け）**:
   - `CommonDeliveryView.status`（APIレスポンスの `status`）は、`CommonDeliveryViewService.stateFor()` により、Postiz `Post.state` ＋ Provider Publication Detail（UPLOAD判定等）＋ Delivery情報から動的に導出される。
   - 画面表示（CommonDeliveryWorkspace等）は常にこの導出 `status` を表示ラベルに使用する。
4. **診断・監査用フィールド**:
   - APIレスポンスの `deliveryStatus` は、DB上の `SnsDelivery.status` 物理値をそのまま返却するフィールドであり、トラブルシューティングや監査・トレーサビリティの診断情報として提供される。
5. **整合性評価（COMMON_DELIVERY_QUEUED_BY_DESIGN）**:
   - 投稿完了時に観測される：
     ```text
     Post.state = PUBLISHED
     Common History.status = published
     SnsDelivery.status = QUEUED
     deliveryStatus = QUEUED
     Common Queue = 0
     ```
     はギャップや不具合ではなく、**設計通りの正常な振る舞い（COMMON_DELIVERY_QUEUED_BY_DESIGN）**である。
6. **Queue / History の判定基準**:
   - Queue / History の一覧分類は、動的に導出された `status` を基準に行われる。
   - `queued` / `scheduled` / `draft` / `planned` はQueueに含まれ、`published` / `uploaded` / `failed` / `link_missing` はHistoryに含まれる。
   - `SnsDelivery.status` 物理値では分類しないため、Postiz側で `PUBLISHED` となった配信は自動的にQueueから除外され（Queue = 0）、History側で `status = published` として表示される。
7. **全SNS共通設計**:
   - 本設計はTikTok固有の特殊仕様ではなく、全SNS（Instagram, TikTok, YouTube, Threads, X）共通のアーキテクチャである。
   - Postiz / Temporal 実行基盤との疎結合を保ち、GET時の副作用（Read-Time Lazy Sync / DB更新）や、Postiz/Temporal側からSNS Studioへの逆方向依存、ポーリング用バックグラウンドリコンサイラー等の不要な複雑性を排除している。

Phase 5/6のAccount Policyと配信一覧は共通基盤で管理し、provider-specific validation、analytics詳細、UPLOAD / public publishの判定だけをadapterへ委譲する。

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

Phase 1〜6まで実装済み。Phase 5の共通配信ポリシーでは既存`SnsAppSetting`のCommon namespaceと`SnsDelivery.approvedAt`を利用し、SNS固有policyをCommon schemaへコピーしない。Phase 6は既存`SnsDelivery` / Postiz `Post`を利用し、queue用modelやAnalytics用metrics列を追加しない。
