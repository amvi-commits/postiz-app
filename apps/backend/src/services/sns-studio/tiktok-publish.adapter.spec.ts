import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { TikTokPublishAdapter } from './tiktok-publish.adapter';
import { CreationMethod } from '@prisma/client';
import { TikTokPublishGuard } from './tiktok-publish.guard';

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
  let mockCommonPublishingService: any;

  const orgId = 'org_123';
  const testPersonalIntegration = {
    id: 'int_personal',
    organizationId: orgId,
    providerIdentifier: 'tiktok',
    token: 'valid_personal_token',
    disabled: false,
    refreshNeeded: false,
    deletedAt: null as Date | null,
  };
  const testBusinessIntegration = {
    id: 'int_business',
    organizationId: orgId,
    providerIdentifier: 'tiktok-business',
    token: 'valid_business_token',
    disabled: false,
    refreshNeeded: false,
    deletedAt: null as Date | null,
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
      post: {
        findMany: jest.fn().mockResolvedValue([]),
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
        creatorInfo: jest.fn().mockResolvedValue({
          creator_avatar_url: 'https://example.com/avatar.jpg',
          creator_username: 'creator_user',
          creator_nickname: 'Creator Nick',
          privacy_level_options: [
            'PUBLIC_TO_EVERYONE',
            'MUTUAL_FOLLOW_FRIENDS',
            'FOLLOWER_OF_CREATOR',
            'SELF_ONLY',
          ],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: 600,
        }),
        maxVideoLength: jest.fn().mockResolvedValue({ maxDurationSeconds: 600 }),
      }),
    };

    mockRefreshIntegrationService = {
      refresh: jest.fn().mockResolvedValue({ accessToken: 'refreshed_token' }),
    };

    mockCommonPublishingService = {
      listAccountPolicies: jest.fn().mockResolvedValue([
        {
          integrationId: 'int_personal',
          policy: {
            autoPostEnabled: true,
            approvalRequired: false,
            maxPostsPerDay: null,
            sameContentCooldownDays: 0,
          },
        },
        {
          integrationId: 'int_business',
          policy: {
            autoPostEnabled: true,
            approvalRequired: false,
            maxPostsPerDay: null,
            sameContentCooldownDays: 0,
          },
        },
      ]),
    };

    adapter = new TikTokPublishAdapter(
      mockPrisma,
      mockPostsService,
      mockIntegrationManager,
      mockRefreshIntegrationService,
      new TikTokPublishGuard(mockPrisma),
      mockCommonPublishingService
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
    it('requires explicit privacy selection and affirmative consent for DIRECT_POST and defaults interactions to false', async () => {
      // 1. Missing privacy_level throws TIKTOK_PRIVACY_SELECTION_REQUIRED
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', {})
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_PRIVACY_SELECTION_REQUIRED' },
      });

      // 2. Missing consentConfirmed throws TIKTOK_CONSENT_REQUIRED
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', {
          privacy_level: 'PUBLIC_TO_EVERYONE',
        })
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_CONSENT_REQUIRED' },
      });

      // 3. Valid settings apply compliant interaction defaults (comment=false, duet=false, stitch=false)
      const { resolvedSettings, warnings } =
        await adapter.normalizeAndValidateSettings('tiktok', {
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
        });
      expect(resolvedSettings.content_posting_method).toBe('DIRECT_POST');
      expect(resolvedSettings.privacy_level).toBe('PUBLIC_TO_EVERYONE');
      expect(resolvedSettings.comment).toBe(false);
      expect(resolvedSettings.duet).toBe(false);
      expect(resolvedSettings.stitch).toBe(false);
      expect(resolvedSettings.autoAddMusic).toBe('no');
      expect(resolvedSettings.video_made_with_ai).toBe(false);
      expect(resolvedSettings.brand_content_toggle).toBe(false);
      expect(resolvedSettings.brand_organic_toggle).toBe(false);
      expect(resolvedSettings.consentConfirmed).toBe(true);
      expect(resolvedSettings.consentConfirmedAt).toBeDefined();
      expect(warnings).toEqual([]);
    });

    it('validates commercial content disclosure requirements', async () => {
      // disclose=true with neither toggle throws TIKTOK_COMMERCIAL_DISCLOSURE_SELECTION_REQUIRED
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', {
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
          disclose: true,
        })
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_COMMERCIAL_DISCLOSURE_SELECTION_REQUIRED' },
      });

      // brand_content_toggle=true with SELF_ONLY throws TIKTOK_BRANDED_CONTENT_PRIVACY_INVALID
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', {
          privacy_level: 'SELF_ONLY',
          consentConfirmed: true,
          disclose: true,
          brand_content_toggle: true,
        })
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_BRANDED_CONTENT_PRIVACY_INVALID' },
      });

      // brand_content_toggle=true with PUBLIC_TO_EVERYONE succeeds
      const { resolvedSettings } = await adapter.normalizeAndValidateSettings('tiktok', {
        privacy_level: 'PUBLIC_TO_EVERYONE',
        consentConfirmed: true,
        disclose: true,
        brand_content_toggle: true,
      });
      expect(resolvedSettings.brand_content_toggle).toBe(true);
    });

    it('rejects music setting for Personal TikTok accounts (TIKTOK_SETTING_UNSUPPORTED)', async () => {
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', {
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
          music: 'music_123' as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('rejects location setting for Personal TikTok accounts (TIKTOK_SETTING_UNSUPPORTED)', async () => {
      await expect(
        adapter.normalizeAndValidateSettings('tiktok', {
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
          location: 'loc_123' as any,
        })
      ).rejects.toThrow(BadRequestException);
    });

    it('allows music and location for TikTok Business accounts', async () => {
      const { resolvedSettings } = await adapter.normalizeAndValidateSettings(
        'tiktok-business',
        {
          privacy_level: 'PUBLIC_TO_EVERYONE',
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
          settings: {
            privacy_level: 'PUBLIC_TO_EVERYONE',
            consentConfirmed: true,
          },
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
          settings: {
            privacy_level: 'PUBLIC_TO_EVERYONE',
            consentConfirmed: true,
          },
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
          settings: {
            privacy_level: 'PUBLIC_TO_EVERYONE',
            consentConfirmed: true,
          },
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
          settings: {
            privacy_level: 'PUBLIC_TO_EVERYONE',
            consentConfirmed: true,
          },
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
        settings: {
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
        },
      });
      expect(res.valid).toBe(true);
      expect(res.errors).toEqual([]);
    });
  });

  // =========================================================================
  // 4. Approval and autoPublish Logic
  // =========================================================================
  // 4. Common Account Policy integration
  // =========================================================================

  describe('Common Account Policy integration', () => {
    it.each([
      ['automatic posting disabled', { autoPostEnabled: false }],
      ['approval required', { approvalRequired: true }],
      ['daily limit configured', { maxPostsPerDay: 3 }],
      ['same-content cooldown configured', { sameContentCooldownDays: 7 }],
    ])('requires the Common content plan when %s is configured', async (_label, override) => {
      mockCommonPublishingService.listAccountPolicies.mockResolvedValue([
        {
          integrationId: 'int_personal',
          policy: {
            autoPostEnabled: true,
            approvalRequired: false,
            maxPostsPerDay: null,
            sameContentCooldownDays: 0,
            ...override,
          },
        },
      ]);

      await expect(
        adapter.publish(orgId, {
          integrationId: 'int_personal',
          content: 'Policy protected post',
          media: [{ path: '/uploads/video.mp4' }],
          mode: 'now',
        })
      ).rejects.toMatchObject({
        response: { code: 'COMMON_CONTENT_PLAN_REQUIRED' },
      });
      expect(mockPostsService.createPost).not.toHaveBeenCalled();
      expect(mockIntegrationManager.getSocialIntegration).not.toHaveBeenCalled();
    });

    it('ignores legacy TikTok auto-publish and daily-limit settings', async () => {
      mockPrisma.snsAppSetting.findUnique.mockResolvedValue({
        organizationId: orgId,
        key: 'sns:tiktok:account:int_personal',
        value: {
          autoPublishEnabled: false,
          dailyPostLimit: 1,
          duplicateWindowDays: 0,
        },
      });

      const result = await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'Common defaults allow this post',
        media: [{ path: '/uploads/video.mp4' }],
        mode: 'now',
        settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
      });

      expect(result.postId).toBe('post_real_123');
      expect(mockCommonPublishingService.listAccountPolicies).toHaveBeenCalledWith(orgId);
    });

    it('allows a draft even when Common Policy requires approval', async () => {
      mockCommonPublishingService.listAccountPolicies.mockResolvedValue([
        {
          integrationId: 'int_personal',
          policy: {
            autoPostEnabled: false,
            approvalRequired: true,
            maxPostsPerDay: 1,
            sameContentCooldownDays: 30,
          },
        },
      ]);

      const result = await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'Draft post',
        media: [{ path: '/uploads/video.mp4' }],
        mode: 'draft',
        settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
      });

      expect(result.postId).toBe('post_real_123');
      expect(result.mode).toBe('draft');
      expect(mockCommonPublishingService.listAccountPolicies).not.toHaveBeenCalled();
    });

    it('draft mode bypasses TikTok duplicate checks', async () => {
      await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'Draft only',
        media: [{ id: 'media_draft', path: '/uploads/draft.mp4' }],
        mode: 'draft',
        settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
      });

      expect(mockPrisma.post.findMany).not.toHaveBeenCalled();
    });

    it('does not let legacy approval settings bypass duplicate media protection', async () => {
      mockPrisma.snsAppSetting.findUnique.mockResolvedValue({
        value: {
          autoPublishEnabled: false,
          dailyPostLimit: 2,
          duplicateWindowDays: 30,
        },
      });
      mockPrisma.post.findMany.mockResolvedValue([
        {
          id: 'previous-media',
          organizationId: orgId,
          integrationId: 'int_personal',
          state: 'QUEUE',
          publishDate: new Date(Date.now() - 60 * 60 * 1000),
          deletedAt: null,
          settings: '{"content_posting_method":"UPLOAD"}',
          image: JSON.stringify([{ id: 'same-id', path: '/uploads/video.mp4' }]),
        },
      ]);

      await expect(
        adapter.publish(orgId, {
          integrationId: 'int_personal',
          content: 'Repeated media',
          media: [{ id: 'same-id', path: '/uploads/processed.mp4' }],
          mode: 'now',
          settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
        })
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_DUPLICATE_MEDIA' },
      });
      expect(mockPostsService.createPost).not.toHaveBeenCalled();
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
        settings: { privacy_level: 'PUBLIC_TO_EVERYONE' } as any,
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

    it('builds a new Postiz payload without placeholder post fields', async () => {
      await adapter.publish(orgId, {
        integrationId: 'int_personal',
        content: 'New TikTok post',
        media: [
          {
            id: 'media_123',
            path: '/uploads/video.mp4',
            thumbnail: '/uploads/video-thumb.jpg',
          },
        ],
        mode: 'now',
        settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
      });

      const [calledDto] = mockPostsService.mapTypeToPost.mock.calls[0];
      const post = calledDto.posts[0];
      const value = post.value[0];

      expect(post).not.toHaveProperty('group');
      expect(post.integration.id).toBe('int_personal');
      expect(value).not.toHaveProperty('id');
      expect(value).not.toHaveProperty('delay');
      expect(value.content).toBe('New TikTok post');
      expect(value.image).toEqual([
        {
          id: 'media_123',
          path: '/uploads/video.mp4',
          thumbnail: '/uploads/video-thumb.jpg',
        },
      ]);
      expect(post.settings).toEqual(
        expect.objectContaining({
          content_posting_method: 'DIRECT_POST',
        })
      );
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
        settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
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
          settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
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
          settings: { privacy_level: 'PUBLIC_TO_EVERYONE', consentConfirmed: true } as any,
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
    it('calls creatorInfo for Personal video DIRECT_POST', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockClear();

      await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Personal video direct post',
        media: [{ path: '/uploads/video.mp4' }],
        settings: {
          content_posting_method: 'DIRECT_POST',
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
        } as any,
      });

      expect(provider.creatorInfo).toHaveBeenCalledTimes(1);
    });

    it('does NOT enforce video duration limit for photo posts', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockResolvedValueOnce({
        creator_avatar_url: 'https://example.com/avatar.jpg',
        creator_username: 'creator_user',
        creator_nickname: 'Creator Nick',
        privacy_level_options: ['PUBLIC_TO_EVERYONE'],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 60,
      });

      const res = await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Photo post',
        media: [{ path: '/uploads/photo.jpg' }],
        mediaDurationSeconds: 120,
        settings: {
          content_posting_method: 'DIRECT_POST',
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
        } as any,
      });

      expect(res.valid).toBe(true);
    });

    it('does NOT call creatorInfo for UPLOAD method', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockClear();

      await adapter.preflight(orgId, {
        integrationId: 'int_personal',
        content: 'Upload video post',
        media: [{ path: '/uploads/video.mp4' }],
        settings: { content_posting_method: 'UPLOAD' } as any,
      });

      expect(provider.creatorInfo).not.toHaveBeenCalled();
    });

    it('does NOT call creatorInfo for TikTok Business accounts', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockClear();

      await adapter.preflight(orgId, {
        integrationId: 'int_business',
        content: 'Business video post',
        media: [{ path: '/uploads/video.mp4' }],
        settings: {
          content_posting_method: 'DIRECT_POST',
          privacy_level: 'PUBLIC_TO_EVERYONE',
        } as any,
      });

      expect(provider.creatorInfo).not.toHaveBeenCalled();
    });

    it('rejects when video duration exceeds maxVideoLength (TIKTOK_MEDIA_DURATION_EXCEEDED)', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockResolvedValueOnce({
        creator_avatar_url: 'https://example.com/avatar.jpg',
        creator_username: 'creator_user',
        creator_nickname: 'Creator Nick',
        privacy_level_options: ['PUBLIC_TO_EVERYONE'],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 60,
      });

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Exceeded video',
          media: [{ path: '/uploads/video.mp4' }],
          mediaDurationSeconds: 120, // 120 > 60
          settings: {
            content_posting_method: 'DIRECT_POST',
            privacy_level: 'PUBLIC_TO_EVERYONE',
            consentConfirmed: true,
          } as any,
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_MEDIA_DURATION_EXCEEDED',
        },
      });
    });

    it('rejects with TIKTOK_CREATOR_INFO_UNAVAILABLE when creator info API fails (fail-closed)', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockRejectedValueOnce(new Error('Network error calling TikTok API'));

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Video with API failure',
          media: [{ path: '/uploads/video.mp4' }],
          settings: {
            content_posting_method: 'DIRECT_POST',
            privacy_level: 'PUBLIC_TO_EVERYONE',
            consentConfirmed: true,
          } as any,
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_CREATOR_INFO_UNAVAILABLE',
        },
      });
    });

    it('rejects when selected privacy level is not allowed for creator (TIKTOK_PRIVACY_LEVEL_NOT_ALLOWED)', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockResolvedValueOnce({
        creator_avatar_url: 'https://example.com/avatar.jpg',
        creator_username: 'creator_user',
        creator_nickname: 'Creator Nick',
        privacy_level_options: ['PUBLIC_TO_EVERYONE'],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      });

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Disallowed privacy post',
          media: [{ path: '/uploads/video.mp4' }],
          settings: {
            content_posting_method: 'DIRECT_POST',
            privacy_level: 'FOLLOWER_OF_CREATOR',
            consentConfirmed: true,
          } as any,
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_PRIVACY_LEVEL_NOT_ALLOWED',
        },
      });
    });

    it('rejects when comments are disabled by creator (TIKTOK_COMMENT_DISABLED_BY_CREATOR)', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockResolvedValueOnce({
        creator_avatar_url: 'https://example.com/avatar.jpg',
        creator_username: 'creator_user',
        creator_nickname: 'Creator Nick',
        privacy_level_options: ['PUBLIC_TO_EVERYONE'],
        comment_disabled: true,
        duet_disabled: false,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      });

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Comment test post',
          media: [{ path: '/uploads/video.mp4' }],
          settings: {
            content_posting_method: 'DIRECT_POST',
            privacy_level: 'PUBLIC_TO_EVERYONE',
            comment: true,
            consentConfirmed: true,
          } as any,
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_COMMENT_DISABLED_BY_CREATOR',
        },
      });
    });

    it('rejects when duet is disabled by creator (TIKTOK_DUET_DISABLED_BY_CREATOR)', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockResolvedValueOnce({
        creator_avatar_url: 'https://example.com/avatar.jpg',
        creator_username: 'creator_user',
        creator_nickname: 'Creator Nick',
        privacy_level_options: ['PUBLIC_TO_EVERYONE'],
        comment_disabled: false,
        duet_disabled: true,
        stitch_disabled: false,
        max_video_post_duration_sec: 600,
      });

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Duet test post',
          media: [{ path: '/uploads/video.mp4' }],
          settings: {
            content_posting_method: 'DIRECT_POST',
            privacy_level: 'PUBLIC_TO_EVERYONE',
            duet: true,
            consentConfirmed: true,
          } as any,
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_DUET_DISABLED_BY_CREATOR',
        },
      });
    });

    it('rejects when stitch is disabled by creator (TIKTOK_STITCH_DISABLED_BY_CREATOR)', async () => {
      const provider = mockIntegrationManager.getSocialIntegration('tiktok');
      provider.creatorInfo.mockResolvedValueOnce({
        creator_avatar_url: 'https://example.com/avatar.jpg',
        creator_username: 'creator_user',
        creator_nickname: 'Creator Nick',
        privacy_level_options: ['PUBLIC_TO_EVERYONE'],
        comment_disabled: false,
        duet_disabled: false,
        stitch_disabled: true,
        max_video_post_duration_sec: 600,
      });

      await expect(
        adapter.preflight(orgId, {
          integrationId: 'int_personal',
          content: 'Stitch test post',
          media: [{ path: '/uploads/video.mp4' }],
          settings: {
            content_posting_method: 'DIRECT_POST',
            privacy_level: 'PUBLIC_TO_EVERYONE',
            stitch: true,
            consentConfirmed: true,
          } as any,
        })
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_STITCH_DISABLED_BY_CREATOR',
        },
      });
    });

    it('serializes same-account publish requests and rechecks TikTok duplicate media', async () => {
      const posts: any[] = [];
      mockPrisma.snsAppSetting.findUnique.mockResolvedValue({
        value: {
          duplicateWindowDays: 30,
        },
      });
      mockPrisma.post.findMany.mockImplementation(async () => [...posts]);
      mockPostsService.createPost.mockImplementation(async () => {
        posts.push({
          id: 'created-post',
          organizationId: orgId,
          integrationId: 'int_personal',
          state: 'QUEUE',
          publishDate: new Date(),
          deletedAt: null,
          settings: '{"content_posting_method":"DIRECT_POST"}',
          image: JSON.stringify([
            { id: 'media-concurrent', path: '/uploads/concurrent.mp4' },
          ]),
        });
        return [{ postId: 'created-post' }];
      });

      const input = {
        integrationId: 'int_personal',
        content: 'Concurrent post',
        media: [{ id: 'media-concurrent', path: '/uploads/concurrent.mp4' }],
        mode: 'now' as const,
        settings: {
          content_posting_method: 'DIRECT_POST',
          privacy_level: 'PUBLIC_TO_EVERYONE',
          consentConfirmed: true,
        } as any,
      };
      const results = await Promise.allSettled([
        adapter.publish(orgId, input),
        adapter.publish(orgId, input),
      ]);

      expect(mockPostsService.createPost).toHaveBeenCalledTimes(1);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      const rejected = results.find((result) => result.status === 'rejected') as PromiseRejectedResult;
      expect(rejected.reason.getResponse()).toMatchObject({
        code: 'TIKTOK_DUPLICATE_MEDIA',
      });
    });

    it('allows different TikTok integrations to enter Postiz creation concurrently', async () => {
      const integrationIds = ['int_personal', 'int_business'];
      mockPrisma.integration.findFirst.mockImplementation(async ({ where }: any) => ({
        ...testPersonalIntegration,
        id: where.id,
        providerIdentifier: where.id === 'int_business' ? 'tiktok-business' : 'tiktok',
      }));
      mockPrisma.snsAppSetting.findUnique.mockResolvedValue({
        value: {
          duplicateWindowDays: 0,
        },
      });
      mockPrisma.post.findMany.mockImplementation(async ({ where }: any) => [
        {
          id: `existing-${where.integrationId}`,
          organizationId: orgId,
          integrationId: where.integrationId,
          state: 'PUBLISHED',
          publishDate: new Date(Date.now() - 60 * 60 * 1000),
          deletedAt: null as Date | null,
          settings: '{"content_posting_method":"DIRECT_POST"}',
          image: '[]',
        },
      ]);

      let mappingCalls = 0;
      let releaseMappingBarrier!: () => void;
      const bothMappingsStarted = new Promise<void>((resolve) => {
        releaseMappingBarrier = resolve;
      });
      mockPostsService.mapTypeToPost.mockImplementation(async (dto: any) => {
        mappingCalls += 1;
        if (mappingCalls === integrationIds.length) releaseMappingBarrier();
        await bothMappingsStarted;
        return dto;
      });

      const results = await Promise.all(
        integrationIds.map((integrationId) =>
          adapter.publish(orgId, {
            integrationId,
            content: 'Parallel account post',
            media: [],
            mode: 'now',
            settings: {
              content_posting_method: 'DIRECT_POST',
              privacy_level: 'PUBLIC_TO_EVERYONE',
              consentConfirmed: true,
            } as any,
          })
        )
      );

      expect(results).toHaveLength(2);
      expect(mappingCalls).toBe(2);
      expect(mockPostsService.createPost).toHaveBeenCalledTimes(2);
    });
  });

  // =========================================================================
  // 7. Dedicated getCreatorInfo Method
  // =========================================================================

  describe('getCreatorInfo', () => {
    it('returns creator info for Personal account', async () => {
      const info = await adapter.getCreatorInfo(orgId, 'int_personal');
      expect(info.creator_username).toBe('creator_user');
      expect(info.privacy_level_options).toEqual(
        expect.arrayContaining(['PUBLIC_TO_EVERYONE'])
      );
    });

    it('rejects for Business account with TIKTOK_CREATOR_INFO_PERSONAL_ONLY', async () => {
      await expect(
        adapter.getCreatorInfo(orgId, 'int_business')
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_CREATOR_INFO_PERSONAL_ONLY',
        },
      });
    });
  });
});
