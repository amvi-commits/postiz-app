/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);
const mockFetch = jest.fn();
let mockOrganization = 'org-one';
let mockAccountQuery: any;
let mockIntegrationQuery: any;
let mockComposerProps: any;
let mockExisting: any;
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({ useFetch: () => mockFetch }));
jest.mock('@gitroom/frontend/components/layout/user.context', () => ({ useUser: () => ({ orgId: mockOrganization }) }));
jest.mock('swr', () => ({ __esModule: true, default: ([, path]: string[]) => path === '/threads-studio/accounts' ? mockAccountQuery : mockIntegrationQuery }));
jest.mock('@gitroom/frontend/components/launches/calendar.context', () => ({ CalendarWeekProvider: ({ children }: any) => children }));
jest.mock('@gitroom/frontend/components/launches/helpers/use.existing.data', () => ({ ExistingDataContextProvider: ({ children, value }: any) => { mockExisting = value; return children; } }));
jest.mock('@gitroom/frontend/components/new-launch/add.edit.modal', () => ({ AddEditModal: (props: any) => { mockComposerProps = props; return React.createElement('div', null, 'Shared editor'); } }));
jest.mock('@gitroom/frontend/components/new-launch/store', () => ({ LaunchStoreProvider: ({ children }: any) => children }));
import { ThreadsComposer } from './threads/threads-composer';

