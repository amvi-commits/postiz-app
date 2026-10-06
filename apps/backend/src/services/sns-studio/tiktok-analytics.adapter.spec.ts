jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/integrations/integration.service',
  () => ({ IntegrationService: class IntegrationService {} })
);
jest.mock('@gitroom/nestjs-libraries/database/prisma/posts/posts.service', () => ({
  PostsService: class PostsService {},
}));
jest.mock('@gitroom/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { State } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import type { AnalyticsData } from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { TikTokAnalyticsAdapter } from './tiktok-analytics.adapter';

const organization = { id: 'org_1' } as any;
const ACCOUNT_ANALYTICS: AnalyticsData[] = [
  ['Followers', '1000'],
  ['Following', '100'],
  ['Total Likes', '5000'],
  ['Videos', '50'],
  ['Views', '20000'],
  ['Recent Likes', '1500'],
  ['Recent Comments', '120'],
  ['Recent Shares', '80'],
].map(([label, total]) => ({
  label,
  percentageChange: 0,
  data: [{ total, date: '2026-10-02' }],
}));

const POST_ANALYTICS: AnalyticsData[] = [
  ['Views', '10000'],
  ['Likes', '500'],
  ['Comments', '30'],
  ['Shares', '20'],
].map(([label, total]) => ({
  label,
  percentageChange: 0,
  data: [{ total, date: '2026-10-02' }],
}));

function makeSetup() {
  const prisma: any = {
    integration: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'integration_1',
        providerIdentifier: 'tiktok',
      }),
    },
    post: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'post_1',
        state: State.PUBLISHED,
        error: null,
        releaseId: 'release_1',
        releaseURL: null,
        integration: { providerIdentifier: 'tiktok' },
      }),
    },
  };
  const integrationService = {
    checkAnalytics: jest.fn().mockResolvedValue(ACCOUNT_ANALYTICS),
  };
  const postsService = {
    checkPostAnalytics: jest.fn().mockResolvedValue(POST_ANALYTICS),
  };

  return {
    prisma,
    integrationService,
    postsService,
    adapter: new TikTokAnalyticsAdapter(prisma, integrationService as any, postsService as any),
  };
}

