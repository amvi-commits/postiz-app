'use client';

import React, { useEffect, useRef, useState } from 'react';
import { MediaBox } from '@gitroom/frontend/components/media/media.component';
import { useUppyUploader } from '@gitroom/frontend/components/media/new.uploader';
import { useModals } from '@gitroom/frontend/components/layout/new-modal';
import { useLaunchStore } from '@gitroom/frontend/components/new-launch/store';

export type VideoInput = {
  id: string; postizMediaId: string; storageKey: string; fileName: string;
  duration: number; sizeBytes: string;
};
type Props = {
  label: string; description: string; value: VideoInput | null;
  onChange: (value: VideoInput | null) => void;
  request: (path: string, init?: RequestInit) => Promise<any>;
  previewUrl: (path: string) => string; disabled?: boolean;
  onBusyChange?: (busy: boolean) => void;
};
const button = 'rounded-lg border border-blockSeparator px-3 py-2 text-sm disabled:opacity-50';

export function VideoInputPicker(props: Props) {
  const latest = useRef(props);
  latest.current = props;
  const mounted = useRef(true);
  const sequence = useRef(0);
  const ownsUpload = useRef(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');
  const modals = useModals();
  const setUploadLocked = useLaunchStore((state) => state.setLocked);
  const setBusy = (busy: boolean) => {
    if (!mounted.current) return;
    setPending(busy);
    latest.current.onBusyChange?.(busy);
  };
  const select = async (media: { id: string }) => {
    const token = ++sequence.current;
    setBusy(true);
    setError('');
    try {
      const asset = await latest.current.request(`/sns-studio/video-tools/inputs/${encodeURIComponent(media.id)}`, { method: 'POST' });
      if (mounted.current && sequence.current === token) latest.current.onChange(asset);
    } catch (e: any) {
      if (mounted.current && sequence.current === token) {
        latest.current.onChange(null);
        setError(e?.message || '動画の登録に失敗しました。Mediaから選び直してください。');
      }
    } finally {
      if (sequence.current === token) setBusy(false);
    }
  };
  const selectRef = useRef(select);
  selectRef.current = select;
  const uppy = useUppyUploader({
    allowedFileTypes: 'video/mp4',
    onStart: () => { ownsUpload.current = true; setBusy(true); },
    // Keep processing locked until the org-owned SnsMediaAsset is registered.
    onEnd: () => { ownsUpload.current = false; },
    onUploadSuccess: (files: any) => {
      if (!mounted.current) return;
      if (files?.length === 1) void selectRef.current(files[0]);
      else { setBusy(false); setError('アップロードが完了しませんでした。動画を選び直してください。'); }
    },
  });
  useEffect(() => {
    mounted.current = true;
    const failed = () => { setBusy(false); setError('アップロードに失敗しました。動画を選び直してください。'); };
    uppy.on('upload-error', failed);
    uppy.on('error', failed);
    return () => {
      mounted.current = false;
      ++sequence.current;
      uppy.off('upload-error', failed);
      uppy.off('error', failed);
      uppy.cancelAll();
      if (ownsUpload.current) setUploadLocked(false);
    };
  }, [uppy]);
  const locked = pending || props.disabled;
  return <section aria-label={props.label} className="rounded-lg border border-blockSeparator p-4">
    <h3 className="font-semibold">{props.label}</h3>
    <p className="mt-1 text-xs text-textItemBlur">{props.description}</p>
    <div className="my-3 flex flex-wrap gap-2">
      <button type="button" className={button} disabled={locked} onClick={() => fileInput.current?.click()}>PCからアップロード</button>
      <input ref={fileInput} type="file" accept="video/mp4,.mp4" aria-label={`${props.label}をPCから選択`} className="hidden" onChange={(e) => {
        const file = e.currentTarget.files?.[0];
        e.currentTarget.value = '';
        if (!file) return;
        setError('');
        setBusy(true);
        ownsUpload.current = true;
        try { uppy.addFile({ name: file.name, type: file.type || 'video/mp4', data: file }); }
        catch { ownsUpload.current = false; setUploadLocked(false); setBusy(false); setError('MP4動画を1件選択してください。'); }
      }} />
      <button type="button" className={button} disabled={locked} onClick={() => modals.openModal({
        title: `${props.label} — 既存Mediaから選択（1件）`,
        closeOnEscape: true,
        fullScreen: true,
        size: 'calc(100% - 80px)',
        height: 'calc(100% - 80px)',
        children: (close) => <MediaBox type="video" closeModal={close} setMedia={(items) => {
          if (items.length !== 1) { setError('動画を1件だけ選択してください。'); return; }
          void select(items[0]);
        }} />,
      })}>既存Mediaから選択</button>
      {props.value && <button type="button" className={button} disabled={locked} onClick={() => { props.onChange(null); setError(''); }}>選択解除</button>}
    </div>
    {pending && <p role="status">アップロード・動画の確認・素材登録中…</p>}
    {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
    {props.value && <>
      <p className="break-all text-sm">{props.value.fileName}</p>
      <p className="text-xs text-textItemBlur">{props.value.duration.toFixed(2)}秒 · {(Number(props.value.sizeBytes) / 1024 / 1024).toFixed(2)} MB · 処理対象に選択済み</p>
      <video aria-label={`${props.label}のプレビュー`} className="mt-2 max-h-64 w-full rounded bg-black" controls preload="metadata" src={props.previewUrl(props.value.storageKey)} />
      <p className="mt-1 text-xs text-textItemBlur">上のボタンで選び直せます。素材自体は削除されません。</p>
    </>}
  </section>;
}
