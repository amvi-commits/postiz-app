jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/prisma.service',
  () => ({ PrismaService: class PrismaService {} }),
  { virtual: true }
);

jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: (value: string) => value },
  sanitize: (value: string) => value,
}));

jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  Relay: jest.fn(),
  finalizeEvent: jest.fn(),
  SimplePool: jest.fn(),
}));

jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));

import { ConflictException } from '@nestjs/common';
import { SnsStudioController } from '../../api/routes/sns-studio.controller';
import { SnsStudioCommonPublishingController } from '../../api/routes/sns-studio-common-publishing.controller';
import { CommonPublishingService } from './common-publishing.service';
import { AccountProtectionService } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-protection.service';

const organizationId = 'org-preflight-memory';
const integrationId = 'tiktok-personal-memory';
const contentId = 'content-preflight-memory';
const originalAssetId = 'asset-original-memory';
const variantAssetId = 'asset-variant-memory';
const policyKey = `sns:common:account-policy:v1:${integrationId}`;

const integration = {
  id: integrationId,
  organizationId,
  name: 'Personal Sandbox',
  profile: '@sandbox-personal',
  providerIdentifier: 'tiktok',
  disabled: false,
  refreshNeeded: false,
  deletedAt: null,
};

const assets = [
  {
    id: originalAssetId,
    organizationId,
    storageKey: '/uploads/sns-studio/preflight/original.mp4',
    fileName: 'original.mp4',
    mimeType: 'video/mp4',
    width: 720,
    height: 1280,
    duration: 3,
  },
  {
    id: variantAssetId,
    organizationId,
    storageKey: '/uploads/sns-studio/preflight/variant.mp4',
    fileName: 'variant.mp4',
    mimeType: 'video/mp4',
    width: 720,
    height: 1280,
    duration: 3,
  },
];

function createMemoryHarness() {
  const store: {
    content: Record<string, any> | null;
    variants: Array<Record<string, any>>;
    platformOverrides: Array<Record<string, any>>;
    deliveries: Array<Record<string, any>>;
    policy: Record<string, unknown>;
    posts: Array<Record<string, any>>;
  } = {
    content: null,
    variants: [],
    platformOverrides: [],
    deliveries: [],
    policy: {
      autoPostEnabled: true,
      approvalRequired: false,
      maxPostsPerDay: 2,
      sameContentCooldownDays: 0,
    },
    posts: [],
  };

  const hydratePlan = () => {
    if (!store.content) return null;
    return {
      ...store.content,
      originalAsset: assets.find((asset) => asset.id === store.content?.originalAssetId) || null,
      variants: store.variants.map((variant) => ({
        ...variant,
        mediaAsset: assets.find((asset) => asset.id === variant.mediaAssetId) || null,
      })),
      platformOverrides: store.platformOverrides,
      deliveries: store.deliveries,
    };
  };

  const tx = {
    snsContent: {
      create: jest.fn(async ({ data }: any) => {
        store.content = { id: contentId, ...data };
        return store.content;
      }),
    },
    snsContentVariant: {
      updateMany: jest.fn(async ({ data }: any) => {
        store.variants = store.variants.map((variant) => ({ ...variant, ...data }));
        return { count: store.variants.length };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const mediaId = where.contentId_mediaAssetId.mediaAssetId;
        const existing = store.variants.find((variant) => variant.mediaAssetId === mediaId);
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const variant = { id: `variant-${store.variants.length + 1}`, ...create };
        store.variants.push(variant);
        return variant;
      }),
      create: jest.fn(async ({ data }: any) => {
        const variant = { id: `variant-${store.variants.length + 1}`, ...data };
        store.variants.push(variant);
        return variant;
      }),
    },
    snsContentPlatformOverride: {
      deleteMany: jest.fn(async () => {
        store.platformOverrides = [];
        return { count: 0 };
      }),
      create: jest.fn(async ({ data }: any) => {
        const item = { id: `platform-override-${store.platformOverrides.length + 1}`, ...data };
        store.platformOverrides.push(item);
        return item;
      }),
    },
    snsDelivery: {
      deleteMany: jest.fn(async () => {
        store.deliveries = [];
        return { count: 0 };
      }),
      create: jest.fn(async ({ data }: any) => {
        const delivery = {
          id: `delivery-${store.deliveries.length + 1}`,
          status: 'PLANNED',
          postId: null,
          approvedAt: null,
          createdAt: new Date(),
          ...data,
        };
        store.deliveries.push(delivery);
        return delivery;
      }),
    },
  };

  const prisma: any = {
    integration: {
      findMany: jest.fn().mockResolvedValue([integration]),
      findFirst: jest.fn().mockResolvedValue(integration),
    },
    snsMediaAsset: {
      findMany: jest.fn(async ({ where }: any) =>
        assets
          .filter((asset) => asset.organizationId === where.organizationId)
          .filter((asset) => where.id.in.includes(asset.id))
          .map(({ id }) => ({ id }))
      ),
    },
    snsContent: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === contentId && where.organizationId === organizationId
          ? hydratePlan()
          : null
      ),
      update: jest.fn(async ({ where, data }: any) => {
        if (store.content?.id !== where.id) return null;
        Object.assign(store.content, data);
        return store.content;
      }),
    },
    snsDelivery: {
      updateMany: jest.fn(async ({ where, data }: any) => {
        const rows = store.deliveries.filter(
          (delivery) =>
            delivery.contentId === where.contentId &&
            delivery.integrationId === where.integrationId
        );
        rows.forEach((delivery) => Object.assign(delivery, data));
        return { count: rows.length };
      }),
    },
    snsAppSetting: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        where.key.in.includes(policyKey)
          ? [{ key: policyKey, value: { ...store.policy } }]
          : []
      ),
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn(),
    },
    post: {
      findMany: jest.fn().mockImplementation(async ({ where }: any) =>
        store.posts.filter((post) =>
          post.organizationId === where.organizationId &&
          post.integrationId === where.integrationId &&
          !post.deletedAt &&
          where.state.in.includes(post.state) &&
          post.publishDate >= where.publishDate.gte &&
          post.publishDate <= where.publishDate.lte
        )
      ),
    },
    $transaction: jest.fn(async (operation: (tx: any) => Promise<unknown>) => operation(tx)),
  };

  const contentController = Object.create(SnsStudioController.prototype) as any;
  contentController.prisma = prisma;

  const commonPublishing = new CommonPublishingService(prisma);
  const commonController = new SnsStudioCommonPublishingController(
    commonPublishing,
    {} as any
  );

  return { store, prisma, tx, contentController, commonController };
}

