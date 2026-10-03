'use client';

import { useCallback, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

type WorkspaceView = 'queue' | 'history' | 'analytics';

type AccountPolicy = {
  integrationId: string;
  accountName: string;
  providerIdentifier: string;
};

type NormalizedMetrics = Record<
  'likes' | 'comments' | 'shares' | 'views' | 'reach' | 'impressions' | 'saves' | 'clicks',
  number | null
>;

type CommonDeliveryRow = {
  deliveryId: string;
  contentId: string;
  contentTitle: string | null;
  content: string;
  finalBody: string;
  platform: string;
  integrationId: string;
  accountName: string;
  status: string;
  deliveryStatus: string;
  effectivePublishAt: string | null;
  publishedAt: string | null;
  approvalRequired: boolean;
  approvedAt: string | null;
  policy: {
    decision: string;
    allowed: boolean;
    reasons: Array<{ code: string; message: string }>;
  };
  postId: string | null;
  providerPostId: string | null;
  postUrl: string | null;
  postState: string | null;
  failureInformation: string | null;
  providerPublicationDetail: { label: string; providerStatus: string } | null;
  analyticsAvailable: boolean;
  normalizedMetrics?: NormalizedMetrics;
  selectedVariant: { name: string; mediaAsset?: { fileName: string } } | null;
  settingsOverride: unknown;
  providerSettingsSnapshot: unknown;
  resolvedHashtags: unknown;
};

const stateNames: Record<string, string> = {
  planned: '計画中',
  draft: '下書き',
  queued: '投稿待ち',
  scheduled: '予約済み',
  published: '公開済み',
  uploaded: '受信箱へアップロード済み・公開前',
  failed: '失敗',
  link_missing: 'Postiz投稿を確認できません',
};

const metricNames: Array<[keyof NormalizedMetrics, string]> = [
  ['likes', 'いいね'],
  ['comments', 'コメント'],
  ['shares', 'シェア'],
  ['views', '再生'],
  ['reach', 'リーチ'],
  ['impressions', '表示回数'],
  ['saves', '保存'],
  ['clicks', 'クリック'],
];

const card = 'rounded-lg border border-blockSeparator p-4';
const field =
  'min-w-36 rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2 text-sm text-newTextColor outline-none focus:border-[#7774ff]';
const button =
  'rounded-lg border border-blockSeparator px-3 py-2 text-sm font-semibold hover:bg-boxFocused disabled:cursor-not-allowed disabled:opacity-50';

const shownDate = (value: string | null | undefined) =>
  value ? new Date(value).toLocaleString() : '日時未設定';

export const CommonDeliveryWorkspace = ({ view }: { view: WorkspaceView }) => {
  const fetch = useFetch();
  const [platform, setPlatform] = useState('');
  const [accountId, setAccountId] = useState('');
  const [state, setState] = useState('');
  const [query, setQuery] = useState('');
  const [analyticsByDelivery, setAnalyticsByDelivery] = useState<
    Record<string, { metrics: NormalizedMetrics; details: unknown[]; available: boolean }>
  >({});
  const [loadingAnalytics, setLoadingAnalytics] = useState<Record<string, boolean>>({});
  const [errorMessage, setErrorMessage] = useState('');

  const request = useCallback(
    async (path: string) => {
      const response = await fetch(path);
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || payload?.code || '読み込みに失敗しました。');
      }
      return payload;
    },
    [fetch]
  );

  const { data: accounts = [] } = useSWR<AccountPolicy[]>(
    '/sns-studio/common/account-policies',
    request
  );
  const apiName = view === 'queue' ? 'queue' : view === 'history' ? 'history' : 'analytics';
  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    if (platform) params.set('platform', platform);
    if (accountId) params.set('accountId', accountId);
    if (state) params.set('state', state);
    if (query.trim()) params.set('q', query.trim());
    return params.toString();
  }, [accountId, platform, query, state]);
  const listUrl = `/sns-studio/common/${apiName}${queryString ? `?${queryString}` : ''}`;
  const { data: rows = [], isLoading, mutate } = useSWR<CommonDeliveryRow[]>(listUrl, request);

  const platforms = useMemo(
    () => Array.from(new Set(accounts.map((account) => account.providerIdentifier))).sort(),
    [accounts]
  );
  const visibleAccounts = useMemo(
    () => accounts.filter((account) => !platform || account.providerIdentifier === platform),
    [accounts, platform]
  );

  const refreshAnalytics = async (deliveryId: string) => {
    setLoadingAnalytics((current) => ({ ...current, [deliveryId]: true }));
    setErrorMessage('');
    try {
      const result = await request(
        `/sns-studio/common/analytics/${deliveryId}?date=${Date.now()}`
      );
      setAnalyticsByDelivery((current) => ({
        ...current,
        [deliveryId]: {
          metrics: result.normalizedMetrics,
          details: result.providerDetails || [],
          available: result.available === true,
        },
      }));
    } catch (error) {
      setErrorMessage(
        error instanceof Error ? error.message : 'Analyticsを取得できませんでした。'
      );
    } finally {
      setLoadingAnalytics((current) => ({ ...current, [deliveryId]: false }));
    }
  };

  const title =
    view === 'queue' ? '共通投稿Queue' : view === 'history' ? '共通投稿History' : '共通Analytics';
  const description =
    view === 'queue'
      ? '配信先ごとの投稿待ち・予約・Policy判定を表示します。投稿処理は既存のPostiz Queueが実行します。'
      : view === 'history'
        ? 'Postiz投稿と共通Deliveryを結び、最終本文・結果・設定snapshotを確認します。'
        : '投稿単位の共通指標を表示します。取得できない指標は未取得のまま扱います。';

  return (
    <section className="grid gap-4">
      <header>
        <h2 className="text-xl font-bold">{title}</h2>
        <p className="mt-1 text-sm text-textItemBlur">{description}</p>
      </header>

      <div className="flex flex-wrap items-end gap-3 rounded-xl border border-blockSeparator p-4">
        <label className="grid gap-1 text-xs">
          <span>Platform</span>
          <select
            aria-label="Platform"
            className={field}
            value={platform}
            onChange={(event) => {
              setPlatform(event.target.value);
              setAccountId('');
            }}
          >
            <option value="">すべて</option>
            {platforms.map((item) => <option key={item} value={item}>{item}</option>)}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          <span>Account</span>
          <select
            aria-label="Account"
            className={field}
            value={accountId}
            onChange={(event) => setAccountId(event.target.value)}
          >
            <option value="">すべて</option>
            {visibleAccounts.map((account) => (
              <option key={account.integrationId} value={account.integrationId}>
                {account.accountName}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-xs">
          <span>State</span>
          <select
            aria-label="State"
            className={field}
            value={state}
            onChange={(event) => setState(event.target.value)}
          >
            <option value="">すべて</option>
            {Object.entries(stateNames).map(([key, label]) => (
              <option key={key} value={key}>{label}</option>
            ))}
          </select>
        </label>
        <label className="grid min-w-52 flex-1 gap-1 text-xs">
          <span>Content / delivery</span>
          <input
            aria-label="Content or delivery search"
            className={field}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="本文・タイトルを検索"
          />
        </label>
        <button className={button} type="button" onClick={() => void mutate()}>
          更新
        </button>
      </div>

      {errorMessage && <p role="alert" className="text-sm text-red-300">{errorMessage}</p>}
      {isLoading ? (
        <p className="text-sm text-textItemBlur">読み込み中...</p>
      ) : rows.length === 0 ? (
        <div className={card}><p className="text-sm text-textItemBlur">表示できる共通配信はありません。</p></div>
      ) : (
        <div className="grid gap-3">
          {rows.map((row) => {
            const analytics = analyticsByDelivery[row.deliveryId];
            const metrics = analytics?.metrics || row.normalizedMetrics;
            return (
              <article key={row.deliveryId} className={card}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-56 flex-1">
                    <div className="font-semibold">{row.contentTitle || row.finalBody || '無題の投稿'}</div>
                    <div className="mt-1 text-xs text-textItemBlur">
                      {row.platform} · {row.accountName} · {stateNames[row.status] || row.status}
                    </div>
                    <div className="mt-1 text-xs text-textItemBlur">
                      {row.selectedVariant?.name || row.selectedVariant?.mediaAsset?.fileName || 'Variant未設定'}
                      {' · '}{shownDate(row.effectivePublishAt)}
                    </div>
                  </div>
                  {view === 'analytics' && row.postId && (
                    <button
                      className={button}
                      type="button"
                      disabled={!row.analyticsAvailable || !!loadingAnalytics[row.deliveryId]}
                      onClick={() => void refreshAnalytics(row.deliveryId)}
                    >
                      {loadingAnalytics[row.deliveryId] ? '取得中...' : '指標を更新'}
                    </button>
                  )}
                  {row.postUrl && (
                    <a className="text-sm text-[#9e9aff] underline" href={row.postUrl} target="_blank" rel="noreferrer">
                      {row.status === 'uploaded' ? 'Providerの受信箱を開く' : 'Postiz投稿を開く'}
                    </a>
                  )}
                </div>

                {view === 'queue' && (
                  <div className="mt-3 border-t border-blockSeparator pt-3 text-sm">
                    <div>
                      承認: {row.approvedAt ? '承認済み' : row.approvalRequired ? '承認待ち' : '不要'}
                      {' · '}Policy: {row.policy.allowed ? '通過' : 'ブロック'}
                    </div>
                    <div className="mt-1 text-xs text-textItemBlur">
                      Postiz ID: {row.postId || '—'} · Provider ID: {row.providerPostId || '—'}
                    </div>
                    {!row.policy.allowed && row.policy.reasons.map((reason) => (
                      <p key={reason.code} className="mt-1 text-xs text-amber-300">{reason.message}</p>
                    ))}
                    {row.failureInformation && <p className="mt-2 text-xs text-red-300">{row.failureInformation}</p>}
                  </div>
                )}

                {view === 'history' && (
                  <div className="mt-3 grid gap-2 border-t border-blockSeparator pt-3 text-sm">
                    {row.providerPublicationDetail && (
                      <p className="text-amber-300">{row.providerPublicationDetail.label}</p>
                    )}
                    {row.failureInformation && <p className="text-red-300">{row.failureInformation}</p>}
                    <div className="whitespace-pre-wrap text-sm">{row.finalBody || '本文なし'}</div>
                    <div className="text-xs text-textItemBlur">
                      Postiz ID: {row.postId || '—'} · Provider ID: {row.providerPostId || '—'}
                      {' · '}公開日時: {shownDate(row.publishedAt)}
                    </div>
                    <details className="text-xs">
                      <summary className="cursor-pointer">保存した配信設定を確認</summary>
                      <div className="mt-2 grid gap-2">
                        <div><strong>settingsOverride（ユーザー指定値）</strong><pre className="mt-1 overflow-auto">{JSON.stringify(row.settingsOverride, null, 2) || 'null'}</pre></div>
                        <div><strong>providerSettingsSnapshot（送信設定）</strong><pre className="mt-1 overflow-auto">{JSON.stringify(row.providerSettingsSnapshot, null, 2) || 'null'}</pre></div>
                      </div>
                    </details>
                  </div>
                )}

                {view === 'analytics' && (
                  <div className="mt-3 border-t border-blockSeparator pt-3">
                    {metrics ? (
                      <dl className="grid grid-cols-2 gap-2 text-xs sm:grid-cols-4">
                        {metricNames.map(([key, label]) => (
                          <div key={key} className="rounded border border-blockSeparator p-2">
                            <dt className="text-textItemBlur">{label}</dt>
                            <dd className="mt-1 font-semibold">{metrics[key] ?? '未取得'}</dd>
                          </div>
                        ))}
                      </dl>
                    ) : (
                      <p className="text-xs text-textItemBlur">指標はまだ取得していません。</p>
                    )}
                    {!row.analyticsAvailable && <p className="mt-2 text-xs text-textItemBlur">このDeliveryに取得可能な公開済み投稿指標がありません。</p>}
                    {analytics?.details?.length ? (
                      <details className="mt-2 text-xs">
                        <summary className="cursor-pointer">Provider固有Analytics</summary>
                        <pre className="mt-2 overflow-auto">{JSON.stringify(analytics.details, null, 2)}</pre>
                      </details>
                    ) : null}
                  </div>
                )}
              </article>
            );
          })}
        </div>
      )}
    </section>
  );
};
