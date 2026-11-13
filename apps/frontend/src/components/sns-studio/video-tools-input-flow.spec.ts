/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
const mockSWR = () => ({ data: [], mutate: jest.fn() });
jest.mock('swr', () => ({ __esModule: true, default: () => mockSWR() }));
jest.mock('./video-input-picker', () => ({ VideoInputPicker: (props: any) => React.createElement('button', {
  'data-picker': props.label,
  onClick: () => props.onChange({ id: props.label, storageKey: props.label.startsWith('元動画') ? '/uploads/source.mp4' : '/uploads/reference.mp4', duration: 2 }),
}, props.label) }));
import { VideoToolsWorkspace } from './video-tools-workspace';
describe('Video Tools selected input handoff', () => {
  let root: Root, div: HTMLDivElement, request: jest.Mock;
  beforeEach(async () => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    div = document.createElement('div'); document.body.appendChild(div); root = createRoot(div);
    request = jest.fn().mockImplementation(async (path) => path.endsWith('edit-plan')
      ? { segments: [{ trimStartSeconds: 0, trimEndSeconds: 2, playbackSpeed: 1 }], textOverlays: [] }
      : path.endsWith('render-plan')
        ? { mediaAssetId: 'edited-asset', path: '/uploads/edited.mp4', durationSeconds: 1.75 }
        : {});
    await act(async () => root.render(React.createElement(VideoToolsWorkspace, { request, previewUrl: (p) => p, onNavigateToPublish: jest.fn(), onNavigateToQueue: jest.fn() })));
  });
  afterEach(async () => { await act(async () => root.unmount()); div.remove(); });
  const click = async (part: string) => act(async () => Array.from(div.querySelectorAll('button')).find(b => b.textContent?.includes(part))!.click());
  it('requires a selected source, but permits ordinary editing without a reference', async () => {
    expect(Array.from(div.querySelectorAll('button')).find(b => b.textContent?.includes('ルールベース編集プラン'))?.disabled).toBe(true);
    await click('元動画（'); await click('ルールベース編集プラン');
    expect(request).toHaveBeenCalledTimes(1);
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ sourceVideoPath: '/uploads/source.mp4' });
    expect(JSON.parse(request.mock.calls[0][1].body).referenceVideoPath).toBeUndefined();
  });
  it('hands off distinct selected paths and renders using the flat Backend contract', async () => {
    await click('元動画（'); await click('参考動画（'); await click('ルールベース編集プラン');
    expect(JSON.parse(request.mock.calls[0][1].body)).toMatchObject({ sourceVideoPath: '/uploads/source.mp4', referenceVideoPath: '/uploads/reference.mp4' });
    await click('レンダリング');
    const render = request.mock.calls.find(([path]) => path === '/sns-studio/video-tools/render-plan');
    expect(render).toBeDefined();
    expect(JSON.parse(render![1].body)).toMatchObject({ sourcePath: '/uploads/source.mp4', segments: [{ trimStartSeconds: 0, trimEndSeconds: 2, playbackSpeed: 1, order: 0 }] });
    expect(JSON.parse(render![1].body).editPlan).toBeUndefined();
    expect(div.querySelector('video')?.getAttribute('src')).toBe('/uploads/edited.mp4');
    expect(div.textContent).toContain('1.8 秒');
    expect(div.textContent).toContain('AI_RE_EDIT');
    expect(request.mock.calls.some(([path]) => /publish|generation\/jobs/.test(path))).toBe(false);
  });
  it('switching to AI creation needs no source and does not start a paid generation', async () => {
    await click('AI新規動画生成');
    expect(div.textContent).toContain('Text-to-Video');
    expect(div.querySelector('[data-picker^="元動画"]')).toBeNull();
    expect(request).not.toHaveBeenCalled();
  });
});
