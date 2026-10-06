import { HttpException, HttpStatus } from '@nestjs/common';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

jest.mock('isomorphic-dompurify', () => ({
  __esModule: true,
  default: { sanitize: (value: any) => value },
  sanitize: (value: any) => value,
}));
jest.mock('nostr-tools', () => ({
  getPublicKey: jest.fn(),
  Relay: jest.fn(),
  finalizeEvent: jest.fn(),
  SimplePool: jest.fn(),
}));
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));
jest.mock(
  '@gitroom/nestjs-libraries/user/org.from.request',
  () => ({ GetOrgFromRequest: () => () => undefined }),
  { virtual: true },
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/prisma.service',
  () => ({ PrismaService: class PrismaService {} }),
  { virtual: true },
);
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({ MediaService: class MediaService {} }),
  { virtual: true },
);
jest.mock(
  '@gitroom/nestjs-libraries/upload/upload.factory',
  () => ({ UploadFactory: { createStorage: jest.fn(() => ({})) } }),
  { virtual: true },
);
jest.mock(
  '@gitroom/nestjs-libraries/upload/custom.upload.validation',
  () => ({ uploadStreamToStorage: jest.fn() }),
  { virtual: true },
);
jest.mock('@gitroom/helpers/utils/shuffle-bag', () => ({ chooseShuffleBagItem: jest.fn() }), { virtual: true });
jest.mock('@gitroom/backend/services/sns-studio/google-drive.storage', () => ({ GoogleDriveStorageProvider: class {} }), { virtual: true });
jest.mock('@gitroom/backend/services/sns-studio/google-drive.generation-provider', () => ({ GoogleDriveGenerationProvider: class {} }), { virtual: true });
jest.mock('@gitroom/backend/services/sns-studio/caption-provider.interface', () => ({ SNS_STUDIO_CAPTION_PROVIDER: Symbol('caption-provider') }), { virtual: true });
jest.mock('@gitroom/backend/services/sns-studio/instagram-metrics', () => ({ normalizeInstagramMetrics: jest.fn() }), { virtual: true });

import { SnsStudioController } from '../../api/routes/sns-studio.controller';

