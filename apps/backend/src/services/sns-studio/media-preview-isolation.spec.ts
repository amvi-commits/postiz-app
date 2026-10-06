import { HttpException, HttpStatus } from '@nestjs/common';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';

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

describe('SnsStudioController.mediaPreview regression & isolation gate', () => {
  const testDir = join(tmpdir(), `sns-preview-test-${Date.now()}`);
  const uploadsDir = join(testDir, 'uploads');
  const orgA = { id: 'org-preview-a' } as any;
  const orgB = { id: 'org-preview-b' } as any;
  const videoBuffer = Buffer.alloc(2048, 0x42); // 2048 bytes of test data
  const originalUploadDir = process.env.UPLOAD_DIRECTORY;

  beforeAll(() => {
    process.env.UPLOAD_DIRECTORY = uploadsDir;
    mkdirSync(uploadsDir, { recursive: true });
    writeFileSync(join(uploadsDir, 'video-a.mp4'), videoBuffer);
  });

  afterAll(() => {
    if (originalUploadDir) process.env.UPLOAD_DIRECTORY = originalUploadDir;
    else delete process.env.UPLOAD_DIRECTORY;
    try {
      if (existsSync(testDir)) rmSync(testDir, { recursive: true, force: true });
    } catch {}
  });

  const createMockResponse = () => {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    const chunks: Buffer[] = [];

    const res: any = new Writable({
      write(chunk, _encoding, callback) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
        callback();
      },
    });

    res.status = (code: number) => {
      statusCode = code;
      return res;
    };
    res.setHeader = (name: string, value: string) => {
      headers[name.toLowerCase()] = String(value);
      return res;
    };
    res.getStatusCode = () => statusCode;
    res.getHeader = (name: string) => headers[name.toLowerCase()];
    res.getHeaders = () => ({ ...headers });
    res.getBody = () => Buffer.concat(chunks);

    return res;
  };

  const createController = (dbAssets: Array<{ organizationId: string; storageKey: string; mimeType: string }>) => {
    const prisma = {
      snsMediaAsset: {
        findFirst: jest.fn(({ where }: any) => {
          const match = dbAssets.find(
            (a) => a.organizationId === where.organizationId && a.storageKey === where.storageKey
          );
          return Promise.resolve(match || null);
        }),
      },
      snsStoryPoolItem: {
        findFirst: jest.fn(() => Promise.resolve(null)),
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
    return { controller, prisma };
  };

  it('serves 200 with full content and correct headers for current organization asset', async () => {
    const { controller } = createController([
      { organizationId: orgA.id, storageKey: '/uploads/video-a.mp4', mimeType: 'video/mp4' },
    ]);
    const res = createMockResponse();
    const req = { headers: {} } as any;

    await controller.mediaPreview(orgA, '/uploads/video-a.mp4', req, res);

    expect(res.getStatusCode()).toBe(200);
    expect(res.getHeader('content-type')).toBe('video/mp4');
    expect(res.getHeader('accept-ranges')).toBe('bytes');
    expect(res.getHeader('content-length')).toBe(String(videoBuffer.length));
    expect(res.getHeader('content-range')).toBeUndefined();
    expect(res.getBody().length).toBe(videoBuffer.length);
    expect(res.getBody().equals(videoBuffer)).toBe(true);
  });

  it('serves 206 Partial Content when Range header is provided (bytes=0-1023)', async () => {
    const { controller } = createController([
      { organizationId: orgA.id, storageKey: '/uploads/video-a.mp4', mimeType: 'video/mp4' },
    ]);
    const res = createMockResponse();
    const req = { headers: { range: 'bytes=0-1023' } } as any;

    await controller.mediaPreview(orgA, '/uploads/video-a.mp4', req, res);

    expect(res.getStatusCode()).toBe(206);
    expect(res.getHeader('content-type')).toBe('video/mp4');
    expect(res.getHeader('accept-ranges')).toBe('bytes');
    expect(res.getHeader('content-range')).toBe(`bytes 0-1023/${videoBuffer.length}`);
    expect(res.getHeader('content-length')).toBe('1024');
    expect(res.getBody().length).toBe(1024);
    expect(res.getBody().equals(videoBuffer.subarray(0, 1024))).toBe(true);
  });

  it('returns 404 (MEDIA_NOT_FOUND) when Organization B requests Organization A asset', async () => {
    const { controller } = createController([
      { organizationId: orgA.id, storageKey: '/uploads/video-a.mp4', mimeType: 'video/mp4' },
    ]);
    const res = createMockResponse();
    const req = { headers: {} } as any;

    await expect(controller.mediaPreview(orgB, '/uploads/video-a.mp4', req, res)).rejects.toThrow(
      expect.objectContaining({
        status: HttpStatus.NOT_FOUND,
      })
    );

    // Verify response leakage: the error must be generic MEDIA_NOT_FOUND, not 403 or mentioning other org
    try {
      await controller.mediaPreview(orgB, '/uploads/video-a.mp4', req, res);
    } catch (error) {
      expect(error).toBeInstanceOf(HttpException);
      const response = (error as HttpException).getResponse() as any;
      expect(response.code).toBe('MEDIA_NOT_FOUND');
      expect(JSON.stringify(response)).not.toContain('other organization');
      expect(JSON.stringify(response)).not.toContain('owner');
      expect(JSON.stringify(response)).not.toContain(orgA.id);
    }
  });

  it('returns 404 when file does not exist on disk even if DB asset exists', async () => {
    const { controller } = createController([
      { organizationId: orgA.id, storageKey: '/uploads/missing-file.mp4', mimeType: 'video/mp4' },
    ]);
    const res = createMockResponse();
    const req = { headers: {} } as any;

    await expect(controller.mediaPreview(orgA, '/uploads/missing-file.mp4', req, res)).rejects.toThrow(
      expect.objectContaining({
        status: HttpStatus.NOT_FOUND,
      })
    );
  });

  it('returns 400 when mediaPath is missing', async () => {
    const { controller } = createController([]);
    const res = createMockResponse();
    const req = { headers: {} } as any;

    await expect(controller.mediaPreview(orgA, '', req, res)).rejects.toThrow(
      expect.objectContaining({
        status: HttpStatus.BAD_REQUEST,
      })
    );
  });
});
