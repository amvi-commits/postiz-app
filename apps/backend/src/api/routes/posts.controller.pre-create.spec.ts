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

import { PostsController } from './posts.controller';
import { CommonPublishingService } from '../../services/sns-studio/common-publishing.service';
import { TikTokPublishGuard } from '../../services/sns-studio/tiktok-publish.guard';
import { TikTokPublishAdapter } from '../../services/sns-studio/tiktok-publish.adapter';
import { TikTokCommonPublishPreCreateHook } from '../../services/sns-studio/tiktok-common-publish-pre-create.hook';
import { ProviderPublishPreCreateProtection } from '../../services/posts/provider-publish-pre-create-protection.service';

const organizationId = 'org-common-tiktok-hook';
const planId = 'plan-common-tiktok-hook';
const tiktokIntegrationId = 'integration-personal-tiktok';
const businessIntegrationId = 'integration-tiktok-business';
const instagramIntegrationId = 'integration-instagram';
const testMedia = { id: 'postiz-media-1', path: '/uploads/sns-studio/test.mp4' };

type StoredTestPost = {
  id: string;
  organizationId: string;
  integrationId: string;
  state: 'QUEUE' | 'PUBLISHED';
  publishDate: Date;
  deletedAt: null;
  image: string;
};

function createHarness(options?: {
  rollingPosts?: StoredTestPost[];
  maxPostsPerDay?: number;
}) {
  const integrations = [
    {
      id: tiktokIntegrationId,
      organizationId,
      name: 'Personal TikTok',
      profile: '@personal-test',
      providerIdentifier: 'tiktok',
      token: 'synthetic-test-token',
      tokenExpiration: null as any,
      disabled: false,
      refreshNeeded: false,
      deletedAt: null as any,
    },
    {
      id: businessIntegrationId,
      organizationId,
      name: 'Business TikTok',
      profile: '@business-test',
      providerIdentifier: 'tiktok-business',
      token: 'synthetic-test-token',
      tokenExpiration: null as any,
      disabled: false,
      refreshNeeded: false,
      deletedAt: null as any,
    },
    {
      id: instagramIntegrationId,
      organizationId,
      name: 'Instagram',
      profile: '@instagram-test',
      providerIdentifier: 'instagram',
      token: 'synthetic-test-token',
      tokenExpiration: null as any,
      disabled: false,
      refreshNeeded: false,
      deletedAt: null as any,
    },
  ];
  const integrationsById = new Map(integrations.map((item) => [item.id, item]));
  const storedPosts = [...(options?.rollingPosts || [])];
  const plan = {
    id: planId,
    organizationId,
    originalAssetId: null as any,
    variants: [] as any[],
    deliveries: integrations.map((integration, index) => ({
      id: `delivery-${index + 1}`,
      contentId: planId,
      variantId: null,
      integrationId: integration.id,
      providerIdentifier: integration.providerIdentifier,
      accountName: integration.profile,
      status: 'PLANNED',
      postId: null,
      approvedAt: null,
    })),
  };
  const commonPolicy = {
    autoPostEnabled: true,
    approvalRequired: false,
    maxPostsPerDay: options?.maxPostsPerDay ?? 2,
    sameContentCooldownDays: 0,
  };
  const commonPolicyKey = (id: string) => `sns:common:account-policy:v1:${id}`;
  const prisma: any = {
    integration: {
      findFirst: jest.fn(async ({ where }: any) =>
        integrationsById.get(where.id) || null
      ),
      findMany: jest.fn(async ({ where }: any) =>
        where.id?.in
          ? where.id.in.map((id: string) => integrationsById.get(id)).filter(Boolean)
          : integrations
      ),
    },
    snsAppSetting: {
      findUnique: jest.fn(async ({ where }: any) =>
        where.organizationId_key.key.startsWith('sns:tiktok:account:')
          ? { value: { duplicateWindowDays: 30 } }
          : null
      ),
      findMany: jest.fn(async ({ where }: any) =>
        where.key.in
          .filter((key: string) => key.startsWith('sns:common:account-policy:v1:'))
          .map((key: string) => ({ key, value: commonPolicy }))
      ),
    },
    snsContent: {
      findFirst: jest.fn(async ({ where }: any) =>
        where.id === planId && where.organizationId === organizationId ? plan : null
      ),
    },
    post: {
      findMany: jest.fn(async ({ where }: any) =>
        storedPosts.filter((post) => {
          const start = where.publishDate?.gte;
          const end = where.publishDate?.lte;
          return (
            post.organizationId === where.organizationId &&
            post.integrationId === where.integrationId &&
            post.deletedAt === null &&
            ['QUEUE', 'PUBLISHED'].includes(post.state) &&
            post.publishDate >= start &&
            post.publishDate <= end
          );
        })
      ),
    },
  };

  const temporalStart = jest.fn();
  const mapTypeToPostImplementation = async (rawBody: any) => ({
    ...rawBody,
    posts: rawBody.posts.map((post: any) => {
      const integration = integrationsById.get(post.integration.id)!;
      return {
        ...post,
        settings: {
          ...(post.settings || {}),
          __type: integration.providerIdentifier,
        },
      };
    }),
  });
  const createPostImplementation = async (_orgId: string, body: any) => {
    const created = body.posts.map((post: any, index: number) => {
      const postId = `created-${storedPosts.length + index + 1}`;
      storedPosts.push({
        id: postId,
        organizationId,
        integrationId: post.integration.id,
        state: 'QUEUE',
        publishDate: new Date(body.date),
        deletedAt: null,
        image: JSON.stringify(post.value[0].image),
      });
      temporalStart(postId);
      return { postId, integration: post.integration.id };
    });
    return created;
  };
  const postsService: any = {
    validatePosts: jest.fn(async (_orgId: string, posts: any[]) =>
      posts.map((post) => ({
        identifier: integrationsById.get(post.integration.id)?.providerIdentifier,
        name: integrationsById.get(post.integration.id)?.name,
        emptyContent: false,
        valid: true,
        settingsError: '',
        errors: true,
        tooLong: false,
        maximumCharacters: 2000,
      }))
    ),
    mapTypeToPost: jest.fn(mapTypeToPostImplementation),
    createPost: jest.fn(createPostImplementation),
  };
  const commonPublishingService = new CommonPublishingService(prisma);
  const guard = new TikTokPublishGuard(prisma);
  const adapter = new TikTokPublishAdapter(
    prisma,
    postsService,
    {
      getSocialIntegration: jest.fn(() => ({
        maxVideoLength: jest.fn().mockResolvedValue({ maxDurationSeconds: 600 }),
      })),
    } as any,
    { refresh: jest.fn() } as any,
    guard,
    commonPublishingService
  );
  const hook = new TikTokCommonPublishPreCreateHook(adapter, guard);
  const protection = new ProviderPublishPreCreateProtection([hook]);
  const controller = new PostsController(
    postsService,
    {} as any,
    {} as any,
    commonPublishingService,
    protection
  );

  const postBody = (
    integrationIds: string[],
    overrides?: {
      type?: 'now' | 'schedule' | 'draft';
      media?: typeof testMedia;
      publishDate?: string;
    }
  ) => ({
    type: overrides?.type || 'now',
    shortLink: false,
    date: overrides?.publishDate || new Date().toISOString(),
    tags: [] as any[],
    snsStudioContentPlanId: planId,
    posts: integrationIds.map((integrationId) => ({
      integration: { id: integrationId },
      value: [
        {
          id: 'value-1',
          delay: 0,
          content: 'SNS Studio TikTok test',
          image: overrides?.media ? [overrides.media] : [testMedia],
        },
      ],
      settings: {
        content_posting_method: 'DIRECT_POST',
        privacy_level: 'PUBLIC_TO_EVERYONE',
        consentConfirmed: true,
        consentConfirmedAt: new Date().toISOString(),
      },
    })),
  });

  return {
    adapter,
    commonPublishingService,
    controller,
    guard,
    plan,
    postBody,
    postsService,
    mapTypeToPostImplementation,
    createPostImplementation,
    prisma,
    storedPosts,
    temporalStart,
  };
}