describe('Threads inline wrapper / existing draft references', () => {
  let root: Root;
  let container: HTMLDivElement;
  const selected = 'threads-one';
  const selectionKey = 'sns-studio:threads-composer:org-one:selection';
  const journalKey = `sns-studio:threads-composer:org-one:${selected}`;
  const savedDraft = { integration: selected, group: 'saved-group', settings: { browserAccount: 'stored-alias' }, posts: [{ id: 'saved-post', state: 'DRAFT', content: 'Restored', image: [{ id: 'media-1', path: '/uploads/one.mp4' }], publishDate: '2026-12-01T00:00:00Z' }] };
  const mount = async () => { await act(async () => root.render(React.createElement(ThreadsComposer))); };
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    localStorage.clear(); mockOrganization = 'org-one'; mockComposerProps = undefined; mockExisting = undefined;
    mockAccountQuery = { data: [{ id: selected, name: 'elephant.399985', transport: 'browser', browserAccount: 'stored-alias', publishBlockedReason: 'Real post locked' }, { id: 'threads-two', name: 'Other', transport: 'official' }], isLoading: false };
    mockIntegrationQuery = { data: { integrations: [{ id: selected, identifier: 'threads' }, { id: 'threads-two', identifier: 'threads' }, { id: 'x-one', identifier: 'x' }] }, isLoading: false };
    mockFetch.mockReset(); mockFetch.mockResolvedValue({ ok: true, json: async () => savedDraft });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
  it('shows loading separately from disconnected accounts', async () => {
    mockAccountQuery = { isLoading: true }; await mount(); expect(container.textContent).toContain('取得中'); expect(container.textContent).not.toContain('接続してください');
  });
  it('shows errors separately from a successful empty account list', async () => {
    mockAccountQuery = { error: new Error('fetch') }; await mount(); expect(container.textContent).toContain('取得に失敗');
    mockAccountQuery = { data: [] }; await mount(); expect(container.textContent).toContain('接続してください');
  });
  it('restores the selected account and the same existing Postiz draft on reload', async () => {
    localStorage.setItem(selectionKey, selected); localStorage.setItem(journalKey, JSON.stringify({ state: 'draft', group: 'saved-group' }));
    await mount();
    expect(container.querySelector('select')?.value).toBe(selected);
    expect(mockFetch).toHaveBeenCalledWith('/posts/group/saved-group');
    expect(mockExisting).toEqual(savedDraft);
    expect(mockComposerProps.integrations.map((item: any) => item.id)).toEqual([selected]);
    expect(mockComposerProps.selectedChannels).toBeUndefined();
    expect(mockComposerProps.inline.blockedReason).toBe('Real post locked');
  });
  it('opens a public copy with both media items after selecting a destination', async () => {
    localStorage.setItem(selectionKey, selected);
    const copiedPost = {
      content: '<p>確認してみてください。</p>',
      media: [{ id: 'image', path: '/uploads/photo.jpg' }, { id: 'video', path: '/uploads/clip.mp4' }],
    };
    await act(async () => root.render(React.createElement(ThreadsComposer, { copiedPost })));
    const picker = container.querySelector('select')!;
    expect(picker.value).toBe('');
    await act(async () => {
      picker.value = selected;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mockComposerProps.onlyValuesByIntegration).toEqual({
      [selected]: [{ content: copiedPost.content, image: copiedPost.media }],
    });
    expect(mockComposerProps.inline.blockedReason).toBe('Real post locked');
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('does not put copied content in the editor of a recovered draft', async () => {
    localStorage.setItem(journalKey, JSON.stringify({ state: 'draft', group: 'saved-group' }));
    await act(async () => root.render(React.createElement(ThreadsComposer, {
      copiedPost: { content: '<p>Different copy</p>', media: [] },
    })));
    const picker = container.querySelector('select')!;
    await act(async () => {
      picker.value = selected;
      picker.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(mockExisting).toEqual(savedDraft);
    expect(mockComposerProps.onlyValuesByIntegration).toBeUndefined();
    expect(container.textContent).toContain('保存済み下書きを表示中');
    expect(mockFetch.mock.calls.map(([path]) => path)).toEqual(['/posts/group/saved-group']);
  });
  it('keeps drafts in existing /posts and only prepares a plan for execution', async () => {
    localStorage.setItem(selectionKey, selected); await mount();
    await mockComposerProps.onPreparePost({ type: 'draft', posts: [{ integration: { id: selected } }] });
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'plan-one' }) });
    await mockComposerProps.onPreparePost({ type: 'now', posts: [{ integration: { id: selected }, value: [{ content: 'Final' }] }] });
    await mockComposerProps.onBeforePost('now');
    expect(mockFetch.mock.calls.map(([path]) => path)).toEqual(['/sns-studio/content-plans', '/sns-studio/common/content-plans/plan-one/preflight']);
  });
  it('reads the returned Post ID to retain the server-assigned group after a first save', async () => {
    localStorage.setItem(selectionKey, selected); await mount();
    await act(async () => mockComposerProps.onPosted({ type: 'draft', group: 'client-proposal', items: [{ postId: 'saved-post', integration: selected }] }));
    expect(mockFetch).toHaveBeenCalledWith('/posts/saved-post');
    expect(mockFetch).not.toHaveBeenCalledWith('/posts/group/client-proposal');
    expect(JSON.parse(localStorage.getItem(journalKey)!)).toEqual({ state: 'draft', group: 'saved-group', postId: 'saved-post' });
    expect(mockExisting).toEqual(savedDraft);
    expect(container.textContent).toContain('下書きを保存しました');
    expect(mockComposerProps.inline.submissionBlocked).toBe(false);
  });
  it('recovers an accepted draft read on reload by Post ID without another create request', async () => {
    localStorage.setItem(selectionKey, selected);
    localStorage.setItem(journalKey, JSON.stringify({ state: 'accepted', group: 'client-proposal', result: { type: 'draft', items: [{ postId: 'saved-post' }] } }));
    await mount();
    expect(mockFetch.mock.calls.map(([path]) => path)).toEqual(['/posts/saved-post']);
    expect(mockExisting).toEqual(savedDraft);
    expect(JSON.parse(localStorage.getItem(journalKey)!)).toMatchObject({ state: 'draft', group: 'saved-group', postId: 'saved-post' });
    expect(mockComposerProps.inline.submissionBlocked).toBe(false);
  });
  it('keeps the same Post ID when the existing dashboard API rotates its group on an edit', async () => {
    localStorage.setItem(selectionKey, selected); await mount();
    await act(async () => mockComposerProps.onPosted({ type: 'draft', group: 'client-proposal', items: [{ postId: 'saved-post' }] }));
    const updated = { ...savedDraft, group: 'server-rotated-group', posts: [{ ...savedDraft.posts[0], content: 'Edited draft' }] };
    mockFetch.mockResolvedValue({ ok: true, json: async () => updated });
    await act(async () => mockComposerProps.onPosted({ type: 'draft', group: 'saved-group', items: [{ postId: 'saved-post' }] }));
    expect(mockExisting).toEqual(updated);
    expect(JSON.parse(localStorage.getItem(journalKey)!)).toEqual({ state: 'draft', group: 'server-rotated-group', postId: 'saved-post' });
    expect(mockFetch.mock.calls.map(([path]) => path)).toEqual(['/posts/saved-post', '/posts/saved-post']);
  });
  it('retains accepted IDs and blocks another create when the canonical draft read fails', async () => {
    localStorage.setItem(selectionKey, selected); await mount();
    mockFetch.mockResolvedValue({ ok: false });
    await expect(act(async () => mockComposerProps.onPosted({ type: 'draft', group: 'client-proposal', items: [{ postId: 'saved-post' }] }))).rejects.toThrow('保存済み下書き');
    expect(JSON.parse(localStorage.getItem(journalKey)!)).toMatchObject({ state: 'accepted', result: { items: [{ postId: 'saved-post' }] } });
    expect(mockFetch.mock.calls.map(([path]) => path)).toEqual(['/posts/saved-post']);
  });
  it('does not carry selected accounts or draft values into another Organization', async () => {
    localStorage.setItem(selectionKey, selected); localStorage.setItem(journalKey, JSON.stringify({ state: 'draft', group: 'saved-group' })); await mount();
    mockOrganization = 'org-two'; mockFetch.mockClear(); await mount();
    expect(container.querySelector('select')?.value).toBe(''); expect(mockFetch).not.toHaveBeenCalled();
  });
  it('does not resubmit a remembered ambiguous request', async () => {
    localStorage.setItem(selectionKey, selected); localStorage.setItem(journalKey, JSON.stringify({ state: 'sending', group: 'pending-group', planId: 'plan-pending' })); await mount();
    expect(mockComposerProps.inline.submissionBlocked).toBe(true); expect(mockFetch).not.toHaveBeenCalled(); expect(container.textContent).toContain('自動再送はしません');
  });
});
