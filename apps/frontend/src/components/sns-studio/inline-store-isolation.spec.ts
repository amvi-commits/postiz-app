/** @jest-environment jsdom */
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { LaunchStoreProvider, useLaunchStore, useLaunchScope, launchEditorTarget } from '../new-launch/store';

function Draft({ label }: { label: string }) {
  const scope = useLaunchScope();
  const text = useLaunchStore(state => state.global[0]?.content || '');
  const set = useLaunchStore(state => state.setGlobalValue);
  const reset = useLaunchStore(state => state.reset);
  return React.createElement('section', { 'aria-label': label, 'data-launch-editor-scope': scope },
    React.createElement('div', { id: 'social-settings' }),
    React.createElement('p', null, text),
    React.createElement('button', { onClick: () => set([{ id: label, content: label, delay: 0, media: [] }]) }, `write-${label}`),
    React.createElement('button', { onClick: reset }, `reset-${label}`));
}
it('isolates the embedded draft from another embedded editor and the existing modal store', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container = document.createElement('div'); document.body.appendChild(container);
  const root = createRoot(container);
  try {
    await act(async () => root.render(React.createElement(React.Fragment, null,
      React.createElement(Draft, { label: 'modal' }),
      React.createElement(LaunchStoreProvider, null, React.createElement(Draft, { label: 'inline-one' })),
      React.createElement(LaunchStoreProvider, null, React.createElement(Draft, { label: 'inline-two' })))));
    const click = async (text: string) => { await act(async () => { Array.from(container.querySelectorAll('button')).find(button => button.textContent === text)!.click(); }); };
    const value = (label: string) => container.querySelector(`section[aria-label="${label}"] p`)?.textContent;
    await click('write-inline-one'); expect(value('inline-one')).toBe('inline-one'); expect(value('inline-two')).toBe(''); expect(value('modal')).toBe('');
    await click('write-modal'); expect(value('inline-one')).toBe('inline-one'); expect(value('modal')).toBe('modal');
    for (const label of ['modal', 'inline-one', 'inline-two']) {
      const section = container.querySelector(`section[aria-label="${label}"]`)!;
      const selector = launchEditorTarget(section.getAttribute('data-launch-editor-scope')!, '#social-settings');
      expect(container.querySelector(selector)?.parentElement).toBe(section);
    }
    await click('reset-inline-one'); expect(value('inline-one')).toBe(''); expect(value('modal')).toBe('modal'); expect(value('inline-two')).toBe('');
    await click('reset-modal');
  } finally { await act(async () => root.unmount()); container.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; }
});
