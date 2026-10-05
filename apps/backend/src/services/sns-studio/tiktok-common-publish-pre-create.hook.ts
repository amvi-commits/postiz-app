import { BadRequestException, Injectable } from '@nestjs/common';
import { TikTokDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';
import { TikTokPublishAdapter } from './tiktok-publish.adapter';
import { TikTokPublishGuard } from './tiktok-publish.guard';
import {
  ProviderPublishPreCreateContext,
  ProviderPublishPreCreateHook,
} from '../posts/provider-publish-pre-create-protection.service';

@Injectable()
export class TikTokCommonPublishPreCreateHook
  implements ProviderPublishPreCreateHook
{
  readonly providerIdentifier = 'tiktok';

  constructor(
    private readonly tiktokPublishAdapter: TikTokPublishAdapter,
    private readonly tiktokPublishGuard: TikTokPublishGuard
  ) {}

  async protect<T>(
    context: ProviderPublishPreCreateContext,
    recheckCommonPolicy: (posts: ProviderPublishPreCreateContext['posts']) => Promise<void>,
    createPost: () => Promise<T>
  ): Promise<T> {
    if (context.type !== 'now' && context.type !== 'schedule') {
      return createPost();
    }

    const protectedPosts = context.posts.filter((post) => {
      const settings = post.settings as Partial<TikTokDto> | undefined;
      return settings?.content_posting_method !== 'UPLOAD';
    });
    if (!protectedPosts.length) return createPost();

    const integrationIds = Array.from(
      new Set(protectedPosts.map((post) => post.integration.id))
    );

    return this.tiktokPublishGuard.withIntegrationLocks(
      context.organizationId,
      integrationIds,
      async () => {
        await recheckCommonPolicy(protectedPosts);

        for (const post of protectedPosts) {
          const value = post.value[0];
          const media = (value?.image || []).map((item) => ({
            id: item.id,
            path: item.path,
            thumbnail: item.thumbnail,
          }));
          const preflight = await this.tiktokPublishAdapter.preflight(
            context.organizationId,
            {
              integrationId: post.integration.id,
              content: value?.content || '',
              media,
              settings: post.settings as Partial<TikTokDto>,
              publishDate: context.publishDate,
              // A scheduled post is still a publish attempt; preflight the same
              // provider settings and duplicate window used by an immediate post.
              mode: 'now',
            }
          );

          if (preflight.providerIdentifier !== 'tiktok') {
            throw new BadRequestException({ code: 'TIKTOK_INVALID_PROVIDER' });
          }

          // PostsService must persist the resolved settings that were checked.
          post.settings = preflight.resolvedSettings as any;
        }

        return createPost();
      }
    );
  }
}
