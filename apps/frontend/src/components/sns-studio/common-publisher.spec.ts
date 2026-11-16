/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
const mockFetch = jest.fn();
const mockIntegrations = jest.fn();
const mockSWR = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({ useFetch: () => mockFetch }));
jest.mock('@gitroom/frontend/components/launches/helpers/use.integration.list', () => ({ useIntegrationList: () => mockIntegrations() }));
jest.mock('swr', () => ({ __esModule: true, default: (...args: unknown[]) => mockSWR(...args) }));
jest.mock('@gitroom/frontend/components/launches/calendar.context', () => ({ CalendarWeekProvider: ({ children }: any) => children }));
jest.mock('@gitroom/frontend/components/launches/new.post', () => ({ NewPost: () => null }));
jest.mock('@gitroom/frontend/components/layout/loading', () => ({ LoadingComponent: () => null }));
jest.mock('./common-account-policy', () => ({ CommonAccountPolicyPanel: () => null }));
import { SnsStudioCommonPublisher } from './common-publisher';
describe('common publisher destination prefill', () => {
  let container: HTMLDivElement;
  let root: Root;
  let accounts: any[] | undefined;
  let renders: number;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    accounts = [{ id: 'threads-1', name: 'Threads one', identifier: 'threads' }];
    renders = 0;
    mockFetch.mockReset();
    mockSWR.mockReturnValue({ data: [], mutate: jest.fn() });
    mockIntegrations.mockImplementation(() => {
      if (++renders > 25) throw new Error('destination prefill render loop');
      return { data: accounts?.map((account) => ({ ...account })), isLoading: false };
    });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT;
  });
  const mount = async (prefill: any) => {
    await act(async () => root.render(React.createElement(SnsStudioCommonPublisher, { prefill })));
  };
  const checkboxes = () => Array.from(container.querySelectorAll<HTMLInputElement>('input[type=checkbox]'));
  it('settles and selects preferred platform without requests', async () => {
    accounts!.push({ id: 'x-1', name: 'X one', identifier: 'x' });
    await mount({ preferredPlatform: 'threads', content: 'Draft' });
    expect(checkboxes().map((item) => item.checked)).toEqual([true, false]);
    expect(renders).toBeLessThan(10);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('settles with no matching accounts', async () => {
    await mount({ preferredPlatform: 'youtube' });
    expect(checkboxes()[0].checked).toBe(false);
    expect(renders).toBeLessThan(10);
  });
  it('handles missing data and arriving accounts', async () => {
    accounts = undefined;
    const prefill = { preferredPlatform: 'threads' };
    await mount(prefill);
    expect(renders).toBeLessThan(10);
    accounts = [{ id: 'threads-1', name: 'Threads one', identifier: 'threads' }];
    await mount(prefill);
    expect(checkboxes()[0].checked).toBe(true);
  });
  it('preserves user deselection across refetched arrays', async () => {
    const prefill = { preferredPlatform: 'threads' };
    await mount(prefill);
    await act(async () => checkboxes()[0].click());
    await mount(prefill);
    expect(checkboxes()[0].checked).toBe(false);
    expect(renders).toBeLessThan(15);
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('selects explicit destination and excludes disabled accounts', async () => {
    accounts!.push({ id: 'x-1', name: 'X one', identifier: 'x' });
    accounts!.push({ id: 'disabled', name: 'Disabled', identifier: 'threads', disabled: true });
    await mount({ initialDestinationId: 'x-1' });
    expect(checkboxes().map((item) => item.checked)).toEqual([false, true]);
    expect(renders).toBeLessThan(10);
  });
});
