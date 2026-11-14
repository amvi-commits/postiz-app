/** @jest-environment jsdom */
import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { LaunchStoreProvider, useLaunchStore } from '../new-launch/store';
jest.mock('@copilotkit/react-core', () => ({ useCopilotAction: () => undefined, useCopilotReadable: () => undefined }));
jest.mock('@gitroom/react/translation/get.transation.service.client', () => ({ useT: () => (_: string, fallback: string) => fallback }));
jest.mock('@gitroom/frontend/components/launches/helpers/use.existing.data', () => ({ useExistingData: () => ({}) }));
jest.mock('@gitroom/frontend/components/signature', () => ({ SignatureBox: () => null }));
jest.mock('@gitroom/frontend/components/media/media.component', () => ({ MultiMediaComponent: () => null }));
jest.mock('@gitroom/frontend/components/media/new.uploader', () => ({ useUppyUploader: () => ({}) }));
jest.mock('@uppy/react', () => ({ Dashboard: () => null }));
jest.mock('@gitroom/frontend/components/new-launch/mention.component', () => ({ suggestion: {} }));
jest.mock('@gitroom/frontend/components/launches/information.component', () => ({ InformationComponent: () => null }));
jest.mock('@gitroom/react/helpers/delete.dialog', () => ({ deleteDialog: jest.fn() }));
import { EditorWrapper } from '../new-launch/editor';

// Exercise the real editor wrapper/store with a focused channel whose content
// still inherits global values. Empty values avoid mounting unrelated uploaders.
function FocusedEditor({ singleAccount }: { singleAccount?: boolean }) {
  const setCurrent = useLaunchStore(state => state.setCurrent);
  useEffect(() => { setCurrent('threads-one'); }, [setCurrent]);
  return React.createElement(EditorWrapper, { totalPosts: 1, value: '', singleAccount });
}
it('lets a single-account editor open directly while preserving the legacy per-channel unlock', async () => {
  (globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
  const container=document.createElement('div'); document.body.appendChild(container);
  const root=createRoot(container);
  try {
    await act(async () => root.render(React.createElement(LaunchStoreProvider, null, React.createElement(FocusedEditor))));
    expect(container.textContent).toContain('Edit content');
    await act(async () => root.render(React.createElement(LaunchStoreProvider, null, React.createElement(FocusedEditor, { singleAccount: true }))));
    expect(container.textContent).not.toContain('Edit content');
    expect(container.textContent).not.toContain('Click this button to exit global editing');
  } finally { await act(async () => root.unmount()); container.remove(); delete (globalThis as any).IS_REACT_ACT_ENVIRONMENT; }
});
