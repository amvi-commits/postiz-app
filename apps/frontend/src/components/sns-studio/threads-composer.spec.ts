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
  it('keeps drafts in existing /posts and only prepares a plan for execution', async () => {
    localStorage.setItem(selectionKey, selected); await mount();
    await mockComposerProps.onPreparePost({ type: 'draft', posts: [{ integration: { id: selected } }] });
    expect(mockFetch).not.toHaveBeenCalled();
    mockFetch.mockResolvedValue({ ok: true, json: async () => ({ id: 'plan-one' }) });
    await mockComposerProps.onPreparePost({ type: 'now', posts: [{ integration: { id: selected }, value: [{ content: 'Final' }] }] });
    await mockComposerProps.onBeforePost('now');
    expect(mockFetch.mock.calls.map(([path]) => path)).toEqual(['/sns-studio/content-plans', '/sns-studio/common/content-plans/plan-one/preflight']);
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
