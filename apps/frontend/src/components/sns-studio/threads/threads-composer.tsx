'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import { useUser } from '@gitroom/frontend/components/layout/user.context';
import { CalendarWeekProvider } from '@gitroom/frontend/components/launches/calendar.context';
import { ExistingDataContextProvider } from '@gitroom/frontend/components/launches/helpers/use.existing.data';
import { AddEditModal } from '@gitroom/frontend/components/new-launch/add.edit.modal';
import { LaunchStoreProvider } from '@gitroom/frontend/components/new-launch/store';
import {
  linkCommonContentPosts,
  preflightCommonContentPlan,
  saveCommonContentPlan,
} from '../common-publish-api';

const emptyPost = {
  integration: '',
  group: undefined as string | undefined,
  posts: [] as any[],
  settings: {},
};
const button =
  'rounded-lg border border-blockSeparator px-4 py-2 text-sm disabled:opacity-50';

export function ThreadsComposer() {
  const user = useUser();
  return user?.orgId ? (
    <OrganizationComposer key={user.orgId} organizationId={user.orgId} />
  ) : (
    <p role="status">Organizationを確認中です。</p>
  );
}

function OrganizationComposer({ organizationId }: { organizationId: string }) {
  const request = useFetch();
  const load = useCallback(
    async ([, path]: [string, string]) => {
      const response = await request(path);
      if (!response.ok)
        throw new Error(
          '投稿先の取得に失敗しました。時間をおいて再読込してください。'
        );
      return response.json();
    },
    [request]
  );
  const accountQuery = useSWR(
    [organizationId, '/threads-studio/accounts'],
    load
  );
  const integrationQuery = useSWR([organizationId, '/integrations/list'], load);
  const accounts = Array.isArray(accountQuery.data)
    ? accountQuery.data
    : accountQuery.data?.accounts || [];
  const integrations = integrationQuery.data?.integrations || [];
  const [accountId, setAccountId] = useState('');
  const selectionKey = `sns-studio:threads-composer:${organizationId}:selection`;
  useEffect(() => {
    setAccountId(localStorage.getItem(selectionKey) || '');
  }, [selectionKey]);
  const [editing, setEditing] = useState<any>(emptyPost);
  const [revision, setRevision] = useState(0);
  const [busy, setBusy] = useState(false);
  const [draftLoading, setDraftLoading] = useState(false);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState<any>(null);
  const plan = useRef<string | null>(null);
  const selected = accounts.find((account: any) => account.id === accountId);
  const integration = integrations.find(
    (item: any) =>
      item.id === accountId &&
      item.identifier === 'threads' &&
      !item.disabled &&
      !item.inBetweenSteps
  );
  const storageKey = `sns-studio:threads-composer:${organizationId}:${accountId}`;

  const remember = (value: any) => {
    localStorage.setItem(storageKey, JSON.stringify(value));
  };
  const loadDraft = useCallback(
    async (group: string) => {
      const response = await request(
        `/posts/group/${encodeURIComponent(group)}`
      );
      if (!response.ok)
        throw new Error(
          '保存済み下書きを取得できません。再送せず、投稿履歴を確認してください。'
        );
      const data = await response.json();
      if (
        data.integration !== accountId ||
        !data.posts?.length ||
        data.posts.some((post: any) => post.state !== 'DRAFT')
      )
        throw new Error(
          'この投稿は下書きとして編集できません。投稿履歴で状態を確認してください。'
        );
      return data;
    },
    [request, accountId]
  );

  useEffect(() => {
    if (!accountId || !selected || !integration) return;
    let current = true;
    setEditing(emptyPost);
    setPending(null);
    plan.current = null;
    const stored = localStorage.getItem(storageKey);
    if (!stored) return;
    let saved: any;
    try {
      saved = JSON.parse(stored);
    } catch {
      setMessage(
        '保存済みの参照情報を確認できません。投稿履歴を確認してください。'
      );
      return;
    }
    if (saved.state !== 'draft') {
      setPending(saved);
      plan.current = saved.planId || null;
      return;
    }
    setDraftLoading(true);
    loadDraft(saved.group)
      .then((data) => {
        if (current) {
          setEditing(data);
          setRevision((value) => value + 1);
        }
      })
      .catch((error) => {
        if (current) {
          setMessage(error.message);
          setPending(saved);
        }
      })
      .finally(() => {
        if (current) setDraftLoading(false);
      });
    return () => {
      current = false;
    };
  }, [accountId, storageKey, loadDraft, !!selected, !!integration]);

  const onPreparePost = async (data: any) => {
    if (data.posts.length !== 1 || data.posts[0].integration.id !== accountId)
      throw new Error('投稿先を再確認してください。');
    // Drafts remain existing Postiz Posts. A delivery plan is prepared only
    // for execution, so editing a draft does not duplicate it or relink an
    // already-consumed delivery. Post IDs from ExistingData are retained.
    if (data.type === 'draft') return;
    const saved = await saveCommonContentPlan(
      request,
      {
        commonContent: data.posts[0].value[0]?.content || '',
        commonScheduledAt:
          data.type === 'schedule'
            ? dayjs.utc(data.date).toISOString()
            : undefined,
        deliveries: [{ integrationId: accountId }],
      },
      plan.current
    );
    plan.current = saved.id;
    return saved.id;
  };
  const beforePost = async (type: 'draft' | 'now' | 'schedule') => {
    if (type === 'draft') return;
    if (!plan.current) throw new Error('投稿内容の保存を確認できません。');
    await preflightCommonContentPlan(request, plan.current, type, [accountId]);
  };
  const onPosted = async (result: any) => {
    const receipt = {
      state: 'accepted',
      group: result.group,
      planId: plan.current,
      result,
    };
    remember(receipt);
    setPending(receipt);
    if (result.type !== 'draft') {
      if (!plan.current)
        throw new Error('投稿受付済みです。履歴との関連を確認してください。');
      await linkCommonContentPosts(request, plan.current, result);
      setMessage(
        result.type === 'schedule'
          ? '予約を登録しました。履歴で日時と状態を確認してください。'
          : '投稿を受け付けました。公開結果は履歴で確認してください。'
      );
      return;
    }
    const data = await loadDraft(result.group);
    remember({ state: 'draft', group: data.group });
    setEditing(data);
    setPending(null);
    setRevision((value) => value + 1);
    setMessage('下書きを保存しました。同じ下書きを続けて編集できます。');
  };

  if (accountQuery.isLoading || integrationQuery.isLoading)
    return <p role="status">Threadsアカウントを取得中です。</p>;
  if (accountQuery.error || integrationQuery.error)
    return (
      <p role="alert">
        投稿先の取得に失敗しました。未接続とは判定していません。
        <button
          className={button}
          onClick={() => {
            void accountQuery.mutate();
            void integrationQuery.mutate();
          }}
        >
          再読込
        </button>
      </p>
    );
  if (!accounts.length)
    return (
      <p>
        Threadsアカウントを接続してください。
        <a href="/launches" className="ml-2 underline">
          アカウント接続を開く
        </a>
      </p>
    );
  return (
    <section className="grid gap-4">
      <label className="grid max-w-md gap-2 text-sm">
        <span>投稿先アカウント</span>
        <select
          className="rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2"
          value={accountId}
          disabled={busy || draftLoading}
          onChange={(event) => {
            if (
              accountId &&
              !window.confirm(
                '編集内容を切り替えます。未保存の入力を破棄して別のアカウントを開きますか？'
              )
            )
              return;
            setMessage('');
            localStorage.setItem(selectionKey, event.target.value);
            setAccountId(event.target.value);
          }}
        >
          <option value="">投稿先を選択してください</option>
          {accounts.map((account: any) => (
            <option key={account.id} value={account.id}>
              {account.name} [
              {account.transport === 'browser'
                ? 'Browser'
                : account.transport === 'official'
                ? 'Official API'
                : '接続確認中'}
              ]
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <button
          className={`${button} justify-self-start`}
          disabled={busy || draftLoading || !!pending}
          onClick={() => {
            if (
              !window.confirm(
                '保存済みの下書きは履歴に残します。未保存の入力を破棄して新しい投稿を作成しますか？'
              )
            )
              return;
            localStorage.removeItem(storageKey);
            setEditing(emptyPost);
            plan.current = null;
            setRevision((value) => value + 1);
            setMessage('');
          }}
        >
          新しい投稿を作成
        </button>
      )}
      {message && <p role="status">{message}</p>}
      {accountId && !selected && (
        <p role="alert">
          保存済みの投稿先を現在のOrganizationで確認できません。投稿先を選び直してください。
        </p>
      )}
      {pending && (
        <div className="rounded-lg border border-amber-300 p-4">
          <p>
            受付済み、または結果確認が必要な投稿があります。自動再送はしません。入力の参照先と関連IDを保持しています。
          </p>
          <a className="underline" href="/launches">
            投稿履歴で確認
          </a>
        </div>
      )}
      {selected && !integration && (
        <p role="alert">
          この投稿先のIntegrationを使用できません。接続状態を確認してください。
        </p>
      )}
      {selected && integration && !draftLoading && (
        <CalendarWeekProvider integrations={[integration]}>
          <LaunchStoreProvider key={accountId}><ExistingDataContextProvider value={editing}>
            <AddEditModal
              key={`${accountId}:${revision}`}
              date={
                editing.posts?.[0]?.publishDate
                  ? dayjs.utc(editing.posts[0].publishDate).local()
                  : dayjs().add(1, 'hour')
              }
              allIntegrations={[
                {
                  ...integration,
                  snsStudioTransport: selected.transport,
                } as any,
              ]}
              integrations={[integration]}
              selectedChannels={editing.integration ? undefined : [accountId]}
              selectedChannelSettings={{
                [accountId]:
                  selected.transport === 'browser' && selected.browserAccount
                    ? { browserAccount: selected.browserAccount }
                    : {},
              }}
              focusedChannel={accountId}
              reopenModal={() => undefined}
              mutate={() => undefined}
              inline={{
                title: 'Threads 投稿作成',
                submissionBlocked: !!pending,
                blockedReason:
                  selected.publishBlockedReason ||
                  (!selected.transport ? '接続方式を確認できません。' : null),
                onBusyChange: setBusy,
                onRequestStarted: (data) =>
                  remember({
                    state: 'sending',
                    group: data.posts[0].group,
                    planId: plan.current,
                  }),
                onRequestRejected: () => {
                  if (editing.group)
                    remember({ state: 'draft', group: editing.group });
                  else localStorage.removeItem(storageKey);
                },
              }}
              onPreparePost={onPreparePost}
              onBeforePost={beforePost}
              onPosted={onPosted}
            />
          </ExistingDataContextProvider></LaunchStoreProvider>
        </CalendarWeekProvider>
      )}
    </section>
  );
}
