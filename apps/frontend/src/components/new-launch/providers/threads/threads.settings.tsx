'use client';

import React, { FC, useCallback, useEffect, useMemo, useState } from 'react';
import clsx from 'clsx';
import { useIntegration } from '@gitroom/frontend/components/launches/helpers/use.integration';
import { useSettings } from '@gitroom/frontend/components/launches/helpers/use.values';
import { ThreadFinisher } from '@gitroom/frontend/components/new-launch/finisher/thread.finisher';
import {
  ThreadsValidationRules,
  THREADS_REPLY_CONTROL_OPTIONS,
  THREADS_THREAD_INTERVALS,
  ThreadsReplyControl,
} from '@gitroom/nestjs-libraries/integrations/social/threads.capabilities';
import { Input } from '@gitroom/react/form/input';
import { Select } from '@gitroom/react/form/select';
import { Checkbox } from '@gitroom/react/form/checkbox';
import { Slider } from '@gitroom/react/form/slider';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

export const ThreadsSettings: FC = () => {
  const integrationContext = useIntegration();
  const { register, watch, setValue } = useSettings();
  const [isOpen, setIsOpen] = useState(true);

  // Watch form fields
  const isGhostPost = watch('isGhostPost') || false;
  const poll = watch('poll');
  const topicTag = watch('topicTag') || '';
  const locationId = watch('locationId') || '';
  const locationName = watch('locationName') || '';
  const isSpoilerMedia = watch('isSpoilerMedia') || false;
  const textSpoilerRanges = watch('textSpoilerRanges') || [];
  const textAttachment = watch('textAttachment') || '';
  const replyControl: ThreadsReplyControl = watch('replyControl') || 'everyone';
  const enableReplyApprovals = watch('enableReplyApprovals') || false;
  const quotePostId = watch('quotePostId') || '';
  const altText = watch('altText') || '';
  const threadInterval = watch('threadInterval') ?? 0;

  // Media & Post inspection from Integration Context
  const postValues = integrationContext?.value || [];
  const mediaCount = useMemo(() => {
    return postValues.reduce((sum, p) => sum + (p.image?.length || 0), 0);
  }, [postValues]);
  const hasMedia = mediaCount > 0;
  const isThread = postValues.length > 1;
  const firstPostContent = postValues[0]?.content || '';

  // Local state for Poll options builder
  const [pollEnabled, setPollEnabled] = useState(!!poll?.options?.length);
  const [pollOptions, setPollOptions] = useState<string[]>(
    poll?.options?.length ? poll.options : ['', '']
  );

  // Location search state
  const fetch = useFetch();
  const [locationSearchQuery, setLocationSearchQuery] = useState('');
  const [locationSearchResults, setLocationSearchResults] = useState<Array<{ id: string; name: string }>>([]);
  const [isSearchingLocation, setIsSearchingLocation] = useState(false);
  const [showLocationResults, setShowLocationResults] = useState(false);

  const handleSearchLocation = useCallback(async () => {
    if (!locationSearchQuery.trim() || !integrationContext?.integration?.id) return;
    setIsSearchingLocation(true);
    try {
      const res = await (
        await fetch(
          `/threads-studio/locations/search?integrationId=${integrationContext.integration.id}&query=${encodeURIComponent(locationSearchQuery.trim())}`
        )
      ).json();
      setLocationSearchResults(res?.data || []);
      setShowLocationResults(true);
    } catch {
      setLocationSearchResults([]);
    } finally {
      setIsSearchingLocation(false);
    }
  }, [fetch, locationSearchQuery, integrationContext?.integration?.id]);

  const handleSelectLocation = useCallback((loc: { id: string; name: string }) => {
    setValue('locationId', loc.id);
    setValue('locationName', loc.name);
    setShowLocationResults(false);
  }, [setValue]);

  const handleClearLocation = useCallback(() => {
    setValue('locationId', '');
    setValue('locationName', '');
  }, [setValue]);

  // Synchronize poll form value
  const handlePollOptionChange = useCallback(
    (index: number, value: string) => {
      const updated = [...pollOptions];
      updated[index] = value.slice(0, 25);
      setPollOptions(updated);
      const validOptions = updated.filter((opt) => opt.trim().length > 0);
      setValue(
        'poll',
        pollEnabled && validOptions.length >= 2
          ? { options: validOptions }
          : undefined
      );
    },
    [pollOptions, pollEnabled, setValue]
  );

  const handleAddPollOption = useCallback(() => {
    if (pollOptions.length < 4) {
      const updated = [...pollOptions, ''];
      setPollOptions(updated);
    }
  }, [pollOptions]);

  const handleRemovePollOption = useCallback(
    (index: number) => {
      if (pollOptions.length > 2) {
        const updated = pollOptions.filter((_, i) => i !== index);
        setPollOptions(updated);
        const validOptions = updated.filter((opt) => opt.trim().length > 0);
        setValue(
          'poll',
          pollEnabled && validOptions.length >= 2
            ? { options: validOptions }
            : undefined
        );
      }
    },
    [pollOptions, pollEnabled, setValue]
  );

  const togglePoll = useCallback(
    (enabled: boolean) => {
      setPollEnabled(enabled);
      if (!enabled) {
        setValue('poll', undefined);
      } else {
        const validOptions = pollOptions.filter((opt) => opt.trim().length > 0);
        setValue(
          'poll',
          validOptions.length >= 2 ? { options: validOptions } : undefined
        );
      }
    },
    [pollOptions, setValue]
  );

  // Quote post input helper (extract ID from URL if pasted)
  const handleQuotePostChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      let val = e.target.value.trim();
      const match = val.match(/threads\.net\/@[^/]+\/post\/([A-Za-z0-9_-]+)/);
      if (match && match[1]) {
        val = match[1];
      }
      setValue('quotePostId', val);
    },
    [setValue]
  );

  // Topic tag helper (auto-strip # and sanitize)
  const handleTopicTagChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      let val = e.target.value.replace(/^#+/, '').replace(/[.&]/g, '');
      if (val.length > 50) val = val.slice(0, 50);
      setValue('topicTag', val);
    },
    [setValue]
  );

  // Mutual exclusion effects
  useEffect(() => {
    if (hasMedia && isGhostPost) {
      setValue('isGhostPost', false);
    }
    if (hasMedia && pollEnabled) {
      togglePoll(false);
    }
  }, [hasMedia, isGhostPost, pollEnabled, setValue, togglePoll]);

  // Realtime validation warnings
  const validationResult = useMemo(() => {
    const validPollOptions = pollOptions.filter((o) => o.trim().length > 0);
    return ThreadsValidationRules.validate({
      message: firstPostContent,
      mediaCount,
      settings: {
        isGhostPost,
        poll:
          pollEnabled && validPollOptions.length >= 2
            ? { options: validPollOptions }
            : undefined,
        topicTag,
        locationId,
        isSpoilerMedia,
        textSpoilerRanges,
        textAttachment,
        replyControl,
        enableReplyApprovals,
        quotePostId,
        altText,
        threadInterval,
      },
    });
  }, [
    firstPostContent,
    mediaCount,
    isGhostPost,
    pollEnabled,
    pollOptions,
    topicTag,
    locationId,
    isSpoilerMedia,
    textSpoilerRanges,
    textAttachment,
    replyControl,
    enableReplyApprovals,
    quotePostId,
    altText,
    threadInterval,
  ]);

  // Active badges
  const activeBadges = useMemo(() => {
    const badges: string[] = [];
    if (isGhostPost) badges.push('👻 Ghost Post');
    if (pollEnabled && poll?.options?.length) badges.push('📊 Poll');
    if (topicTag) badges.push(`🏷️ #${topicTag}`);
    if (locationId) badges.push('📍 位置情報');
    if (isSpoilerMedia || textSpoilerRanges.length) badges.push('⚠️ Spoiler');
    if (textAttachment) badges.push('📄 長文添付');
    if (quotePostId) badges.push('💬 引用');
    if (enableReplyApprovals) badges.push('🛡️ 返信承認');
    if (replyControl !== 'everyone') badges.push('🔒 返信制限');
    return badges;
  }, [
    isGhostPost,
    pollEnabled,
    poll,
    topicTag,
    locationId,
    isSpoilerMedia,
    textSpoilerRanges,
    textAttachment,
    quotePostId,
    enableReplyApprovals,
    replyControl,
  ]);

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-newTableBorder bg-newBgColorInner/60 p-4 mb-5">
      {/* Header with expand/collapse */}
      <div
        className="flex items-center justify-between cursor-pointer select-none"
        onClick={() => setIsOpen(!isOpen)}
      >
        <div className="flex items-center gap-2">
          <span className="font-semibold text-textColor text-[15px] flex items-center gap-1.5">
            <svg
              className="w-4 h-4 fill-current text-[#7774ff]"
              viewBox="0 0 24 24"
            >
              <path d="M12.001 0C5.373 0 0 5.373 0 12s5.373 12 12.001 12c6.627 0 11.999-5.373 11.999-12S18.628 0 12.001 0zm4.27 15.65c-.488.29-1.22.5-2.07.5-1.995 0-3.35-1.12-3.37-2.825.02-1.745 1.34-2.84 3.25-2.84.77 0 1.48.19 1.95.44v.975c-.46-.26-1.13-.45-1.85-.45-1.29 0-2.18.7-2.19 1.875.01 1.155.88 1.865 2.29 1.865.7 0 1.39-.17 1.99-.44v.905z" />
            </svg>
            Threads 追加設定
          </span>
          {activeBadges.length > 0 && (
            <div className="flex flex-wrap gap-1">
              {activeBadges.map((badge) => (
                <span
                  key={badge}
                  className="rounded-full bg-[#5145ff]/20 px-2 py-0.5 text-[11px] font-medium text-[#9e9aff]"
                >
                  {badge}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="text-textItemBlur text-xs flex items-center gap-1">
          <span>{isOpen ? '閉じる' : '展開する'}</span>
          <span className={clsx('transition-transform duration-200', isOpen && 'rotate-180')}>
            ▼
          </span>
        </div>
      </div>

      {/* Realtime Validation Warning Banner */}
      {!validationResult.isValid && validationResult.errors.length > 0 && (
        <div className="rounded-lg border border-red-500/40 bg-red-500/10 p-3 text-xs text-red-300">
          <div className="font-bold flex items-center gap-1.5 mb-1 text-red-200">
            ⚠️ Threads投稿設定の競合または不整合があります
          </div>
          <ul className="list-disc pl-4 space-y-0.5">
            {validationResult.errors.map((errText: string, i: number) => (
              <li key={i}>{errText}</li>
            ))}
          </ul>
        </div>
      )}

      {isOpen && (
        <div className="mt-2 flex flex-col gap-4 border-t border-newTableBorder/50 pt-3">
          {/* 1. Ghost Post (24h Ephemeral) */}
          <div className="rounded-lg border border-newTableBorder/60 bg-newBgColorInner p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-sm flex items-center gap-1.5 text-textColor">
                  <span>👻 Ghost Post (24時間限定投稿)</span>
                  {isGhostPost && (
                    <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-300 font-bold">
                      24h AUTO-ARCHIVE
                    </span>
                  )}
                </div>
                <div className="text-xs text-textItemBlur mt-0.5">
                  投稿から24時間後にMeta公式サーバーで自動アーカイブされ非公開になります。
                </div>
              </div>
              <Slider
                value={isGhostPost ? 'on' : 'off'}
                onChange={(val) => {
                  if (hasMedia) return;
                  setValue('isGhostPost', val === 'on');
                }}
                fill={true}
              />
            </div>
            {hasMedia && (
              <div className="mt-2 text-[11px] text-amber-300/90 bg-amber-500/10 p-1.5 rounded">
                ※ メディア（画像/動画）が添付されているためGhost Postは利用できません（テキスト投稿のみ対応）。
              </div>
            )}
            {isGhostPost && (
              <div className="mt-2 text-[11px] text-purple-300 bg-purple-500/10 p-2 rounded">
                ✓ Ghost Post有効: 投稿後24時間で自動的にアーカイブされます。
              </div>
            )}
          </div>

          {/* 2. Poll (アンケート) */}
          <div className="rounded-lg border border-newTableBorder/60 bg-newBgColorInner p-3">
            <div className="flex items-center justify-between">
              <div>
                <div className="font-semibold text-sm flex items-center gap-1.5 text-textColor">
                  <span>📊 アンケート (Poll Attachment)</span>
                </div>
                <div className="text-xs text-textItemBlur mt-0.5">
                  2〜4個の選択肢を設置可能（各最大25文字・テキスト投稿専用）。
                </div>
              </div>
              <Slider
                value={pollEnabled ? 'on' : 'off'}
                onChange={(val) => {
                  if (hasMedia) return;
                  togglePoll(val === 'on');
                }}
                fill={true}
              />
            </div>

            {hasMedia && (
              <div className="mt-2 text-[11px] text-amber-300/90 bg-amber-500/10 p-1.5 rounded">
                ※ メディアが添付されているためアンケートは追加できません。
              </div>
            )}

            {pollEnabled && !hasMedia && (
              <div className="mt-3 flex flex-col gap-2">
                {pollOptions.map((opt, idx) => (
                  <div key={idx} className="flex items-center gap-2">
                    <span className="text-xs text-textItemBlur w-16">
                      選択肢 {idx + 1}:
                    </span>
                    <input
                      type="text"
                      maxLength={25}
                      className="flex-1 rounded border border-newTableBorder bg-newBgColorInner px-3 py-1.5 text-xs text-textColor outline-none focus:border-[#7774ff]"
                      placeholder={`選択肢 ${idx + 1} (最大25文字)`}
                      value={opt}
                      onChange={(e) => handlePollOptionChange(idx, e.target.value)}
                    />
                    <span
                      className={clsx(
                        'text-[10px] w-8 text-right',
                        opt.length > 20 ? 'text-amber-400 font-bold' : 'text-textItemBlur'
                      )}
                    >
                      {opt.length}/25
                    </span>
                    {pollOptions.length > 2 && (
                      <button
                        type="button"
                        className="text-textItemBlur hover:text-red-400 text-xs px-1"
                        onClick={() => handleRemovePollOption(idx)}
                      >
                        ✕
                      </button>
                    )}
                  </div>
                ))}
                {pollOptions.length < 4 && (
                  <button
                    type="button"
                    className="mt-1 self-start text-xs text-[#7774ff] hover:underline"
                    onClick={handleAddPollOption}
                  >
                    + 選択肢を追加 ({pollOptions.length}/4)
                  </button>
                )}
              </div>
            )}
          </div>

          {/* 3. Topic Tag (トピックタグ) & Location */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-textItemBlur">
                  🏷️ トピックタグ (Topic Tag)
                </label>
                <span className="text-[10px] text-textItemBlur">
                  {topicTag.length}/50
                </span>
              </div>
              <input
                type="text"
                maxLength={50}
                placeholder="例: TechTrends (記号#や.は不要)"
                value={topicTag}
                onChange={handleTopicTagChange}
                className="w-full rounded-lg border border-newTableBorder bg-newBgColorInner px-3 py-2 text-xs text-textColor outline-none focus:border-[#7774ff]"
              />
              <div className="text-[10px] text-textItemBlur mt-1">
                Threads公式トピック分類。#記号は不要、ピリオド(.)や(&)は使用できません。
              </div>
            </div>

            <div>
              <div className="flex items-center justify-between mb-1">
                <label className="text-xs font-semibold text-textItemBlur">
                  📍 位置情報 (Location)
                </label>
                {locationId && (
                  <button
                    type="button"
                    className="text-[10px] text-red-400 hover:underline"
                    onClick={handleClearLocation}
                  >
                    解除
                  </button>
                )}
              </div>

              {locationId ? (
                <div className="flex items-center justify-between rounded-lg border border-[#7774ff]/40 bg-[#7774ff]/10 px-3 py-2 text-xs text-[#9e9aff]">
                  <span className="truncate">
                    📍 {locationName || locationId}
                  </span>
                  <button
                    type="button"
                    className="text-textItemBlur hover:text-red-400 text-xs ml-2"
                    onClick={handleClearLocation}
                  >
                    ✕
                  </button>
                </div>
              ) : (
                <div className="relative">
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      placeholder="スポット名で検索（例: Shibuya, Tokyo）"
                      value={locationSearchQuery}
                      onChange={(e) => setLocationSearchQuery(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') {
                          e.preventDefault();
                          handleSearchLocation();
                        }
                      }}
                      className="flex-1 rounded-lg border border-newTableBorder bg-newBgColorInner px-3 py-2 text-xs text-textColor outline-none focus:border-[#7774ff]"
                    />
                    <button
                      type="button"
                      disabled={isSearchingLocation || !locationSearchQuery.trim()}
                      onClick={handleSearchLocation}
                      className="rounded-lg bg-[#5145ff]/20 px-2.5 py-2 text-xs font-semibold text-[#9e9aff] hover:bg-[#5145ff]/30 disabled:opacity-40"
                    >
                      {isSearchingLocation ? '...' : '検索'}
                    </button>
                  </div>

                  {showLocationResults && (
                    <div className="absolute z-20 mt-1 max-h-40 w-full overflow-y-auto rounded-lg border border-newTableBorder bg-[#1a1b26] p-1 shadow-lg">
                      {locationSearchResults.length === 0 ? (
                        <div className="p-2 text-center text-[11px] text-textItemBlur">
                          候補が見つかりませんでした
                        </div>
                      ) : (
                        locationSearchResults.map((loc) => (
                          <div
                            key={loc.id}
                            onClick={() => handleSelectLocation(loc)}
                            className="cursor-pointer rounded px-2.5 py-1.5 text-xs text-textColor hover:bg-[#5145ff]/20 flex items-center justify-between"
                          >
                            <span>{loc.name}</span>
                            <span className="text-[10px] text-textItemBlur">
                              ID: {loc.id}
                            </span>
                          </div>
                        ))
                      )}
                    </div>
                  )}
                </div>
              )}
              <div className="text-[10px] text-textItemBlur mt-1">
                Threads公式Location APIでスポットを検索してタグ付けします。
              </div>
            </div>
          </div>

          {/* 4. Reply Control & Moderation (返信制限 & 事前承認) */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3 rounded-lg border border-newTableBorder/60 bg-newBgColorInner p-3">
            <div>
              <label className="block text-xs font-semibold text-textItemBlur mb-1">
                🔒 返信できるユーザー (Reply Control)
              </label>
              <select
                className="w-full rounded-lg border border-newTableBorder bg-newBgColorInner px-3 py-2 text-xs text-textColor outline-none focus:border-[#7774ff]"
                value={replyControl}
                onChange={(e) =>
                  setValue('replyControl', e.target.value as ThreadsReplyControl)
                }
              >
                {THREADS_REPLY_CONTROL_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label} — {opt.description}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex flex-col justify-center">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-xs text-textColor">
                    🛡️ 返信の事前承認 (Reply Approvals)
                  </div>
                  <div className="text-[10px] text-textItemBlur">
                    返信を手動で承認するまで公開されません
                  </div>
                </div>
                <Slider
                  value={enableReplyApprovals ? 'on' : 'off'}
                  onChange={(val) => {
                    setValue('enableReplyApprovals', val === 'on');
                  }}
                  fill={true}
                />
              </div>
            </div>
          </div>

          {/* 5. Long-form Text Attachment (長文テキスト添付) */}
          <div className="rounded-lg border border-newTableBorder/60 bg-newBgColorInner p-3">
            <div className="flex items-center justify-between mb-1">
              <label className="text-xs font-semibold text-textColor flex items-center gap-1.5">
                <span>📄 長文テキスト添付 (Text Attachment)</span>
                <span className="text-[10px] text-textItemBlur font-normal">
                  （最大10,000文字）
                </span>
              </label>
              <span
                className={clsx(
                  'text-[10px]',
                  textAttachment.length > 9000
                    ? 'text-amber-400 font-bold'
                    : 'text-textItemBlur'
                )}
              >
                {textAttachment.length}/10,000
              </span>
            </div>
            <textarea
              rows={3}
              maxLength={10000}
              placeholder="短文フックに続く詳細解説や長文記事内容をここに添付できます（Threads長文添付機能）。"
              value={textAttachment}
              disabled={pollEnabled}
              onChange={(e) => setValue('textAttachment', e.target.value)}
              className="w-full rounded-lg border border-newTableBorder bg-newBgColorInner px-3 py-2 text-xs text-textColor outline-none focus:border-[#7774ff] disabled:opacity-50"
            />
            {pollEnabled && (
              <div className="text-[10px] text-amber-300 mt-1">
                ※ アンケート（Poll）と長文テキスト添付は併用できません。
              </div>
            )}
          </div>

          {/* 6. Spoilers & Media Controls */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {/* Media Spoiler & Alt Text */}
            <div className="rounded-lg border border-newTableBorder/60 bg-newBgColorInner p-3 flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <div>
                  <div className="font-semibold text-xs text-textColor">
                    ⚠️ メディアネタバレ警告 (Spoiler Media)
                  </div>
                  <div className="text-[10px] text-textItemBlur">
                    メディアをぼかして閲覧注意ラベルを表示
                  </div>
                </div>
                <Slider
                  value={isSpoilerMedia && hasMedia ? 'on' : 'off'}
                  onChange={(val) => {
                    if (!hasMedia) return;
                    setValue('isSpoilerMedia', val === 'on');
                  }}
                  fill={true}
                />
              </div>

              {hasMedia && (
                <div className="mt-1">
                  <label className="block text-[11px] text-textItemBlur mb-1">
                    🖼️ 画像Altテキスト (Accessibility)
                  </label>
                  <input
                    type="text"
                    maxLength={1000}
                    placeholder="画像の説明テキスト"
                    value={altText}
                    onChange={(e) => setValue('altText', e.target.value)}
                    className="w-full rounded border border-newTableBorder bg-newBgColorInner px-2.5 py-1.5 text-xs text-textColor outline-none focus:border-[#7774ff]"
                  />
                </div>
              )}
            </div>

            {/* Quote Post */}
            <div className="rounded-lg border border-newTableBorder/60 bg-newBgColorInner p-3 flex flex-col justify-between">
              <div>
                <label className="block text-xs font-semibold text-textColor mb-1">
                  💬 引用投稿 (Quote Post)
                </label>
                <input
                  type="text"
                  placeholder="引用先Threads URLまたは投稿ID"
                  value={quotePostId}
                  onChange={handleQuotePostChange}
                  className="w-full rounded-lg border border-newTableBorder bg-newBgColorInner px-3 py-2 text-xs text-textColor outline-none focus:border-[#7774ff]"
                />
                <div className="text-[10px] text-textItemBlur mt-1">
                  ThreadsのURLを貼り付けると自動的にIDを抽出します。
                </div>
              </div>
            </div>
          </div>

          {/* 7. Thread Intervals & Multi-post Settings */}
          {isThread && (
            <div className="rounded-lg border border-newTableBorder/60 bg-newBgColorInner p-3">
              <div className="flex items-center justify-between mb-2">
                <div>
                  <div className="font-semibold text-xs text-textColor">
                    ⏱️ スレッド投稿間隔 (Thread Intervals)
                  </div>
                  <div className="text-[10px] text-textItemBlur">
                    スレッドの各ツイート/投稿間の間隔を指定して自然なタイムライン露出を図ります
                  </div>
                </div>
                <select
                  className="rounded-lg border border-newTableBorder bg-newBgColorInner px-3 py-1.5 text-xs text-textColor outline-none focus:border-[#7774ff]"
                  value={threadInterval}
                  onChange={(e) =>
                    setValue('threadInterval', Number(e.target.value))
                  }
                >
                  {THREADS_THREAD_INTERVALS.map((int) => (
                    <option key={int.value} value={int.value}>
                      {int.label}
                    </option>
                  ))}
                </select>
              </div>
            </div>
          )}

          {/* 8. Existing Thread Finisher Integration */}
          <div className="mt-1">
            <ThreadFinisher />
          </div>
        </div>
      )}
    </div>
  );
};