describe('SnsStudioController.mediaRetention & cleanup regression gate', () => {
  const testDir = join(tmpdir(), `sns-retention-test-${Date.now()}`);
  const uploadsDir = join(testDir, 'uploads');
  const rendersDir = join(uploadsDir, 'sns-studio', 'renders');
  const org = { id: 'org-retention-test' } as any;
  const originalUploadDir = process.env.UPLOAD_DIRECTORY;

  beforeAll(() => {
    process.env.UPLOAD_DIRECTORY = uploadsDir;
    mkdirSync(rendersDir, { recursive: true });
  });

  afterAll(() => {
    if (originalUploadDir) process.env.UPLOAD_DIRECTORY = originalUploadDir;
    else delete process.env.UPLOAD_DIRECTORY;
    try {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  const createController = (options: {
    retentionDaysValue?: number | null;
    assets?: any[];
  } = {}) => {
    let settingValue = options.retentionDaysValue !== undefined ? options.retentionDaysValue : null;
    const dbAssets = (options.assets || []).map((a) => ({ ...a }));

    const prisma = {
      snsAppSetting: {
        findUnique: jest.fn(({ where }: any) => {
          if (where.organizationId_key?.key === 'sns:retention-days' && settingValue !== null) {
            return Promise.resolve({
              organizationId: where.organizationId_key.organizationId,
              key: 'sns:retention-days',
              value: settingValue,
            });
          }
          return Promise.resolve(null);
        }),
        upsert: jest.fn(({ create, update }: any) => {
          settingValue = update.value ?? create.value;
          return Promise.resolve({
            organizationId: org.id,
            key: 'sns:retention-days',
            value: settingValue,
          });
        }),
      },
      snsMediaAsset: {
        findMany: jest.fn(({ where }: any) => {
          return Promise.resolve(
            dbAssets.filter((a) => {
              if (a.organizationId !== where.organizationId) return false;
              if (where.isFinal !== undefined && a.isFinal !== where.isFinal) return false;
              if (where.publishedAt?.lte) {
                if (!a.publishedAt) return false;
                if (new Date(a.publishedAt).getTime() > new Date(where.publishedAt.lte).getTime()) return false;
              }
              return true;
            })
          );
        }),
        update: jest.fn(({ where, data }: any) => {
          const match = dbAssets.find((a) => a.id === where.id);
          if (match) {
            Object.assign(match, data);
            return Promise.resolve(match);
          }
          return Promise.resolve(null);
        }),
      },
    };

    const controller = new SnsStudioController(
      prisma as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    return { controller, prisma, dbAssets, getSettingValue: () => settingValue };
  };

  describe('retention settings', () => {
    it('returns default 7 days when no setting is saved', async () => {
      const { controller } = createController();
      const result = await controller.snsSettings(org);
      expect(result).toEqual({ retentionDays: 7 });
    });

    it('returns configured retention days when set in DB', async () => {
      const { controller } = createController({ retentionDaysValue: 30 });
      const result = await controller.snsSettings(org);
      expect(result).toEqual({ retentionDays: 30 });
    });

    it('allows updating retention days to 0, 7, and 30', async () => {
      const { controller, getSettingValue } = createController();

      const r0 = await controller.updateSnsSettings(org, { retentionDays: 0 });
      expect(r0).toEqual({ retentionDays: 0 });
      expect(getSettingValue()).toBe(0);

      const r7 = await controller.updateSnsSettings(org, { retentionDays: 7 });
      expect(r7).toEqual({ retentionDays: 7 });
      expect(getSettingValue()).toBe(7);

      const r30 = await controller.updateSnsSettings(org, { retentionDays: 30 });
      expect(r30).toEqual({ retentionDays: 30 });
      expect(getSettingValue()).toBe(30);
    });

    it('rejects invalid retention days values with 400 RETENTION_DAYS_INVALID', async () => {
      const { controller } = createController();

      for (const invalidValue of [1, 14, 60, -1, 999]) {
        await expect(controller.updateSnsSettings(org, { retentionDays: invalidValue })).rejects.toThrow(
          expect.objectContaining({
            status: HttpStatus.BAD_REQUEST,
          })
        );
      }
    });
  });

  describe('media cleanup', () => {
    it('skips cleanup when retentionDays is 0 (keep forever)', async () => {
      const expiredDate = new Date(Date.now() - 40 * 24 * 60 * 60_000);
      const filePath = join(rendersDir, 'keep-forever.mp4');
      writeFileSync(filePath, 'dummy');

      const { controller } = createController({
        retentionDaysValue: 0,
        assets: [
          {
            id: 'asset-keep',
            organizationId: org.id,
            storageKey: '/uploads/sns-studio/renders/keep-forever.mp4',
            isFinal: true,
            publishedAt: expiredDate,
          },
        ],
      });

      const result = await controller.runCleanup(org);
      expect(result).toEqual({ deleted: 0 });
      expect(existsSync(filePath)).toBe(true);
    });

    it('deletes expired render files and updates metadata', async () => {
      const now = Date.now();
      const expiredDate = new Date(now - 10 * 24 * 60 * 60_000); // 10 days ago (cutoff is 7)
      const freshDate = new Date(now - 2 * 24 * 60 * 60_000); // 2 days ago

      const expiredFilePath = join(rendersDir, 'expired.mp4');
      const freshFilePath = join(rendersDir, 'fresh.mp4');
      writeFileSync(expiredFilePath, 'expired-content');
      writeFileSync(freshFilePath, 'fresh-content');

      const { controller, dbAssets } = createController({
        retentionDaysValue: 7,
        assets: [
          {
            id: 'asset-expired',
            organizationId: org.id,
            storageKey: '/uploads/sns-studio/renders/expired.mp4',
            isFinal: true,
            publishedAt: expiredDate,
            metadata: { originalName: 'expired.mp4' },
          },
          {
            id: 'asset-fresh',
            organizationId: org.id,
            storageKey: '/uploads/sns-studio/renders/fresh.mp4',
            isFinal: true,
            publishedAt: freshDate,
          },
        ],
      });

      const result = await controller.runCleanup(org);
      expect(result.deleted).toBe(1);

      // Expired file is unlinked
      expect(existsSync(expiredFilePath)).toBe(false);
      // Fresh file is retained
      expect(existsSync(freshFilePath)).toBe(true);

      // DB asset metadata has cleanupCheckedAt
      const updatedAsset = dbAssets.find((a) => a.id === 'asset-expired');
      expect(updatedAsset.metadata?.cleanupCheckedAt).toBeDefined();
      expect(updatedAsset.metadata?.originalName).toBe('expired.mp4');
    });

    it('safely skips files outside /uploads/sns-studio/renders/', async () => {
      const expiredDate = new Date(Date.now() - 10 * 24 * 60 * 60_000);
      const externalFile = join(uploadsDir, 'user-raw.mp4');
      writeFileSync(externalFile, 'important-user-media');

      const { controller } = createController({
        retentionDaysValue: 7,
        assets: [
          {
            id: 'asset-user-raw',
            organizationId: org.id,
            storageKey: '/uploads/user-raw.mp4', // NOT in sns-studio/renders/
            isFinal: true,
            publishedAt: expiredDate,
          },
        ],
      });

      const result = await controller.runCleanup(org);
      expect(result.deleted).toBe(0);
      expect(existsSync(externalFile)).toBe(true);
    });

    it('does not throw when file on disk is already missing', async () => {
      const expiredDate = new Date(Date.now() - 10 * 24 * 60 * 60_000);

      const { controller, dbAssets } = createController({
        retentionDaysValue: 7,
        assets: [
          {
            id: 'asset-already-gone',
            organizationId: org.id,
            storageKey: '/uploads/sns-studio/renders/already-gone.mp4',
            isFinal: true,
            publishedAt: expiredDate,
            metadata: {},
          },
        ],
      });

      // Should complete cleanly without error
      const result = await controller.runCleanup(org);
      expect(result.deleted).toBe(0);

      const updatedAsset = dbAssets.find((a) => a.id === 'asset-already-gone');
      expect(updatedAsset.metadata?.cleanupCheckedAt).toBeDefined();
    });
  });
});
