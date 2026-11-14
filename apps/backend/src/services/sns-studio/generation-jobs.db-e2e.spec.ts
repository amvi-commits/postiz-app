/** Disposable DB + real FFmpeg validation. Drive/execution envelopes are fixtures,
 * never evidence of real Colab/model/Drive success. */
import { PrismaClient } from '@prisma/client';
import { randomUUID, createHash } from 'crypto';
import { copyFileSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';
import sharp from 'sharp';
import { GenerationJobs } from './generation-jobs';
import { generationInputHash } from './generation-manifest';
jest.mock('isomorphic-dompurify', () => ({ __esModule: true, default: { sanitize: (value: any) => value } }));
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));
import { SnsStudioController } from '../../api/routes/sns-studio.controller';
import express from 'express';
import { createServer, Server } from 'http';

const enabled = process.env.BMODE_DB_E2E === '1';
(enabled ? describe : describe.skip)('B-mode isolated DB integrity (fixture Drive, not real AI E2E)', () => {
  const p = new PrismaClient();
  const fixture = '/bmode-fixtures/contract-video.mp4';
  let sha: string;
  let org: string, other: string, service: GenerationJobs, drive: any, provider: any;
  let manifests: Map<string, any>;
  let validate: jest.Mock;
  beforeAll(async () => {
    const url = new URL(process.env.DATABASE_URL || '');
    if (!['bmode-db', 'localhost', '127.0.0.1'].includes(url.hostname) || !/^\/sns_studio_bmode_e2e(?:_[0-9]+)?$/.test(url.pathname)) throw Error('Unrecognized isolated B-mode DB');
    if (await p.organization.count()) throw Error('Disposable B-mode DB must start empty');
    sha = createHash('sha256').update(readFileSync(fixture)).digest('hex');
    process.env.UPLOAD_DIRECTORY = '/bmode-uploads';
  });
  beforeEach(async () => {
    org = randomUUID(); other = randomUUID();
    await p.organization.createMany({ data: [{ id: org, name: 'B-mode fixture' }, { id: other, name: 'Other fixture' }] });
    manifests = new Map();
    drive = {
      realGenerationEnabled: () => true,
      selectedFolder: async () => ({ id: 'fixture-root' }),
      updateGenerationControl: jest.fn(async () => undefined),
      listGenerationResults: async () => [...manifests.keys()].map(id => ({ id })),
      readJson: async (_org: string, id: string) => manifests.get(id),
      fileMetadata: async (_org: string, id: string) => {
        const job = await p.snsGenerationJob.findFirstOrThrow({ where: { organizationId: org } });
        const meta = (job.inputManifest as any)._generation;
        return { id, mimeType: 'video/mp4', size: String(statSync(fixture).size), parents: [meta.jobFolderId] };
      },
      download: jest.fn(async (_org: string, _id: string, path: string) => { mkdirSync(dirname(path), { recursive: true }); copyFileSync(fixture, path); }),
    };
    provider = { submit: jest.fn(async (job: any, image: any) => {
      const { outputFolderId, ...input } = job.input;
      if (image) input.referenceImage = { fileId: `image-${job.id}`, sizeBytes: image.data.length, mimeType: image.mimeType, sha256: image.sha256 };
      const execution = { attempt: job.attempt, inputHash: generationInputHash(input), resultFileId: `result-${job.id}-${job.attempt}`, outputFileId: `output-${job.id}-${job.attempt}`, controlFileId: `control-${job.id}-${job.attempt}`, jobFolderId: `folder-${job.id}-${job.attempt}` };
      return { queuePath: execution.jobFolderId, input, execution };
    }) };
    validate = jest.fn(async (path: string) => {
      const response = await fetch(`${process.env.BMODE_WORKER_URL || 'http://bmode-worker:8001'}/generation/validate-video`, { method: 'POST', headers: { authorization: 'Bearer isolated-fixture-token', 'content-type': 'application/json' }, body: JSON.stringify({ path: path.replace('/uploads/', '/bmode-uploads/') }), signal: AbortSignal.timeout(120000) });
      if (!response.ok) throw Error('Real isolated Worker validation failed');
      return response.json();
    });
    service = new GenerationJobs(p as any, drive, provider, validate);
  });
  afterAll(async () => { await p.$disconnect(); });
  const resultFor = (job: any, failed = false) => {
    const input = job.inputManifest, meta = input._generation;
    return { schemaVersion: 2, jobId: job.id, organizationId: org, attempt: meta.attempt, inputHash: meta.inputHash, mock: false, status: failed ? 'FAILED' : 'COMPLETE', errorCode: failed ? 'MODEL_ADAPTER_FAILED' : undefined,
      execution: { mock: false, realInference: true, mode: input.mode, repoId: input.adopted.repoId, revision: input.adopted.revision, pipeline: input.adopted.pipeline, seed: input.seed, adopted: input.adopted },
      outputs: [{ fileId: meta.outputFileId, mimeType: 'video/mp4', sha256: sha, sizeBytes: statSync(fixture).size, durationSeconds: 3.063, width: 480, height: 848, fps: 16, numFrames: 49, fullDecode: true }] };
  };
  const register = (job: any, failed = false) => manifests.set(job.inputManifest._generation.resultFileId, resultFor(job, failed));
  const count = async () => ({ assets: await p.snsMediaAsset.count({ where: { organizationId: org } }), inbox: await p.snsContentInboxItem.count({ where: { organizationId: org } }), queue: await p.snsPipelineRun.count({ where: { organizationId: org } }) });

  it('rejects mock/unknown inputs and cross-org Job/asset use before uploads', async () => {
    await expect(service.create(org, { prompt: 'mug', mock: 'false' })).rejects.toMatchObject({ status: 400 });
    const job = await service.create(org, { prompt: 'mug', seed: 0 });
    await expect(service.cancel(other, job.id)).rejects.toMatchObject({ status: 404 });
    await expect(service.retry(other, job.id)).rejects.toMatchObject({ status: 404 });
    const asset = await p.snsMediaAsset.create({ data: { organizationId: other, source: 'FIXTURE', fileName: 'private.png', storageKey: '/uploads/private.png', mimeType: 'image/png' } });
    await expect(service.create(org, { prompt: 'mug', mode: 'image-to-video', referenceImageAssetId: asset.id })).rejects.toMatchObject({ status: 404 });
    expect(provider.submit).toHaveBeenCalledTimes(1);
  });
  it('passes decoded owned image bytes/hash to the Drive adapter without mutating the input', async () => {
    const bytes = await sharp({ create: { width: 64, height: 64, channels: 3, background: 'blue' } }).png().toBuffer();
    mkdirSync('/bmode-uploads/images', { recursive: true });
    const path = join('/bmode-uploads/images', `${randomUUID()}.png`); writeFileSync(path, bytes);
    const asset = await p.snsMediaAsset.create({ data: { organizationId: org, source: 'FIXTURE', fileName: 'own.png', storageKey: path.replace('/bmode-uploads/', '/uploads/'), mimeType: 'image/png' } });
    const job: any = await service.create(org, { prompt: 'mug', mode: 'image-to-video', referenceImageAssetId: asset.id, seed: 0 });
    expect(provider.submit.mock.calls[0][1].data.equals(bytes)).toBe(true);
    expect(job.inputManifest.referenceImage.sha256).toBe(createHash('sha256').update(bytes).digest('hex'));
    expect(readFileSync(path).equals(bytes)).toBe(true);
  });
  it('imports only once across simultaneous and repeated result synchronization', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job);
    await Promise.all([service.sync(org), service.sync(org)]);
    expect(await count()).toEqual({ assets: 1, inbox: 1, queue: 1 });
    expect((await service.sync(org)).skipped).toBe(1);
    const asset = await p.snsMediaAsset.findFirstOrThrow({ where: { organizationId: org } });
    expect(Number(asset.sizeBytes)).toBe(statSync(fixture).size);
    expect((asset.metadata as any).sha256).toBe(sha);
    expect((await service.list(org))[0].resultManifest.outputs[0].approvalStatus).toBe('READY_FOR_REVIEW');
  });
  it('rolls back a DB import failure and converges on the next sync', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job);
    const original = p.$transaction.bind(p);
    const broken: any = new Proxy(p, { get(target, key) { if (key === '$transaction') return async (run: any, options: any) => original(async (tx: any) => { await run(tx); throw Error('Injected commit failure'); }, options); return (target as any)[key]; } });
    const failing = new GenerationJobs(broken, drive, provider, validate);
    expect((await failing.sync(org)).failed).toBe(1);
    expect(await count()).toEqual({ assets: 0, inbox: 0, queue: 0 });
    expect((await service.sync(org)).completed).toBe(1);
    expect(await count()).toEqual({ assets: 1, inbox: 1, queue: 1 });
  });
  it('keeps upload/download failure retryable without partial DB registration', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job);
    drive.download.mockRejectedValueOnce(Error('Injected transport failure'));
    expect((await service.sync(org)).failed).toBe(1);
    expect(await count()).toEqual({ assets: 0, inbox: 0, queue: 0 });
    expect((await service.sync(org)).completed).toBe(1);
  });
  it('rejects cancelled/old-attempt results and allows only one concurrent retry', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job);
    await service.cancel(org, job.id);
    expect((await service.sync(org)).skipped).toBe(1);
    const retried = await Promise.allSettled([service.retry(org, job.id), service.retry(org, job.id)]);
    expect(retried.filter(item => item.status === 'fulfilled')).toHaveLength(1);
    expect(provider.submit).toHaveBeenCalledTimes(2);
    expect((await service.sync(org)).skipped).toBe(1);
    const current: any = await p.snsGenerationJob.findUniqueOrThrow({ where: { id: job.id } });
    expect(current.inputManifest._generation.attempt).toBe(2);
    register(current);
    expect((await service.sync(org)).completed).toBe(1);
    expect(await count()).toEqual({ assets: 1, inbox: 1, queue: 1 });
  });
  it('rejects cancellation arriving while output validation is running', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job);
    let release!: () => void, entered!: () => void;
    const started = new Promise<void>(done => { entered = done; });
    const barrier = new Promise<void>(done => { release = done; });
    const original = validate.getMockImplementation()!;
    validate.mockImplementationOnce(async (...args: any[]) => { entered(); await barrier; return original(...args); });
    const syncing = service.sync(org);
    await started; await service.cancel(org, job.id); release(); await syncing;
    expect((await p.snsGenerationJob.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('CANCELLED');
    expect(await count()).toEqual({ assets: 0, inbox: 0, queue: 0 });
  });
  it('stores failed result status without allowing it to permanently skip a new attempt', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job, true);
    expect((await service.sync(org)).failed).toBe(1);
    const retry: any = await service.retry(org, job.id);
    expect(retry.inputManifest._generation.attempt).toBe(2);
    register(retry); expect((await service.sync(org)).completed).toBe(1);
    expect(await p.post.count()).toBe(0); expect(await p.snsDelivery.count()).toBe(0);
  });

  it('reports measured OOM without persisting untrusted error strings', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job, true);
    const result = manifests.get(job.inputManifest._generation.resultFileId); result.errorCode = 'MODEL_OUT_OF_MEMORY';
    await service.sync(org);
    expect((await p.snsGenerationJob.findUniqueOrThrow({ where: { id: job.id } })).errorCode).toBe('MODEL_OUT_OF_MEMORY');
  });

  it('preserves a failed manifest upload as a retryable failed attempt', async () => {
    provider.submit.mockRejectedValueOnce(Error('Injected queue upload failure'));
    await expect(service.create(org, { prompt: 'mug' })).rejects.toMatchObject({ status: 503 });
    const job = await p.snsGenerationJob.findFirstOrThrow({ where: { organizationId: org } });
    expect(job.status).toBe('FAILED');
    expect((await service.retry(org, job.id)).status).toBe('QUEUED');
    expect(await count()).toEqual({ assets: 0, inbox: 0, queue: 0 });
  });

  it('persists actual Queue approval across reload and gates the existing Postiz bridge', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job); await service.sync(org);
    const asset = await p.snsMediaAsset.findFirstOrThrow({ where: { organizationId: org } });
    const mediaService = { getMediaStatus: async (owner: string, id: string) => p.media.findFirstOrThrow({ where: { id, organizationId: owner } }), saveFile: async (owner: string, name: string, path: string) => p.media.create({ data: { organizationId: owner, name, path, type: 'video' } }) };
    process.env.FRONTEND_URL = 'http://localhost:4027';
    const controller = () => new SnsStudioController(p as any, drive, provider, mediaService as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    await expect(controller().createPostMedia({ id: org } as any, asset.id)).rejects.toMatchObject({ status: 409 });
    const inbox = await controller().listInbox({ id: org } as any);
    expect(inbox[0].mediaAsset?.source).toBe('AI_GENERATION');
    expect((inbox[0].mediaAsset?.metadata as any).prompt).toBe('mug');
    const runId = (asset.metadata as any).pipelineRunId;
    await expect(controller().approvePipeline({ id: other } as any, runId)).rejects.toMatchObject({ status: 404 });
    await controller().approvePipeline({ id: org } as any, runId);
    const reloaded = await controller().generationJobs({ id: org } as any);
    expect(reloaded[0].resultManifest.outputs[0].approvalStatus).toBe('APPROVED');
    expect((await p.snsPipelineRun.findUniqueOrThrow({ where: { id: runId } })).approvedAt).not.toBeNull();
    const bridged = await controller().createPostMedia({ id: org } as any, asset.id);
    const again = await controller().createPostMedia({ id: org } as any, asset.id);
    expect(again.media.id).toBe(bridged.media.id);
    expect(again.reused).toBe(true);
    expect(bridged.media.id).not.toBe(job.id); expect(bridged.media.id).not.toBe(asset.id);
    expect(bridged.media.path).toContain(asset.storageKey);
    expect(await p.media.count({ where: { organizationId: org } })).toBe(1);
    expect(await p.post.count()).toBe(0); expect(await p.snsDelivery.count()).toBe(0);
  });

  it('serves real HTTP preview 200/206 with consistent headers and cross-org404', async () => {
    const job: any = await service.create(org, { prompt: 'mug' }); register(job); await service.sync(org);
    const asset = await p.snsMediaAsset.findFirstOrThrow({ where: { organizationId: org } });
    const controller = new SnsStudioController(p as any, drive, provider, {} as any, {} as any, {} as any, {} as any, {} as any, {} as any);
    const app = express(); let server: Server | undefined;
    app.get('/preview', async (req, res) => { try { await controller.mediaPreview({ id: req.query.other === '1' ? other : org } as any, asset.storageKey, req, res); } catch (caught: any) { res.status(caught.getStatus?.() || 500).end(); } });
    try {
      server = createServer(app); await new Promise<void>(done => server!.listen(0, '127.0.0.1', done));
      const port = (server.address() as any).port; const url = `http://127.0.0.1:${port}/preview`;
      const response = await fetch(url);
      expect(response.status).toBe(200); expect(response.headers.get('content-type')).toBe('video/mp4'); expect(response.headers.get('accept-ranges')).toBe('bytes');
      expect((await response.arrayBuffer()).byteLength).toBe(Number(asset.sizeBytes));
      const range = await fetch(url, { headers: { range: 'bytes=0-1023' } });
      expect(range.status).toBe(206); expect(range.headers.get('content-range')).toBe(`bytes 0-1023/${asset.sizeBytes}`); expect(range.headers.get('content-length')).toBe('1024');
      expect((await range.arrayBuffer()).byteLength).toBe(1024);
      expect((await fetch(`${url}?other=1`)).status).toBe(404);
    } finally { await new Promise<void>(done => server ? server.close(() => done()) : done()); }
  });
});
