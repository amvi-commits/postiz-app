jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/prisma.service',
  () => ({ PrismaService: class PrismaService {} }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/openai/openai.service',
  () => ({ OpenaiService: class OpenaiService {} }),
  { virtual: true }
);

import { ThreadsStudioService } from './threads-studio.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import type { Organization } from '@prisma/client';

describe('ThreadsStudioService - Browser Account Connection and Fail-Closed Guards', () => {
  let service: ThreadsStudioService;
  let mockPrisma: any;
  let mockIntegrationManager: any;
  let mockOpenaiService: any;
  let mockThreadsProvider: any;

  const mockOrg: Organization = {
    id: 'org_test_123',
    name: 'Test Org',
    createdAt: new Date(),
    updatedAt: new Date(),
  } as any;

  beforeEach(() => {
    mockThreadsProvider = {
      verifyBrowserTransport: jest.fn(),
      getBrowserProfile: jest.fn(),
      fetchUserThreads: jest.fn(),
      fetchConversation: jest.fn(),
      fetchPendingReplies: jest.fn(),
      replyToThread: jest.fn(),
      manageReply: jest.fn(),
      managePendingReply: jest.fn(),
      keywordSearch: jest.fn(),
      searchLocations: jest.fn(),
      fetchPublishingLimit: jest.fn(),
      postAnalytics: jest.fn(),
    };

    mockIntegrationManager = {
      getSocialIntegration: jest.fn((id: string) => {
        if (id === 'threads') return mockThreadsProvider;
        return null;
      }),
    };

    mockOpenaiService = {};

    mockPrisma = {
      integration: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        findUnique: jest.fn(),
        upsert: jest.fn(),
      },
      snsThreadsAccountSetting: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
      },
      snsThreadsPostMetadata: {
        findMany: jest.fn().mockResolvedValue([]),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      snsThreadsInboxItem: {
        findFirst: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        upsert: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
      },
      post: {
        findMany: jest.fn().mockResolvedValue([]),
        findFirst: jest.fn(),
      },
    };

    service = new ThreadsStudioService(
      mockPrisma,
      mockIntegrationManager,
      mockOpenaiService
    );
  });

  describe('getAccounts metadata enrichment', () => {
    it('enriches browser accounts with isBrowser: true and transport: browser', async () => {
      mockPrisma.integration.findMany.mockResolvedValue([
        {
          id: 'int_official',
          name: 'Official User',
          profile: 'official_user',
          picture: null,
          inBetweenSteps: false,
          refreshNeeded: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          internalId: '12345678',
          customInstanceDetails: null,
          additionalSettings: null,
          providerIdentifier: 'threads',
        },
        {
          id: 'int_browser',
          name: 'Browser User',
          profile: 'browser_user',
          picture: 'https://example.com/pic.jpg',
          inBetweenSteps: false,
          refreshNeeded: false,
          createdAt: new Date(),
          updatedAt: new Date(),
          internalId: 'threads_browser_main',
          customInstanceDetails: JSON.stringify({
            transport: 'browser',
            browserAccount: 'main',
            profileUrl: 'https://www.threads.net/@browser_user',
          }),
          additionalSettings: JSON.stringify([
            { title: 'transport', value: 'browser' },
            { title: 'browserAccount', value: 'main' },
          ]),
          providerIdentifier: 'threads',
        },
      ]);

      const accounts = await service.getAccounts(mockOrg);
      expect(accounts).toHaveLength(2);

      const official = accounts.find((a) => a.id === 'int_official')!;
      expect(official.isBrowser).toBe(false);
      expect(official.transport).toBe('official_api');
      expect(official.browserAccount).toBeNull();

      const browser = accounts.find((a) => a.id === 'int_browser')!;
      expect(browser.isBrowser).toBe(true);
      expect(browser.transport).toBe('browser');
      expect(browser.browserAccount).toBe('main');
    });
  });

  describe('connectBrowserAccount', () => {
    it('rejects invalid account names with special characters', async () => {
      await expect(
        service.connectBrowserAccount(mockOrg, { account: 'invalid account!' })
      ).rejects.toThrow(BadRequestException);

      await expect(
        service.connectBrowserAccount(mockOrg, { account: '../path_traversal' })
      ).rejects.toThrow(BadRequestException);
    });

    it('throws THREADS_BROWSER_UNREACHABLE when Sidecar is not healthy', async () => {
      mockThreadsProvider.verifyBrowserTransport.mockResolvedValue({
        transport: 'browser',
        allowRealPost: false,
        sidecarUrl: 'http://127.0.0.1:8017',
        health: { status: 'error', error: 'Connection refused' },
      });

      await expect(
        service.connectBrowserAccount(mockOrg, { account: 'main' })
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'THREADS_BROWSER_UNREACHABLE',
        }),
      });
    });

    it('throws THREADS_BROWSER_AUTH_REQUIRED when Sidecar session is not SESSION_OK', async () => {
      mockThreadsProvider.verifyBrowserTransport.mockResolvedValue({
        transport: 'browser',
        allowRealPost: false,
        sidecarUrl: 'http://127.0.0.1:8017',
        health: { status: 'ok' },
        session: { session_status: 'AUTH_REQUIRED' },
      });

      await expect(
        service.connectBrowserAccount(mockOrg, { account: 'main' })
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'THREADS_BROWSER_AUTH_REQUIRED',
        }),
      });
    });

    it('throws THREADS_BROWSER_PROFILE_ERROR when profile fetch fails', async () => {
      mockThreadsProvider.verifyBrowserTransport.mockResolvedValue({
        transport: 'browser',
        allowRealPost: false,
        sidecarUrl: 'http://127.0.0.1:8017',
        health: { status: 'ok' },
        session: { session_status: 'SESSION_OK' },
      });
      mockThreadsProvider.getBrowserProfile.mockRejectedValue(
        new Error('Failed to scrape profile')
      );

      await expect(
        service.connectBrowserAccount(mockOrg, { account: 'main' })
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'THREADS_BROWSER_PROFILE_ERROR',
        }),
      });
    });

    it('idempotently creates or updates integration without fake OAuth token', async () => {
      mockThreadsProvider.verifyBrowserTransport.mockResolvedValue({
        transport: 'browser',
        allowRealPost: false,
        sidecarUrl: 'http://127.0.0.1:8017',
        health: { status: 'ok' },
        session: { session_status: 'SESSION_OK' },
      });
      mockThreadsProvider.getBrowserProfile.mockResolvedValue({
        status: 'ok',
        account: 'main',
        username: 'my_threads_brand',
        name: 'My Threads Brand',
        picture: 'https://example.com/avatar.png',
        profile_url: 'https://www.threads.net/@my_threads_brand',
        session_status: 'SESSION_OK',
      });

      mockPrisma.integration.upsert.mockResolvedValue({
        id: 'int_threads_browser_main',
        organizationId: mockOrg.id,
        internalId: 'threads_browser_main',
        providerIdentifier: 'threads',
        name: 'My Threads Brand',
        profile: 'my_threads_brand',
        picture: 'https://example.com/avatar.png',
        token: 'managed:threads-browser:main',
        disabled: false,
      });

      const res = await service.connectBrowserAccount(mockOrg, { account: 'main' });

      expect(res.status).toBe('ok');
      expect(res.integration.id).toBe('int_threads_browser_main');
      expect(res.integration.isBrowser).toBe(true);
      expect(res.integration.transport).toBe('browser');
      expect(res.integration.browserAccount).toBe('main');

      // Verify Prisma upsert was called with managed token and deterministic internalId
      expect(mockPrisma.integration.upsert).toHaveBeenCalledWith({
        where: {
          organizationId_internalId: {
            organizationId: mockOrg.id,
            internalId: 'threads_browser_main',
          },
        },
        create: expect.objectContaining({
          organizationId: mockOrg.id,
          internalId: 'threads_browser_main',
          providerIdentifier: 'threads',
          token: 'managed:threads-browser:main',
          name: 'My Threads Brand',
          profile: 'my_threads_brand',
          disabled: false,
        }),
        update: expect.objectContaining({
          token: 'managed:threads-browser:main',
          disabled: false,
          deletedAt: null,
        }),
      });

      // Verify account settings upsert
      expect(mockPrisma.snsThreadsAccountSetting.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { integrationId: 'int_threads_browser_main' },
        })
      );
    });
  });

  describe('Fail-Closed protection on official API features for browser accounts', () => {
    const browserIntegration = {
      id: 'int_browser_main',
      organizationId: mockOrg.id,
      internalId: 'threads_browser_main',
      token: 'managed:threads-browser:main',
      providerIdentifier: 'threads',
      disabled: false,
      customInstanceDetails: JSON.stringify({ transport: 'browser' }),
    };

    it('rejects syncInbox targeting a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.syncInbox(mockOrg, 'int_browser_main')
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.fetchUserThreads).not.toHaveBeenCalled();
    });

    it('skips browser integrations during full-org syncInbox without failing', async () => {
      mockPrisma.integration.findMany.mockResolvedValue([
        browserIntegration,
        {
          id: 'int_official',
          organizationId: mockOrg.id,
          internalId: '12345678',
          token: 'real_meta_oauth_token',
          providerIdentifier: 'threads',
          disabled: false,
        },
      ]);
      mockThreadsProvider.fetchUserThreads.mockResolvedValue({ data: [] });

      const result = await service.syncInbox(mockOrg);
      expect(result.accountsCount).toBe(2);
      expect(mockThreadsProvider.fetchUserThreads).toHaveBeenCalledTimes(1);
      expect(mockThreadsProvider.fetchUserThreads).toHaveBeenCalledWith(
        'real_meta_oauth_token',
        15
      );
    });

    it('rejects replyToInboxItem on a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.snsThreadsInboxItem.findFirst.mockResolvedValue({
        id: 'inbox_1',
        integrationId: 'int_browser_main',
        threadsReplyId: 'reply_123',
      });
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.replyToInboxItem(mockOrg, 'inbox_1', 'test reply')
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.replyToThread).not.toHaveBeenCalled();
    });

    it('rejects hideInboxItem on a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.snsThreadsInboxItem.findFirst.mockResolvedValue({
        id: 'inbox_1',
        integrationId: 'int_browser_main',
        threadsReplyId: 'reply_123',
      });
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.hideInboxItem(mockOrg, 'inbox_1', true)
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.manageReply).not.toHaveBeenCalled();
    });

    it('rejects approvePendingReply on a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.snsThreadsInboxItem.findFirst.mockResolvedValue({
        id: 'inbox_1',
        integrationId: 'int_browser_main',
        threadsReplyId: 'reply_123',
      });
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.approvePendingReply(mockOrg, 'inbox_1', true)
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.managePendingReply).not.toHaveBeenCalled();
    });

    it('rejects searchThreads on a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.searchThreads(mockOrg, 'int_browser_main', 'search query')
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.keywordSearch).not.toHaveBeenCalled();
    });

    it('rejects searchLocations on a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.searchLocations(mockOrg, 'int_browser_main', 'Tokyo')
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.searchLocations).not.toHaveBeenCalled();
    });

    it('rejects getPublishingLimit (quota) on a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.getPublishingLimit(mockOrg, 'int_browser_main')
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.fetchPublishingLimit).not.toHaveBeenCalled();
    });

    it('rejects getThreadsAnalytics targeted to a browser integration with BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE', async () => {
      mockPrisma.integration.findFirst.mockResolvedValue(browserIntegration);

      await expect(
        service.getThreadsAnalytics(mockOrg, { integrationId: 'int_browser_main' })
      ).rejects.toMatchObject({
        response: expect.objectContaining({
          code: 'BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE',
        }),
      });

      expect(mockThreadsProvider.postAnalytics).not.toHaveBeenCalled();
    });

    it('checkAndTriggerAutoPlug returns unsupported reason for browser integration without calling API', async () => {
      mockPrisma.post.findFirst.mockResolvedValue({
        id: 'post_1',
        releaseId: 'th_rel_1',
        integrationId: 'int_browser_main',
        integration: browserIntegration,
      });

      const res = await service.checkAndTriggerAutoPlug(mockOrg, 'post_1');
      expect(res).toEqual({
        triggered: false,
        reason: 'BROWSER_ACCOUNT_NOT_SUPPORTED',
      });
      expect(mockThreadsProvider.postAnalytics).not.toHaveBeenCalled();
      expect(mockThreadsProvider.replyToThread).not.toHaveBeenCalled();
    });
  });
});
