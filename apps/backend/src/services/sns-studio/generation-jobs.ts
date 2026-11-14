import { HttpException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'fs';
import { resolve, sep } from 'path';
import sharp from 'sharp';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { generationLimits, generationModels, validateGenerationInput } from '@gitroom/helpers/video-generation/contract';
import { GoogleDriveGenerationProvider } from './google-drive.generation-provider';
import { GoogleDriveStorageProvider } from './google-drive.storage';
import { generationInputHash } from './generation-manifest';

const error = (code: string, status = 409): never => { throw new HttpException({ code }, status); };
const object = (value: unknown): Record<string, any> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {};

// Video Tools orchestration only. Post/SnsDelivery remain execution/display truth.
export class GenerationJobs {
  constructor(private readonly prisma: PrismaService, private readonly drive: GoogleDriveStorageProvider, private readonly provider: GoogleDriveGenerationProvider, private readonly validateVideo: (path: string) => Promise<any>) {}

  private normalize(input: unknown) {
    try { return validateGenerationInput(input); } catch { return error('GENERATION_INPUT_INVALID', 400); }
  }

  private async owned(org: string, id: string) {
    return await this.prisma.snsGenerationJob.findFirst({ where: { id, organizationId: org } }) || error('JOB_NOT_FOUND', 404);
  }

  private async image(org: string, input: Record<string, any>) {
    if (input.mode !== 'image-to-video') return undefined;
    const asset = await this.prisma.snsMediaAsset.findFirst({ where: { id: input.referenceImageAssetId, organizationId: org } });
    if (!asset) return error('MEDIA_ASSET_NOT_FOUND', 404);
    const root = realpathSync(resolve(process.env.UPLOAD_DIRECTORY || './uploads'));
    if (!asset.storageKey.startsWith('/uploads/')) return error('MEDIA_ASSET_NOT_FOUND', 404);
    let path: string;
    try { path = realpathSync(resolve(root, asset.storageKey.slice('/uploads/'.length))); } catch { return error('MEDIA_ASSET_NOT_FOUND', 404); }
    if (!path.startsWith(`${root}${sep}`) || !statSync(path).isFile()) return error('MEDIA_ASSET_NOT_FOUND', 404);
    const size = statSync(path).size;
    if (!size || size > generationLimits.imageBytes) return error('GENERATION_IMAGE_INVALID', 400);
    const data = readFileSync(path);
    try {
      const decoder = sharp(data, { limitInputPixels: generationLimits.imagePixels, failOn: 'warning', animated: false });
      const info = await decoder.metadata();
      const mime = ({ png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as Record<string, string>)[info.format || ''];
      if (!mime || mime !== asset.mimeType || (info.pages || 1) !== 1) return error('GENERATION_IMAGE_INVALID', 400);
      await decoder.raw().toBuffer();
      return { data, mimeType: mime, sha256: createHash('sha256').update(data).digest('hex') };
    } catch { return error('GENERATION_IMAGE_INVALID', 400); }
  }

  async list(org: string) {
    const jobs = await this.prisma.snsGenerationJob.findMany({ where: { organizationId: org }, orderBy: { createdAt: 'desc' }, take: 100 });
    const ids = jobs.flatMap(job => (object(job.resultManifest).outputs || []).map((output: any) => output.pipelineRunId).filter((id: unknown) => typeof id === 'string'));
    const runs = ids.length ? await this.prisma.snsPipelineRun.findMany({ where: { organizationId: org, id: { in: ids } } }) : [];
    return jobs.map(job => ({ ...job, resultManifest: job.resultManifest ? { ...object(job.resultManifest), outputs: (object(job.resultManifest).outputs || []).map((output: any) => ({ ...output, approvalStatus: runs.find(run => run.id === output.pipelineRunId)?.status || 'READY_FOR_REVIEW' })) } : null }));
  }

  async create(org: string, raw: unknown) {
    const input = this.normalize(raw);
    const image = await this.image(org, input);
    if (!this.drive.realGenerationEnabled()) return error('REAL_GENERATION_REQUIRES_REAL_DRIVE', 400);
    const folder = await this.drive.selectedFolder(org);
    if (!folder?.id) return error('GOOGLE_DRIVE_FOLDER_REQUIRED', 400);
    const job = await this.prisma.snsGenerationJob.create({ data: { organizationId: org, status: 'SUBMITTING', inputManifest: { ...input, _generation: { attempt: 1 } } } });
    return this.submit(org, job, input, 1, folder.id, image);
  }

  private async submit(org: string, job: any, input: Record<string, any>, attempt: number, folder: string, image?: { data: Buffer; mimeType: string; sha256: string }) {
    try {
      const queued = await this.provider.submit({ jobId: job.id, organizationId: org, createdAt: job.createdAt.toISOString(), input: { ...input, outputFolderId: folder }, attempt, resultFilePrefix: `sns-studio-result-${job.id}-a${attempt}` }, image);
      const updated = await this.prisma.snsGenerationJob.updateMany({ where: { id: job.id, organizationId: org, status: 'SUBMITTING', updatedAt: job.updatedAt }, data: { status: 'QUEUED', inputManifest: { ...queued.input, _generation: queued.execution } as any, queuePath: queued.queuePath, submittedAt: new Date() } });
      if (!updated.count) {
        if (typeof queued.execution?.controlFileId === 'string') await this.drive.updateGenerationControl(org, queued.execution.controlFileId, { jobId: job.id, attempt, cancelRequested: true });
        return this.owned(org, job.id);
      }
      return this.owned(org, job.id);
    } catch {
      await this.prisma.snsGenerationJob.updateMany({ where: { id: job.id, organizationId: org, status: 'SUBMITTING', updatedAt: job.updatedAt }, data: { status: 'FAILED', errorCode: 'GENERATION_QUEUE_UPLOAD_FAILED', errorMessage: 'Generation queue upload failed.' } });
      return error('GENERATION_QUEUE_UPLOAD_FAILED', 503);
    }
  }

  async retry(org: string, id: string) {
    const job = await this.owned(org, id);
    if (!['FAILED', 'CANCELLED'].includes(job.status)) return error('GENERATION_RETRY_NOT_AVAILABLE');
    const previous = object(job.inputManifest);
    const { _generation, adopted, referenceImage, ...raw } = previous;
    const input = this.normalize(raw);
    const image = await this.image(org, input);
    if (!this.drive.realGenerationEnabled()) return error('REAL_GENERATION_REQUIRES_REAL_DRIVE', 400);
    const folder = await this.drive.selectedFolder(org);
    if (!folder?.id) return error('GOOGLE_DRIVE_FOLDER_REQUIRED', 400);
    const attempt = Number(object(_generation).attempt || 0) + 1;
    const claim = await this.prisma.snsGenerationJob.updateMany({ where: { id, organizationId: org, status: job.status, updatedAt: job.updatedAt }, data: { status: 'SUBMITTING', inputManifest: { ...input, _generation: { attempt } }, resultManifest: Prisma.DbNull, errorCode: null, errorMessage: null, completedAt: null } });
    if (!claim.count) return error('GENERATION_CONCURRENT_UPDATE');
    return this.submit(org, await this.owned(org, id), input, attempt, folder.id, image);
  }

  async cancel(org: string, id: string) {
    const job = await this.owned(org, id);
    if (['COMPLETE', 'CANCELLED'].includes(job.status)) return job;
    const result = await this.prisma.snsGenerationJob.updateMany({ where: { id, organizationId: org, status: job.status, updatedAt: job.updatedAt }, data: { status: 'CANCELLED', completedAt: new Date() } });
    if (!result.count) return error('GENERATION_CONCURRENT_UPDATE');
    const meta = object(object(job.inputManifest)._generation);
    let cancellationDelivered = false;
    if (typeof meta.controlFileId === 'string') {
      try { await this.drive.updateGenerationControl(org, meta.controlFileId, { jobId: id, attempt: meta.attempt, cancelRequested: true }); cancellationDelivered = true; } catch { /* DB cancellation still rejects every late result. */ }
    }
    return { ...await this.owned(org, id), cancellationDelivered, immediateGpuStop: false };
  }

  private matches(job: any, manifest: any, resultFileId: string) {
    const input = object(job.inputManifest);
    const meta = object(input._generation);
    const { _generation, ...content } = input;
    return manifest.schemaVersion === 2 && manifest.organizationId === job.organizationId && manifest.attempt === meta.attempt && manifest.inputHash === meta.inputHash && meta.inputHash === generationInputHash(content) && meta.resultFileId === resultFileId && manifest.mock === false;
  }

  async sync(org: string) {
    const files = await this.drive.listGenerationResults(org);
    const report = { completed: 0, imported: 0, skipped: 0, failed: 0 };
    for (const file of files) {
      if (!file.id) continue;
      let claim: any;
      try {
        const manifest = await this.drive.readJson(org, file.id);
        const job = typeof manifest.jobId === 'string' ? await this.prisma.snsGenerationJob.findFirst({ where: { id: manifest.jobId, organizationId: org } }) : null;
        if (!job || !['QUEUED', 'RUNNING'].includes(job.status) || !this.matches(job, manifest, file.id)) { report.skipped++; continue; }
        if (manifest.status === 'FAILED') {
          const safeCode = ['GENERATION_TIMEOUT', 'MODEL_OUT_OF_MEMORY', 'BLOCKED_BY_GPU', 'BLOCKED_BY_RAM_OR_DISK', 'PROMPT_EXCEEDS_MODEL_TOKEN_LIMIT', 'MODEL_OUTPUT_CONTRACT_MISMATCH', 'UNVERIFIED_DEPENDENCY_VERSION', 'REFERENCE_IMAGE_HASH_MISMATCH'].includes(manifest.errorCode) ? manifest.errorCode : 'MODEL_ADAPTER_FAILED';
          const changed = await this.prisma.snsGenerationJob.updateMany({ where: { id: job.id, organizationId: org, status: job.status, updatedAt: job.updatedAt }, data: { status: 'FAILED', resultManifest: { resultFileId: file.id, attempt: manifest.attempt, inputHash: manifest.inputHash }, errorCode: safeCode, errorMessage: safeCode, completedAt: new Date() } });
          if (changed.count) report.failed++; else report.skipped++;
          continue;
        }
        const input = object(job.inputManifest);
        const meta = object(input._generation);
        const model = generationModels[input.modelName];
        const execution = object(manifest.execution);
        const outputs = manifest.outputs;
        if (manifest.status !== 'COMPLETE' || !model || execution.mock !== false || execution.realInference !== true || execution.mode !== input.mode || execution.repoId !== model.repo_id || execution.revision !== model.revision || execution.pipeline !== model.pipeline_class || execution.seed !== input.seed || generationInputHash(execution.adopted) !== generationInputHash(input.adopted) || !Array.isArray(outputs) || outputs.length !== 1 || (input.mode === 'image-to-video' && (execution.inputImageUsed !== true || execution.referenceImageSha256 !== input.referenceImage?.sha256))) return error('GENERATION_RESULT_CONTRACT_INVALID', 400);
        const output = object(outputs[0]);
        if (output.fileId !== meta.outputFileId || output.mimeType !== 'video/mp4' || !/^[a-f0-9]{64}$/.test(output.sha256) || !Number.isSafeInteger(output.sizeBytes) || output.sizeBytes < 1000 || output.sizeBytes > generationLimits.outputBytes || output.fullDecode !== true || typeof output.durationSeconds !== 'number' || !Number.isFinite(output.durationSeconds) || output.durationSeconds <= 0 || output.durationSeconds > 6 || output.width !== input.adopted.width || output.height !== input.adopted.height || output.fps !== input.adopted.fps || output.numFrames !== input.adopted.numFrames) return error('GENERATION_OUTPUT_INVALID', 400);
        const claimed = await this.prisma.snsGenerationJob.updateMany({ where: { id: job.id, organizationId: org, status: job.status, updatedAt: job.updatedAt }, data: { status: 'SYNCING' } });
        if (!claimed.count) { report.skipped++; continue; }
        claim = await this.owned(org, job.id);
        const fileMeta = await this.drive.fileMetadata(org, output.fileId);
        if (fileMeta.mimeType !== 'video/mp4' || Number(fileMeta.size) !== output.sizeBytes || fileMeta.trashed || !fileMeta.parents?.includes(meta.jobFolderId)) return error('GENERATION_OUTPUT_FILE_INVALID', 400);
        const storageKey = `/uploads/sns-studio/generated/${job.id}/a${meta.attempt}-${output.sha256}.mp4`;
        const root = resolve(process.env.UPLOAD_DIRECTORY || './uploads');
        const diskPath = resolve(root, storageKey.slice('/uploads/'.length));
        if (!existsSync(diskPath)) await this.drive.download(org, output.fileId, diskPath, generationLimits.outputBytes);
        if (statSync(diskPath).size !== output.sizeBytes || createHash('sha256').update(readFileSync(diskPath)).digest('hex') !== output.sha256) return error('GENERATION_OUTPUT_HASH_MISMATCH', 400);
        const validated = await this.validateVideo(storageKey);
        const [fpsNumerator, fpsDenominator] = String(validated.video?.frameRate || '').split('/').map(Number);
        if (validated.fullDecode !== true || validated.sha256 !== output.sha256 || validated.sizeBytes !== output.sizeBytes || validated.video.width !== input.adopted.width || validated.video.height !== input.adopted.height || validated.numFrames !== input.adopted.numFrames || !Number.isFinite(fpsNumerator / fpsDenominator) || Math.abs(fpsNumerator / fpsDenominator - input.adopted.fps) > 0.01 || Math.abs(validated.durationSeconds - output.durationSeconds) > 0.1) return error('GENERATION_OUTPUT_DECODE_INVALID', 400);
        await this.prisma.$transaction(async tx => {
          const locked = await tx.snsGenerationJob.updateMany({ where: { id: job.id, organizationId: org, status: 'SYNCING', updatedAt: claim.updatedAt }, data: { status: 'COMPLETE' } });
          if (!locked.count) return error('GENERATION_CANCELLED_OR_CHANGED');
          const provenance = { generationJobId: job.id, attempt: meta.attempt, inputHash: meta.inputHash, driveFileId: output.fileId, sha256: output.sha256, prompt: input.prompt, execution };
          const asset = await tx.snsMediaAsset.create({ data: { organizationId: org, source: 'AI_GENERATION', storageKey, fileName: `${job.id}-a${meta.attempt}.mp4`, mimeType: 'video/mp4', sizeBytes: BigInt(statSync(diskPath).size), width: validated.video.width, height: validated.video.height, duration: validated.durationSeconds, metadata: provenance as any } });
          const run = await tx.snsPipelineRun.create({ data: { organizationId: org, status: 'READY_FOR_REVIEW', currentStep: 'REVIEW', input: { generationJobId: job.id, mediaAssetId: asset.id }, output: { mediaPath: storageKey, mediaType: 'video', mediaAssetId: asset.id, generationJobId: job.id, content: input.prompt }, steps: { create: [{ name: 'GENERATE', status: 'COMPLETED' }, { name: 'EDIT', status: 'COMPLETED' }, { name: 'REVIEW', status: 'PENDING' }, { name: 'PUBLISH', status: 'PENDING' }] } } });
          await tx.snsMediaAsset.update({ where: { id: asset.id }, data: { metadata: { ...provenance, pipelineRunId: run.id } as any } });
          const inbox = await tx.snsContentInboxItem.create({ data: { organizationId: org, fileName: asset.fileName, mediaType: 'video', sizeBytes: asset.sizeBytes, status: 'READY_FOR_REVIEW', previewUrl: `/sns-studio/media/preview?path=${encodeURIComponent(storageKey)}`, mediaAssetId: asset.id, metadata: { generationJobId: job.id, pipelineRunId: run.id } } });
          await tx.snsGenerationJob.update({ where: { id: job.id }, data: { resultManifest: { ...manifest, resultFileId: file.id, outputs: [{ ...output, mediaAssetId: asset.id, inboxItemId: inbox.id, pipelineRunId: run.id, storageKey }] } as any, errorCode: null, errorMessage: null, completedAt: new Date() } });
        }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
        report.completed++; report.imported++;
      } catch {
        if (claim) await this.prisma.snsGenerationJob.updateMany({ where: { id: claim.id, organizationId: org, status: 'SYNCING', updatedAt: claim.updatedAt }, data: { status: 'QUEUED' } });
        report.failed++;
      }
    }
    return report;
  }
}
