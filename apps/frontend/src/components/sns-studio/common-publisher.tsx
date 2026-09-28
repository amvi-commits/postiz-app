'use client';

import { CalendarWeekProvider } from '@gitroom/frontend/components/launches/calendar.context';
import { useIntegrationList } from '@gitroom/frontend/components/launches/helpers/use.integration.list';
import { NewPost } from '@gitroom/frontend/components/launches/new.post';
import { LoadingComponent } from '@gitroom/frontend/components/layout/loading';

const card =
  'rounded-xl border border-blockSeparator bg-newBgColorInner p-5';

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

export type CommonPublishPrefill = {
  content?: string;
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
  const { data: integrations = [], isLoading, error } = useIntegrationList();

  if (isLoading) {
    return (
      <div className="flex min-h-[240px] items-center justify-center">
        <LoadingComponent />
      </div>
    );
  }

  const destinations = integrations.filter(
    (integration) =>
      supportedIdentifiers.has(integration.identifier) &&
      !integration.disabled &&
      !integration.inBetweenSteps
  );

  const platforms = Array.from(
    new Set(destinations.map((integration) => platformName(integration.identifier)))
  );

  return (
    <section className="grid gap-5">
      <div className={card}>
        <div className="flex flex-col gap-2">
          <h2 className="text-xl font-bold">共通投稿・配信</h2>
          <p className="text-sm text-textItemBlur">
            1つの投稿作成フローから複数SNS・複数アカウントを選択し、本文・メディア・SNS固有設定・下書き・即時投稿・予約投稿を設定します。
          </p>
          <p className="text-sm text-textItemBlur">
            配信処理は既存のSNS連携と投稿ワークフローを再利用します。SNS Studio側に各SNSの投稿処理を重複実装しません。
          </p>
        </div>
      </div>

      <div className={card}>
        <div className="mb-4 flex flex-col gap-1">
          <h3 className="font-semibold">配信先</h3>
          {error ? (
            <p className="text-sm text-red-500">
              接続済みアカウントを取得できませんでした。
            </p>
          ) : destinations.length ? (
            <>
              <p className="text-sm text-textItemBlur">
                {destinations.length}アカウント接続済み
                {platforms.length ? `（${platforms.join(' / ')}）` : ''}
              </p>
              <p className="text-xs text-textItemBlur">
                投稿画面内で複数アカウントを同時選択できます。共通本文を基本値として、選択したアカウントごとに本文・メディア・SNS固有設定を上書きできます。
              </p>
            </>
          ) : (
            <p className="text-sm text-textItemBlur">
              対応SNSの接続済みアカウントがありません。先にSNSアカウントを接続してください。
            </p>
          )}
        </div>

        {prefill && (
          <div className="mb-4 rounded-lg border border-blockSeparator p-3 text-sm">
            <div className="font-semibold">SNS Studio素材を引き継ぎます</div>
            <div className="mt-1 break-all text-xs text-textItemBlur">
              {prefill.media.path}
            </div>
          </div>
        )}

        {destinations.length > 0 && (
          <CalendarWeekProvider integrations={destinations}>
            <div className="max-w-[320px]">
              <NewPost
                label={prefill ? 'この素材で共通投稿を作成' : undefined}
                onlyValues={
                  prefill
                    ? [
                        {
                          content: prefill.content || '',
                          image: [prefill.media],
                        },
                      ]
                    : undefined
                }
              />
            </div>
          </CalendarWeekProvider>
        )}
      </div>

      <div className={card}>
        <h3 className="mb-2 font-semibold">現在この共通画面で再利用している機能</h3>
        <div className="grid gap-2 text-sm text-textItemBlur md:grid-cols-2">
          <div>・複数SNS / 複数アカウント選択</div>
          <div>・共通本文 / アカウント別上書き</div>
          <div>・共通メディア選択 / アカウント別上書き</div>
          <div>・SNS固有設定とプレビュー</div>
          <div>・下書き保存 / 即時投稿 / 予約投稿</div>
          <div>・投稿前のSNS別サーバー検証</div>
        </div>
        <p className="mt-3 text-xs text-textItemBlur">
          SNS Studioの加工済み素材をこの投稿画面へ直接引き継ぐ処理、SNS単位・アカウント単位の投稿時刻上書き、承認ポリシーは次の共通基盤フェーズで接続します。
        </p>
      </div>
    </section>
  );
};
