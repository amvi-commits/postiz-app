/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import dayjs from 'dayjs';
import utc from 'dayjs/plugin/utc';
dayjs.extend(utc);
const mockFetch = jest.fn();
const mockValues = jest.fn();
const mockConfirm = jest.fn();
const mockToast = jest.fn();
let mockState: any;
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({ useFetch: () => mockFetch }));
jest.mock('@gitroom/frontend/components/new-launch/store', () => ({ useLaunchStore: (selector: any) => selector(mockState) }));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({ useT: () => (_key: string, fallback: string) => fallback }));
jest.mock('@gitroom/frontend/components/launches/helpers/use.existing.data', () => ({ useExistingData: () => ({ posts: [] }) }));
jest.mock('@gitroom/frontend/components/settings/shortlink-preference.component', () => ({ useShortlinkPreference: () => ({ data: { shortlink: 'NO' } }) }));
jest.mock('@gitroom/react/toaster/toaster', () => ({ useToaster: () => ({ show: mockToast }) }));
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({ deleteDialog: (...args: any[]) => mockConfirm(...args) }));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({ useModals: () => ({ closeAll: jest.fn() }) }));
jest.mock('@copilotkit/react-ui', () => ({ CopilotPopup: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/providers/show.all.providers', () => {
  const React = require('react');
  return { ShowAllProviders: React.forwardRef((_props: any, ref: any) => { React.useImperativeHandle(ref, () => ({ getAllValues: mockValues })); return null; }) };
});
jest.mock('@gitroom/frontend/components/new-launch/picks.socials.component', () => ({ PicksSocialsComponent: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/editor', () => ({ EditorWrapper: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/select.current', () => ({ SelectCurrent: () => null }));
jest.mock('@gitroom/frontend/components/launches/helpers/date.picker', () => ({ DatePicker: () => null }));
jest.mock('@gitroom/frontend/components/launches/repeat.component', () => ({ RepeatComponent: () => null }));
jest.mock('@gitroom/frontend/components/launches/tags.component', () => ({ TagsComponent: () => null }));
jest.mock('@gitroom/frontend/components/launches/select.customer', () => ({ SelectCustomer: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/dummy.code.component', () => ({ DummyCodeComponent: () => null }));
jest.mock('@gitroom/frontend/components/launches/creation.method.badge', () => ({ CreationMethodBadge: () => null }));
jest.mock('@gitroom/frontend/components/ui/is.scroll.hook', () => ({ useHasScroll: () => false }));
jest.mock('@gitroom/frontend/components/ui/icons', () => ({ SettingsIcon: () => null, ChevronDownIcon: () => null, CloseIcon: () => null, TrashIcon: () => null, DropdownArrowSmallIcon: () => null }));
jest.mock('@gitroom/react/form/button', () => ({ Button: () => null }));
import { ManageModal } from '@gitroom/frontend/components/new-launch/manage.modal';

describe('shared submission engine embedded in SNS Studio (all endpoints fake)', () => {
  let root: Root;
  let container: HTMLDivElement;
  let prepare: jest.Mock;
  let preflight: jest.Mock;
  let posted: jest.Mock;
  let uncertain: jest.Mock;
  let order: string[];
  const ok = (body: any) => ({ ok: true, json: async () => body });
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    (globalThis as any).structuredClone = (v: any) => require('v8').deserialize(require('v8').serialize(v));
    order = []; mockFetch.mockReset(); mockValues.mockReset(); mockConfirm.mockReset().mockResolvedValue(true); mockToast.mockReset();
    const integration = { id: 'a', name: 'Fake Official', identifier: 'threads', transport: 'official' };
    mockState = { selectedIntegrations: [{ integration }], integrations: [integration], current: 'global', date: dayjs('2030-01-01'), tags: [], locked: false, setHide: jest.fn(), setDate: jest.fn(), setTags: jest.fn(), setRepeater: jest.fn() };
    mockValues.mockResolvedValue([{ id: 'a', settings: {}, values: [{ content: 'isolated test', media: [] }] }]);
    prepare = jest.fn(async () => { order.push('save'); return 'plan'; });
    preflight = jest.fn(async () => { order.push('preflight'); });
    posted = jest.fn(async () => { order.push('link'); }); uncertain = jest.fn();
    mockFetch.mockImplementation(async (path: string) => {
      order.push(path);
      return path === '/posts/valid' ? ok([{ id: 'a', valid: true, errors: true }]) : ok([{ postId: 'post', integration: 'a' }]);
    });
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); });
  const mount = async () => act(async () => root.render(React.createElement(ManageModal, { embedded: true, singleDestination: true, date: mockState.date, integrations: mockState.integrations, mutate: jest.fn(), reopenModal: jest.fn(), preparePost: prepare, onBeforePost: preflight, onPosted: posted, onSubmissionUncertain: uncertain })));
  const button = (text: string) => Array.from(container.querySelectorAll('button')).find(b => b.textContent?.trim() === text)!;
  it('saves a draft using the existing Post API without scheduling it', async () => {
    await mount(); await act(async () => button('下書き保存').click());
    expect(order).toEqual(['/posts/valid', 'save', '/posts', 'link']);
    const data = JSON.parse(mockFetch.mock.calls.find(c => c[0] === '/posts')[1].body);
    expect(data.type).toBe('draft'); expect(data.snsStudioContentPlanId).toBe('plan');
    expect(preflight).not.toHaveBeenCalled();
  });
  it.each(['予約する', '今すぐ投稿'])('uses validation → save → preflight → registration → links for %s', async label => {
    await mount(); await act(async () => button(label).click());
    expect(order).toEqual(['/posts/valid', 'save', 'preflight', '/posts', 'link']);
    expect(mockConfirm).toHaveBeenCalledTimes(1);
  });
  it('suppresses double clicks and subsequent registration attempts', async () => {
    await mount(); await act(async () => { button('下書き保存').click(); button('下書き保存').click(); });
    await act(async () => button('下書き保存').click());
    expect(mockFetch.mock.calls.filter(c => c[0] === '/posts')).toHaveLength(1);
  });
  it('does not register after saving fails', async () => {
    prepare.mockRejectedValue(new Error('save failed')); await mount(); await act(async () => button('下書き保存').click());
    expect(mockFetch.mock.calls.some(c => c[0] === '/posts')).toBe(false); expect(posted).not.toHaveBeenCalled();
  });
  it('does not register after policy preflight rejects', async () => {
    preflight.mockRejectedValue(new Error('policy blocked')); await mount(); await act(async () => button('今すぐ投稿').click());
    expect(mockFetch.mock.calls.some(c => c[0] === '/posts')).toBe(false);
  });
  it('never retries a timed out registration', async () => {
    mockFetch.mockImplementation(async (path: string) => { if (path === '/posts') throw new Error('timeout'); return ok([{ id: 'a', valid: true, errors: true }]); });
    await mount(); await act(async () => button('下書き保存').click()); await act(async () => button('下書き保存').click());
    expect(mockFetch.mock.calls.filter(c => c[0] === '/posts')).toHaveLength(1); expect(uncertain).toHaveBeenCalled();
  });
  it('never retries after tracking fails following acceptance', async () => {
    posted.mockRejectedValue(new Error('link failed')); await mount(); await act(async () => button('下書き保存').click()); await act(async () => button('下書き保存').click());
    expect(mockFetch.mock.calls.filter(c => c[0] === '/posts')).toHaveLength(1);
  });
  it('keeps Browser real sending locked after confirmation', async () => {
    mockState.selectedIntegrations[0].integration.transport = 'browser';
    await mount(); await act(async () => button('今すぐ投稿').click());
    expect(mockConfirm).toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
    expect(mockFetch.mock.calls.some(c => c[0] === '/posts')).toBe(false);
  });
  it('rejects past reservations without creating records', async () => {
    mockState.date = dayjs('2000-01-01'); await mount(); await act(async () => button('予約する').click());
    expect(mockFetch).not.toHaveBeenCalled(); expect(prepare).not.toHaveBeenCalled();
  });
});
