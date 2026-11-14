'use client';
import { useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { useLaunchStore } from '@gitroom/frontend/components/new-launch/store';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { ExistingDataContextProvider } from '@gitroom/frontend/components/launches/helpers/use.existing.data';
import { InlinePublishSession, threadsConnection } from './inline-publish-session';
import type { CommonPublishPrefill } from './common-publisher';

export function InlinePublisher({ threadsOnly = false, prefill }: { threadsOnly?: boolean; prefill?: CommonPublishPrefill | null }) {
  const request = useFetch();
  const user = useUser();
  const applyContent = useLaunchStore(s => s.setGlobalValueText);
  useEffect(() => { if (prefill?.content) applyContent(0, prefill.content); }, [prefill?.content, applyContent]);
  const active = useRef(true);
  useEffect(() => () => { active.current = false; }, []);
  const { data, error, isLoading } = useIntegrationList();
  const [existing, setExisting] = useState<any>(null);
  const [revision, setRevision] = useState(0);
  const [message, setMessage] = useState('');
  const [stopped, setStopped] = useState(false);
  const session = useRef(new InlinePublishSession());
  const load = async (path: string) => {
    const response = await request(path);
    if (!response.ok) throw new Error('データを取得できませんでした。');
    return response.json();
  };
  const { data: threads, error: threadsError } = useSWR((data || []).some((a: any) => a.identifier === 'threads') ? ['/threads-studio/accounts', user?.orgId] : null, ([path]) => load(path));
  const { data: plans, error: plansError, mutate } = useSWR(['/sns-studio/content-plans', user?.orgId], ([path]) => load(path));
  const threadAccounts: any[] = Array.isArray(threads) ? threads : threads?.accounts || [];
  const accounts = (Array.isArray(data) ? data : []).filter(a => !a.disabled && !a.inBetweenSteps && (!threadsOnly || a.identifier === 'threads')).map(a => {
    const account = threadAccounts.find(t => t.id === a.id);
    const connection = a.identifier === 'threads' ? threadsConnection(a.additionalSettings, account) : { transport: undefined, browserAccount: undefined };
    return { ...a, ...connection, name: a.identifier === 'threads' ? `@${account?.username || a.display || a.name} [${connection.transport === 'browser' ? 'Browser' : connection.transport === 'official' ? 'Official API' : '接続方式未確認'}]` : a.name };
  });
  const preparePost = async (type: string, snapshot: any) => {
    if (!active.current) throw new Error('Organizationが変更されました。');
    if (threadsOnly && snapshot.posts.length !== 1) throw new Error('Threadsの投稿先を1つ選択してください。');
    for (const post of snapshot.posts) {
      const destination = accounts.find(a => a.id === post.integration.id);
      if (!destination) throw new Error('現在のOrganizationに投稿先がありません。');
      if (destination.transport === 'browser' && (!destination.browserAccount || post.settings?.browserAccount !== destination.browserAccount)) throw new Error('保存されたBrowserアカウント設定を確認してください。別アカウントへの切替は行いません。');
    }
    let id: string;
    try { id = await session.current.prepare(request, {
      commonContent: snapshot.posts[0]?.value[0]?.content || '',
      commonScheduledAt: type === 'schedule' ? snapshot.date : null,
      deliveries: snapshot.posts.map((p: any) => ({ integrationId: p.integration.id, contentOverride: p.value[0]?.content || '', settingsOverride: p.settings })),
    });
    } catch (e) { if (session.current.uncertain) setStopped(true); throw e; }
    if (!active.current) throw new Error('Organizationが変更されました。');
    return id;
  };
  const preflight = async (type: string) => {
    if (!active.current) throw new Error('Organizationが変更されました。');
    const r = await request(`/sns-studio/common/content-plans/${session.current.planId}/preflight`, { method: 'POST', body: JSON.stringify({ type }) });
    const result = await r.json();
    if (!r.ok) throw new Error(result.message || result.blockedDeliveries?.flatMap((d: any) => d.reasons?.map((reason: any) => reason.message)).join(' ') || '投稿前確認で停止しました。');
  };
  const openDraft = async (plan: any) => {
    try {
      const postId = plan.deliveries?.[0]?.postId;
      if (!postId || plan.deliveries.length !== 1) throw new Error('この下書きはカレンダーから編集してください。');
      const draft = await load(`/posts/${postId}`);
      if (!draft.posts?.length || draft.posts.some((p: any) => p.state !== 'DRAFT')) throw new Error('下書きの状態が変わりました。履歴を確認してください。');
      if (!accounts.some(a => a.id === draft.integration)) throw new Error('現在のOrganizationに投稿先がありません。');
      session.current = new InlinePublishSession(); session.current.planId = plan.id; session.current.linked = true;
      setStopped(false); setExisting(draft); setRevision(r => r + 1); setMessage('下書きを読み込みました。');
    } catch (e) { setMessage(e instanceof Error ? e.message : '下書きを取得できませんでした。'); }
  };
  if (isLoading || ((data || []).some((a: any) => a.identifier === 'threads') && !threads && !threadsError)) return <p role="status">投稿先を読み込み中…</p>;
  if (error || threadsError) return <p role="alert">投稿先の取得に失敗しました。再読み込みしてください。</p>;
  if (!accounts.length) return <p>{threadsOnly ? 'Threadsアカウントを接続してください。' : '投稿先アカウントを接続してください。'} <a className="underline" href="/integrations">アカウント接続</a></p>;
  return <section className="grid gap-4">
    <div className="rounded-xl border border-blockSeparator p-5">
      <h2 className="text-xl font-bold">{threadsOnly ? 'Threads 投稿作成' : '複数SNSに投稿'}</h2>
      <p className="mt-2 text-sm text-textItemBlur">投稿先、投稿本文、画像／動画を編集し、下書き・予約・今すぐ投稿を選択してください。公開状態は履歴で確認できます。</p>
      {threadsOnly && <p className="mt-2 text-sm">Browser Transportの実投稿・予約は安全確認が完了するまでロックされます。下書きは保存できます。</p>}
      {message && <p role="status" className="mt-2">{message}</p>}
      {stopped && <a href="/launches" className="underline">履歴・カレンダーで結果を確認</a>}
    </div>
    <ExistingDataContextProvider value={existing || { integration: '', posts: [], settings: {} }}>
      <AddEditModal key={revision} embedded singleDestination={threadsOnly} date={existing?.posts?.[0]?.publishDate ? dayjs.utc(existing.posts[0].publishDate).local() : dayjs()}
        integrations={accounts} allIntegrations={accounts} selectedChannels={existing ? undefined : prefill?.initialDestinationId ? [prefill.initialDestinationId] : undefined}
        selectedChannelSettings={Object.fromEntries(accounts.filter(a => a.transport === 'browser' && a.browserAccount).map(a => [a.id, { browserAccount: a.browserAccount }]))}
        onlyValues={prefill ? [{ content: prefill.content || '', image: (prefill.variants?.find(v => v.sourceAssetId === prefill.defaultVariantAssetId)?.media || prefill.media) ? [prefill.variants?.find(v => v.sourceAssetId === prefill.defaultVariantAssetId)?.media || prefill.media] : [] }] : undefined}
        reopenModal={() => {}} mutate={() => void mutate()} preparePost={preparePost} onBeforePost={preflight}
        isSubmissionCurrent={() => active.current} submissionBlocked={stopped} onSubmissionUncertain={() => { session.current.uncertain = true; setStopped(true); setMessage('受付結果を確認できません。再送せず履歴を確認してください。'); }}
        onPosted={async result => {
          if (!active.current) throw new Error('Organizationが変更されました。履歴を確認してください。');
          session.current.linked = true;
          setStopped(true); // No new registration while linking/reloading a canonical draft.
          const r = await request(`/sns-studio/content-plans/${session.current.planId}/post-links`, { method: 'POST', body: JSON.stringify(result) });
          if (!r.ok) { setMessage('投稿は受け付けられましたが履歴の更新に失敗しました。再投稿せずカレンダーを確認してください。'); return; }
          if (result.type === 'draft' && result.items.length === 1) {
            const draft = await load(`/posts/${result.items[0].postId}`);
            setExisting(draft); setRevision(r => r + 1); setStopped(false); setMessage('下書きを保存しました。再編集すると同じ下書きを更新します。');
          } else setMessage(result.type === 'draft' ? '下書きを保存しました。再編集はカレンダーから行えます。' : result.type === 'schedule' ? '予約登録を受け付けました。履歴で状態を確認してください。' : '投稿を受け付けました。公開はまだ確認されていません。');
          void mutate();
        }} />
    </ExistingDataContextProvider>
    <details className="rounded-xl border border-blockSeparator p-4"><summary>保存済み下書きを編集</summary>
      {plansError && <p role="alert">下書き一覧の取得に失敗しました。</p>}
      {(plans || []).filter((p: any) => p.status === 'POSTIZ_DRAFT' && (!threadsOnly || (p.deliveries?.length === 1 && accounts.some(a => a.id === p.deliveries[0].integrationId)))).map((p: any) => <button key={p.id} className="m-2 rounded border border-blockSeparator p-2" onClick={() => void openDraft(p)}>{p.title || '下書き'}を編集</button>)}
    </details>
  </section>;
}
