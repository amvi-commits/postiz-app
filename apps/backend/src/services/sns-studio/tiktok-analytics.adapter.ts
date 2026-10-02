import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Organization, State } from '@prisma/client';
import { IntegrationService } from '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

type TikTokAccountMetrics = {
  followers: number | null;
  following: number | null;
  totalLikes: number | null;
  videos: number | null;
  recentViews: number | null;
  recentLikes: number | null;
  recentComments: number | null;
  recentShares: number | null;
};

type TikTokPostMetrics = {
  views: number | null;
  likes: number | null;
  comments: number | null;
  shares: number | null;
};

type TikTokProviderIdentifier = 'tiktok' | 'tiktok-business';

const TIKTOK_PROVIDER_IDENTIFIERS: TikTokProviderIdentifier[] = [
  'tiktok',
  'tiktok-business',
];

/**
 * Resolve the Postiz analytics cache key as epoch milliseconds. A missing date
 * uses UTC midnight so requests on the same UTC day share Postiz's existing
 * Redis cache entry.
 */
export function resolveTikTokAnalyticsDate(
  date?: string,
  now: Date = new Date()
): number {
  if (date === undefined) {
    return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
  }

  if (!/^\d+(?:\.\d+)?$/.test(date)) {
    throw new BadRequestException({
      code: 'TIKTOK_INVALID_ANALYTICS_DATE',
      message: 'date must be a non-negative numeric timestamp.',
    });
  }

  const numericDate = Number(date);
  if (!Number.isFinite(numericDate) || numericDate < 0) {
    throw new BadRequestException({
      code: 'TIKTOK_INVALID_ANALYTICS_DATE',
      message: 'date must be a non-negative numeric timestamp.',
    });
  }

  return numericDate;
}

function metricValue(raw: unknown): number | null {
  if (typeof raw === 'number') {
    return Number.isFinite(raw) ? raw : null;
  }
  if (typeof raw !== 'string' || raw.trim() === '') {
    return null;
  }

  const normalized = raw.trim();
  if (!/^-?(?:\d+(?:\.\d*)?|\.\d+)$/.test(normalized)) {
    return null;
  }

  const value = Number(normalized);
  return Number.isFinite(value) ? value : null;
}

function metricForLabel(
  analytics: AnalyticsData[],
  label: string
): number | null {
  const entry = analytics.find((item) => item?.label === label);
  if (!entry || !Array.isArray(entry.data) || entry.data.length === 0) {
    return null;
  }

  return metricValue(entry.data[0]?.total);
}

function normalizeAccountMetrics(analytics: AnalyticsData[]): TikTokAccountMetrics {
  return {
    followers: metricForLabel(analytics, 'Followers'),
    following: metricForLabel(analytics, 'Following'),
    totalLikes: metricForLabel(analytics, 'Total Likes'),
    videos: metricForLabel(analytics, 'Videos'),
    recentViews: metricForLabel(analytics, 'Views'),
    recentLikes: metricForLabel(analytics, 'Recent Likes'),
    recentComments: metricForLabel(analytics, 'Recent Comments'),
    recentShares: metricForLabel(analytics, 'Recent Shares'),
  };
}

function normalizePostMetrics(analytics: AnalyticsData[]): TikTokPostMetrics {
  return {
    views: metricForLabel(analytics, 'Views'),
    likes: metricForLabel(analytics, 'Likes'),
    comments: metricForLabel(analytics, 'Comments'),
    shares: metricForLabel(analytics, 'Shares'),
  };
}

function isTikTokProvider(value: string): value is TikTokProviderIdentifier {
  return TIKTOK_PROVIDER_IDENTIFIERS.includes(value as TikTokProviderIdentifier);
}

