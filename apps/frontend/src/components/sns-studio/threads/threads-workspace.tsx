'use client';

import React, { FC, useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import clsx from 'clsx';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';
import type { CommonPublishPrefill } from '@gitroom/frontend/components/sns-studio/common-publisher';
import {
  THREADS_REPLY_CONTROL_OPTIONS,
  ThreadsReplyControl,
} from '@gitroom/nestjs-libraries/integrations/social/threads.capabilities';

const card = 'rounded-xl border border-blockSeparator bg-newBgColorInner p-5';
const field =
  'w-full rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2 text-newTextColor outline-none focus:border-[#7774ff]';
const primaryButton =
  'rounded-lg bg-[#5145ff] px-4 py-2 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'rounded-lg border border-blockSeparator px-4 py-2 font-semibold text-newTextColor hover:bg-boxFocused disabled:opacity-50';

type SubTab =
  | 'Publish'
  | 'Calendar'
  | 'Inbox'
  | 'Research'
  | 'ReferencePosts'
  | 'Analytics'
  | 'Settings';

const subTabs: Array<{ id: SubTab; label: string; icon: string }> = [
  { id: 'Publish', label: '投稿 (Publish)', icon: '📝' },
  { id: 'Calendar', label: 'カレンダー (Ghost消滅)', icon: '📅' },
  { id: 'Inbox', label: 'Inbox & 返信', icon: '📥' },
  { id: 'Research', label: 'リサーチ (Search)', icon: '🔍' },
  { id: 'ReferencePosts', label: '参考投稿ストック', icon: '📚' },
  { id: 'Analytics', label: '分析 (Analytics)', icon: '📈' },
  { id: 'Settings', label: 'アカウント・自動化', icon: '⚙️' },
];

export interface ThreadsCalendarPost {
  id: string;
  state?: string;
  publishDate?: string | Date;
  content?: string;
  text?: string;
  group?: string;
  releaseURL?: string | null;
  permalink?: string | null;
  isGhostPost?: boolean;
  ghostStatus?: 'ACTIVE' | 'ARCHIVED' | null;
  remainingMinutes?: number | null;
  ghostExpiresAt?: string | Date | null;
  topicTag?: string | null;
  hasPoll?: boolean;
  hasSpoiler?: boolean;
  likes?: number;
  replies?: number;
  reposts?: number;
  metadata?: {
    isGhostPost?: boolean;
    isExpired?: boolean;
    isArchived?: boolean;
    remainingHours?: number;
    topicTag?: string;
  };
  integration?: {
    id: string;
    name: string;
    profile?: string | null;
    picture?: string | null;
  };
}

export interface NormalizedThreadsCalendarPost extends ThreadsCalendarPost {
  isGhost: boolean;
  isArchived: boolean;
  hoursLeft: number;
  topicTag: string;
}

export interface ThreadsInboxItem {
  id: string;
  organizationId?: string;
  integrationId?: string;
  threadsMediaId?: string;
  threadsReplyId?: string;
  senderId?: string;
  senderUsername?: string;
  authorUsername?: string;
  senderProfilePic?: string | null;
  text?: string;
  content?: string;
  postSnippet?: string | null;
  parentPostContent?: string | null;
  itemType?: string;
  status?: string;
  approvalStatus?: string | null;
  isPendingApproval?: boolean;
  isHidden?: boolean;
  hidden?: boolean;
  isAutoReplied?: boolean;
  parentReplyId?: string | null;
  repliedAt?: string | Date;
  createdAt?: string | Date;
  updatedAt?: string | Date;
  handledAt?: string | Date | null;
  ourReplyId?: string | null;
  ourReplyText?: string | null;
  aiDraftText?: string | null;
  metadata?: any;
}

export interface NormalizedThreadsInboxItem extends ThreadsInboxItem {
  displayUsername: string;
  displayText: string;
  parentSnippet: string;
  status: string;
  hidden: boolean;
  isPendingApproval: boolean;
}

export function normalizeCalendarPost(
  item: ThreadsCalendarPost
): NormalizedThreadsCalendarPost {
  const isGhost = Boolean(item.isGhostPost ?? item.metadata?.isGhostPost);
  const isArchived = Boolean(
    item.ghostStatus === 'ARCHIVED' ||
      item.metadata?.isExpired ||
      item.metadata?.isArchived
  );
  const remainingMinutes =
    item.remainingMinutes != null
      ? item.remainingMinutes
      : item.metadata?.remainingHours != null
      ? item.metadata.remainingHours * 60
      : null;
  const hoursLeft =
    remainingMinutes != null
      ? Math.ceil(remainingMinutes / 60)
      : item.metadata?.remainingHours ?? 0;
  const topicTag = item.topicTag ?? item.metadata?.topicTag ?? '';

  return {
    ...item,
    isGhost,
    isArchived,
    hoursLeft,
    topicTag,
  };
}

export function normalizeThreadsInboxItem(
  item: ThreadsInboxItem
): NormalizedThreadsInboxItem {
  return {
    ...item,
    displayUsername:
      item.senderUsername || item.authorUsername || 'Unknown',
    displayText: item.text || item.content || '',
    parentSnippet: item.postSnippet || item.parentPostContent || '',
    status: item.status || 'UNHANDLED',
    hidden: Boolean(item.isHidden ?? item.hidden),
    isPendingApproval: Boolean(
      item.isPendingApproval || item.status === 'PENDING_APPROVAL'
    ),
  };
}

const BrowserFeatureUnavailableBanner: FC<{
  featureName: string;
  description?: string;
}> = ({
  featureName,
  description = 'この機能はMeta公式API経由のアカウント専用です。Browser接続アカウントでは、投稿（テキスト/単一画像）機能のみ利用可能です。',
}) => (
  <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-6 text-center">
    <div className="text-2xl mb-2">⚠️</div>
    <h3 className="text-sm font-bold text-textColor">
      {featureName} はBrowser接続アカウントでは利用できません
    </h3>
    <p className="mt-2 text-xs text-textItemBlur max-w-md mx-auto">
      {description}
    </p>
    <div className="mt-4">
      <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded text-xs bg-amber-500/20 text-amber-300 font-mono">
        BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE
      </span>
    </div>
  </div>
);

export const ThreadsWorkspace: FC<{
  onOpenPublish?: (prefill: CommonPublishPrefill) => void;
}> = ({ onOpenPublish }) => {
  const fetch = useFetch();
  const [activeSubTab, setActiveSubTab] = useState<SubTab>('Publish');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [selectedAccountId, setSelectedAccountId] = useState('');
  const [browserAccountInput, setBrowserAccountInput] = useState('main');
  const [browserConnecting, setBrowserConnecting] = useState(false);
  const [browserCheckResult, setBrowserCheckResult] = useState<any>(null);
  const [checkingSidecar, setCheckingSidecar] = useState(false);

  // SWR request helper
  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await fetch(path, {
        ...init,
        headers: {
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(data?.message || data?.code || 'Threads処理に失敗しました。');
      }
      return data;
    },
    [fetch]
  );

  const load = useCallback((path: string) => request(path), [request]);

  // Data fetching
  const { data: accountsData, mutate: refreshAccounts } = useSWR(
    '/threads-studio/accounts',
    load
  );
  const accounts: any[] = Array.isArray(accountsData)
    ? accountsData
    : (accountsData?.accounts || []);

  const effectiveAccountId = useMemo(() => {
    return selectedAccountId || accounts[0]?.id || '';
  }, [selectedAccountId, accounts]);

  const selectedAccount = useMemo(() => {
    return accounts.find((a) => a.id === effectiveAccountId);
  }, [accounts, effectiveAccountId]);

  const isBrowserAccount = Boolean(
    selectedAccount?.isBrowser || selectedAccount?.transport === 'browser'
  );

  const { data: capabilitiesData } = useSWR('/threads-studio/capabilities', load);

  const { data: quotaData } = useSWR(
    effectiveAccountId && activeSubTab === 'Settings' && !isBrowserAccount
      ? `/threads-studio/accounts/${effectiveAccountId}/quota`
      : null,
    load
  );

  const calendarKey = useMemo(() => {
    if (activeSubTab !== 'Calendar') return null;
    const from = dayjs().subtract(14, 'days').startOf('day').toISOString();
    const to = dayjs().add(14, 'days').endOf('day').toISOString();
    return `/threads-studio/calendar?from=${from}&to=${to}`;
  }, [activeSubTab]);

  const { data: calendarData, mutate: refreshCalendar } = useSWR(
    calendarKey,
    load
  );

  const [inboxStatusFilter, setInboxStatusFilter] = useState<string>('ALL');
  const { data: inboxData, mutate: refreshInbox } = useSWR(
    activeSubTab === 'Inbox' && !isBrowserAccount
      ? `/threads-studio/inbox?${effectiveAccountId ? `integrationId=${effectiveAccountId}&` : ''}${inboxStatusFilter !== 'ALL' ? `status=${inboxStatusFilter}` : ''}`
      : null,
    load,
    { refreshInterval: 10000 }
  );

  const calendarPosts: NormalizedThreadsCalendarPost[] = useMemo(() => {
    const raw: ThreadsCalendarPost[] = Array.isArray(calendarData)
      ? calendarData
      : calendarData?.posts ?? [];
    return raw.map(normalizeCalendarPost);
  }, [calendarData]);

  const inboxItems: NormalizedThreadsInboxItem[] = useMemo(() => {
    const raw: ThreadsInboxItem[] = Array.isArray(inboxData)
      ? inboxData
      : Array.isArray(inboxData?.items)
      ? inboxData.items
      : [];
    return raw.map(normalizeThreadsInboxItem);
  }, [inboxData]);

  const { data: referencePosts = [], mutate: refreshReferencePosts } = useSWR(
    activeSubTab === 'ReferencePosts' || activeSubTab === 'Publish'
      ? '/threads-studio/reference-posts'
      : null,
    load
  );

  const { data: analyticsData, mutate: refreshAnalytics } = useSWR(
    activeSubTab === 'Analytics' && !isBrowserAccount
      ? `/threads-studio/analytics?${effectiveAccountId ? `integrationId=${effectiveAccountId}` : ''}`
      : null,
    load
  );

  const checkSidecarStatus = useCallback(async () => {
    setCheckingSidecar(true);
    try {
      const res = await request('/threads-studio/browser/verify', {
        method: 'POST',
        body: JSON.stringify({
          account: browserAccountInput || 'main',
          checkHealth: true,
          checkSession: true,
        }),
      });
      setBrowserCheckResult(res);
      return res;
    } catch (err: any) {
      setBrowserCheckResult({
        health: { status: 'error', error: err?.message || String(err) },
      });
      return null;
    } finally {
      setCheckingSidecar(false);
    }
  }, [browserAccountInput, request]);

  const connectBrowserAccountAction = useCallback(async () => {
    setBrowserConnecting(true);
    setMessage('');
    try {
      const res = await request('/threads-studio/browser/connect', {
        method: 'POST',
        body: JSON.stringify({ account: browserAccountInput || 'main' }),
      });
      await refreshAccounts();
      if (res?.integration?.id) {
        setSelectedAccountId(res.integration.id);
      }
      setMessage(res?.message || 'Threads Browserアカウントを接続しました。');
    } catch (err: any) {
      setMessage(`接続エラー: ${err?.message || String(err)}`);
    } finally {
      setBrowserConnecting(false);
    }
  }, [browserAccountInput, request, refreshAccounts]);

  const connectOfficialAccountAction = useCallback(async () => {
    try {
      const res = await (await fetch('/integrations/social/threads')).json();
      if (res?.url) {
        window.location.href = res.url;
      } else {
        setMessage('公式API認証URLの生成に失敗しました。');
      }
    } catch (err: any) {
      setMessage(`公式API接続エラー: ${err?.message || String(err)}`);
    }
  }, [fetch]);

  const runAction = useCallback(
    async (action: () => Promise<unknown>, successMsg: string) => {
      setBusy(true);
      setMessage('');
      try {
        await action();
        setMessage(successMsg);
      } catch (err) {
        setMessage(err instanceof Error ? err.message : '処理に失敗しました。');
      } finally {
        setBusy(false);
      }
    },
    []
  );

  // 1. AI Post Generator State
  const [aiPostMode, setAiPostMode] = useState<
    'standard' | 'short' | 'long' | 'thread' | 'ghost' | 'poll'
  >('standard');
  const [aiPostTopic, setAiPostTopic] = useState('');
  const [aiPostTone, setAiPostTone] = useState('カジュアルで親しみやすい');
  const [aiPostTopicTag, setAiPostTopicTag] = useState('');
  const [selectedReferenceIds, setSelectedReferenceIds] = useState<string[]>([]);
  const [generatedDraft, setGeneratedDraft] = useState('');

  const generateAiPost = async () => {
    if (!aiPostTopic.trim()) throw new Error('トピックまたは要約を入力してください。');
    const result = await request('/threads-studio/ai-generate-post', {
      method: 'POST',
      body: JSON.stringify({
        mode: aiPostMode,
        topic: aiPostTopic,
        referencePostIds: selectedReferenceIds,
        tone: aiPostTone,
        topicTag: aiPostTopicTag || undefined,
      }),
    });
    setGeneratedDraft(result.text || '');
    return result;
  };

  const forwardToCommonPublisher = (content: string) => {
    if (!onOpenPublish) return;
    onOpenPublish({
      preferredPlatform: 'threads',
      initialDestinationId: effectiveAccountId || undefined,
      content,
    });
  };

  // 2. Inbox & AI Reply State
  const [activeInboxItem, setActiveInboxItem] =
    useState<NormalizedThreadsInboxItem | null>(null);
  const [replyInputText, setReplyInputText] = useState('');
  const [aiReplyTone, setAiReplyTone] = useState<'casual' | 'polite' | 'concise'>(
    'casual'
  );
  const [aiReplyPrompt, setAiReplyPrompt] = useState('');

  const generateAiReply = async (item: NormalizedThreadsInboxItem) => {
    setActiveInboxItem(item);
    const result = await request('/threads-studio/inbox/ai-reply-draft', {
      method: 'POST',
      body: JSON.stringify({
        itemId: item.id,
        replyText: item.displayText,
        postSnippet: item.parentSnippet,
        replierUsername: item.displayUsername,
        tone: aiReplyTone,
        customPrompt: aiReplyPrompt || undefined,
      }),
    });
    setReplyInputText(result.draft || '');
    return result;
  };

  const sendReply = async (item: NormalizedThreadsInboxItem) => {
    if (!replyInputText.trim()) throw new Error('返信内容を入力してください。');
    await request(`/threads-studio/inbox/${item.id}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text: replyInputText }),
    });
    setReplyInputText('');
    setActiveInboxItem(null);
    await refreshInbox();
  };

  const toggleHide = async (item: NormalizedThreadsInboxItem) => {
    const nextHide = !item.hidden;
    await request(`/threads-studio/inbox/${item.id}/hide`, {
      method: 'POST',
      body: JSON.stringify({ hide: nextHide }),
    });
    await refreshInbox();
  };

  const moderatePendingReply = async (
    item: NormalizedThreadsInboxItem,
    approve: boolean
  ) => {
    await request(`/threads-studio/inbox/${item.id}/approval`, {
      method: 'POST',
      body: JSON.stringify({ approve }),
    });
    await refreshInbox();
  };

  const syncInbox = async () => {
    await request('/threads-studio/inbox/sync', {
      method: 'POST',
      body: JSON.stringify({ integrationId: effectiveAccountId || undefined }),
    });
    await refreshInbox();
  };

  // 3. Research State
  const [searchQuery, setSearchQuery] = useState('');
  const [searchType, setSearchType] = useState<'TOP' | 'RECENT'>('RECENT');
  const [searchMode, setSearchMode] = useState<'KEYWORD' | 'TAG'>('KEYWORD');
  const [searchResults, setSearchResults] = useState<any[]>([]);

  const searchThreads = async () => {
    if (!effectiveAccountId) throw new Error('Threadsアカウントを選択してください。');
    if (!searchQuery.trim()) throw new Error('検索キーワードを入力してください。');
    const result = await request(
      `/threads-studio/research?integrationId=${effectiveAccountId}&q=${encodeURIComponent(
        searchQuery
      )}&searchType=${searchType}&searchMode=${searchMode}`
    );
    setSearchResults(result.data || []);
    return result;
  };

  const saveToReferences = async (post: any, note?: string) => {
    await request('/threads-studio/reference-posts', {
      method: 'POST',
      body: JSON.stringify({
        threadsPostId: post.id || post.threadsPostId,
        authorUsername: post.username || post.authorUsername || 'unknown',
        content: post.text || post.content || '',
        permalink: post.permalink,
        likesCount: post.like_count ?? post.likesCount ?? 0,
        repliesCount: post.reply_count ?? post.repliesCount ?? 0,
        viewsCount: post.views ?? post.viewsCount ?? 0,
        category: searchMode === 'TAG' ? searchQuery : 'リサーチ',
        notes: note || '公式API keyword_searchから保存',
      }),
    });
    await refreshReferencePosts();
  };

  const deleteReference = async (id: string) => {
    await request(`/threads-studio/reference-posts/${id}`, { method: 'DELETE' });
    await refreshReferencePosts();
  };

  // 4. Account Settings State
  const currentAccount = useMemo(() => {
    return accounts.find((a) => a.id === effectiveAccountId);
  }, [accounts, effectiveAccountId]);

  const [settingsForm, setSettingsForm] = useState({
    defaultReplyControl: 'everyone',
    aiReplyEnabled: true,
    autoReplyEnabled: false,
    autoPlugEnabled: false,
    maxRepliesPerDay: 50,
    aiCharacter: '礼儀正しく簡潔に答える専門家アシスタント',
    tone: '丁寧',
    ngWords: '宣伝, 招待, 怪しい, アフィリエイト',
    autoReplyOnlyQuestions: true,
    autoReplyExcludeUrls: true,
    autoPlugLikesThreshold: 100,
    autoPlugMessage: '💡 詳しい関連情報や最新アップデートはプロフィールのリンク先をチェックしてください！',
  });

  React.useEffect(() => {
    if (currentAccount?.snsThreadsSetting) {
      const s = currentAccount.snsThreadsSetting;
      setSettingsForm({
        defaultReplyControl: s.defaultReplyControl || 'everyone',
        aiReplyEnabled: s.aiReplyEnabled ?? true,
        autoReplyEnabled: s.autoReplyEnabled ?? false,
        autoPlugEnabled: s.autoPlugEnabled ?? false,
        maxRepliesPerDay: s.maxRepliesPerDay ?? 50,
        aiCharacter: s.aiCharacter || '礼儀正しく簡潔に答える専門家アシスタント',
        tone: s.tone || '丁寧',
        ngWords: Array.isArray(s.ngWords) ? s.ngWords.join(', ') : '',
        autoReplyOnlyQuestions: s.autoReplyRules?.onlyQuestions ?? true,
        autoReplyExcludeUrls: s.autoReplyRules?.excludeUrls ?? true,
        autoPlugLikesThreshold: s.autoPlugRules?.likesThreshold ?? 100,
        autoPlugMessage: s.autoPlugRules?.message || '',
      });
    }
  }, [currentAccount]);

  const saveAccountSettings = async () => {
    if (!effectiveAccountId) return;
    await request(`/threads-studio/accounts/${effectiveAccountId}/settings`, {
      method: 'PUT',
      body: JSON.stringify({
        defaultReplyControl: settingsForm.defaultReplyControl,
        aiReplyEnabled: settingsForm.aiReplyEnabled,
        autoReplyEnabled: settingsForm.autoReplyEnabled,
        autoPlugEnabled: settingsForm.autoPlugEnabled,
        maxRepliesPerDay: Number(settingsForm.maxRepliesPerDay),
        aiCharacter: settingsForm.aiCharacter,
        tone: settingsForm.tone,
        ngWords: settingsForm.ngWords
          .split(/[\s,]+/)
          .map((w) => w.trim())
          .filter(Boolean),
        autoReplyRules: {
          onlyQuestions: settingsForm.autoReplyOnlyQuestions,
          excludeUrls: settingsForm.autoReplyExcludeUrls,
        },
        autoPlugRules: {
          likesThreshold: Number(settingsForm.autoPlugLikesThreshold),
          message: settingsForm.autoPlugMessage,
        },
      }),
    });
    await refreshAccounts();
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Top Header & Account Switcher */}
      <div className={card}>
        <div className="flex flex-wrap items-center justify-between gap-4">
          <div>
            <div className="flex items-center gap-2">
              <span className="text-2xl">🧵</span>
              <h1 className="text-xl font-bold text-textColor">Threads Studio</h1>
              <span className="rounded-full bg-[#5145ff]/20 px-2.5 py-0.5 text-xs font-semibold text-[#9e9aff]">
                Meta Threads API v1.0
              </span>
            </div>
            <p className="mt-1 text-xs text-textItemBlur">
              Postiz公式基盤を活用し、Ghost Post（24h消滅）、Polls、Inbox、AI返信、公式リサーチを包括管理します。
            </p>
          </div>

          <div className="flex items-center gap-3">
            <span className="text-xs text-textItemBlur">対象アカウント:</span>
            <select
              className={clsx(field, 'w-auto min-w-[220px] text-xs font-semibold')}
              value={effectiveAccountId}
              onChange={(e) => setSelectedAccountId(e.target.value)}
            >
              {accounts.length ? (
                accounts.map((acc) => (
                  <option key={acc.id} value={acc.id}>
                    @{acc.name || acc.display || acc.username || acc.identifier}{' '}
                    {acc.isBrowser ? '[Browser]' : '[Official API]'}
                  </option>
                ))
              ) : (
                <option value="">Threadsアカウント未接続</option>
              )}
            </select>
            {selectedAccount && (
              <span
                className={clsx(
                  'rounded px-2.5 py-1 text-[11px] font-semibold flex items-center gap-1',
                  isBrowserAccount
                    ? 'bg-amber-500/20 text-amber-300 border border-amber-500/30'
                    : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/30'
                )}
              >
                <span>{isBrowserAccount ? '🌐' : '🔑'}</span>
                <span>{isBrowserAccount ? 'Browser Transport' : 'Official Meta API'}</span>
              </span>
            )}
          </div>
        </div>

        {/* Global Notification Banner */}
        {message && (
          <div className="mt-3 rounded-lg border border-[#7774ff]/40 bg-[#5145ff]/10 p-3 text-xs text-textColor flex items-center justify-between">
            <span>{message}</span>
            <button
              onClick={() => setMessage('')}
              className="text-textItemBlur hover:text-textColor text-xs"
            >
              ✕
            </button>
          </div>
        )}

        {/* Sub-tab Navigation */}
        <div className="mt-5 flex flex-wrap gap-1.5 border-t border-blockSeparator pt-4">
          {subTabs.map((tab) => (
            <button
              key={tab.id}
              onClick={() => {
                setActiveSubTab(tab.id);
                setMessage('');
              }}
              className={clsx(
                'flex items-center gap-1.5 rounded-lg px-3.5 py-2 text-xs font-semibold transition-colors',
                activeSubTab === tab.id
                  ? 'bg-[#5145ff] text-white shadow-sm'
                  : 'text-textItemBlur hover:bg-boxFocused hover:text-textColor'
              )}
            >
              <span>{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      </div>

      {/* 1. Sub-tab: Publish */}
      {activeSubTab === 'Publish' && (
        <div className="grid gap-6 xl:grid-cols-2">
          {/* Preset Launcher Card */}
          <div className={card}>
            <h2 className="text-base font-bold text-textColor flex items-center gap-2">
              <span>🚀</span> 共通投稿画面でThreads投稿を作成
            </h2>
            <p className="mt-1 text-xs text-textItemBlur">
              共通投稿基盤（Publish）をThreadsプリセットで開き、Ghost PostやPoll、Topic Tagなどの追加設定を編集して即時投稿・予約配信します。
            </p>
            <div className="mt-4 flex flex-col gap-3">
              <button
                type="button"
                className={clsx(primaryButton, 'py-3 text-sm flex items-center justify-center gap-2')}
                onClick={() => forwardToCommonPublisher('')}
              >
                <span>🧵</span> Threadsプリセットで共通投稿を開く
              </button>
            </div>

            <div className="mt-6 border-t border-blockSeparator pt-4">
              <h3 className="font-semibold text-xs text-textColor mb-2">
                🌟 Threads公式API拡張機能一覧
              </h3>
              <div className="grid grid-cols-2 gap-2 text-[11px] text-textItemBlur">
                <div className="rounded border border-blockSeparator p-2">
                  <strong className="text-textColor">👻 Ghost Post</strong>
                  <div className="mt-0.5">24時間で自動的にアーカイブ非公開化（テキスト専用）</div>
                </div>
                <div className="rounded border border-blockSeparator p-2">
                  <strong className="text-textColor">📊 Poll (アンケート)</strong>
                  <div className="mt-0.5">2〜4択・各25文字の公式アンケート投票</div>
                </div>
                <div className="rounded border border-blockSeparator p-2">
                  <strong className="text-textColor">🏷️ Topic Tag</strong>
                  <div className="mt-0.5">Threads公式トピック分類（#不要・最大50文字）</div>
                </div>
                <div className="rounded border border-blockSeparator p-2">
                  <strong className="text-textColor">⚠️ Spoiler Warning</strong>
                  <div className="mt-0.5">メディアぼかし＆本文テキストのネタバレ指定</div>
                </div>
                <div className="rounded border border-blockSeparator p-2">
                  <strong className="text-textColor">📄 長文テキスト添付</strong>
                  <div className="mt-0.5">最大10,000文字の長文解説テキスト添付</div>
                </div>
                <div className="rounded border border-blockSeparator p-2">
                  <strong className="text-textColor">🛡️ Reply Approvals</strong>
                  <div className="mt-0.5">届いた返信の手動事前承認制（炎上対策）</div>
                </div>
              </div>
            </div>
          </div>

          {/* AI Post Generator Card */}
          <div className={card}>
            <h2 className="text-base font-bold text-textColor flex items-center gap-2">
              <span>🤖</span> Threads AI 投稿下書きジェネレーター
            </h2>
            <p className="mt-1 text-xs text-textItemBlur">
              参考投稿ストックの構成や成功パターンをプロンプトに注入し、Threadsに最適化された短文フック・スレッド・Poll案を作成します。
            </p>

            <div className="mt-4 flex flex-col gap-3">
              <div className="grid grid-cols-2 gap-2">
                <div>
                  <label className="block text-xs font-semibold text-textItemBlur mb-1">
                    投稿フォーマット
                  </label>
                  <select
                    className={field}
                    value={aiPostMode}
                    onChange={(e: any) => setAiPostMode(e.target.value)}
                  >
                    <option value="standard">スタンダード (〜500文字)</option>
                    <option value="short">短文フック (1〜2行)</option>
                    <option value="long">長文添付構成 (フック+解説)</option>
                    <option value="thread">ツリースレッド構成</option>
                    <option value="ghost">👻 Ghost Post (24h限定)</option>
                    <option value="poll">📊 アンケート提案</option>
                  </select>
                </div>
                <div>
                  <label className="block text-xs font-semibold text-textItemBlur mb-1">
                    トーン
                  </label>
                  <input
                    className={field}
                    value={aiPostTone}
                    onChange={(e) => setAiPostTone(e.target.value)}
                    placeholder="例: 親しみやすい、専門的、毒舌など"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-textItemBlur mb-1">
                  トピック / テーマ / 伝えたい要点
                </label>
                <textarea
                  rows={2}
                  className={field}
                  placeholder="例: AI自動化によるSNS運用の生産性向上について"
                  value={aiPostTopic}
                  onChange={(e) => setAiPostTopic(e.target.value)}
                />
              </div>

              {referencePosts.length > 0 && (
                <div>
                  <label className="block text-xs font-semibold text-textItemBlur mb-1">
                    参考投稿を注入 ({selectedReferenceIds.length}件選択中)
                  </label>
                  <div className="max-h-24 overflow-y-auto rounded-lg border border-blockSeparator p-2 flex flex-col gap-1.5 text-xs">
                    {referencePosts.map((ref: any) => (
                      <label key={ref.id} className="flex items-center gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={selectedReferenceIds.includes(ref.id)}
                          onChange={(e) => {
                            if (e.target.checked) {
                              setSelectedReferenceIds([...selectedReferenceIds, ref.id]);
                            } else {
                              setSelectedReferenceIds(
                                selectedReferenceIds.filter((id) => id !== ref.id)
                              );
                            }
                          }}
                        />
                        <span className="truncate flex-1">
                          @{ref.authorUsername}: {ref.content}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <button
                type="button"
                className={secondaryButton}
                disabled={busy || !aiPostTopic.trim()}
                onClick={() =>
                  void runAction(generateAiPost, 'AIによる投稿案を作成しました。')
                }
              >
                AI投稿案を生成
              </button>

              {generatedDraft && (
                <div className="mt-3 rounded-lg border border-[#7774ff]/40 bg-newBgColorInner/80 p-3">
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold text-textColor">
                      生成された投稿案
                    </span>
                    <button
                      type="button"
                      className="text-xs text-[#7774ff] hover:underline"
                      onClick={() => forwardToCommonPublisher(generatedDraft)}
                    >
                      共通投稿画面へ送る ➔
                    </button>
                  </div>
                  <textarea
                    rows={4}
                    className={clsx(field, 'text-xs')}
                    value={generatedDraft}
                    onChange={(e) => setGeneratedDraft(e.target.value)}
                  />
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* 2. Sub-tab: Calendar (Ghost Post Visualization) */}
      {activeSubTab === 'Calendar' && (
        <div className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold text-textColor flex items-center gap-2">
                <span>📅</span> Threads投稿カレンダー & Ghost消滅トラッカー
              </h2>
              <p className="mt-1 text-xs text-textItemBlur">
                Ghost Postの24時間消滅ステータス（生存中・アーカイブ済み）および通常投稿の配信タイムラインを可視化します。
              </p>
            </div>
            <button
              className={secondaryButton}
              onClick={() => void refreshCalendar()}
              disabled={busy}
            >
              更新
            </button>
          </div>

          <div className="grid gap-3">
            {calendarPosts.length ? (
              calendarPosts.map((item) => {
                const permalink = item.releaseURL || item.permalink;
                return (
                  <div
                    key={item.id}
                    className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-blockSeparator p-3.5 text-xs"
                  >
                    <div className="flex flex-col gap-1 min-w-[240px] flex-1">
                      <div className="flex items-center gap-2">
                        {item.isGhost ? (
                          <span
                            className={clsx(
                              'rounded px-2 py-0.5 text-[10px] font-bold flex items-center gap-1',
                              item.isArchived
                                ? 'bg-zinc-800 text-zinc-400'
                                : 'bg-purple-500/20 text-purple-300'
                            )}
                          >
                            👻 GHOST POST
                          </span>
                        ) : (
                          <span className="rounded bg-zinc-800 px-2 py-0.5 text-[10px] text-zinc-300 font-bold">
                            REGULAR
                          </span>
                        )}
                        <span className="text-textItemBlur">
                          {dayjs(item.publishDate).format('YYYY/MM/DD HH:mm')}
                        </span>
                        {item.topicTag && (
                          <span className="text-[#9e9aff]">#{item.topicTag}</span>
                        )}
                      </div>
                      <div className="text-textColor font-medium mt-0.5 line-clamp-2">
                        {item.content || item.text}
                      </div>
                    </div>

                    {/* Status & Ephemeral Countdown */}
                    <div className="flex items-center gap-3">
                      {item.isGhost && (
                        <div className="text-right">
                          {item.isArchived ? (
                            <span className="rounded bg-red-500/20 px-2 py-1 text-[11px] font-bold text-red-300">
                              ARCHIVED (Meta非公開済)
                            </span>
                          ) : (
                            <span className="rounded bg-amber-500/20 px-2 py-1 text-[11px] font-bold text-amber-300 animate-pulse">
                              ⏳ 残り約 {item.hoursLeft} 時間で消滅
                            </span>
                          )}
                        </div>
                      )}

                      <div className="flex items-center gap-2 text-textItemBlur text-[11px]">
                        <span>❤️ {item.likes || 0}</span>
                        <span>💬 {item.replies || 0}</span>
                        <span>🔁 {item.reposts || 0}</span>
                      </div>

                      {permalink && (
                        <a
                          href={permalink}
                          target="_blank"
                          rel="noreferrer"
                          className="text-[#9e9aff] hover:underline"
                        >
                          開く ➔
                        </a>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <div className="rounded-lg border border-dashed border-blockSeparator p-8 text-center text-xs text-textItemBlur">
                表示対象期間のThreads投稿はありません。
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. Sub-tab: Inbox & Moderation */}
      {activeSubTab === 'Inbox' && (
        isBrowserAccount ? (
          <BrowserFeatureUnavailableBanner
            featureName="Inbox・モデレーション・返信機能"
            description="Threadsのリプライ取得およびモデレーション機能 (threads_manage_replies, threads_read_replies) はMeta公式API専用機能です。Browser接続アカウントではご利用いただけません。"
          />
        ) : (
        <div className="grid gap-6 xl:grid-cols-3">
          {/* Inbox List (2 Cols) */}
          <div className={clsx(card, 'xl:col-span-2')}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-bold text-textColor flex items-center gap-2">
                  <span>📥</span> Threads リプライ・Inbox
                </h2>
                <p className="mt-1 text-xs text-textItemBlur">
                  届いたリプライを統合管理。非表示切り替えや、返信承認待ちのモデレーションに対応。
                </p>
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="button"
                  className={secondaryButton}
                  onClick={() => void runAction(syncInbox, 'Threadsから最新リプライを同期しました。')}
                  disabled={busy}
                >
                  🔄 最新リプライを同期
                </button>
              </div>
            </div>

            {/* Filter Pills */}
            <div className="flex flex-wrap gap-1.5 mb-4">
              {['ALL', 'UNHANDLED', 'REPLIED', 'PENDING_APPROVAL', 'HIDDEN'].map((f) => (
                <button
                  key={f}
                  onClick={() => setInboxStatusFilter(f)}
                  className={clsx(
                    'rounded-lg px-2.5 py-1 text-xs font-semibold',
                    inboxStatusFilter === f
                      ? 'bg-[#5145ff] text-white'
                      : 'border border-blockSeparator text-textItemBlur hover:text-textColor'
                  )}
                >
                  {f === 'ALL' && 'すべて'}
                  {f === 'UNHANDLED' && '未対応のみ'}
                  {f === 'REPLIED' && '返信済み'}
                  {f === 'PENDING_APPROVAL' && '🛡️ 返信承認待ち'}
                  {f === 'HIDDEN' && '非表示中'}
                </button>
              ))}
            </div>

            {/* Inbox Item Cards */}
            <div className="grid gap-3">
              {inboxItems.length ? (
                inboxItems.map((item) => (
                  <div
                    key={item.id}
                    className={clsx(
                      'rounded-lg border p-3.5 transition-colors',
                      item.isPendingApproval
                        ? 'border-amber-500/50 bg-amber-500/5'
                        : item.hidden
                        ? 'border-zinc-800 opacity-60'
                        : 'border-blockSeparator bg-newBgColorInner'
                    )}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2">
                        <strong className="text-xs text-textColor">
                          @{item.displayUsername}
                        </strong>
                        <span className="text-[10px] text-textItemBlur">
                          {dayjs(item.repliedAt || item.createdAt).format(
                            'YYYY/MM/DD HH:mm'
                          )}
                        </span>
                        {item.isPendingApproval && (
                          <span className="rounded bg-amber-500/20 px-1.5 py-0.5 text-[10px] font-bold text-amber-300">
                            🛡️ 承認待ち
                          </span>
                        )}
                        {item.hidden && (
                          <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-400">
                            非表示中
                          </span>
                        )}
                        {item.isAutoReplied && (
                          <span className="rounded bg-blue-500/20 px-1.5 py-0.5 text-[10px] text-blue-300">
                            🤖 自動返信済
                          </span>
                        )}
                      </div>

                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="rounded border border-blockSeparator px-2 py-1 text-[11px] text-textItemBlur hover:text-textColor"
                          onClick={() => void runAction(() => toggleHide(item), item.hidden ? '再表示しました。' : '非表示にしました。')}
                        >
                          {item.hidden ? '再表示' : '非表示'}
                        </button>
                        <button
                          type="button"
                          className="rounded bg-[#5145ff]/20 px-2 py-1 text-[11px] font-semibold text-[#9e9aff] hover:bg-[#5145ff]/30"
                          onClick={() => {
                            setActiveInboxItem(item);
                            setReplyInputText('');
                          }}
                        >
                          💬 返信
                        </button>
                      </div>
                    </div>

                    {/* Original post context */}
                    {item.parentSnippet && (
                      <div className="mt-1.5 rounded bg-newBgColorInner/50 p-1.5 text-[11px] text-textItemBlur line-clamp-1 border-l-2 border-[#7774ff]">
                        親投稿: {item.parentSnippet}
                      </div>
                    )}

                    {/* Reply content */}
                    <div className="mt-2 text-xs text-textColor whitespace-pre-wrap">
                      {item.displayText}
                    </div>

                    {/* Moderation Controls for Pending Approvals */}
                    {item.isPendingApproval && (
                      <div className="mt-3 flex items-center gap-2 border-t border-amber-500/30 pt-2 text-xs">
                        <span className="text-amber-300 text-[11px]">
                          Reply Approvalsにより保留中:
                        </span>
                        <button
                          type="button"
                          className={clsx(primaryButton, 'py-1 px-3 text-xs')}
                          onClick={() => void runAction(() => moderatePendingReply(item, true), '返信を承認・公開しました。')}
                        >
                          承認して公開
                        </button>
                        <button
                          type="button"
                          className={clsx(secondaryButton, 'py-1 px-3 text-xs')}
                          onClick={() => void runAction(() => moderatePendingReply(item, false), '返信を無視・非公開としました。')}
                        >
                          無視する
                        </button>
                      </div>
                    )}
                  </div>
                ))
              ) : (
                <div className="rounded-lg border border-dashed border-blockSeparator p-8 text-center text-xs text-textItemBlur">
                  該当するリプライはありません。
                </div>
              )}
            </div>
          </div>

          {/* AI Reply & Response Panel (1 Col) */}
          <div className={card}>
            <h2 className="text-base font-bold text-textColor flex items-center gap-2">
              <span>🤖</span> AI返信アシスタント
            </h2>
            <p className="mt-1 text-xs text-textItemBlur">
              相手の発言と親投稿の文脈を読み、最適なトーンで返信下書きを生成します（送信前に必ず手動確認）。
            </p>

            {activeInboxItem ? (
              <div className="mt-4 flex flex-col gap-3">
                <div className="rounded-lg border border-blockSeparator p-2.5 text-xs">
                  <div className="font-semibold text-textItemBlur">
                    返信先: @{activeInboxItem.displayUsername}
                  </div>
                  <div className="mt-1 text-textColor">{activeInboxItem.displayText}</div>
                </div>

                <div className="grid grid-cols-3 gap-1.5">
                  {(['casual', 'polite', 'concise'] as const).map((tone) => (
                    <button
                      key={tone}
                      type="button"
                      onClick={() => setAiReplyTone(tone)}
                      className={clsx(
                        'rounded-lg py-1.5 text-xs font-semibold border',
                        aiReplyTone === tone
                          ? 'border-[#5145ff] bg-[#5145ff]/20 text-[#9e9aff]'
                          : 'border-blockSeparator text-textItemBlur'
                      )}
                    >
                      {tone === 'casual' && 'カジュアル'}
                      {tone === 'polite' && '丁寧'}
                      {tone === 'concise' && '短く簡潔'}
                    </button>
                  ))}
                </div>

                <div>
                  <input
                    type="text"
                    placeholder="AIへの追加指示（任意: 例: 感謝を伝える）"
                    value={aiReplyPrompt}
                    onChange={(e) => setAiReplyPrompt(e.target.value)}
                    className={field}
                  />
                </div>

                <button
                  type="button"
                  className={secondaryButton}
                  disabled={busy}
                  onClick={() =>
                    void runAction(
                      () => generateAiReply(activeInboxItem),
                      'AI返信下書きを生成しました。'
                    )
                  }
                >
                  AI返信下書きを生成
                </button>

                <div>
                  <label className="block text-xs font-semibold text-textItemBlur mb-1">
                    返信本文（手動編集可能）
                  </label>
                  <textarea
                    rows={4}
                    value={replyInputText}
                    onChange={(e) => setReplyInputText(e.target.value)}
                    placeholder="返信内容を確認・編集してください"
                    className={field}
                  />
                </div>

                <div className="text-[11px] text-amber-300 bg-amber-500/10 p-2 rounded">
                  ※ 安全のためAI返信は自動送信されません。内容を確認して手動で送信してください。
                </div>

                <button
                  type="button"
                  className={primaryButton}
                  disabled={busy || !replyInputText.trim()}
                  onClick={() =>
                    void runAction(
                      () => sendReply(activeInboxItem),
                      '返信を送信しました。'
                    )
                  }
                >
                  確認して送信 ➔
                </button>
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-dashed border-blockSeparator p-6 text-center text-xs text-textItemBlur">
                左側のInbox一覧から「返信」を選択すると、ここにAI返信支援パネルが開きます。
              </div>
            )}
          </div>
        </div>
        )
      )}

      {/* 4. Sub-tab: Research (Official API keyword_search) */}
      {activeSubTab === 'Research' && (
        isBrowserAccount ? (
          <BrowserFeatureUnavailableBanner
            featureName="Threads キーワードリサーチ・検索"
            description="Threadsのキーワード検索API (threads_keyword_search) はMeta公式API専用機能です。Browser接続アカウントではご利用いただけません。"
          />
        ) : (
        <div className="grid gap-6">
          <div className="rounded-md border border-blockSeparator px-4 py-3 text-xs text-textColor">
            <p>
              Threads公式リサーチを利用するには、Meta Threads APIの認証と{' '}
              <code>threads_keyword_search</code> 権限が必要です。未接続または権限不足の場合、検索は利用できません。
            </p>
            <p className="mt-1 text-textItemBlur">
              現在のMeta側の権限状態はMeta Developersで確認してください。
            </p>
            {!effectiveAccountId && (
              <p role="status" className="mt-2 text-textItemBlur">
                Threadsアカウントを選択してください。
              </p>
            )}
          </div>
          <div className={card}>
            <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
              <div>
                <h2 className="text-base font-bold text-textColor flex items-center gap-2">
                  <span>🔍</span> Threads公式リサーチ (/keyword_search)
                </h2>
                <p className="mt-1 text-xs text-textItemBlur">
                  Threads公式APIのkeyword_searchエンドポイントを使用し、リアルタイムトレンド・競合ポスト・関連ハッシュタグを分析します。
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 md:grid-cols-4 gap-3">
              <div className="md:col-span-2">
                <label className="block text-xs font-semibold text-textItemBlur mb-1">
                  検索キーワード / トピック
                </label>
                <input
                  type="text"
                  placeholder="例: 生成AI, マーケティング, Threads運用"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className={field}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-textItemBlur mb-1">
                  検索タイプ
                </label>
                <select
                  value={searchType}
                  onChange={(e: any) => setSearchType(e.target.value)}
                  className={field}
                >
                  <option value="RECENT">最新順 (RECENT)</option>
                  <option value="TOP">人気順 (TOP)</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-textItemBlur mb-1">
                  検索モード
                </label>
                <select
                  value={searchMode}
                  onChange={(e: any) => setSearchMode(e.target.value)}
                  className={field}
                >
                  <option value="KEYWORD">キーワード検索 (KEYWORD)</option>
                  <option value="TAG">トピックタグ検索 (TAG)</option>
                </select>
              </div>
            </div>

            <div className="mt-4 flex justify-end">
              <button
                type="button"
                className={primaryButton}
                disabled={busy || !effectiveAccountId || !searchQuery.trim()}
                onClick={() =>
                  void runAction(searchThreads, 'Threads検索を実行しました。')
                }
              >
                Threads検索を実行
              </button>
            </div>
          </div>

          {/* Search Results */}
          <div className="grid gap-4 md:grid-cols-2">
            {searchResults.length > 0 ? (
              searchResults.map((post: any) => (
                <div key={post.id} className={card}>
                  <div className="flex items-center justify-between gap-2">
                    <strong className="text-xs text-textColor">
                      @{post.username || 'user'}
                    </strong>
                    <div className="flex items-center gap-2 text-[11px] text-textItemBlur">
                      <span>❤️ {post.like_count || 0}</span>
                      <span>💬 {post.reply_count || 0}</span>
                      <span>👁️ {post.views || 0}</span>
                    </div>
                  </div>

                  <p className="mt-2 text-xs text-textColor whitespace-pre-wrap line-clamp-4">
                    {post.text}
                  </p>

                  <div className="mt-3 flex items-center justify-between border-t border-blockSeparator pt-2.5">
                    {post.permalink ? (
                      <a
                        href={post.permalink}
                        target="_blank"
                        rel="noreferrer"
                        className="text-xs text-[#9e9aff] hover:underline"
                      >
                        Threadsで見る ➔
                      </a>
                    ) : (
                      <span />
                    )}
                    <button
                      type="button"
                      className={clsx(secondaryButton, 'text-xs py-1 px-3')}
                      onClick={() =>
                        void runAction(
                          () => saveToReferences(post),
                          '参考投稿ストックへ保存しました。'
                        )
                      }
                    >
                      ⭐ 参考投稿に保存
                    </button>
                  </div>
                </div>
              ))
            ) : (
              <div className="col-span-2 rounded-lg border border-dashed border-blockSeparator p-8 text-center text-xs text-textItemBlur">
                検索キーワードを入力して「Threads検索を実行」してください。
              </div>
            )}
          </div>
        </div>
        )
      )}

      {/* 5. Sub-tab: Reference Posts Library */}
      {activeSubTab === 'ReferencePosts' && (
        <div className={card}>
          <div className="flex flex-wrap items-center justify-between gap-3 mb-4">
            <div>
              <h2 className="text-base font-bold text-textColor flex items-center gap-2">
                <span>📚</span> 参考投稿ライブラリ（インスピレーション・ストック）
              </h2>
              <p className="mt-1 text-xs text-textItemBlur">
                リサーチで発見した高エンゲージメント投稿や競合の優良投稿をストック。AI投稿生成プロンプトへ注入して活用できます。
              </p>
            </div>
            <button
              className={secondaryButton}
              onClick={() => void refreshReferencePosts()}
              disabled={busy}
            >
              更新
            </button>
          </div>

          <div className="grid gap-3 md:grid-cols-2">
            {referencePosts.length ? (
              referencePosts.map((post: any) => (
                <div
                  key={post.id}
                  className="rounded-lg border border-blockSeparator p-3.5 flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <strong className="text-xs text-textColor">
                        @{post.authorUsername}
                      </strong>
                      <span className="rounded bg-zinc-800 px-1.5 py-0.5 text-[10px] text-zinc-300">
                        {post.category || 'リサーチ'}
                      </span>
                    </div>

                    <p className="mt-2 text-xs text-textColor line-clamp-3 whitespace-pre-wrap">
                      {post.content}
                    </p>

                    {post.notes && (
                      <div className="mt-2 text-[11px] text-[#9e9aff] bg-[#5145ff]/10 p-1.5 rounded">
                        メモ: {post.notes}
                      </div>
                    )}
                  </div>

                  <div className="mt-3 flex items-center justify-between border-t border-blockSeparator pt-2 text-xs">
                    <div className="flex items-center gap-2 text-textItemBlur text-[11px]">
                      <span>❤️ {post.likesCount || 0}</span>
                      <span>💬 {post.repliesCount || 0}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        className="text-xs text-[#7774ff] hover:underline"
                        onClick={() => {
                          setAiPostTopic(`参考構成: @${post.authorUsername} の投稿文「${post.content.slice(0, 80)}...」`);
                          setSelectedReferenceIds([post.id]);
                          setActiveSubTab('Publish');
                        }}
                      >
                        AI投稿で模倣 ➔
                      </button>
                      <button
                        type="button"
                        className="text-xs text-textItemBlur hover:text-red-400"
                        onClick={() =>
                          void runAction(
                            () => deleteReference(post.id),
                            '参考投稿を削除しました。'
                          )
                        }
                      >
                        削除
                      </button>
                    </div>
                  </div>
                </div>
              ))
            ) : (
              <div className="col-span-2 rounded-lg border border-dashed border-blockSeparator p-8 text-center text-xs text-textItemBlur">
                保存済みの参考投稿はありません。「リサーチ」タブから保存してください。
              </div>
            )}
          </div>
        </div>
      )}

      {/* 6. Sub-tab: Analytics & Multi-dimensional Comparison */}
      {activeSubTab === 'Analytics' && (
        isBrowserAccount ? (
          <BrowserFeatureUnavailableBanner
            featureName="Threads アナリティクス・詳細インサイト"
            description="Threads Insights API (threads_manage_insights) はMeta公式API専用機能です。Browser接続アカウントではご利用いただけません。"
          />
        ) : (
        <div className="flex flex-col gap-6">
          {/* KPI Summary Cards */}
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <div className={card}>
              <div className="text-xs text-textItemBlur">Total Views</div>
              <div className="mt-1 text-2xl font-bold text-textColor">
                {analyticsData?.summary?.totalViews?.toLocaleString?.() || 0}
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-textItemBlur">Total Likes</div>
              <div className="mt-1 text-2xl font-bold text-textColor">
                {analyticsData?.summary?.totalLikes?.toLocaleString?.() || 0}
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-textItemBlur">Total Replies</div>
              <div className="mt-1 text-2xl font-bold text-textColor">
                {analyticsData?.summary?.totalReplies?.toLocaleString?.() || 0}
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-textItemBlur">Total Reposts</div>
              <div className="mt-1 text-2xl font-bold text-textColor">
                {analyticsData?.summary?.totalReposts?.toLocaleString?.() || 0}
              </div>
            </div>
            <div className={card}>
              <div className="text-xs text-textItemBlur">Total Quotes</div>
              <div className="mt-1 text-2xl font-bold text-textColor">
                {analyticsData?.summary?.totalQuotes?.toLocaleString?.() || 0}
              </div>
            </div>
          </div>

          {/* Multi-Dimensional Comparison Cards */}
          <div className="grid gap-6 md:grid-cols-2">
            {/* Ghost vs Regular */}
            <div className={card}>
              <h3 className="font-bold text-sm text-textColor flex items-center gap-2">
                <span>👻</span> Ghost Post (24h消滅) vs 通常投稿の比較
              </h3>
              <p className="mt-1 text-xs text-textItemBlur">
                24時間限定投稿と永続投稿のインプレッションと反応率の差異
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-blockSeparator p-3">
                  <div className="text-textItemBlur font-semibold">👻 Ghost Posts</div>
                  <div className="mt-2 text-lg font-bold">
                    {analyticsData?.comparisons?.ghostVsRegular?.ghost?.count || 0} 投稿
                  </div>
                  <div className="text-xs text-textItemBlur mt-1">
                    平均いいね: {analyticsData?.comparisons?.ghostVsRegular?.ghost?.avgLikes || 0}
                  </div>
                </div>
                <div className="rounded-lg border border-blockSeparator p-3">
                  <div className="text-textItemBlur font-semibold">📄 Regular Posts</div>
                  <div className="mt-2 text-lg font-bold">
                    {analyticsData?.comparisons?.ghostVsRegular?.regular?.count || 0} 投稿
                  </div>
                  <div className="text-xs text-textItemBlur mt-1">
                    平均いいね: {analyticsData?.comparisons?.ghostVsRegular?.regular?.avgLikes || 0}
                  </div>
                </div>
              </div>
            </div>

            {/* Poll vs No Poll */}
            <div className={card}>
              <h3 className="font-bold text-sm text-textColor flex items-center gap-2">
                <span>📊</span> アンケート (Poll) 有無の反応比較
              </h3>
              <p className="mt-1 text-xs text-textItemBlur">
                投票選択肢を設置した投稿と通常投稿のエンゲージメント比較
              </p>
              <div className="mt-4 grid grid-cols-2 gap-3 text-xs">
                <div className="rounded-lg border border-blockSeparator p-3">
                  <div className="text-textItemBlur font-semibold">📊 Pollあり</div>
                  <div className="mt-2 text-lg font-bold">
                    {analyticsData?.comparisons?.pollVsNoPoll?.withPoll?.count || 0} 投稿
                  </div>
                  <div className="text-xs text-textItemBlur mt-1">
                    平均返信: {analyticsData?.comparisons?.pollVsNoPoll?.withPoll?.avgReplies || 0}
                  </div>
                </div>
                <div className="rounded-lg border border-blockSeparator p-3">
                  <div className="text-textItemBlur font-semibold">テキストのみ</div>
                  <div className="mt-2 text-lg font-bold">
                    {analyticsData?.comparisons?.pollVsNoPoll?.withoutPoll?.count || 0} 投稿
                  </div>
                  <div className="text-xs text-textItemBlur mt-1">
                    平均返信: {analyticsData?.comparisons?.pollVsNoPoll?.withoutPoll?.avgReplies || 0}
                  </div>
                </div>
              </div>
            </div>
          </div>
        </div>
        )
      )}

      {/* 7. Sub-tab: Settings & Automation */}
      {activeSubTab === 'Settings' && (
        <div className="grid gap-6 xl:grid-cols-2">
          {/* Threads Account Connection Card (Official OAuth & Browser Sidecar) */}
          <div className={clsx(card, 'xl:col-span-2')}>
            <h2 className="text-base font-bold text-textColor flex items-center gap-2">
              <span>🔗</span> Threads アカウント接続
            </h2>
            <p className="mt-1 text-xs text-textItemBlur">
              Meta公式APIによるOAuth接続、またはローカルのBrowser Sidecarによるブラウザ接続を管理します。
            </p>

            <div className="mt-4 grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Official Meta OAuth */}
              <div className="rounded-lg border border-blockSeparator p-4 bg-newBgColorInner flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-textColor flex items-center gap-1.5">
                      <span>🌐</span> 公式API (Meta OAuth)
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 text-blue-400 border border-blue-500/30">
                      Graph API
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-textItemBlur leading-relaxed">
                    Meta Graph APIを利用して接続します。投稿、リサーチ、インサイト、Inbox返信など全ての公式機能が利用可能です。
                  </p>
                </div>
                <div className="mt-4 pt-3 border-t border-blockSeparator">
                  <button
                    type="button"
                    className={clsx(primaryButton, 'w-full text-center justify-center')}
                    onClick={connectOfficialAccountAction}
                  >
                    公式APIで接続 ➔
                  </button>
                </div>
              </div>

              {/* Browser Sidecar Connection */}
              <div className="rounded-lg border border-blockSeparator p-4 bg-newBgColorInner flex flex-col justify-between">
                <div>
                  <div className="flex items-center justify-between">
                    <span className="font-bold text-sm text-textColor flex items-center gap-1.5">
                      <span>🖥️</span> Browserで接続 (Playwright Sidecar)
                    </span>
                    <span className="text-[10px] px-2 py-0.5 rounded bg-purple-500/10 text-purple-400 border border-purple-500/30 font-mono">
                      Sidecar
                    </span>
                  </div>
                  <p className="mt-2 text-xs text-textItemBlur leading-relaxed">
                    ローカルのThreads Browser Sidecarでログイン済みのプロファイル（例: main）をSNS Studioのアカウントとして登録します。
                  </p>

                  {/* Account Alias Input & Sidecar Status */}
                  <div className="mt-3 space-y-2">
                    <div className="flex items-center gap-2">
                      <label className="text-xs text-textItemBlur whitespace-nowrap">プロファイル:</label>
                      <input
                        type="text"
                        value={browserAccountInput}
                        onChange={(e) => setBrowserAccountInput(e.target.value)}
                        placeholder="main"
                        className={clsx(field, 'text-xs py-1 px-2')}
                        disabled={browserConnecting || checkingSidecar}
                      />
                      <button
                        type="button"
                        className={clsx(secondaryButton, 'text-xs py-1 px-3 whitespace-nowrap')}
                        onClick={() => void checkSidecarStatus()}
                        disabled={checkingSidecar || !browserAccountInput.trim()}
                      >
                        {checkingSidecar ? '確認中...' : '状態確認'}
                      </button>
                    </div>

                    {browserCheckResult && (
                      <div
                        className={clsx(
                          'text-xs p-2.5 rounded border',
                          browserCheckResult.healthy && browserCheckResult.session === 'SESSION_OK'
                            ? 'border-emerald-500/30 bg-emerald-500/10 text-emerald-300'
                            : 'border-amber-500/30 bg-amber-500/10 text-amber-300'
                        )}
                      >
                        <div className="font-semibold flex items-center gap-1.5">
                          <span>{browserCheckResult.healthy && browserCheckResult.session === 'SESSION_OK' ? '✅' : '⚠️'}</span>
                          <span>Sidecar: {browserCheckResult.healthy ? 'ONLINE (8017)' : 'OFFLINE'}</span>
                          <span>/ Session: {browserCheckResult.session || 'UNKNOWN'}</span>
                        </div>
                        {browserCheckResult.profile && (
                          <div className="mt-1 text-[11px] text-textItemBlur">
                            ユーザー: @{browserCheckResult.profile.username || browserCheckResult.profile.display_name} ({browserCheckResult.profile.display_name})
                          </div>
                        )}
                        {browserCheckResult.error && (
                          <div className="mt-1 text-[11px] text-red-400">
                            {browserCheckResult.error}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>

                <div className="mt-4 pt-3 border-t border-blockSeparator">
                  <button
                    type="button"
                    className={clsx(primaryButton, 'w-full text-center justify-center bg-purple-600 hover:bg-purple-500')}
                    onClick={() => void connectBrowserAccountAction()}
                    disabled={browserConnecting || !browserAccountInput.trim()}
                  >
                    {browserConnecting ? '登録処理中...' : 'Browserで接続 ➔'}
                  </button>
                </div>
              </div>
            </div>
          </div>

          {/* Threads API Quota & Rate Limit status or Browser Transport Info */}
          {isBrowserAccount ? (
            <div className={clsx(card, 'xl:col-span-2 bg-purple-500/10 border-purple-500/30')}>
              <h2 className="text-base font-bold text-textColor flex items-center gap-2">
                <span>🖥️</span> Threads Browser Transport (Sidecar) 接続情報
              </h2>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-3 gap-4 text-xs">
                <div className="rounded-lg bg-newBgColorInner p-3 border border-blockSeparator">
                  <div className="text-textItemBlur font-medium">トランスポート形式</div>
                  <div className="text-base font-bold text-textColor mt-1 flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-full bg-purple-400"></span>
                    Browser Sidecar (Playwright)
                  </div>
                  <div className="text-[10px] text-textItemBlur mt-1">
                    ローカルブラウザプロファイル経由
                  </div>
                </div>
                <div className="rounded-lg bg-newBgColorInner p-3 border border-blockSeparator">
                  <div className="text-textItemBlur font-medium">プロファイル Alias</div>
                  <div className="text-base font-bold text-textColor mt-1 font-mono">
                    {selectedAccount?.browserAccount || 'main'}
                  </div>
                  <div className="text-[10px] text-textItemBlur mt-1">
                    sessions/{selectedAccount?.browserAccount || 'main'}
                  </div>
                </div>
                <div className="rounded-lg bg-newBgColorInner p-3 border border-blockSeparator">
                  <div className="text-textItemBlur font-medium">投稿制限・モード</div>
                  <div className="text-base font-bold text-amber-400 mt-1">
                    Safe Dry-Run Mode
                  </div>
                  <div className="text-[10px] text-textItemBlur mt-1">
                    実投稿ガード有効 (ALLOW_REAL_POST=false)
                  </div>
                </div>
              </div>
            </div>
          ) : quotaData?.data?.[0] ? (
            <div className={clsx(card, 'xl:col-span-2 bg-[#7774ff]/10 border-[#7774ff]/30')}>
              <h2 className="text-base font-bold text-textColor flex items-center gap-2">
                <span>⏱️</span> Threads API 公開枠・レート制限 (Official 24h Quota)
              </h2>
              <div className="mt-3 grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                <div className="rounded-lg bg-newBgColorInner p-3 border border-blockSeparator">
                  <div className="text-textItemBlur font-medium">投稿クォータ消費量 (Posts)</div>
                  <div className="text-lg font-bold text-textColor mt-1">
                    {quotaData.data[0].quota_usage ?? 0} / {quotaData.data[0].config?.quota_total ?? 250}
                  </div>
                  <div className="text-[10px] text-textItemBlur mt-1">
                    直近24時間の移動枠で消費された新規投稿コンテナ数
                  </div>
                </div>
                <div className="rounded-lg bg-newBgColorInner p-3 border border-blockSeparator">
                  <div className="text-textItemBlur font-medium">返信クォータ消費量 (Replies)</div>
                  <div className="text-lg font-bold text-textColor mt-1">
                    {quotaData.data[0].reply_quota_usage ?? 0} / {quotaData.data[0].config?.reply_quota_total ?? 1000}
                  </div>
                  <div className="text-[10px] text-textItemBlur mt-1">
                    直近24時間の移動枠で消費された返信・コメント数
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {/* Default Reply Controls & Account Rules */}
          <div className={card}>
            <h2 className="text-base font-bold text-textColor flex items-center gap-2">
              <span>🔒</span> 返信制限・基本設定
            </h2>
            <p className="mt-1 text-xs text-textItemBlur">
              このThreadsアカウントにおける新規投稿の既定返信制限を設定します。
            </p>

            <div className="mt-4 flex flex-col gap-3">
              <div>
                <label className="block text-xs font-semibold text-textItemBlur mb-1">
                  既定の返信制限 (Default Reply Control)
                </label>
                <select
                  value={settingsForm.defaultReplyControl}
                  onChange={(e) =>
                    setSettingsForm({
                      ...settingsForm,
                      defaultReplyControl: e.target.value,
                    })
                  }
                  className={field}
                >
                  {THREADS_REPLY_CONTROL_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label} — {opt.description}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-textItemBlur mb-1">
                  AIキャラクター / 役割設定
                </label>
                <input
                  type="text"
                  value={settingsForm.aiCharacter}
                  onChange={(e) =>
                    setSettingsForm({
                      ...settingsForm,
                      aiCharacter: e.target.value,
                    })
                  }
                  className={field}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-textItemBlur mb-1">
                  NGワードリスト（カンマ区切り）
                </label>
                <input
                  type="text"
                  value={settingsForm.ngWords}
                  onChange={(e) =>
                    setSettingsForm({
                      ...settingsForm,
                      ngWords: e.target.value,
                    })
                  }
                  className={field}
                />
              </div>
            </div>
          </div>

          {/* Conditional Auto-Reply & Auto-Plug */}
          <div className={card}>
            <h2 className="text-base font-bold text-textColor flex items-center gap-2">
              <span>⚡</span> 条件付き自動返信 & Auto-Plug
            </h2>
            <p className="mt-1 text-xs text-textItemBlur">
              炎上防止のため既定OFF。アカウントごとに明示的に有効化した場合のみ発動します。
            </p>

            <div className="mt-4 flex flex-col gap-4">
              {/* Conditional AI Auto Reply */}
              <div className="rounded-lg border border-blockSeparator p-3">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="font-semibold text-xs text-textColor">
                    🤖 条件付きAI自動返信 (Opt-in)
                  </span>
                  <input
                    type="checkbox"
                    checked={settingsForm.autoReplyEnabled}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        autoReplyEnabled: e.target.checked,
                      })
                    }
                  />
                </label>
                {settingsForm.autoReplyEnabled && (
                  <div className="mt-3 flex flex-col gap-2 text-xs border-t border-blockSeparator pt-2">
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={settingsForm.autoReplyOnlyQuestions}
                        onChange={(e) =>
                          setSettingsForm({
                            ...settingsForm,
                            autoReplyOnlyQuestions: e.target.checked,
                          })
                        }
                      />
                      <span>質問と判定されたリプライのみ返信する</span>
                    </label>
                    <label className="flex items-center gap-2">
                      <input
                        type="checkbox"
                        checked={settingsForm.autoReplyExcludeUrls}
                        onChange={(e) =>
                          setSettingsForm({
                            ...settingsForm,
                            autoReplyExcludeUrls: e.target.checked,
                          })
                        }
                      />
                      <span>URLが含まれるリプライ・スパムは除外する</span>
                    </label>
                    <div>
                      <span className="text-textItemBlur text-[11px]">
                        1日の最大返信数:
                      </span>
                      <input
                        type="number"
                        min="1"
                        max="200"
                        value={settingsForm.maxRepliesPerDay}
                        onChange={(e) =>
                          setSettingsForm({
                            ...settingsForm,
                            maxRepliesPerDay: Number(e.target.value),
                          })
                        }
                        className={clsx(field, 'w-24 mt-1')}
                      />
                    </div>
                  </div>
                )}
              </div>

              {/* Auto-Plug */}
              <div className="rounded-lg border border-blockSeparator p-3">
                <label className="flex items-center justify-between cursor-pointer">
                  <span className="font-semibold text-xs text-textColor">
                    🚀 Auto-Plug (高反響ポストへの自動ぶら下げ)
                  </span>
                  <input
                    type="checkbox"
                    checked={settingsForm.autoPlugEnabled}
                    onChange={(e) =>
                      setSettingsForm({
                        ...settingsForm,
                        autoPlugEnabled: e.target.checked,
                      })
                    }
                  />
                </label>
                {settingsForm.autoPlugEnabled && (
                  <div className="mt-3 flex flex-col gap-2 text-xs border-t border-blockSeparator pt-2">
                    <div>
                      <span className="text-textItemBlur text-[11px]">
                        いいねしきい値:
                      </span>
                      <input
                        type="number"
                        min="10"
                        value={settingsForm.autoPlugLikesThreshold}
                        onChange={(e) =>
                          setSettingsForm({
                            ...settingsForm,
                            autoPlugLikesThreshold: Number(e.target.value),
                          })
                        }
                        className={clsx(field, 'w-24 mt-1')}
                      />
                    </div>
                    <div>
                      <span className="text-textItemBlur text-[11px]">
                        ぶら下げメッセージ (宣伝/リンク):
                      </span>
                      <textarea
                        rows={2}
                        value={settingsForm.autoPlugMessage}
                        onChange={(e) =>
                          setSettingsForm({
                            ...settingsForm,
                            autoPlugMessage: e.target.value,
                          })
                        }
                        className={field}
                      />
                    </div>
                  </div>
                )}
              </div>

              <button
                type="button"
                className={primaryButton}
                disabled={busy || !effectiveAccountId}
                onClick={() =>
                  void runAction(saveAccountSettings, 'アカウント設定を保存しました。')
                }
              >
                設定を保存
              </button>
            </div>
          </div>

          {/* Feature Flags & API Scopes Overview */}
          <div className={clsx(card, 'xl:col-span-2')}>
            <h3 className="font-bold text-xs text-textColor mb-2 flex items-center gap-1.5">
              <span>🛡️</span> Threads API 必要Scope
            </h3>
            <div className="grid grid-cols-2 md:grid-cols-3 gap-2 text-xs">
              <div className="rounded border border-blockSeparator p-2 flex items-center justify-between">
                <span>threads_basic</span>
                <span className="text-textItemBlur font-semibold">必要</span>
              </div>
              <div className="rounded border border-blockSeparator p-2 flex items-center justify-between">
                <span>threads_content_publish</span>
                <span className="text-textItemBlur font-semibold">必要</span>
              </div>
              <div className="rounded border border-blockSeparator p-2 flex items-center justify-between">
                <span>threads_manage_replies</span>
                <span className="text-textItemBlur font-semibold">必要</span>
              </div>
              <div className="rounded border border-blockSeparator p-2 flex items-center justify-between">
                <span>threads_read_replies</span>
                <span className="text-textItemBlur font-semibold">必要</span>
              </div>
              <div className="rounded border border-blockSeparator p-2 flex items-center justify-between">
                <span>threads_manage_insights</span>
                <span className="text-textItemBlur font-semibold">必要</span>
              </div>
              <div className="rounded border border-blockSeparator p-2 flex items-center justify-between">
                <span>threads_keyword_search</span>
                <span className="text-textItemBlur font-semibold">必要</span>
              </div>
            </div>
            <p className="mt-2 text-[11px] text-textItemBlur">
              この一覧はSNS Studioが利用する必要Scopeです。Meta Appで実際に付与済みかどうかを示すものではありません。
            </p>
          </div>
        </div>
      )}
    </div>
  );
};