describe('TikTok Personal Common Publishing preflight in isolated memory transaction', () => {
  it('saves Content → selected Variant → planned Delivery and enforces the persisted 2-post policy', async () => {
    const { store, prisma, tx, contentController, commonController } = createMemoryHarness();
    const scheduledAt = new Date(Date.now() + 24 * 60 * 60 * 1000);

    const plan = await contentController.createContentPlan(
      { id: organizationId },
      {
        title: 'Sandbox preflight fixture',
        commonContent: 'Common caption',
        commonHashtags: ['launch'],
        commonScheduledAt: scheduledAt.toISOString(),
        originalAssetId,
        variants: [
          { mediaAssetId: originalAssetId, name: 'Default', isDefault: true },
          { mediaAssetId: variantAssetId, name: 'TikTok selected', isDefault: false },
        ],
        deliveries: [
          {
            integrationId,
            contentOverride: 'TikTok caption',
            hashtagsOverride: ['sandbox'],
            scheduledAtOverride: scheduledAt.toISOString(),
            variantAssetId,
            settingsOverride: { content_posting_method: 'DIRECT_POST' },
          },
        ],
      }
    );

    expect(plan.id).toBe(contentId);
    expect(plan.variants).toHaveLength(2);
    expect(plan.deliveries).toHaveLength(1);
    expect(plan.deliveries[0]).toMatchObject({
      contentId,
      integrationId,
      providerIdentifier: 'tiktok',
      accountName: 'Personal Sandbox',
      status: 'PLANNED',
      variantId: plan.variants.find((variant: any) => variant.mediaAssetId === variantAssetId).id,
      resolvedContent: 'TikTok caption',
      resolvedHashtags: ['#sandbox'],
      resolvedScheduledAt: scheduledAt,
      settingsOverride: { content_posting_method: 'DIRECT_POST' },
    });
    expect(plan.variants.find((variant: any) => variant.id === plan.deliveries[0].variantId))
      .toMatchObject({ mediaAssetId: variantAssetId, mediaAsset: { mimeType: 'video/mp4' } });
    expect(tx.snsContent.create).toHaveBeenCalledTimes(1);
    expect(tx.snsContentVariant.upsert).toHaveBeenCalledTimes(2);
    expect(tx.snsDelivery.create).toHaveBeenCalledTimes(1);

    const emptyCount = await commonController.preflightContentPlan(
      { id: organizationId } as any,
      contentId,
      { type: 'schedule', integrationIds: [integrationId] }
    );
    expect(emptyCount.deliveries[0]).toMatchObject({
      allowed: true,
      decision: 'allowed',
      policy: { maxPostsPerDay: 2 },
    });

    const now = new Date();
    store.posts = [
      { id: 'prior-1', organizationId, integrationId, state: 'PUBLISHED', publishDate: new Date(now.getTime() - 60_000) },
      { id: 'prior-2', organizationId, integrationId, state: 'QUEUE', publishDate: new Date(now.getTime() - 30_000) },
    ];
    const blocked = await commonController
      .preflightContentPlan(
        { id: organizationId } as any,
        contentId,
        { type: 'schedule', integrationIds: [integrationId] }
      )
      .catch((error) => error);
    expect(blocked).toBeInstanceOf(ConflictException);
    expect(blocked.getResponse()).toMatchObject({
      code: 'COMMON_PUBLISH_POLICY_BLOCKED',
    });
    expect(blocked.getResponse().blockedDeliveries[0]).toMatchObject({
      policy: { maxPostsPerDay: 2 },
    });
    expect(blocked.getResponse().blockedDeliveries[0].reasons).toContainEqual(
      expect.objectContaining({ code: 'posting_limit' })
    );

    store.posts = [
      { id: 'future-post', organizationId, integrationId, state: 'PUBLISHED', publishDate: new Date(now.getTime() + 60_000) },
    ];
    const allowed = await commonController.preflightContentPlan(
      { id: organizationId } as any,
      contentId,
      { type: 'schedule', integrationIds: [integrationId] }
    );
    expect(allowed.deliveries[0]).toMatchObject({ allowed: true, decision: 'allowed' });
    expect(allowed.deliveries[0].policy).toMatchObject({
      autoPostEnabled: true,
      approvalRequired: false,
      maxPostsPerDay: 2,
      sameContentCooldownDays: 0,
    });
    expect(prisma.post.findMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          integrationId,
          publishDate: expect.objectContaining({ lte: expect.any(Date) }),
        }),
      })
    );
    expect(store.content?.status).toBe('READY');
    expect(store.deliveries[0].postId).toBeNull();

    const providerSnapshot = {
      __type: 'tiktok',
      content_posting_method: 'DIRECT_POST',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      duet: false,
      stitch: false,
      comment: true,
    };
    const linkedPlan = await contentController.linkContentPlanPosts(
      { id: organizationId } as any,
      contentId,
      {
        type: 'schedule',
        items: [
          {
            integration: integrationId,
            postId: 'test-only-post-link',
            date: scheduledAt.toISOString(),
            content: 'TikTok caption',
            settings: providerSnapshot,
          },
        ],
      }
    );
    expect(linkedPlan.deliveries[0]).toMatchObject({
      postId: 'test-only-post-link',
      status: 'SCHEDULED',
      settingsOverride: { content_posting_method: 'DIRECT_POST' },
      providerSettingsSnapshot: providerSnapshot,
    });
    expect(linkedPlan.deliveries[0].providerSettingsSnapshot).not.toEqual(
      linkedPlan.deliveries[0].settingsOverride
    );

    store.posts = [];
    store.deliveries = [];
    store.variants = [];
    store.platformOverrides = [];
    store.content = null;
    expect(store).toMatchObject({
      content: null,
      variants: [],
      platformOverrides: [],
      deliveries: [],
      posts: [],
    });
  });
});

