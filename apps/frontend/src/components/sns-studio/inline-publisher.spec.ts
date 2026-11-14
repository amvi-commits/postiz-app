/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
const mockRequest = jest.fn();
const mockIntegrations = jest.fn();
const mockComposer = jest.fn();
const mockMutate = jest.fn();
let mockThreads: any = [];
let mockUser = { orgId: 'test-org' };
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({ useFetch: () => mockRequest }));
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({ useUser: () => mockUser }));
jest.mock('@gitroom/frontend/components/launches/helpers/use.integration.list', () => ({ useIntegrationList: () => mockIntegrations() }));
jest.mock('@gitroom/frontend/components/new-launch/store', () => ({ useLaunchStore: () => () => {} }));
jest.mock('@gitroom/frontend/components/new-launch/add.edit.modal', () => ({ AddEditModal: (props: any) => { mockComposer(props); return null; } }));
jest.mock('swr', () => ({ __esModule: true, default: (key: any) => ({ data: key?.[0] === '/threads-studio/accounts' ? mockThreads : [], mutate: mockMutate }) }));
import { InlinePublisher } from './inline-publisher';

describe('inline publisher with fake shared composer and isolated API', () => {
  let root: Root;
  let container: HTMLDivElement;
  const account = { id: 'a', identifier: 'threads', name: 'same display name', disabled: false, inBetweenSteps: false };
  const snapshot = { date: '2030-01-01T00:00:00Z', posts: [{ integration: { id: 'a' }, settings: { replyControl: 'everyone', browserAccount: 'test-profile' }, value: [{ content: 'draft', image: [{ id: 'media', path: '/uploads/test.png' }] }] }] };
  const ok = (data: any) => ({ ok: true, status: 200, json: async () => data });
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mockUser = { orgId: 'test-org' };
    mockRequest.mockReset(); mockComposer.mockClear(); mockMutate.mockClear();
    mockThreads = [{ id: 'a', username: 'fake_browser', transport: 'browser', isBrowser: true, browserAccount: 'test-profile' }];
    mockIntegrations.mockReturnValue({ data: [account], isLoading: false });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const mount = async (key = 'test-org') => act(async () => root.render(React.createElement(InlinePublisher, {key, threadsOnly: true})));
  const props = () => mockComposer.mock.calls[mockComposer.mock.calls.length - 1][0];
  it('does not save, reserve, or publish when opening the form', async () => {
    await mount(); expect(mockRequest).not.toHaveBeenCalled();
    expect(container.textContent).toContain('Threads 投稿作成');
  });
  it('filters other SNS and binds Browser metadata by integration ID', async () => {
    mockIntegrations.mockReturnValue({ data: [account, { ...account, id: 'b' }, { ...account, id: 'x', identifier: 'x' }], isLoading: false });
    await mount(); expect(props().integrations).toHaveLength(2);
    expect(props().integrations[0].transport).toBe('browser');
    expect(props().integrations[1].transport).toBe('unknown');
    expect(props().singleDestination).toBe(true);
  });
  it('shows loading separately from zero connected accounts', async () => {
    mockIntegrations.mockReturnValue({ data: [], isLoading: true }); await mount();
    expect(container.textContent).toContain('読み込み中');
    mockIntegrations.mockReturnValue({ data: [], isLoading: false }); await mount();
    expect(container.textContent).toContain('Threadsアカウントを接続してください');
  });
  it('shows account retrieval errors', async () => {
    mockIntegrations.mockReturnValue({ data: [], error: new Error('failed'), isLoading: false }); await mount();
    expect(container.querySelector('[role=alert]')?.textContent).toContain('取得に失敗');
  });
  it('saves a plan before policy preflight without registering a Post itself', async () => {
    mockRequest.mockResolvedValue(ok({ id: 'plan' })); await mount();
    await act(async () => { await props().preparePost('schedule', snapshot); await props().onBeforePost('schedule'); });
    expect(mockRequest.mock.calls.map(c => c[0])).toEqual(['/sns-studio/content-plans', '/sns-studio/common/content-plans/plan/preflight']);
    const payload = JSON.parse(mockRequest.mock.calls[0][1].body);
    expect(payload.deliveries[0].settingsOverride).toEqual(snapshot.posts[0].settings);
    expect(payload.deliveries[0].providerSettingsSnapshot).toBeUndefined();
    expect(snapshot.posts[0].value[0].image).toHaveLength(1);
  });
  it('rehydrates the canonical draft after linking and reuses its plan on edits', async () => {
    mockRequest.mockImplementation(async (path: string) => path === '/posts/draft-id' ? ok({ integration: 'a', group: 'group', settings: {}, posts: [{ id: 'draft-id', state: 'DRAFT', content: 'draft', image: snapshot.posts[0].value[0].image }] }) : ok({ id: 'plan' }));
    await mount(); await act(async () => { await props().preparePost('draft', snapshot); await props().onPosted({ type: 'draft', items: [{ postId: 'draft-id', integration: 'a', date: snapshot.date }] }); });
    await act(async () => { expect(await props().preparePost('draft', snapshot)).toBe('plan'); });
    expect(mockRequest.mock.calls.filter(c => c[0] === '/sns-studio/content-plans')).toHaveLength(1);
    expect(container.textContent).toContain('同じ下書きを更新');
  });
  it('blocks resubmission after uncertain registration', async () => {
    await mount(); await act(async () => props().onSubmissionUncertain());
    expect(props().submissionBlocked).toBe(true);
    await act(async () => { await expect(props().preparePost('now', snapshot)).rejects.toThrow('再送'); });
    expect(mockRequest).not.toHaveBeenCalled();
  });
  it('does not offer resend after Post acceptance but tracking failure', async () => {
    mockRequest.mockImplementation(async (path: string) => path.endsWith('/post-links') ? { ok: false } : ok({ id: 'plan' }));
    await mount(); await act(async () => { await props().preparePost('now', snapshot); await props().onPosted({ type: 'now', items: [{ postId: 'accepted', integration: 'a' }] }); });
    expect(props().submissionBlocked).toBe(true);
    expect(container.textContent).toContain('再投稿せず');
  });
  it('invalidates the previous organization submission after remount', async () => {
    await mount(); const old = props(); mockUser = { orgId: 'other-org' }; await mount('other-org');
    expect(old.isSubmissionCurrent()).toBe(false);
    await expect(old.preparePost('draft', snapshot)).rejects.toThrow('Organization');
    expect(props().isSubmissionCurrent()).toBe(true);
  });
});
