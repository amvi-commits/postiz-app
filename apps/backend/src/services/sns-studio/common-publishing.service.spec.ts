jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/prisma.service',
  () => ({ PrismaService: class PrismaService {} }),
  { virtual: true }
);

import { CommonPublishingService } from './common-publishing.service';

const organizationId = 'org-a';
const integrationId = 'integration-a';
const contentId = 'content-a';
const deliveryId = 'delivery-a';
const policyKey = `sns:common:account-policy:v1:${integrationId}`;

const integration = {
  id: integrationId,
  name: 'Account A',
  profile: '@account-a',
  providerIdentifier: 'instagram',
  disabled: false,
};

const createPlan = (overrides: Record<string, unknown> = {}) => ({
  id: contentId,
  organizationId,
  originalAssetId: null as string | null,
  variants: [] as Array<{ id: string; mediaAssetId: string | null }>,
  deliveries: [
    {
      id: deliveryId,
      contentId,
      variantId: null as string | null,
      integrationId,
      providerIdentifier: 'instagram',
      accountName: '@account-a',
      status: 'PLANNED',
      postId: null as string | null,
      approvedAt: null as Date | null,
    },
  ],
  ...overrides,
});

const createPrisma = () => ({
  integration: {
    findMany: jest.fn().mockResolvedValue([integration]),
    findFirst: jest.fn().mockResolvedValue(integration),
  },
  snsAppSetting: {
    findMany: jest.fn().mockResolvedValue([]),
    findUnique: jest.fn().mockResolvedValue(null),
    upsert: jest.fn().mockResolvedValue({}),
  },
  snsContent: {
    findFirst: jest.fn().mockResolvedValue(createPlan()),
    findMany: jest.fn().mockResolvedValue([]),
  },
  snsDelivery: {
    findMany: jest.fn().mockResolvedValue([]),
    update: jest.fn().mockResolvedValue({ id: deliveryId, approvedAt: new Date() }),
  },
  post: {
    findMany: jest.fn().mockResolvedValue([]),
  },
});

