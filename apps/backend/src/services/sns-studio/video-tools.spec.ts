import { HttpException, HttpStatus } from '@nestjs/common';

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

describe('SnsStudioController.videoTools A & B Mode Regression Gate', () => {
  const orgA = { id: 'org-video-tools-a' } as any;
  const orgB = { id: 'org-video-tools-b' } as any;

  const createController = (options: {
    assets?: any[];
    inboxItems?: any[];
    jobs?: any[];
    workerResponses?: Record<string, any>;
  } = {}) => {
    const assets = (options.assets || []).map((a) => ({ ...a }));
    const inboxItems = (options.inboxItems || []).map((i) => ({ ...i }));
    const jobs = (options.jobs || []).map((j) => ({ ...j }));

    const prisma = {
      snsMediaAsset: {
        findFirst: jest.fn(({ where }: any) => {
          const match = assets.find((a) => {
            if (where.organizationId && a.organizationId !== where.organizationId) return false;
            if (where.storageKey && a.storageKey !== where.storageKey) return false;
            if (where.id && a.id !== where.id) return false;
            return true;
          });
          return Promise.resolve(match || null);
        }),
        create: jest.fn(({ data }: any) => {
          const newAsset = { id: `asset-${Date.now()}-${Math.random()}`, ...data };
          assets.push(newAsset);
          return Promise.resolve(newAsset);
        }),
      },
      snsContentInboxItem: {
        findFirst: jest.fn(({ where }: any) => {
          const match = inboxItems.find((i) => {
            if (where.organizationId && i.organizationId !== where.organizationId) return false;
            if (where.mediaAsset?.storageKey && i.mediaAsset?.storageKey !== where.mediaAsset.storageKey) return false;
            return true;
          });
          return Promise.resolve(match || null);
        }),
        create: jest.fn(({ data }: any) => {
          const newItem = { id: `inbox-${Date.now()}-${Math.random()}`, ...data };
          inboxItems.push(newItem);
          return Promise.resolve(newItem);
        }),
      },
      snsGenerationJob: {
        create: jest.fn(({ data }: any) => {
          const newJob = { id: `job-${Date.now()}-${Math.random()}`, createdAt: new Date(), ...data };
          jobs.push(newJob);
          return Promise.resolve(newJob);
        }),
        findFirst: jest.fn(({ where }: any) => {
          const match = jobs.find((j) => {
            if (where.organizationId && j.organizationId !== where.organizationId) return false;
            if (where.id && j.id !== where.id) return false;
            return true;
          });
          return Promise.resolve(match || null);
        }),
        update: jest.fn(({ where, data }: any) => {
          const match = jobs.find((j) => j.id === where.id);
          if (match) {
            Object.assign(match, data);
            return Promise.resolve(match);
          }
          return Promise.resolve(null);
        }),
      },
    };

    const googleDrive = {
      selectedFolder: jest.fn((orgId: string) => Promise.resolve({ id: `folder-${orgId}` })),
    };

    const generationProvider = {
      submit: jest.fn((manifest: any) => Promise.resolve({ queuePath: `drive-path-${manifest.jobId}` })),
    };

    const mediaService = {
      getMediaStatus: jest.fn((orgId: string, mediaId: string) =>
        Promise.resolve({ id: mediaId, path: `/uploads/media-${mediaId}.mp4` })
      ),
      saveFile: jest.fn((orgId: string, path: string) =>
        Promise.resolve({ id: `postiz-${path}`, path })
      ),
    };

    const controller = new SnsStudioController(
      prisma as any,
      googleDrive as any,
      generationProvider as any,
      mediaService as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any,
      {} as any
    );

    // Mock mediaWorker private method
    (controller as any).mediaWorker = jest.fn((path: string, method: string, payload: any) => {
      if (options.workerResponses && options.workerResponses[path]) {
        return Promise.resolve(options.workerResponses[path]);
      }
      if (path === '/analyze') {
        return Promise.resolve({
          fileName: 'ref.mp4',
          durationSeconds: 15.0,
          width: 1080,
          height: 1920,
          aspectRatio: '9:16',
          orientation: 'vertical',
          tempo: 'FAST',
          scenes: [
            { index: 1, startTime: 0, endTime: 3.5, duration: 3.5 },
            { index: 2, startTime: 3.5, endTime: 7.2, duration: 3.7 },
            { index: 3, startTime: 7.2, endTime: 15.0, duration: 7.8 },
          ],
          cutCount: 3,
          averageCutDurationSeconds: 5.0,
          hasAudio: true,
          hasBgm: true,
          isBgmEstimated: true,
        });
      }
      if (path === '/render-plan') {
        return Promise.resolve({
          path: '/uploads/sns-studio/renders/plan-output.mp4',
          fileName: 'plan-output.mp4',
          sizeBytes: 1048576,
          durationSeconds: 14.5,
          width: 1080,
          height: 1920,
          hasAudio: true,
          segmentCount: payload.segments?.length || 1,
        });
      }
      return Promise.resolve({});
    });

    return { controller, prisma, assets, inboxItems, jobs };
  };

  describe('Mode A: Video Analysis and Edit Plan', () => {
    it('analyzes reference video within current organization', async () => {
      const { controller } = createController({
        assets: [
          { organizationId: orgA.id, storageKey: '/uploads/ref-video.mp4', fileName: 'ref-video.mp4' },
        ],
      });

      const result = await controller.videoToolsAnalyze(orgA, { mediaPath: '/uploads/ref-video.mp4' });
      expect(result.durationSeconds).toBe(15.0);
      expect(result.tempo).toBe('FAST');
      expect(result.scenes.length).toBe(3);
    });

    it('rejects analyzing media owned by another organization with 404 (MEDIA_NOT_FOUND)', async () => {
      const { controller } = createController({
        assets: [
          { organizationId: orgB.id, storageKey: '/uploads/org-b-video.mp4', fileName: 'org-b-video.mp4' },
        ],
      });

      await expect(
        controller.videoToolsAnalyze(orgA, { mediaPath: '/uploads/org-b-video.mp4' })
      ).rejects.toThrow(
        expect.objectContaining({ status: HttpStatus.NOT_FOUND })
      );
    });

    it('generates an editable Edit Plan based on reference analysis and prompt', async () => {
      const { controller } = createController({
        assets: [
          { organizationId: orgA.id, storageKey: '/uploads/source.mp4', fileName: 'source.mp4' },
        ],
      });

      const referenceAnalysis = {
        aspectRatio: '9:16',
        durationSeconds: 10.0,
        tempo: 'FAST',
        hasBgm: true,
        scenes: [
          { index: 1, duration: 3.0 },
          { index: 2, duration: 4.0 },
          { index: 3, duration: 3.0 },
        ],
      };

      const plan = await controller.videoToolsGenerateEditPlan(orgA, {
        sourcePath: '/uploads/source.mp4',
        referenceAnalysis,
        instructionPrompt: '商品紹介テロップを入れてテンポよく',
        aspectRatio: '9:16',
      });

      expect(plan.sourcePath).toBe('/uploads/source.mp4');
      expect(plan.targetAspect).toBe('9:16');
      expect(plan.tempo).toBe('FAST');
      expect(plan.playbackSpeed).toBe(1.15); // FAST tempo recommendation
      expect(plan.segments.length).toBe(3);
      expect(plan.textOverlays.length).toBe(1);
      expect(plan.textOverlays[0].text).toContain('商品紹介テロップ');
    });

    it('renders an Edit Plan and registers SnsMediaAsset and SnsContentInboxItem (Queue ready)', async () => {
      const { controller, assets, inboxItems } = createController({
        assets: [
          { organizationId: orgA.id, storageKey: '/uploads/source.mp4', fileName: 'source.mp4' },
        ],
      });

      const renderResult = await controller.videoToolsRenderPlan(orgA, {
        sourcePath: '/uploads/source.mp4',
        outputName: 'final-product.mp4',
        segments: [
          { trimStartSeconds: 0, trimEndSeconds: 5, playbackSpeed: 1.0, order: 0 },
          { trimStartSeconds: 5, trimEndSeconds: 10, playbackSpeed: 1.1, order: 1 },
        ],
        textOverlays: [{ text: '注目の新商品', x: 0.5, y: 0.8, fontSize: 48, startTime: 0 }],
      });

      expect(renderResult.path).toBe('/uploads/sns-studio/renders/plan-output.mp4');
      expect(renderResult.mediaAssetId).toBeDefined();
      expect(renderResult.inboxItemId).toBeDefined();

      // Check SnsMediaAsset creation
      const savedAsset = assets.find((a) => a.id === renderResult.mediaAssetId);
      expect(savedAsset).toBeDefined();
      expect(savedAsset.organizationId).toBe(orgA.id);
      expect(savedAsset.source).toBe('AI_RE_EDIT');
      expect(savedAsset.storageKey).toBe('/uploads/sns-studio/renders/plan-output.mp4');

      // Check SnsContentInboxItem creation (Production Queue)
      const savedInbox = inboxItems.find((i) => i.id === renderResult.inboxItemId);
      expect(savedInbox).toBeDefined();
      expect(savedInbox.organizationId).toBe(orgA.id);
      expect(savedInbox.status).toBe('READY_FOR_REVIEW');
      expect(savedInbox.previewUrl).toContain('/sns-studio/media/preview');
    });

    it('rejects render-plan when segment contains another organization asset (404)', async () => {
      const { controller } = createController({
        assets: [
          { organizationId: orgA.id, storageKey: '/uploads/source.mp4', fileName: 'source.mp4' },
          { organizationId: orgB.id, storageKey: '/uploads/org-b-secret.mp4', fileName: 'org-b-secret.mp4' },
        ],
      });

      await expect(
        controller.videoToolsRenderPlan(orgA, {
          sourcePath: '/uploads/source.mp4',
          segments: [
            { sourcePath: '/uploads/org-b-secret.mp4', trimStartSeconds: 0, trimEndSeconds: 2, playbackSpeed: 1, order: 0 },
          ],
        })
      ).rejects.toThrow(
        expect.objectContaining({ status: HttpStatus.NOT_FOUND })
      );
    });
  });

  describe('Mode B: Generation Job Lifecycle & Isolation', () => {
    it('cancels a running generation job in current organization', async () => {
      const { controller, jobs } = createController({
        jobs: [
          { id: 'job-1', organizationId: orgA.id, status: 'QUEUED', inputManifest: {} },
        ],
      });

      const updated = await controller.cancelGenerationJob(orgA, 'job-1');
      expect(updated.status).toBe('CANCELLED');
      expect(jobs[0].status).toBe('CANCELLED');
    });

    it('rejects cancelling another organization generation job with 404', async () => {
      const { controller } = createController({
        jobs: [
          { id: 'job-b', organizationId: orgB.id, status: 'QUEUED', inputManifest: {} },
        ],
      });

      await expect(
        controller.cancelGenerationJob(orgA, 'job-b')
      ).rejects.toThrow(
        expect.objectContaining({ status: HttpStatus.NOT_FOUND })
      );
    });

    it('retries a failed generation job and resets status to QUEUED', async () => {
      const { controller, jobs } = createController({
        jobs: [
          { id: 'job-failed', organizationId: orgA.id, status: 'FAILED', inputManifest: { prompt: 'generate cute cat' }, errorCode: 'ERROR' },
        ],
      });

      const retried = await controller.retryGenerationJob(orgA, 'job-failed');
      expect(retried.status).toBe('QUEUED');
      expect(retried.errorCode).toBeNull();
      expect(jobs[0].status).toBe('QUEUED');
    });

    it('creates a generation job with structured { input: ... } contract matching frontend', async () => {
      const { controller, jobs } = createController();

      const created = await controller.createGenerationJob(orgA, {
        input: {
          prompt: 'A futuristic sports car drifting in neon city',
          mode: 'text-to-video',
          modelName: 'wan-2.1-t2v-1.3b',
          aspectRatio: '9:16',
          durationSeconds: 5,
        },
      });

      expect(created.status).toBe('QUEUED');
      expect(jobs.length).toBe(1);
      expect((jobs[0].inputManifest as any).modelName).toBe('wan-2.1-t2v-1.3b');
      expect((jobs[0].inputManifest as any).prompt).toContain('futuristic sports car');
    });

    it('rejects creating generation job when input object is missing', async () => {
      const { controller } = createController();

      await expect(
        controller.createGenerationJob(orgA, {} as any)
      ).rejects.toThrow(
        expect.objectContaining({ status: HttpStatus.BAD_REQUEST })
      );
    });
  });

  describe('Postiz Media Bridge Integration', () => {
    it('bridges SnsMediaAsset to Postiz Media and returns valid Postiz Media ID for common publisher', async () => {
      const { controller } = createController({
        assets: [
          {
            id: 'asset-rendered-123',
            organizationId: orgA.id,
            storageKey: '/uploads/sns-studio/rendered/output.mp4',
            fileName: 'output.mp4',
            metadata: { postizMediaId: 'postiz-media-real-999' },
          },
        ],
      });

      const result = await controller.createPostMedia(orgA, 'asset-rendered-123');
      expect(result).toBeDefined();
      expect(result.sourceAssetId).toBe('asset-rendered-123');
      expect(result.media.id).toBe('postiz-media-real-999');
    });

    it('rejects bridging when passed an invalid ID such as a Generation Job ID', async () => {
      const { controller } = createController({
        jobs: [
          { id: 'job-xyz-not-asset', organizationId: orgA.id, status: 'COMPLETE', inputManifest: {} },
        ],
      });

      await expect(
        controller.createPostMedia(orgA, 'job-xyz-not-asset')
      ).rejects.toThrow(
        expect.objectContaining({ status: HttpStatus.NOT_FOUND })
      );
    });
  });

  describe('Mode A NLP Instruction Parser', () => {
    it('extracts cut count, speed, and telop text from Japanese natural language prompt', async () => {
      const { controller } = createController({
        assets: [
          { organizationId: orgA.id, storageKey: '/uploads/source.mp4', fileName: 'source.mp4' },
        ],
      });

      const plan = await controller.videoToolsGenerateEditPlan(orgA, {
        sourcePath: '/uploads/source.mp4',
        instructionPrompt: '3カットでテンポよく高速に、テロップ: タイムセール開催中',
        targetDurationSeconds: 12,
      });

      expect(plan.segments.length).toBe(3);
      expect(plan.playbackSpeed).toBe(1.15); // 'テンポよく高速'
      expect(plan.textOverlays.length).toBe(1);
      expect(plan.textOverlays[0].text).toBe('タイムセール開催中');
    });
  });
});
