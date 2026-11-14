# SNS Studio: bounded, one-shot Colab generation

A-mode FFmpeg re-editing and B-mode real model inference are separate. A valid MP4, a passing mock test, or source value AI_RE_EDIT is not evidence of real AI generation. Candidate support below does not mean GPU E2E has passed.

## Pinned candidates and resource policy

| ID | Official repository / exact revision | Pipeline | Model constraints |
|---|---|---|---|
| wan-2.1-t2v-1.3b | Wan-AI/Wan2.1-T2V-1.3B-Diffusers @ 0fad780a534b6463e45facd96134c9f345acfa5b | WanPipeline; Wan VAE float32 | spatial multiples16; frames4k+1;16fps |
| ltx-video-0.9.1-t2v | Lightricks/LTX-Video-0.9.1 @ 0dfb9a9b26f48256bbafc4e9fa337445ff76dc1c | LTXPipeline | spatial multiples32; frames8k+1;25fps |
| ltx-video-0.9.1-i2v | same exact LTX 0.9.1 checkpoint | LTXImageToVideoPipeline | same grid; decoded org-owned reference image required |

Wan is Apache-2.0. LTX 0.9.1 uses Lightricks' **RAIL-M license dated 2024-11-22**, including use restrictions; read the pinned model license before use. Weights/licenses are not bundled or represented as our own.

Official sources:

- https://huggingface.co/Wan-AI/Wan2.1-T2V-1.3B-Diffusers/tree/0fad780a534b6463e45facd96134c9f345acfa5b
- https://huggingface.co/Lightricks/LTX-Video-0.9.1/tree/0dfb9a9b26f48256bbafc4e9fa337445ff76dc1c
- https://huggingface.co/Lightricks/LTX-Video-0.9.1/blob/0dfb9a9b26f48256bbafc4e9fa337445ff76dc1c/ltx-video-2b-v0.9.1.license.txt
- https://huggingface.co/docs/diffusers/v0.35.1/en/api/pipelines/wan
- https://huggingface.co/docs/diffusers/v0.35.1/en/api/pipelines/ltx_video
- https://developers.google.com/workspace/drive/api/guides/create-file#use_a_pre-generated_id_to_upload_files

The first validation scope is one output, integer2–4 seconds,480p model grid,1–50 steps(default30), seed0..4294967295. The API and adapter share model-contract.json. Exact adopted width/height/fps/frames/duration and adjustment reason are displayed/stored; arbitrary invalid values are rejected. Unknown models and mode mismatches fail instead of silently choosing another model. 14B and720p are outside this initial bounded scope.

Use Python3.11/3.12 and requirements-colab.txt in a dedicated Colab venv. Versions are candidate pins until an actual GPU run validates them. The adapter verifies the core installed versions before downloading weights. Do not install the GPU requirements in4017, Windows, or regular CI. Notebook preflight2026-11-14 observed a T4 with14.56GiB VRAM and, with existing high-memory runtime2026.01,50.99GiB CPU RAM/Python3.12.12. This does not guarantee availability or inference success. No new subscription/compute-unit purchase/paid API fallback.

The adapter requires CUDA, total VRAM>=12GiB, free CPU RAM>=16GiB(Wan)/12GiB(LTX), and free disk>=40GiB/25GiB. These are fail-closed preconditions, not memory guarantees. Actual dtype, VAE dtype, offload, elapsed time, peak allocated/reserved GPU memory, runtime versions and output metrics are recorded. OOM/timeouts remain failures. Outputs are silent; no fabricated audio is added.

The initial real Wan/T4 probe on2026-11-14 failed with OOM after163.87s (peak allocated13,379,449,856 bytes; reserved13,753,122,816). This is a failed attempt, not E2E success. Sub-20GiB GPUs now use sequential CPU offload, with its performance reason recorded. BF16 selection requires native SM8+ support and explicitly excludes emulation; T4 uses FP16. Oversized tokenized prompts fail rather than being silently truncated. Retest results must be recorded separately from this policy change.

The bounded real T4 retest and I2V diagnostic succeeded with the pinned environment; see [measured results and scope](REAL_MODEL_DIAGNOSTICS_2026-11-14.md). These are actual model outputs, while the real organization/Drive/SNS Studio chain remains unverified. `real_e2e_verified` therefore remains false.

## API/Drive contract

Create via POST /sns-studio/generation/jobs with an input object containing prompt, mode, modelName, durationSeconds, resolution, aspectRatio, seed and numInferenceSteps. For I2V select referenceImageAssetId from the current organization's image assets. No local path/URL, Drive token, mock string, client execution metadata or override is accepted. UI uses mock=false. seed=0 is retained.

Backend verifies ownership (cross-org404), resolves the image inside shared uploads, checks MIME/size and decodes it with sharp. It uploads unchanged bytes privately into this attempt's Drive folder. The manifest records Drive file ID, SHA-256, byte size and MIME. Colab checks membership, size/hash and image decode before passing that exact local image into I2V.

inputManifest retains user/adopted settings plus _generation metadata (attempt, inputHash, manifest/lock/control/output/result IDs). The Drive job keeps the existing input envelope, with schemaVersion2 identity outside input. Inputs are canonical JSON hashed on both sides.

