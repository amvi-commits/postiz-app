'use client';

import { useMemo, useState } from 'react';
import useSWR from 'swr';
import dayjs from 'dayjs';
import { CalendarWeekProvider } from '@gitroom/frontend/components/launches/calendar.context';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { NewPost } from '@gitroom/frontend/components/launches/new.post';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

const card =
  'rounded-xl border border-blockSeparator bg-newBgColorInner p-5';
const field =
  'w-full rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2 text-newTextColor outline-none focus:border-[#7774ff]';
const primaryButton =
  'rounded-lg bg-[#5145ff] px-4 py-2 font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50';
const secondaryButton =
  'rounded-lg border border-blockSeparator px-4 py-2 font-semibold text-newTextColor hover:bg-boxFocused disabled:opacity-50';

const supportedIdentifiers = new Set([
  'instagram',
  'instagram-standalone',
  'tiktok',
  'tiktok-business',
  'youtube',
  'threads',
  'x',
]);

const platformName = (identifier: string) => {
  if (identifier.startsWith('instagram')) return 'Instagram';
  if (identifier.startsWith('tiktok')) return 'TikTok';
  if (identifier === 'youtube') return 'YouTube';
  if (identifier === 'threads') return 'Threads';
  if (identifier === 'x') return 'X';
  return identifier;
};

const platformKey = (identifier: string) => {
  if (identifier.startsWith('instagram')) return 'instagram';
  if (identifier.startsWith('tiktok')) return 'tiktok';
  return identifier;
};

const parseHashtags = (value: string) =>
  value
    .split(/[\s,]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => (item.startsWith('#') ? item : `#${item}`));

const appendHashtags = (content: string, hashtags: string[]) =>
  [content.trim(), hashtags.join(' ')].filter(Boolean).join('\n\n');

type OverrideState = {
  content: string;
  hashtags: string;
  scheduledAt: string;
};

type DeliveryState = OverrideState & {
  selected: boolean;
};

export type CommonPublishPrefill = {
  content?: string;
  sourceAssetId?: string;
  media: {
    id: string;
    path: string;
  };
};

