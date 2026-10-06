# Instagram Story Link外観調査 — 2026-10-04

## 結論と判定範囲

**分類D: Native Link Stickerの外観を生成する有効な送信契約は未特定。**

確認した3.0.14の通常経路はクリック領域のmetadataを送るだけで、図形や文字を描画しない。`StorySticker(story_link=StoryStickerLink(...))`へ置き換えても、そのnested fieldはconfigureで参照されず、URLまで送信payloadから落ちる。A（既存版の不足fieldを補えばNative表示できる）、B（新版への更新で解決）は確認できなかった。

ただし、Instagram private API全体でNative外観の生成が不可能と証明したわけではない。どの追加field・assetが必要か、サーバーがどの契約で外観を生成するかは不明なので、分類Cの「private API経由で安定生成できない」まで断定しない。

現在公開済みのStoryは動画とリンク操作が成功し、公式モバイルアプリでも通常時の図形・URLラベルが透明であることをユーザーが確認済み。判定は **functional PASS / visual FAIL / 総合E2E FAIL** のまま。

今回は追加Story/Reel投稿、Instagram通信、新規Login、DB更新、ライブラリ更新、本番Worker再起動を一切行っていない。既存実投稿の承認は消費済みであり、追加投稿には新しい承認が必要。

## 正本と比較対象

- 稼働Workerから直接読み取ったinstalled version: **instagrapi 3.0.14**。
- 稼働Workerのソースはcommit `5cff4b367d98cec385728f716d72233ff2eaf8bc`のまま。
- GitHubの3.0.14 tagが指すcommit: `13ebe3b73f9a3fc2d495124c94d958d7b438e007`。
- 調査時の公式upstream master: **3.0.19 / `157eaacb9f5b2d5a4b308807b3b16fcd388d7e23`**（2026-10-03）。
- installedとupstreamの `types.py`, `mixins/video.py`, `mixins/photo.py`, `story.py` はファイルSHA256まで同一。
- `extractors.py`全体には差分があるが、`extract_story_v1`のASTは同一。

従って関連するupload/configure/Link型/StoryBuilderの更新やbackportで改善する差分は、この比較では存在しない。依存versionは変更していない。

公式ソース:

- [video configure / upload](https://github.com/subzeroid/instagrapi/blob/157eaacb9f5b2d5a4b308807b3b16fcd388d7e23/instagrapi/mixins/video.py)
- [Link / Stickerの型](https://github.com/subzeroid/instagrapi/blob/157eaacb9f5b2d5a4b308807b3b16fcd388d7e23/instagrapi/types.py)
- [StoryBuilderのメディア描画](https://github.com/subzeroid/instagrapi/blob/157eaacb9f5b2d5a4b308807b3b16fcd388d7e23/instagrapi/story.py)
- [Story取得時のextractor](https://github.com/subzeroid/instagrapi/blob/157eaacb9f5b2d5a4b308807b3b16fcd388d7e23/instagrapi/extractors.py)

## 現行Workerとライブラリの処理

1. Worker `app/main.py`が `StoryLink(webUri, x, y, width, height, rotation)`を生成。
2. videoには一時thumbnailを渡し、`video_upload_to_story(..., links=[link])`を呼ぶ。photoも同じlinks引数。
3. uploadはlinks/stickers/extra_dataをconfigureへ渡す。通常uploadはリンクの図形やラベルをメディアへ描画しない。
4. configureはlinksの先頭1件を `media/validate_reel_url/`で検証し、内部で `StorySticker(type="story_link", extra=...)`へ変換。
5. URL・位置・サイズ等をJSON文字列の `tap_models` と、文字列の `story_sticker_ids`として送る。
6. thumbnailは投稿用の静止画であり、動画全体の可視Link UIの代わりにはならない。

現行方式のLink関連payload（資格情報・device・session fieldは除外）:

```json
{
  "tap_models": [
    {
      "x": 0.5,
      "y": 0.5,
      "z": 0,
      "width": 0.51,
      "height": 0.26,
      "rotation": 0.0,
      "type": "story_link",
      "is_sticker": true,
      "selected_index": 0,
      "tap_state": 0,
      "link_type": "web",
      "url": "https://example.com/",
      "tap_state_str_id": "link_sticker_default"
    }
  ],
  "story_sticker_ids": "link_sticker_default"
}
```

実際には`tap_models`をJSON encodeして送る。図形、色、フォント、ラベル、描画assetは含まれない。透明なクリック領域という実投稿結果と一致する。サーバーの内部描画条件は見えていないため、個別field追加によるNative表示改善は未確定。

## 型とfieldの役割

| 項目 | 3.0.14でソースから確認できる動作 |
|---|---|
| StoryLink | HTTP URLと位置・サイズ・回転・z。links経路からtap metadataへ変換される |
| StoryStickerLink | url/link_title/link_type/display_urlを持つnested型。取得レスポンスのStorySticker.story_linkを表現できるが、configureはこのfieldを読まない |
| StorySticker | 汎用tap model用の位置・type・id・extra。デフォルトtypeはgifであり、リンク候補ではstory_linkを明示する必要がある |
| story_link_stickers | extract_story_v1が取得レスポンスから読み取る。通常upload/configureはこのfieldを生成しない |
| story_cta | 取得レスポンスからlinksを復元するために読み取る。通常configureは生成しない |
| story_sticker_ids | configureはIDをカンマ区切り文字列で送る。単数のsticker_idsというfieldは生成しない |
| id | 指定すればtap modelのstr_idとstory_sticker_idsに入る。画像assetを生成・uploadする処理ではない |
| type | 現行はstory_link。未指定StoryStickerはgifとなりhas_animated_stickerも設定される |
| link_title / display_url | StoryStickerLink内だけに設定しても送信されない。extraへ明示すればflat tap metadataへコピーできるがNative外観の証拠にはならない |
| link_type | 現行はextra経由でwebを送る |
| extra | 任意dictionaryをtap modelへmerge。URL、style ID等はここから送られる |
| extra_data | configureのトップレベルへ任意fieldをmergeする拡張口。未知fieldを通せることとサーバーが受け付けることは別 |
| z-order | StoryLinkは0、StoryStickerはデフォルト1000005。比較ではz=0に揃えた。zを変えても画像や文字は生成されない |
| visual asset / asset ID | 現行payloadにはない。Native用に必須か、有効なIDをどう取得するかは不明 |

## オフラインA/B比較

すべて`Client.private_request`を捕捉して戻り値へ置き換え、コンテナのnetworkをnoneに設定した。保存Session・credential volumeは接続していない。テストではsocket/request transportも禁止した。Instagramへのconfigure/URL検証は0回。

| 候補 | URL | title / display URL | tap metadata | story_link_stickers | ID / asset | 判定 |
|---|---|---|---|---|---|---|
| A: StoryLink（現在） | flat urlあり | なし | あり | なし | style ID、assetなし | 機能成功済みの現行経路。外観を描画しない |
| B: StorySticker + nested StoryStickerLink | **送信されない** | **送信されない** | 位置とtypeのみ | なし | 指定なし | 単純置換はリンク機能まで失う危険があるため採用しない |
| C: id + 明示extra | flat urlあり | flat fieldとして送れる | あり | なし | str_idあり、assetなし | serializationは可能。Native表示とサーバー受理は未確認 |
| D: extra_dataで手動field注入 | 任意JSONを通せる | 任意JSONを通せる | 自動生成なし | 注入分だけ | 未確定 | 未知のAPI契約のため本番採用しない |

videoとphotoの双方で同じ結果をunit testした。uploadからconfigureへの引数伝播も、rupload・読取・configure・sleepを全てmockして確認した。

## 2026年upstream修正との関係

- [`e4c3820`](https://github.com/subzeroid/instagrapi/commit/e4c382008433cf042138defe91141b9e60288c2e): 複数story_sticker_idsをカンマ区切りにする修正。稼働3.0.14に既に入っている。外観描画の追加ではない。
- [`4f37a4f`](https://github.com/subzeroid/instagrapi/commit/4f37a4f711d88585666d021138cbc11723fcd0d4) / [`b081936`](https://github.com/subzeroid/instagrapi/commit/b0819364a17665a16d22ea16c955141ccf3db973): configureレスポンスのmedia抽出とエラー処理の改善。Native Link外観fieldの追加ではない。
- 3.0.14と現在upstreamの関連コードが同一のため、これらを再backportしない。masterへの更新も実施しない。

## Visual fallback設計案（本番未接続）

外観を確実にメディア内へ含めるため、V1は **Visual fallbackをdefaultにする案** を推奨する。Nativeとは区別し、Native表示が検証できるまでUIでは「Native: 未対応／検証待ち」を選択不可とする。「Visual fallback: 動画内の可視ボタン＋Instagramの実リンク」と明示する。

1. Instagram固有adapterのPreflightで素材のupright寸法・9:16・URL・座標を確定する。
2. 同じx/y/width/height/rotationから描画矩形とStoryLinkを作る。座標は中心を表すものとして変換する。
3. 共有元動画をread-onlyで扱い、writable tempに「リンクを開く」＋hostnameのPNGを生成する。
4. FFmpegで派生動画にoverlayを焼き込む。フレーム先頭から表示し、音声を保持する。動画の隣にはJPEG/派生動画を作らない。
5. 派生動画をprobe/decodeし、元動画hash/sizeが不変であることを確認。派生動画からthumbnailも生成する。
6. 本番へ接続する将来の変更では、派生動画＋元と同じStoryLinkの組を1回だけuploadする。既存アカウントdefault値は上書きしない。
7. 成功・失敗・timeoutを問わずtemp動画、PNG、thumbnailをfinallyでcleanup。自動retryは加えない。
8. モードと派生素材の診断はadapter/UIの設定と既存metadataで扱う案とし、共通schemaや共通投稿モデルを変更しない。

既存メディア描画サービスのFFmpeg/日本語fontを再利用する方向とする。Instagram Workerで描画する場合は同じfont・FFmpeg供給が必要。現Workerに日本語fontはなく、今回の日本語previewのみ既存media WorkerのNoto CJK fontをread-onlyで渡した。新たな依存追加はしていない。

libraryのStoryBuilderもリンク文字を白背景へ描画して合成するが、720x1280固定、fade、durationの丸め、独自座標変換があるためそのままSNS Studioへ接続しない。

## オフライン試作と制限

- 試作は `tests/story_link_visual_fixture.py`のみ。本番appからimportされず、投稿API・Client・Loginを持たない。
- 対象素材: `/uploads/sns-studio/renders/f86fc078e2d7-sns-studio-comic.mp4`。
- URL: `https://example.com/`。
- 指定値: x=0.5 / y=0.5 / width=0.51 / height=0.26 / rotation=0。
- 1080x1920上の矩形: left=264.6 / top=710.4 / width=550.8 / height=499.2px。raster時の丸め差は最大0.5px。
- 日本語ボタンとexample.comを表示した派生動画をローカル生成し、目視・decodeを確認。派生動画111702 bytes。
- 元動画123381 bytes、SHA256 `c053dc13c61c4508e5d16dae17e058f97170ca580968c9821df026d6ccb62c02`は生成前後で不変。隣接JPEGなし。一時directoryは削除済み。
- 指定のheight=0.26は画面の約1/4を占めるため、既存文字に重なる大きなボタンとなる。指定値は変更していない。将来UIではpreviewして選べるようにする。
- 今回確認した対象はrotation=0のみ。prototypeでは角度の画面内判定を行うが、Instagramの回転方向と一致するかは本番統合前に別途確認する。
- 投稿後にInstagramが座標を微調整することがあるため、実端末でのoverlay/tapの一致は将来の承認済み実投稿で確認が必要。
- このpreviewはクリックできるInstagram StoryでもNative Stickerでもなく、ローカル動画の外観確認用。

調査資料とpreview保存先:

`C:\Users\star-\Documents\Codex\2026-09-27\referenced-chatgpt-conversation-this-is-an-2\story-link-investigation-2026-10-04`

保存した資料はinstalled/upstream source、固定commit情報、source-comparison.json、payload-comparison.json、visual-preview-result.json、PNG/MP4 preview。資格情報・Session・Cookieは含まれない。

## テストと安全確認

- Worker: **40 PASS**（既存18＋追加22）。現行/候補Link serialization、photo/video引数伝播、extra/id/z、位置・サイズ・URL、overlay座標、一時生成/正常・失敗cleanup、元動画非破壊、既存Reel回帰を含む。
- Backend targeted Jest: **1 suite / 6 PASS**。Reel/Story失敗時の1回呼出し、Organization scope、PreflightのDB記録/実publish非実行。
- Frontend用Preflight helper targeted Jest: **1 suite / 7 PASS**。preflight endpoint限定、入力エラー、Hard Error/PASS表示、publish非実行。
- Frontend typecheck: **PASS**（現行Frontend sourceをread-only mount、tsc --noEmit --incremental false）。
- 全実行はnetwork noneの一時コンテナ。稼働Workerのdata volume、DB、Sessionを接続せず実行。
- 既存のStarlette/httpx deprecation warningが1件ある。テスト失敗なし。
- 最初の描画テストはWorkerにDejaVu fontがないため3件setup error。Pillow内蔵fontを使うoffline fixtureへ修正後、全40件PASS。日本語previewにはNoto CJKを使用した。
- schema/migration/共通投稿モデル/本番Worker/投稿adapterの変更は0件。
- 追加の実Story、Reel、新規Loginは0回。公開済みStoryは既存の1件のみ。
- pushしない。stash@{0}および既存work/と無関係な変更は保持する。

## 次の作業

調査・mock段階で停止する。推奨案を採用する場合は、Instagram固有の可視fallbackを既存描画機構へ接続し、Preflight previewとNative/Visual fallbackの表示を追加する。この作業と、追加実投稿の承認は別に扱う。旧承認で再投稿しない。