describe('PostsController TikTok Personal pre-create protection', () => {
  it('preserves the formal mapTypeToPost → PostsService.createPost path and rechecks policy under the TikTok mutex', async () => {
    const harness = createHarness();
    expect((harness.adapter as any).publishGuard).toBe(harness.guard);
    expect(typeof harness.guard.check).toBe('function');
    const order: string[] = [];
    const assertPlan = harness.commonPublishingService.assertPlanAllowsPost.bind(
      harness.commonPublishingService
    );
    jest
      .spyOn(harness.commonPublishingService, 'assertPlanAllowsPost')
      .mockImplementation(async (...args) => {
        order.push('common-policy');
        return assertPlan(...args);
      });
    const originalPreflight = harness.adapter.preflight.bind(harness.adapter);
    const preflight = jest
      .spyOn(harness.adapter, 'preflight')
      .mockImplementation(async (...args) => {
        order.push('provider-preflight');
        return originalPreflight(...args);
      });
    const originalWithLocks = harness.guard.withIntegrationLocks.bind(
      harness.guard
    );
    const withLocks = jest
      .spyOn(harness.guard, 'withIntegrationLocks')
      .mockImplementation((orgId, integrationIds, operation) =>
        originalWithLocks(orgId, integrationIds, async () => {
          order.push('mutex-acquired');
          return operation();
        })
      );
    jest
      .spyOn(harness.postsService, 'createPost')
      .mockImplementation(async (...args: any[]) => {
        order.push('createPost');
        return (harness.createPostImplementation as any)(...args);
      });

    await expect(
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([tiktokIntegrationId])
      )
    ).resolves.toHaveLength(1);

    expect(harness.postsService.mapTypeToPost).toHaveBeenCalledTimes(1);
    expect(withLocks).toHaveBeenCalledWith(
      organizationId,
      [tiktokIntegrationId],
      expect.any(Function)
    );
    expect(preflight).toHaveBeenCalledWith(
      organizationId,
      expect.objectContaining({
        integrationId: tiktokIntegrationId,
        content: 'SNS Studio TikTok test',
        media: [testMedia],
        mode: 'now',
        settings: expect.objectContaining({ __type: 'tiktok' }),
      })
    );
    expect(harness.postsService.createPost).toHaveBeenCalledTimes(1);
    expect(order).toEqual([
      'common-policy',
      'mutex-acquired',
      'common-policy',
      'provider-preflight',
      'createPost',
    ]);
    expect(
      harness.postsService.createPost.mock.invocationCallOrder[0]
    ).toBeGreaterThan(
      (harness.commonPublishingService.assertPlanAllowsPost as any).mock.invocationCallOrder[1]
    );
  });

  it('does not call PostsService.createPost when TikTok duplicate guard blocks', async () => {
    const harness = createHarness({
      rollingPosts: [
        {
          id: 'existing-duplicate',
          organizationId,
          integrationId: tiktokIntegrationId,
          state: 'PUBLISHED',
          publishDate: new Date(Date.now() - 60_000),
          deletedAt: null,
          image: JSON.stringify([testMedia]),
        },
      ],
    });

    await expect(
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([tiktokIntegrationId])
      )
    ).rejects.toMatchObject({
      response: { code: 'TIKTOK_DUPLICATE_MEDIA' },
    });

    expect(harness.postsService.createPost).not.toHaveBeenCalled();
    expect(harness.temporalStart).not.toHaveBeenCalled();
  });

  it('does not apply the Personal hook to TikTok Business', async () => {
    const harness = createHarness();
    const withLocks = jest.spyOn(harness.guard, 'withIntegrationLocks');
    const preflight = jest.spyOn(harness.adapter, 'preflight');

    await expect(
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([businessIntegrationId])
      )
    ).resolves.toHaveLength(1);

    expect(withLocks).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(harness.postsService.createPost).toHaveBeenCalledTimes(1);
  });

  it('leaves non-TikTok posts and mixed cross-post mapping intact', async () => {
    const harness = createHarness();
    const withLocks = jest.spyOn(harness.guard, 'withIntegrationLocks');
    const preflight = jest.spyOn(harness.adapter, 'preflight');
    const policyCheck = jest.spyOn(
      harness.commonPublishingService,
      'assertPlanAllowsPost'
    );
    const response = await harness.controller.createPost(
      { id: organizationId } as any,
      harness.postBody([tiktokIntegrationId, instagramIntegrationId])
    );

    expect(response).toHaveLength(2);
    expect(withLocks).toHaveBeenCalledWith(
      organizationId,
      [tiktokIntegrationId],
      expect.any(Function)
    );
    expect(preflight).toHaveBeenCalledTimes(1);
    expect(policyCheck).toHaveBeenCalledTimes(2);
    expect(policyCheck.mock.calls[0][3]).toHaveLength(2);
    expect(policyCheck.mock.calls[1][3]).toHaveLength(1);
    expect((policyCheck.mock.calls[1][3] as any)[0].integration.id).toBe(
      tiktokIntegrationId
    );
    expect(harness.postsService.createPost).toHaveBeenCalledWith(
      organizationId,
      expect.objectContaining({
        posts: expect.arrayContaining([
          expect.objectContaining({ settings: expect.objectContaining({ __type: 'tiktok' }) }),
          expect.objectContaining({ settings: expect.objectContaining({ __type: 'instagram' }) }),
        ]),
      }),
      'WEB'
    );
  });

  it('keeps the existing UPLOAD mode outside the new Direct Post hook', async () => {
    const harness = createHarness();
    const withLocks = jest.spyOn(harness.guard, 'withIntegrationLocks');
    const preflight = jest.spyOn(harness.adapter, 'preflight');

    await harness.controller.createPost(
      { id: organizationId } as any,
      {
        ...harness.postBody([tiktokIntegrationId]),
        posts: harness.postBody([tiktokIntegrationId]).posts.map((post: any) => ({
          ...post,
          settings: { content_posting_method: 'UPLOAD' },
        })),
      }
    );

    expect(withLocks).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(harness.postsService.createPost).toHaveBeenCalledTimes(1);
  });

  it('serializes two same-account requests and blocks the second at the 1/2 daily limit', async () => {
    const firstRollingPost: StoredTestPost = {
      id: 'existing-different-media',
      organizationId,
      integrationId: tiktokIntegrationId,
      state: 'PUBLISHED',
      publishDate: new Date(Date.now() - 60_000),
      deletedAt: null,
      image: JSON.stringify([{ id: 'older-media', path: '/uploads/older.mp4' }]),
    };
    const harness = createHarness({ rollingPosts: [firstRollingPost] });
    const policyRecheck = jest.spyOn(
      harness.commonPublishingService,
      'assertPlanAllowsPost'
    );
    let mapCalls = 0;
    let releaseMapping!: () => void;
    const bothMapped = new Promise<void>((resolve) => {
      releaseMapping = resolve;
    });
    jest
      .spyOn(harness.postsService, 'mapTypeToPost')
      .mockImplementation(async (...args: any[]) => {
        mapCalls += 1;
        if (mapCalls === 2) releaseMapping();
        await bothMapped;
        return (harness.mapTypeToPostImplementation as any)(...args);
      });
    const results = await Promise.allSettled([
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([tiktokIntegrationId])
      ),
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([tiktokIntegrationId])
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'rejected',
          reason: expect.objectContaining({
            response: expect.objectContaining({ code: 'COMMON_PUBLISH_POLICY_BLOCKED' }),
          }),
        }),
      ])
    );
    expect(harness.postsService.createPost).toHaveBeenCalledTimes(1);
    expect(policyRecheck).toHaveBeenCalledTimes(4);
    expect(harness.storedPosts).toHaveLength(2);
    expect(harness.temporalStart).toHaveBeenCalledTimes(1);
  });

  it('serializes duplicate-media requests and creates exactly one post', async () => {
    const harness = createHarness();
    const preflight = jest.spyOn(harness.adapter, 'preflight');
    let mapCalls = 0;
    let releaseMapping!: () => void;
    const bothMapped = new Promise<void>((resolve) => {
      releaseMapping = resolve;
    });
    jest
      .spyOn(harness.postsService, 'mapTypeToPost')
      .mockImplementation(async (...args: any[]) => {
        mapCalls += 1;
        if (mapCalls === 2) releaseMapping();
        await bothMapped;
        return (harness.mapTypeToPostImplementation as any)(...args);
      });
    const results = await Promise.allSettled([
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([tiktokIntegrationId])
      ),
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([tiktokIntegrationId])
      ),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: 'rejected',
          reason: expect.objectContaining({
            response: expect.objectContaining({ code: 'TIKTOK_DUPLICATE_MEDIA' }),
          }),
        }),
      ])
    );
    expect(harness.postsService.createPost).toHaveBeenCalledTimes(1);
    expect(preflight).toHaveBeenCalledTimes(2);
    expect(harness.storedPosts).toHaveLength(1);
    expect(harness.temporalStart).toHaveBeenCalledTimes(1);
  });

  it('checks scheduled duplicates against the selected publishDate', async () => {
    const previousSchedule = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const requestedSchedule = new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
    const harness = createHarness({
      rollingPosts: [
        {
          id: 'future-scheduled-duplicate',
          organizationId,
          integrationId: tiktokIntegrationId,
          state: 'QUEUE',
          publishDate: previousSchedule,
          deletedAt: null,
          image: JSON.stringify([testMedia]),
        },
      ],
    });
    const preflight = jest.spyOn(harness.adapter, 'preflight');

    await expect(
      harness.controller.createPost(
        { id: organizationId } as any,
        harness.postBody([tiktokIntegrationId], {
          type: 'schedule',
          publishDate: requestedSchedule.toISOString(),
        })
      )
    ).rejects.toMatchObject({
      response: { code: 'TIKTOK_DUPLICATE_MEDIA' },
    });

    expect(harness.postsService.createPost).not.toHaveBeenCalled();
    expect(harness.temporalStart).not.toHaveBeenCalled();
    expect(preflight).toHaveBeenCalledWith(
      organizationId,
      expect.objectContaining({
        publishDate: requestedSchedule.toISOString(),
      })
    );
  });

  it('rejects scheduled TikTok Personal DIRECT_POST when explicit consent is missing (TIKTOK_CONSENT_REQUIRED)', async () => {
    const harness = createHarness();
    const body = harness.postBody([tiktokIntegrationId], { type: 'schedule' });
    // Remove consent
    body.posts[0].settings = {
      content_posting_method: 'DIRECT_POST',
      privacy_level: 'PUBLIC_TO_EVERYONE',
      consentConfirmed: false,
    };

    await expect(
      harness.controller.createPost({ id: organizationId } as any, body)
    ).rejects.toMatchObject({
      response: { code: 'TIKTOK_CONSENT_REQUIRED' },
    });
    expect(harness.postsService.createPost).not.toHaveBeenCalled();
  });

  it('rejects scheduled TikTok Personal DIRECT_POST when privacy_level is missing (TIKTOK_PRIVACY_SELECTION_REQUIRED)', async () => {
    const harness = createHarness();
    const body = harness.postBody([tiktokIntegrationId], { type: 'schedule' });
    // Remove privacy_level
    body.posts[0].settings = {
      content_posting_method: 'DIRECT_POST',
      consentConfirmed: true,
    };

    await expect(
      harness.controller.createPost({ id: organizationId } as any, body)
    ).rejects.toMatchObject({
      response: { code: 'TIKTOK_PRIVACY_SELECTION_REQUIRED' },
    });
    expect(harness.postsService.createPost).not.toHaveBeenCalled();
  });
});
