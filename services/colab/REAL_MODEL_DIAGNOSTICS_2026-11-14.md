# Real model diagnostics, 2026-11-14

Two bounded actual model runs succeeded. This is **not** a real Drive/SNS Studio E2E pass: organization Google OAuth client configuration, token and selected private folder were absent, the live Drive provider was mocked, and 4017 was not updated. No secrets, weights or video bytes are committed. Full private evidence and clips are retained locally; the hashes below identify the clips.

## Reproducibility

Both successful runs used adapter source `79e1e5699666293d4cd42eca242677ebd9f4e425`, retrieved from this public repository at that immutable commit with five verified file hashes. The manual deterministic runner bundle SHA-256 was `0c58aa2498c2e486b5a88e5b871fcac81bd96b029cdf6b5fd89fd31df42ec25d`.

Existing Colab runtime 2026.01: Python 3.12.12, Tesla T4 (SM 7.5), total VRAM 14.563 GiB, free VRAM 14.361 GiB, free CPU RAM about 47 GiB and free disk about 199.94 GiB before model download. A dedicated venv was used; the base kernel, Windows and live services were not modified.

Verified versions: PyTorch 2.6.0+cu124 / CUDA 12.4, torchvision 0.21.0, Diffusers 0.35.1, Transformers 4.51.3, Accelerate 1.6.0, huggingface-hub 0.34.4, safetensors 0.5.3, sentencepiece 0.2.0, Pillow 11.2.1, imageio 2.37.0, imageio-ffmpeg 0.6.0, ftfy 6.3.1 and psutil 7.0.0. Dedicated-venv package consistency and adapter version checks passed.

Only one child ran at a time, each with a finite 1,800-second timeout, seed 0, 30 steps, one output and `mock=false`. No paid API, purchase, new subscription, keep-alive or automatic inference retry was used. These two diagnostic IDs were not backend/Drive job IDs.

## Measured results

| Field | T2V retest | I2V |
| --- | --- | --- |
| Diagnostic ID | `bmode-real-t2v-20261114-a2` | `bmode-real-i2v-20261114-a1` |
| Repository | `Wan-AI/Wan2.1-T2V-1.3B-Diffusers` | `Lightricks/LTX-Video-0.9.1` |
| Revision | `0fad780a534b6463e45facd96134c9f345acfa5b` | `0dfb9a9b26f48256bbafc4e9fa337445ff76dc1c` |
| Pipeline | `WanPipeline` | `LTXImageToVideoPipeline` |
| Model license | Apache-2.0 | LTX Video 0.9.1 RAIL-M, 2024-11-22 |
| Dtype / VAE dtype | FP16 / FP32 | FP16 / FP16 |
| Offload | sequential CPU | sequential CPU |
| Max sequence length | 512 | 128 |
| Requested duration | 2 seconds | 2 seconds |
| Actual output | 480 × 848, 33 frames, 16 fps, 2.063 seconds | 480 × 480, 49 frames, 25 fps, 1.96 seconds |
| H.264 MP4 bytes | 41,015 | 49,716 |
| Child wall time | 601.87 seconds | 223.59 seconds |
| Adapter execution time | 599.406 seconds | 220.294 seconds |
| Pipeline inference time | 520.839 seconds | 79.821 seconds |
| Peak allocated GPU bytes | 4,216,463,360 | 1,173,506,048 |
| Peak reserved GPU bytes | 6,306,136,064 | 1,539,309,568 |
| Real inference / mock | true / false | true / false |
| Input image actually used | not applicable | true; decoded RGB image passed to I2V pipeline |
| ffprobe / all-frame decode | PASS | PASS |
| Audio | silent, not generated | silent, not generated |

T2V output SHA-256: `b2a414920301b42d9c22a8e74128eab1dc7fadbd9e6b2428c9da5be7b0ba02c2`.

I2V output SHA-256: `eae08785495d25d0a63f914aa81860de045ad19b6b2c77860a43ae239d61f43b`.

I2V used an original 640 × 640 PNG sailboat drawing created in the diagnostic job directory. Input SHA-256: `276ae844fd76e520668601df9b8609747d2b245bdba757ae1bfc5614ebcd0590`. It matched the adapter evidence and `inputImageUsed=true`; this was not a T2V fallback. This local diagnostic does not demonstrate Windows/current-org image transfer through real Drive.

Chrome displayed both outputs. First/middle/last contact sheets and frame differences were retained for visual assessment. T2V depicts the requested ceramic mug and a slow camera movement; I2V retains the drawn sailboat and changes the water/boat over time. These short low-resolution samples do not establish production quality or support for other settings/models. No fabricated audio was added.

## Earlier failed attempt

`bmode-real-t2v-20261114-a1` failed with actual T4 OOM after 163.87 seconds. Peak allocated GPU memory was 13,379,449,856 bytes and peak reserved was 13,753,122,816 bytes. The prior dtype probe included BF16 emulation and the policy used whole-model offload. No video/mock success was returned. The fix requires native BF16 support and uses sequential CPU offload on sub-20-GiB GPUs. The separate successful `a2` attempt above measures that fix; the failure is not removed from the record.

## Remaining gates

- Real Google OAuth client configuration, user consent and a selected private Drive folder for the SNS Studio organization.
- Real job/attempt/owned-image transfer, Drive output/result write, backend sync and repeat sync.
- Actual SNS Studio preview, durable human approval and unsaved common-publisher handoff using those real Drive jobs.
- Separately approved App/Media Worker image switch on 4017 after isolated candidate validation, retaining all safety mounts and original held records.
- GitHub Actions execution: manual dispatch returned HTTP 422 because Actions is disabled for the repository. Local test success is not GitHub CI success.

CPU/DB/browser fixtures must be reported separately from these actual model diagnostics and from the unverified real Drive chain. Keep PR #27 Draft and do not merge.
