/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot, Root } from 'react-dom/client';
import dayjs from 'dayjs';
const mockOpen = jest.fn();
const mockFetch = jest.fn();
const mockToast = jest.fn();
jest.mock('@gitroom/helpers/utils/custom.fetch', () => ({ useFetch: () => mockFetch }));
jest.mock('@gitroom/react/toaster/toaster', () => ({ useToaster: () => ({ show: mockToast }) }));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({ useT: () => (_: string, fallback: string) => fallback }));
jest.mock('@gitroom/frontend/components/layout/new-modal', () => ({ useModals: () => ({ openModal: mockOpen, closeAll: jest.fn() }) }));
jest.mock('@gitroom/frontend/components/launches/calendar.context', () => ({ useCalendar: () => ({ integrations: [{ id: 'account-one' }], sets: [], reloadCalendarView: jest.fn() }) }));
jest.mock('@gitroom/frontend/components/launches/calendar', () => ({ SetSelectionModal: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/add.edit.modal', () => ({ AddEditModal: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/modal.wrapper.component', () => ({ ModalWrapperComponent: () => null }));
import { NewPost } from '../launches/new.post';

describe('shared editor explicit preparation', () => {
  let root: Root, container: HTMLDivElement;
  beforeEach(() => {
    (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
    mockOpen.mockReset(); mockFetch.mockReset(); mockToast.mockReset();
    container = document.createElement('div'); document.body.appendChild(container); root = createRoot(container);
  });
  afterEach(async () => { await act(async () => root.unmount()); container.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; });
  it('prepares once and gives the editor the fresh plan and callbacks in one user action', async () => {
    const before = jest.fn(), posted = jest.fn();
    const prepare = jest.fn().mockResolvedValue({ commonContentPlanId: 'new-plan', onBeforePost: before, onPosted: posted });
    await act(async () => root.render(React.createElement(NewPost, { date: dayjs().add(1, 'day'), beforeOpen: prepare, selectedChannels: ['account-one'] })));
    await act(async () => { container.querySelector('button')!.click(); container.querySelector('button')!.click(); });
    expect(prepare).toHaveBeenCalledTimes(1); expect(mockOpen).toHaveBeenCalledTimes(1);
    expect(mockOpen.mock.calls[0][0].children.props).toMatchObject({ commonContentPlanId: 'new-plan', onBeforePost: before, onPosted: posted, selectedChannels: ['account-one'] });
    expect(mockFetch).not.toHaveBeenCalled();
  });
  it('does not open or post if internal saving fails', async () => {
    await act(async () => root.render(React.createElement(NewPost, { beforeOpen: async () => { throw new Error('Save failed'); } })));
    await act(async () => container.querySelector('button')!.click());
    expect(mockOpen).not.toHaveBeenCalled(); expect(mockFetch).not.toHaveBeenCalled(); expect(mockToast).toHaveBeenCalledWith('Save failed', 'warning');
  });
});
