import {
  BadGatewayException,
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import type { ThreadsProvider } from '@gitroom/nestjs-libraries/integrations/social/threads.provider';
import { threadsProfileUsername } from '@gitroom/nestjs-libraries/integrations/social/threads-profile-username';
import type {
  ThreadsCopyMedia,
  ThreadsGraphPost,
  ThreadsPostPage,
} from '@gitroom/nestjs-libraries/integrations/social/threads-account-posts';

const PAGE_SIZE = 20;
const MAX_MEDIA_PER_POST = 20;

function threadsPermalink(value?: string | null): string | null {
  try {
    const url = new URL(value || '');
    const host = url.hostname.replace(/^www\./, '');
    return url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      !url.port &&
      ['threads.net', 'threads.com'].includes(host)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

function importableMediaUrl(value?: string): string | null {
  try {
    const url = new URL(value || '');
    // Only files returned by Threads on a Meta CDN. User-supplied URLs are never downloaded.
    if (
      url.protocol !== 'https:' ||
      url.username ||
      url.password ||
      url.port ||
      !['cdninstagram.com', 'fbcdn.net'].some((domain) =>
        url.hostname.endsWith('.' + domain)
      )
    )
      return null;
    return url.href;
  } catch {
    return null;
  }
}

function graphMedia(post: ThreadsGraphPost) {
  const carousel = post.media_type === 'CAROUSEL_ALBUM';
  const items = carousel ? post.children?.data || [] : [post];
  const media = items.filter(
    (item) => item.media_type === 'IMAGE' || item.media_type === 'VIDEO'
  );
  const count = carousel ? items.length || 1 : media.length;
  const urls = media.flatMap((item) => {
    const url = importableMediaUrl(item.media_url);
    return url ? [url] : [];
  });
  return {
    count,
    urls,
    unavailable:
      Boolean(post.children?.paging?.next) ||
      urls.length !== count ||
      count > MAX_MEDIA_PER_POST,
  };
}

@Injectable()
export class ThreadsPostReuseService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrations: IntegrationManager,
    private readonly media: MediaService
  ) {}

  async list(
    orgId: string,
    integrationId: string,
    username?: string,
    cursor?: string
  ): Promise<ThreadsPostPage> {
    const page = await this.graphPage(orgId, integrationId, username, cursor);
    return {
      posts: page.posts.map((post) => {
        const { count, unavailable } = graphMedia(post);
        return {
          id: post.id,
          text: post.text || '',
          username: post.username || page.username,
          timestamp: post.timestamp || null,
          permalink: threadsPermalink(post.permalink),
          mediaType: post.media_type || 'TEXT_POST',
          mediaCount: count,
          mediaUnavailable: unavailable,
        };
      }),
      nextCursor: page.nextCursor,
    };
  }

  async importMedia(
    orgId: string,
    integrationId: string,
    input: {
      username?: string;
      cursor?: string;
      postId?: string;
      confirmedRights?: boolean;
    }
  ) {
    if (
      input.confirmedRights !== true ||
      typeof input.postId !== 'string' ||
      !input.postId ||
      input.postId.length > 128
    ) {
      throw new BadRequestException(
        '再利用できる素材であることを確認し、投稿を選択してください。'
      );
    }
    const page = await this.graphPage(
      orgId,
      integrationId,
      input.username,
      input.cursor
    );
    const post = page.posts.find((item) => item.id === input.postId);
    if (!post)
      throw new NotFoundException(
        'この一覧に投稿がありません。投稿を取得し直してください。'
      );
    const { count, urls, unavailable } = graphMedia(post);
    if (!count || unavailable) {
      throw new BadRequestException(
        '添付を一括取得できません。本文をコピーして使用できる素材を追加してください。'
      );
    }
    const media: ThreadsCopyMedia[] = [];
    let failed = 0;
    // Preserve carousel order and keep memory usage bounded by the existing streaming uploader.
    const signal = AbortSignal.timeout(90_000);
    for (const url of urls) {
      try {
        const item = await this.media.uploadFromUrl(orgId, url, {
          signal,
          redirect: 'error',
        });
        media.push({ id: item.id, path: item.path });
      } catch {
        failed++;
      }
    }
    return { media, failed };
  }

  private async getIntegration(orgId: string, integrationId: string) {
    if (!integrationId)
      throw new BadRequestException(
        '取得に使うThreadsアカウントを選んでください。'
      );
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: integrationId,
        organizationId: orgId,
        providerIdentifier: 'threads',
        deletedAt: null,
      },
      select: {
        internalId: true,
        token: true,
        disabled: true,
        inBetweenSteps: true,
        refreshNeeded: true,
      },
    });
    if (!integration)
      throw new NotFoundException('Threadsアカウントが見つかりません。');
    return integration;
  }

  private async graphPage(
    orgId: string,
    integrationId: string,
    username?: string,
    cursor?: string
  ) {
    const handle = threadsProfileUsername(username);
    if (!handle) {
      throw new BadRequestException(
        '公開Threadsアカウントのユーザー名またはプロフィールURLを入力してください。'
      );
    }
    if (
      cursor !== undefined &&
      (typeof cursor !== 'string' || cursor.length > 2048)
    ) {
      throw new BadRequestException(
        '取得位置が無効です。一覧を取得し直してください。'
      );
    }
    const integration = await this.getIntegration(orgId, integrationId);
    // Browser integrations use an alias/synthetic ID; they cannot authorize Graph reads.
    if (
      !integration.token ||
      !/^\d+$/.test(integration.internalId) ||
      integration.disabled ||
      integration.inBetweenSteps ||
      integration.refreshNeeded
    ) {
      throw new BadRequestException(
        '取得には公式APIで接続済みのThreadsアカウントが必要です。'
      );
    }
    const provider = this.integrations.getSocialIntegration(
      'threads'
    ) as ThreadsProvider;
    try {
      const page = await provider.fetchPublicProfilePosts(integration.token, {
        username: handle,
        after: cursor,
        limit: PAGE_SIZE,
      });
      return {
        ...page,
        posts: page.posts.filter(
          (post) =>
            !post.username ||
            post.username.toLowerCase() === handle.toLowerCase()
        ),
        username: handle,
      };
    } catch {
      throw new BadGatewayException(
        '公開投稿を取得できませんでした。公開プロフィールであることと、接続に threads_profile_discovery 権限が付与されていることを確認してください。'
      );
    }
  }
}
