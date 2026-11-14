/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
import timezone from 'dayjs/plugin/timezone';
dayjs.extend(utc); dayjs.extend(timezone);

const mockFetch = jest.fn();
const mockToast = jest.fn();
const mockModal = { openModal: jest.fn(), closeAll: jest.fn() };
let mockText = 'Test draft';
let mockMedia: any[] = [];
let mockPostId: string | undefined;
let mockExisting: any;
let mockStore: any;
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({ useFetch: () => mockFetch }));
jest.mock('@gitroom/react/toaster/toaster', () => ({ useToaster: () => ({ show: mockToast }) }));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({ useT: () => (_: string, text: string) => text }));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({ useModals: () => mockModal }));
jest.mock('@gitroom/frontend/components/launches/helpers/use.existing.data', () => ({ useExistingData: () => mockExisting }));
jest.mock('@gitroom/frontend/components/new-launch/store', () => ({ useLaunchStore: (selector: any) => selector(mockStore), useLaunchScope: () => 'test-editor', launchEditorTarget: (scope: string, target: string) => `[data-launch-editor-scope="${scope}"] ${target}` }));
jest.mock('@gitroom/frontend/components/new-launch/editor', () => ({ EditorWrapper: () => React.createElement(React.Fragment, null, React.createElement('textarea', { 'aria-label': '投稿本文', defaultValue: mockText, onChange: (event: any) => { mockText = event.target.value; } }), React.createElement('span', null, `添付${mockMedia.length}件`)) }));
jest.mock('@gitroom/frontend/components/new-launch/providers/show.all.providers', () => {
  const R = require('react');
  return { ShowAllProviders: R.forwardRef((_: any, ref: any) => {
    R.useImperativeHandle(ref, () => ({ getAllValues: async () => [{ id: 'threads-1', settings: { browserAccount: 'saved-profile' }, values: [{ id: mockPostId, content: mockText, media: mockMedia }] }] }));
    return R.createElement('div', null, 'Post preview');
  }) };
});
jest.mock('@gitroom/frontend/components/settings/shortlink-preference.component', () => ({ useShortlinkPreference: () => ({ data: { shortlink: 'NO' } }) }));
jest.mock('@gitroom/frontend/components/new-launch/picks.socials.component', () => ({ PicksSocialsComponent: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/select.current', () => ({ SelectCurrent: () => null }));
jest.mock('@gitroom/frontend/components/launches/helpers/date.picker', () => ({ DatePicker: () => null }));
jest.mock('@gitroom/frontend/components/launches/repeat.component', () => ({ RepeatComponent: () => null }));
jest.mock('@gitroom/frontend/components/launches/tags.component', () => ({ TagsComponent: () => null }));
jest.mock('@gitroom/frontend/components/launches/select.customer', () => ({ SelectCustomer: () => null }));
jest.mock('@gitroom/frontend/components/launches/creation.method.badge', () => ({ CreationMethodBadge: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/dummy.code.component', () => ({ DummyCodeComponent: () => null }));
jest.mock('@copilotkit/react-ui', () => ({ CopilotPopup: () => null }));
jest.mock('@gitroom/frontend/components/ui/icons', () => new Proxy({}, { get: () => () => null }));
jest.mock('@gitroom/frontend/components/ui/is.scroll.hook', () => ({ useHasScroll: () => false }));
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({ deleteDialog: jest.fn() }));
import { ManageModal } from '../new-launch/manage.modal';

describe('embedded existing Postiz editor / fake executor', () => {
  let container: HTMLDivElement;
  let root: Root;
  const response = (body: any, status = 200) => ({ ok: status < 400, status, json: async () => body });
  const postRequests = () => mockFetch.mock.calls.filter(([path]) => path === '/posts');
  const button = (text: string) => Array.from(container.querySelectorAll('button')).find(item => item.textContent === text)!;
  const click = async (text: string) => { await act(async () => { button(text).click(); }); };
  const mount = async (extra: any = {}) => {
    await act(async () => root.render(React.createElement(ManageModal, { date: mockStore.date, integrations: [mockStore.integrations[0]], reopenModal: () => undefined, mutate: () => undefined, inline: { title: 'Threads 投稿作成', ...extra.inline }, ...Object.fromEntries(Object.entries(extra).filter(([key]) => key !== 'inline')) })));
  };
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mockText = 'Test draft'; mockMedia = [{ id: 'owned-media', path: '/uploads/owned.mp4' }]; mockPostId = undefined;
    mockExisting = { integration: '', group: undefined, posts: [], settings: {} };
    const integration = { id: 'threads-1', name: 'elephant.399985 [Browser]', identifier: 'threads' };
    mockStore = { selectedIntegrations: [{ integration }], integrations: [integration], current: 'threads-1', hide: false, locked: false, date: dayjs().add(1, 'day'), tags: [], repeater: undefined, setDate: jest.fn(), setHide: jest.fn(), setTags: jest.fn(), setRepeater: jest.fn(), setSelectedIntegrations: jest.fn() };
    mockFetch.mockReset(); mockToast.mockReset(); mockModal.openModal.mockReset(); mockModal.closeAll.mockReset();
    mockFetch.mockImplementation(async (path: string) => path === '/posts/valid'
      ? response([{ id: 'threads-1', identifier: 'threads', name: 'Actor', emptyContent: false, valid: true, errors: true, tooLong: false }])
      : response([{ postId: 'draft-post-1', integration: 'threads-1' }]));
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });

  it('saves through /posts as a draft, retaining media and the saved Browser alias', async () => {
    const posted = jest.fn(); await mount({ onPosted: posted }); await click('下書き保存');
    const payload = JSON.parse(postRequests()[0][1].body);
    expect(payload.type).toBe('draft'); expect(payload.posts).toHaveLength(1);
    expect(payload.posts[0]).toMatchObject({ integration: { id: 'threads-1' }, settings: { browserAccount: 'saved-profile' }, value: [{ content: 'Test draft', image: [{ id: 'owned-media', path: '/uploads/owned.mp4' }] }] });
    expect(posted).toHaveBeenCalledWith(expect.objectContaining({ type: 'draft', group: expect.any(String), items: [expect.objectContaining({ postId: 'draft-post-1' })] }));
    expect(mockModal.openModal).not.toHaveBeenCalled(); expect(mockModal.closeAll).not.toHaveBeenCalled();
  });
  it('preserves the existing draft group and post ID when editing', async () => {
    mockPostId = 'saved-root'; mockExisting = { integration: 'threads-1', group: 'saved-group', posts: [{ state: 'DRAFT' }] };
    await mount(); await click('下書き保存');
    expect(JSON.parse(postRequests()[0][1].body).posts[0]).toMatchObject({ group: 'saved-group', value: [{ id: 'saved-root' }] });
  });
  it('runs prepare then policy preflight then the existing executor only after confirmation', async () => {
    const order: string[] = [];
    await mount({ onPreparePost: async () => { order.push('save'); return 'plan-1'; }, onBeforePost: async () => { order.push('policy'); }, onPosted: async () => { order.push('link'); } });
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation(async (...args: any[]) => { if (args[0] === '/posts') order.push('post'); return original(...args); });
    await click('予約する'); expect(postRequests()).toHaveLength(0); expect(order).toEqual([]);
    expect(container.textContent).toContain('予約内容の確認'); expect(container.textContent).toContain('日本時間');
    await click('この日時で予約する');
    expect(order).toEqual(['save', 'policy', 'post', 'link']);
    expect(JSON.parse(postRequests()[0][1].body).snsStudioContentPlanId).toBe('plan-1');
  });
  it('keeps the input and does not send when preparation fails', async () => {
    await mount({ onPreparePost: async () => { throw new Error('save failed'); } }); await click('下書き保存');
    expect(postRequests()).toHaveLength(0); expect(container.textContent).toContain('save failed');
    expect(container.querySelector('textarea')?.value).toBe('Test draft'); expect(container.textContent).toContain('添付1件');
  });
  it('does not send after a policy block', async () => {
    await mount({ onBeforePost: async () => { throw new Error('approval required'); } }); await click('今すぐ投稿'); await click('内容を確認して投稿する');
    expect(postRequests()).toHaveLength(0); expect(mockToast).toHaveBeenCalledWith('approval required', 'warning');
  });
  it('suppresses duplicate clicks before asynchronous validation completes', async () => {
    let resolve!: (value: any) => void;
    mockFetch.mockImplementation((path: string) => path === '/posts/valid' ? new Promise(value => { resolve = value; }) : Promise.resolve(response([{ postId: 'post-1', integration: 'threads-1' }])));
    await mount(); await act(async () => { button('下書き保存').click(); button('下書き保存').click(); });
    await act(async () => resolve(response([{ id: 'threads-1', emptyContent: false, valid: true, errors: true }])));
    expect(postRequests()).toHaveLength(1);
  });
  it('never repeats accepted posts to repair a tracking failure', async () => {
    await mount({ onPosted: async () => { throw new Error('link failed'); } }); await click('下書き保存'); await click('下書き保存');
    expect(postRequests()).toHaveLength(1); expect(container.textContent).toContain('履歴との紐付けを確認'); expect(container.textContent).not.toContain('下書きを保存しました。');
  });
  it('locks ambiguous network results without clearing text/media or automatically retrying', async () => {
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((...args: any[]) => args[0] === '/posts' ? Promise.reject(new Error('timeout')) : original(...args));
    await mount(); await click('下書き保存'); await click('下書き保存');
    expect(postRequests()).toHaveLength(1); expect(container.textContent).toContain('結果を確認できません'); expect(container.querySelector('textarea')?.value).toBe('Test draft'); expect(container.textContent).toContain('添付1件');
  });
  it('shows the real-post lock in confirmation without calling any executor', async () => {
    await mount({ inline: { blockedReason: 'Browser投稿ロック中' } }); await click('今すぐ投稿');
    expect(button('内容を確認して投稿する').disabled).toBe(true); await click('内容を確認して投稿する'); expect(postRequests()).toHaveLength(0);
  });
  it('cancels confirmation without sending or discarding input', async () => {
    await mount(); await click('今すぐ投稿'); await click('編集に戻る'); expect(postRequests()).toHaveLength(0); expect(container.querySelector('textarea')?.value).toBe('Test draft');
  });
  it('stops an old screen after unmount/organization switch before submission', async () => {
    let resolve!: (value: any) => void;
    mockFetch.mockImplementation(() => new Promise(value => { resolve = value; }));
    await mount(); await click('下書き保存'); await act(async () => root.render(React.createElement('div', null, 'Another organization')));
    await act(async () => resolve(response([{ id: 'threads-1', emptyContent: false }])));
    expect(postRequests()).toHaveLength(0);
  });
  it('rejects a past schedule before creating a plan or post', async () => {
    mockStore.date = dayjs().subtract(1, 'day'); const prepare = jest.fn();
    await mount({ onPreparePost: prepare }); await click('予約する');
    expect(container.textContent).toContain('未来の日本時間'); expect(prepare).not.toHaveBeenCalled(); expect(postRequests()).toHaveLength(0);
  });
  it('disables submission and explains pending attachment processing', async () => {
    mockStore.locked = true; await mount();
    expect(button('下書き保存').disabled).toBe(true); expect(button('予約する').disabled).toBe(true); expect(button('今すぐ投稿').disabled).toBe(true);
    expect(container.textContent).toContain('添付の処理'); await click('下書き保存'); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('treats a server error after submission as ambiguous instead of automatically repeating', async () => {
    const original = mockFetch.getMockImplementation()!;
    mockFetch.mockImplementation((...args: any[]) => args[0] === '/posts' ? Promise.resolve(response({}, 500)) : original(...args));
    await mount(); await click('下書き保存'); await click('下書き保存'); expect(postRequests()).toHaveLength(1); expect(button('下書き保存').disabled).toBe(true);
  });
});
