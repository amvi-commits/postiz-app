/**
 * sns-studio-tiktok.spec.ts
 *
 * Comprehensive tests for SNS Studio TikTok Phase 1:
 * - Behavioral tests for SnsStudioController (GET & PUT /tiktok/accounts)
 * - Structural and schema guards (no custom common schema, no generic aliases)
 */

import * as fs from 'fs';
import * as path from 'path';
import { HttpException, HttpStatus } from '@nestjs/common';
import { SnsStudioController } from './sns-studio.controller';

describe('SNS Studio TikTok Phase 1', () => {
  // =========================================================================
  // Behavioral Tests: SnsStudioController
  // =========================================================================

  describe('SnsStudioController TikTok Behavior', () => {
    let controller: SnsStudioController;
    let mockPrisma: any;
    const testOrg = { id: 'org_123', name: 'Test Org' } as any;

    beforeEach(() => {
      mockPrisma = {
        integration: {
          findMany: jest.fn(),
          findFirst: jest.fn(),
        },
        snsAppSetting: {
          findMany: jest.fn(),
          findUnique: jest.fn(),
          upsert: jest.fn(),
        },
      };

      const mockTikTokPublishAdapter = {
        preflight: jest.fn(),
        publish: jest.fn(),
      };

      // Instantiate controller with mock Prisma and dummy services
      controller = new SnsStudioController(
        mockPrisma,
        {} as any,
        {} as any,
        {} as any,
        mockTikTokPublishAdapter as any
      );
    });

    describe('GET /tiktok/accounts', () => {
      it('returns TikTok Personal and Business accounts with platform=tiktok and correct providerIdentifier', async () => {
        const now = new Date();
        const past = new Date(now.getTime() - 1000 * 3600); // 1 hour ago (expired access token)
        const future = new Date(now.getTime() + 1000 * 3600); // 1 hour future

        const mockIntegrations = [
          {
            id: 'int_tt_personal',
            organizationId: 'org_123',
            providerIdentifier: 'tiktok',
            internalId: 'tt_open_id_1',
            name: 'Personal User',
            profile: '@personal_user',
            picture: 'https://example.com/pic1.jpg',
            disabled: false,
            refreshNeeded: false,
            tokenExpiration: past, // Expired access token
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'int_tt_business',
            organizationId: 'org_123',
            providerIdentifier: 'tiktok-business',
            internalId: 'tt_open_id_2',
            name: 'Business User',
            profile: '@business_user',
            picture: 'https://example.com/pic2.jpg',
            disabled: false,
            refreshNeeded: false,
            tokenExpiration: future,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'int_tt_disabled',
            organizationId: 'org_123',
            providerIdentifier: 'tiktok',
            internalId: 'tt_open_id_3',
            name: 'Disabled User',
            profile: '@disabled_user',
            picture: null,
            disabled: true,
            refreshNeeded: false,
            tokenExpiration: future,
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'int_tt_refresh',
            organizationId: 'org_123',
            providerIdentifier: 'tiktok-business',
            internalId: 'tt_open_id_4',
            name: 'Refresh Needed User',
            profile: '@refresh_user',
            picture: null,
            disabled: false,
            refreshNeeded: true,
            tokenExpiration: past,
            createdAt: now,
            updatedAt: now,
          },
        ];

        mockPrisma.integration.findMany.mockResolvedValue(mockIntegrations);

        // Mock saved setting for the business account only
        mockPrisma.snsAppSetting.findMany.mockResolvedValue([
          {
            organizationId: 'org_123',
            key: 'sns:tiktok:account:int_tt_business',
            value: {
              autoPublishEnabled: false,
              dailyPostLimit: 5,
              duplicateWindowDays: 60,
            },
          },
        ]);

        const result = await controller.listTikTokAccounts(testOrg);

        // Verify query filters: only tiktok & tiktok-business, active org, not deleted
        expect(mockPrisma.integration.findMany).toHaveBeenCalledWith({
          where: {
            organizationId: 'org_123',
            providerIdentifier: { in: ['tiktok', 'tiktok-business'] },
            deletedAt: null,
          },
          select: expect.objectContaining({
            id: true,
            providerIdentifier: true,
            disabled: true,
            refreshNeeded: true,
            tokenExpiration: true,
          }),
          orderBy: { createdAt: 'asc' },
        });

        expect(result).toHaveLength(4);

        // 1. Personal account checks
        const personal = result.find((a: any) => a.id === 'int_tt_personal');
        expect(personal).toBeDefined();
        expect(personal.platform).toBe('tiktok');
        expect(personal.providerIdentifier).toBe('tiktok');
        expect(personal.accountType).toBe('personal');
        expect(personal.username).toBe('@personal_user');
        // Default values applied
        expect(personal.autoPublishEnabled).toBe(true);
        expect(personal.dailyPostLimit).toBe(2);
        expect(personal.duplicateWindowDays).toBe(30);
        // Expired access token alone does NOT cause DISCONNECTED status!
        expect(personal.tokenExpired).toBe(true);
        expect(personal.status).toBe('ACTIVE');

        // 2. Business account checks (custom settings loaded)
        const business = result.find((a: any) => a.id === 'int_tt_business');
        expect(business).toBeDefined();
        expect(business.platform).toBe('tiktok');
        expect(business.providerIdentifier).toBe('tiktok-business');
        expect(business.accountType).toBe('business');
        expect(business.autoPublishEnabled).toBe(false);
        expect(business.dailyPostLimit).toBe(5);
        expect(business.duplicateWindowDays).toBe(60);
        expect(business.status).toBe('ACTIVE');

        // 3. Disabled account checks
        const disabled = result.find((a: any) => a.id === 'int_tt_disabled');
        expect(disabled.status).toBe('DISCONNECTED');

        // 4. Refresh needed account checks
        const refreshNeeded = result.find((a: any) => a.id === 'int_tt_refresh');
        expect(refreshNeeded.status).toBe('NEEDS_USER_ACTION');
      });

      it('returns empty array when no TikTok integrations exist', async () => {
        mockPrisma.integration.findMany.mockResolvedValue([]);
        const result = await controller.listTikTokAccounts(testOrg);
        expect(result).toEqual([]);
        expect(mockPrisma.snsAppSetting.findMany).not.toHaveBeenCalled();
      });
    });

    describe('PUT /tiktok/accounts/:id', () => {
      it('saves settings to SnsAppSetting with org isolation and returns updated account', async () => {
        mockPrisma.integration.findFirst.mockResolvedValue({
          id: 'int_tt_1',
          organizationId: 'org_123',
          providerIdentifier: 'tiktok',
        });

        // Existing setting has duplicateWindowDays=45
        mockPrisma.snsAppSetting.findUnique.mockResolvedValue({
          organizationId: 'org_123',
          key: 'sns:tiktok:account:int_tt_1',
          value: {
            autoPublishEnabled: true,
            dailyPostLimit: 2,
            duplicateWindowDays: 45,
            otherCustomField: 'keep_me',
          },
        });

        mockPrisma.snsAppSetting.upsert.mockResolvedValue({
          id: 'setting_1',
          organizationId: 'org_123',
          key: 'sns:tiktok:account:int_tt_1',
          value: {
            autoPublishEnabled: false,
            dailyPostLimit: 4,
            duplicateWindowDays: 45,
            otherCustomField: 'keep_me',
          },
        });

        const updateDto = {
          autoPublishEnabled: false,
          dailyPostLimit: 4,
        };

        const result = await controller.updateTikTokAccount(testOrg, 'int_tt_1', updateDto);

        // Verify Integration ownership check
        expect(mockPrisma.integration.findFirst).toHaveBeenCalledWith({
          where: {
            id: 'int_tt_1',
            organizationId: 'org_123',
            providerIdentifier: { in: ['tiktok', 'tiktok-business'] },
          },
        });

        // Verify SnsAppSetting upsert with merged values
        expect(mockPrisma.snsAppSetting.upsert).toHaveBeenCalledWith({
          where: {
            organizationId_key: {
              organizationId: 'org_123',
              key: 'sns:tiktok:account:int_tt_1',
            },
          },
          create: expect.objectContaining({
            organizationId: 'org_123',
            key: 'sns:tiktok:account:int_tt_1',
            value: expect.objectContaining({
              autoPublishEnabled: false,
              dailyPostLimit: 4,
              duplicateWindowDays: 45,
              otherCustomField: 'keep_me',
            }),
          }),
          update: expect.objectContaining({
            value: expect.objectContaining({
              autoPublishEnabled: false,
              dailyPostLimit: 4,
              duplicateWindowDays: 45,
              otherCustomField: 'keep_me',
            }),
          }),
        });

        expect(result).toMatchObject({
          id: 'int_tt_1',
          integrationId: 'int_tt_1',
          platform: 'tiktok',
          providerIdentifier: 'tiktok',
          accountType: 'personal',
          autoPublishEnabled: false,
          dailyPostLimit: 4,
          duplicateWindowDays: 45,
        });
      });

      it('throws 404 NOT_FOUND if integration does not belong to organization or is not TikTok', async () => {
        mockPrisma.integration.findFirst.mockResolvedValue(null);

        await expect(
          controller.updateTikTokAccount(testOrg, 'non_existent_or_other_org', {
            dailyPostLimit: 3,
          })
        ).rejects.toThrow(new HttpException('TikTok integration not found', HttpStatus.NOT_FOUND));

        expect(mockPrisma.snsAppSetting.upsert).not.toHaveBeenCalled();
      });
    });
  });

  // =========================================================================
  // Structural & Schema Guards
  // =========================================================================

  describe('Structural & Schema Guards', () => {
    const schemaPath = path.resolve(
      __dirname,
      '../../../../../libraries/nestjs-libraries/src/database/prisma/schema.prisma'
    );
    const controllerPath = path.resolve(__dirname, './sns-studio.controller.ts');
    const frontendPath = path.resolve(
      __dirname,
      '../../../../frontend/src/components/sns-studio/sns-studio.tsx'
    );

    const schemaContent = fs.readFileSync(schemaPath, 'utf8');
    const controllerContent = fs.readFileSync(controllerPath, 'utf8');
    const frontendContent = fs.readFileSync(frontendPath, 'utf8');

    it('does NOT contain custom common models (SnsSocialAccount, socialAccountId)', () => {
      expect(schemaContent).not.toContain('model SnsSocialAccount');
      expect(schemaContent).not.toContain('socialAccountId');
      expect(schemaContent).not.toContain('snsSocialAccounts');
    });

    it('does NOT contain generic social-accounts aliases in controller', () => {
      expect(controllerContent).not.toContain("@Get('/social-accounts')");
      expect(controllerContent).not.toContain("@Put('/social-accounts/:id')");
      expect(controllerContent).not.toContain("@Delete('/social-accounts/:id')");
      expect(controllerContent).not.toContain('type UpdateSocialAccountDto');
    });

    it('does NOT contain generic SocialAccount alias or archive button in frontend', () => {
      expect(frontendContent).not.toContain('type SocialAccount =');
      expect(frontendContent).not.toContain("request(`/sns-studio/tiktok/accounts/${account.id}`, { method: 'DELETE' }");
      expect(frontendContent).not.toContain('アーカイブ');
    });

    it('frontend uses platform === "tiktok" for filtering', () => {
      expect(frontendContent).toContain("a.platform === 'tiktok'");
      expect(frontendContent).not.toContain("a.platform === 'tiktok-business'");
    });

    it('integrates Postiz useAddProvider for TikTok connect', () => {
      expect(frontendContent).toContain('useAddProvider(refreshTikTokAccounts)');
      expect(frontendContent).toContain('TikTokを接続');
    });
  });

  // =========================================================================
  // Phase 2: TikTok Publish Adapter & Publishing Bridge Tests
  // =========================================================================

  describe('Phase 2: TikTokPublishAdapter & Publishing Bridge', () => {
    const adapterPath = path.resolve(
      __dirname,
      '../../services/sns-studio/tiktok-publish.adapter.ts'
    );
    const adapterContent = fs.readFileSync(adapterPath, 'utf8');

    it('TikTokPublishAdapter does NOT call provider.post() or provider.postPending() directly', () => {
      expect(adapterContent).not.toMatch(/\bprovider\.post\(/);
      expect(adapterContent).not.toMatch(/\bprovider\.postPending\(/);
      expect(adapterContent).not.toMatch(/\bTiktokProvider\.post\(/);
    });

    it('TikTokPublishAdapter delegates creation to PostsService.createPost with CreationMethod.API', () => {
      expect(adapterContent).toContain('this.postsService.createPost');
      expect(adapterContent).toContain('CreationMethod.API');
    });

    it('TikTokPublishAdapter delegates settings mapping to PostsService.mapTypeToPost', () => {
      expect(adapterContent).toContain('this.postsService.mapTypeToPost');
    });

    it('TikTokPublishAdapter delegates validation to PostsService.validatePosts', () => {
      expect(adapterContent).toContain('this.postsService.validatePosts');
    });

    it('Controller exposes /tiktok/preflight and /tiktok/publish endpoints', () => {
      const controllerPath = path.resolve(__dirname, './sns-studio.controller.ts');
      const controllerContent = fs.readFileSync(controllerPath, 'utf8');
      expect(controllerContent).toContain("@Post('/tiktok/preflight')");
      expect(controllerContent).toContain("@Post('/tiktok/publish')");
      expect(controllerContent).toContain('this.tiktokPublishAdapter.preflight');
      expect(controllerContent).toContain('this.tiktokPublishAdapter.publish');
    });
  });
});
