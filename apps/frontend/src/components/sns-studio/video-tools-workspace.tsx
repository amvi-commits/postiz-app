'use client';

import React, { useState } from 'react';
import useSWR from 'swr';
import type { CommonPublishPrefill } from './common-publisher';

const card = 'rounded-xl border border-blockSeparator bg-newBgColorInner p-5';
const field =
  'w-full rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2 text-newTextColor outline-none focus:border-[#7774ff]';
const primaryButton =
  'rounded-lg bg-[#5145ff] px-4 py-2 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50 transition';
const secondaryButton =
  'rounded-lg border border-blockSeparator px-4 py-2 font-semibold text-newTextColor hover:bg-boxFocused disabled:opacity-50 transition';
const dangerButton =
  'rounded-lg bg-red-600/80 px-4 py-2 font-semibold text-white hover:bg-red-600 disabled:opacity-50 transition';

export type SubTool =
  | 'ai-generation'
  | 'ai-re-edit'
  | 'reference-analysis'
  | 'history'
  | 'templates';

export type VideoToolsWorkspaceProps = {
  request: (path: string, init?: RequestInit) => Promise<any>;
  previewUrl: (path: string) => string;
  onNavigateToPublish: (prefill: CommonPublishPrefill) => void;
  onNavigateToQueue: () => void;
  mediaWorkerHealth?: any;
  initialSubTool?: SubTool;
};

