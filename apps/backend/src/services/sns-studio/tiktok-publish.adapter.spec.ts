import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { TikTokPublishAdapter } from './tiktok-publish.adapter';
import { CreationMethod } from '@prisma/client';

jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: {
    sanitize: (val: any) => val,
  },
  sanitize: (val: any) => val,
}));

jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  Relay: jest.fn(),
  finalizeEvent: jest.fn(),
  SimplePool: jest.fn(),
}));

jest.mock('file-type', () => ({
  fileTypeFromBuffer: jest.fn(),
}));

describe('TikTokPublishAdapter', () => {
  let adapter: TikTokPublishAdapter;
  let mockPrisma: any;
  let mockPostsService: any;
  let mockIntegrationManager: any;
  let mockRefreshIntegrationService: any;

  const orgId = 'org_123';
  const testPersonalIntegration = {
    id: 'int_personal',
    organizationId: orgId,
    providerIdentifier: 'tiktok',
    token: 'valid_personal_token',
    disabled: false,
    refreshNeeded: false,
    deletedAt: null,
  };
  const testBusinessIntegration = {
    id: 'int_business',
    organizationId: orgId,
    providerIdentifier: 'tiktok-business',
    token: 'valid_business_token',
    disabled: false,
    refreshNeeded: false,
    deletedAt: null,
  };

  beforeEach(() => {
    mockPrisma = {
      integration: {
        findFirst: jest.fn().mockImplementation(({ where }) => {
          if (where.id === testPersonalIntegration.id && where.organizationId === orgId && where.deletedAt === null) {
            return Promise.resolve(testPersonalIntegration);
          }
          if (where.id === testBusinessIntegration.id && where.organizationId === orgId && where.deletedAt === null) {
            return Promise.resolve(testBusinessIntegration);
          }
          return Promise.resolve(null);
        }),
      },
      snsAppSetting: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
    };

    mockPostsService = {
      validatePosts: jest.fn().mockResolvedValue([
        {
          valid: true,
          settingsError: '',
          errors: true,
          emptyContent: false,
          tooLong: false,
          maximumCharacters: 2000,
        },
      ]),
      mapTypeToPost: jest.fn().mockImplementation((dto) => Promise.resolve(dto)),
      createPost: jest.fn().mockResolvedValue([
        {
          postId: 'post_real_123',
          integration: 'int_personal',
        },
      ]),
    };

    mockIntegrationManager = {
      getSocialIntegration: jest.fn().mockReturnValue({
        maxVideoLength: jest.fn().mockResolvedValue({ maxDurationSeconds: 600 }),
      }),
    };

    mockRefreshIntegrationService = {
      refresh: jest.fn().mockResolvedValue({ accessToken: 'refreshed_token' }),
    };

    adapter = new TikTokPublishAdapter(
      mockPrisma,
      mockPostsService,
      mockIntegrationManager,
      mockRefreshIntegrationService
    );
  });

  // =========================================================================
  // 1. Integration Validation Tests
  // =========================================================================

  describe('Integration Validation', () => {
    it('accepts valid Personal TikTok integration', async () => {
      const res = await adapter.validateIntegration(orgId, 'int_personal');
      expect(res.id).toBe('int_personal');
      expect(res.providerIdentifier).toBe('tiktok');
    });

    it('accepts valid Business TikTok integration', async () => {
      const res = await adapter.validateIntegration(orgId, 'int_business');
      expect(res.id).toBe('int_business');
      expect(res.providerIdentifier).toBe('tiktok-business');
    });

    it('rejects integration belonging to another organization (404)', async () => {
      mockPrisma.integration.findFirst.mockResolvedValueOnce(null);
      await expect(
        adapter.validateIntegration('org_other', 'int_personal')
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects non-TikTok integration (400 TIKTOK_INVALID_PROVIDER)', async () => {
      mockPrisma.integration.findFirst.mockResolvedValueOnce({
        id: 'int_ig',
        organizationId: orgId,
        providerIdentifier: 'instagram',
        disabled: false,
        refreshNeeded: false,
        deletedAt: null,
      });
      await expect(
        adapter.validateIntegration(orgId, 'int_ig')
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects deleted integration (404 TIKTOK_INTEGRATION_NOT_FOUND)', async () => {
      mockPrisma.integration.findFirst.mockResolvedValueOnce(null);
      await expect(
        adapter.validateIntegration(orgId, 'int_del')
      ).rejects.toThrow(NotFoundException);
    });

    it('rejects disabled integration (400 TIKTOK_INTEGRATION_DISABLED)', async () => {
      mockPrisma.integration.findFirst.mockResolvedValueOnce({
        ...testPersonalIntegration,
        disabled: true,
      });
      await expect(
        adapter.validateIntegration(orgId, 'int_personal')
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects refreshNeeded integration (400 TIKTOK_REAUTH_REQUIRED)', async () => {
      mockPrisma.integration.findFirst.mockResolvedValueOnce({
        ...testPersonalIntegration,
        refreshNeeded: true,
      });
      await expect(
        adapter.validateIntegration(orgId, 'int_personal')
      ).rejects.toThrow(BadRequestException);
    });
  });

  // =========================================================================
  // 2. Settings Normalization & Account Type Constraints
  // =========================================================================

  describe('Settings Normalization & Constraints', () => {
    it('applies default settings when empty', async () => {
      const { resolvedSettings, warnings } =
        await adapter.normalizeAndValidateSettings('tiktok', {});
      expect(resolvedSettings.content_posting_method).toBe('DIRECT_POST');
      expect(resolvedSettings.privacy_level).toBe('PUBLIC_TO_EVERYONE');
      expect(resolvedSettings.comment).toBe(true);
      expect(resolvedSettings.duet).toBe(false);
      expect(resolvedSettings.stitch).toBe(false);
      expect(resolvedSettings.autoAddMusic).toBe('no');
      expect(resolvedSettings.video_made_with_ai).toBe(false);
      expect(resolvedSettings.brand_content_toggle).toBe(false);
      expect(resolvedSettings.brand_organic_toggle).toBe(false);
      expect(warnings).toEqual([]);
    });

    it('rejects music setting for Personal TikTok accounts (TIKTOK_SETTING_UNSUPPORTED)', async () => {
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', { music: 'music_123' as any })
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects location setting for Personal TikTok accounts (TIKTOK_SETTING_UNSUPPORTED)', async () => {
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', { location: 'loc_123' as any })
      ).rejects.toThrow(BadRequestException);
    });

    it('allows music and location for TikTok Business accounts', async () => {
      const { resolvedSettings } = await adapter.normalizeAndValidateSettings(
        'tiktok-business',
        {
          music: { id: 'music_biz', title: 'Music Track' },
          location: { id: 'loc_biz', name: 'Tokyo Tower' },
        } as any
      );
      expect(resolvedSettings.music).toEqual({ id: 'music_biz', title: 'Music Track' });
      expect(resolvedSettings.location).toEqual({ id: 'loc_biz', name: 'Tokyo Tower' });
    });

    it('accepts UPLOAD posting method and produces TIKTOK_UPLOAD_LIMITED_SETTINGS warning', async () => {
      const { resolvedSettings, warnings } =
        await adapter.normalizeAndValidateSettings('tiktok', {
          content_posting_method: 'UPLOAD',
        });
      expect(resolvedSettings.content_posting_method).toBe('UPLOAD');
      expect(warnings.length).toBe(1);
      expect(warnings[0].code).toBe('TIKTOK_UPLOAD_LIMITED_SETTINGS');
    });
  });

  // =========================================================================
  // 3. PostsService.validatePosts Full Evaluation
  // =========================================================================

  describe('PostsService.validatePosts Evaluation', () => {
    it('rejects when emptyContent is true (TIKTOK_EMPTY_CONTENT)', async () => {
      mockPostsService.validatePosts.mockResolvedValueOnce([
        {
          valid: true,
          settingsError: '',
          errors: true,
          emptyContent: true,
          tooLong: false,
          maximumCharacters: 2000,
        },
      ]);

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: '',
          media: [],
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_EMPTY_CONTENT',
        },
      });
    });

    it('rejects when valid is false (TIKTOK_PREFLIGHT_FAILED)', async () => {
      mockPostsService.validatePosts.mockResolvedValueOnce([
        {
          valid: false,
          settingsError: 'Invalid privacy setting',
          errors: true,
          emptyContent: false,
          tooLong: false,
          maximumCharacters: 2000,
        },
      ]);

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Some content',
          media: [{ path: '/uploads/video.mp4' }],
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_PREFLIGHT_FAILED',
        },
      });
    });

    it('rejects when errors is not true (TIKTOK_MEDIA_INVALID)', async () => {
      mockPostsService.validatePosts.mockResolvedValueOnce([
        {
          valid: true,
          settingsError: '',
          errors: 'Only pictures are supported when selecting multiple items',
          emptyContent: false,
          tooLong: false,
          maximumCharacters: 2000,
        },
      ]);

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Some content',
          media: [{ path: '/uploads/video.mp4' }, { path: '/uploads/video2.mp4' }],
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_MEDIA_INVALID',
        },
      });
    });

    it('rejects when tooLong is true (TIKTOK_CONTENT_TOO_LONG)', async () => {
      mockPostsService.validatePosts.mockResolvedValueOnce([
        {
          valid: true,
          settingsError: '',
          errors: true,
          emptyContent: false,
          tooLong: true,
          maximumCharacters: 2000,
        },
      ]);

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Very long content...'.repeat(200),
          media: [{ path: '/uploads/video.mp4' }],
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_CONTENT_TOO_LONG',
        },
      });
    });

    it('passes when all validation checks succeed', async () => {
      const res = await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Valid content',
        media: [{ path: '/uploads/video.mp4' }],
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });
  });

  // =========================================================================
  // 4. Approval and autoPublish Logic
  // =========================================================================

  describe('Approval and autoPublish Logic', () => {
    it('now + autoPublish=false + unapproved throws ForbiddenException (TIKTOK_APPROVAL_REQUIRED)', async () => {
      mockPrisma.snsAppSetting.findUnique.mockResolvedValueOnce({
        organizationId: orgId,
        key: 'sns:tiktok:account:int_personal',
        value: { autoPublishEnabled: false },
      });

      await expect(
        adapter.publish(orgId, {
          integrationId: 'int_personal',
          content: 'Now post',
          media: [{ path: '/uploads/video.mp4' }],
          mode: 'now',
          approved: false,
        })
      ).rejects.toThrow(ForbiddenException);
    });

    it('now + autoPublish=false + approved=true succeeds', async () => {
      mockPrisma.snsAppSetting.findUnique.mockResolvedValueOnce({
        organizationId: orgId,
        key: 'sns:tiktok:account:int_personal',
        value: { autoPublishEnabled: false },
      });

      const res = await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'Approved post',
        media: [{ path: '/uploads/video.mp4' }],
        mode: 'now',
        approved: true,
      });
      expect(res.postId).toBe('post_real_123');
    });

    it('autoPublish=true succeeds without approved flag', async () => {
      mockPrisma.snsAppSetting.findUnique.mockResolvedValueOnce({
        organizationId: orgId,
        key: 'sns:tiktok:account:int_personal',
        value: { autoPublishEnabled: true },
      });

      const res = await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'Auto publish post',
        media: [{ path: '/uploads/video.mp4' }],
      });
      expect(res.postId).toBe('post_real_123');
    });

    it('draft + autoPublish=false + unapproved succeeds without approval', async () => {
      mockPrisma.snsAppSetting.findUnique.mockResolvedValueOnce({
        organizationId: orgId,
        key: 'sns:tiktok:account:int_personal',
        value: { autoPublishEnabled: false },
      });

      const res = await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'Draft post',
        media: [{ path: '/uploads/video.mp4' }],
        mode: 'draft',
        approved: false,
      });
      expect(res.postId).toBe('post_real_123');
      expect(res.mode).toBe('draft');
    });
  });

  // =========================================================================
  // 5. createPost Bridge & postId Extraction
  // =========================================================================

  describe('createPost Bridge & postId Extraction', () => {
    it('calls validatePosts, mapTypeToPost, and createPost with CreationMethod.API', async () => {
      await adapter.publish(orgId, {
        integrationId: 'int_business',
        content: 'Pipeline execution test',
        media: [{ path: '/uploads/biz_video.mp4' }],
        mode: 'now',
      });

      expect(mockPostsService.validatePosts).toHaveBeenCalledTimes(1);
      expect(mockPostsService.mapTypeToPost).toHaveBeenCalledTimes(1);
      expect(mockPostsService.createPost).toHaveBeenCalledTimes(1);

      const [calledOrgId, calledDto, calledMethod] =
        mockPostsService.createPost.mock.calls[0];
      expect(calledOrgId).toBe(orgId);
      expect(calledMethod).toBe(CreationMethod.API);
      expect(calledDto.type).toBe('now');
      expect(calledDto.posts[0].integration.id).toBe('int_business');
    });

    it('returns actual postId from PostsService.createPost', async () => {
      mockPostsService.createPost.mockResolvedValueOnce([
        {
          postId: 'post_actual_9999',
          integration: 'int_personal',
        },
      ]);

      const res = await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'Post with real ID',
        media: [{ path: '/uploads/video.mp4' }],
      });
      expect(res.postId).toBe('post_actual_9999');
    });

    it('rejects with TIKTOK_POST_CREATE_FAILED if PostsService returns empty list', async () => {
      mockPostsService.createPost.mockResolvedValueOnce([]);

      await expect(
        adapter.publish(orgId, {
          integrationId: 'int_personal',
          content: 'Empty result post',
          media: [{ path: '/uploads/video.mp4' }],
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_POST_CREATE_FAILED',
        },
      });
    });

    it('rejects with TIKTOK_POST_CREATE_FAILED if PostsService does not return postId', async () => {
      mockPostsService.createPost.mockResolvedValueOnce([
        { integration: 'int_personal' }, // missing postId
      ]);

      await expect(
        adapter.publish(orgId, {
          integrationId: 'int_personal',
          content: 'Missing postId',
          media: [{ path: '/uploads/video.mp4' }],
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_POST_CREATE_FAILED',
        },
      });
    });
  });

  // =========================================================================
  // 6. Creator Info Execution Conditions & Error Handling
  // =========================================================================

  describe('Creator Info Execution & Error Handling', () => {
    it('calls maxVideoLength for Personal video DIRECT_POST', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Personal video direct post',
        media: [{ path: '/uploads/video.mp4' }],
        settings: { content_posting_method: 'DIRECT_POST' } as any,
      });

      expect(provider.maxVideoLength).toHaveBeenCalledTimes(1);
    });

    it('does NOT call maxVideoLength for photo posts', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.maxVideoLength.mockClear();

      await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Photo post',
        media: [{ path: '/uploads/photo.jpg' }],
        settings: { content_posting_method: 'DIRECT_POST' } as any,
      });

      expect(provider.maxVideoLength).not.toHaveBeenCalled();
    });

    it('does NOT call maxVideoLength for UPLOAD method', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.maxVideoLength.mockClear();

      await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Upload video post',
        media: [{ path: '/uploads/video.mp4' }],
        settings: { content_posting_method: 'UPLOAD' } as any,
      });

      expect(provider.maxVideoLength).not.toHaveBeenCalled();
    });

    it('does NOT call maxVideoLength for TikTok Business accounts', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.maxVideoLength.mockClear();

      await adapter.preflight(orgId, {
        integrationId: 'int_business',
        content: 'Business video post',
        media: [{ path: '/uploads/video.mp4' }],
        settings: { content_posting_method: 'DIRECT_POST' } as any,
      });

      expect(provider.maxVideoLength).not.toHaveBeenCalled();
    });

    it('rejects when video duration exceeds maxVideoLength (TIKTOK_MEDIA_DURATION_EXCEEDED)', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.maxVideoLength.mockResolvedValueOnce({ maxDurationSeconds: 60 });

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Exceeded video',
          media: [{ path: '/uploads/video.mp4' }],
          mediaDurationSeconds: 120, // 120 > 60
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_MEDIA_DURATION_EXCEEDED',
        },
      });
    });

    it('produces TIKTOK_CREATOR_INFO_UNAVAILABLE warning when creator info API fails', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.maxVideoLength.mockRejectedValueOnce(new Error('Network error calling TikTok API'));

      const res = await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Video with API failure',
        media: [{ path: '/uploads/video.mp4' }],
      });

      expect(res.valid).toBe(true);
      expect(res.warnings).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            code: 'TIKTOK_CREATOR_INFO_UNAVAILABLE',
          }),
        ])
      );
    });
  });
});
