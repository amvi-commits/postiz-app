'use client';

import { useEffect, useRef, useState, type FormEvent } from 'react';
import dayjs from 'dayjs';
import { threadsProfileUsername } from '@gitroom/nestjs-libraries/integrations/social/threads-profile-username';
import type {
  ThreadsCopyMedia,
  ThreadsPostPage,
  ThreadsReusablePost,
} from '@gitroom/nestjs-libraries/integrations/social/threads-account-posts';
import { softenThreadsEnding } from './threads-copy-text';

type SourceAccount = { id: string; name?: string; profile?: string };
type Search = { integrationId: string; username: string };
type Result = { search: Search; cursor?: string; page: ThreadsPostPage };
type CopyInput = { text: string; media: ThreadsCopyMedia[] };

const button =
  'rounded-lg border border-blockSeparator px-3 py-2 text-sm font-semibold hover:bg-boxFocused disabled:opacity-45';
const primary =
  'rounded-lg bg-[#5145ff] px-4 py-2 text-sm font-semibold text-white disabled:opacity-45';
const field =
  'rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2 text-newTextColor';

const mediaLabels: Record<string, string> = {
  TEXT_POST: 'テキスト',
  IMAGE: '画像',
  VIDEO: '動画',
  CAROUSEL_ALBUM: '複数の添付',
  MEDIA: '添付あり',
};