Drive creates lockFileId using a Backend pre-generated ID; concurrent create(id=...) gets409. Filenames are not locks. Backend status/updatedAt CAS and a serializable import transaction prevent concurrent retries/imports and partial registrations. Each retry gets a new attempt/folder/IDs; old results, cancelled jobs and mismatched hashes/IDs are rejected. A failed manifest never permanently skips the next attempt.

Cancellation always rejects late imports; the private control file requests remote cancellation. Running GPU inference may finish before cancellation is seen. There is no claim of immediate GPU interruption or intermediate inference checkpoint resume. The child process has a finite timeout(default1800s,maximum3600s), no automatic inference retries.

If a valid completed local output survives, the same runtime can retry its interrupted upload/result write without inference. If the runtime/output is lost, explicitly retry in SNS Studio to create a new attempt. Transport failures after inference retain the local completed output; no fake COMPLETE is emitted.

## Execute one job

1. Real Google Drive OAuth and a selected private folder must already be configured for the organization. A mock Drive is not eligible for real generation. Users perform Google login/consent; never paste secrets into chat/notebook.
2. Build the minimal runner zip using build_bundle.py --output <local-evidence-directory>/sns-studio-runner-bundle.zip. Only the five fixed runner files are included, with normalized LF text, stable zip metadata and hashes. Never upload the private repository, .env, browser profiles or model weights.
3. Open sns_studio_worker.ipynb in the existing user's Colab browser. It retrieves only five public files from the fixed source commit and verifies each SHA-256 (no repository clone/token). The deterministic zip remains available for manual distribution. Choose an existing/free GPU runtime; do not purchase or upgrade.
4. Create exactly one Job in SNS Studio, then copy its full Job ID, attempt and manifest file ID from the history details into the first Notebook cell. Do not run unrelated queued jobs.
5. Run hardware preflight, isolated pinned dependency installation and checksum validation of the five source files. The Notebook records their hashes and the corresponding manual bundle hash; update source commit/file hashes together after intentional runner changes. Source download failure stops execution; do not add a token to bypass it.
6. Complete Google auth/consent yourself. Confirm the selected Job, inputs, model/revision, adopted settings and resources.
7. Execute the single-job cell once. Inspect generation-evidence.json or sanitized failure-evidence.json. ffprobe and all-frame decode, H.264 MP4, dimensions/fps/frame count, byte size and SHA are mandatory.
8. Visually inspect motion/quality/black frames/loops, and play the result fully. A technical decode pass is not a quality assessment.
9. Sync in SNS Studio, then preview the result, approve its existing production Queue record, and hand it to Common Publishing. Do not submit/publish/schedule for this validation.

Notebook outputs are intentionally empty in Git. An active Notebook is not an unlimited external backend; there is no polling/keep-alive/limit bypass.

## Import, approval and preview

Sync accepts only the current real-mode job/attempt/hash/model/revision/input-image proof and reserved result/output IDs. It independently downloads bounded bytes, checks the actual file stat/hash and calls the authenticated Media Worker for probe, frame count and all-frame decode.

One serializable transaction records SnsMediaAsset, Inbox, the existing SnsPipelineRun/steps in READY_FOR_REVIEW, and COMPLETE. A DB failure rolls the entire registration back; synchronization can be repeated. Provenance is stored in existing metadata/resultManifest. No schema or migration is introduced.

Inbox registration does not mean approved. Existing POST /queue/:id/approve persists the review step plus APPROVED/approvedAt. The generation Media Bridge checks that durable owned pipeline before even returning a cached Media ID. The UI gates pre-approval handoff. After approval, the existing POST /media-assets/:id/post-media bridge supplies a Postiz Media ID/path and prompt to the unsaved Common Publishing screen. Job/asset/Media IDs remain distinct. No Post/SnsDelivery is created by synchronization/approval.

Preview uses the existing authenticated, organization-scoped route:200/full GET,206/Range with consistent headers; other org404. Current4017 retains its safety controller bind; Backend/Worker/UI changes here require a verified normal-image candidate and **separate approval before4017 restart/recreation**. Never copy dist or remove safety mounts to force compatibility.

## Tests and deployment boundaries

CPU tests: python -m unittest -v test_model_adapter test_drive_one_shot. The test-only Dockerfile.tests contains FFmpeg/Pillow/psutil, no torch/model download; run it with network disabled. Synthetic fixture tests never count as real generation.

The dedicated generation-jobs.db-e2e.spec.ts requires BMODE_DB_E2E=1 and an empty recognized disposable DB, plus its test-only Media Worker and fixture mount. It tests org isolation, I2V byte transfer, concurrent sync/retry/cancel, failed import rollback, late results, durable approval, Bridge and real HTTP200/206/404. Its Drive/execution envelopes are explicitly simulated, not real GPU/Drive E2E.

Video Tools CPU contracts workflow uses only disposable services/fixtures. Build and secret-scan workflows expose existing checks via workflow_dispatch; supply the actual PR base SHA for the secret scan. No Draft transition or empty commits are needed. A missing workflow run is NOT SUCCESS.

Preserve the Canonical manifest, existing safety binds, auth, shared uploads, Sessions, protected reservations and rollback containers. Do not replace the Docker CLI runtime with historical Compose settings. Source/image/launcher SHA differences must be compared by actual application trees rather than strings alone.