describe('TikTokAnalyticsAdapter', () => {
  afterEach(() => jest.useRealTimers());

  describe('account analytics', () => {
    it.each([
      ['tiktok', 'personal'],
      ['tiktok-business', 'business'],
    ])('allows %s integrations as %s accounts', async (providerIdentifier, accountType) => {
      const { prisma, adapter } = makeSetup();
      prisma.integration.findFirst.mockResolvedValue({ id: 'integration_1', providerIdentifier });

      const response = await adapter.getAccountAnalytics(organization, 'integration_1');

      expect(response).toMatchObject({
        status: 'available',
        integrationId: 'integration_1',
        platform: 'tiktok',
        providerIdentifier,
        accountType,
      });
    });

    it('rejects integrations belonging to another organization', async () => {
      const { prisma, adapter } = makeSetup();
      prisma.integration.findFirst.mockResolvedValue(null);

      await expect(adapter.getAccountAnalytics(organization, 'foreign')).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(prisma.integration.findFirst).toHaveBeenCalledWith({
        where: { id: 'foreign', organizationId: organization.id, deletedAt: null },
        select: { id: true, providerIdentifier: true },
      });
    });

    it('rejects deleted integrations', async () => {
      const { prisma, adapter } = makeSetup();
      prisma.integration.findFirst.mockResolvedValue(null);

      await expect(adapter.getAccountAnalytics(organization, 'deleted')).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('rejects a non-TikTok integration', async () => {
      const { prisma, adapter } = makeSetup();
      prisma.integration.findFirst.mockResolvedValue({
        id: 'integration_1',
        providerIdentifier: 'instagram',
      });

      await expect(adapter.getAccountAnalytics(organization, 'integration_1')).rejects.toMatchObject({
        response: { code: 'TIKTOK_INTEGRATION_NOT_TIKTOK' },
      });
    });

    it('delegates account retrieval to IntegrationService.checkAnalytics', async () => {
      const { adapter, integrationService } = makeSetup();

      await adapter.getAccountAnalytics(organization, 'integration_1', '1700000000000');

      expect(integrationService.checkAnalytics).toHaveBeenCalledWith(
        organization,
        'integration_1',
        '1700000000000'
      );
    });

    it('normalizes every supported account metric without changing explicit values', async () => {
      const { adapter } = makeSetup();

      const response = await adapter.getAccountAnalytics(organization, 'integration_1');

      expect(response).toMatchObject({
        metrics: {
          followers: 1000,
          following: 100,
          totalLikes: 5000,
          videos: 50,
          recentViews: 20000,
          recentLikes: 1500,
          recentComments: 120,
          recentShares: 80,
        },
      });
    });

    it('preserves a provider-reported zero as numeric zero', async () => {
      const { adapter, integrationService } = makeSetup();
      integrationService.checkAnalytics.mockResolvedValue([
        { label: 'Followers', percentageChange: 0, data: [{ total: '0', date: '2026-10-02' }] },
      ]);

      const response = await adapter.getAccountAnalytics(organization, 'integration_1');

      expect(response).toMatchObject({ status: 'available', metrics: { followers: 0 } });
    });

    it('leaves unreported account metrics null', async () => {
      const { adapter, integrationService } = makeSetup();
      integrationService.checkAnalytics.mockResolvedValue([
        { label: 'Followers', percentageChange: 0, data: [{ total: '8', date: '2026-10-02' }] },
      ]);

      const response = await adapter.getAccountAnalytics(organization, 'integration_1');

      expect(response).toMatchObject({
        status: 'available',
        metrics: {
          followers: 8,
          following: null,
          totalLikes: null,
          videos: null,
          recentViews: null,
          recentLikes: null,
          recentComments: null,
          recentShares: null,
        },
      });
    });

    it('does not coerce malformed metric strings such as hexadecimal to zero', async () => {
      const { adapter, integrationService } = makeSetup();
      integrationService.checkAnalytics.mockResolvedValue([
        { label: 'Followers', percentageChange: 0, data: [{ total: '0x0', date: '2026-10-02' }] },
      ]);

      const response = await adapter.getAccountAnalytics(organization, 'integration_1');

      expect(response).toMatchObject({ status: 'available', metrics: { followers: null } });
    });

    it('treats an empty provider response as unavailable, not zero', async () => {
      const { adapter, integrationService } = makeSetup();
      integrationService.checkAnalytics.mockResolvedValue([]);

      await expect(adapter.getAccountAnalytics(organization, 'integration_1')).resolves.toMatchObject({
        status: 'unavailable',
        metrics: null,
        errorCode: 'TIKTOK_ANALYTICS_UNAVAILABLE',
      });
    });

    it('normalizes thrown Postiz errors without returning integration credentials', async () => {
      const { adapter, integrationService, prisma } = makeSetup();
      prisma.integration.findFirst.mockResolvedValue({
        id: 'integration_1',
        providerIdentifier: 'tiktok',
        token: 'access-token-secret',
        refreshToken: 'refresh-token-secret',
      });
      integrationService.checkAnalytics.mockRejectedValue(new Error('provider failure'));

      const response = await adapter.getAccountAnalytics(organization, 'integration_1');

      expect(response).toMatchObject({ status: 'error', metrics: null, errorCode: 'TIKTOK_ANALYTICS_ERROR' });
      expect(JSON.stringify(response)).not.toContain('access-token-secret');
      expect(JSON.stringify(response)).not.toContain('refresh-token-secret');
    });

    it('uses a stable UTC-midnight date key for repeated calls on the same day', async () => {
      const { adapter, integrationService } = makeSetup();
      jest.useFakeTimers().setSystemTime(new Date('2026-10-02T18:45:12.345Z'));

      await adapter.getAccountAnalytics(organization, 'integration_1');
      await adapter.getAccountAnalytics(organization, 'integration_1');

      expect(integrationService.checkAnalytics.mock.calls.map((call) => call[2])).toEqual([
        String(Date.UTC(2026, 9, 2)),
        String(Date.UTC(2026, 9, 2)),
      ]);
    });

    it.each(['NaN', '-1', 'today', '', '0x10', '1e6'])('rejects invalid date %p', async (date) => {
      const { adapter } = makeSetup();

      await expect(adapter.getAccountAnalytics(organization, 'integration_1', date)).rejects.toBeInstanceOf(
        BadRequestException
      );
    });
  });

  describe('post analytics', () => {
    it('rejects posts belonging to another organization', async () => {
      const { prisma, adapter } = makeSetup();
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(adapter.getPostAnalytics(organization, 'foreign_post')).rejects.toBeInstanceOf(
        NotFoundException
      );
      expect(prisma.post.findFirst).toHaveBeenCalledWith({
        where: { id: 'foreign_post', organizationId: organization.id, deletedAt: null },
        select: {
          id: true,
          state: true,
          error: true,
          releaseId: true,
          releaseURL: true,
          integration: { select: { providerIdentifier: true } },
        },
      });
    });

    it('rejects deleted posts', async () => {
      const { prisma, adapter } = makeSetup();
      prisma.post.findFirst.mockResolvedValue(null);

      await expect(adapter.getPostAnalytics(organization, 'deleted_post')).rejects.toBeInstanceOf(
        NotFoundException
      );
    });

    it('rejects posts for another provider', async () => {
      const { prisma, adapter } = makeSetup();
      prisma.post.findFirst.mockResolvedValue({
        id: 'post_1',
        state: State.PUBLISHED,
        integration: { providerIdentifier: 'instagram' },
      });

      await expect(adapter.getPostAnalytics(organization, 'post_1')).rejects.toMatchObject({
        response: { code: 'TIKTOK_POST_NOT_TIKTOK' },
      });
    });

    it.each([
      [State.DRAFT, 'draft'],
      [State.QUEUE, 'pending'],
      [State.ERROR, 'error'],
    ])('maps %s without requesting Postiz analytics', async (state, status) => {
      const { prisma, postsService, adapter } = makeSetup();
      prisma.post.findFirst.mockResolvedValue({
        id: 'post_1',
        state,
        error: 'Postiz publish error',
        releaseId: 'release_1',
        releaseURL: null,
        integration: { providerIdentifier: 'tiktok' },
      });

      const response = await adapter.getPostAnalytics(organization, 'post_1');

      expect(response).toMatchObject({ status, metrics: null, postState: state });
      expect(postsService.checkPostAnalytics).not.toHaveBeenCalled();
      if (state === State.ERROR) {
        expect(response).toMatchObject({
          errorCode: 'TIKTOK_POST_ERROR',
          errorMessage: 'Postiz publish error',
        });
      }
    });

    it('returns pending while a published Post has no releaseId', async () => {
      const { prisma, postsService, adapter } = makeSetup();
      prisma.post.findFirst.mockResolvedValue({
        id: 'post_1',
        state: State.PUBLISHED,
        releaseId: null,
        integration: { providerIdentifier: 'tiktok' },
      });

      await expect(adapter.getPostAnalytics(organization, 'post_1')).resolves.toMatchObject({
        status: 'pending',
        errorCode: 'TIKTOK_RELEASE_ID_PENDING',
        metrics: null,
      });
      expect(postsService.checkPostAnalytics).not.toHaveBeenCalled();
    });

    it('delegates published post retrieval to PostsService.checkPostAnalytics', async () => {
      const { adapter, postsService } = makeSetup();

      await adapter.getPostAnalytics(organization, 'post_1', '1700000000000');

      expect(postsService.checkPostAnalytics).toHaveBeenCalledWith(
        organization.id,
        'post_1',
        1700000000000
      );
    });

    it('normalizes all post metrics and returns the stored release metadata', async () => {
      const { adapter, prisma } = makeSetup();
      prisma.post.findFirst.mockResolvedValue({
        id: 'post_1',
        state: State.PUBLISHED,
        releaseId: 'release_1',
        releaseURL: 'https://www.tiktok.com/@creator/video/123',
        integration: { providerIdentifier: 'tiktok-business' },
      });

      const response = await adapter.getPostAnalytics(organization, 'post_1');

      expect(response).toMatchObject({
        status: 'available',
        postId: 'post_1',
        platform: 'tiktok',
        providerIdentifier: 'tiktok-business',
        releaseId: 'release_1',
        releaseURL: 'https://www.tiktok.com/@creator/video/123',
        metrics: { views: 10000, likes: 500, comments: 30, shares: 20 },
      });
    });

    it('preserves explicit post metric zero and leaves missing metrics null', async () => {
      const { adapter, postsService } = makeSetup();
      postsService.checkPostAnalytics.mockResolvedValue([
        { label: 'Views', percentageChange: 0, data: [{ total: '0', date: '2026-10-02' }] },
      ]);

      await expect(adapter.getPostAnalytics(organization, 'post_1')).resolves.toMatchObject({
        status: 'available',
        metrics: { views: 0, likes: null, comments: null, shares: null },
      });
    });

    it('maps an empty post analytics array to unavailable instead of zero', async () => {
      const { adapter, postsService } = makeSetup();
      postsService.checkPostAnalytics.mockResolvedValue([]);

      await expect(adapter.getPostAnalytics(organization, 'post_1')).resolves.toMatchObject({
        status: 'unavailable',
        errorCode: 'TIKTOK_POST_ANALYTICS_UNAVAILABLE',
        metrics: null,
      });
    });

    it('maps Postiz missing responses to missing', async () => {
      const { adapter, postsService } = makeSetup();
      postsService.checkPostAnalytics.mockResolvedValue({ missing: true } as any);

      await expect(adapter.getPostAnalytics(organization, 'post_1')).resolves.toMatchObject({
        status: 'missing',
        errorCode: 'TIKTOK_POST_MISSING',
        metrics: null,
      });
    });

    it('omits releaseURL when Postiz has no URL instead of generating one', async () => {
      const { adapter, prisma } = makeSetup();
      prisma.post.findFirst.mockResolvedValue({
        id: 'post_1',
        state: State.PUBLISHED,
        releaseId: 'release_1',
        releaseURL: null,
        integration: { providerIdentifier: 'tiktok' },
      });

      const response = await adapter.getPostAnalytics(organization, 'post_1');

      expect(response).not.toHaveProperty('releaseURL');
    });

    it('uses the same UTC-midnight date number for repeated post requests', async () => {
      const { adapter, postsService } = makeSetup();
      jest.useFakeTimers().setSystemTime(new Date('2026-10-02T18:45:12.345Z'));

      await adapter.getPostAnalytics(organization, 'post_1');
      await adapter.getPostAnalytics(organization, 'post_1');

      expect(postsService.checkPostAnalytics.mock.calls.map((call) => call[2])).toEqual([
        Date.UTC(2026, 9, 2),
        Date.UTC(2026, 9, 2),
      ]);
    });

    it('normalizes Postiz exceptions to a safe error response', async () => {
      const { adapter, postsService } = makeSetup();
      postsService.checkPostAnalytics.mockRejectedValue(new Error('secret-token failure'));

      const response = await adapter.getPostAnalytics(organization, 'post_1');

      expect(response).toMatchObject({
        status: 'error',
        errorCode: 'TIKTOK_POST_ANALYTICS_ERROR',
        metrics: null,
      });
      expect(JSON.stringify(response)).not.toContain('secret-token');
    });
  });

  it('does not call a TikTok provider or expose one from the adapter', () => {
    const adapterPath = path.resolve(__dirname, './tiktok-analytics.adapter.ts');
    const source = fs.readFileSync(adapterPath, 'utf8');

    expect(source).not.toMatch(/TiktokProvider|TiktokBusinessProvider/);
    expect(source).not.toMatch(/\.analytics\s*\(|\.postAnalytics\s*\(/);
    expect(source).toContain('this.integrationService.checkAnalytics');
    expect(source).toContain('this.postsService.checkPostAnalytics');
  });
});
