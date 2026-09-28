'use client';

import { FormEvent, useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { SnsStudioCommonPublisher } from '@gitroom/frontend/components/sns-studio/common-publisher';
import type { CommonPublishPrefill } from '@gitroom/frontend/components/sns-studio/common-publisher';

type Tab = 'Dashboard' | 'Accounts' | 'Content Inbox' | 'Create' | 'Publish' | 'Story Pools' | 'Automation Recipes' | 'Queue' | 'Analytics' | 'Settings';
type Account = { id: string; username: string; status: string; healthStatus?: string; health?: { session?: string }; proxyConfigured?: boolean | null; lastError?: string | null; captionAIEnabled?: boolean; lastValidatedAt?: string | null; lastPublishedAt?: string | null; defaultStoryPoolId?: string | null; defaultStickerX?: number | null; defaultStickerY?: number | null; defaultStickerWidth?: number | null; defaultStickerHeight?: number | null; defaultStickerRotation?: number | null; defaultStoryPool?: { id: string; name: string } | null };
type UrlItem = { id: string; name: string; url: string; note?: string | null; active: boolean };
type Pool = { id: string; name: string; items: Array<{ id: string; mediaPath: string; mediaType: string; urlSnapshot?: string | null; urlLibrary?: UrlItem | null }> };
type Recipe = { id: string; name: string; inputType: string; config: Record<string, unknown> };
type PublishRecord = { id: string; publishType: string; status: string; postUrl?: string | null; mediaId?: string | null; publishedAt?: string | null; errorCode?: string | null; account: { username: string }; snapshots?: Array<{ metrics?: Record<string, unknown> | null }> };

const tabs: Tab[] = ['Dashboard', 'Accounts', 'Content Inbox', 'Create', 'Publish', 'Story Pools', 'Automation Recipes', 'Queue', 'Analytics', 'Settings'];
const card = 'rounded-xl border border-blockSeparator bg-newBgColorInner p-5';
const field = 'w-full rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2 text-newTextColor outline-none focus:border-[#7774ff]';
const primaryButton = 'rounded-lg bg-[#5145ff] px-4 py-2 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton = 'rounded-lg border border-blockSeparator px-4 py-2 font-semibold text-newTextColor hover:bg-boxFocused disabled:opacity-50';

const explainError = (payload: any) => {
  const detail = payload?.detail ?? payload?.response?.data?.detail ?? payload?.response?.data ?? payload;
  if (Array.isArray(detail?.errors) && detail.errors.length) return `Preflightで停止しました: ${detail.errors.join(', ')}`;
  return typeof detail === 'string' ? detail : detail?.message || detail?.code || payload?.message || '処理に失敗しました。';
};

export const SnsStudio = () => {
  const fetch = useFetch();
  const [activeTab, setActiveTab] = useState<Tab>('Dashboard');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [accountForm, setAccountForm] = useState({ username: '', password: '', proxy: '', verificationCode: '' });
  const [reelForm, setReelForm] = useState({ accountId: '', videoPath: '', caption: '', thumbnailPath: '', trialReel: false, pipelineRunId: '' });
  const [storyForm, setStoryForm] = useState({ accountId: '', mediaPath: '', mediaType: 'image', linkUrl: '', x: 0.5, y: 0.5, width: 0.51, height: 0.26, rotation: 0, pipelineRunId: '' });
  const [poolForm, setPoolForm] = useState({ name: '', description: '' });
  const [poolItemForm, setPoolItemForm] = useState({ poolId: '', mediaPath: '', mediaType: 'image', urlLibraryId: '' });
  const [urlForm, setUrlForm] = useState({ name: '', url: '', note: '' });
  const [recipeForm, setRecipeForm] = useState({ name: '', inputType: 'VIDEO', config: '{\n  "publishType": "REEL",\n  "approveBeforePublish": true\n}' });
  const [recipeSourcePath, setRecipeSourcePath] = useState('');
  const [inboxRecipeSelection, setInboxRecipeSelection] = useState<Record<string, string>>({});
  const [renderForm, setRenderForm] = useState({ sourcePath: '', trimStartSeconds: 0, trimEndSeconds: 0, playbackSpeed: 1, cropPercent: 100, bgmPath: '', bgmVolume: 0.15, sourceAudioVolume: 1, subtitlesPath: '', textOverlay: '', textX: 0.5, textY: 0.8, textFontSize: 64 });
  const [variantForm, setVariantForm] = useState({ sourcePath: '', count: 3, settings: '{\n  "playbackSpeed": {"enabled": true, "min": 0.96, "max": 1.04},\n  "trimStartSeconds": {"enabled": false, "min": 0, "max": 1.5},\n  "trimEndSeconds": {"enabled": false, "min": 0, "max": 1},\n  "cropPercent": {"enabled": false, "min": 95, "max": 100}\n}' });
  const [variantResults, setVariantResults] = useState<any[]>([]);
  const [commonPostPrefill, setCommonPostPrefill] = useState<CommonPublishPrefill | null>(null);
  const [comicPages, setComicPages] = useState('[\n  {\n    "imagePath": "/uploads/page-01.png",\n    "dialogues": [\n      {"speakerSlot": "FEMALE_1", "text": "最初のセリフ"},\n      {"speakerSlot": "MALE_1", "text": "次のセリフ"}\n    ]\n  }\n]');
  const [comicEditingPresetId, setComicEditingPresetId] = useState('');
  const [concatPaths, setConcatPaths] = useState('[\n  "/uploads/clip-01.mp4",\n  "/uploads/clip-02.mp4"\n]');
  const [driveFolderId, setDriveFolderId] = useState('');
  const [poolAssignments, setPoolAssignments] = useState<Record<string, string>>({});
  const [trialEligibility, setTrialEligibility] = useState<Record<string, boolean>>({});
  const [retentionDays, setRetentionDays] = useState(7);
  const [captionPrompt, setCaptionPrompt] = useState('');
  const [editingPresetForm, setEditingPresetForm] = useState({ name: 'Reel Standard', config: '{\n  "width": 1080,\n  "height": 1920,\n  "fps": 30,\n  "playbackSpeed": 1,\n  "cropPercent": 100,\n  "bgmVolume": 0.15,\n  "sourceAudioVolume": 1\n}' });
  const [voicePresetForm, setVoicePresetForm] = useState({ name: 'Default voices', slots: '{}', ttsSettings: '{\n  "subtitleFontSize": 48,\n  "subtitlePosition": 2,\n  "subtitleOutline": 2,\n  "maxSubtitleChars": 22,\n  "pagePaddingSeconds": 0.3\n}' });
  const [voicePresetId, setVoicePresetId] = useState('');
  const [generationInput, setGenerationInput] = useState({ prompt: '', count: 1, mediaType: 'video' });

  const request = useCallback(async (path: string, init?: RequestInit) => {
    const response = await fetch(path, {
      ...init,
      headers: { ...(init?.body ? { 'Content-Type': 'application/json' } : {}), ...init?.headers },
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(explainError(data));
    return data;
  }, [fetch]);

  const load = useCallback(async (path: string) => request(path), [request]);
  const { data: dashboard, mutate: refreshDashboard } = useSWR('/sns-studio/dashboard', load, { refreshInterval: 5000 });
  const { data: accounts = [], mutate: refreshAccounts } = useSWR<Account[]>('/sns-studio/accounts', load);
  const { data: urls = [], mutate: refreshUrls } = useSWR<UrlItem[]>('/sns-studio/urls', load);
  const { data: pools = [], mutate: refreshPools } = useSWR<Pool[]>('/sns-studio/story-pools', load);
  const { data: recipes = [], mutate: refreshRecipes } = useSWR<Recipe[]>('/sns-studio/recipes', load);
  const { data: inbox = [], mutate: refreshInbox } = useSWR('/sns-studio/content-inbox', load);
  const { data: queue = [], mutate: refreshQueue } = useSWR('/sns-studio/queue', load, { refreshInterval: 3000 });
  const { data: records = [], mutate: refreshRecords } = useSWR<PublishRecord[]>('/sns-studio/publish-records', load);
  const { data: driveStatus, mutate: refreshDrive } = useSWR('/sns-studio/drive/status', load);
  const { data: instagramWorkerHealth } = useSWR('/sns-studio/health', load, { shouldRetryOnError: false, refreshInterval: 30000 });
  const { data: mediaWorkerHealth } = useSWR('/sns-studio/media/health', load, { shouldRetryOnError: false, refreshInterval: 30000 });
  const { data: driveFolders = [], mutate: refreshDriveFolders } = useSWR<any[]>(driveStatus?.connected ? '/sns-studio/drive/folders' : null, load);
  const { data: snsSettings, mutate: refreshSettings } = useSWR('/sns-studio/settings', load);
  const { data: voiceSpeakers, error: voiceError } = useSWR('/sns-studio/voicevox/speakers', load, { shouldRetryOnError: false });
  const { data: editingPresets = [], mutate: refreshEditingPresets } = useSWR<any[]>('/sns-studio/editing-presets', load);
  const { data: voicePresets = [], mutate: refreshVoicePresets } = useSWR<any[]>('/sns-studio/voice-presets', load);
  const { data: generationJobs = [], mutate: refreshGenerationJobs } = useSWR<any[]>('/sns-studio/generation/jobs', load);

  const refresh = useCallback(async () => {
    await Promise.all([refreshDashboard(), refreshAccounts(), refreshUrls(), refreshPools(), refreshRecipes(), refreshInbox(), refreshQueue(), refreshRecords(), refreshDrive(), refreshDriveFolders(), refreshSettings(), refreshEditingPresets(), refreshVoicePresets(), refreshGenerationJobs()]);
  }, [refreshDashboard, refreshAccounts, refreshUrls, refreshPools, refreshRecipes, refreshInbox, refreshQueue, refreshRecords, refreshDrive, refreshDriveFolders, refreshSettings, refreshEditingPresets, refreshVoicePresets, refreshGenerationJobs]);

  const run = useCallback(async (action: () => Promise<unknown>, success: string) => {
    setBusy(true);
    setMessage('');
    try {
      await action();
      setMessage(success);
      await refresh();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : '処理に失敗しました。');
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const submit = (action: () => Promise<unknown>, success: string) => (event: FormEvent) => {
    event.preventDefault();
    void run(action, success);
  };

  const defaultAccount = useMemo(() => accounts[0]?.id || '', [accounts]);

  const openCommonPublisher = useCallback(async (item: any) => {
    if (!item?.mediaAsset?.id) {
      throw new Error('共通投稿へ渡せるSNS Studio素材がありません。');
    }
    const result = await request(
      `/sns-studio/media-assets/${item.mediaAsset.id}/post-media`,
      { method: 'POST' }
    );
    if (!result?.media?.id || !result?.media?.path) {
      throw new Error('共通投稿用Mediaの作成に失敗しました。');
    }
    setCommonPostPrefill({
      sourceAssetId: result.sourceAssetId,
      media: {
        id: result.media.id,
        path: result.media.path,
      },
    });
    setActiveTab('Publish');
  }, [request]);

  useEffect(() => {
    const account = accounts.find((candidate) => candidate.id === (storyForm.accountId || defaultAccount));
    if (!account) return;
    setStoryForm((current) => ({
      ...current,
      accountId: account.id,
      x: account.defaultStickerX ?? current.x,
      y: account.defaultStickerY ?? current.y,
      width: account.defaultStickerWidth ?? current.width,
      height: account.defaultStickerHeight ?? current.height,
      rotation: account.defaultStickerRotation ?? current.rotation,
    }));
  }, [accounts, storyForm.accountId, defaultAccount]);

  useEffect(() => {
    if (driveStatus?.folder?.id) setDriveFolderId(driveStatus.folder.id);
  }, [driveStatus?.folder?.id]);

  useEffect(() => {
    if (snsSettings?.retentionDays !== undefined) setRetentionDays(snsSettings.retentionDays);
  }, [snsSettings?.retentionDays]);

  useEffect(() => {
    if (!voicePresetId && voicePresets.length) setVoicePresetId(voicePresets[0].id);
  }, [voicePresets, voicePresetId]);

  const publishReel = async () => {
    const body = { ...reelForm, accountId: reelForm.accountId || defaultAccount, pipelineRunId: reelForm.pipelineRunId || undefined };
    const response = await request('/sns-studio/publish/reel', { method: 'POST', body: JSON.stringify(body) });
    if (body.pipelineRunId) setReelForm((current) => ({ ...current, pipelineRunId: '' }));
    if (response.preflightWarnings?.length) setMessage(`投稿完了。確認事項: ${response.preflightWarnings.join(', ')}`);
    return response;
  };

  const publishStory = async () => {
    const body = { ...storyForm, accountId: storyForm.accountId || defaultAccount };
    const response = await request('/sns-studio/publish/story', { method: 'POST', body: JSON.stringify({ accountId: body.accountId, mediaPath: body.mediaPath, mediaType: body.mediaType, linkUrl: body.linkUrl, pipelineRunId: body.pipelineRunId || undefined, sticker: { x: body.x, y: body.y, width: body.width, height: body.height, rotation: body.rotation } }) });
    if (body.pipelineRunId) setStoryForm((current) => ({ ...current, pipelineRunId: '' }));
    if (response.preflightWarnings?.length) setMessage(`投稿完了。確認事項: ${response.preflightWarnings.join(', ')}`);
    return response;
  };

  const generateCaption = async () => {
    const accountId = reelForm.accountId || defaultAccount;
    if (!accountId) throw new Error('先にInstagramアカウントを接続してください。');
    if (!accounts.find((account) => account.id === accountId)?.captionAIEnabled) throw new Error('Accountsで対象アカウントのAI CaptionをONにしてください。');
    const result = await request('/sns-studio/caption/generate', { method: 'POST', body: JSON.stringify({ accountId, sourceText: captionPrompt }) });
    setReelForm((current) => ({ ...current, caption: result.caption }));
    return result;
  };

  const startRecipe = async (recipe: Recipe, source?: { path: string; inboxItemId: string; mediaType: string }) => {
    const config = recipe.config || {};
    let input: Record<string, unknown>;
    if (recipe.inputType === 'COMIC_PAGES') {
      const parsedPages = JSON.parse(comicPages);
      const pages = source?.mediaType === 'image'
        ? parsedPages.map((page: any, index: number) => index === 0 ? { ...page, imagePath: source.path } : page)
        : parsedPages;
      input = { pages, voicePresetId, inboxItemId: source?.inboxItemId };
    } else if (recipe.inputType === 'STORY_POOL') {
      input = { accountId: config.accountId || storyForm.accountId || defaultAccount, poolId: config.poolId, inboxItemId: source?.inboxItemId };
    } else {
      const sourcePath = source?.path || recipeSourcePath || (typeof config.sourcePath === 'string' ? config.sourcePath : '');
      if (!sourcePath) throw new Error('Recipe実行にはSource pathを指定してください。');
      input = { sourcePath, inboxItemId: source?.inboxItemId, accountId: config.accountId || reelForm.accountId || defaultAccount, caption: config.caption || reelForm.caption, trialReel: config.trialReelDefault || false };
    }
    const result = await request('/sns-studio/queue', { method: 'POST', body: JSON.stringify({ recipeId: recipe.id, input }) });
    setActiveTab('Queue');
    return result;
  };

  const loadPipelineForCreate = (item: any) => {
    const output = item.output || {};
    if (output.publishType === 'STORY') {
      const accountId = output.accountId || storyForm.accountId || defaultAccount;
      const account = accounts.find((entry) => entry.id === accountId);
      setStoryForm((current) => ({
        ...current,
        accountId,
        mediaPath: output.mediaPath || '',
        mediaType: output.mediaType || 'image',
        linkUrl: output.linkUrl || '',
        pipelineRunId: item.id,
        x: output.storySticker?.x ?? account?.defaultStickerX ?? current.x,
        y: output.storySticker?.y ?? account?.defaultStickerY ?? current.y,
        width: output.storySticker?.width ?? account?.defaultStickerWidth ?? current.width,
        height: output.storySticker?.height ?? account?.defaultStickerHeight ?? current.height,
        rotation: output.storySticker?.rotation ?? account?.defaultStickerRotation ?? current.rotation,
      }));
    } else {
      setReelForm((current) => ({ ...current, accountId: output.accountId || current.accountId || defaultAccount, videoPath: output.mediaPath || '', caption: output.caption || '', trialReel: !!output.trialReel, pipelineRunId: item.id }));
    }
    setActiveTab('Create');
  };

  const previewUrl = (path: string) => `/sns-studio/media/preview?path=${encodeURIComponent(path)}`;

  const prepareRandomStory = async () => {
    const accountId = storyForm.accountId || defaultAccount;
    if (!accountId) return setMessage('先にInstagramアカウントを接続してください。');
    setBusy(true);
    setMessage('');
    try {
      const item = await request(`/sns-studio/accounts/${accountId}/story-pool/next`, { method: 'POST' });
      setStoryForm((current) => ({ ...current, accountId, mediaPath: item.mediaPath, mediaType: item.mediaType, linkUrl: item.url || '' }));
      setActiveTab('Create');
      setMessage('PoolからStory素材を選びました。プレビューとURLを確認して投稿できます。');
    } catch (error) {
      setMessage(error instanceof Error ? error.message : 'Story Poolを選べませんでした。');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto bg-newBgColor p-5 text-newTextColor lg:p-8">
      <header className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <div className="text-sm font-semibold uppercase tracking-[0.18em] text-textItemBlur">Local workspace</div>
          <h1 className="mt-1 text-3xl font-bold">SNS Studio</h1>
          <p className="mt-2 max-w-3xl text-sm text-textItemBlur">素材を準備し、プレビューを確認してからInstagramへ今すぐ投稿します。</p>
        </div>
        <button className={secondaryButton} onClick={() => void refresh()} disabled={busy}>更新</button>
      </header>

      <nav className="flex flex-wrap gap-2 rounded-xl border border-blockSeparator bg-newBgColorInner p-2" aria-label="SNS Studio navigation">
        {tabs.map((tab) => (
          <button key={tab} onClick={() => setActiveTab(tab)} className={`rounded-lg px-3 py-2 text-sm font-semibold transition ${activeTab === tab ? 'bg-[#5145ff] text-white' : 'text-textItemBlur hover:bg-boxFocused hover:text-newTextColor'}`}>
            {tab}
          </button>
        ))}
      </nav>

      {message && <div role="status" className="rounded-lg border border-[#7774ff]/40 bg-[#5145ff]/10 px-4 py-3 text-sm">{message}</div>}

      {activeTab === 'Dashboard' && <section className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
        <Metric title="Accounts" value={accounts.length} detail={`${dashboard?.accounts?.reduce((n: number, row: any) => n + row._count._all, 0) || 0} saved`} />
        <Metric title="Content Inbox" value={inbox.length} detail="素材一覧" />
        <Metric title="Pipeline Queue" value={queue.filter((row: any) => !['PUBLISHED', 'FAILED'].includes(row.status)).length} detail="予約投稿はありません" />
        <Metric title="Recent publishing" value={records.filter((row) => row.status === 'PUBLISHED').length} detail={`${records.filter((row) => row.status === 'FAILED').length} failed`} />
        <div className={`${card} md:col-span-2 xl:col-span-4`}>
          <h2 className="text-lg font-bold">最近の投稿</h2>
          <RecordList records={records.slice(0, 6)} />
        </div>
      </section>}

      {activeTab === 'Accounts' && <section className="grid gap-5 xl:grid-cols-[minmax(320px,420px)_1fr]">
        <form className={card} onSubmit={submit(async () => { const result = await request('/sns-studio/accounts', { method: 'POST', body: JSON.stringify(accountForm) }); setAccountForm((current) => ({ ...current, password: '', verificationCode: '' })); return result; }, 'Instagramアカウントを接続しました。')}>
          <h2 className="text-lg font-bold">Instagramアカウントを接続</h2>
          <p className="mb-4 mt-1 text-sm text-textItemBlur">パスワードとセッションはInstagram Worker内で暗号化して保存します。</p>
          <div className="grid gap-3">
            <Field label="Username"><input className={field} autoComplete="username" value={accountForm.username} onChange={(e) => setAccountForm({ ...accountForm, username: e.target.value })} required /></Field>
            <Field label="Password"><input className={field} type="password" autoComplete="current-password" value={accountForm.password} onChange={(e) => setAccountForm({ ...accountForm, password: e.target.value })} required /></Field>
            <Field label="Proxy (optional)"><input className={field} placeholder="http(s):// or socks5://" value={accountForm.proxy} onChange={(e) => setAccountForm({ ...accountForm, proxy: e.target.value })} /></Field>
            <button type="button" className={secondaryButton} disabled={busy || !accountForm.proxy.trim()} onClick={() => void run(async () => { const result = await request('/sns-studio/proxy/test', { method: 'POST', body: JSON.stringify({ proxy: accountForm.proxy }) }); if (!result.reachable) throw new Error(result.code || 'Proxy connection failed'); }, 'Proxy接続を確認しました。')}>Test Proxy</button>
            <Field label="2FA code (when requested)"><input className={field} inputMode="numeric" value={accountForm.verificationCode} onChange={(e) => setAccountForm({ ...accountForm, verificationCode: e.target.value })} /></Field>
            <button className={primaryButton} disabled={busy}>Login / Save session</button>
          </div>
        </form>
        <div className={card}>
          <h2 className="text-lg font-bold">Accounts</h2>
          <div className="mt-4 grid gap-3">
            {accounts.length === 0 && <Empty>Instagramアカウントはまだありません。</Empty>}
            {accounts.map((account) => <div key={account.id} className="flex flex-wrap items-center gap-3 rounded-lg border border-blockSeparator p-4">
              <div className="min-w-[220px] flex-1"><div className="font-bold">@{account.username}</div><div className={`mt-1 text-xs ${account.healthStatus === 'GREEN' ? 'text-green-400' : account.healthStatus === 'YELLOW' ? 'text-amber-300' : 'text-red-300'}`}>{account.healthStatus || account.status} · Session: {account.health?.session || account.status} · Proxy: {account.proxyConfigured === null || account.proxyConfigured === undefined ? '不明' : account.proxyConfigured ? '設定済み' : 'なし'}</div><div className="mt-1 text-xs text-textItemBlur">Last validation: {account.lastValidatedAt ? new Date(account.lastValidatedAt).toLocaleString() : '未確認'} · Last post: {account.lastPublishedAt ? new Date(account.lastPublishedAt).toLocaleString() : '—'} · Trial Reel: {trialEligibility[account.id] === undefined ? '未確認' : trialEligibility[account.id] ? '利用可能' : '対象外'} · Story Pool: {account.defaultStoryPool?.name || '未設定'}</div>{account.lastError && <div className="mt-1 text-xs text-red-300">Last error: {account.lastError}</div>}</div>
              <select aria-label={`@${account.username} の Story Pool`} className={`${field} max-w-48`} value={poolAssignments[account.id] ?? account.defaultStoryPoolId ?? ''} onChange={(e) => setPoolAssignments({ ...poolAssignments, [account.id]: e.target.value })}><option value="">Poolを選択</option>{pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select>
              <button className={secondaryButton} onClick={() => void run(() => request(`/sns-studio/accounts/${account.id}/story-pool/${poolAssignments[account.id] ?? account.defaultStoryPoolId}`, { method: 'POST' }), 'AccountのStory Poolを保存しました。')} disabled={busy || !(poolAssignments[account.id] ?? account.defaultStoryPoolId)}>Pool保存</button>
              <button className={secondaryButton} onClick={() => void run(() => request(`/sns-studio/accounts/${account.id}/validate`, { method: 'POST', body: '{}' }), 'セッションを確認しました。')} disabled={busy}>Validate</button>
              <button className={secondaryButton} onClick={() => void run(() => request(`/sns-studio/accounts/${account.id}/caption-settings`, { method: 'PUT', body: JSON.stringify({ enabled: !account.captionAIEnabled }) }), 'AI Caption設定を更新しました。')} disabled={busy}>AI Caption {account.captionAIEnabled ? 'ON' : 'OFF'}</button>
              <button className={secondaryButton} onClick={() => void run(async () => { const result = await request(`/sns-studio/accounts/${account.id}/trial-reel-eligibility`); setTrialEligibility((current) => ({ ...current, [account.id]: !!result.eligible })); return result; }, 'Trial Reelの利用可否を確認しました。')} disabled={busy}>Trial Reel check</button>
            </div>)}
          </div>
        </div>
      </section>}

      {activeTab === 'Content Inbox' && <section className={card}>
        <div className="flex flex-wrap items-start justify-between gap-4"><div><h2 className="text-lg font-bold">Content Inbox</h2><p className="mt-1 text-sm text-textItemBlur">Google Drive接続後、指定フォルダの素材をここで確認します。</p></div><button className={secondaryButton} onClick={() => void refreshInbox()}>同期状態を更新</button></div>
        <div className="mt-4 grid gap-3">{inbox.length ? inbox.map((item: any) => <div key={item.id} className="flex flex-wrap items-center gap-4 rounded-lg border border-blockSeparator p-4"><div className="min-w-[200px] flex-1 font-semibold">{item.fileName}</div><span className="text-sm text-textItemBlur">{item.mediaType}</span><span className="text-sm text-textItemBlur">{item.status}</span><span className="text-sm text-textItemBlur">{item.sizeBytes ? `${(Number(item.sizeBytes) / 1024 / 1024).toFixed(1)} MB` : '—'}</span>{item.previewUrl && <a href={item.previewUrl} target="_blank" rel="noreferrer" className="text-sm text-[#9e9aff] underline">Preview / Drive</a>}{item.mediaAsset?.storageKey && <div className="flex flex-wrap items-center gap-2"><select aria-label={`${item.fileName} に使用するRecipe`} className={`${field} max-w-56`} value={inboxRecipeSelection[item.id] || ''} onChange={(e) => setInboxRecipeSelection((current) => ({ ...current, [item.id]: e.target.value }))}><option value="">Recipeを選択</option>{recipes.map((recipe) => <option key={recipe.id} value={recipe.id}>{recipe.name}</option>)}</select><button className={secondaryButton} disabled={busy || !inboxRecipeSelection[item.id]} onClick={() => { const recipe = recipes.find((entry) => entry.id === inboxRecipeSelection[item.id]); if (recipe) void run(() => startRecipe(recipe, { path: item.mediaAsset.storageKey, inboxItemId: item.id, mediaType: item.mediaType }), '素材を制作Queueへ登録しました。'); }}>Recipeを実行</button></div>}{item.mediaAsset?.id && <button className={primaryButton} disabled={busy} onClick={() => void run(() => openCommonPublisher(item), '共通投稿へ素材を引き継ぎました。')}>共通投稿で使用</button>}{item.mediaAsset?.storageKey && item.mediaType === 'video' && <button className={secondaryButton} onClick={() => { setReelForm((current) => ({ ...current, videoPath: item.mediaAsset.storageKey, pipelineRunId: '' })); setActiveTab('Create'); }}>Use for Reel</button>}{item.mediaAsset?.storageKey && item.mediaType === 'image' && <button className={secondaryButton} onClick={() => { setStoryForm((current) => ({ ...current, mediaPath: item.mediaAsset.storageKey, mediaType: 'image', pipelineRunId: '' })); setActiveTab('Create'); }}>Use for Story</button>}</div>) : <Empty>Inboxは空です。SettingsからGoogle Driveを接続して同期してください。</Empty>}</div>
      </section>}

      {activeTab === 'Publish' && <SnsStudioCommonPublisher prefill={commonPostPrefill} />}

      {activeTab === 'Create' && <section className="grid gap-5 xl:grid-cols-2">
        <form className={card} onSubmit={submit(publishReel, 'Reel投稿が完了しました。')}>
          <h2 className="text-lg font-bold">Publish Reel now</h2>
          <p className="mb-4 mt-1 text-sm text-textItemBlur">投稿前にアカウント、共有メディア、Trial Reel資格を確認してください。</p>
          <div className="grid gap-3">
            <AccountSelect accounts={accounts} value={reelForm.accountId || defaultAccount} onChange={(accountId) => setReelForm({ ...reelForm, accountId })} />
            <Field label="Video path (inside shared uploads)"><input className={field} value={reelForm.videoPath} onChange={(e) => setReelForm({ ...reelForm, videoPath: e.target.value })} placeholder="/uploads/reel.mp4" required /></Field>
            {reelForm.videoPath && <video className="max-h-96 w-full rounded-lg bg-black" controls preload="metadata" src={previewUrl(reelForm.videoPath)} />}
            {reelForm.pipelineRunId && <div className="text-xs text-textItemBlur">承認済みPipeline: {reelForm.pipelineRunId}</div>}
            <Field label="Caption"><textarea className={`${field} min-h-24`} maxLength={2200} value={reelForm.caption} onChange={(e) => setReelForm({ ...reelForm, caption: e.target.value })} /></Field>
            <Field label="AI Caption用の素材メモ"><textarea className={`${field} min-h-16`} maxLength={12000} value={captionPrompt} onChange={(e) => setCaptionPrompt(e.target.value)} placeholder="動画の内容、伝えたい要点など" /></Field><button type="button" className={secondaryButton} disabled={busy || !captionPrompt.trim() || !accounts.find((account) => account.id === (reelForm.accountId || defaultAccount))?.captionAIEnabled} onClick={() => void run(generateCaption, 'AI Captionを作成しました。内容を確認して編集してください。')}>AI Captionを生成</button>
            <Field label="Thumbnail path (optional)"><input className={field} value={reelForm.thumbnailPath} onChange={(e) => setReelForm({ ...reelForm, thumbnailPath: e.target.value })} placeholder="/uploads/cover.jpg" /></Field>
            <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={reelForm.trialReel} onChange={(e) => setReelForm({ ...reelForm, trialReel: e.target.checked })} /> Trial Reel</label>
            <button className={primaryButton} disabled={busy || !accounts.length}>Preflight and publish now</button>
          </div>
        </form>
        <form className={card} onSubmit={submit(publishStory, 'Story投稿が完了しました。リンクスタンプはInstagram上でも表示を確認してください。')}>
          <h2 className="text-lg font-bold">Publish Story + Link</h2>
          <p className="mb-4 mt-1 text-sm text-textItemBlur">Storyリンクスタンプの描画結果は、Instagramアプリで確認してください。</p>
          <div className="grid gap-3">
            <AccountSelect accounts={accounts} value={storyForm.accountId || defaultAccount} onChange={(accountId) => setStoryForm({ ...storyForm, accountId })} />
            <Field label="Media path (inside shared uploads)"><input className={field} value={storyForm.mediaPath} onChange={(e) => setStoryForm({ ...storyForm, mediaPath: e.target.value })} placeholder="/uploads/story.jpg" required /></Field>
            <Field label="Media type"><select className={field} value={storyForm.mediaType} onChange={(e) => setStoryForm({ ...storyForm, mediaType: e.target.value })}><option value="image">Image</option><option value="video">Video</option></select></Field>
            {storyForm.mediaPath && <div className="relative mx-auto aspect-[9/16] max-h-[520px] w-full max-w-[293px] overflow-hidden rounded-lg bg-black">{storyForm.mediaType === 'video' ? <video className="absolute inset-0 h-full w-full object-contain" controls preload="metadata" src={previewUrl(storyForm.mediaPath)} /> : <img className="absolute inset-0 h-full w-full object-contain" src={previewUrl(storyForm.mediaPath)} alt="Story preview" />}{storyForm.linkUrl && <div className="pointer-events-none absolute flex items-center justify-center rounded-full bg-white/90 px-2 text-center text-xs font-semibold text-black" style={{ left: `${storyForm.x * 100}%`, top: `${storyForm.y * 100}%`, width: `${Math.max(10, storyForm.width * 100)}%`, height: `${Math.max(4, storyForm.height * 100)}%`, transform: `translate(-50%, -50%) rotate(${storyForm.rotation}deg)` }}>Link Sticker</div>}</div>}
            {storyForm.pipelineRunId && <div className="text-xs text-textItemBlur">承認済みPipeline: {storyForm.pipelineRunId}</div>}
            <Field label="Link URL"><input className={field} type="url" value={storyForm.linkUrl} onChange={(e) => setStoryForm({ ...storyForm, linkUrl: e.target.value })} placeholder="https://example.com" required /></Field>
            <StickerFields values={storyForm} onChange={(key, value) => setStoryForm({ ...storyForm, [key]: value })} />
            <button className={primaryButton} disabled={busy || !accounts.length}>Preflight and publish now</button>
          </div>
        </form>
        <form className={card} onSubmit={submit(async () => { const rendered = await request('/sns-studio/media/render', { method: 'POST', body: JSON.stringify(renderForm) }); setReelForm((current) => ({ ...current, videoPath: rendered.path })); return rendered; }, '動画を加工しました。Reel投稿欄に出力パスを設定しました。')}>
          <h2 className="text-lg font-bold">動画を加工</h2><p className="mb-4 mt-1 text-sm text-textItemBlur">元素材を残したまま、FFmpegで9:16動画を作ります。</p>
          <div className="grid gap-3">
            <Field label="Source path"><input className={field} value={renderForm.sourcePath} onChange={(e) => setRenderForm({ ...renderForm, sourcePath: e.target.value })} placeholder="/uploads/input.mp4" required /></Field>
            <div className="grid grid-cols-2 gap-3"><Field label="冒頭カット（秒）"><input className={field} type="number" min="0" step="0.1" value={renderForm.trimStartSeconds} onChange={(e) => setRenderForm({ ...renderForm, trimStartSeconds: Number(e.target.value) })} /></Field><Field label="末尾カット（秒）"><input className={field} type="number" min="0" step="0.1" value={renderForm.trimEndSeconds} onChange={(e) => setRenderForm({ ...renderForm, trimEndSeconds: Number(e.target.value) })} /></Field><Field label="再生速度"><input className={field} type="number" min="0.5" max="2" step="0.01" value={renderForm.playbackSpeed} onChange={(e) => setRenderForm({ ...renderForm, playbackSpeed: Number(e.target.value) })} /></Field><Field label="Crop（%）"><input className={field} type="number" min="95" max="100" step="1" value={renderForm.cropPercent} onChange={(e) => setRenderForm({ ...renderForm, cropPercent: Number(e.target.value) })} /></Field></div>
            <Field label="BGM path（任意）"><input className={field} value={renderForm.bgmPath} onChange={(e) => setRenderForm({ ...renderForm, bgmPath: e.target.value })} /></Field>
            <Field label="字幕ファイル（SRT/VTT）"><input className={field} value={renderForm.subtitlesPath} onChange={(e) => setRenderForm({ ...renderForm, subtitlesPath: e.target.value })} /></Field>
            <Field label="テキスト挿入（任意）"><input className={field} maxLength={300} value={renderForm.textOverlay} onChange={(e) => setRenderForm({ ...renderForm, textOverlay: e.target.value })} /></Field>
            {renderForm.textOverlay && <div className="grid grid-cols-3 gap-3"><Field label="Text X (0–1)"><input className={field} type="number" min="0" max="1" step="0.01" value={renderForm.textX} onChange={(e) => setRenderForm({ ...renderForm, textX: Number(e.target.value) })} /></Field><Field label="Text Y (0–1)"><input className={field} type="number" min="0" max="1" step="0.01" value={renderForm.textY} onChange={(e) => setRenderForm({ ...renderForm, textY: Number(e.target.value) })} /></Field><Field label="文字サイズ"><input className={field} type="number" min="18" max="160" value={renderForm.textFontSize} onChange={(e) => setRenderForm({ ...renderForm, textFontSize: Number(e.target.value) })} /></Field></div>}
            <div className="grid grid-cols-2 gap-3"><Field label="BGM音量"><input className={field} type="number" min="0" max="1" step="0.01" value={renderForm.bgmVolume} onChange={(e) => setRenderForm({ ...renderForm, bgmVolume: Number(e.target.value) })} /></Field><Field label="元音声音量"><input className={field} type="number" min="0" max="2" step="0.01" value={renderForm.sourceAudioVolume} onChange={(e) => setRenderForm({ ...renderForm, sourceAudioVolume: Number(e.target.value) })} /></Field></div>
            <button className={primaryButton} disabled={busy}>加工してReel欄へ</button>
          </div>
        </form>
        <form className={card} onSubmit={submit(async () => { const result = await request('/sns-studio/media/variants', { method: 'POST', body: JSON.stringify({ sourcePath: variantForm.sourcePath, count: variantForm.count, settings: JSON.parse(variantForm.settings) }) }); setVariantResults(result.variants || []); return result; }, 'Variantを生成しました。')}>
          <h2 className="text-lg font-bold">Variant Generator</h2><p className="mb-4 mt-1 text-sm text-textItemBlur">有効にした範囲だけランダムな編集値を選び、採用値を保存します。</p>
          <div className="grid gap-3"><Field label="Source path"><input className={field} value={variantForm.sourcePath} onChange={(e) => setVariantForm({ ...variantForm, sourcePath: e.target.value })} placeholder="/uploads/input.mp4" required /></Field><Field label="生成数（1–20）"><input className={field} type="number" min="1" max="20" value={variantForm.count} onChange={(e) => setVariantForm({ ...variantForm, count: Number(e.target.value) })} /></Field><Field label="変更項目と範囲（JSON）"><textarea className={`${field} min-h-40 font-mono text-xs`} value={variantForm.settings} onChange={(e) => setVariantForm({ ...variantForm, settings: e.target.value })} /></Field><button className={primaryButton} disabled={busy}>Variantsを生成</button></div>
          {variantResults.length > 0 && <div className="mt-4 grid gap-2">{variantResults.map((variant, index) => <div key={variant.mediaAssetId} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-blockSeparator p-3 text-sm"><span>Variant {index + 1} · {variant.durationSeconds?.toFixed?.(1) || '—'}s</span><code className="text-xs">{JSON.stringify(variant.adoptedSettings)}</code><button type="button" className={secondaryButton} onClick={() => setReelForm((current) => ({ ...current, videoPath: variant.path }))}>Use for Reel</button></div>)}</div>}
        </form>
        <form className={card} onSubmit={submit(async () => { const voicePreset = voicePresets.find((item) => item.id === voicePresetId); const editingPreset = editingPresets.find((item) => item.id === comicEditingPresetId); const result = await request('/sns-studio/media/comic/render', { method: 'POST', body: JSON.stringify({ ...(editingPreset?.config || {}), ...(voicePreset?.ttsSettings || {}), pages: JSON.parse(comicPages), subtitles: true, voiceSlots: voicePreset?.slots || {}, voicePresetId: voicePreset?.id, editingPresetId: editingPreset?.id }) }); setReelForm((current) => ({ ...current, videoPath: result.path, pipelineRunId: '' })); return result; }, '漫画スライド動画を作成し、Reel欄へ設定しました。')}>
          <h2 className="text-lg font-bold">漫画スライド動画</h2><p className="mb-4 mt-1 text-sm text-textItemBlur">ページごとに画像と複数セリフを設定し、speakerSlotをVoice Presetへ割り当てます。</p><Field label="Voice Preset"><select className={field} value={voicePresetId} onChange={(e) => setVoicePresetId(e.target.value)}><option value="">Presetを選択</option>{voicePresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field><Field label="Editing Preset"><select className={field} value={comicEditingPresetId} onChange={(e) => setComicEditingPresetId(e.target.value)}><option value="">既定（1080×1920 / 30fps）</option>{editingPresets.map((preset) => <option key={preset.id} value={preset.id}>{preset.name}</option>)}</select></Field><Field label="ページとセリフ"><textarea className={`${field} min-h-64 font-mono text-xs`} value={comicPages} onChange={(e) => setComicPages(e.target.value)} /></Field><button className={`${primaryButton} mt-3`} disabled={busy}>動画を生成してReel欄へ</button>
        </form>
        <form className={card} onSubmit={submit(async () => { const result = await request('/sns-studio/media/concat', { method: 'POST', body: JSON.stringify({ paths: JSON.parse(concatPaths) }) }); setReelForm((current) => ({ ...current, videoPath: result.path })); return result; }, '動画を結合し、Reel欄へ設定しました。')}><h2 className="text-lg font-bold">動画を結合</h2><p className="mb-3 mt-1 text-sm text-textItemBlur">順番に並べた2〜20本の動画を縦動画へ変換して結合します。パスは共有uploads内を指定してください。</p><Field label="動画パスの配列（JSON）"><textarea className={`${field} min-h-32 font-mono text-xs`} value={concatPaths} onChange={(e) => setConcatPaths(e.target.value)} /></Field><button className={`${primaryButton} mt-3`} disabled={busy}>結合してReel欄へ</button></form>
      </section>}

      {activeTab === 'Story Pools' && <section className="grid gap-5 xl:grid-cols-2">
        <form className={card} onSubmit={submit(() => request('/sns-studio/story-pools', { method: 'POST', body: JSON.stringify(poolForm) }), 'Story Poolを作成しました。')}>
          <h2 className="text-lg font-bold">New Story Pool</h2>
          <div className="mt-4 grid gap-3"><Field label="Pool name"><input className={field} value={poolForm.name} onChange={(e) => setPoolForm({ ...poolForm, name: e.target.value })} required /></Field><Field label="Description"><input className={field} value={poolForm.description} onChange={(e) => setPoolForm({ ...poolForm, description: e.target.value })} /></Field><button className={primaryButton} disabled={busy}>Create Pool</button></div>
        </form>
        <form className={card} onSubmit={submit(() => request(`/sns-studio/story-pools/${poolItemForm.poolId}/items`, { method: 'POST', body: JSON.stringify({ mediaPath: poolItemForm.mediaPath, mediaType: poolItemForm.mediaType, urlLibraryId: poolItemForm.urlLibraryId || undefined }) }), '素材をStory Poolへ追加しました。')}>
          <h2 className="text-lg font-bold">Add item</h2>
          <div className="mt-4 grid gap-3"><Field label="Pool"><select className={field} value={poolItemForm.poolId} onChange={(e) => setPoolItemForm({ ...poolItemForm, poolId: e.target.value })} required><option value="">Select a pool</option>{pools.map((pool) => <option key={pool.id} value={pool.id}>{pool.name}</option>)}</select></Field><Field label="Media path"><input className={field} value={poolItemForm.mediaPath} onChange={(e) => setPoolItemForm({ ...poolItemForm, mediaPath: e.target.value })} required /></Field><Field label="Media type"><select className={field} value={poolItemForm.mediaType} onChange={(e) => setPoolItemForm({ ...poolItemForm, mediaType: e.target.value })}><option value="image">Image</option><option value="video">Video</option></select></Field><Field label="URL Library item"><select className={field} value={poolItemForm.urlLibraryId} onChange={(e) => setPoolItemForm({ ...poolItemForm, urlLibraryId: e.target.value })}><option value="">No library URL</option>{urls.filter((url) => url.active).map((url) => <option key={url.id} value={url.id}>{url.name}</option>)}</select></Field><button className={primaryButton} disabled={busy}>Add item</button></div>
        </form>
        <form className={`${card} xl:col-span-2`} onSubmit={submit(() => request('/sns-studio/urls', { method: 'POST', body: JSON.stringify(urlForm) }), 'URLを保存しました。')}>
          <h2 className="text-lg font-bold">URL Library</h2>
          <div className="mt-4 grid gap-3 md:grid-cols-4"><Field label="Name"><input className={field} value={urlForm.name} onChange={(e) => setUrlForm({ ...urlForm, name: e.target.value })} required /></Field><Field label="URL"><input className={field} type="url" value={urlForm.url} onChange={(e) => setUrlForm({ ...urlForm, url: e.target.value })} required /></Field><Field label="Note"><input className={field} value={urlForm.note} onChange={(e) => setUrlForm({ ...urlForm, note: e.target.value })} /></Field><div className="flex items-end"><button className={primaryButton} disabled={busy}>Save URL</button></div></div>
          <div className="mt-4 flex flex-wrap gap-2">{urls.map((url) => <span key={url.id} className="rounded-lg border border-blockSeparator px-3 py-2 text-sm">{url.name} · {url.url}</span>)}</div>
        </form>
        <div className={`${card} xl:col-span-2`}><div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-bold">Account Shuffle Bags</h2><select className={`${field} max-w-xs`} value={storyForm.accountId || defaultAccount} onChange={(e) => setStoryForm({ ...storyForm, accountId: e.target.value })}><option value="">Select account</option>{accounts.map((a) => <option key={a.id} value={a.id}>@{a.username}</option>)}</select><button className={secondaryButton} onClick={() => void prepareRandomStory()} disabled={busy}>Random Storyを準備</button></div><div className="mt-3 grid gap-3 md:grid-cols-2">{pools.map((pool) => <div key={pool.id} className="rounded-lg border border-blockSeparator p-4"><div className="font-bold">{pool.name}</div><div className="mt-1 text-sm text-textItemBlur">{pool.items.length} items</div>{pool.items.map((item) => <div key={item.id} className="mt-2 truncate text-xs text-textItemBlur">{item.mediaPath} · {item.urlLibrary?.name || item.urlSnapshot || 'URL未設定'}</div>)}</div>)}</div></div>
      </section>}

      {activeTab === 'Automation Recipes' && <section className="grid gap-5 xl:grid-cols-2">
        <form className={card} onSubmit={submit(async () => request('/sns-studio/recipes', { method: 'POST', body: JSON.stringify({ name: recipeForm.name, inputType: recipeForm.inputType, config: JSON.parse(recipeForm.config) }) }), 'Recipeを保存しました。')}>
          <h2 className="text-lg font-bold">New Automation Recipe</h2><div className="mt-4 grid gap-3"><Field label="Name"><input className={field} value={recipeForm.name} onChange={(e) => setRecipeForm({ ...recipeForm, name: e.target.value })} required /></Field><Field label="Input type"><select className={field} value={recipeForm.inputType} onChange={(e) => setRecipeForm({ ...recipeForm, inputType: e.target.value })}><option>VIDEO</option><option>COMIC_PAGES</option><option>STORY_POOL</option></select></Field><Field label="Recipe config (JSON)"><textarea className={`${field} min-h-40 font-mono text-xs`} value={recipeForm.config} onChange={(e) => setRecipeForm({ ...recipeForm, config: e.target.value })} /></Field><button className={primaryButton} disabled={busy}>Save Recipe</button></div>
        </form><div className={card}><h2 className="text-lg font-bold">Saved Recipes</h2><p className="mt-2 text-sm text-textItemBlur">Recipeを実行すると素材の生成・編集が始まり、完成後にQueueでPreviewと承認を行います。</p><Field label="VIDEO Recipe source path"><input className={`${field} mt-3`} value={recipeSourcePath} onChange={(e) => setRecipeSourcePath(e.target.value)} placeholder="/uploads/source.mp4" /></Field><div className="mt-4 grid gap-3">{recipes.length ? recipes.map((recipe) => <div key={recipe.id} className="rounded-lg border border-blockSeparator p-4"><div className="font-bold">{recipe.name}</div><div className="mt-1 text-xs text-textItemBlur">{recipe.inputType}</div><pre className="mt-3 overflow-auto text-xs text-textItemBlur">{JSON.stringify(recipe.config, null, 2)}</pre><button className={`${secondaryButton} mt-3`} disabled={busy || (recipe.inputType === 'VIDEO' && !recipeSourcePath.trim())} onClick={() => void run(() => startRecipe(recipe), 'PipelineをQueueへ登録しました。')}>Run recipe</button></div>) : <Empty>保存済みRecipeはありません。</Empty>}</div></div>
      </section>}

      {activeTab === 'Queue' && <section className={card}><h2 className="text-lg font-bold">制作Queue</h2><p className="mb-4 mt-1 text-sm text-textItemBlur">生成・編集後に完成素材をPreviewし、承認したものだけCreateから今すぐ投稿できます。</p><div className="grid gap-3">{queue.length ? queue.map((item: any) => { const output = item.output || {}; return <div key={item.id} className="rounded-lg border border-blockSeparator p-4"><div className="flex flex-wrap justify-between gap-2"><strong>{item.recipe?.name || 'Pipeline'}</strong><span className="text-sm text-textItemBlur">{item.status} · {item.currentStep || '—'}</span></div>{item.errorCode && <div className="mt-2 text-sm text-red-300">{item.errorCode}</div>}<div className="mt-3 flex flex-wrap gap-2">{item.steps?.map((step: any) => <span key={step.id} className="rounded-full border border-blockSeparator px-3 py-1 text-xs">{step.name}: {step.status}</span>)}</div>{output.mediaPath && <div className="mt-4 max-w-2xl">{output.publishType === 'STORY' ? <div className="relative mx-auto aspect-[9/16] max-h-[520px] w-full max-w-[293px] overflow-hidden rounded-lg bg-black">{output.mediaType === 'image' ? <img className="absolute inset-0 h-full w-full object-contain" src={previewUrl(output.mediaPath)} alt="Story preview" /> : <video className="absolute inset-0 h-full w-full object-contain" controls preload="metadata" src={previewUrl(output.mediaPath)} />}{output.linkUrl && output.storySticker && <div className="pointer-events-none absolute flex items-center justify-center rounded-full bg-white/90 px-2 text-center text-xs font-semibold text-black" style={{ left: `${(output.storySticker.x ?? 0.5) * 100}%`, top: `${(output.storySticker.y ?? 0.5) * 100}%`, width: `${Math.max(10, (output.storySticker.width ?? 0.5) * 100)}%`, height: `${Math.max(4, (output.storySticker.height ?? 0.25) * 100)}%`, transform: `translate(-50%, -50%) rotate(${output.storySticker.rotation || 0}deg)` }}>Link Sticker</div>}</div> : output.mediaType === 'image' ? <img className="max-h-[32rem] w-full rounded-lg bg-black object-contain" src={previewUrl(output.mediaPath)} alt="Pipeline preview" /> : <video className="max-h-[32rem] w-full rounded-lg bg-black" controls preload="metadata" src={previewUrl(output.mediaPath)} />}<div className="mt-2 text-xs text-textItemBlur">{output.mediaPath}{output.durationSeconds ? ` · ${Number(output.durationSeconds).toFixed(1)} 秒` : ''}{output.linkUrl ? ` · ${output.linkUrl}` : ''}</div></div>}{item.status === 'READY_FOR_REVIEW' && <button className={`${primaryButton} mt-3`} onClick={() => void run(() => request(`/sns-studio/queue/${item.id}/approve`, { method: 'POST', body: '{}' }), 'Previewを確認しPipelineを承認しました。')}>Previewを確認して承認</button>}{item.status === 'APPROVED' && <button className={`${primaryButton} mt-3`} onClick={() => loadPipelineForCreate(item)}>Createで投稿内容を確認</button>}{item.status === 'FAILED' && <button className={`${secondaryButton} mt-3`} onClick={() => void run(() => request(`/sns-studio/queue/${item.id}/retry`, { method: 'POST', body: '{}' }), item.currentStep === 'PUBLISH' ? '投稿工程を再開しました。Createで内容を確認して手動投稿してください。' : '失敗した工程から再実行を開始しました。')} disabled={busy}>この工程から再実行</button>}{item.publishRecords?.[0]?.postUrl && <a className="ml-3 text-sm text-[#9e9aff] underline" href={item.publishRecords[0].postUrl} target="_blank" rel="noreferrer">投稿を開く</a>}</div>; }) : <Empty>制作Queueは空です。</Empty>}</div></section>}

      {activeTab === 'Analytics' && <section className={card}><h2 className="text-lg font-bold">Analytics</h2><p className="mb-4 mt-1 text-sm text-textItemBlur">取得できない指標は空欄のまま保存します。Metric更新と失敗投稿の再送は手動で実行します。</p><div className="grid gap-3">{records.length ? records.map((record) => <div key={record.id} className="flex flex-wrap items-center gap-4 rounded-lg border border-blockSeparator p-4"><div className="min-w-[170px] flex-1"><div className="font-bold">@{record.account.username} · {record.publishType}</div><div className="mt-1 text-xs text-textItemBlur">{record.publishedAt ? new Date(record.publishedAt).toLocaleString() : record.status}</div></div><span className="text-sm">{JSON.stringify(record.snapshots?.[0]?.metrics || {})}</span>{record.status === 'FAILED' && <button className={secondaryButton} title="This manually sends the same media again." onClick={() => void run(() => request(`/sns-studio/publish-records/${record.id}/retry`, { method: 'POST', body: '{}' }), '失敗した素材を再送しました。')} disabled={busy}>投稿だけ再実行</button>}{record.mediaId && <button className={secondaryButton} onClick={() => void run(() => request(`/sns-studio/analytics/media/${record.mediaId}`), 'Analyticsを取得しました。')} disabled={busy}>Refresh insights</button>}{record.postUrl && <a className="text-sm text-[#9e9aff] underline" href={record.postUrl} target="_blank" rel="noreferrer">Open post</a>}</div>) : <Empty>投稿履歴はありません。</Empty>}</div></section>}

      {activeTab === 'Settings' && <section className="grid gap-5 xl:grid-cols-2">
        <div className={card}><h2 className="text-lg font-bold">Google Drive Storage</h2><p className="mt-1 text-sm text-textItemBlur">認証トークンはローカルで暗号化し、指定フォルダの画像・動画をInboxへ同期します。</p>
          <div className="mt-4 flex flex-wrap gap-2"><button className={primaryButton} onClick={() => void run(async () => { const { url } = await request('/sns-studio/drive/oauth-url'); window.location.assign(url); }, 'Google Driveへ移動します。')} disabled={busy}>{driveStatus?.connected ? 'Google Drive再接続' : 'Google Driveを接続'}</button><button className={secondaryButton} onClick={() => void refreshDrive()} disabled={busy}>接続状態を更新</button></div>
          <div className="mt-3 text-sm">状態: {driveStatus?.connected ? '接続済み' : '未接続'}</div>
          {driveStatus?.connected && <div className="mt-4 grid gap-3"><Field label="同期するGoogle Driveフォルダ"><select className={field} value={driveFolderId} onChange={(e) => setDriveFolderId(e.target.value)}><option value="">フォルダを選択</option>{driveFolders.map((folder: any) => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><div className="flex flex-wrap gap-2"><button className={secondaryButton} onClick={() => void run(() => request('/sns-studio/drive/folder', { method: 'PUT', body: JSON.stringify({ folderId: driveFolderId }) }), 'Driveフォルダを保存しました。')} disabled={busy || !driveFolderId}>フォルダを保存</button><button className={primaryButton} onClick={() => void run(() => request('/sns-studio/drive/sync', { method: 'POST', body: '{}' }), 'Google Drive同期が完了しました。')} disabled={busy || !driveStatus.folder?.id}>今すぐ同期</button><button className={secondaryButton} onClick={() => void refreshDriveFolders()} disabled={busy}>フォルダ一覧を更新</button></div></div>}
        </div>
        <div className={`${card} xl:col-span-2`}><h2 className="text-lg font-bold">Generation Jobs</h2><p className="mt-2 text-sm text-textItemBlur">モデルに依存しないDrive Job Queueです。Colab Workerがjob.jsonを読み、結果JSONとDrive file IDを書き戻します。</p><div className="mt-2 break-all text-xs text-textItemBlur">選択Folder ID: {driveStatus?.folder?.id || '未設定'}</div><div className="mt-3 grid gap-3 md:grid-cols-3"><Field label="生成メモ"><textarea className={`${field} min-h-20`} value={generationInput.prompt} onChange={(e) => setGenerationInput({ ...generationInput, prompt: e.target.value })} placeholder="ColabのモデルAdapterへ渡す指示" /></Field><Field label="生成数"><input className={field} type="number" min="1" max="20" value={generationInput.count} onChange={(e) => setGenerationInput({ ...generationInput, count: Number(e.target.value) })} /></Field><Field label="出力タイプ"><select className={field} value={generationInput.mediaType} onChange={(e) => setGenerationInput({ ...generationInput, mediaType: e.target.value })}><option value="video">Video</option><option value="image">Image</option></select></Field></div><div className="mt-3 flex flex-wrap gap-2"><button className={primaryButton} onClick={() => void run(() => request('/sns-studio/generation/jobs', { method: 'POST', body: JSON.stringify({ input: generationInput }) }), 'Generation JobをDriveへ送信しました。')} disabled={busy || !driveStatus?.connected || !driveStatus?.folder?.id || !generationInput.prompt.trim()}>Colab Queueへ送信</button><button className={secondaryButton} onClick={() => void run(() => request('/sns-studio/generation/jobs/sync', { method: 'POST', body: '{}' }), 'DriveからGeneration結果を同期しました。')} disabled={busy || !driveStatus?.connected}>結果を同期</button></div><div className="mt-4 grid gap-2">{generationJobs.length ? generationJobs.slice(0, 20).map((job: any) => <div key={job.id} className="rounded-lg border border-blockSeparator p-3 text-sm"><div className="flex flex-wrap justify-between gap-2"><strong>{job.status}</strong><span className="text-textItemBlur">{new Date(job.createdAt).toLocaleString()}</span></div><div className="mt-1 text-xs text-textItemBlur">{job.errorCode || job.queuePath || JSON.stringify(job.inputManifest)}</div></div>) : <Empty>Generation Jobはありません。</Empty>}</div></div>
        <div className={card}><h2 className="text-lg font-bold">Local Services</h2><div className="mt-4 grid gap-3 text-sm"><ServiceRow name="Instagram Worker" value={instagramWorkerHealth?.status === 'ok' ? '起動中' : '未接続'} /><ServiceRow name="Google Drive" value={driveStatus?.connected ? '接続済み' : 'OAuth設定が必要'} /><ServiceRow name="Media Worker" value={mediaWorkerHealth?.status === 'ok' ? '起動中' : '未接続'} /><ServiceRow name="FFmpeg / ffprobe" value={mediaWorkerHealth?.ffmpeg && mediaWorkerHealth?.ffprobe ? '利用可能' : '未確認'} /><ServiceRow name="VOICEVOX" value={voiceSpeakers && !voiceError ? '利用可能' : '未接続'} /></div></div>
        <form className={card} onSubmit={submit(() => request('/sns-studio/settings', { method: 'PUT', body: JSON.stringify({ retentionDays }) }), '保持期間を保存しました。')}><h2 className="text-lg font-bold">Media retention</h2><p className="mt-2 text-sm text-textItemBlur">元素材と投稿履歴は保持し、投稿成功した完成動画だけ期限後に削除します。</p><div className="mt-4 flex flex-wrap items-end gap-3"><Field label="完成動画の保持期間"><select className={`${field} min-w-40`} value={retentionDays} onChange={(e) => setRetentionDays(Number(e.target.value))}><option value={7}>7日</option><option value={30}>30日</option><option value={0}>削除しない</option></select></Field><button className={primaryButton} disabled={busy}>保存</button><button type="button" className={secondaryButton} disabled={busy} onClick={() => void run(() => request('/sns-studio/storage/cleanup', { method: 'POST', body: '{}' }), 'Cleanupを実行しました。')}>Cleanupを実行</button></div></form>
        <div className={card}><h2 className="text-lg font-bold">Editing Presets</h2><form className="mt-3 grid gap-3" onSubmit={submit(() => request('/sns-studio/editing-presets', { method: 'POST', body: JSON.stringify({ name: editingPresetForm.name, config: JSON.parse(editingPresetForm.config) }) }), 'Editing Presetを保存しました。')}><Field label="Preset名"><input className={field} value={editingPresetForm.name} onChange={(e) => setEditingPresetForm({ ...editingPresetForm, name: e.target.value })} /></Field><Field label="編集設定（JSON）"><textarea className={`${field} min-h-32 font-mono text-xs`} value={editingPresetForm.config} onChange={(e) => setEditingPresetForm({ ...editingPresetForm, config: e.target.value })} /></Field><button className={primaryButton} disabled={busy}>Presetを保存</button></form><div className="mt-3 grid gap-2">{editingPresets.map((preset) => <button key={preset.id} className="rounded-lg border border-blockSeparator p-3 text-left text-sm" onClick={() => { setEditingPresetForm({ name: preset.name, config: JSON.stringify(preset.config, null, 2) }); setRenderForm((current) => ({ ...current, ...preset.config })); setActiveTab('Create'); }}>{preset.name} · Createに適用</button>)}</div></div>
        <div className={card}><h2 className="text-lg font-bold">VOICEVOX speakers</h2><p className="mt-2 text-sm text-textItemBlur">漫画動画の各セリフへ指定するspeakerIdを確認できます。利用時は声ごとの利用規約・クレジット条件を確認してください。</p>{voiceError ? <div className="mt-3 text-sm text-amber-300">VOICEVOXが利用できません。サービス状態を確認してください。</div> : <div className="mt-3 max-h-64 overflow-auto">{(voiceSpeakers || []).map((speaker: any) => <div key={speaker.name} className="border-b border-blockSeparator py-2 text-sm"><strong>{speaker.name}</strong><div className="mt-1 flex flex-wrap gap-2">{(speaker.styles || []).map((style: any) => <span key={style.id} className="rounded-full border border-blockSeparator px-2 py-1 text-xs">{style.name}: {style.id}</span>)}</div></div>)}</div>}</div>
        <div className={card}><h2 className="text-lg font-bold">Voice Presets</h2><p className="mt-2 text-sm text-textItemBlur">FEMALE_1 / FEMALE_2 / MALE_1 / MALE_2 を実際のVOICEVOX style IDへ割り当てます。</p><form className="mt-3 grid gap-3" onSubmit={submit(() => request('/sns-studio/voice-presets', { method: 'POST', body: JSON.stringify({ name: voicePresetForm.name, slots: JSON.parse(voicePresetForm.slots), ttsSettings: JSON.parse(voicePresetForm.ttsSettings) }) }), 'Voice Presetを保存しました。')}><Field label="Preset名"><input className={field} value={voicePresetForm.name} onChange={(e) => setVoicePresetForm({ ...voicePresetForm, name: e.target.value })} /></Field><Field label="Speaker slots（JSON）"><textarea className={`${field} min-h-24 font-mono text-xs`} value={voicePresetForm.slots} onChange={(e) => setVoicePresetForm({ ...voicePresetForm, slots: e.target.value })} /></Field><Field label="TTS・字幕設定（JSON）"><textarea className={`${field} min-h-24 font-mono text-xs`} value={voicePresetForm.ttsSettings} onChange={(e) => setVoicePresetForm({ ...voicePresetForm, ttsSettings: e.target.value })} /></Field><button className={primaryButton} disabled={busy}>Voice Presetを保存</button></form><div className="mt-3 grid gap-2">{voicePresets.map((preset) => <button key={preset.id} className="rounded-lg border border-blockSeparator p-3 text-left text-sm" onClick={() => { setVoicePresetId(preset.id); setVoicePresetForm({ name: preset.name, slots: JSON.stringify(preset.slots, null, 2), ttsSettings: JSON.stringify(preset.ttsSettings || {}, null, 2) }); }}>{preset.name} · {JSON.stringify(preset.slots)}</button>)}</div></div>
      </section>}
    </div>
  );
};

const Field = ({ label, children }: { label: string; children: React.ReactNode }) => <label className="grid gap-1.5 text-sm"><span className="font-medium text-textItemBlur">{label}</span>{children}</label>;
const Empty = ({ children }: { children: React.ReactNode }) => <div className="rounded-lg border border-dashed border-blockSeparator px-4 py-8 text-center text-sm text-textItemBlur">{children}</div>;
const Metric = ({ title, value, detail }: { title: string; value: string | number; detail: string }) => <div className={card}><div className="text-sm text-textItemBlur">{title}</div><div className="mt-2 text-3xl font-bold">{value}</div><div className="mt-1 text-xs text-textItemBlur">{detail}</div></div>;
const ServiceRow = ({ name, value }: { name: string; value: string }) => <div className="flex justify-between gap-3 rounded-lg border border-blockSeparator p-3"><span className="font-semibold">{name}</span><span className="text-right text-textItemBlur">{value}</span></div>;
const AccountSelect = ({ accounts, value, onChange }: { accounts: Account[]; value: string; onChange: (id: string) => void }) => <Field label="Instagram Account"><select className={field} value={value} onChange={(event) => onChange(event.target.value)} required><option value="">Select account</option>{accounts.map((account) => <option key={account.id} value={account.id}>@{account.username}</option>)}</select></Field>;
const StickerFields = ({ values, onChange }: { values: Record<string, any>; onChange: (key: 'x' | 'y' | 'width' | 'height' | 'rotation', value: number) => void }) => <div className="grid grid-cols-2 gap-3"><Field label="Sticker X"><input className={field} type="number" min="0" max="1" step="0.01" value={values.x} onChange={(e) => onChange('x', Number(e.target.value))} /></Field><Field label="Sticker Y"><input className={field} type="number" min="0" max="1" step="0.01" value={values.y} onChange={(e) => onChange('y', Number(e.target.value))} /></Field><Field label="Width"><input className={field} type="number" min="0.01" max="1" step="0.01" value={values.width} onChange={(e) => onChange('width', Number(e.target.value))} /></Field><Field label="Height"><input className={field} type="number" min="0.01" max="1" step="0.01" value={values.height} onChange={(e) => onChange('height', Number(e.target.value))} /></Field><Field label="Rotation"><input className={field} type="number" min="-360" max="360" step="1" value={values.rotation} onChange={(e) => onChange('rotation', Number(e.target.value))} /></Field></div>;
const RecordList = ({ records }: { records: PublishRecord[] }) => <div className="mt-3 grid gap-2">{records.length ? records.map((record) => <div key={record.id} className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blockSeparator p-3 text-sm"><span>@{record.account.username} · {record.publishType}</span><span className={record.status === 'PUBLISHED' ? 'text-green-400' : record.status === 'FAILED' ? 'text-red-400' : 'text-textItemBlur'}>{record.status}</span><span className="text-textItemBlur">{record.publishedAt ? new Date(record.publishedAt).toLocaleString() : record.errorCode || ''}</span></div>) : <Empty>投稿履歴はありません。</Empty>}</div>;