export function ThreadsAccountPosts({
  accounts,
  initialAccountId,
  accountsError,
  accountsLoading,
  request,
  onCopy,
}: {
  accounts: SourceAccount[];
  initialAccountId: string;
  accountsError: boolean;
  accountsLoading: boolean;
  request: (path: string, init?: RequestInit) => Promise<any>;
  onCopy: (copy: CopyInput) => void;
}) {
  const [integrationId, setIntegrationId] = useState(initialAccountId);
  const [username, setUsername] = useState('');
  const [result, setResult] = useState<Result | null>(null);
  const [selected, setSelected] = useState<ThreadsReusablePost | null>(null);
  const [text, setText] = useState('');
  const [includeMedia, setIncludeMedia] = useState(false);
  const [confirmedRights, setConfirmedRights] = useState(false);
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState('');
  const [imported, setImported] = useState<ThreadsCopyMedia[] | null>(null);
  const [failedImports, setFailedImports] = useState(0);
  const active = useRef(false);
  const pending = useRef(false);
  const copyEditor = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);

  useEffect(() => {
    if (selected) copyEditor.current?.focus();
  }, [selected]);

  const clearSelection = () => {
    setSelected(null);
    setImported(null);
    setNotice('');
  };

  const run = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true;
    setWorking(true);
    setNotice('');
    try {
      await action();
    } catch (error) {
      if (active.current)
        setNotice(
          error instanceof Error ? error.message : '処理に失敗しました。'
        );
    } finally {
      pending.current = false;
      if (active.current) setWorking(false);
    }
  };

  const fetchPage = (search: Search, cursor?: string) =>
    run(async () => {
      clearSelection();
      const query = new URLSearchParams({ username: search.username });
      if (cursor) query.set('cursor', cursor);
      const page = (await request(
        `/threads-studio/accounts/${encodeURIComponent(
          search.integrationId
        )}/posts?${query}`
      )) as ThreadsPostPage;
      if (active.current) setResult({ search, cursor, page });
    });

  const searchPosts = (event: FormEvent) => {
    event.preventDefault();
    if (!integrationId || !username.trim() || pending.current) return;
    const handle = threadsProfileUsername(username);
    if (!handle) {
      setNotice(
        'ThreadsのプロフィールURLまたは @ユーザー名を入力してください。'
      );
      return;
    }
    setResult(null);
    void fetchPage({ integrationId, username: handle });
  };

  const select = (post: ThreadsReusablePost) => {
    setSelected(post);
    setText(post.text);
    setIncludeMedia(post.mediaCount > 0 && !post.mediaUnavailable);
    setConfirmedRights(false);
    setImported(null);
    setFailedImports(0);
    setNotice('');
  };

  const prepareCopy = () => {
    if (!selected || !result || !confirmedRights) return;
    void run(async () => {
      let media = includeMedia ? imported || [] : [];
      if (includeMedia && !imported) {
        const payload = await request(
          `/threads-studio/accounts/${encodeURIComponent(
            result.search.integrationId
          )}/import-post-media`,
          {
            method: 'POST',
            body: JSON.stringify({
              username: result.search.username,
              cursor: result.cursor,
              postId: selected.id,
              confirmedRights: true,
            }),
          }
        );
        if (!active.current) return;
        media = payload.media;
        setImported(media);
        setFailedImports(payload.failed);
        if (payload.failed) {
          setNotice(
            `添付 ${payload.failed} 件を取り込めませんでした。取得できた添付だけで続けるか、投稿作成で素材を追加できます。`
          );
          return;
        }
      }
      if (!text.trim() && !media.length) {
        setNotice('本文を入力するか、利用できる添付を選んでください。');
        return;
      }
      if (active.current) onCopy({ text: text.trim(), media });
    });
  };

  const mediaOptionAvailable =
    selected && selected.mediaCount > 0 && !selected.mediaUnavailable;

  return (
    <section className="grid gap-5 rounded-xl border border-blockSeparator bg-newBgColorInner p-5">
      <h2 className="text-lg font-bold">公開アカウントの投稿取得・コピー</h2>
      <form onSubmit={searchPosts} className="grid gap-3 md:grid-cols-2">
        <label className="grid gap-1 text-sm">
          API認証に使う接続アカウント
          <select
            className={field}
            disabled={working}
            value={integrationId}
            onChange={(event) => {
              setIntegrationId(event.target.value);
              setResult(null);
              clearSelection();
            }}
          >
            <option value="">アカウントを選択</option>
            {accounts.map((account) => (
              <option key={account.id} value={account.id}>
                {account.profile
                  ? `@${account.profile.replace(/^@/, '')}`
                  : account.name || account.id}
              </option>
            ))}
          </select>
        </label>
        <label className="grid gap-1 text-sm">
          取得する公開アカウント
          <input
            className={field}
            placeholder="@ユーザー名 またはプロフィールURL"
            maxLength={512}
            value={username}
            disabled={working}
            onChange={(event) => {
              setUsername(event.target.value);
              setResult(null);
              clearSelection();
            }}
          />
        </label>
        <div className="self-end">
          <button
            type="submit"
            className={primary}
            disabled={
              working ||
              !accounts.some((account) => account.id === integrationId) ||
              !username.trim()
            }
          >
            投稿を取得
          </button>
        </div>
      </form>
      {accountsError && (
        <p role="alert">接続アカウント一覧の取得に失敗しました。</p>
      )}
      {accountsLoading && (
        <p role="status" className="text-sm">
          接続アカウントを取得中…
        </p>
      )}
      {!accounts.length && !accountsError && !accountsLoading && (
        <p className="text-sm text-textItemBlur">
          公式APIで接続済みのThreadsアカウントが必要です。
        </p>
      )}
      <p className="text-sm text-textItemBlur">
        指定した公開プロフィールの投稿を取得します。API認証に使う接続には Meta
        の threads_profile_discovery 権限が必要です。
      </p>
      {working && (
        <p role="status" className="text-sm">
          処理中…
        </p>
      )}
      {result && (
        <div className="grid gap-2">
          <h3 className="text-sm font-semibold">取得結果</h3>
          {!result.page.posts.length && (
            <p className="text-sm text-textItemBlur">
              該当する投稿がありません。
            </p>
          )}
          {result.page.posts.map((post) => (
            <article
              key={post.id}
              className="grid gap-2 rounded-lg border border-blockSeparator p-3"
            >
              <div className="flex flex-wrap gap-3 text-sm text-textItemBlur">
                <span>@{post.username.replace(/^@/, '')}</span>
                {post.timestamp && (
                  <span>
                    {dayjs(post.timestamp).format('YYYY/MM/DD HH:mm')}
                  </span>
                )}
                <span>
                  {mediaLabels[post.mediaType] || post.mediaType}
                  {post.mediaCount > 0 && ` · ${post.mediaCount}件`}
                </span>
                {post.permalink && (
                  <a
                    href={post.permalink}
                    target="_blank"
                    rel="noreferrer"
                    className="underline"
                  >
                    元の投稿
                  </a>
                )}
              </div>
              {post.text && (
                <p className="line-clamp-4 whitespace-pre-wrap break-words text-sm">
                  {post.text}
                </p>
              )}
              <div>
                <button
                  type="button"
                  className={button}
                  disabled={working}
                  onClick={() => select(post)}
                >
                  コピーして編集
                </button>
              </div>
            </article>
          ))}
          {result.page.nextCursor && (
            <div>
              <button
                type="button"
                className={button}
                disabled={working}
                onClick={() =>
                  void fetchPage(
                    result.search,
                    result.page.nextCursor || undefined
                  )
                }
              >
                次の投稿を取得
              </button>
            </div>
          )}
        </div>
      )}
      {selected && (
        <section className="grid gap-3 rounded-lg border border-blockSeparator p-4">
          <h3 className="font-semibold">投稿をコピー</h3>
          <details>
            <summary>元の本文を表示</summary>
            <p className="mt-2 whitespace-pre-wrap break-words text-sm">
              {selected.text || '本文なし'}
            </p>
          </details>
          <label className="grid gap-1 text-sm">
            コピー先の本文
            <textarea
              ref={copyEditor}
              className={field}
              rows={5}
              disabled={working}
              value={text}
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          {selected.text && (
            <div>
              <button
                type="button"
                className={button}
                disabled={working || !text.trim()}
                onClick={() => {
                  const edited = softenThreadsEnding(text);
                  setText(edited);
                  setNotice(
                    edited === text
                      ? '調整できる語尾が見つかりませんでした。本文は直接編集できます。'
                      : '語尾を調整しました。本文を確認してください。'
                  );
                }}
              >
                語尾をやわらかく
              </button>
            </div>
          )}
          {selected.mediaCount > 0 && (
            <label className="flex gap-2 text-sm">
              <input
                type="checkbox"
                checked={includeMedia}
                disabled={working || !mediaOptionAvailable}
                onChange={(event) => setIncludeMedia(event.target.checked)}
              />
              画像・動画を引き継ぐ（{selected.mediaCount}件）
            </label>
          )}
          {selected.mediaUnavailable && (
            <p className="text-sm text-textItemBlur">
              一部またはすべての添付を取得できません。投稿作成で素材を追加できます。
            </p>
          )}
          <label className="flex gap-2 text-sm">
            <input
              type="checkbox"
              checked={confirmedRights}
              disabled={working}
              onChange={(event) => setConfirmedRights(event.target.checked)}
            />
            本文と使用する素材の再利用権限を確認しました
          </label>
          <div>
            <button
              type="button"
              className={primary}
              disabled={
                working ||
                !confirmedRights ||
                (!text.trim() && (!includeMedia || imported?.length === 0))
              }
              onClick={prepareCopy}
            >
              {failedImports && includeMedia
                ? '取得できた内容で投稿作成へ'
                : '投稿作成で開く'}
            </button>
          </div>
        </section>
      )}
      {notice && (
        <p role="status" className="text-sm">
          {notice}
        </p>
      )}
    </section>
  );
}
