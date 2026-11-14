'use client';

import { ReactNode, useState, useEffect } from 'react';
import dayjs from 'dayjs';

const button =
  'rounded-lg border border-blockSeparator px-4 py-2 font-semibold disabled:opacity-50 disabled:cursor-not-allowed';

// Presentation only. ManageModal still owns provider validation, preflight and
// Postiz submission; neither single-SNS screens nor this layout send posts.
export function InlinePostLayout(props: {
  scope: string;
  title: string;
  editor: ReactNode;
  settings: ReactNode;
  preview: ReactNode;
  locked: boolean;
  mediaProcessing?: boolean;
  busy: boolean;
  blockedReason?: string | null;
  date: dayjs.Dayjs;
  onDateChange: (date: dayjs.Dayjs) => void;
  onAction: (type: 'draft' | 'now' | 'schedule') => void;
  status?: string;
  accountNames: Record<string, string>;
  confirmation?: {
    type: 'now' | 'schedule';
    posts: any[];
    date: string;
    accept: () => void;
    cancel: () => void;
  } | null;
}) {
  const confirmation = props.confirmation;
  const dateValue = props.date.tz('Asia/Tokyo').format('YYYY-MM-DDTHH:mm');
  const [dateInput, setDateInput] = useState(dateValue);
  const [dateError, setDateError] = useState('');
  useEffect(() => {
    setDateInput(dateValue);
    setDateError('');
  }, [dateValue]);
  return (
    <section data-launch-editor-scope={props.scope}
      className="grid gap-4"
      aria-label={props.title}
      aria-busy={props.busy}
    >
      <div className="grid gap-5 xl:grid-cols-[minmax(0,1fr)_minmax(280px,420px)]">
        <div className="min-w-0 rounded-xl border border-blockSeparator bg-newBgColorInner p-5">
          <h2 className="text-lg font-bold">{props.title}</h2>
          <div inert={props.busy ? true : undefined}>
            <h3 className="mb-2 mt-5 text-sm font-semibold">
              投稿本文・画像／動画
            </h3>
            <div id="social-content" className="min-h-64">
              {props.editor}
            </div>
            <div id="social-empty" />
            <details
              id="wrapper-settings"
              className="mt-4 rounded-lg border border-blockSeparator p-3"
            >
              <summary className="cursor-pointer text-sm font-semibold">
                詳細設定
              </summary>
              <div id="social-settings" className="mt-3">
                {props.settings}
              </div>
            </details>
          </div>
        </div>
        <aside className="min-w-0 rounded-xl border border-blockSeparator bg-newBgColorInner p-5">
          <h3 className="mb-3 font-semibold">プレビュー</h3>
          {props.preview}
        </aside>
      </div>
      <div className="rounded-xl border border-blockSeparator bg-newBgColorInner p-5">
        <label className="grid max-w-sm gap-2 text-sm">
          <span>予約日時（日本時間）</span>
          <input
            type="datetime-local"
            disabled={props.busy}
            value={dateInput}
            className="rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2"
            onChange={(event) => {
              const value = event.target.value;
              setDateInput(value);
              setDateError('予約日時を正しく入力してください。');
              if (/^\d{4}-\d\d-\d\dT\d\d:\d\d$/.test(value)) {
                const next = dayjs.tz(value, 'Asia/Tokyo');
                if (
                  next.isValid() &&
                  next.format('YYYY-MM-DDTHH:mm') === value
                ) {
                  setDateError('');
                  props.onDateChange(next);
                }
              }
            }}
          />
        </label>
        {dateError && (
          <p className="mt-2 text-sm text-amber-200" role="alert">
            {dateError}
          </p>
        )}
        {props.blockedReason && (
          <p className="mt-3 text-sm text-amber-200" role="note">
            {props.blockedReason}
          </p>
        )}
        <div className="mt-4 flex flex-wrap gap-3">
          <button
            className={button}
            disabled={props.locked || props.busy}
            onClick={() => props.onAction('draft')}
          >
            下書き保存
          </button>
          <button
            className={button}
            disabled={props.locked || props.busy || !!dateError}
            onClick={() => props.onAction('schedule')}
          >
            予約する
          </button>
          <button
            className={`${button} bg-[#5145ff] text-white`}
            disabled={props.locked || props.busy}
            onClick={() => props.onAction('now')}
          >
            今すぐ投稿
          </button>
        </div>
        {props.status && (
          <p className="mt-3 text-sm" role="status">
            {props.status}
          </p>
        )}
      </div>
      {confirmation && (
        <section
          role="dialog"
          aria-modal="true"
          aria-label="投稿内容の最終確認"
          className="rounded-xl border border-[#7774ff] bg-newBgColorInner p-5"
        >
          <h3 className="font-semibold">
            {confirmation.type === 'now'
              ? '今すぐ投稿の確認'
              : '予約内容の確認'}
          </h3>
          <p className="mt-2 text-sm">
            {confirmation.type === 'now'
              ? '投稿を受け付けた後、公開結果を履歴で確認します。'
              : `${dayjs
                  .utc(confirmation.date)
                  .tz('Asia/Tokyo')
                  .format('YYYY/MM/DD HH:mm')}（日本時間）`}
          </p>
          {confirmation.posts.map((post) => (
            <div
              key={post.integration.id}
              className="mt-3 rounded-lg border border-blockSeparator p-3"
            >
              <div className="text-sm font-semibold">
                {props.accountNames[post.integration.id]}
              </div>
              {post.value.map((value: any, index: number) => (
                <div key={index}>
                  <p className="mt-2 whitespace-pre-wrap">
                    {value.content.replace(/<[^>]+>/g, '')}
                  </p>
                  <p className="text-sm text-textItemBlur">
                    添付: {value.image?.length || 0}件
                  </p>
                </div>
              ))}
            </div>
          ))}
          {props.blockedReason && (
            <p className="mt-3 text-sm text-amber-200">{props.blockedReason}</p>
          )}
          <div className="mt-4 flex gap-3">
            <button className={button} onClick={confirmation.cancel}>
              編集に戻る
            </button>
            <button
              className={`${button} bg-[#5145ff] text-white`}
              disabled={!!props.blockedReason}
              onClick={confirmation.accept}
            >
              {confirmation.type === 'now'
                ? '内容を確認して投稿する'
                : 'この日時で予約する'}
            </button>
          </div>
        </section>
      )}
      {props.mediaProcessing && <p role="status" className="mt-3 text-sm">添付の処理または入力の確認が必要なため、保存・送信できません。</p>}
    </section>
  );
}
