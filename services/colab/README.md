# SNS Studio AI Video Generation - Colab Worker & Model Adapter

Google Colab を用いて非同期で動画生成ジョブを実行するワーカーおよびモデルアダプターの構成です。

## 概要

SNS Studio から投入された動画生成ジョブ（Text-to-Video / Image-to-Video）は、Google Drive 経由で共有され、Colab 上で動作するワーカーによって実行されます。

- **ジョブ管理**: SNS Studio (NestJS Backend) ↔ Google Drive Job Queue
- **推論実行**: Google Colab (T4 / A100 / L4 GPU) ↔ `sns_studio_worker.ipynb`
- **モデル制御**: `sns_studio_model_adapter.py` (`generate(job: dict, output_dir: str) -> list[str]`)

---

## ハードウェア要件

- **推奨環境**: Google Colab Pro / Pro+ (A100 または L4 GPU, VRAM >= 12GB)
- **フェイルクローズド防護**:
  - CUDA GPU が存在しない環境や VRAM が不足している環境では、`RuntimeError("BLOCKED_BY_GPU: ...")` により処理を即座に安全停止（fail-closed）します。
  - Windows ローカル環境（AMD Radeon 内蔵GPU等）への過負荷やクラッシュを防止します。

---

## サポートモデル

| モデル名 | モード | 説明 | 推奨解像度 |
|---|---|---|---|
| `wan-2.1-t2v-1.3b` | Text-to-Video | Wan2.1 1.3B 軽量動画生成モデル | 480p / 720p, 3〜5秒 |
| `wan-2.1-i2v-1.3b` | Image-to-Video | Wan2.1 1.3B 画像駆動動画生成モデル | 480p / 720p, 3〜5秒 |
| `ltx-video-0.9.1` | T2V / I2V | Lightricks LTX-Video 高速拡散モデル | 720p, 5〜8秒 |

---

## セットアップ手順 (Google Colab)

1. **ノートブックの読み込み**:
   - `services/colab/sns_studio_worker.ipynb` を Google Colab にアップロードします。
2. **モデルアダプターの配置**:
   - `services/colab/sns_studio_model_adapter.py` を Colab のカレントディレクトリに配置します。
3. **Google Drive フォルダIDの設定**:
   - ノートブック内の `ROOT_FOLDER_ID = 'PASTE_THE_SELECTED_SNS_STUDIO_FOLDER_ID_HERE'` に、SNS Studio の Settings で連携した Google Drive フォルダの ID を貼り付けます。
4. **必要なライブラリのインストール**:
   ```bash
   pip install torch diffusers transformers sentencepiece accelerate torchvision
   ```
5. **ワーカー実行**:
   - ノートブックの全セルを実行します。定期的に Google Drive をポーリングし、ジョブを受信すると自動生成して結果をアップロードします。