@Injectable()
export class TikTokAnalyticsAdapter {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationService: IntegrationService,
    private readonly postsService: PostsService
  ) {}

  async getAccountAnalytics(
    organization: Organization,
    integrationId: string,
    date?: string
  ) {
    const dateKey = resolveTikTokAnalyticsDate(date);
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: integrationId,
        organizationId: organization.id,
        deletedAt: null,
      },
      select: {
        id: true,
        providerIdentifier: true,
      },
    });

    if (!integration) {
      throw new NotFoundException({ code: 'TIKTOK_INTEGRATION_NOT_FOUND' });
    }
    if (!isTikTokProvider(integration.providerIdentifier)) {
      throw new BadRequestException({ code: 'TIKTOK_INTEGRATION_NOT_TIKTOK' });
    }

    const accountType =
      integration.providerIdentifier === 'tiktok-business' ? 'business' : 'personal';
    const responseBase = {
      integrationId: integration.id,
      platform: 'tiktok' as const,
      providerIdentifier: integration.providerIdentifier,
      accountType,
    };

    try {
      const analytics = await this.integrationService.checkAnalytics(
        organization,
        integration.id,
        String(dateKey)
      );
      const capturedAt = new Date().toISOString();

      if (!Array.isArray(analytics) || analytics.length === 0) {
        return {
          status: 'unavailable' as const,
          ...responseBase,
          capturedAt,
          metrics: null,
          errorCode: 'TIKTOK_ANALYTICS_UNAVAILABLE',
        };
      }

      return {
        status: 'available' as const,
        ...responseBase,
        capturedAt,
        metrics: normalizeAccountMetrics(analytics),
      };
    } catch {
      return {
        status: 'error' as const,
        ...responseBase,
        capturedAt: new Date().toISOString(),
        metrics: null,
        errorCode: 'TIKTOK_ANALYTICS_ERROR',
        errorMessage: 'TikTok account analytics could not be retrieved.',
      };
    }
  }

  async getPostAnalytics(
    organization: Organization,
    postId: string,
    date?: string
  ) {
    const dateKey = resolveTikTokAnalyticsDate(date);
    const post = await this.prisma.post.findFirst({
      where: {
        id: postId,
        organizationId: organization.id,
        deletedAt: null,
      },
      select: {
        id: true,
        state: true,
        error: true,
        releaseId: true,
        releaseURL: true,
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
      },
    });

    if (!post) {
      throw new NotFoundException({ code: 'TIKTOK_POST_NOT_FOUND' });
    }

    const providerIdentifier = post.integration?.providerIdentifier;
    if (!providerIdentifier || !isTikTokProvider(providerIdentifier)) {
      throw new BadRequestException({ code: 'TIKTOK_POST_NOT_TIKTOK' });
    }

    const responseBase = {
      postId: post.id,
      postState: post.state,
      platform: 'tiktok' as const,
      providerIdentifier,
      ...(post.releaseURL ? { releaseURL: post.releaseURL } : {}),
    };

    if (post.state === State.DRAFT) {
      return { status: 'draft' as const, ...responseBase, metrics: null };
    }
    if (post.state === State.QUEUE) {
      return { status: 'pending' as const, ...responseBase, metrics: null };
    }
    if (post.state === State.ERROR) {
      return {
        status: 'error' as const,
        ...responseBase,
        errorCode: 'TIKTOK_POST_ERROR',
        errorMessage: post.error,
        metrics: null,
      };
    }
    if (post.state !== State.PUBLISHED) {
      return { status: 'pending' as const, ...responseBase, metrics: null };
    }
    if (!post.releaseId) {
      return {
        status: 'pending' as const,
        ...responseBase,
        errorCode: 'TIKTOK_RELEASE_ID_PENDING',
        metrics: null,
      };
    }

    try {
      const analytics = await this.postsService.checkPostAnalytics(
        organization.id,
        post.id,
        dateKey
      );

      if (!Array.isArray(analytics)) {
        if (analytics?.missing === true) {
          return {
            status: 'missing' as const,
            ...responseBase,
            errorCode: 'TIKTOK_POST_MISSING',
            metrics: null,
          };
        }

        return {
          status: 'unavailable' as const,
          ...responseBase,
          errorCode: 'TIKTOK_POST_ANALYTICS_UNAVAILABLE',
          metrics: null,
        };
      }

      if (analytics.length === 0) {
        return {
          status: 'unavailable' as const,
          ...responseBase,
          errorCode: 'TIKTOK_POST_ANALYTICS_UNAVAILABLE',
          metrics: null,
        };
      }

      return {
        status: 'available' as const,
        ...responseBase,
        releaseId: post.releaseId,
        metrics: normalizePostMetrics(analytics),
      };
    } catch {
      return {
        status: 'error' as const,
        ...responseBase,
        errorCode: 'TIKTOK_POST_ANALYTICS_ERROR',
        errorMessage: 'TikTok post analytics could not be retrieved.',
        metrics: null,
      };
    }
  }
}
