const mockSWR = jest.fn();

jest.mock(
  '@gitroom/helpers/utils/custom.fetch',
  () => ({ useFetch: () => jest.fn() }),
  { virtual: true }
);
jest.mock('swr', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSWR(...args),
}));

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { VideoToolsWorkspace } from './video-tools-workspace';

describe('VideoToolsWorkspace UI smoke', () => {
  const dummyRequest = jest.fn().mockResolvedValue({});
  const dummyPreviewUrl = (p: string) => `http://localhost:3000/preview?path=${p}`;
  const dummyNavigatePublish = jest.fn();
  const dummyNavigateQueue = jest.fn();

  beforeEach(() => {
    mockSWR.mockReset();
    mockSWR.mockImplementation((key: unknown) => {
      if (key === '/sns-studio/generation/jobs') {
        return {
          data: [
            {
              id: 'job-12345678',
              status: 'FAILED',
              inputManifest: {
                modelName: 'wan-2.1-t2v-1.3b',
                mode: 'text-to-video',
                prompt: 'A cyberpunk racing car in neon city',
              },
              errorCode: 'BLOCKED_BY_GPU',
              errorMessage: 'CUDA GPU with >=12GB VRAM required for Wan2.1. Colab worker recommended.',
              createdAt: '2026-10-14T02:00:00.000Z',
              resultManifest: null,
            },
            {
              id: 'job-87654321',
              status: 'COMPLETE',
              inputManifest: {
                modelName: 'ltx-video-0.9.1-t2v',
                mode: 'text-to-video',
                prompt: 'A calm mountain river at sunset',
              },
              errorCode: null,
              errorMessage: null,
              createdAt: '2026-10-14T01:00:00.000Z',
              resultManifest: {
                outputs: [
                  {
                    mediaAssetId: 'asset-gen-1',
                    storageKey: '/uploads/sns-studio/generated/job-87654321/river.mp4',
                    name: 'river.mp4',
                    inboxItemId: 'inbox-gen-1',
                  },
                ],
              },
            },
          ],
          mutate: jest.fn(),
          isLoading: false,
        };
      }
      if (key === '/sns-studio/editing-presets') {
        return {
          data: [
            {
              id: 'preset-1',
              name: 'Reel Standard',
              config: { targetAspectRatio: '9:16', playbackSpeed: 1.0, bgmVolume: 0.2 },
            },
          ],
          mutate: jest.fn(),
          isLoading: false,
        };
      }
      return { data: [], mutate: jest.fn(), isLoading: false };
    });
  });

  it('renders initial AI generation workspace with model selector and GPU guidance', () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoToolsWorkspace, {
        request: dummyRequest,
        previewUrl: dummyPreviewUrl,
        onNavigateToPublish: dummyNavigatePublish,
        onNavigateToQueue: dummyNavigateQueue,
      })
    );

    // サブナビゲーションの5タブが存在すること
    expect(html).toContain('AI新規動画生成');
    expect(html).toContain('元動画のAI再加工 (Aモード)');
    expect(html).toContain('参考動画の解析');
    expect(html).toContain('制作履歴 &amp; ジョブ一覧');
    expect(html).toContain('保存済みテンプレート');

    // AI新規生成モードのUI
    expect(html).toContain('AI新規動画生成 (Bモード)');
    expect(html).toContain('Text-to-Video');
    expect(html).toContain('Image-to-Video');
    expect(html).toContain('wan-2.1-t2v-1.3b');
    expect(html).toContain('BLOCKED_BY_GPU');
    expect(html).toContain('services/colab/sns_studio_worker.ipynb');
  });

  it('renders A-mode video re-edit workspace with FFmpeg controls and edit plan generator', () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoToolsWorkspace, {
        request: dummyRequest,
        previewUrl: dummyPreviewUrl,
        onNavigateToPublish: dummyNavigatePublish,
        onNavigateToQueue: dummyNavigateQueue,
        initialSubTool: 'ai-re-edit',
      })
    );

    expect(html).toContain('元動画のAI再加工 (Aモード)');
    expect(html).toContain('FFmpeg 編集エンジン');
    expect(html).toContain('元動画パス (必須)');
    expect(html).toContain('参考動画パス (任意: カット割りの手本にする動画)');
    expect(html).toContain('ルールベース編集プランを生成');
  });

  it('renders reference video analysis workspace', () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoToolsWorkspace, {
        request: dummyRequest,
        previewUrl: dummyPreviewUrl,
        onNavigateToPublish: dummyNavigatePublish,
        onNavigateToQueue: dummyNavigateQueue,
        initialSubTool: 'reference-analysis',
      })
    );

    expect(html).toContain('参考動画の解析 (Structure Analyzer)');
    expect(html).toContain('解析する動画パス');
    expect(html).toContain('解析を実行');
    expect(html).toContain('解析結果レポート');
  });

  it('renders history view displaying jobs, outputs, and fail-closed GPU error guidance', () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoToolsWorkspace, {
        request: dummyRequest,
        previewUrl: dummyPreviewUrl,
        onNavigateToPublish: dummyNavigatePublish,
        onNavigateToQueue: dummyNavigateQueue,
        initialSubTool: 'history',
      })
    );

    expect(html).toContain('制作履歴 (AI動画生成ジョブ一覧)');
    expect(html).toContain('Google Driveと同期');
    expect(html).toContain('Job #job-1234');
    expect(html).toContain('GPU環境制約 (Fail-closed):');
    expect(html).toContain('BLOCKED_BY_GPU');
    expect(html).toContain('Job #job-8765');
    expect(html).toContain('COMPLETE');
    expect(html).toContain('共通投稿へ送る (Postiz Media変換)');
    expect(html).toContain('/uploads/sns-studio/generated/job-87654321/river.mp4');
  });

  it('renders saved templates view with preset list and creation form', () => {
    const html = renderToStaticMarkup(
      React.createElement(VideoToolsWorkspace, {
        request: dummyRequest,
        previewUrl: dummyPreviewUrl,
        onNavigateToPublish: dummyNavigatePublish,
        onNavigateToQueue: dummyNavigateQueue,
        initialSubTool: 'templates',
      })
    );

    expect(html).toContain('保存済みテンプレート (Presets)');
    expect(html).toContain('Reel Standard');
    expect(html).toContain('テンプレートを新規作成');
  });
});
