/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
const mockSelect = jest.fn();
const mockCurrent = jest.fn();
const accounts = [{ id: 'a', name: 'same', transport: 'browser', browserAccount: 'first' }, { id: 'b', name: 'same', transport: 'browser', browserAccount: 'second' }];
jest.mock('@gitroom/frontend/components/new-launch/store', () => ({ useLaunchStore: (selector: any) => selector({ integrations: accounts, selectedIntegrations: [], setSelectedIntegrations: mockSelect, setCurrent: mockCurrent }) }));
jest.mock('@gitroom/frontend/components/launches/helpers/use.existing.data', () => ({ useExistingData: () => ({}) }));
jest.mock('@gitroom/react/helpers/safe.image', () => ({ __esModule: true, default: () => null }));
jest.mock('@gitroom/react/helpers/image.with.fallback', () => ({ __esModule: true, default: () => null }));
import { PicksSocialsComponent } from '@gitroom/frontend/components/new-launch/picks.socials.component';
it('selects exactly one saved account by ID, preserves its binding, and leaves the main input editable', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); const root = createRoot(container);
  await act(async () => root.render(React.createElement(PicksSocialsComponent, { single: true })));
  await act(async () => { const select = container.querySelector('select')!; select.value = 'b'; select.dispatchEvent(new Event('change', { bubbles: true })); });
  expect(mockSelect).toHaveBeenCalledWith([{ selectedIntegrations: accounts[1], settings: { browserAccount: 'second' } }]);
  expect(mockCurrent).toHaveBeenCalledWith('global');
  await act(async () => root.unmount());
});