export const VideoToolsWorkspace: React.FC<VideoToolsWorkspaceProps> = ({
  request,
  previewUrl,
  onNavigateToPublish,
  onNavigateToQueue,
  mediaWorkerHealth,
  initialSubTool = 'ai-generation',
}) => {
  const [subTool, setSubTool] = useState<SubTool>(initialSubTool);
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  // 1. AI新規生成 State
  const [genMode, setGenMode] = useState<'text-to-video' | 'image-to-video'>('text-to-video');
  const [prompt, setPrompt] = useState('');
  const [referenceImagePath, setReferenceImagePath] = useState('');
  const [selectedModel, setSelectedModel] = useState('wan-2.1-t2v-1.3b');
  const [aspectRatio, setAspectRatio] = useState('9:16');
  const [durationSeconds, setDurationSeconds] = useState(5);
  const [resolution, setResolution] = useState('720p');
  const [seed, setSeed] = useState<string>('');

  // 2. 元動画の再加工 State (Aモード)
  const [sourceVideoPath, setSourceVideoPath] = useState('');
  const [reEditPrompt, setReEditPrompt] = useState('テンポよく3つのシーンにカットし、9:16の縦型動画に調整');
  const [reEditReferencePath, setReEditReferencePath] = useState('');
  const [editPlan, setEditPlan] = useState<any | null>(null);
  const [reEditTargetRatio, setReEditTargetRatio] = useState('9:16');
  const [reEditBgmPath, setReEditBgmPath] = useState('');
  const [reEditBgmVolume, setReEditBgmVolume] = useState(0.2);
  const [reEditNarrationText, setReEditNarrationText] = useState('');
  const [lastRenderedAsset, setLastRenderedAsset] = useState<any | null>(null);

  // 3. 参考動画解析 State
  const [analysisVideoPath, setAnalysisVideoPath] = useState('');
  const [analysisResult, setAnalysisResult] = useState<any | null>(null);

  // 4. 保存済みテンプレート State
  const [presetForm, setPresetForm] = useState({
    name: '',
    description: '',
    targetAspectRatio: '9:16',
    defaultSpeed: 1.0,
    bgmVolume: 0.2,
  });

  // データロード
  const { data: jobs = [], mutate: refreshJobs } = useSWR(
    '/sns-studio/generation/jobs',
    (url: string) => request(url),
    { refreshInterval: 4000 }
  );

  const { data: presets = [], mutate: refreshPresets } = useSWR(
    '/sns-studio/editing-presets',
    (url: string) => request(url)
  );

  const runAction = async (action: () => Promise<void>, successMsg?: string) => {
    setBusy(true);
    setStatusMessage(null);
    setErrorMessage(null);
    try {
      await action();
      if (successMsg) setStatusMessage(successMsg);
    } catch (err: any) {
      setErrorMessage(err?.message || '処理中にエラーが発生しました。');
    } finally {
      setBusy(false);
    }
  };

  // --- Postiz Media Bridge ヘルパー ---
  // SnsMediaAsset IDからPostizの共通投稿用Mediaを作成・取得する
  const bridgeToPostizMedia = async (mediaAssetId: string) => {
    const res = await request(`/sns-studio/media-assets/${mediaAssetId}/post-media`, {
      method: 'POST',
    });
    if (!res?.media?.id) {
      throw new Error('共通投稿用Postiz Mediaの生成に失敗しました。');
    }
    return {
      postizMediaId: res.media.id as string,
      path: res.media.path as string,
      sourceAssetId: mediaAssetId,
    };
  };

  // --- AI新規生成 ハンドラ ---
  const handleCreateJob = async () => {
    if (!prompt.trim()) {
      setErrorMessage('プロンプトを入力してください。');
      return;
    }
    if (genMode === 'image-to-video' && !referenceImagePath.trim()) {
      setErrorMessage('Image-to-Videoでは参考画像のパスが必要です。');
      return;
    }

    await runAction(async () => {
      // Backend契約: { input: { ... } } を維持
      const inputPayload: Record<string, any> = {
        prompt: prompt.trim(),
        mode: genMode,
        modelName: selectedModel,
        mediaType: 'video',
        aspectRatio,
        durationSeconds: Number(durationSeconds),
        resolution,
      };
      if (genMode === 'image-to-video') {
        inputPayload.referenceImage = referenceImagePath.trim();
      }
      if (seed.trim()) {
        inputPayload.seed = parseInt(seed.trim(), 10);
      }
      if (analysisResult) {
        inputPayload.referenceAnalysis = analysisResult;
      }

      const res = await request('/sns-studio/generation/jobs', {
        method: 'POST',
        body: JSON.stringify({ input: inputPayload }),
      });

      await refreshJobs();
      setSubTool('history');
      setStatusMessage(
        `動画生成ジョブ #${res.id?.slice(0, 8) || ''} を投入しました。Google Drive/Colab Workerと連携して実行されます。`
      );
    });
  };

  // --- 参考動画解析 ハンドラ ---
  const handleAnalyzeVideo = async () => {
    if (!analysisVideoPath.trim()) {
      setErrorMessage('解析対象の動画パスを入力してください。');
      return;
    }

    await runAction(async () => {
      const res = await request('/sns-studio/video-tools/analyze', {
        method: 'POST',
        body: JSON.stringify({ videoPath: analysisVideoPath.trim() }),
      });
      setAnalysisResult(res);
      setStatusMessage('参考動画の構造解析が完了しました（※BGM・字幕は推測値です）。');
    });
  };

  const applyAnalysisToPrompt = () => {
    if (!analysisResult) return;
    const tempoDesc =
      analysisResult.tempo === 'FAST'
        ? '高速テンポ・リズミカルなカット割り'
        : analysisResult.tempo === 'SLOW'
        ? 'ゆったりとしたシネマティックなテンポ'
        : '標準テンポのテンポよい構成';
    const addition = ` [参考動画構成: テンポ=${tempoDesc}, アスペクト比=${analysisResult.aspectRatio || '9:16'}, 平均カット=${
      analysisResult.averageCutDurationSeconds ? analysisResult.averageCutDurationSeconds.toFixed(1) + 's' : '3s'
    }]`;
    setPrompt((prev) => (prev ? prev + addition : addition.trim()));
    if (analysisResult.aspectRatio === '9:16' || analysisResult.aspectRatio === '16:9' || analysisResult.aspectRatio === '1:1') {
      setAspectRatio(analysisResult.aspectRatio);
    }
    setSubTool('ai-generation');
    setStatusMessage('参考動画の解析構成を新規生成プロンプトに反映しました。');
  };

  const applyAnalysisToReEdit = () => {
    if (!analysisResult) return;
    setReEditReferencePath(analysisVideoPath);
    setReEditPrompt(
      `参考動画のテンポ(${analysisResult.tempo || 'MEDIUM'})とカット割り(${analysisResult.sceneCount || 3}シーン)を模倣して再加工`
    );
    if (analysisResult.aspectRatio) {
      setReEditTargetRatio(analysisResult.aspectRatio === '16:9' ? '16:9' : '9:16');
    }
    setSubTool('ai-re-edit');
    setStatusMessage('参考動画の解析結果を再加工パラメータにセットしました。');
  };

  // --- 元動画のAI再加工 ハンドラ (Aモード) ---
  const handleGenerateEditPlan = async () => {
    if (!sourceVideoPath.trim()) {
      setErrorMessage('元動画のパスを入力してください。');
      return;
    }

    await runAction(async () => {
      const payload: Record<string, any> = {
        sourceVideoPath: sourceVideoPath.trim(),
        instructions: reEditPrompt.trim(),
        targetAspectRatio: reEditTargetRatio,
      };
      if (reEditReferencePath.trim()) {
        payload.referenceVideoPath = reEditReferencePath.trim();
      }
      if (analysisResult) {
        payload.referenceAnalysis = analysisResult;
      }

      const plan = await request('/sns-studio/video-tools/edit-plan', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setEditPlan(plan);
      setStatusMessage('編集プラン(Edit Plan)を作成しました。各シーンの秒数やテロップを微調整してからレンダリングできます。');
    });
  };

  const handleRenderEditPlan = async () => {
    if (!editPlan || !editPlan.segments?.length) {
      setErrorMessage('有効な編集プランがありません。');
      return;
    }

    await runAction(async () => {
      const payload = {
        editPlan: {
          ...editPlan,
          targetAspectRatio: reEditTargetRatio,
          bgmPath: reEditBgmPath.trim() || undefined,
          bgmVolume: Number(reEditBgmVolume),
          narrationText: reEditNarrationText.trim() || undefined,
        },
      };

      const res = await request('/sns-studio/video-tools/render-plan', {
        method: 'POST',
        body: JSON.stringify(payload),
      });

      setLastRenderedAsset(res.asset);
      setStatusMessage('FFmpegによる元動画の再加工レンダリングが完了しました！素材一覧および制作Queueに登録されました。');
    });
  };

  // --- Aモード: 共通投稿への引き継ぎ ---
  const handleSendReEditToPublish = async () => {
    if (!lastRenderedAsset?.id) return;
    await runAction(async () => {
      const bridged = await bridgeToPostizMedia(lastRenderedAsset.id);
      onNavigateToPublish({
        content: `${reEditPrompt}\n\n#AIReEdit #VideoTools`,
        sourceAssetId: bridged.sourceAssetId,
        media: {
          id: bridged.postizMediaId,
          path: bridged.path,
        },
      });
    }, '共通投稿に素材をセットしました。');
  };

  // --- Bモード: 共通投稿への引き継ぎ ---
  const handleSendJobOutputToPublish = async (
    out: { mediaAssetId: string; storageKey: string },
    promptText: string
  ) => {
    if (!out.mediaAssetId) {
      setErrorMessage('SnsMediaAsset IDが見つかりません。Google Driveとの同期を再実行してください。');
      return;
    }
    await runAction(async () => {
      const bridged = await bridgeToPostizMedia(out.mediaAssetId);
      onNavigateToPublish({
        content: `${promptText}\n\n#AIVideo #VideoTools`,
        sourceAssetId: bridged.sourceAssetId,
        media: {
          id: bridged.postizMediaId,
          path: bridged.path,
        },
      });
    }, '共通投稿に生成動画をセットしました。');
  };

  // --- ジョブ管理 ハンドラ ---
  const handleCancelJob = async (jobId: string) => {
    await runAction(async () => {
      await request(`/sns-studio/generation/jobs/${jobId}/cancel`, { method: 'POST' });
      await refreshJobs();
    }, 'ジョブをキャンセルしました。');
  };

  const handleRetryJob = async (jobId: string) => {
    await runAction(async () => {
      await request(`/sns-studio/generation/jobs/${jobId}/retry`, { method: 'POST' });
      await refreshJobs();
    }, 'ジョブの再実行を要求しました。');
  };

  const handleSyncJobs = async () => {
    await runAction(async () => {
      await request('/sns-studio/generation/jobs/sync', { method: 'POST' });
      await refreshJobs();
    }, 'Google Driveとのジョブ同期が完了しました。');
  };

  return (
    <div className="flex flex-col gap-5">
      {/* サブナビゲーション */}
      <div className="flex flex-wrap gap-2 border-b border-blockSeparator pb-3">
        <button
          type="button"
          onClick={() => setSubTool('ai-generation')}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
            subTool === 'ai-generation' ? 'bg-[#5145ff] text-white' : 'text-textItemBlur hover:bg-boxFocused'
          }`}
        >
          ✨ AI新規動画生成
        </button>
        <button
          type="button"
          onClick={() => setSubTool('ai-re-edit')}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
            subTool === 'ai-re-edit' ? 'bg-[#5145ff] text-white' : 'text-textItemBlur hover:bg-boxFocused'
          }`}
        >
          ✂️ 元動画のAI再加工 (Aモード)
        </button>
        <button
          type="button"
          onClick={() => setSubTool('reference-analysis')}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
            subTool === 'reference-analysis' ? 'bg-[#5145ff] text-white' : 'text-textItemBlur hover:bg-boxFocused'
          }`}
        >
          🔍 参考動画の解析
        </button>
        <button
          type="button"
          onClick={() => setSubTool('history')}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
            subTool === 'history' ? 'bg-[#5145ff] text-white' : 'text-textItemBlur hover:bg-boxFocused'
          }`}
        >
          📋 制作履歴 & ジョブ一覧 ({jobs.length})
        </button>
        <button
          type="button"
          onClick={() => setSubTool('templates')}
          className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${
            subTool === 'templates' ? 'bg-[#5145ff] text-white' : 'text-textItemBlur hover:bg-boxFocused'
          }`}
        >
          📐 保存済みテンプレート
        </button>
      </div>

      {/* ステータスメッセージ */}
      {statusMessage && (
        <div className="rounded-lg border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-300">
          {statusMessage}
        </div>
      )}
      {errorMessage && (
        <div className="rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-300">
          {errorMessage}
        </div>
      )}

      {/* 1. AI新規動画生成 (Text-to-Video / Image-to-Video) */}
      {subTool === 'ai-generation' && (
        <div className="grid gap-5 xl:grid-cols-2">
          <section className={card}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">AI新規動画生成 (Bモード)</h2>
              <span className="rounded-full bg-[#5145ff]/20 px-3 py-0.5 text-xs text-[#9e9aff]">
                OSS Model Engine
              </span>
            </div>
            <p className="mt-1 text-sm text-textItemBlur">
              プロンプトや画像から生成AIで新しい映像を作ります。生成処理はGoogle Colab Worker等のGPU環境で非同期に実行されます。
            </p>

            <div className="mt-4 flex gap-4 border-b border-blockSeparator pb-3">
              <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
                <input
                  type="radio"
                  name="genMode"
                  checked={genMode === 'text-to-video'}
                  onChange={() => {
                    setGenMode('text-to-video');
                    setSelectedModel('wan-2.1-t2v-1.3b');
                  }}
                />
                Text-to-Video (テキストから動画)
              </label>
              <label className="flex items-center gap-2 text-sm font-semibold cursor-pointer">
                <input
                  type="radio"
                  name="genMode"
                  checked={genMode === 'image-to-video'}
                  onChange={() => {
                    setGenMode('image-to-video');
                    setSelectedModel('ltx-video-0.9.1-i2v');
                  }}
                />
                Image-to-Video (画像から動画)
              </label>
            </div>

            <div className="mt-4 flex flex-col gap-4">
              <div>
                <div className="flex items-center justify-between mb-1">
                  <label className="text-sm font-semibold">プロンプト (映像の指示文)</label>
                  {analysisResult && (
                    <button
                      type="button"
                      onClick={applyAnalysisToPrompt}
                      className="text-xs text-[#9e9aff] hover:underline"
                    >
                      + 参考動画の解析特徴を追記
                    </button>
                  )}
                </div>
                <textarea
                  className={`${field} min-h-[90px]`}
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder="例: 夕暮れのサイバーパンク都市を高速で駆け抜けるスポーツカー、ネオンの光線、映画のような質感、4k解像度"
                />
              </div>

              {genMode === 'image-to-video' && (
                <div>
                  <label className="text-sm font-semibold block mb-1">
                    参考画像パス (SnsMediaAsset または ローカルパス)
                  </label>
                  <input
                    type="text"
                    className={field}
                    value={referenceImagePath}
                    onChange={(e) => setReferenceImagePath(e.target.value)}
                    placeholder="/uploads/my-character.png"
                  />
                  <p className="mt-1 text-xs text-textItemBlur">
                    ※動きを付与したい静止画像のファイルパスを指定してください。
                  </p>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-semibold block mb-1">モデル選択 (公式HFチェックポイント)</label>
                  <select
                    className={field}
                    value={selectedModel}
                    onChange={(e) => setSelectedModel(e.target.value)}
                  >
                    {genMode === 'text-to-video' ? (
                      <>
                        <option value="wan-2.1-t2v-1.3b">Wan2.1 T2V (1.3B) - Colab T4/L4/A100 推奨</option>
                        <option value="ltx-video-0.9.1-t2v">LTX-Video T2V (0.9.1) - 高速・T4/L4/A100 推奨</option>
                      </>
                    ) : (
                      <>
                        <option value="ltx-video-0.9.1-i2v">LTX-Video I2V (0.9.1) - Colab T4/L4/A100 推奨</option>
                        <option value="wan-2.1-i2v-14b">Wan2.1 I2V (14B-480P) - ※要A100 GPU (VRAM 40GB+)</option>
                      </>
                    )}
                  </select>
                </div>

                <div>
                  <label className="text-sm font-semibold block mb-1">アスペクト比</label>
                  <select
                    className={field}
                    value={aspectRatio}
                    onChange={(e) => setAspectRatio(e.target.value)}
                  >
                    <option value="9:16">9:16 (縦型 - Reel/Shorts/TikTok)</option>
                    <option value="16:9">16:9 (横型 - YouTube通常)</option>
                    <option value="1:1">1:1 (正方形 - Feed)</option>
                  </select>
                </div>
              </div>

              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className="text-sm font-semibold block mb-1">動画尺 (秒)</label>
                  <select
                    className={field}
                    value={durationSeconds}
                    onChange={(e) => setDurationSeconds(Number(e.target.value))}
                  >
                    <option value={3}>3秒</option>
                    <option value={5}>5秒</option>
                    <option value={8}>8秒</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-semibold block mb-1">解像度</label>
                  <select
                    className={field}
                    value={resolution}
                    onChange={(e) => setResolution(e.target.value)}
                  >
                    <option value="480p">480p (高速)</option>
                    <option value="720p">720p (標準HD)</option>
                  </select>
                </div>
                <div>
                  <label className="text-sm font-semibold block mb-1">Seed (任意)</label>
                  <input
                    type="number"
                    className={field}
                    value={seed}
                    onChange={(e) => setSeed(e.target.value)}
                    placeholder="ランダム"
                  />
                </div>
              </div>

              <div className="mt-2">
                <button
                  type="button"
                  className={`${primaryButton} w-full`}
                  onClick={handleCreateJob}
                  disabled={busy}
                >
                  {busy ? 'ジョブ作成中...' : '🚀 AI動画生成ジョブを投入'}
                </button>
              </div>
            </div>
          </section>

          {/* 実行環境ガイダンス */}
          <div className="flex flex-col gap-4">
            <section className={card}>
              <h3 className="text-md font-bold text-amber-300 flex items-center gap-2">
                ⚠️ GPU実行環境とアーキテクチャについて
              </h3>
              <div className="mt-2 text-sm text-textItemBlur space-y-2">
                <p>
                  ・動画生成AIモデル（Wan2.1 / LTX-Video）は12GB以上のVRAMを持つCUDA GPUが必要です。
                </p>
                <p>
                  ・ローカルWindows環境（内蔵Radeon等）では過負荷を防ぐため、安全に fail-closed ガード（<code className="text-amber-200">BLOCKED_BY_GPU</code>）が作動します。
                </p>
                <p>
                  ・本番生成は <code className="text-amber-200">services/colab/sns_studio_worker.ipynb</code> をGoogle Colab (T4 / A100 GPU) で起動し、Google Drive Job Queueと同期して実行します。
                </p>
              </div>
            </section>

            {analysisResult && (
              <section className={card}>
                <h3 className="text-md font-bold">参考動画解析のキャッシュ</h3>
                <div className="mt-2 text-xs text-textItemBlur space-y-1">
                  <div>テンポ: <strong>{analysisResult.tempo}</strong> ({analysisResult.averageCutDurationSeconds ? analysisResult.averageCutDurationSeconds.toFixed(1) + 's/cut' : ''})</div>
                  <div>アスペクト比: <strong>{analysisResult.aspectRatio}</strong> ({analysisResult.width}x{analysisResult.height})</div>
                  <div>シーン数: <strong>{analysisResult.sceneCount}</strong></div>
                </div>
                <button
                  type="button"
                  onClick={applyAnalysisToPrompt}
                  className={`${secondaryButton} mt-3 text-xs w-full`}
                >
                  この解析特徴をプロンプトに追記
                </button>
              </section>
            )}
          </div>
        </div>
      )}

      {/* 2. 元動画のAI再加工 (Aモード) */}
      {subTool === 'ai-re-edit' && (
        <div className="grid gap-5 xl:grid-cols-2">
          <section className={card}>
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-bold">元動画のAI再加工 (Aモード)</h2>
              <span className="rounded-full bg-emerald-500/20 px-3 py-0.5 text-xs text-emerald-300">
                FFmpeg 編集エンジン
              </span>
            </div>
            <p className="mt-1 text-sm text-textItemBlur">
              元動画を構造化された編集プランとFFmpegにより再加工（トリミング、順序変更、9:16クロップ、速度変更、テロップ、BGM、ナレーション）します。
            </p>

            <div className="mt-4 flex flex-col gap-4">
              <div>
                <label className="text-sm font-semibold block mb-1">
                  元動画パス (必須)
                </label>
                <input
                  type="text"
                  className={field}
                  value={sourceVideoPath}
                  onChange={(e) => setSourceVideoPath(e.target.value)}
                  placeholder="/uploads/original-clip.mp4"
                />
              </div>

              <div>
                <label className="text-sm font-semibold block mb-1">
                  参考動画パス (任意: カット割りの手本にする動画)
                </label>
                <input
                  type="text"
                  className={field}
                  value={reEditReferencePath}
                  onChange={(e) => setReEditReferencePath(e.target.value)}
                  placeholder="/uploads/reference-reel.mp4"
                />
              </div>

              <div>
                <label className="text-sm font-semibold block mb-1">
                  編集指示文 (プロンプト)
                </label>
                <textarea
                  className={`${field} min-h-[70px]`}
                  value={reEditPrompt}
                  onChange={(e) => setReEditPrompt(e.target.value)}
                  placeholder="例: 最初と最後の無駄な間をカットし、テンポよく3つのハイライトに分割してテロップを乗せる"
                />
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="text-sm font-semibold block mb-1">仕上がり比率</label>
                  <select
                    className={field}
                    value={reEditTargetRatio}
                    onChange={(e) => setReEditTargetRatio(e.target.value)}
                  >
                    <option value="9:16">9:16 (縦型ショート/リール)</option>
                    <option value="16:9">16:9 (横型動画)</option>
                    <option value="1:1">1:1 (正方形)</option>
                  </select>
                </div>
                <div className="flex items-end">
                  <button
                    type="button"
                    className={`${secondaryButton} w-full`}
                    onClick={handleGenerateEditPlan}
                    disabled={busy || !sourceVideoPath}
                  >
                    💡 ルールベース編集プランを生成 (微調整可能)
                  </button>
                </div>
              </div>

              {/* Edit Plan エディタ */}
              {editPlan && (
                <div className="mt-3 rounded-lg border border-blockSeparator bg-boxFocused/40 p-4">
                  <div className="flex items-center justify-between mb-2">
                    <h3 className="font-bold text-sm">📋 編集プラン (Edit Plan) の編集</h3>
                    <span className="text-xs text-textItemBlur">
                      {editPlan.segments?.length || 0} シーン
                    </span>
                  </div>
                  <p className="text-[11px] text-textItemBlur mb-2">
                    ※ルールベースで提案されたシーン分割やテロップです。各シーンの秒数や文字を自由に手動修正できます。
                  </p>

                  <div className="space-y-3 max-h-[300px] overflow-y-auto pr-1">
                    {editPlan.segments?.map((seg: any, idx: number) => (
                      <div
                        key={idx}
                        className="rounded border border-blockSeparator bg-newBgColorInner p-3 text-xs flex flex-col gap-2"
                      >
                        <div className="flex items-center justify-between font-semibold">
                          <span>シーン #{idx + 1}</span>
                          <button
                            type="button"
                            onClick={() => {
                              const next = [...editPlan.segments];
                              next.splice(idx, 1);
                              setEditPlan({ ...editPlan, segments: next });
                            }}
                            className="text-red-400 hover:underline"
                          >
                            削除
                          </button>
                        </div>
                        <div className="grid grid-cols-3 gap-2">
                          <div>
                            <label className="text-textItemBlur block mb-0.5">開始秒</label>
                            <input
                              type="number"
                              step="0.1"
                              className={field}
                              value={seg.startSeconds}
                              onChange={(e) => {
                                const next = [...editPlan.segments];
                                next[idx].startSeconds = parseFloat(e.target.value) || 0;
                                setEditPlan({ ...editPlan, segments: next });
                              }}
                            />
                          </div>
                          <div>
                            <label className="text-textItemBlur block mb-0.5">終了秒</label>
                            <input
                              type="number"
                              step="0.1"
                              className={field}
                              value={seg.endSeconds}
                              onChange={(e) => {
                                const next = [...editPlan.segments];
                                next[idx].endSeconds = parseFloat(e.target.value) || 0;
                                setEditPlan({ ...editPlan, segments: next });
                              }}
                            />
                          </div>
                          <div>
                            <label className="text-textItemBlur block mb-0.5">再生速度</label>
                            <input
                              type="number"
                              step="0.05"
                              className={field}
                              value={seg.playbackSpeed || 1.0}
                              onChange={(e) => {
                                const next = [...editPlan.segments];
                                next[idx].playbackSpeed = parseFloat(e.target.value) || 1.0;
                                setEditPlan({ ...editPlan, segments: next });
                              }}
                            />
                          </div>
                        </div>

                        <div>
                          <label className="text-textItemBlur block mb-0.5">テロップ挿入</label>
                          <input
                            type="text"
                            className={field}
                            value={seg.textOverlay?.text || ''}
                            placeholder="画面に表示する文字"
                            onChange={(e) => {
                              const next = [...editPlan.segments];
                              next[idx].textOverlay = {
                                ...(next[idx].textOverlay || {}),
                                text: e.target.value,
                              };
                              setEditPlan({ ...editPlan, segments: next });
                            }}
                          />
                        </div>
                      </div>
                    ))}
                  </div>

                  <button
                    type="button"
                    onClick={() => {
                      const next = [...(editPlan.segments || [])];
                      next.push({
                        sourcePath: sourceVideoPath,
                        startSeconds: 0,
                        endSeconds: 3,
                        playbackSpeed: 1.0,
                        textOverlay: { text: '' },
                      });
                      setEditPlan({ ...editPlan, segments: next });
                    }}
                    className={`${secondaryButton} mt-3 text-xs w-full`}
                  >
                    + セグメントを追加
                  </button>

                  <div className="mt-4 pt-3 border-t border-blockSeparator grid grid-cols-2 gap-3 text-xs">
                    <div>
                      <label className="font-semibold block mb-1">BGMパス (任意)</label>
                      <input
                        type="text"
                        className={field}
                        value={reEditBgmPath}
                        onChange={(e) => setReEditBgmPath(e.target.value)}
                        placeholder="/uploads/bgm-upbeat.mp3"
                      />
                    </div>
                    <div>
                      <label className="font-semibold block mb-1">BGM音量 ({reEditBgmVolume})</label>
                      <input
                        type="range"
                        min="0"
                        max="1"
                        step="0.05"
                        className="w-full mt-2"
                        value={reEditBgmVolume}
                        onChange={(e) => setReEditBgmVolume(parseFloat(e.target.value))}
                      />
                    </div>
                  </div>

                  <div className="mt-3 text-xs">
                    <label className="font-semibold block mb-1">ナレーション指示 (TTS)</label>
                    <input
                      type="text"
                      className={field}
                      value={reEditNarrationText}
                      onChange={(e) => setReEditNarrationText(e.target.value)}
                      placeholder="合成音声で読み上げるスクリプト"
                    />
                  </div>

                  <button
                    type="button"
                    className={`${primaryButton} mt-4 w-full`}
                    onClick={handleRenderEditPlan}
                    disabled={busy}
                  >
                    {busy ? 'レンダリング中...' : '🎬 このプランでレンダリングを実行'}
                  </button>
                </div>
              )}
            </div>
          </section>

          {/* 成果物プレビュー & 制作Queue連携 */}
          <div className="flex flex-col gap-4">
            <section className={card}>
              <h3 className="text-md font-bold mb-2">再加工の出力プレビュー</h3>
              {lastRenderedAsset ? (
                <div className="space-y-3">
                  <div className="relative mx-auto aspect-[9/16] max-h-[460px] w-full max-w-[260px] overflow-hidden rounded-lg bg-black">
                    <video
                      className="absolute inset-0 h-full w-full object-contain"
                      controls
                      preload="metadata"
                      src={previewUrl(lastRenderedAsset.path)}
                    />
                  </div>
                  <div className="text-xs text-textItemBlur">
                    <div>パス: {lastRenderedAsset.path}</div>
                    <div>尺: {lastRenderedAsset.durationSeconds?.toFixed(1) || '?'} 秒</div>
                    <div>ソース: {lastRenderedAsset.source}</div>
                  </div>

                  <div className="flex flex-col gap-2 pt-2 border-t border-blockSeparator">
                    <button
                      type="button"
                      className={`${primaryButton} text-sm`}
                      onClick={handleSendReEditToPublish}
                      disabled={busy}
                    >
                      🚀 共通投稿 (Cross Post) にセット (Postiz Media変換)
                    </button>
                    <button
                      type="button"
                      className={`${secondaryButton} text-sm`}
                      onClick={onNavigateToQueue}
                    >
                      📬 制作Queueで確認・承認
                    </button>
                  </div>
                </div>
              ) : (
                <div className="flex flex-col items-center justify-center p-8 text-center text-textItemBlur border border-dashed border-blockSeparator rounded-lg">
                  <p>レンダリングされた動画がここにプレビュー表示されます。</p>
                </div>
              )}
            </section>
          </div>
        </div>
      )}

      {/* 3. 参考動画の解析 */}
      {subTool === 'reference-analysis' && (
        <div className="grid gap-5 xl:grid-cols-2">
          <section className={card}>
            <h2 className="text-lg font-bold">参考動画の解析 (Structure Analyzer)</h2>
            <p className="mt-1 text-sm text-textItemBlur">
              バズっている手本動画を解析し、総尺・解像度・カット割り・テンポ・BGMの有無を自動抽出します。
            </p>

            <div className="mt-4 flex flex-col gap-4">
              <div>
                <label className="text-sm font-semibold block mb-1">
                  解析する動画パス (SnsMediaAsset または パス)
                </label>
                <input
                  type="text"
                  className={field}
                  value={analysisVideoPath}
                  onChange={(e) => setAnalysisVideoPath(e.target.value)}
                  placeholder="/uploads/sample-viral-reel.mp4"
                />
              </div>

              <button
                type="button"
                className={primaryButton}
                onClick={handleAnalyzeVideo}
                disabled={busy || !analysisVideoPath}
              >
                {busy ? '動画を解析中 (FFmpeg / ffprobe)...' : '🔍 解析を実行'}
              </button>
            </div>
          </section>

          {/* 解析結果カード */}
          <section className={card}>
            <h3 className="text-md font-bold mb-2">解析結果レポート</h3>
            {analysisResult ? (
              <div className="space-y-4">
                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="rounded border border-blockSeparator p-3">
                    <span className="text-xs text-textItemBlur block">基本情報</span>
                    <div className="font-bold text-base mt-1">
                      {analysisResult.durationSeconds?.toFixed(1) || 0} 秒
                    </div>
                    <div className="text-xs text-textItemBlur mt-0.5">
                      {analysisResult.width}x{analysisResult.height} ({analysisResult.aspectRatio || '9:16'}) / {analysisResult.fps?.toFixed(0) || 30}fps
                    </div>
                  </div>

                  <div className="rounded border border-blockSeparator p-3">
                    <span className="text-xs text-textItemBlur block">テンポ評価</span>
                    <div className="font-bold text-base mt-1">
                      {analysisResult.tempo === 'FAST' ? '⚡ FAST (アップテンポ)' : analysisResult.tempo === 'SLOW' ? '🍃 SLOW (ゆったり)' : '⏱️ MEDIUM (標準)'}
                    </div>
                    <div className="text-xs text-textItemBlur mt-0.5">
                      平均カット間隔: {analysisResult.averageCutDurationSeconds ? analysisResult.averageCutDurationSeconds.toFixed(1) + '秒' : '不明'}
                    </div>
                  </div>
                </div>

                <div className="rounded border border-blockSeparator p-3 text-sm space-y-2">
                  <div className="font-semibold text-xs text-textItemBlur">シーン・カット検出</div>
                  <div className="text-sm">
                    検出されたシーン数: <strong>{analysisResult.sceneCount || 1}</strong>
                  </div>
                  {analysisResult.sceneCuts?.length > 0 && (
                    <div className="flex flex-wrap gap-1 mt-1 max-h-20 overflow-y-auto">
                      {analysisResult.sceneCuts.map((time: number, idx: number) => (
                        <span key={idx} className="rounded bg-boxFocused px-2 py-0.5 text-xs">
                          #{idx + 1}: {Number(time).toFixed(1)}s
                        </span>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded border border-blockSeparator p-3 text-xs space-y-2">
                  <div className="font-semibold text-textItemBlur">音声・字幕推測</div>
                  <div className="grid grid-cols-2 gap-2">
                    <div>
                      BGMの有無:{' '}
                      <span className="font-semibold">
                        {analysisResult.hasBgm ? 'あり' : 'なし'}
                      </span>{' '}
                      <span className="text-amber-300 text-[10px]">(※推測値)</span>
                    </div>
                    <div>
                      字幕・テロップ:{' '}
                      <span className="font-semibold">
                        {analysisResult.hasSubtitles ? 'あり' : 'なし'}
                      </span>{' '}
                      <span className="text-amber-300 text-[10px]">(※推測値)</span>
                    </div>
                  </div>
                  <p className="text-[11px] text-textItemBlur">
                    ※ffprobeオーディオ解析およびFFmpegシーン検知による推定値です。確定情報ではありません。
                  </p>
                </div>

                <div className="flex flex-col gap-2 pt-2">
                  <button
                    type="button"
                    className={`${primaryButton} text-sm`}
                    onClick={applyAnalysisToPrompt}
                  >
                    ✨ この解析特徴をAI新規生成プロンプトに反映
                  </button>
                  <button
                    type="button"
                    className={`${secondaryButton} text-sm`}
                    onClick={applyAnalysisToReEdit}
                  >
                    ✂️ この構成を元動画の再加工プランに反映
                  </button>
                </div>
              </div>
            ) : (
              <div className="flex flex-col items-center justify-center p-8 text-center text-textItemBlur border border-dashed border-blockSeparator rounded-lg">
                <p>動画パスを入力して「解析を実行」を押すと、ここに結果が表示されます。</p>
              </div>
            )}
          </section>
        </div>
      )}

      {/* 4. 制作履歴 & ジョブ一覧 */}
      {subTool === 'history' && (
        <section className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3 border-b border-blockSeparator pb-4">
            <div>
              <h2 className="text-lg font-bold">制作履歴 (AI動画生成ジョブ一覧)</h2>
              <p className="text-xs text-textItemBlur">
                Google Drive Job Queueと連携して実行される非同期ジョブの状態を確認・同期します。
              </p>
            </div>
            <div className="flex gap-2">
              <button
                type="button"
                className={secondaryButton}
                onClick={handleSyncJobs}
                disabled={busy}
              >
                🔄 Google Driveと同期
              </button>
              <button
                type="button"
                className={secondaryButton}
                onClick={() => void refreshJobs()}
                disabled={busy}
              >
                再読み込み
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {jobs.length ? (
              jobs.map((job: any) => {
                const isComplete = job.status === 'COMPLETE' || job.status === 'COMPLETED';
                const isFailed = job.status === 'FAILED';
                const isCancelled = job.status === 'CANCELLED';
                const isBlocked =
                  isFailed &&
                  (job.errorMessage?.includes('BLOCKED_BY_GPU') ||
                    job.errorCode?.includes('BLOCKED_BY_GPU') ||
                    job.error?.includes('BLOCKED_BY_GPU'));

                const inputPrompt =
                  job.inputManifest?.prompt || job.prompt || '(プロンプト未指定)';
                const modelLabel =
                  job.inputManifest?.modelName || job.inputManifest?.model || job.model || 'wan-2.1-t2v-1.3b';
                const modeLabel =
                  job.inputManifest?.mode || job.mediaType || 'text-to-video';

                // 出力成果物 (resultManifest.outputs: [{ mediaAssetId, storageKey, name, inboxItemId }])
                const outputs: Array<{ mediaAssetId: string; storageKey: string; name?: string; inboxItemId?: string }> =
                  Array.isArray(job.resultManifest?.outputs)
                    ? job.resultManifest.outputs
                    : Array.isArray(job.outputs)
                    ? job.outputs.map((p: any) =>
                        typeof p === 'string' ? { storageKey: p, mediaAssetId: '' } : p
                      )
                    : [];

                return (
                  <div
                    key={job.id}
                    className="rounded-lg border border-blockSeparator bg-boxFocused/30 p-4 transition"
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <span
                          className={`rounded px-2 py-0.5 text-xs font-bold ${
                            isComplete
                              ? 'bg-emerald-500/20 text-emerald-300'
                              : isFailed
                              ? 'bg-red-500/20 text-red-300'
                              : isCancelled
                              ? 'bg-gray-500/20 text-gray-300'
                              : 'bg-amber-500/20 text-amber-300 animate-pulse'
                          }`}
                        >
                          {job.status}
                        </span>
                        <strong className="text-sm">Job #{job.id.slice(0, 8)}</strong>
                        <span className="text-xs text-textItemBlur">
                          {modelLabel} • {modeLabel}
                        </span>
                      </div>
                      <div className="text-xs text-textItemBlur">
                        {job.createdAt ? new Date(job.createdAt).toLocaleString() : ''}
                      </div>
                    </div>

                    <div className="mt-2 text-xs text-newTextColor">
                      <strong>プロンプト:</strong> {inputPrompt}
                    </div>

                    {(job.errorMessage || job.errorCode || job.error) && (
                      <div className="mt-2 rounded bg-red-500/10 p-2 text-xs text-red-300 border border-red-500/20">
                        {isBlocked ? (
                          <div>
                            <strong>🛑 GPU環境制約 (Fail-closed):</strong>{' '}
                            {job.errorCode ? `[${job.errorCode}] ` : ''}{job.errorMessage || job.error}
                            <p className="mt-1 text-[11px] text-amber-200">
                              ※ローカルWindows環境での無断実行は防護されています。Google Colabワーカー（VRAM 12GB+）で実行してください。
                            </p>
                          </div>
                        ) : (
                          <div>
                            <strong>エラー [{job.errorCode || 'ERROR'}]:</strong>{' '}
                            {job.errorMessage || job.error}
                          </div>
                        )}
                      </div>
                    )}

                    {/* 出力成果物 */}
                    {outputs.length > 0 && (
                      <div className="mt-3 flex flex-wrap gap-4 items-center">
                        {outputs.map((out, i) => (
                          <div key={i} className="flex flex-col gap-1">
                            <video
                              className="max-h-40 max-w-[200px] rounded border border-blockSeparator bg-black"
                              controls
                              preload="metadata"
                              src={previewUrl(out.storageKey)}
                            />
                            <span className="text-[10px] text-textItemBlur truncate max-w-[200px]">
                              {out.storageKey}
                            </span>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                className={`${primaryButton} text-xs py-1`}
                                onClick={() => handleSendJobOutputToPublish(out, inputPrompt)}
                                disabled={busy}
                              >
                                🚀 共通投稿へ送る (Postiz Media変換)
                              </button>
                              {out.inboxItemId && (
                                <button
                                  type="button"
                                  className={`${secondaryButton} text-xs py-1`}
                                  onClick={onNavigateToQueue}
                                >
                                  制作Queue
                                </button>
                              )}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}

                    {/* アクションボタン */}
                    <div className="mt-3 flex gap-2">
                      {(job.status === 'PENDING' ||
                        job.status === 'SUBMITTING' ||
                        job.status === 'QUEUED' ||
                        job.status === 'RUNNING') && (
                        <button
                          type="button"
                          className={`${dangerButton} text-xs py-1`}
                          onClick={() => handleCancelJob(job.id)}
                          disabled={busy}
                        >
                          キャンセル
                        </button>
                      )}
                      {(isFailed || isCancelled) && (
                        <button
                          type="button"
                          className={`${secondaryButton} text-xs py-1`}
                          onClick={() => handleRetryJob(job.id)}
                          disabled={busy}
                        >
                          再実行
                        </button>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="py-8 text-center text-textItemBlur">
                まだ生成ジョブはありません。
              </div>
            )}
          </div>
        </section>
      )}

      {/* 5. 保存済みテンプレート */}
      {subTool === 'templates' && (
        <div className="grid gap-5 xl:grid-cols-2">
          <section className={card}>
            <h2 className="text-lg font-bold">保存済みテンプレート (Presets)</h2>
            <p className="mt-1 text-sm text-textItemBlur">
              動画のアスペクト比、カット速度、BGM設定などのテンプレートを保存し、再加工時に適用します。
            </p>

            <div className="mt-4 space-y-3">
              {presets.length ? (
                presets.map((preset: any) => (
                  <div
                    key={preset.id}
                    className="flex items-center justify-between rounded-lg border border-blockSeparator p-3"
                  >
                    <div>
                      <div className="font-semibold text-sm">{preset.name}</div>
                      <div className="text-xs text-textItemBlur mt-0.5">
                        {JSON.stringify(preset.config || {})}
                      </div>
                    </div>
                    <button
                      type="button"
                      className={`${secondaryButton} text-xs`}
                      onClick={() => {
                        setSubTool('ai-re-edit');
                        setStatusMessage(`テンプレート「${preset.name}」を再加工にセットしました。`);
                      }}
                    >
                      適用
                    </button>
                  </div>
                ))
              ) : (
                <div className="text-xs text-textItemBlur">保存済みテンプレートはありません。</div>
              )}
            </div>
          </section>

          <section className={card}>
            <h3 className="text-md font-bold mb-2">テンプレートを新規作成</h3>
            <div className="space-y-3">
              <div>
                <label className="text-sm font-semibold block mb-1">テンプレート名</label>
                <input
                  type="text"
                  className={field}
                  value={presetForm.name}
                  onChange={(e) => setPresetForm({ ...presetForm, name: e.target.value })}
                  placeholder="例: Shorts Fast Upbeat"
                />
              </div>

              <div>
                <label className="text-sm font-semibold block mb-1">仕上がりアスペクト比</label>
                <select
                  className={field}
                  value={presetForm.targetAspectRatio}
                  onChange={(e) => setPresetForm({ ...presetForm, targetAspectRatio: e.target.value })}
                >
                  <option value="9:16">9:16 (縦型)</option>
                  <option value="16:9">16:9 (横型)</option>
                  <option value="1:1">1:1 (正方形)</option>
                </select>
              </div>

              <div>
                <label className="text-sm font-semibold block mb-1">デフォルト再生速度 ({presetForm.defaultSpeed}x)</label>
                <input
                  type="range"
                  min="0.8"
                  max="1.5"
                  step="0.05"
                  className="w-full"
                  value={presetForm.defaultSpeed}
                  onChange={(e) => setPresetForm({ ...presetForm, defaultSpeed: parseFloat(e.target.value) })}
                />
              </div>

              <button
                type="button"
                className={`${primaryButton} w-full mt-2`}
                onClick={async () => {
                  if (!presetForm.name.trim()) return setErrorMessage('テンプレート名を入力してください。');
                  await runAction(async () => {
                    await request('/sns-studio/editing-presets', {
                      method: 'POST',
                      body: JSON.stringify({
                        name: presetForm.name.trim(),
                        config: {
                          targetAspectRatio: presetForm.targetAspectRatio,
                          playbackSpeed: presetForm.defaultSpeed,
                          bgmVolume: presetForm.bgmVolume,
                        },
                      }),
                    });
                    await refreshPresets();
                    setPresetForm({ name: '', description: '', targetAspectRatio: '9:16', defaultSpeed: 1.0, bgmVolume: 0.2 });
                  }, 'テンプレートを保存しました。');
                }}
                disabled={busy}
              >
                保存する
              </button>
            </div>
          </section>
        </div>
      )}
    </div>
  );
};
