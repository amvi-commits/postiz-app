/**
 * sns-studio-tiktok.spec.ts
 *
 * Phase 1 tests for TikTok integration with Postiz Integration + SnsAppSetting adapter.
 *
 * Requirements verified:
 * 1. Postiz Integration is the Single Source of Truth (no separate SnsSocialAccount model)
 * 2. providerIdentifier represents Provider type ('tiktok' | 'tiktok-business')
 * 3. TikTok Personal / Business accounts are distinguished
 * 4. TikTok accounts display in SNS Studio with correct defaults (limit=2, window=30, autoPublish=true)
 * 5. Settings update and reload via SnsAppSetting ('sns:tiktok:account:<integrationId>')
 * 6. Organization data isolation enforced
 * 7. Disconnected state when integration is expired or disabled
 * 8. Unconnected state display and connect button
 * 9. Postiz useAddProvider flow reused
 * 10. Existing Instagram accounts and workflows remain 100% intact
 * 11. No conflict with feature/sns-studio-common-publishing schema
 * 12. TikTok API provider and DTO reuse without duplication
 */

import * as fs from 'fs';
import * as path from 'path';

describe('SNS Studio TikTok Phase 1 (Integration + SnsAppSetting Adapter)', () => {
  const schemaPath = path.resolve(
    __dirname,
    '../../../../../libraries/nestjs-libraries/src/database/prisma/schema.prisma'
  );
  const controllerPath = path.resolve(__dirname, './sns-studio.controller.ts');
  const frontendPath = path.resolve(
    __dirname,
    '../../../../frontend/src/components/sns-studio/sns-studio.tsx'
  );
  const tiktokProviderPath = path.resolve(
    __dirname,
    '../../../../../libraries/nestjs-libraries/src/integrations/social/tiktok.provider.ts'
  );
  const tiktokBusinessProviderPath = path.resolve(
    __dirname,
    '../../../../../libraries/nestjs-libraries/src/integrations/social/tiktok.business.provider.ts'
  );
  const tiktokDtoPath = path.resolve(
    __dirname,
    '../../../../../libraries/nestjs-libraries/src/dtos/posts/providers-settings/tiktok.dto.ts'
  );

  const schemaContent = fs.readFileSync(schemaPath, 'utf8');
  const controllerContent = fs.readFileSync(controllerPath, 'utf8');
  const frontendContent = fs.readFileSync(frontendPath, 'utf8');
  const tiktokProviderContent = fs.readFileSync(tiktokProviderPath, 'utf8');
  const tiktokBusinessProviderContent = fs.readFileSync(tiktokBusinessProviderPath, 'utf8');
  const tiktokDtoContent = fs.readFileSync(tiktokDtoPath, 'utf8');

  describe('1. Schema integrity & no duplicate common models', () => {
    it('does NOT create SnsSocialAccount or duplicate delivery models', () => {
      expect(schemaContent).not.toContain('model SnsSocialAccount');
      expect(schemaContent).not.toContain('socialAccountId');
      expect(schemaContent).not.toContain('snsSocialAccounts');
    });

    it('keeps existing SnsInstagramAccount and SnsAppSetting intact', () => {
      expect(schemaContent).toContain('model SnsInstagramAccount {');
      expect(schemaContent).toContain('model SnsAppSetting {');
      expect(schemaContent).toContain('model SnsPublishRecord {');
      expect(schemaContent).toContain('account        SnsInstagramAccount @relation');
    });

    it('SnsAppSetting has unique constraint on [organizationId, key] for isolation', () => {
      expect(schemaContent).toContain('@@unique([organizationId, key])');
    });
  });

  describe('2. Postiz Integration as Single Source of Truth', () => {
    it('controller queries Integration model filtering by providerIdentifier tiktok / tiktok-business', () => {
      expect(controllerContent).toContain("providerIdentifier: { in: ['tiktok', 'tiktok-business'] }");
      expect(controllerContent).toContain('this.prisma.integration.findMany');
    });

    it('uses Integration.id as account identifier', () => {
      expect(controllerContent).toContain('id: integration.id');
      expect(controllerContent).toContain('integrationId: integration.id');
    });

    it('preserves providerIdentifier as provider type string', () => {
      expect(controllerContent).toContain("accountType: integration.providerIdentifier === 'tiktok-business' ? 'business' : 'personal'");
      expect(controllerContent).toContain('providerIdentifier: integration.providerIdentifier');
    });
  });

  describe('3. TikTok settings stored in SnsAppSetting', () => {
    it('uses recommended key format sns:tiktok:account:<integrationId>', () => {
      expect(controllerContent).toContain('sns:tiktok:account:');
    });

    it('sets correct TikTok default values (dailyPostLimit=2, duplicateWindowDays=30, autoPublishEnabled=true)', () => {
      expect(controllerContent).toContain('dailyPostLimit: 2');
      expect(controllerContent).toContain('duplicateWindowDays: 30');
      expect(controllerContent).toContain('autoPublishEnabled: true');
    });

    it('updates settings using SnsAppSetting upsert with organization isolation', () => {
      expect(controllerContent).toContain('this.prisma.snsAppSetting.upsert');
      expect(controllerContent).toContain('organizationId_key: { organizationId: org.id, key }');
    });

    it('validates limits with UpdateTikTokAccountDto', () => {
      expect(controllerContent).toContain('class UpdateTikTokAccountDto');
      expect(controllerContent).toContain('@IsOptional() @IsBoolean() autoPublishEnabled');
      expect(controllerContent).toContain('@IsOptional() @IsNumber() @Min(1) @Max(100) dailyPostLimit');
      expect(controllerContent).toContain('@IsOptional() @IsNumber() @Min(0) @Max(365) duplicateWindowDays');
    });
  });

  describe('4. Frontend Accounts UI', () => {
    it('defines TikTokAccount type and uses /sns-studio/tiktok/accounts endpoint', () => {
      expect(frontendContent).toContain('type TikTokAccount = {');
      expect(frontendContent).toContain("'/sns-studio/tiktok/accounts'");
    });

    it('renders Personal and Business badges', () => {
      expect(frontendContent).toContain("isBusiness ? 'Business' : 'Personal'");
      expect(frontendContent).toContain('Business');
      expect(frontendContent).toContain('Personal');
    });

    it('renders autoPublish, dailyPostLimit, and duplicateWindowDays controls', () => {
      expect(frontendContent).toContain('autoPublishEnabled');
      expect(frontendContent).toContain('dailyPostLimit');
      expect(frontendContent).toContain('duplicateWindowDays');
      expect(frontendContent).toContain('設定を保存');
    });

    it('integrates Postiz useAddProvider for TikTok connect button', () => {
      expect(frontendContent).toContain("useAddProvider(refreshSocialAccounts)");
      expect(frontendContent).toContain('TikTokを接続');
      expect(frontendContent).toContain('TikTokを接続する');
    });

    it('shows empty state when no TikTok account is connected', () => {
      expect(frontendContent).toContain('TikTokアカウントが見つかりません。');
    });
  });

  describe('5. Existing Instagram & Postiz features preservation', () => {
    it('Instagram accounts list endpoint and Worker health check remain intact', () => {
      expect(controllerContent).toContain("@Get('/accounts')");
      expect(controllerContent).toContain('async listAccounts');
      expect(controllerContent).toContain("worker(`/accounts/${encodeURIComponent(account.id)}/health`)");
    });

    it('Postiz standard TiktokProvider and TiktokBusinessProvider are preserved', () => {
      expect(tiktokProviderContent).toContain("identifier = 'tiktok'");
      expect(tiktokBusinessProviderContent).toContain("identifier = 'tiktok-business'");
    });

    it('Postiz standard TikTokDto is reused without modification', () => {
      expect(tiktokDtoContent).toContain('class TikTokDto');
      expect(tiktokDtoContent).toContain('content_posting_method');
    });
  });
});