describe('CommonPublishingService account policy', () => {
  it('returns safe common defaults and reads only the Common account-policy namespace', async () => {
    const prisma = createPrisma();
    const service = new CommonPublishingService(prisma as any);

    const result = await service.listAccountPolicies(organizationId);

    expect(result).toEqual([
      {
        integrationId,
        accountName: '@account-a',
        providerIdentifier: 'instagram',
        disabled: false,
        policy: {
          autoPostEnabled: true,
          approvalRequired: false,
          maxPostsPerDay: null,
          sameContentCooldownDays: 0,
        },
      },
    ]);
    expect(prisma.snsAppSetting.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId,
          key: { in: [policyKey] },
        }),
      })
    );
  });

  it('saves account policy in the scoped common namespace without changing provider settings', async () => {
    const prisma = createPrisma();
    const service = new CommonPublishingService(prisma as any);
    const policy = {
      autoPostEnabled: false,
      approvalRequired: true,
      maxPostsPerDay: 4,
      sameContentCooldownDays: 12,
    };

    await service.updateAccountPolicy(organizationId, integrationId, policy);

    expect(prisma.integration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: integrationId, organizationId, deletedAt: null },
      })
    );
    expect(prisma.snsAppSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId_key: { organizationId, key: policyKey } },
        create: expect.objectContaining({ organizationId, key: policyKey }),
        update: expect.objectContaining({ value: policy }),
      })
    );
  });

  it('rejects invalid account limits and cooldown values', async () => {
    const prisma = createPrisma();
    const service = new CommonPublishingService(prisma as any);

    await expect(
      service.updateAccountPolicy(organizationId, integrationId, {
        maxPostsPerDay: 1.5,
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.updateAccountPolicy(organizationId, integrationId, {
        sameContentCooldownDays: 366,
      })
    ).rejects.toMatchObject({ status: 400 });
    expect(prisma.snsAppSetting.upsert).not.toHaveBeenCalled();
  });

  it('requires explicit approval when auto-post is disabled and allows after delivery approval', async () => {
    const prisma = createPrisma();
    prisma.snsAppSetting.findMany.mockResolvedValue([
      {
        key: policyKey,
        value: { autoPostEnabled: false, approvalRequired: false },
      },
    ]);
    const service = new CommonPublishingService(prisma as any);

    const pending = await service.evaluateContentPlan(
      organizationId,
      contentId,
      [integrationId],
      'now',
      new Date('2026-10-03T12:00:00Z')
    );
    expect(pending.deliveries[0]).toMatchObject({
      allowed: false,
      decision: 'approval_required',
      approvalRequired: true,
      reasons: [expect.objectContaining({ code: 'approval_required' })],
    });

    prisma.snsContent.findFirst.mockResolvedValue(
      createPlan({
        deliveries: [
          { ...createPlan().deliveries[0], approvedAt: new Date('2026-10-03T11:00:00Z') },
        ],
      })
    );
    const approved = await service.evaluateContentPlan(
      organizationId,
      contentId,
      [integrationId],
      'now',
      new Date('2026-10-03T12:00:00Z')
    );
    expect(approved.deliveries[0]).toMatchObject({ allowed: true, decision: 'allowed' });
  });

  it('blocks the account posting limit using only Postiz queue and published posts in the rolling 24-hour window', async () => {
    const prisma = createPrisma();
    prisma.snsAppSetting.findMany.mockResolvedValue([
      { key: policyKey, value: { maxPostsPerDay: 2 } },
    ]);
    prisma.post.findMany.mockResolvedValue([{ id: 'post-1' }, { id: 'post-2' }]);
    const service = new CommonPublishingService(prisma as any);

    const result = await service.evaluateContentPlan(
      organizationId,
      contentId,
      [integrationId],
      'schedule',
      new Date('2026-10-03T12:00:00Z')
    );

    expect(result.deliveries[0].reasons).toContainEqual(
      expect.objectContaining({ code: 'posting_limit' })
    );
    expect(prisma.post.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId,
          integrationId,
          publishDate: {
            gte: new Date('2026-10-02T12:00:00Z'),
            lte: new Date('2026-10-03T12:00:00Z'),
          },
        }),
      })
    );
  });

  it('blocks the same source asset inside cooldown using linked Common deliveries and Postiz state', async () => {
    const prisma = createPrisma();
    prisma.snsAppSetting.findMany.mockResolvedValue([
      { key: policyKey, value: { sameContentCooldownDays: 30 } },
    ]);
    prisma.snsContent.findFirst.mockResolvedValue(
      createPlan({ originalAssetId: 'asset-shared' })
    );
    prisma.snsContent.findMany.mockResolvedValue([{ id: 'older-content' }]);
    prisma.snsDelivery.findMany.mockResolvedValue([{ postId: 'post-old' }]);
    prisma.post.findMany.mockResolvedValue([{ id: 'post-old' }]);
    const service = new CommonPublishingService(prisma as any);

    const result = await service.evaluateContentPlan(
      organizationId,
      contentId,
      [integrationId],
      'now',
      new Date('2026-10-03T12:00:00Z')
    );

    expect(result.deliveries[0].reasons).toContainEqual(
      expect.objectContaining({ code: 'same_content_cooldown' })
    );
    expect(prisma.snsContent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId,
          id: { not: contentId },
          OR: expect.arrayContaining([
            { originalAssetId: 'asset-shared' },
            { variants: { some: { mediaAssetId: 'asset-shared' } } },
          ]),
        }),
      })
    );
  });

  it('allows drafts without consuming auto-post, approval, limit, or cooldown policy', async () => {
    const prisma = createPrisma();
    prisma.snsAppSetting.findMany.mockResolvedValue([
      {
        key: policyKey,
        value: {
          autoPostEnabled: false,
          approvalRequired: true,
          maxPostsPerDay: 1,
          sameContentCooldownDays: 30,
        },
      },
    ]);
    prisma.snsContent.findFirst.mockResolvedValue(
      createPlan({ originalAssetId: 'asset-shared' })
    );
    const service = new CommonPublishingService(prisma as any);

    const result = await service.evaluateContentPlan(
      organizationId,
      contentId,
      [integrationId],
      'draft'
    );

    expect(result.deliveries[0]).toMatchObject({ allowed: true, decision: 'allowed' });
    expect(prisma.post.findMany).not.toHaveBeenCalled();
    expect(prisma.snsContent.findMany).not.toHaveBeenCalled();
  });

  it('does not evaluate a plan against an account from another organization', async () => {
    const prisma = createPrisma();
    prisma.integration.findMany.mockResolvedValue([]);
    const service = new CommonPublishingService(prisma as any);

    await expect(
      service.evaluateContentPlan(organizationId, contentId, [integrationId])
    ).rejects.toMatchObject({ status: 400 });
  });

  it('records approval on the owned SnsDelivery and rejects an already-linked delivery', async () => {
    const prisma = createPrisma();
    const service = new CommonPublishingService(prisma as any);

    await service.approveDelivery(organizationId, contentId, deliveryId);
    expect(prisma.snsDelivery.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: deliveryId },
        data: { approvedAt: expect.any(Date) },
      })
    );

    prisma.snsContent.findFirst.mockResolvedValue(
      createPlan({
        deliveries: [
          { ...createPlan().deliveries[0], status: 'SCHEDULED', postId: 'post-1' },
        ],
      })
    );
    await expect(
      service.approveDelivery(organizationId, contentId, deliveryId)
    ).rejects.toMatchObject({ status: 409 });
  });

  it('prevents a saved Common delivery from creating a duplicate Postiz post', async () => {
    const prisma = createPrisma();
    prisma.snsContent.findFirst.mockResolvedValue(
      createPlan({
        deliveries: [
          { ...createPlan().deliveries[0], status: 'QUEUED', postId: 'post-linked' },
        ],
      })
    );
    const service = new CommonPublishingService(prisma as any);

    await expect(
      service.assertPlanAllowsPost(organizationId, contentId, 'now', [
        { integration: { id: integrationId } },
      ])
    ).rejects.toMatchObject({ status: 409 });
  });
});
