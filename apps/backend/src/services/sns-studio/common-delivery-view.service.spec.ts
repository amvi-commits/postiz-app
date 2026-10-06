jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/prisma.service',
  () => ({ PrismaService: class PrismaService {} }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/posts/posts.service',
  () => ({ PostsService: class PostsService {} }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/integrations/integration.manager',
  () => ({ IntegrationManager: class IntegrationManager {} }),
  { virtual: true }
);
jest.mock(
  '@gitroom/backend/services/sns-studio/common-publishing.service',
  () => ({ CommonPublishingService: class CommonPublishingService {} }),
  { virtual: true }
);

import { State } from '@prisma/client';
import { CommonDeliveryViewService, normalizeCommonAnalytics } from './common-delivery-view.service';
import { tiktokPublicationDetail } from '../../../../../libraries/nestjs-libraries/src/integrations/social/tiktok-publication-status.adapter';

const organizationId = 'org-one';
const scheduledAt = new Date('2026-10-04T09:00:00.000Z');

const makeDelivery = (overrides: Record<string, unknown> = {}): any => ({
  id: 'delivery-one',
  contentId: 'content-one',
  integrationId: 'integration-one',
  providerIdentifier: 'threads',
  accountName: '@account-one',
  status: 'PLANNED',
  postId: null,
  approvedAt: null,
  resolvedContent: null,
  resolvedHashtags: null,
  resolvedScheduledAt: scheduledAt,
  scheduledAtOverride: null,
  contentOverride: null,
  settingsOverride: { userValue: 'keep' },
  providerSettingsSnapshot: { sentValue: 'keep' },
  lastError: null,
  updatedAt: scheduledAt,
  content: {
    id: 'content-one',
    title: 'Common content',
    commonContent: 'A shared caption',
    commonHashtags: ['#common'],
    commonScheduledAt: scheduledAt,
    status: 'READY',
    originalAsset: { id: 'asset-one', fileName: 'source.mp4', storageKey: '/uploads/source.mp4', mimeType: 'video/mp4' },
    variants: [],
  },
  variant: { id: 'variant-one', name: 'Threads version', mediaAssetId: 'asset-one', isDefault: true, mediaAsset: { id: 'asset-one', fileName: 'source.mp4', storageKey: '/uploads/source.mp4', mimeType: 'video/mp4' } },
  ...overrides,
});

const setup = () => {
  const prisma = {
    snsDelivery: { findMany: jest.fn().mockResolvedValue([]) },
    post: { findMany: jest.fn().mockResolvedValue([]) },
    integration: { findMany: jest.fn().mockResolvedValue([{ id: 'integration-one', name: 'Account One', profile: '@account-one', disabled: false }]) },
  };
  const posts = { checkPostAnalytics: jest.fn().mockResolvedValue([]) };
  const integrations = {
    getSocialIntegration: jest.fn().mockReturnValue({ postAnalytics: jest.fn(), commonPostPublicationDetail: tiktokPublicationDetail }),
  };
  const commonPublishing = {
    evaluateContentPlan: jest.fn().mockResolvedValue({
      deliveries: [{ decision: 'allowed', allowed: true, reasons: [] }],
    }),
  };
  return {
    prisma,
    posts,
    integrations,
    commonPublishing,
    service: new CommonDeliveryViewService(
      prisma as any,
      posts as any,
      integrations as any,
      commonPublishing as any
    ),
  };
};

describe('CommonDeliveryViewService', () => {
  it('lists Queue items by organization and returns independent delivery policy state', async () => {
    const { prisma, service, commonPublishing } = setup();
    prisma.snsDelivery.findMany.mockResolvedValue([
      makeDelivery(),
      makeDelivery({ id: 'delivery-done', status: 'QUEUED', postId: 'post-done' }),
    ]);
    prisma.post.findMany.mockResolvedValue([
      { id: 'post-done', state: State.PUBLISHED, publishDate: new Date(), content: 'Posted', releaseId: 'provider-1', releaseURL: 'https://example.test/post', settings: '{}', error: null, deletedAt: null },
    ]);

    const result = await service.listQueue(organizationId, {
      providerIdentifier: 'threads',
      integrationId: 'integration-one',
      query: 'caption',
    });

    expect(prisma.snsDelivery.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          content: expect.objectContaining({ organizationId }),
          providerIdentifier: 'threads',
          integrationId: 'integration-one',
          AND: expect.arrayContaining([expect.objectContaining({ OR: expect.any(Array) })]),
        }),
      })
    );
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ organizationId }) })
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      deliveryId: 'delivery-one',
      status: 'planned',
      policy: { allowed: true, decision: 'allowed' },
      accountName: '@account-one',
      finalBody: 'A shared caption',
    });
    expect(commonPublishing.evaluateContentPlan).toHaveBeenCalledWith(
      organizationId,
      'content-one',
      ['integration-one'],
      'schedule'
    );
  });

  it('keeps approval, approved, and policy-blocked Queue states distinct', async () => {
    const { prisma, service, commonPublishing } = setup();
    prisma.snsDelivery.findMany.mockResolvedValue([
      makeDelivery({ id: 'delivery-needs-approval' }),
      makeDelivery({ id: 'delivery-approved', approvedAt: scheduledAt }),
      makeDelivery({ id: 'delivery-limit-blocked' }),
    ]);
    commonPublishing.evaluateContentPlan
      .mockResolvedValueOnce({
        deliveries: [{
          decision: 'approval_required',
          allowed: false,
          approvalRequired: true,
          reasons: [{ code: 'approval_required', message: '承認が必要です。' }],
        }],
      })
      .mockResolvedValueOnce({
        deliveries: [{ decision: 'allowed', allowed: true, approvalRequired: true, reasons: [] }],
      })
      .mockResolvedValueOnce({
        deliveries: [{
          decision: 'blocked',
          allowed: false,
          approvalRequired: false,
          reasons: [{ code: 'posting_limit', message: '投稿上限です。' }],
        }],
      });

    const result = await service.listQueue(organizationId);

    expect(result.map(({ deliveryId, approvalRequired, approvedAt, policy }) => ({
      deliveryId,
      approvalRequired,
      approvedAt,
      policy,
    }))).toEqual([
      {
        deliveryId: 'delivery-needs-approval',
        approvalRequired: true,
        approvedAt: null,
        policy: {
          decision: 'approval_required',
          allowed: false,
          approvalRequired: true,
          reasons: [{ code: 'approval_required', message: '承認が必要です。' }],
        },
      },
      {
        deliveryId: 'delivery-approved',
        approvalRequired: true,
        approvedAt: scheduledAt,
        policy: { decision: 'allowed', allowed: true, approvalRequired: true, reasons: [] },
      },
      {
        deliveryId: 'delivery-limit-blocked',
        approvalRequired: false,
        approvedAt: null,
        policy: {
          decision: 'blocked',
          allowed: false,
          approvalRequired: false,
          reasons: [{ code: 'posting_limit', message: '投稿上限です。' }],
        },
      },
    ]);
  });

  it('keeps successful, failed, and inbox-upload history distinct and preserves both settings values', async () => {
    const { prisma, service } = setup();
    prisma.snsDelivery.findMany.mockResolvedValue([
      makeDelivery({
        id: 'delivery-upload',
        integrationId: 'integration-upload',
        providerIdentifier: 'tiktok-business',
        status: 'QUEUED',
        postId: 'post-upload',
        resolvedContent: 'The final posted body',
        settingsOverride: { requestedPrivacy: 'SELF_ONLY' },
        providerSettingsSnapshot: { content_posting_method: 'UPLOAD' },
      }),
      makeDelivery({
        id: 'delivery-failed',
        integrationId: 'integration-failed',
        status: 'QUEUED',
        postId: 'post-failed',
      }),
      makeDelivery({
        id: 'delivery-published',
        integrationId: 'integration-published',
        status: 'QUEUED',
        postId: 'post-published',
        resolvedContent: 'The successful sibling delivery',
      }),
    ]);
    prisma.integration.findMany.mockResolvedValue([
      { id: 'integration-upload', name: 'TikTok Inbox', profile: '@tiktok', disabled: false },
      { id: 'integration-failed', name: 'Threads', profile: '@threads', disabled: false },
      { id: 'integration-published', name: 'YouTube', profile: '@youtube', disabled: false },
    ]);
    prisma.post.findMany.mockResolvedValue([
      { id: 'post-upload', state: State.PUBLISHED, publishDate: scheduledAt, content: 'The final posted body', releaseId: 'missing', releaseURL: 'https://www.tiktok.com/messages?lang=en', settings: '{"content_posting_method":"UPLOAD"}', error: null, deletedAt: null },
      { id: 'post-failed', state: State.ERROR, publishDate: scheduledAt, content: 'failed body', releaseId: null, releaseURL: null, settings: '{}', error: 'provider rejected post', deletedAt: null },
      { id: 'post-published', state: State.PUBLISHED, publishDate: scheduledAt, content: 'The successful sibling delivery', releaseId: 'provider-published-id', releaseURL: 'https://example.test/published', settings: '{}', error: null, deletedAt: null },
    ]);

    const result = await service.listHistory(organizationId);
    const uploaded = result.find((item) => item.deliveryId === 'delivery-upload');
    const failed = result.find((item) => item.deliveryId === 'delivery-failed');
    const published = result.find((item) => item.deliveryId === 'delivery-published');

    expect(uploaded).toMatchObject({
      status: 'uploaded',
      publishedAt: null,
      finalBody: 'The final posted body',
      providerPublicationDetail: {
        providerStatus: 'uploaded_to_inbox',
        publicPublication: false,
      },
      settingsOverride: { requestedPrivacy: 'SELF_ONLY' },
      providerSettingsSnapshot: { content_posting_method: 'UPLOAD' },
    });
    expect(failed).toMatchObject({ status: 'failed', failureInformation: 'provider rejected post' });
    expect(published).toMatchObject({
      status: 'published',
      postId: 'post-published',
      providerPostId: 'provider-published-id',
      finalBody: 'The successful sibling delivery',
    });
  });

  it('confirms delivery status semantics: SnsDelivery.status=QUEUED with Post.state=PUBLISHED resolves to status=published and deliveryStatus=QUEUED in History, and is excluded from Queue', async () => {
    const { prisma, service } = setup();
    prisma.snsDelivery.findMany.mockResolvedValue([
      makeDelivery({
        id: 'delivery-completed',
        integrationId: 'integration-one',
        status: 'QUEUED',
        postId: 'post-completed',
        resolvedContent: 'Real published post',
      }),
    ]);
    prisma.post.findMany.mockResolvedValue([
      {
        id: 'post-completed',
        state: State.PUBLISHED,
        publishDate: scheduledAt,
        content: 'Real published post',
        releaseId: 'release-123',
        releaseURL: 'https://example.test/post/123',
        settings: '{}',
        error: null,
        deletedAt: null,
      },
    ]);

    // 1. History: derived status is 'published', raw deliveryStatus is 'QUEUED'
    const history = await service.listHistory(organizationId);
    expect(history).toHaveLength(1);
    expect(history[0]).toMatchObject({
      deliveryId: 'delivery-completed',
      status: 'published',
      deliveryStatus: 'QUEUED',
      postState: State.PUBLISHED,
      postId: 'post-completed',
      providerPostId: 'release-123',
      postUrl: 'https://example.test/post/123',
    });

    // 2. Queue: delivery with derived status 'published' is excluded from Queue
    const queue = await service.listQueue(organizationId);
    expect(queue).toHaveLength(0);
  });

  it('fetches provider analytics through Postiz and leaves unavailable normalized values null', async () => {
    const { prisma, posts, service } = setup();
    prisma.snsDelivery.findMany.mockResolvedValue([
      makeDelivery({ id: 'delivery-published', status: 'SCHEDULED', postId: 'post-published' }),
    ]);
    prisma.post.findMany.mockResolvedValue([
      { id: 'post-published', state: State.PUBLISHED, publishDate: scheduledAt, content: 'Caption', releaseId: 'provider-id', releaseURL: null, settings: '{}', error: null, deletedAt: null },
    ]);
    posts.checkPostAnalytics.mockResolvedValue([
      { label: 'Likes', data: [{ total: '3', date: '2026-10-01' }, { total: '8', date: '2026-10-02' }], percentageChange: 0 },
      { label: 'Video Views', data: [{ total: '21', date: '2026-10-02' }], percentageChange: 0 },
      { label: 'Provider only metric', data: [{ total: '100', date: '2026-10-02' }], percentageChange: 0 },
    ]);

    const result = await service.deliveryAnalytics(organizationId, 'delivery-published', 1760000000000);

    expect(posts.checkPostAnalytics).toHaveBeenCalledWith(
      organizationId,
      'post-published',
      1760000000000
    );
    expect(result).toMatchObject({
      available: true,
      normalizedMetrics: {
        likes: 8,
        views: 21,
        comments: null,
        shares: null,
        reach: null,
        impressions: null,
        saves: null,
        clicks: null,
      },
    });
    expect(result.providerDetails).toHaveLength(3);
  });

  it('does not request public analytics for a TikTok inbox upload', async () => {
    const { prisma, posts, service } = setup();
    prisma.snsDelivery.findMany.mockResolvedValue([
      makeDelivery({ providerIdentifier: 'tiktok', status: 'QUEUED', postId: 'post-inbox' }),
    ]);
    prisma.post.findMany.mockResolvedValue([
      { id: 'post-inbox', state: State.PUBLISHED, publishDate: scheduledAt, content: 'Caption', releaseId: 'missing', releaseURL: 'https://www.tiktok.com/messages', settings: '{"content_posting_method":"UPLOAD"}', error: null, deletedAt: null },
    ]);

    const result = await service.deliveryAnalytics(organizationId, 'delivery-one');

    expect(result.available).toBe(false);
    expect(result.normalizedMetrics.likes).toBeNull();
    expect(posts.checkPostAnalytics).not.toHaveBeenCalled();
  });

  it('does not expose analytics for a missing provider post or a delivery outside the organization', async () => {
    const { prisma, posts, service } = setup();
    prisma.snsDelivery.findMany.mockResolvedValue([
      makeDelivery({ postId: 'post-missing-provider' }),
    ]);
    prisma.post.findMany.mockResolvedValue([
      { id: 'post-missing-provider', state: State.PUBLISHED, publishDate: scheduledAt, content: 'Caption', releaseId: 'missing', releaseURL: null, settings: '{}', error: null, deletedAt: null },
    ]);

    const available = await service.listAnalytics(organizationId);
    expect(available[0].analyticsAvailable).toBe(false);

    prisma.snsDelivery.findMany.mockResolvedValue([]);
    await expect(service.deliveryAnalytics(organizationId, 'foreign-delivery')).rejects.toMatchObject({
      status: 404,
    });
    expect(posts.checkPostAnalytics).not.toHaveBeenCalled();
  });

  it('normalizes known provider labels while preserving null for missing metrics', () => {
    expect(
      normalizeCommonAnalytics([
        { label: 'shares_count', data: [{ total: '4', date: '2026-10-02' }] },
        { label: 'unknown metric', data: [{ total: '900', date: '2026-10-02' }] },
      ])
    ).toEqual({
      likes: null,
      comments: null,
      shares: 4,
      views: null,
      reach: null,
      impressions: null,
      saves: null,
      clicks: null,
    });
  });
});
