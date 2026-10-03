import { Injectable, NotFoundException } from '@nestjs/common';
import { State } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import {
  AnalyticsData,
  CommonPostPublicationContext,
  ProviderPublicationDetail,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { CommonPublishingService } from './common-publishing.service';

export type CommonDeliveryView = 'queue' | 'history' | 'analytics';

export type CommonDeliveryFilters = {
  deliveryId?: string;
  providerIdentifier?: string;
  integrationId?: string;
  contentId?: string;
  state?: string;
  query?: string;
};

export type CommonDeliveryState =
  | 'planned'
  | 'draft'
  | 'queued'
  | 'scheduled'
  | 'published'
  | 'uploaded'
  | 'failed'
  | 'link_missing';

const NORMALIZED_METRIC_ALIASES: Record<string, string[]> = {
  likes: ['like', 'likes', 'like_count', 'likes_count'],
  comments: ['comment', 'comments', 'comment_count', 'comments_count'],
  shares: ['share', 'shares', 'share_count', 'shares_count', 'reposts'],
  views: ['view', 'views', 'view_count', 'video_views', 'plays', 'play_count'],
  reach: ['reach', 'unique_reach'],
  impressions: ['impression', 'impressions', 'impression_count'],
  saves: ['save', 'saves', 'save_count', 'saved'],
  clicks: ['click', 'clicks', 'click_count'],
};

type CommonMetric = keyof typeof NORMALIZED_METRIC_ALIASES;

const EMPTY_NORMALIZED_METRICS: Record<CommonMetric, number | null> = {
  likes: null,
  comments: null,
  shares: null,
  views: null,
  reach: null,
  impressions: null,
  saves: null,
  clicks: null,
};

function normalizeLabel(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
}

export function normalizeCommonAnalytics(data: unknown) {
  const metrics: Record<string, number | null> = {
    ...EMPTY_NORMALIZED_METRICS,
  };
  if (!Array.isArray(data)) return metrics;

  const aliases = new Map<string, string>();
  for (const [metric, names] of Object.entries(NORMALIZED_METRIC_ALIASES)) {
    for (const name of names) aliases.set(name, metric);
  }

  for (const row of data) {
    if (!row || typeof row !== 'object') continue;
    const record = row as Record<string, unknown>;
    if (typeof record.label !== 'string') continue;
    const metric = aliases.get(normalizeLabel(record.label));
    if (!metric || !Array.isArray(record.data) || !record.data.length) continue;

    const points = record.data
      .map((point) => {
        if (!point || typeof point !== 'object') return null;
        const item = point as Record<string, unknown>;
        const raw = item.total;
        const total = typeof raw === 'number' ? raw : Number(raw);
        if (!Number.isFinite(total)) return null;
        return {
          total,
          date: typeof item.date === 'string' ? item.date : '',
        };
      })
      .filter((point): point is { total: number; date: string } => !!point)
      .sort((left, right) => left.date.localeCompare(right.date));
    if (points.length) metrics[metric] = points[points.length - 1].total;
  }

  return metrics;
}

function stateFor(
  delivery: { status: string; postId: string | null },
  post: {
    state: State;
    publishDate: Date;
  } | undefined,
  providerDetail: ProviderPublicationDetail | undefined,
  now: Date
): CommonDeliveryState {
  if (post) {
    if (
      post.state === State.PUBLISHED &&
      providerDetail?.publicPublication === false
    ) {
      return 'uploaded';
    }
    if (post.state === State.PUBLISHED) return 'published';
    if (post.state === State.ERROR) return 'failed';
    if (post.state === State.DRAFT) return 'draft';
    return post.publishDate.getTime() > now.getTime() ? 'scheduled' : 'queued';
  }
  if (delivery.postId) return 'link_missing';
  if (delivery.status === 'POSTIZ_DRAFT') return 'draft';
  if (delivery.status === 'QUEUED') return 'queued';
  if (delivery.status === 'SCHEDULED') return 'scheduled';
  if (delivery.status === 'FAILED' || delivery.status === 'ERROR') return 'failed';
  return 'planned';
}

@Injectable()
export class CommonDeliveryViewService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly posts: PostsService,
    private readonly integrations: IntegrationManager,
    private readonly commonPublishing: CommonPublishingService
  ) {}

  listQueue(organizationId: string, filters: CommonDeliveryFilters = {}) {
    return this.list(organizationId, 'queue', filters);
  }

  listHistory(organizationId: string, filters: CommonDeliveryFilters = {}) {
    return this.list(organizationId, 'history', filters);
  }

  async listAnalytics(
    organizationId: string,
    filters: CommonDeliveryFilters = {}
  ) {
    const rows = await this.list(organizationId, 'analytics', filters);
    return rows.map((row) => ({
      ...row,
      analyticsAvailable: row.analyticsAvailable,
      normalizedMetrics: { ...EMPTY_NORMALIZED_METRICS },
    }));
  }

  async deliveryAnalytics(
    organizationId: string,
    deliveryId: string,
    date = Date.now()
  ) {
    const [delivery] = await this.list(organizationId, 'history', {
      deliveryId,
    });
    if (!delivery) {
      throw new NotFoundException({ code: 'COMMON_DELIVERY_NOT_FOUND' });
    }

    const emptyMetrics = { ...EMPTY_NORMALIZED_METRICS };
    if (!delivery.postId || !delivery.analyticsAvailable) {
      return {
        delivery,
        available: false,
        normalizedMetrics: emptyMetrics,
        providerDetails: [],
      };
    }

    const result = await this.posts.checkPostAnalytics(
      organizationId,
      delivery.postId,
      Number.isFinite(date) ? date : Date.now()
    );
    const providerDetails: AnalyticsData[] = Array.isArray(result) ? result : [];
    return {
      delivery,
      available: Array.isArray(result) && result.length > 0,
      normalizedMetrics: normalizeCommonAnalytics(providerDetails),
      providerDetails,
      ...(result && !Array.isArray(result) && result.missing
        ? { unavailableReason: 'provider_post_missing' }
        : {}),
    };
  }

  private async list(
    organizationId: string,
    view: CommonDeliveryView,
    filters: CommonDeliveryFilters
  ) {
    const query = filters.query?.trim().slice(0, 120);
    const andFilters: any[] = [];
    if (query) {
      andFilters.push({
        OR: [
          { resolvedContent: { contains: query, mode: 'insensitive' } },
          { contentOverride: { contains: query, mode: 'insensitive' } },
          {
            content: {
              organizationId,
              title: { contains: query, mode: 'insensitive' },
            },
          },
          {
            content: {
              organizationId,
              commonContent: { contains: query, mode: 'insensitive' },
            },
          },
        ],
      });
    }
    if (view !== 'queue') {
      andFilters.push({
        OR: [{ postId: { not: null } }, { status: { not: 'PLANNED' } }],
      });
    }
    const where: any = {
      content: {
        organizationId,
        ...(filters.contentId ? { id: filters.contentId } : {}),
      },
      ...(andFilters.length ? { AND: andFilters } : {}),
      ...(filters.deliveryId ? { id: filters.deliveryId } : {}),
      ...(filters.providerIdentifier
        ? { providerIdentifier: filters.providerIdentifier }
        : {}),
      ...(filters.integrationId ? { integrationId: filters.integrationId } : {}),
      ...(view === 'queue'
        ? { status: { in: ['PLANNED', 'QUEUED', 'SCHEDULED'] } }
        : {}),
    };

    const rows = await this.prisma.snsDelivery.findMany({
      where,
      orderBy: [{ resolvedScheduledAt: 'asc' }, { updatedAt: 'desc' }],
      take: 200,
      include: {
        content: {
          select: {
            id: true,
            title: true,
            commonContent: true,
            commonHashtags: true,
            commonScheduledAt: true,
            status: true,
            originalAsset: {
              select: { id: true, fileName: true, storageKey: true, mimeType: true },
            },
            variants: {
              select: {
                id: true,
                name: true,
                mediaAssetId: true,
                isDefault: true,
                mediaAsset: {
                  select: { id: true, fileName: true, storageKey: true, mimeType: true },
                },
              },
            },
          },
        },
        variant: {
          select: {
            id: true,
            name: true,
            mediaAssetId: true,
            isDefault: true,
            mediaAsset: {
              select: { id: true, fileName: true, storageKey: true, mimeType: true },
            },
          },
        },
      },
    });
    if (!rows.length) return [];

    const postIds = Array.from(
      new Set(rows.map(({ postId }) => postId).filter((id): id is string => !!id))
    );
    const integrationIds = Array.from(new Set(rows.map(({ integrationId }) => integrationId)));
    const [posts, accounts] = await Promise.all([
      postIds.length
        ? this.prisma.post.findMany({
            where: { id: { in: postIds }, organizationId },
            select: {
              id: true,
              state: true,
              publishDate: true,
              content: true,
              releaseId: true,
              releaseURL: true,
              settings: true,
              error: true,
              deletedAt: true,
            },
          })
        : Promise.resolve([]),
      this.prisma.integration.findMany({
        where: { id: { in: integrationIds }, organizationId },
        select: { id: true, name: true, profile: true, disabled: true },
      }),
    ]);
    const postById = new Map(posts.map((post) => [post.id, post]));
    const accountById = new Map(accounts.map((account) => [account.id, account]));
    const now = new Date();

    const mapped = await Promise.all(
      rows.map(async (delivery) => {
        const post = delivery.postId ? postById.get(delivery.postId) : undefined;
        const provider = this.integrations.getSocialIntegration(
          delivery.providerIdentifier
        );
        const publicationContext: CommonPostPublicationContext | undefined = post
          ? {
              state: post.state,
              settings: post.settings,
              releaseId: post.releaseId,
              releaseURL: post.releaseURL,
            }
          : undefined;
        const providerPublicationDetail = publicationContext
          ? provider?.commonPostPublicationDetail?.(publicationContext)
          : undefined;
        const state = stateFor(delivery, post, providerPublicationDetail, now);
        const account = accountById.get(delivery.integrationId);
        const linked = !!delivery.postId;

        let policy = {
          decision: 'allowed',
          allowed: true,
          approvalRequired: false,
          reasons: [] as Array<{ code: string; message: string }>,
        };
        if (!linked && delivery.status === 'PLANNED') {
          try {
            const evaluation = await this.commonPublishing.evaluateContentPlan(
              organizationId,
              delivery.contentId,
              [delivery.integrationId],
              'schedule'
            );
            const decision = evaluation.deliveries[0];
            if (decision) {
              policy = {
                decision: decision.decision,
                allowed: decision.allowed,
                approvalRequired: decision.approvalRequired,
                reasons: decision.reasons,
              };
            }
          } catch {
            policy = {
              decision: 'blocked',
              allowed: false,
              approvalRequired: false,
              reasons: [
                {
                  code: 'account_unavailable',
                  message: '投稿Policyを確認できません。接続アカウントを確認してください。',
                },
              ],
            };
          }
        }

        const publicPublished =
          state === 'published' &&
          providerPublicationDetail?.publicPublication !== false;
        const analyticsAvailable =
          !!post?.releaseId &&
          post.releaseId !== 'missing' &&
          !post.deletedAt &&
          post.state === State.PUBLISHED &&
          providerPublicationDetail?.publicPublication !== false &&
          !!provider?.postAnalytics;
        const effectivePublishAt =
          post?.publishDate ||
          delivery.resolvedScheduledAt ||
          delivery.scheduledAtOverride ||
          delivery.content.commonScheduledAt;

        return {
          deliveryId: delivery.id,
          contentId: delivery.contentId,
          contentTitle: delivery.content.title,
          content: delivery.content.commonContent,
          finalBody:
            delivery.resolvedContent ||
            post?.content ||
            delivery.contentOverride ||
            delivery.content.commonContent,
          platform: delivery.providerIdentifier,
          providerIdentifier: delivery.providerIdentifier,
          integrationId: delivery.integrationId,
          accountName:
            account?.profile || account?.name || delivery.accountName || 'Unknown account',
          accountDisabled: account?.disabled ?? true,
          status: state,
          deliveryStatus: delivery.status,
          effectivePublishAt,
          publishedAt: publicPublished ? post?.publishDate || null : null,
          approvalRequired: !linked && policy.approvalRequired,
          approvedAt: delivery.approvedAt,
          policy,
          postId: delivery.postId,
          providerPostId: post?.releaseId || null,
          postUrl: post?.releaseURL || null,
          postState: post?.state || null,
          failureInformation: post?.error || delivery.lastError || null,
          providerPublicationDetail: providerPublicationDetail || null,
          analyticsAvailable,
          selectedVariant: delivery.variant,
          originalAsset: delivery.content.originalAsset,
          settingsOverride: delivery.settingsOverride,
          providerSettingsSnapshot: delivery.providerSettingsSnapshot,
          resolvedHashtags: delivery.resolvedHashtags,
          deletedPost: post?.deletedAt ? true : false,
          updatedAt: delivery.updatedAt,
        };
      })
    );

    const stateFilter = filters.state?.trim().toLowerCase();
    return mapped.filter((delivery) => {
      if (view === 'queue' && !['planned', 'queued', 'scheduled', 'link_missing'].includes(delivery.status)) {
        return false;
      }
      if (stateFilter && delivery.status !== stateFilter) return false;
      return true;
    });
  }
}
