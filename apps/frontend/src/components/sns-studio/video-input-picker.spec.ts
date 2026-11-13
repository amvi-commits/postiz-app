/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
const mockUploaders: any[] = [];
const mockModal = { openModal: jest.fn(), closeCurrent: jest.fn() };
const mockUnlock = jest.fn();
jest.mock('@gitroom/frontend/components/new-launch/store', () => ({ useLaunchStore: (selector: any) => selector({ setLocked: mockUnlock }) }));
jest.mock('@gitroom/frontend/components/media/new.uploader', () => ({
  useUppyUploader: (options: any) => {
    const ref = require('react').useRef(null);
    if (!ref.current) {
      ref.current = { options, addFile: jest.fn(), on: jest.fn(), off: jest.fn(), cancelAll: jest.fn() };
      mockUploaders.push(ref.current);
    }
    return ref.current;
  },
}));
jest.mock('@gitroom/frontend/components/media/media.component', () => ({ MediaBox: () => null }));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({ useModals: () => mockModal }));
import { VideoInputPicker, VideoInput } from './video-input-picker';

describe('Video input picker — existing uploader / Media UI wiring', () => {
  let container: HTMLDivElement, root: Root, request: jest.Mock, source: jest.Mock, reference: jest.Mock;
  const asset = { id: 'asset-1', postizMediaId: 'media-1', storageKey: '/uploads/group.mp4', fileName: 'group.mp4', sizeBytes: '1234', duration: 2 };
  const props = (label: string, onChange: jest.Mock, value: VideoInput | null = null) => ({
    label, description: '動画を選択', value, onChange, request, previewUrl: (path: string) => `/api/sns-studio/media/preview?path=${encodeURIComponent(path)}`,
  });
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mockUploaders.length = 0;
    mockModal.openModal.mockClear();
    request = jest.fn().mockResolvedValue(asset);
    source = jest.fn(); reference = jest.fn();
    container = document.createElement('div'); document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const mount = async (value: VideoInput | null = null) => act(async () => {
    root.render(React.createElement(VideoInputPicker, props('元動画', source, value)));
  });
  it('passes a PC file to the standard Postiz uploader, then registers by ID only', async () => {
    await mount();
    const input = container.querySelector('input')!;
    const file = new File(['test'], 'test.mp4', { type: 'video/mp4' });
    Object.defineProperty(input, 'files', { configurable: true, value: [file] });
    await act(async () => input.dispatchEvent(new Event('change', { bubbles: true })));
    expect(mockUploaders[0].addFile).toHaveBeenCalledWith({ name: 'test.mp4', type: 'video/mp4', data: file });
    expect(request).not.toHaveBeenCalled();
    await act(async () => mockUploaders[0].options.onUploadSuccess([{ id: 'media-1', path: 'untrusted ignored' }]));
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('/sns-studio/video-tools/inputs/media-1', { method: 'POST' });
    expect(source).toHaveBeenCalledWith(asset);
    expect(container.textContent).not.toContain('素材登録中');
  });
  it('uses the existing video Media selector and supports independent source/reference', async () => {
    await act(async () => root.render(React.createElement('div', null,
      React.createElement(VideoInputPicker, props('元動画', source)),
      React.createElement(VideoInputPicker, props('参考動画', reference)))));
    const sections = container.querySelectorAll('section');
    await act(async () => (sections[1].querySelectorAll('button')[1] as HTMLButtonElement).click());
    const options = mockModal.openModal.mock.calls[0][0];
    expect(options).toMatchObject({ fullScreen: true, size: 'calc(100% - 80px)', height: 'calc(100% - 80px)' });
    const picker = options.children(jest.fn());
    expect(picker.props.type).toBe('video');
    await act(async () => picker.props.setMedia([{ id: 'reference-2', path: '/uploads/not-trusted.mp4' }]));
    expect(reference).toHaveBeenCalledWith(asset);
    expect(source).not.toHaveBeenCalled();
    expect(request.mock.calls[0][0]).toBe('/sns-studio/video-tools/inputs/reference-2');
  });
  it('shows file metadata and authenticated preview; clearing never deletes media', async () => {
    await mount(asset);
    expect(container.textContent).toContain('group.mp4');
    expect(container.textContent).toContain('2.00秒');
    expect(container.querySelector('video')?.getAttribute('src')).toContain('/api/sns-studio/media/preview?path=');
    await act(async () => (Array.from(container.querySelectorAll('button')).find(b => b.textContent === '選択解除')!).click());
    expect(source).toHaveBeenCalledWith(null);
    expect(request).not.toHaveBeenCalled();
  });
  it('does not select a media until registration succeeds, and exposes failures', async () => {
    request.mockRejectedValue(new Error('別Organizationの素材は利用できません'));
    await mount();
    await act(async () => mockUploaders[0].options.onUploadSuccess([{ id: 'foreign' }]));
    expect(source).toHaveBeenCalledWith(null);
    expect(container.querySelector('[role=alert]')?.textContent).toContain('別Organization');
    expect(container.querySelector('video')).toBeNull();
  });
  it('refuses multiple selection and makes no registration call', async () => {
    await mount();
    await act(async () => (container.querySelectorAll('button')[1] as HTMLButtonElement).click());
    await act(async () => mockModal.openModal.mock.calls[0][0].children(jest.fn()).props.setMedia([{ id: 'one' }, { id: 'two' }]));
    expect(request).not.toHaveBeenCalled();
    expect(container.textContent).toContain('1件だけ');
  });
  it('ignores completed uploads after an Organization switch unmounts the picker', async () => {
    await mount();
    const complete = mockUploaders[0].options.onUploadSuccess;
    await act(async () => root.render(null));
    await act(async () => complete([{ id: 'old-org-media' }]));
    expect(request).not.toHaveBeenCalled(); expect(source).not.toHaveBeenCalled();
  });
});