export const SnsStudioCommonPublisher = ({
  prefill,
}: {
  prefill?: CommonPublishPrefill | null;
}) => {
  const fetch = useFetch();
  const { data: integrations = [], isLoading, error } = useIntegrationList();
  const [activePrefill, setActivePrefill] = useState<CommonPublishPrefill | null>(
    prefill || null
  );
  const [planId, setPlanId] = useState<string | null>(null);
  const [title, setTitle] = useState('');
  const [commonContent, setCommonContent] = useState(prefill?.content || '');
  const [commonHashtags, setCommonHashtags] = useState('');
  const [commonScheduledAt, setCommonScheduledAt] = useState('');
  const [platformOverrides, setPlatformOverrides] = useState<
    Record<string, OverrideState>
  >({});
  const [deliveries, setDeliveries] = useState<Record<string, DeliveryState>>(
    {}
  );
  const [savedSignature, setSavedSignature] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState('');

  const loadPlans = async (path: string) => {
    const response = await fetch(path);
    if (!response.ok) return [];
    return response.json();
  };
  const { data: plans = [], mutate: refreshPlans } = useSWR<any[]>(
    '/sns-studio/content-plans',
    loadPlans,
    { revalidateOnFocus: false }
  );

  const localDate = (value?: string | null) =>
    value ? dayjs(value).format('YYYY-MM-DDTHH:mm') : '';

  const destinations = integrations.filter(
    (integration) =>
      supportedIdentifiers.has(integration.identifier) &&
      !integration.disabled &&
      !integration.inBetweenSteps
  );

  const groupedDestinations = useMemo(() => {
    const grouped = new Map<string, typeof destinations>();
    for (const integration of destinations) {
      const key = platformKey(integration.identifier);
      grouped.set(key, [...(grouped.get(key) || []), integration]);
    }
    return Array.from(grouped.entries());
  }, [destinations]);

  const selectedDestinations = destinations.filter(
    (integration) => deliveries[integration.id]?.selected
  );

  const planPayload = useMemo(
    () => ({
      title,
      commonContent,
      commonHashtags: parseHashtags(commonHashtags),
      commonScheduledAt: commonScheduledAt ? dayjs(commonScheduledAt).toISOString() : null,
      originalAssetId: activePrefill?.sourceAssetId || null,
      platformOverrides: Object.entries(platformOverrides)
        .filter(
          ([, value]) =>
            value.content || value.hashtags || value.scheduledAt
        )
        .map(([platform, value]) => ({
          platform,
          ...(value.content ? { contentOverride: value.content } : {}),
          ...(value.hashtags
            ? { hashtagsOverride: parseHashtags(value.hashtags) }
            : {}),
          ...(value.scheduledAt
            ? { scheduledAtOverride: dayjs(value.scheduledAt).toISOString() }
            : {}),
        })),
      deliveries: selectedDestinations.map((integration) => {
        const value = deliveries[integration.id] || {
          selected: true,
          content: '',
          hashtags: '',
          scheduledAt: '',
        };
        return {
          integrationId: integration.id,
          ...(value.content ? { contentOverride: value.content } : {}),
          ...(value.hashtags
            ? { hashtagsOverride: parseHashtags(value.hashtags) }
            : {}),
          ...(value.scheduledAt
            ? { scheduledAtOverride: dayjs(value.scheduledAt).toISOString() }
            : {}),
        };
      }),
    }),
    [
      title,
      commonContent,
      commonHashtags,
      commonScheduledAt,
      activePrefill?.sourceAssetId,
      platformOverrides,
      deliveries,
      selectedDestinations,
    ]
  );

  const signature = JSON.stringify(planPayload);
  const dirty = planId ? signature !== savedSignature : true;

  const effectiveFor = (integration: (typeof destinations)[number]) => {
    const platform = platformOverrides[platformKey(integration.identifier)] || {
      content: '',
      hashtags: '',
      scheduledAt: '',
    };
    const account = deliveries[integration.id] || {
      selected: false,
      content: '',
      hashtags: '',
      scheduledAt: '',
    };
    const content = account.content || platform.content || commonContent;
    const hashtags = account.hashtags
      ? parseHashtags(account.hashtags)
      : platform.hashtags
        ? parseHashtags(platform.hashtags)
        : parseHashtags(commonHashtags);
    const scheduledAt =
      account.scheduledAt || platform.scheduledAt || commonScheduledAt;
    return { content, hashtags, scheduledAt };
  };

  const updatePlatform = (
    platform: string,
    patch: Partial<OverrideState>
  ) => {
    setPlatformOverrides((current) => ({
      ...current,
      [platform]: {
        content: '',
        hashtags: '',
        scheduledAt: '',
        ...(current[platform] || {}),
        ...patch,
      },
    }));
  };

  const updateDelivery = (
    integrationId: string,
    patch: Partial<DeliveryState>
  ) => {
    setDeliveries((current) => ({
      ...current,
      [integrationId]: {
        selected: false,
        content: '',
        hashtags: '',
        scheduledAt: '',
        ...(current[integrationId] || {}),
        ...patch,
      },
    }));
  };

  const savePlan = async () => {
    if (!selectedDestinations.length) {
      setMessage('投稿先アカウントを1つ以上選択してください。');
      return;
    }
    setSaving(true);
    setMessage('');
    try {
      const response = await fetch(
        planId ? `/sns-studio/content-plans/${planId}` : '/sns-studio/content-plans',
        {
          method: planId ? 'PUT' : 'POST',
          body: JSON.stringify(planPayload),
        }
      );
      const result = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(result?.code || result?.message || '配信計画の保存に失敗しました。');
      }
      setPlanId(result.id);
      setSavedSignature(signature);
      setMessage('配信計画を保存しました。');
      await refreshPlans();
    } catch (saveError) {
      setMessage(
        saveError instanceof Error
          ? saveError.message
          : '配信計画の保存に失敗しました。'
      );
    } finally {
      setSaving(false);
    }
  };

  const resetPlan = () => {
    setPlanId(null);
    setTitle('');
    setCommonContent(activePrefill?.content || '');
    setCommonHashtags('');
    setCommonScheduledAt('');
    setPlatformOverrides({});
    setDeliveries({});
    setSavedSignature('');
    setMessage('');
  };

  const loadPlan = async (plan: any) => {
    if (!['DRAFT', 'READY'].includes(plan.status)) {
      setMessage('Postiz作成済みの配信計画は重複投稿防止のため再編集できません。');
      return;
    }

    let nextPrefill: CommonPublishPrefill | null = null;
    if (plan.originalAsset?.id) {
      const response = await fetch(
        `/sns-studio/media-assets/${plan.originalAsset.id}/post-media`,
        { method: 'POST' }
      );
      const bridged = await response.json().catch(() => ({}));
      if (response.ok && bridged?.media?.id && bridged?.media?.path) {
        nextPrefill = {
          sourceAssetId: bridged.sourceAssetId,
          media: {
            id: bridged.media.id,
            path: bridged.media.path,
          },
        };
      }
    }

    const nextPlatforms = Object.fromEntries(
      (plan.platformOverrides || []).map((item: any) => [
        item.platform,
        {
          content: item.contentOverride || '',
          hashtags: Array.isArray(item.hashtagsOverride)
            ? item.hashtagsOverride.join(' ')
            : '',
          scheduledAt: localDate(item.scheduledAtOverride),
        },
      ])
    );
    const nextDeliveries = Object.fromEntries(
      (plan.deliveries || []).map((item: any) => [
        item.integrationId,
        {
          selected: true,
          content: item.contentOverride || '',
          hashtags: Array.isArray(item.hashtagsOverride)
            ? item.hashtagsOverride.join(' ')
            : '',
          scheduledAt: localDate(item.scheduledAtOverride),
        },
      ])
    );
    const nextCommonScheduledAt = localDate(plan.commonScheduledAt);

    setActivePrefill(nextPrefill);
    setPlanId(plan.id);
    setTitle(plan.title || '');
    setCommonContent(plan.commonContent || '');
    setCommonHashtags(
      Array.isArray(plan.commonHashtags) ? plan.commonHashtags.join(' ') : ''
    );
    setCommonScheduledAt(nextCommonScheduledAt);
    setPlatformOverrides(nextPlatforms);
    setDeliveries(nextDeliveries);

    const nextPayload = {
      title: plan.title || '',
      commonContent: plan.commonContent || '',
      commonHashtags: Array.isArray(plan.commonHashtags)
        ? plan.commonHashtags
        : [],
      commonScheduledAt: nextCommonScheduledAt
        ? dayjs(nextCommonScheduledAt).toISOString()
        : null,
      originalAssetId: plan.originalAsset?.id || null,
      platformOverrides: Object.entries(nextPlatforms)
        .filter(([, value]: any) =>
          value.content || value.hashtags || value.scheduledAt
        )
        .map(([platform, value]: any) => ({
          platform,
          ...(value.content ? { contentOverride: value.content } : {}),
          ...(value.hashtags
            ? { hashtagsOverride: parseHashtags(value.hashtags) }
            : {}),
          ...(value.scheduledAt
            ? { scheduledAtOverride: dayjs(value.scheduledAt).toISOString() }
            : {}),
        })),
      deliveries: (plan.deliveries || []).map((item: any) => {
        const value: any = nextDeliveries[item.integrationId];
        return {
          integrationId: item.integrationId,
          ...(value.content ? { contentOverride: value.content } : {}),
          ...(value.hashtags
            ? { hashtagsOverride: parseHashtags(value.hashtags) }
            : {}),
          ...(value.scheduledAt
            ? { scheduledAtOverride: dayjs(value.scheduledAt).toISOString() }
            : {}),
        };
      }),
    };
    setSavedSignature(JSON.stringify(nextPayload));
    setMessage('保存済み配信計画を読み込みました。');
  };

  const selectedChannels = selectedDestinations.map(
    (integration) => integration.id
  );

  const onlyValuesByIntegration = Object.fromEntries(
    selectedDestinations.map((integration) => {
      const effective = effectiveFor(integration);
      return [
        integration.id,
        [
          {
            content: appendHashtags(effective.content, effective.hashtags),
            image: activePrefill ? [activePrefill.media] : [],
          },
        ],
      ];
    })
  );

  const scheduledAtByIntegration = Object.fromEntries(
    selectedDestinations
      .map((integration) => [
        integration.id,
        effectiveFor(integration).scheduledAt,
      ])
      .filter(([, value]) => !!value)
  ) as Record<string, string>;

  const onPosted = async (result: {
    type: 'draft' | 'now' | 'schedule' | 'update';
    items: Array<{ postId: string; integration: string; date: string }>;
  }) => {
    if (!planId) return;
    await fetch(`/sns-studio/content-plans/${planId}/post-links`, {
      method: 'POST',
      body: JSON.stringify(result),
    });
  };

  if (isLoading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center">
        <LoadingComponent />
      </div>
    );
  }

  return (
    <section className="grid gap-5">
      <div className={card}>
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-bold">共通投稿・配信</h2>
          <p className="text-sm text-textItemBlur">
            共通値を設定し、必要なSNS・アカウントだけ個別上書きします。実際の投稿処理とSNS固有設定は既存Postiz providerを再利用します。
          </p>
          {activePrefill && (
            <div className="mt-2 rounded-lg border border-blockSeparator p-3 text-xs text-textItemBlur">
              SNS Studio素材: {activePrefill.media.path}
            </div>
          )}
          {message && <div className="text-sm">{message}</div>}
        </div>
      </div>

      <div className={card}>
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="font-semibold">保存済み配信計画</h3>
            <p className="text-xs text-textItemBlur">
              DRAFT / READYのみ再編集できます。Postiz作成済みは履歴として保持します。
            </p>
          </div>
          <button className={secondaryButton} onClick={resetPlan}>
            新しい配信計画
          </button>
        </div>
        <div className="grid gap-2">
          {plans.length === 0 && (
            <div className="text-sm text-textItemBlur">保存済み計画はありません。</div>
          )}
          {plans.slice(0, 12).map((plan: any) => (
            <div
              key={plan.id}
              className="flex flex-wrap items-center gap-3 rounded-lg border border-blockSeparator p-3 text-sm"
            >
              <div className="min-w-[180px] flex-1">
                <div className="font-semibold">{plan.title || '名称未設定'}</div>
                <div className="text-xs text-textItemBlur">
                  {plan.status} · {plan.deliveries?.length || 0}配信先
                </div>
              </div>
              <button
                className={secondaryButton}
                disabled={!['DRAFT', 'READY'].includes(plan.status)}
                onClick={() => void loadPlan(plan)}
              >
                読み込む
              </button>
            </div>
          ))}
        </div>
      </div>

      <div className={card}>
        <h3 className="mb-4 font-semibold">1. 共通設定</h3>
        <div className="grid gap-4">
          <label className="grid gap-1 text-sm">
            <span>管理名</span>
            <input
              className={field}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="例: 新商品紹介 10/1"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>共通投稿文</span>
            <textarea
              className={`${field} min-h-28`}
              value={commonContent}
              onChange={(event) => setCommonContent(event.target.value)}
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>共通ハッシュタグ</span>
            <input
              className={field}
              value={commonHashtags}
              onChange={(event) => setCommonHashtags(event.target.value)}
              placeholder="#商品 #おすすめ"
            />
          </label>
          <label className="grid gap-1 text-sm">
            <span>共通投稿日時</span>
            <input
              type="datetime-local"
              className={field}
              value={commonScheduledAt}
              onChange={(event) => setCommonScheduledAt(event.target.value)}
            />
          </label>
        </div>
      </div>

      <div className={card}>
        <h3 className="mb-1 font-semibold">2. SNS → アカウント上書き</h3>
        <p className="mb-4 text-xs text-textItemBlur">
          空欄は上位設定を継承します。優先順位は「アカウント ＞ SNS ＞ 共通」です。
        </p>
        {error && (
          <p className="text-sm text-red-500">
            接続済みアカウントを取得できませんでした。
          </p>
        )}
        {!destinations.length && !error && (
          <p className="text-sm text-textItemBlur">
            対応SNSの接続済みアカウントがありません。
          </p>
        )}

        <div className="grid gap-5">
          {groupedDestinations.map(([platform, platformAccounts]) => {
            const platformValue = platformOverrides[platform] || {
              content: '',
              hashtags: '',
              scheduledAt: '',
            };
            return (
              <div
                key={platform}
                className="rounded-xl border border-blockSeparator p-4"
              >
                <div className="mb-3 font-semibold">
                  {platformName(platformAccounts[0].identifier)}
                </div>
                <div className="mb-4 grid gap-3 md:grid-cols-2">
                  <label className="grid gap-1 text-xs md:col-span-2">
                    <span>SNS別投稿文（空欄=共通）</span>
                    <textarea
                      className={`${field} min-h-20`}
                      value={platformValue.content}
                      onChange={(event) =>
                        updatePlatform(platform, {
                          content: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span>SNS別ハッシュタグ</span>
                    <input
                      className={field}
                      value={platformValue.hashtags}
                      onChange={(event) =>
                        updatePlatform(platform, {
                          hashtags: event.target.value,
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span>SNS別投稿日時</span>
                    <input
                      type="datetime-local"
                      className={field}
                      value={platformValue.scheduledAt}
                      onChange={(event) =>
                        updatePlatform(platform, {
                          scheduledAt: event.target.value,
                        })
                      }
                    />
                  </label>
                </div>

                <div className="grid gap-3">
                  {platformAccounts.map((integration) => {
                    const value = deliveries[integration.id] || {
                      selected: false,
                      content: '',
                      hashtags: '',
                      scheduledAt: '',
                    };
                    return (
                      <div
                        key={integration.id}
                        className="rounded-lg border border-blockSeparator p-3"
                      >
                        <label className="flex items-center gap-2 text-sm font-semibold">
                          <input
                            type="checkbox"
                            checked={value.selected}
                            onChange={(event) =>
                              updateDelivery(integration.id, {
                                selected: event.target.checked,
                              })
                            }
                          />
                          <span>{integration.name}</span>
                        </label>
                        {value.selected && (
                          <div className="mt-3 grid gap-3 md:grid-cols-2">
                            <label className="grid gap-1 text-xs md:col-span-2">
                              <span>アカウント別投稿文</span>
                              <textarea
                                className={`${field} min-h-16`}
                                value={value.content}
                                onChange={(event) =>
                                  updateDelivery(integration.id, {
                                    content: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label className="grid gap-1 text-xs">
                              <span>アカウント別ハッシュタグ</span>
                              <input
                                className={field}
                                value={value.hashtags}
                                onChange={(event) =>
                                  updateDelivery(integration.id, {
                                    hashtags: event.target.value,
                                  })
                                }
                              />
                            </label>
                            <label className="grid gap-1 text-xs">
                              <span>アカウント別投稿日時</span>
                              <input
                                type="datetime-local"
                                className={field}
                                value={value.scheduledAt}
                                onChange={(event) =>
                                  updateDelivery(integration.id, {
                                    scheduledAt: event.target.value,
                                  })
                                }
                              />
                            </label>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </div>

      <div className={card}>
        <h3 className="mb-3 font-semibold">3. 保存 → 投稿作成</h3>
        <div className="flex flex-wrap items-center gap-3">
          <button
            className={secondaryButton}
            disabled={saving || !selectedDestinations.length}
            onClick={() => void savePlan()}
          >
            {saving ? '保存中...' : planId ? '配信計画を更新' : '配信計画を保存'}
          </button>

          {planId && !dirty && selectedDestinations.length > 0 && (
            <CalendarWeekProvider integrations={destinations}>
              <div className="min-w-[260px]">
                <NewPost
                  label="この配信計画で投稿を作成"
                  selectedChannels={selectedChannels}
                  onlyValues={[
                    {
                      content: appendHashtags(
                        commonContent,
                        parseHashtags(commonHashtags)
                      ),
                      image: activePrefill ? [activePrefill.media] : [],
                    },
                  ]}
                  onlyValuesByIntegration={onlyValuesByIntegration}
                  scheduledAtByIntegration={scheduledAtByIntegration}
                  date={
                    commonScheduledAt
                      ? dayjs(commonScheduledAt)
                      : undefined
                  }
                  onPosted={onPosted}
                />
              </div>
            </CalendarWeekProvider>
          )}
        </div>
        {planId && dirty && (
          <p className="mt-3 text-xs text-amber-300">
            設定が変更されています。投稿作成前に配信計画を保存してください。
          </p>
        )}
        <p className="mt-3 text-xs text-textItemBlur">
          投稿画面内ではTikTok・Instagram・YouTube等の既存SNS固有設定をそのまま利用できます。異なる実効投稿日時は保存時に日時単位へ分割して既存 /posts へ送信します。
        </p>
      </div>
    </section>
  );
};
