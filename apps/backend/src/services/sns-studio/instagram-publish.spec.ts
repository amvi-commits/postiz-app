import { HttpException } from '@nestjs/common';
import { SnsStudioController } from '../../api/routes/sns-studio.controller';

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

describe('SnsStudioController.publishReel failure handling', () => {
  it('records one failed publish row and calls the Instagram worker once', async () => {
    const publishRecord = { id: 'publish-record-1' };
    const prisma = {
      snsPublishRecord: {
        create: jest.fn().mockResolvedValue(publishRecord),
        update: jest.fn().mockResolvedValue({ ...publishRecord, status: 'FAILED' }),
      },
    };
    const controller = new SnsStudioController(prisma as any, {} as any, {} as any, {} as any, { run: (_context: any, operation: () => Promise<any>) => operation() } as any, {} as any, {} as any, {} as any, {} as any);
    const worker = jest.fn().mockRejectedValue(new HttpException({ code: 'IG_UPLOAD_FAILED' }, 502));
    (controller as any).account = jest.fn().mockResolvedValue({ id: 'account-1' });
    (controller as any).preflightReel = jest.fn().mockResolvedValue({ ready: true, warnings: [] });
    (controller as any).worker = worker;

    let thrown: unknown;
    try {
      await controller.publishReel(
        { id: 'org-1' } as any,
        { accountId: 'account-1', videoPath: '/uploads/reel.mp4', caption: 'Local mock', trialReel: false } as any,
      );
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(HttpException);
    expect((thrown as HttpException).getStatus()).toBe(502);
    expect((thrown as HttpException).getResponse()).toEqual({ code: 'IG_UPLOAD_FAILED' });
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith(
      '/publish/reel',
      'POST',
      expect.objectContaining({ accountId: 'account-1', videoPath: '/uploads/reel.mp4' }),
    );
    expect(prisma.snsPublishRecord.create).toHaveBeenCalledTimes(1);
    expect(prisma.snsPublishRecord.update).toHaveBeenCalledTimes(1);
    expect(prisma.snsPublishRecord.update).toHaveBeenCalledWith({
      where: { id: 'publish-record-1' },
      data: expect.objectContaining({ status: 'FAILED', errorCode: 'IG_UPLOAD_FAILED' }),
    });
  });
});

describe('SnsStudioController.listAccounts organization scope', () => {
  const accounts: Array<{
    id: string;
    username: string;
    organizationId: string;
    archivedAt: null;
  }> = [
    { id: 'local-account-1', username: 'mock_sns_studio_demo', organizationId: 'local-test', archivedAt: null },
    { id: 'local-account-2', username: 'mock_sns_studio_secondary', organizationId: 'local-test', archivedAt: null },
    { id: 'group-account-1', username: 'lovenight_8r', organizationId: 'group', archivedAt: null },
  ];

  const createController = () => {
    const prisma = {
      snsInstagramAccount: {
        findMany: jest.fn(({ where }: any) =>
          Promise.resolve(
            accounts.filter(
              (account) =>
                account.organizationId === where.organizationId &&
                account.archivedAt === where.archivedAt,
            ),
          ),
        ),
      },
    };
    const controller = new SnsStudioController(prisma as any, {} as any, {} as any, {} as any, { run: (_context: any, operation: () => Promise<any>) => operation() } as any, {} as any, {} as any, {} as any, {} as any);
    const worker = jest.fn().mockResolvedValue({ status: 'GREEN', session: 'VALID' });
    (controller as any).worker = worker;
    return { controller, prisma, worker };
  };

  it('returns only the two mock accounts for SNS Studio Local Test', async () => {
    const { controller, prisma, worker } = createController();

    const result = await controller.listAccounts({ id: 'local-test' } as any);

    expect(prisma.snsInstagramAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organizationId: 'local-test', archivedAt: null },
      }),
    );
    expect(result.map((account: any) => account.username)).toEqual([
      'mock_sns_studio_demo',
      'mock_sns_studio_secondary',
    ]);
    expect(worker.mock.calls.map(([path]) => path)).toEqual([
      '/accounts/local-account-1/health',
      '/accounts/local-account-2/health',
    ]);
  });

  it('returns only @lovenight_8r for group without mixing Organizations', async () => {
    const { controller, worker } = createController();

    const result = await controller.listAccounts({ id: 'group' } as any);

    expect(result.map((account: any) => account.username)).toEqual(['lovenight_8r']);
    expect(worker).toHaveBeenCalledTimes(1);
    expect(worker).toHaveBeenCalledWith('/accounts/group-account-1/health');
    expect(worker.mock.calls.some(([path]) => /\/accounts\/login|\/publish\/reel/.test(path))).toBe(false);
  });
});

describe('SnsStudioController.preflightStory read-only behavior', () => {
  const body = {
    accountId: 'account-1',
    mediaPath: '/uploads/story.mp4',
    mediaType: 'video',
    linkUrl: 'https://example.com/',
    sticker: { x: 0.5, y: 0.5, width: 0.51, height: 0.26, rotation: 0 },
  };

  const createController = (healthStatus = 'GREEN') => {
    const prisma = {
      snsInstagramAccount: {
        findFirst: jest.fn().mockResolvedValue({ id: 'account-1', username: 'lovenight_8r', status: 'ACTIVE' }),
        update: jest.fn(),
      },
      snsPublishRecord: { create: jest.fn(), update: jest.fn() },
    };
    const mediaWorker = jest.fn().mockResolvedValue({
      kind: 'video', sizeBytes: 123381, durationSeconds: 3.675,
      video: { width: 1080, height: 1920, codec: 'h264' }, hasAudio: true,
    });
    const worker = jest.fn().mockResolvedValue({ status: healthStatus, session: 'VALID' });
    const controller = new SnsStudioController(prisma as any, {} as any, {} as any, {} as any);
    (controller as any).mediaWorker = mediaWorker;
    (controller as any).worker = worker;
    return { controller, prisma, mediaWorker, worker };
  };

  it('probes the media and session without creating a publish record or calling Worker publish', async () => {
    const { controller, prisma, mediaWorker, worker } = createController();

    const result = await controller.preflightStory({ id: 'org-1' } as any, body as any);

    expect(result.ready).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.account).toEqual({ id: 'account-1', username: 'lovenight_8r', status: 'GREEN' });
    expect(mediaWorker).toHaveBeenCalledWith('/probe', 'POST', { path: body.mediaPath });
    expect(worker).toHaveBeenCalledWith('/accounts/account-1/health');
    expect(worker.mock.calls.map(([path]) => path)).not.toContain('/publish/story');
    expect(prisma.snsPublishRecord.create).not.toHaveBeenCalled();
    expect(prisma.snsPublishRecord.update).not.toHaveBeenCalled();
    expect(prisma.snsInstagramAccount.update).not.toHaveBeenCalled();
  });

  it('returns a hard error for unhealthy session and still creates no publish record', async () => {
    const { controller, prisma, worker } = createController('YELLOW');

    const result = await controller.preflightStory({ id: 'org-1' } as any, body as any);

    expect(result.ready).toBe(false);
    expect(result.errors).toContain('INSTAGRAM_SESSION_NOT_HEALTHY');
    expect(worker.mock.calls.map(([path]) => path)).toEqual(['/accounts/account-1/health']);
    expect(prisma.snsPublishRecord.create).not.toHaveBeenCalled();
    expect(prisma.snsInstagramAccount.update).not.toHaveBeenCalled();
  });
});