describe('SNS Studio account execution lease test harness', () => {
  it('holds a lease for one account, rejects a competing action, permits another account, and releases on completion', async () => {
    const previousEnabled = process.env.ACCOUNT_PROTECTION_ENABLED;
    process.env.ACCOUNT_PROTECTION_ENABLED = 'true';
    jest.useFakeTimers();

    const leases = new Map<string, Record<string, any>>();
    const prisma: any = {
      accountSecurityProfile: {
        upsert: jest.fn(async ({ where }: any) => {
          const input = where.organizationId_accountType_accountId;
          return {
            id: `profile:${input.accountId}`,
            organizationId: input.organizationId,
            accountId: input.accountId,
            provider: 'tiktok',
            enabled: true,
            automationPaused: false,
            securityState: 'ACTIVE',
            pauseReason: null,
            cooldownUntil: null,
          };
        }),
        update: jest.fn().mockResolvedValue({}),
      },
      accountCircuitState: {
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'circuit', failureCount: 0 }),
      },
      accountExecutionLease: {
        updateMany: jest.fn(async ({ where, data }: any) => {
          const current = leases.get(where.securityProfileId);
          if (where.ownerToken) {
            if (current?.ownerToken !== where.ownerToken) return { count: 0 };
            Object.assign(current, data);
            return { count: 1 };
          }
          if (current && current.expiresAt <= where.expiresAt.lte) {
            leases.delete(where.securityProfileId);
            return { count: 1 };
          }
          return { count: 0 };
        }),
        create: jest.fn(async ({ data }: any) => {
          if (leases.has(data.securityProfileId)) {
            throw Object.assign(new Error('unique lease'), { code: 'P2002' });
          }
          leases.set(data.securityProfileId, data);
          return data;
        }),
        deleteMany: jest.fn(async ({ where }: any) => {
          const current = leases.get(where.securityProfileId);
          if (current?.ownerToken === where.ownerToken) {
            leases.delete(where.securityProfileId);
            return { count: 1 };
          }
          return { count: 0 };
        }),
      },
      accountActionBudget: {
        upsert: jest.fn(async ({ where }: any) => ({
          id: `budget:${where.securityProfileId_provider_actionType.securityProfileId}`,
          resetAt: new Date(Date.now() + 60_000),
          windowSeconds: 60,
          maxActions: 1,
        })),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      accountSecurityAuditLog: { create: jest.fn().mockResolvedValue({}) },
    };

    try {
      const protection = new AccountProtectionService(prisma);
      const primaryInput = {
        organizationId: 'org-lease-memory',
        accountId: 'tiktok-personal-lease-memory',
        accountType: 'POSTIZ_INTEGRATION',
        provider: 'tiktok',
        action: 'PUBLISH' as const,
      };
      const otherInput = { ...primaryInput, accountId: 'other-tiktok-account' };

      let enterOperation!: () => void;
      let releaseOperation!: () => void;
      const entered = new Promise<void>((resolve) => { enterOperation = resolve; });
      const hold = new Promise<void>((resolve) => { releaseOperation = resolve; });
      const primary = protection.run(primaryInput, async () => {
        enterOperation();
        await hold;
        return 'primary-complete';
      });
      await entered;

      expect(leases.has(`profile:${primaryInput.accountId}`)).toBe(true);
      const competing = await protection
        .run(primaryInput, async () => 'must-not-run')
        .catch((error) => error);
      expect(competing.getResponse()).toMatchObject({ code: 'ACCOUNT_ACTION_ALREADY_RUNNING' });
      await expect(protection.run(otherInput, async () => 'other-account-complete'))
        .resolves.toBe('other-account-complete');

      const leaseBeforeHeartbeat = leases.get(`profile:${primaryInput.accountId}`)!.expiresAt.getTime();
      await jest.advanceTimersByTimeAsync(30_000);
      const leaseAfterHeartbeat = leases.get(`profile:${primaryInput.accountId}`)!;
      expect(leaseAfterHeartbeat.heartbeatAt).toBeInstanceOf(Date);
      expect(leaseAfterHeartbeat.expiresAt.getTime()).toBeGreaterThan(leaseBeforeHeartbeat);

      releaseOperation();
      await expect(primary).resolves.toBe('primary-complete');
      expect(leases.has(`profile:${primaryInput.accountId}`)).toBe(false);
      expect(prisma.accountExecutionLease.create).toHaveBeenCalledTimes(3);
      expect(prisma.accountExecutionLease.deleteMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
      if (previousEnabled === undefined) delete process.env.ACCOUNT_PROTECTION_ENABLED;
      else process.env.ACCOUNT_PROTECTION_ENABLED = previousEnabled;
    }
  });
});
