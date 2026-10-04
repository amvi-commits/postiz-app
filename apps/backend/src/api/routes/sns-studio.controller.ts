import {
  Body,
  Controller,
  Delete,
  Inject,
  Get,
  HttpException,
  HttpStatus,
  Param,
  Post,
  Put,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import type { Request as ExpressRequest, Response as ExpressResponse } from 'express';
import { Organization } from '@prisma/client';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { randomUUID } from 'crypto';
import { extname, resolve, sep } from 'path';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { ApiTags } from '@nestjs/swagger';
import { chooseShuffleBagItem } from '@gitroom/helpers/utils/shuffle-bag';
import { GoogleDriveStorageProvider } from '@gitroom/backend/services/sns-studio/google-drive.storage';
import { GoogleDriveGenerationProvider } from '@gitroom/backend/services/sns-studio/google-drive.generation-provider';
import { SNS_STUDIO_CAPTION_PROVIDER } from '@gitroom/backend/services/sns-studio/caption-provider.interface';
import type { CaptionProvider } from '@gitroom/backend/services/sns-studio/caption-provider.interface';
import { normalizeInstagramMetrics } from '@gitroom/backend/services/sns-studio/instagram-metrics';

class InstagramLoginDto {
  @IsString() @MinLength(1) @MaxLength(100) username!: string;
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
  @IsOptional() @IsString() @MaxLength(2048) proxy?: string;
  @IsOptional() @IsString() @MaxLength(32) verificationCode?: string;
}

class InstagramLoginCodeDto {
  @IsString() @MinLength(1) @MaxLength(32) verificationCode!: string;
}

class StoryPoolDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsOptional() @IsString() @MaxLength(500) description?: string;
}

class StoryPoolItemDto {
  @IsString() @MinLength(1) @MaxLength(2048) mediaPath!: string;
  @IsString() mediaType!: 'image' | 'video';
  @IsOptional() @IsString() urlLibraryId?: string;
  @IsOptional() @IsUrl({ require_protocol: true }) urlSnapshot?: string;
}

class UrlLibraryDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsUrl({ require_protocol: true }) @MaxLength(2048) url!: string;
  @IsOptional() @IsString() @MaxLength(500) note?: string;
  @IsOptional() @IsBoolean() active?: boolean;
}

class StickerDto {
  @IsNumber() @Min(0) @Max(1) x!: number;
  @IsNumber() @Min(0) @Max(1) y!: number;
  @IsNumber() @Min(0.01) @Max(1) width!: number;
  @IsNumber() @Min(0.01) @Max(1) height!: number;
  @IsNumber() @Min(-360) @Max(360) rotation!: number;
}

class PublishReelDto {
  @IsString() accountId!: string;
  @IsString() videoPath!: string;
  @IsOptional() @IsString() @MaxLength(2200) caption?: string;
  @IsOptional() @IsString() thumbnailPath?: string;
  @IsOptional() @IsBoolean() trialReel?: boolean;
  @IsOptional() @IsString() pipelineRunId?: string;
  @IsOptional() @IsString() recipeName?: string;
  @IsOptional() @IsString() presetName?: string;
  @IsOptional() variantSettings?: Record<string, unknown>;
  @IsOptional() @IsNumber() duration?: number;
}

class PublishStoryDto {
  @IsString() accountId!: string;
  @IsString() mediaPath!: string;
  @IsString() mediaType!: 'image' | 'video';
  @IsUrl({ require_protocol: true }) linkUrl!: string;
  @ValidateNested() @Type(() => StickerDto) sticker!: StickerDto;
  @IsOptional() @IsString() pipelineRunId?: string;
  @IsOptional() @IsString() recipeName?: string;
}

class RecipeDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  @IsString() inputType!: string;
  config!: Record<string, unknown>;
}

class PipelineDto {
  @IsOptional() @IsString() recipeId?: string;
  @IsOptional() input?: Record<string, unknown>;
}

class DriveFolderDto {
  @IsString() @MinLength(1) @MaxLength(256) folderId!: string;
}

class MediaProbeDto {
  @IsString() @MinLength(1) @MaxLength(2048) path!: string;
}

class PreflightDto {
  @IsString() @MinLength(1) accountId!: string;
  @IsString() @MinLength(1) @MaxLength(2048) mediaPath!: string;
  @IsOptional() @IsIn(['image', 'video']) mediaType?: 'image' | 'video';
  @IsOptional() @IsUrl({ require_protocol: true }) @MaxLength(2048) linkUrl?: string;
  @IsOptional() @ValidateNested() @Type(() => StickerDto) sticker?: StickerDto;
  @IsOptional() @IsBoolean() trialReel?: boolean;
  @IsOptional() @IsString() @MaxLength(2048) thumbnailPath?: string;
  @IsOptional() @IsString() @MaxLength(2200) caption?: string;
}

class RenderDto {
  @IsString() @MinLength(1) @MaxLength(2048) sourcePath!: string;
  @IsOptional() @IsString() @MaxLength(100) outputName?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(3600) trimStartSeconds?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(3600) trimEndSeconds?: number;
  @IsOptional() @IsNumber() @Min(0.5) @Max(2) playbackSpeed?: number;
  @IsOptional() @IsNumber() @Min(95) @Max(100) cropPercent?: number;
  @IsOptional() @IsNumber() @Min(320) @Max(2160) width?: number;
  @IsOptional() @IsNumber() @Min(320) @Max(3840) height?: number;
  @IsOptional() @IsNumber() @Min(15) @Max(60) fps?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(2) sourceAudioVolume?: number;
  @IsOptional() @IsString() @MaxLength(2048) bgmPath?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) bgmVolume?: number;
  @IsOptional() @IsString() @MaxLength(2048) subtitlesPath?: string;
  @IsOptional() @IsNumber() @Min(18) @Max(120) subtitleFontSize?: number;
  @IsOptional() @IsString() @MaxLength(300) textOverlay?: string;
  @IsOptional() @IsNumber() @Min(0) @Max(1) textX?: number;
  @IsOptional() @IsNumber() @Min(0) @Max(1) textY?: number;
  @IsOptional() @IsNumber() @Min(18) @Max(160) textFontSize?: number;
}

class EditingPresetDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  config!: Record<string, unknown>;
}

class VoicePresetDto {
  @IsString() @MinLength(1) @MaxLength(100) name!: string;
  slots!: Record<string, unknown>;
  @IsOptional() ttsSettings?: Record<string, unknown>;
}

class CaptionSettingsDto {
  @IsBoolean() enabled!: boolean;
  @IsOptional() profile?: Record<string, unknown>;
}

class CaptionGenerateDto {
  @IsString() @MinLength(1) @MaxLength(12000) sourceText!: string;
  @IsString() accountId!: string;
}

@ApiTags('SNS Studio')
@Controller('/sns-studio')
export class SnsStudioController {
  private readonly cleanupAt = new Map<string, number>();
  private readonly activePipelines = new Set<string>();
  constructor(
    private readonly prisma: PrismaService,
    private readonly googleDrive: GoogleDriveStorageProvider,
    private readonly generationProvider: GoogleDriveGenerationProvider,
    @Inject(SNS_STUDIO_CAPTION_PROVIDER) private readonly captionProvider: CaptionProvider,
  ) {}

  private async worker<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const baseUrl = process.env.INSTAGRAM_WORKER_URL;
    if (!baseUrl) {
      throw new ServiceUnavailableException({ code: 'IG_WORKER_UNAVAILABLE' });
    }
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = process.env.SNS_STUDIO_SERVICE_TOKEN || this.readServiceToken('IG_WORKER_TOKEN_FILE');
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    let response: Response;
    try {
      response = await fetch(`${baseUrl.replace(/\/$/, '')}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new ServiceUnavailableException({ code: 'IG_WORKER_UNAVAILABLE' });
    }
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const detail = (payload as any)?.detail || { code: 'IG_REQUEST_FAILED' };
      throw new HttpException(detail, response.status);
    }
    return payload as T;
  }

  private readServiceToken(name: 'IG_WORKER_TOKEN_FILE' | 'MEDIA_WORKER_TOKEN_FILE') {
    const tokenFile = process.env[name];
    if (!tokenFile) return undefined;
    try {
      return readFileSync(tokenFile, 'utf8').trim();
    } catch {
      return undefined;
    }
  }

  private mediaWorker<T = any>(path: string, method = 'GET', body?: unknown): Promise<T> {
    const mediaUrl = process.env.MEDIA_WORKER_URL;
    if (!mediaUrl) throw new ServiceUnavailableException({ code: 'MEDIA_WORKER_UNAVAILABLE' });
    const headers: Record<string, string> = {};
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const token = process.env.SNS_STUDIO_SERVICE_TOKEN || this.readServiceToken('MEDIA_WORKER_TOKEN_FILE');
    if (token) headers.Authorization = `Bearer ${token}`;
    return fetch(`${mediaUrl.replace(/\/$/, '')}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(30 * 60_000),
    }).then(async (response) => {
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        const detail = (payload as any)?.detail || { code: 'MEDIA_REQUEST_FAILED' };
        throw new HttpException(detail, response.status);
      }
      return payload as T;
    }).catch((error) => {
      if (error instanceof HttpException) throw error;
      throw new ServiceUnavailableException({ code: 'MEDIA_WORKER_UNAVAILABLE' });
    });
  }

  private async account(org: Organization, accountId: string) {
    const account = await this.prisma.snsInstagramAccount.findFirst({
      where: { id: accountId, organizationId: org.id },
    });
    if (!account) throw new HttpException('Account not found', HttpStatus.NOT_FOUND);
    return account;
  }

  private async updateInstagramLoginStatus(accountId: string, error: unknown) {
    const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
    const code = typeof detail === 'object' && detail ? ((detail as any).errorCode || (detail as any).code) : undefined;
    await this.prisma.snsInstagramAccount.update({
      where: { id: accountId },
      data: { status: ['IG_LOGIN_REQUIRED', 'IG_2FA_REQUIRED', 'IG_CHALLENGE_REQUIRED'].includes(code) ? 'NEEDS_USER_ACTION' : 'ERROR' },
    });
  }

  private async retentionDays(organizationId: string) {
    const setting = await this.prisma.snsAppSetting.findUnique({ where: { organizationId_key: { organizationId, key: 'sns:retention-days' } } });
    return typeof setting?.value === 'number' ? setting.value : 7;
  }

  private async cleanupExpiredMedia(organizationId: string) {
    const now = Date.now();
    if (now - (this.cleanupAt.get(organizationId) || 0) < 6 * 60 * 60_000) return { deleted: 0 };
    this.cleanupAt.set(organizationId, now);
    const days = await this.retentionDays(organizationId);
    if (days === 0) return { deleted: 0 };
    const cutoff = new Date(now - days * 24 * 60 * 60_000);
    const assets = await this.prisma.snsMediaAsset.findMany({ where: { organizationId, isFinal: true, publishedAt: { lte: cutoff } } });
    let deleted = 0;
    const uploadRoot = resolve(process.env.UPLOAD_DIRECTORY || './uploads');
    const renderRoot = resolve(uploadRoot, 'sns-studio', 'renders') + sep;
    for (const asset of assets) {
      if (!asset.storageKey.startsWith('/uploads/sns-studio/renders/')) continue;
      const filePath = resolve(uploadRoot, asset.storageKey.slice('/uploads/'.length));
      if (!filePath.startsWith(renderRoot)) continue;
      try { unlinkSync(filePath); deleted += 1; } catch { /* already cleaned up or absent */ }
      const priorMetadata = asset.metadata && typeof asset.metadata === 'object' && !Array.isArray(asset.metadata) ? asset.metadata as Record<string, unknown> : {};
      await this.prisma.snsMediaAsset.update({ where: { id: asset.id }, data: { metadata: { ...priorMetadata, cleanupCheckedAt: new Date().toISOString() } as any } });
    }
    return { deleted };
  }

  @Get('/health')
  health() {
    return this.worker('/health');
  }

  @Get('/drive/status')
  async driveStatus(@GetOrgFromRequest() org: Organization) {
    return { connected: await this.googleDrive.isConnected(org.id), folder: await this.googleDrive.selectedFolder(org.id) };
  }

  @Get('/drive/oauth-url')
  async driveOAuthUrl(@GetOrgFromRequest() org: Organization) {
    return { url: await this.googleDrive.authorizationUrl(org.id) };
  }

  @Get('/drive/callback')
  async driveCallback(
    @GetOrgFromRequest() org: Organization,
    @Query('code') code: string,
    @Query('state') state: string,
    @Query('error') error?: string,
  ) {
    if (error) throw new HttpException({ code: 'GOOGLE_DRIVE_OAUTH_DENIED' }, HttpStatus.BAD_REQUEST);
    if (!code || !state) throw new HttpException({ code: 'GOOGLE_DRIVE_OAUTH_RESPONSE_INVALID' }, HttpStatus.BAD_REQUEST);
    return this.googleDrive.completeAuthorization(org.id, code, state);
  }

  @Get('/drive/folders')
  async driveFolders(@GetOrgFromRequest() org: Organization) {
    return this.googleDrive.listFolders(org.id);
  }

  @Put('/drive/folder')
  async setDriveFolder(@GetOrgFromRequest() org: Organization, @Body() body: DriveFolderDto) {
    return this.googleDrive.selectFolder(org.id, body.folderId);
  }

  @Post('/drive/sync')
  async syncDrive(@GetOrgFromRequest() org: Organization) {
    const folder = await this.googleDrive.selectedFolder(org.id);
    if (!folder?.id) throw new HttpException({ code: 'GOOGLE_DRIVE_FOLDER_REQUIRED' }, HttpStatus.BAD_REQUEST);
    const files = await this.googleDrive.listMedia(org.id, folder.id);
    const uploadRoot = resolve(process.env.UPLOAD_DIRECTORY || './uploads');
    const originalRoot = resolve(uploadRoot, 'sns-studio', 'originals');
    const report = { imported: 0, skipped: 0, failed: 0 };
    for (const file of files) {
      const existing = await this.prisma.snsContentInboxItem.findFirst({ where: { organizationId: org.id, driveFileId: file.id } });
      if (existing && existing.status !== 'FAILED') {
        report.skipped += 1;
        continue;
      }
      const cleanName = file.name.replace(/[^\p{L}\p{N}._() -]/gu, '_').slice(0, 120) || 'drive-media';
      const extension = extname(cleanName).replace(/[^.A-Za-z0-9]/g, '').slice(0, 12);
      const diskPath = resolve(originalRoot, `${randomUUID()}${extension}`);
      const mediaPath = `/uploads/sns-studio/originals/${diskPath.split(/[\\/]/).pop()}`;
      try {
        await this.googleDrive.download(org.id, file.id, diskPath);
        const size = file.size && /^\d+$/.test(file.size) ? BigInt(file.size) : null;
        const mediaType = file.mimeType.startsWith('video/') ? 'video' : 'image';
        await this.prisma.$transaction(async (tx) => {
          const media = await tx.snsMediaAsset.create({
            data: { organizationId: org.id, source: 'GOOGLE_DRIVE', storageKey: mediaPath, fileName: cleanName, mimeType: file.mimeType, sizeBytes: size, isOriginal: true },
          });
          const data = {
            fileName: cleanName,
            mediaType,
            sizeBytes: size,
            sourceCreatedAt: file.createdTime ? new Date(file.createdTime) : null,
            status: 'NEW',
            previewUrl: file.webViewLink || null,
            mediaAssetId: media.id,
            errorCode: null,
            errorMessage: null,
            metadata: { driveFileId: file.id, webViewLink: file.webViewLink, modifiedTime: file.modifiedTime } as any,
          };
          if (existing) {
            await tx.snsContentInboxItem.update({ where: { id: existing.id }, data });
          } else {
            await tx.snsContentInboxItem.create({ data: { organizationId: org.id, driveFileId: file.id, ...data } });
          }
        });
        report.imported += 1;
      } catch {
        report.failed += 1;
        await this.prisma.snsContentInboxItem.upsert({
          where: { organizationId_driveFileId: { organizationId: org.id, driveFileId: file.id } },
          create: { organizationId: org.id, driveFileId: file.id, fileName: cleanName, mediaType: file.mimeType.startsWith('video/') ? 'video' : 'image', sizeBytes: file.size && /^\d+$/.test(file.size) ? BigInt(file.size) : null, sourceCreatedAt: file.createdTime ? new Date(file.createdTime) : null, status: 'FAILED', previewUrl: file.webViewLink || null, errorCode: 'GOOGLE_DRIVE_DOWNLOAD_FAILED', errorMessage: 'Download failed; sync again to retry.' },
          update: { status: 'FAILED', errorCode: 'GOOGLE_DRIVE_DOWNLOAD_FAILED', errorMessage: 'Download failed; sync again to retry.' },
        });
      }
    }
    return report;
  }

  @Get('/generation/jobs')
  generationJobs(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsGenerationJob.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'desc' }, take: 100 });
  }

  @Post('/generation/jobs')
  async createGenerationJob(@GetOrgFromRequest() org: Organization, @Body() body: { input: Record<string, unknown> }) {
    if (!body.input || typeof body.input !== 'object' || Array.isArray(body.input)) {
      throw new HttpException({ code: 'GENERATION_INPUT_INVALID' }, HttpStatus.BAD_REQUEST);
    }
    const folder = await this.googleDrive.selectedFolder(org.id);
    if (!folder?.id) throw new HttpException({ code: 'GOOGLE_DRIVE_FOLDER_REQUIRED' }, HttpStatus.BAD_REQUEST);
    const job = await this.prisma.snsGenerationJob.create({ data: { organizationId: org.id, status: 'SUBMITTING', inputManifest: body.input as any } });
    try {
      const queued = await this.generationProvider.submit({
        jobId: job.id,
        organizationId: org.id,
        createdAt: job.createdAt.toISOString(),
        input: { ...body.input, outputFolderId: folder.id },
        resultFilePrefix: `sns-studio-result-${job.id}`,
      });
      return this.prisma.snsGenerationJob.update({ where: { id: job.id }, data: { status: 'QUEUED', queuePath: queued.queuePath, submittedAt: new Date() } });
    } catch {
      await this.prisma.snsGenerationJob.update({ where: { id: job.id }, data: { status: 'FAILED', errorCode: 'GENERATION_QUEUE_UPLOAD_FAILED', errorMessage: 'Google Drive could not store the job manifest.' } });
      throw new ServiceUnavailableException({ code: 'GENERATION_QUEUE_UPLOAD_FAILED' });
    }
  }

  @Post('/generation/jobs/sync')
  async syncGenerationResults(@GetOrgFromRequest() org: Organization) {
    const resultFiles = await this.googleDrive.listGenerationResults(org.id);
    const report = { completed: 0, imported: 0, skipped: 0, failed: 0 };
    const uploadRoot = resolve(process.env.UPLOAD_DIRECTORY || './uploads');
    for (const resultFile of resultFiles) {
      if (!resultFile.id) continue;
      try {
        const manifest = await this.googleDrive.readJson(org.id, resultFile.id);
        const jobId = typeof manifest.jobId === 'string' ? manifest.jobId : '';
        const job = jobId ? await this.prisma.snsGenerationJob.findFirst({ where: { id: jobId, organizationId: org.id } }) : null;
        if (!job || job.status === 'COMPLETE') { report.skipped += 1; continue; }
        if (manifest.status === 'FAILED') {
          await this.prisma.snsGenerationJob.update({ where: { id: job.id }, data: { status: 'FAILED', errorCode: String(manifest.errorCode || 'GENERATION_FAILED'), errorMessage: String(manifest.errorMessage || 'Colab generation failed.').slice(0, 500), resultManifest: manifest as any, completedAt: new Date() } });
          report.failed += 1;
          continue;
        }
        const outputs = Array.isArray(manifest.outputs) ? manifest.outputs : [];
        if (!outputs.length) { report.skipped += 1; continue; }
        const imported = [];
        for (const output of outputs) {
          if (!output || typeof output.fileId !== 'string') continue;
          const file = await this.googleDrive.fileMetadata(org.id, output.fileId);
          if (!file.id || !file.name || !(file.mimeType?.startsWith('image/') || file.mimeType?.startsWith('video/'))) continue;
          const cleanName = file.name.replace(/[^\p{L}\p{N}._() -]/gu, '_').slice(0, 120) || 'generated-media';
          const extension = extname(cleanName).replace(/[^.A-Za-z0-9]/g, '').slice(0, 12);
          const diskPath = resolve(uploadRoot, 'sns-studio', 'generated', job.id, `${randomUUID()}${extension}`);
          const storageKey = `/uploads/sns-studio/generated/${job.id}/${diskPath.split(/[\\/]/).pop()}`;
          await this.googleDrive.download(org.id, file.id, diskPath);
          const sizeBytes = file.size && /^\d+$/.test(file.size) ? BigInt(file.size) : null;
          const media = await this.prisma.snsMediaAsset.create({ data: { organizationId: org.id, source: 'AI_GENERATION', storageKey, fileName: cleanName, mimeType: file.mimeType, sizeBytes, isOriginal: false, metadata: { generationJobId: job.id, driveFileId: file.id } as any } });
          const inboxItem = await this.prisma.snsContentInboxItem.create({ data: { organizationId: org.id, driveFileId: null, fileName: cleanName, mediaType: file.mimeType.startsWith('video/') ? 'video' : 'image', sizeBytes, sourceCreatedAt: file.createdTime ? new Date(file.createdTime) : null, status: 'READY_FOR_REVIEW', previewUrl: file.webViewLink || null, mediaAssetId: media.id, metadata: { generationJobId: job.id } as any } });
          imported.push({ mediaAssetId: media.id, inboxItemId: inboxItem.id, name: cleanName, storageKey });
        }
        if (!imported.length) { report.skipped += 1; continue; }
        await this.prisma.snsGenerationJob.update({ where: { id: job.id }, data: { status: 'COMPLETE', resultManifest: { resultFileId: resultFile.id, outputs: imported } as any, completedAt: new Date() } });
        report.completed += 1;
        report.imported += imported.length;
      } catch {
        report.failed += 1;
      }
    }
    return report;
  }

  @Post('/proxy/test')
  proxyTest(@Body() body: { proxy: string }) {
    if (!body.proxy?.trim()) throw new HttpException('Proxy is required', HttpStatus.BAD_REQUEST);
    return this.worker('/proxy/test', 'POST', { proxy: body.proxy.trim() });
  }

  @Get('/dashboard')
  async dashboard(@GetOrgFromRequest() org: Organization) {
    await this.cleanupExpiredMedia(org.id);
    const [accounts, inbox, queue, recent, cleanup] = await Promise.all([
      this.prisma.snsInstagramAccount.groupBy({ by: ['status'], where: { organizationId: org.id }, _count: { _all: true } }),
      this.prisma.snsContentInboxItem.groupBy({ by: ['status'], where: { organizationId: org.id }, _count: { _all: true } }),
      this.prisma.snsPipelineRun.findMany({ where: { organizationId: org.id, status: { not: 'PUBLISHED' } }, orderBy: { updatedAt: 'desc' }, take: 8 }),
      this.prisma.snsPublishRecord.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'desc' }, take: 8, include: { account: { select: { username: true } } } }),
      this.prisma.snsMediaAsset.count({ where: { organizationId: org.id, isFinal: true, publishedAt: { not: null } } }),
    ]);
    return { accounts, inbox, queue, recent, cleanup };
  }

  @Get('/settings')
  async snsSettings(@GetOrgFromRequest() org: Organization) {
    return { retentionDays: await this.retentionDays(org.id) };
  }

  @Put('/settings')
  async updateSnsSettings(@GetOrgFromRequest() org: Organization, @Body() body: { retentionDays: number }) {
    if (![0, 7, 30].includes(Number(body.retentionDays))) {
      throw new HttpException({ code: 'RETENTION_DAYS_INVALID' }, HttpStatus.BAD_REQUEST);
    }
    await this.prisma.snsAppSetting.upsert({
      where: { organizationId_key: { organizationId: org.id, key: 'sns:retention-days' } },
      create: { organizationId: org.id, key: 'sns:retention-days', value: Number(body.retentionDays) as any },
      update: { value: Number(body.retentionDays) as any },
    });
    return { retentionDays: Number(body.retentionDays) };
  }

  @Post('/storage/cleanup')
  async runCleanup(@GetOrgFromRequest() org: Organization) {
    this.cleanupAt.delete(org.id);
    return this.cleanupExpiredMedia(org.id);
  }

  @Get('/accounts')
  async listAccounts(@GetOrgFromRequest() org: Organization) {
    const accounts = await this.prisma.snsInstagramAccount.findMany({
      where: { organizationId: org.id, archivedAt: null },
      orderBy: { createdAt: 'asc' },
      include: { defaultStoryPool: { select: { id: true, name: true } } },
    });
    return Promise.all(accounts.map(async (account) => {
      const health = await this.worker(`/accounts/${encodeURIComponent(account.id)}/health`).catch(() => ({ status: 'YELLOW', session: 'UNAVAILABLE', proxyConfigured: null, lastError: 'IG_WORKER_UNAVAILABLE' }));
      return { ...account, health, healthStatus: health.status, proxyConfigured: health.proxyConfigured ?? null, lastError: health.lastError || null };
    }));
  }

  @Post('/accounts')
  async loginAccount(@GetOrgFromRequest() org: Organization, @Body() body: InstagramLoginDto) {
    const username = body.username.trim().replace(/^@/, '');
    const account = await this.prisma.snsInstagramAccount.upsert({
      where: { organizationId_username: { organizationId: org.id, username } },
      create: { organizationId: org.id, username, status: 'CONNECTING' },
      update: { status: 'CONNECTING', archivedAt: null },
    });
    try {
      await this.worker('/accounts/login', 'POST', {
        accountId: account.id,
        username,
        password: body.password,
        proxy: body.proxy || null,
        verificationCode: body.verificationCode || null,
      });
      return this.prisma.snsInstagramAccount.update({
        where: { id: account.id },
        data: { status: 'ACTIVE', lastValidatedAt: new Date() },
      });
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
      await this.updateInstagramLoginStatus(account.id, error);
      throw new HttpException(detail, status);
    }
  }

  @Post('/accounts/:id/login/continue')
  async continueAccountLogin(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: InstagramLoginCodeDto) {
    await this.account(org, id);
    try {
      const result = await this.worker(`/accounts/${encodeURIComponent(id)}/login/continue`, 'POST', body);
      await this.prisma.snsInstagramAccount.update({ where: { id }, data: { status: 'ACTIVE', lastValidatedAt: new Date() } });
      return result;
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
      await this.updateInstagramLoginStatus(id, error);
      throw new HttpException(detail, status);
    }
  }

  @Post('/accounts/:id/login/recheck')
  async recheckAccountLogin(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    await this.account(org, id);
    try {
      const result = await this.worker(`/accounts/${encodeURIComponent(id)}/login/recheck`, 'POST', {});
      await this.prisma.snsInstagramAccount.update({ where: { id }, data: { status: 'ACTIVE', lastValidatedAt: new Date() } });
      return result;
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
      await this.updateInstagramLoginStatus(id, error);
      throw new HttpException(detail, status);
    }
  }

  @Post('/accounts/:id/validate')
  async validateAccount(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    await this.account(org, id);
    try {
      const result = await this.worker(`/accounts/${encodeURIComponent(id)}/validate`, 'POST', {});
      await this.prisma.snsInstagramAccount.update({ where: { id }, data: { status: 'ACTIVE', lastValidatedAt: new Date() } });
      return result;
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
      await this.updateInstagramLoginStatus(id, error);
      throw new HttpException(detail, status);
    }
  }

  @Delete('/accounts/:id')
  async archiveAccount(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    await this.account(org, id);
    await this.worker(`/accounts/${encodeURIComponent(id)}`, 'DELETE');
    await this.prisma.snsInstagramAccount.update({ where: { id }, data: { status: 'DISCONNECTED', archivedAt: new Date(), defaultStoryPoolId: null } });
    return { archived: true };
  }

  @Get('/accounts/:id/info')
  async accountInfo(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    await this.account(org, id);
    return this.worker(`/accounts/${encodeURIComponent(id)}/info`);
  }

  @Get('/accounts/:id/trial-reel-eligibility')
  async trialEligibility(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    await this.account(org, id);
    return this.worker(`/accounts/${encodeURIComponent(id)}/trial-reel-eligibility`);
  }

  @Get('/accounts/:id/health')
  async accountHealth(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    await this.account(org, id);
    return this.worker(`/accounts/${encodeURIComponent(id)}/health`);
  }

  @Put('/accounts/:id/story-settings')
  async updateStorySettings(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: StickerDto & { captionAIEnabled?: boolean; captionProfile?: Record<string, unknown>; defaultStoryPoolId?: string }
  ) {
    await this.account(org, id);
    if (body.defaultStoryPoolId) {
      const pool = await this.prisma.snsStoryPool.findFirst({ where: { id: body.defaultStoryPoolId, organizationId: org.id } });
      if (!pool) throw new HttpException('Story Pool not found', HttpStatus.NOT_FOUND);
    }
    return this.prisma.snsInstagramAccount.update({
      where: { id },
      data: {
        defaultStickerX: body.x,
        defaultStickerY: body.y,
        defaultStickerWidth: body.width,
        defaultStickerHeight: body.height,
        defaultStickerRotation: body.rotation,
        ...(body.captionAIEnabled === undefined ? {} : { captionAIEnabled: body.captionAIEnabled }),
        ...(body.captionProfile === undefined ? {} : { captionProfile: body.captionProfile as any }),
        ...(body.defaultStoryPoolId === undefined ? {} : { defaultStoryPoolId: body.defaultStoryPoolId }),
      },
    });
  }

  @Put('/accounts/:id/caption-settings')
  async updateCaptionSettings(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: CaptionSettingsDto) {
    await this.account(org, id);
    return this.prisma.snsInstagramAccount.update({
      where: { id },
      data: { captionAIEnabled: body.enabled, ...(body.profile === undefined ? {} : { captionProfile: body.profile as any }) },
    });
  }

  @Post('/caption/generate')
  async generateCaption(@GetOrgFromRequest() org: Organization, @Body() body: CaptionGenerateDto) {
    const account = await this.account(org, body.accountId);
    if (!account.captionAIEnabled) throw new HttpException({ code: 'CAPTION_AI_DISABLED' }, HttpStatus.BAD_REQUEST);
    try {
      return { caption: await this.captionProvider.generate(body.sourceText, (account.captionProfile || {}) as Record<string, unknown>) };
    } catch (error) {
      const code = error instanceof Error && error.message === 'OPENAI_API_KEY_NOT_CONFIGURED' ? 'OPENAI_API_KEY_NOT_CONFIGURED' : 'CAPTION_GENERATION_FAILED';
      throw new ServiceUnavailableException({ code });
    }
  }

  @Post('/media/probe')
  mediaProbe(@Body() body: MediaProbeDto) {
    return this.mediaWorker('/probe', 'POST', { path: body.path });
  }

  @Get('/media/preview')
  async mediaPreview(@GetOrgFromRequest() org: Organization, @Query('path') mediaPath: string, @Req() request: ExpressRequest, @Res() response: ExpressResponse): Promise<void> {
    if (!mediaPath) throw new HttpException({ code: 'MEDIA_PATH_REQUIRED' }, HttpStatus.BAD_REQUEST);
    const [asset, storyItem] = await Promise.all([
      this.prisma.snsMediaAsset.findFirst({ where: { organizationId: org.id, storageKey: mediaPath }, select: { mimeType: true } }),
      this.prisma.snsStoryPoolItem.findFirst({ where: { mediaPath, pool: { organizationId: org.id } }, select: { mediaType: true } }),
    ]);
    if (!asset && !storyItem) throw new HttpException({ code: 'MEDIA_NOT_FOUND' }, HttpStatus.NOT_FOUND);
    const uploadRoot = resolve(process.env.UPLOAD_DIRECTORY || './uploads');
    const relativePath = mediaPath.replace(/^\/uploads\//, '');
    const filePath = resolve(uploadRoot, relativePath);
    if (!filePath.startsWith(`${uploadRoot}${sep}`) || !existsSync(filePath) || !statSync(filePath).isFile()) {
      throw new HttpException({ code: 'MEDIA_NOT_FOUND' }, HttpStatus.NOT_FOUND);
    }
    const fileStat = statSync(filePath);
    if (!fileStat.size) throw new HttpException({ code: 'MEDIA_NOT_FOUND' }, HttpStatus.NOT_FOUND);
    const extension = extname(filePath).toLowerCase();
    const mimeType = asset?.mimeType || ({ '.mp4': 'video/mp4', '.mov': 'video/quicktime', '.webm': 'video/webm', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' } as Record<string, string>)[extension] || (storyItem?.mediaType === 'image' ? 'image/jpeg' : 'application/octet-stream');
    const range = request.headers.range;
    let statusCode = 200;
    let start = 0;
    let end = fileStat.size - 1;
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range);
      if (!match || (!match[1] && !match[2])) {
        response.status(416).setHeader('Content-Range', `bytes */${fileStat.size}`);
        response.end();
        return;
      }
      if (match[1]) start = Number(match[1]);
      if (!match[1] && match[2]) {
        const suffixLength = Number(match[2]);
        if (!Number.isSafeInteger(suffixLength) || suffixLength <= 0) {
          response.status(416).setHeader('Content-Range', `bytes */${fileStat.size}`);
          response.end();
          return;
        }
        start = Math.max(0, fileStat.size - suffixLength);
        end = fileStat.size - 1;
      }
      if (match[1] && match[2]) end = Number(match[2]);
      if (!match[2]) end = fileStat.size - 1;
      if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || start >= fileStat.size || end < start) {
        response.status(416).setHeader('Content-Range', `bytes */${fileStat.size}`);
        response.end();
        return;
      }
      end = Math.min(end, fileStat.size - 1);
      statusCode = 206;
      response.setHeader('Content-Range', `bytes ${start}-${end}/${fileStat.size}`);
    }
    response.status(statusCode);
    response.setHeader('Content-Type', mimeType);
    response.setHeader('Accept-Ranges', 'bytes');
    response.setHeader('Content-Length', String(end - start + 1));
    await new Promise<void>((resolveStream, rejectStream) => {
      const stream = createReadStream(filePath, { start, end });
      stream.once('error', rejectStream);
      response.once('finish', resolveStream);
      response.once('close', resolveStream);
      stream.pipe(response);
    });
  }

  @Get('/media/health')
  mediaHealth() {
    return this.mediaWorker('/health');
  }

  @Post('/media/preflight/reel')
  async preflightReel(@GetOrgFromRequest() org: Organization, @Body() body: PreflightDto) {
    const account = await this.account(org, body.accountId);
    const errors: string[] = [];
    const warnings: string[] = [];
    let media: any;
    let trialEligible: boolean | null = null;
    let thumbnail: any;
    try {
      media = await this.mediaWorker('/probe', 'POST', { path: body.mediaPath });
    } catch (error) {
      errors.push(error instanceof HttpException ? String((error.getResponse() as any)?.code || 'MEDIA_INVALID') : 'MEDIA_WORKER_UNAVAILABLE');
    }
    const health = await this.worker(`/accounts/${encodeURIComponent(account.id)}/health`).catch(() => ({ status: 'UNAVAILABLE' }));
    if (account.status !== 'ACTIVE' || health.status !== 'GREEN') errors.push('INSTAGRAM_SESSION_NOT_HEALTHY');
    if (media) {
      if (media.kind !== 'video') errors.push('VIDEO_STREAM_REQUIRED');
      if (!media.video?.width || !media.video?.height) errors.push('VIDEO_STREAM_REQUIRED');
      if (media.video?.codec && !['h264', 'avc1'].includes(media.video.codec)) warnings.push('VIDEO_CODEC_MAY_NOT_BE_SUPPORTED');
      const ratio = media.video?.width && media.video?.height ? media.video.width / media.video.height : 0;
      if (ratio && Math.abs(ratio - 9 / 16) > 0.08) warnings.push('VIDEO_IS_NOT_9_16');
      if (media.durationSeconds <= 0) errors.push('VIDEO_DURATION_INVALID');
      if (!media.hasAudio) warnings.push('VIDEO_HAS_NO_AUDIO');
    }
    if (body.thumbnailPath) {
      try { thumbnail = await this.mediaWorker('/probe', 'POST', { path: body.thumbnailPath }); }
      catch { errors.push('THUMBNAIL_NOT_READABLE'); }
      if (thumbnail && (thumbnail.kind !== 'image' || !thumbnail.video?.width || !thumbnail.video?.height)) errors.push('THUMBNAIL_INVALID');
    }
    if (body.caption && body.caption.length > 2200) errors.push('CAPTION_TOO_LONG');
    if (body.trialReel) {
      const result: any = await this.worker(`/accounts/${encodeURIComponent(account.id)}/trial-reel-eligibility`).catch(() => ({ eligible: false }));
      trialEligible = !!result.eligible;
      if (!trialEligible) errors.push('TRIAL_REEL_NOT_ELIGIBLE');
    }
    return { ready: errors.length === 0, errors, warnings, account: { id: account.id, username: account.username, status: health.status }, media: media || null, thumbnail: thumbnail || null, trialEligible };
  }

  @Post('/media/preflight/story')
  async preflightStory(@GetOrgFromRequest() org: Organization, @Body() body: PreflightDto) {
    const account = await this.account(org, body.accountId);
    const errors: string[] = [];
    const warnings: string[] = [];
    let media: any;
    try {
      media = await this.mediaWorker('/probe', 'POST', { path: body.mediaPath });
    } catch (error) {
      errors.push(error instanceof HttpException ? String((error.getResponse() as any)?.code || 'MEDIA_INVALID') : 'MEDIA_WORKER_UNAVAILABLE');
    }
    if (!['image', 'video'].includes(body.mediaType || '')) errors.push('STORY_MEDIA_TYPE_INVALID');
    if (!body.linkUrl) errors.push('STORY_LINK_REQUIRED');
    else {
      try {
        const url = new URL(body.linkUrl);
        if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) errors.push('STORY_LINK_URL_INVALID');
      } catch { errors.push('STORY_LINK_URL_INVALID'); }
    }
    if (!body.sticker) errors.push('STORY_STICKER_SETTINGS_REQUIRED');
    if (media && body.mediaType && media.kind !== body.mediaType) errors.push('STORY_MEDIA_TYPE_MISMATCH');
    if (media && (!media.video?.width || !media.video?.height)) errors.push('STORY_MEDIA_DIMENSIONS_INVALID');
    if (media?.video?.width > 8192 || media?.video?.height > 8192) errors.push('STORY_MEDIA_DIMENSIONS_UNSUPPORTED');
    if (media?.kind === 'video' && media.durationSeconds > 60) warnings.push('STORY_VIDEO_MAY_BE_SEGMENTED_BY_INSTAGRAM');
    if (media?.kind === 'video' && media.video?.codec && !['h264', 'avc1'].includes(media.video.codec)) warnings.push('STORY_VIDEO_CODEC_MAY_NOT_BE_SUPPORTED');
    const ratio = media?.video?.width && media?.video?.height ? media.video.width / media.video.height : 0;
    if (ratio && Math.abs(ratio - 9 / 16) > 0.1) warnings.push('MEDIA_IS_NOT_9_16');
    if (account.status !== 'ACTIVE') errors.push('INSTAGRAM_SESSION_NOT_HEALTHY');
    let visual: any = null;
    if (body.mediaType === 'video' && errors.length === 0) {
      try {
        const check = await this.worker('/media/preflight/story', 'POST', {
          accountId: account.id, mediaPath: body.mediaPath, mediaType: body.mediaType,
          linkUrl: body.linkUrl, sticker: body.sticker,
        });
        if (!check.ready) errors.push(...(check.errors?.length ? check.errors : ['IG_STORY_VISUAL_RENDER_FAILED']));
        warnings.push(...(check.warnings || []));
        visual = check.visual || null;
      } catch (error) {
        errors.push(error instanceof HttpException ? String((error.getResponse() as any)?.code || 'IG_STORY_VISUAL_RENDER_FAILED') : 'INSTAGRAM_WORKER_UNAVAILABLE');
      }
    }
    // Finish local validation/rendering before any Instagram session request.
    let health = { status: 'NOT_CHECKED' };
    if (errors.length === 0) {
      health = await this.worker(`/accounts/${encodeURIComponent(account.id)}/health`).catch(() => ({ status: 'UNAVAILABLE' }));
      if (health.status !== 'GREEN') errors.push('INSTAGRAM_SESSION_NOT_HEALTHY');
    }
    return { ready: errors.length === 0, errors, warnings, account: { id: account.id, username: account.username, status: health.status }, media: media || null, visual };
  }

  @Post('/media/render')
  async renderMedia(@GetOrgFromRequest() org: Organization, @Body() body: RenderDto) {
    const result: any = await this.mediaWorker('/render', 'POST', body);
    const saved = await this.prisma.snsMediaAsset.create({
      data: {
        organizationId: org.id,
        source: 'FFMPEG_RENDER',
        storageKey: result.path,
        fileName: result.fileName,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(result.sizeBytes || 0),
        width: result.width,
        height: result.height,
        duration: result.durationSeconds,
        isFinal: true,
        metadata: { renderSettings: body, hasAudio: result.hasAudio } as any,
      },
    });
    return { ...result, mediaAssetId: saved.id };
  }

  @Post('/media/comic/render')
  async renderComic(@GetOrgFromRequest() org: Organization, @Body() body: Record<string, any>) {
    if (!Array.isArray(body.pages) || body.pages.length < 1 || body.pages.length > 60) {
      throw new HttpException({ code: 'COMIC_PAGES_INVALID' }, HttpStatus.BAD_REQUEST);
    }
    const result: any = await this.mediaWorker('/comic/render', 'POST', body);
    const saved = await this.prisma.snsMediaAsset.create({
      data: {
        organizationId: org.id,
        source: 'COMIC_RENDER',
        storageKey: result.path,
        fileName: result.fileName,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(result.sizeBytes || 0),
        width: result.width,
        height: result.height,
        duration: result.durationSeconds,
        isFinal: true,
        metadata: { pageCount: result.pageCount, voicePresetId: body.voicePresetId || null, editingPresetId: body.editingPresetId || null, backgroundMusicApplied: !!body.bgmPath } as any,
      },
    });
    return { ...result, mediaAssetId: saved.id };
  }

  @Post('/media/concat')
  async concatenateMedia(@GetOrgFromRequest() org: Organization, @Body() body: { paths: string[] }) {
    if (!Array.isArray(body.paths) || body.paths.length < 2 || body.paths.length > 20) {
      throw new HttpException({ code: 'CONCAT_INPUT_INVALID' }, HttpStatus.BAD_REQUEST);
    }
    const result: any = await this.mediaWorker('/concat', 'POST', body);
    const saved = await this.prisma.snsMediaAsset.create({
      data: {
        organizationId: org.id, source: 'FFMPEG_CONCAT', storageKey: result.path, fileName: result.fileName,
        mimeType: 'video/mp4', sizeBytes: BigInt(result.sizeBytes || 0), width: result.width, height: result.height,
        duration: result.durationSeconds, isFinal: true, metadata: { inputCount: result.inputCount, inputs: body.paths } as any,
      },
    });
    return { ...result, mediaAssetId: saved.id };
  }

  @Post('/media/variants')
  async generateVariants(@GetOrgFromRequest() org: Organization, @Body() body: Record<string, any>) {
    const count = Number(body.count);
    if (!Number.isInteger(count) || count < 1 || count > 20 || typeof body.sourcePath !== 'string') {
      throw new HttpException({ code: 'VARIANT_INPUT_INVALID' }, HttpStatus.BAD_REQUEST);
    }
    const settings = body.settings && typeof body.settings === 'object' ? body.settings : {};
    const range = (name: string, low: number, high: number, min: number, max: number) => {
      const config = settings[name];
      if (!config?.enabled) return undefined;
      const first = Number(config.min);
      const last = Number(config.max);
      if (!Number.isFinite(first) || !Number.isFinite(last) || first > last || first < min || last > max) {
        throw new HttpException({ code: 'VARIANT_RANGE_INVALID', field: name }, HttpStatus.BAD_REQUEST);
      }
      return Number((first + Math.random() * (last - first)).toFixed(3));
    };
    const variants = [];
    for (let index = 0; index < count; index += 1) {
      const adopted = {
        playbackSpeed: range('playbackSpeed', 0.5, 2, 0.5, 2),
        trimStartSeconds: range('trimStartSeconds', 0, 30, 0, 30),
        trimEndSeconds: range('trimEndSeconds', 0, 30, 0, 30),
        cropPercent: range('cropPercent', 95, 100, 95, 100),
      };
      const bgmPaths: string[] = Array.isArray(settings.bgmPaths) ? settings.bgmPaths.filter((path: unknown) => typeof path === 'string') : [];
      const chosenBgm = settings.bgmEnabled && bgmPaths.length ? bgmPaths[Math.floor(Math.random() * bgmPaths.length)] : undefined;
      const renderSettings = {
        sourcePath: body.sourcePath,
        outputName: `variant-${index + 1}.mp4`,
        ...Object.fromEntries(Object.entries(adopted).filter(([, value]) => value !== undefined)),
        ...(chosenBgm ? { bgmPath: chosenBgm } : {}),
        ...(settings.bgmVolume === undefined ? {} : { bgmVolume: Number(settings.bgmVolume) }),
        ...(settings.subtitlesPath ? { subtitlesPath: settings.subtitlesPath } : {}),
      };
      const rendered: any = await this.mediaWorker('/render', 'POST', renderSettings);
      const asset = await this.prisma.snsMediaAsset.create({
        data: {
          organizationId: org.id, source: 'FFMPEG_VARIANT', storageKey: rendered.path, fileName: rendered.fileName,
          mimeType: 'video/mp4', sizeBytes: BigInt(rendered.sizeBytes || 0), width: rendered.width, height: rendered.height,
          duration: rendered.durationSeconds, isFinal: true, metadata: { adoptedSettings: { ...adopted, bgmPath: chosenBgm || null } } as any,
        },
      });
      variants.push({ ...rendered, mediaAssetId: asset.id, adoptedSettings: { ...adopted, bgmPath: chosenBgm || null } });
    }
    return { variants };
  }

  @Get('/editing-presets')
  editingPresets(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsEditingPreset.findMany({ where: { organizationId: org.id }, orderBy: { name: 'asc' } });
  }

  @Post('/editing-presets')
  async saveEditingPreset(@GetOrgFromRequest() org: Organization, @Body() body: EditingPresetDto) {
    return this.prisma.snsEditingPreset.upsert({
      where: { organizationId_name: { organizationId: org.id, name: body.name } },
      create: { organizationId: org.id, name: body.name, config: body.config as any },
      update: { config: body.config as any },
    });
  }

  @Get('/voice-presets')
  voicePresets(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsVoicePreset.findMany({ where: { organizationId: org.id }, orderBy: { name: 'asc' } });
  }

  @Post('/voice-presets')
  saveVoicePreset(@GetOrgFromRequest() org: Organization, @Body() body: VoicePresetDto) {
    return this.prisma.snsVoicePreset.upsert({
      where: { organizationId_name: { organizationId: org.id, name: body.name } },
      create: { organizationId: org.id, name: body.name, slots: body.slots as any, ttsSettings: body.ttsSettings as any },
      update: { slots: body.slots as any, ttsSettings: body.ttsSettings as any },
    });
  }

  @Get('/voicevox/speakers')
  voicevoxSpeakers() {
    return this.mediaWorker('/voicevox/speakers');
  }

  @Post('/voicevox/audio')
  voicevoxAudio(@Body() body: { text: string; speakerId: number }) {
    return this.mediaWorker('/voicevox/audio', 'POST', body);
  }

  @Get('/urls')
  listUrls(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsUrlLibraryItem.findMany({ where: { organizationId: org.id }, orderBy: { updatedAt: 'desc' } });
  }

  @Post('/urls')
  createUrl(@GetOrgFromRequest() org: Organization, @Body() body: UrlLibraryDto) {
    return this.prisma.snsUrlLibraryItem.create({ data: { organizationId: org.id, ...body } });
  }

  @Put('/urls/:id')
  async updateUrl(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: UrlLibraryDto) {
    const existing = await this.prisma.snsUrlLibraryItem.findFirst({ where: { id, organizationId: org.id } });
    if (!existing) throw new HttpException('URL not found', HttpStatus.NOT_FOUND);
    return this.prisma.snsUrlLibraryItem.update({ where: { id }, data: body });
  }

  @Delete('/urls/:id')
  async deleteUrl(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    const existing = await this.prisma.snsUrlLibraryItem.findFirst({ where: { id, organizationId: org.id } });
    if (!existing) throw new HttpException('URL not found', HttpStatus.NOT_FOUND);
    await this.prisma.snsUrlLibraryItem.delete({ where: { id } });
    return { deleted: true };
  }

  @Get('/story-pools')
  listPools(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsStoryPool.findMany({ where: { organizationId: org.id }, orderBy: { updatedAt: 'desc' }, include: { items: { orderBy: { position: 'asc' }, include: { urlLibrary: true } }, _count: { select: { accounts: true } } } });
  }

  @Post('/story-pools')
  createPool(@GetOrgFromRequest() org: Organization, @Body() body: StoryPoolDto) {
    return this.prisma.snsStoryPool.create({ data: { organizationId: org.id, ...body } });
  }

  @Post('/story-pools/:id/items')
  async addPoolItem(@GetOrgFromRequest() org: Organization, @Param('id') id: string, @Body() body: StoryPoolItemDto) {
    const pool = await this.prisma.snsStoryPool.findFirst({ where: { id, organizationId: org.id } });
    if (!pool) throw new HttpException('Story Pool not found', HttpStatus.NOT_FOUND);
    if (!['image', 'video'].includes(body.mediaType)) throw new HttpException('mediaType must be image or video', HttpStatus.BAD_REQUEST);
    if (body.urlLibraryId) {
      const url = await this.prisma.snsUrlLibraryItem.findFirst({ where: { id: body.urlLibraryId, organizationId: org.id, active: true } });
      if (!url) throw new HttpException('Active URL not found', HttpStatus.NOT_FOUND);
    }
    const position = await this.prisma.snsStoryPoolItem.count({ where: { poolId: id } });
    return this.prisma.snsStoryPoolItem.create({ data: { poolId: id, mediaPath: body.mediaPath, mediaType: body.mediaType, urlLibraryId: body.urlLibraryId, urlSnapshot: body.urlSnapshot, position } });
  }

  @Post('/accounts/:id/story-pool/next')
  async nextStory(@GetOrgFromRequest() org: Organization, @Param('id') accountId: string) {
    const account = await this.account(org, accountId);
    if (!account.defaultStoryPoolId) throw new HttpException('No default Story Pool is assigned', HttpStatus.BAD_REQUEST);
    const poolId = account.defaultStoryPoolId;
    return this.prisma.$transaction(async (tx) => {
      const lockKey = `${accountId}:${poolId}`;
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))::text AS locked`;
      const items = await tx.snsStoryPoolItem.findMany({ where: { poolId, active: true, pool: { organizationId: org.id, active: true } }, include: { urlLibrary: true } });
      const prior = await tx.snsStoryPoolUsage.findMany({ where: { accountId, poolId }, select: { itemId: true, cycle: true } });
      const choice = chooseShuffleBagItem(items, prior);
      if (!choice) throw new HttpException('Story Pool is empty', HttpStatus.BAD_REQUEST);
      await tx.snsStoryPoolUsage.create({ data: { accountId, poolId, itemId: choice.item.id, cycle: choice.cycle } });
      return { ...choice.item, url: choice.item.urlLibrary?.url || choice.item.urlSnapshot, cycle: choice.cycle };
    });
  }

  @Post('/accounts/:id/story-pool/:poolId')
  async setDefaultPool(@GetOrgFromRequest() org: Organization, @Param('id') accountId: string, @Param('poolId') poolId: string) {
    await this.account(org, accountId);
    const pool = await this.prisma.snsStoryPool.findFirst({ where: { id: poolId, organizationId: org.id } });
    if (!pool) throw new HttpException('Story Pool not found', HttpStatus.NOT_FOUND);
    return this.prisma.snsInstagramAccount.update({ where: { id: accountId }, data: { defaultStoryPoolId: poolId } });
  }

  @Get('/content-inbox')
  listInbox(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsContentInboxItem.findMany({ where: { organizationId: org.id }, orderBy: { updatedAt: 'desc' }, take: 100, include: { mediaAsset: { select: { storageKey: true, mimeType: true, width: true, height: true, duration: true } } } }).then((rows) => rows.map((row) => ({ ...row, sizeBytes: row.sizeBytes?.toString() ?? null })));
  }

  @Get('/recipes')
  listRecipes(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsAutomationRecipe.findMany({ where: { organizationId: org.id }, orderBy: { updatedAt: 'desc' } });
  }

  @Post('/recipes')
  createRecipe(@GetOrgFromRequest() org: Organization, @Body() body: RecipeDto) {
    return this.prisma.snsAutomationRecipe.create({ data: { organizationId: org.id, ...body, config: body.config as any } });
  }

  @Get('/queue')
  async queue(@GetOrgFromRequest() org: Organization) {
    const working = await this.prisma.snsPipelineRun.findMany({ where: { organizationId: org.id, status: { in: ['GENERATING', 'EDITING'] } }, select: { id: true, currentStep: true } });
    const abandoned = working.filter((run) => !this.activePipelines.has(run.id));
    for (const run of abandoned) {
      const failedStep = run.currentStep || 'GENERATE';
      await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: run.id }, data: { status: 'FAILED', errorCode: 'PIPELINE_INTERRUPTED', errorMessage: 'PIPELINE_INTERRUPTED' } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: run.id, name: failedStep, status: { in: ['RUNNING', 'PENDING'] } }, data: { status: 'FAILED', errorCode: 'PIPELINE_INTERRUPTED', errorMessage: 'PIPELINE_INTERRUPTED', completedAt: new Date() } }),
      ]);
    }
    return this.prisma.snsPipelineRun.findMany({ where: { organizationId: org.id }, orderBy: { updatedAt: 'desc' }, take: 100, include: { recipe: { select: { name: true } }, steps: { orderBy: { createdAt: 'asc' } }, publishRecords: { orderBy: { createdAt: 'desc' }, take: 1, select: { status: true, postUrl: true, publishedAt: true } } } });
  }

  private async savePipelineMedia(organizationId: string, source: string, result: any, metadata: Record<string, unknown>) {
    return this.prisma.snsMediaAsset.create({
      data: {
        organizationId,
        source,
        storageKey: result.path,
        fileName: result.fileName,
        mimeType: 'video/mp4',
        sizeBytes: BigInt(result.sizeBytes || 0),
        width: result.width,
        height: result.height,
        duration: result.durationSeconds,
        isFinal: true,
        metadata: metadata as any,
      },
    });
  }

  private async executePipelineRun(organizationId: string, runId: string) {
    const run = await this.prisma.snsPipelineRun.findFirst({
      where: { id: runId, organizationId, status: 'NEW' },
      include: { recipe: true, steps: true },
    });
    if (!run) return;
    const claim = await this.prisma.snsPipelineRun.updateMany({ where: { id: runId, organizationId, status: 'NEW' }, data: { status: 'GENERATING', startedAt: run.startedAt || new Date(), errorCode: null, errorMessage: null } });
    if (!claim.count) return;
    this.activePipelines.add(runId);

    const input = run.input && typeof run.input === 'object' && !Array.isArray(run.input) ? run.input as Record<string, any> : {};
    const config = run.recipe?.config && typeof run.recipe.config === 'object' && !Array.isArray(run.recipe.config) ? run.recipe.config as Record<string, any> : {};
    const inputType = String(run.recipe?.inputType || input.inputType || (Array.isArray(input.pages) ? 'COMIC_PAGES' : 'VIDEO')).toUpperCase();
    const priorOutput = run.output && typeof run.output === 'object' && !Array.isArray(run.output) ? run.output as Record<string, any> : {};
    const steps = new Map(run.steps.map((step) => [step.name, step]));
    const resumeStep = run.currentStep || 'GENERATE';
    let currentStep = resumeStep;
    let pipelineOutput = { ...priorOutput };

    try {
      if (typeof input.inboxItemId === 'string') await this.prisma.snsContentInboxItem.updateMany({ where: { id: input.inboxItemId, organizationId }, data: { status: 'PROCESSING' } });
      const generate = steps.get('GENERATE');
      if (resumeStep === 'GENERATE' || generate?.status !== 'COMPLETED') {
        currentStep = 'GENERATE';
        await this.prisma.snsPipelineRun.update({ where: { id: runId }, data: { status: 'GENERATING', currentStep } });
        await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId, name: currentStep } }, data: { status: 'RUNNING', input: { inputType }, startedAt: new Date(), errorCode: null, errorMessage: null } });
        if (inputType === 'STORY_POOL') {
          const accountId = String(input.accountId || config.accountId || '');
          if (!accountId) throw new HttpException({ code: 'STORY_ACCOUNT_REQUIRED' }, HttpStatus.BAD_REQUEST);
          const account = await this.prisma.snsInstagramAccount.findFirst({ where: { id: accountId, organizationId } });
          if (!account) throw new HttpException({ code: 'ACCOUNT_NOT_FOUND' }, HttpStatus.NOT_FOUND);
          const poolId = String(input.poolId || config.poolId || account.defaultStoryPoolId || '');
          if (!poolId) throw new HttpException({ code: 'STORY_POOL_REQUIRED' }, HttpStatus.BAD_REQUEST);
          const selection = await this.prisma.$transaction(async (tx) => {
            await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${`${accountId}:${poolId}`}))::text AS locked`;
            const items = await tx.snsStoryPoolItem.findMany({ where: { poolId, active: true, pool: { organizationId, active: true } }, include: { urlLibrary: true } });
            const prior = await tx.snsStoryPoolUsage.findMany({ where: { accountId, poolId }, select: { itemId: true, cycle: true } });
            const choice = chooseShuffleBagItem(items, prior);
            if (!choice) throw new HttpException({ code: 'STORY_POOL_EMPTY' }, HttpStatus.BAD_REQUEST);
            await tx.snsStoryPoolUsage.create({ data: { accountId, poolId, itemId: choice.item.id, cycle: choice.cycle } });
            return { item: choice.item, url: choice.item.urlLibrary?.url || choice.item.urlSnapshot, cycle: choice.cycle };
          });
          pipelineOutput = { ...pipelineOutput, accountId, poolId, mediaPath: selection.item.mediaPath, mediaType: selection.item.mediaType, linkUrl: selection.url || '', publishType: 'STORY', storyItemId: selection.item.id, cycle: selection.cycle, caption: '', storySticker: { x: account.defaultStickerX, y: account.defaultStickerY, width: account.defaultStickerWidth, height: account.defaultStickerHeight, rotation: account.defaultStickerRotation } };
        } else if (inputType === 'COMIC_PAGES') {
          const pages = input.pages;
          if (!Array.isArray(pages) || pages.length < 1 || pages.length > 60) throw new HttpException({ code: 'COMIC_PAGES_INVALID' }, HttpStatus.BAD_REQUEST);
          pipelineOutput = { ...pipelineOutput, pages, publishType: 'REEL', sourceType: 'COMIC_PAGES', accountId: input.accountId || config.accountId || '', caption: input.caption || config.caption || '' };
        } else {
          const sourcePath = input.sourcePath || input.mediaPath;
          if (typeof sourcePath !== 'string' || !sourcePath) throw new HttpException({ code: 'PIPELINE_SOURCE_REQUIRED' }, HttpStatus.BAD_REQUEST);
          pipelineOutput = { ...pipelineOutput, sourcePath, accountId: input.accountId || config.accountId || '', caption: input.caption || config.caption || '', publishType: config.publishType || 'REEL', trialReel: input.trialReel ?? config.trialReelDefault ?? false };
        }
        await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId, name: 'GENERATE' } }, data: { status: 'COMPLETED', output: { ...(inputType === 'STORY_POOL' ? { storyItemId: pipelineOutput.storyItemId, mediaPath: pipelineOutput.mediaPath } : {}), inputType }, completedAt: new Date() } });
        await this.prisma.snsPipelineRun.update({ where: { id: runId }, data: { output: pipelineOutput as any } });
      }

      currentStep = 'EDIT';
      const editStep = steps.get('EDIT');
      if (resumeStep === 'EDIT' || editStep?.status !== 'COMPLETED') {
        await this.prisma.snsPipelineRun.update({ where: { id: runId }, data: { status: 'EDITING', currentStep } });
        await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId, name: currentStep } }, data: { status: 'RUNNING', input: { inputType }, startedAt: new Date(), errorCode: null, errorMessage: null } });
        if (inputType === 'STORY_POOL') {
          pipelineOutput = { ...pipelineOutput, mediaAssetId: null };
        } else if (inputType === 'COMIC_PAGES') {
          const voicePresetId = input.voicePresetId || config.voicePresetId || config.ttsPresetId;
          const voicePreset = voicePresetId ? await this.prisma.snsVoicePreset.findFirst({ where: { id: String(voicePresetId), organizationId } }) : null;
          const editingPresetId = input.editingPresetId || config.editingPresetId;
          const editingPreset = editingPresetId ? await this.prisma.snsEditingPreset.findFirst({ where: { id: String(editingPresetId), organizationId } }) : null;
          const editingSettings = editingPreset?.config && typeof editingPreset.config === 'object' && !Array.isArray(editingPreset.config) ? editingPreset.config as Record<string, unknown> : {};
          const ttsSettings = { ...(voicePreset?.ttsSettings && typeof voicePreset.ttsSettings === 'object' ? voicePreset.ttsSettings as Record<string, unknown> : {}), ...(config.ttsSettings || {}), ...(input.ttsSettings || {}) };
          const renderBody = { ...editingSettings, ...(config.editingConfig || {}), ...ttsSettings, pages: pipelineOutput.pages, voiceSlots: voicePreset?.slots || config.voiceSlots || input.voiceSlots || {}, subtitles: input.subtitles ?? config.subtitles ?? true, outputName: `pipeline-${runId}.mp4` };
          const result: any = await this.mediaWorker('/comic/render', 'POST', renderBody);
          const asset = await this.savePipelineMedia(organizationId, 'PIPELINE_COMIC_RENDER', result, { pipelineRunId: runId, pageCount: result.pageCount, voicePresetId: voicePreset?.id || null, editingPresetId: editingPreset?.id || null, renderSettings: renderBody as any });
          const comicOutput = { ...pipelineOutput };
          delete comicOutput.pages;
          pipelineOutput = { ...comicOutput, mediaPath: asset.storageKey, mediaAssetId: asset.id, mediaType: 'video', durationSeconds: result.durationSeconds, width: result.width, height: result.height, voicePresetId: voicePreset?.id || null };
        } else {
          let presetConfig: Record<string, any> = {};
          const presetId = input.editingPresetId || config.editingPresetId;
          if (presetId) {
            const preset = await this.prisma.snsEditingPreset.findFirst({ where: { id: String(presetId), organizationId } });
            if (!preset) throw new HttpException({ code: 'EDITING_PRESET_NOT_FOUND' }, HttpStatus.NOT_FOUND);
            if (preset.config && typeof preset.config === 'object' && !Array.isArray(preset.config)) presetConfig = preset.config as Record<string, any>;
          }
          const renderSettings = { ...presetConfig, ...(config.editingConfig || {}), ...(config.renderSettings || {}), ...(input.renderSettings || {}), sourcePath: pipelineOutput.sourcePath, outputName: `pipeline-${runId}.mp4` };
          const result: any = await this.mediaWorker('/render', 'POST', renderSettings);
          const asset = await this.savePipelineMedia(organizationId, 'PIPELINE_VIDEO_RENDER', result, { pipelineRunId: runId, renderSettings: renderSettings as any, inputPath: pipelineOutput.sourcePath });
          pipelineOutput = { ...pipelineOutput, mediaPath: asset.storageKey, mediaAssetId: asset.id, mediaType: 'video', durationSeconds: result.durationSeconds, width: result.width, height: result.height };
        }
        await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId, name: 'EDIT' } }, data: { status: 'COMPLETED', output: { mediaPath: pipelineOutput.mediaPath, mediaAssetId: pipelineOutput.mediaAssetId || null, mediaType: pipelineOutput.mediaType || 'video' }, completedAt: new Date() } });
        await this.prisma.snsPipelineRun.update({ where: { id: runId }, data: { output: pipelineOutput as any } });
      } else {
        pipelineOutput = { ...pipelineOutput, ...((editStep?.output && typeof editStep.output === 'object' ? editStep.output : {}) as Record<string, any>) };
      }

      currentStep = 'REVIEW';
      await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId, name: currentStep } }, data: { status: 'PENDING', input: { mediaPath: pipelineOutput.mediaPath }, errorCode: null, errorMessage: null } });
      await this.prisma.snsPipelineRun.update({ where: { id: runId }, data: { status: 'READY_FOR_REVIEW', currentStep, output: pipelineOutput as any, errorCode: null, errorMessage: null } });
      if (typeof input.inboxItemId === 'string') {
        await this.prisma.snsContentInboxItem.updateMany({ where: { id: input.inboxItemId, organizationId }, data: { status: 'READY_FOR_REVIEW', mediaAssetId: pipelineOutput.mediaAssetId || undefined } });
      }
    } catch (error) {
      const response = error instanceof HttpException ? error.getResponse() : null;
      const code = response && typeof response === 'object' && 'code' in response ? String((response as any).code) : 'PIPELINE_STEP_FAILED';
      const message = code;
      await this.prisma.snsPipelineStep.updateMany({ where: { runId, name: currentStep }, data: { status: 'FAILED', errorCode: code, errorMessage: message, completedAt: new Date() } });
      await this.prisma.snsPipelineRun.update({ where: { id: runId }, data: { status: 'FAILED', currentStep, output: pipelineOutput as any, errorCode: code, errorMessage: message } });
      if (typeof input.inboxItemId === 'string') await this.prisma.snsContentInboxItem.updateMany({ where: { id: input.inboxItemId, organizationId }, data: { status: 'FAILED' } });
    } finally {
      this.activePipelines.delete(runId);
    }
  }

  @Post('/queue')
  async createPipeline(@GetOrgFromRequest() org: Organization, @Body() body: PipelineDto) {
    const recipe = body.recipeId ? await this.prisma.snsAutomationRecipe.findFirst({ where: { id: body.recipeId, organizationId: org.id } }) : null;
    if (body.recipeId && !recipe) {
      throw new HttpException('Recipe not found', HttpStatus.NOT_FOUND);
    }
    const created = await this.prisma.snsPipelineRun.create({ data: { organizationId: org.id, recipeId: body.recipeId, input: (body.input || {}) as any, steps: { create: [{ name: 'GENERATE' }, { name: 'EDIT' }, { name: 'REVIEW' }, { name: 'PUBLISH' }] } }, include: { steps: true } });
    void this.executePipelineRun(org.id, created.id).catch(() => undefined);
    return created;
  }

  @Post('/queue/:id/approve')
  async approvePipeline(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    const run = await this.prisma.snsPipelineRun.findFirst({ where: { id, organizationId: org.id } });
    if (!run) throw new HttpException('Pipeline run not found', HttpStatus.NOT_FOUND);
    if (run.status !== 'READY_FOR_REVIEW') throw new HttpException('Pipeline is not ready for review', HttpStatus.CONFLICT);
    await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId: id, name: 'REVIEW' } }, data: { status: 'COMPLETED', completedAt: new Date() } });
    return this.prisma.snsPipelineRun.update({ where: { id }, data: { status: 'APPROVED', approvedAt: new Date(), currentStep: 'PUBLISH' } });
  }

  @Post('/queue/:id/retry')
  async retryPipelineStep(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    const run = await this.prisma.snsPipelineRun.findFirst({ where: { id, organizationId: org.id }, include: { steps: true } });
    if (!run) throw new HttpException('Pipeline run not found', HttpStatus.NOT_FOUND);
    if (run.status !== 'FAILED') throw new HttpException({ code: 'PIPELINE_RETRY_NOT_AVAILABLE' }, HttpStatus.CONFLICT);
    const failedStep = run.currentStep || 'GENERATE';
    if (failedStep === 'PUBLISH') {
      await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId: id, name: 'PUBLISH' } }, data: { status: 'PENDING', errorCode: null, errorMessage: null, startedAt: null, completedAt: null } });
      return this.prisma.snsPipelineRun.update({ where: { id }, data: { status: 'APPROVED', currentStep: 'PUBLISH', approvedAt: run.approvedAt || new Date(), errorCode: null, errorMessage: null } });
    }
    if (failedStep === 'REVIEW') {
      await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId: id, name: 'REVIEW' } }, data: { status: 'PENDING', errorCode: null, errorMessage: null, completedAt: null } });
      return this.prisma.snsPipelineRun.update({ where: { id }, data: { status: 'READY_FOR_REVIEW', currentStep: 'REVIEW', errorCode: null, errorMessage: null } });
    }
    await this.prisma.snsPipelineStep.update({ where: { runId_name: { runId: id, name: failedStep } }, data: { status: 'PENDING', errorCode: null, errorMessage: null, startedAt: null, completedAt: null } });
    const restarted = await this.prisma.snsPipelineRun.update({ where: { id }, data: { status: 'NEW', currentStep: failedStep, errorCode: null, errorMessage: null } });
    void this.executePipelineRun(org.id, id).catch(() => undefined);
    return restarted;
  }

  @Post('/publish/reel')
  async publishReel(@GetOrgFromRequest() org: Organization, @Body() body: PublishReelDto) {
    const account = await this.account(org, body.accountId);
    if (body.pipelineRunId) {
      const run = await this.prisma.snsPipelineRun.findFirst({ where: { id: body.pipelineRunId, organizationId: org.id } });
      if (!run || run.status !== 'APPROVED') throw new HttpException({ code: 'PIPELINE_APPROVAL_REQUIRED' }, HttpStatus.CONFLICT);
    }
    const preflight = await this.preflightReel(org, { accountId: body.accountId, mediaPath: body.videoPath, thumbnailPath: body.thumbnailPath, caption: body.caption, trialReel: body.trialReel });
    if (!preflight.ready) throw new HttpException({ code: 'PREFLIGHT_FAILED', errors: preflight.errors, warnings: preflight.warnings }, HttpStatus.CONFLICT);
    const record = await this.prisma.snsPublishRecord.create({
      data: { organizationId: org.id, accountId: account.id, pipelineRunId: body.pipelineRunId || undefined, mediaPath: body.videoPath, publishType: body.trialReel ? 'TRIAL_REEL' : 'REEL', status: 'PUBLISHING', trialReel: !!body.trialReel, caption: body.caption, recipeName: body.recipeName, presetName: body.presetName, variantSettings: { ...(body.variantSettings || {}), thumbnailPath: body.thumbnailPath } as any, duration: body.duration },
    });
    try {
      if (body.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: body.pipelineRunId }, data: { status: 'PUBLISHING', currentStep: 'PUBLISH' } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: body.pipelineRunId, name: 'PUBLISH' }, data: { status: 'RUNNING', startedAt: new Date(), errorCode: null, errorMessage: null } }),
      ]);
      const result = await this.worker('/publish/reel', 'POST', body);
      await this.prisma.snsInstagramAccount.update({ where: { id: account.id }, data: { status: 'ACTIVE', lastPublishedAt: new Date() } });
      await this.prisma.snsMediaAsset.updateMany({ where: { organizationId: org.id, storageKey: body.videoPath, isFinal: true }, data: { publishedAt: new Date() } });
      if (body.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: body.pipelineRunId }, data: { status: 'PUBLISHED', currentStep: 'PUBLISH', completedAt: new Date() } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: body.pipelineRunId, name: 'PUBLISH' }, data: { status: 'COMPLETED', completedAt: new Date() } }),
      ]);
      const published = await this.prisma.snsPublishRecord.update({
        where: { id: record.id },
        data: { status: 'PUBLISHED', mediaId: result.mediaId, postUrl: result.postUrl, publishedAt: new Date(result.publishedAt), rawResponse: result as any },
      });
      return { ...published, preflightWarnings: preflight.warnings };
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
      const code = typeof detail === 'object' ? (detail as any)?.code : undefined;
      await this.prisma.snsPublishRecord.update({ where: { id: record.id }, data: { status: 'FAILED', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: typeof detail === 'string' ? detail : code || 'Instagram could not complete the request.' } });
      if (body.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: body.pipelineRunId }, data: { status: 'FAILED', currentStep: 'PUBLISH', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: code || 'Instagram could not complete the request.' } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: body.pipelineRunId, name: 'PUBLISH' }, data: { status: 'FAILED', errorCode: code || 'IG_REQUEST_FAILED', completedAt: new Date() } }),
      ]);
      throw new HttpException(detail, status);
    }
  }

  @Post('/publish/story')
  async publishStory(@GetOrgFromRequest() org: Organization, @Body() body: PublishStoryDto) {
    const account = await this.account(org, body.accountId);
    if (body.pipelineRunId) {
      const run = await this.prisma.snsPipelineRun.findFirst({ where: { id: body.pipelineRunId, organizationId: org.id } });
      if (!run || run.status !== 'APPROVED') throw new HttpException({ code: 'PIPELINE_APPROVAL_REQUIRED' }, HttpStatus.CONFLICT);
    }
    const preflight = await this.preflightStory(org, { accountId: body.accountId, mediaPath: body.mediaPath, mediaType: body.mediaType, linkUrl: body.linkUrl, sticker: body.sticker });
    if (!preflight.ready) throw new HttpException({ code: 'PREFLIGHT_FAILED', errors: preflight.errors, warnings: preflight.warnings }, HttpStatus.CONFLICT);
    await this.prisma.snsInstagramAccount.update({
      where: { id: account.id },
      data: {
        defaultStickerX: body.sticker.x,
        defaultStickerY: body.sticker.y,
        defaultStickerWidth: body.sticker.width,
        defaultStickerHeight: body.sticker.height,
        defaultStickerRotation: body.sticker.rotation,
      },
    });
    const record = await this.prisma.snsPublishRecord.create({
      data: { organizationId: org.id, accountId: account.id, pipelineRunId: body.pipelineRunId, mediaPath: body.mediaPath, publishType: 'STORY', status: 'PUBLISHING', recipeName: body.recipeName, variantSettings: { sticker: body.sticker, mediaType: body.mediaType, linkUrl: body.linkUrl } as any },
    });
    try {
      if (body.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: body.pipelineRunId }, data: { status: 'PUBLISHING', currentStep: 'PUBLISH' } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: body.pipelineRunId, name: 'PUBLISH' }, data: { status: 'RUNNING', startedAt: new Date(), errorCode: null, errorMessage: null } }),
      ]);
      const result = await this.worker('/publish/story', 'POST', body);
      await this.prisma.snsInstagramAccount.update({ where: { id: account.id }, data: { status: 'ACTIVE', lastPublishedAt: new Date() } });
      await this.prisma.snsMediaAsset.updateMany({ where: { organizationId: org.id, storageKey: body.mediaPath, isFinal: true }, data: { publishedAt: new Date() } });
      if (body.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: body.pipelineRunId }, data: { status: 'PUBLISHED', currentStep: 'PUBLISH', completedAt: new Date() } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: body.pipelineRunId, name: 'PUBLISH' }, data: { status: 'COMPLETED', completedAt: new Date() } }),
      ]);
      const published = await this.prisma.snsPublishRecord.update({ where: { id: record.id }, data: { status: 'PUBLISHED', mediaId: result.mediaId, postUrl: result.postUrl, publishedAt: new Date(result.publishedAt), rawResponse: result as any } });
      return { ...published, preflightWarnings: preflight.warnings };
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
      const code = typeof detail === 'object' ? (detail as any)?.code : undefined;
      await this.prisma.snsPublishRecord.update({ where: { id: record.id }, data: { status: 'FAILED', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: code || 'Instagram could not complete the request.' } });
      if (body.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: body.pipelineRunId }, data: { status: 'FAILED', currentStep: 'PUBLISH', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: code || 'Instagram could not complete the request.' } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: body.pipelineRunId, name: 'PUBLISH' }, data: { status: 'FAILED', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: code || 'Instagram could not complete the request.', completedAt: new Date() } }),
      ]);
      throw new HttpException(detail, status);
    }
  }

  @Get('/publish-records')
  publishRecords(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsPublishRecord.findMany({ where: { organizationId: org.id }, orderBy: { createdAt: 'desc' }, take: 100, include: { account: { select: { username: true } }, snapshots: { orderBy: { capturedAt: 'desc' }, take: 1 } } });
  }

  @Post('/publish-records/:id/retry')
  async retryFailedPublish(@GetOrgFromRequest() org: Organization, @Param('id') id: string) {
    const previous = await this.prisma.snsPublishRecord.findFirst({ where: { id, organizationId: org.id }, include: { account: true } });
    if (!previous) throw new HttpException({ code: 'PUBLISH_RECORD_NOT_FOUND' }, HttpStatus.NOT_FOUND);
    if (previous.status !== 'FAILED' || !previous.mediaPath) throw new HttpException({ code: 'PUBLISH_RETRY_NOT_AVAILABLE' }, HttpStatus.CONFLICT);
    await this.account(org, previous.accountId);
    const record = await this.prisma.snsPublishRecord.create({
      data: {
        organizationId: org.id, accountId: previous.accountId, pipelineRunId: previous.pipelineRunId, mediaPath: previous.mediaPath,
        publishType: previous.publishType, status: 'PUBLISHING', trialReel: previous.trialReel,
        caption: previous.caption, recipeName: previous.recipeName, presetName: previous.presetName,
        variantSettings: previous.variantSettings as any, duration: previous.duration,
      },
    });
    try {
      let result: any;
      if (previous.publishType === 'REEL' || previous.publishType === 'TRIAL_REEL') {
        const variant = previous.variantSettings && typeof previous.variantSettings === 'object' && !Array.isArray(previous.variantSettings) ? previous.variantSettings as Record<string, unknown> : {};
        const thumbnailPath = typeof variant.thumbnailPath === 'string' ? variant.thumbnailPath : undefined;
        const preflight = await this.preflightReel(org, { accountId: previous.accountId, mediaPath: previous.mediaPath, caption: previous.caption || '', trialReel: previous.trialReel, thumbnailPath });
        if (!preflight.ready) throw new HttpException({ code: 'PREFLIGHT_FAILED', errors: preflight.errors, warnings: preflight.warnings }, HttpStatus.CONFLICT);
        const publishBody = { accountId: previous.accountId, videoPath: previous.mediaPath, caption: previous.caption || '', trialReel: previous.trialReel, thumbnailPath: typeof variant.thumbnailPath === 'string' ? variant.thumbnailPath : undefined };
        result = await this.worker('/publish/reel', 'POST', publishBody);
      } else if (previous.publishType === 'STORY') {
        const variant = previous.variantSettings && typeof previous.variantSettings === 'object' && !Array.isArray(previous.variantSettings) ? previous.variantSettings as Record<string, any> : {};
        const sticker = variant.sticker;
        if (!sticker || typeof variant.linkUrl !== 'string' || !['image', 'video'].includes(variant.mediaType)) throw new HttpException({ code: 'STORY_RETRY_DATA_MISSING' }, HttpStatus.CONFLICT);
        const preflight = await this.preflightStory(org, { accountId: previous.accountId, mediaPath: previous.mediaPath, mediaType: variant.mediaType, linkUrl: variant.linkUrl, sticker });
        if (!preflight.ready) throw new HttpException({ code: 'PREFLIGHT_FAILED', errors: preflight.errors, warnings: preflight.warnings }, HttpStatus.CONFLICT);
        result = await this.worker('/publish/story', 'POST', { accountId: previous.accountId, mediaPath: previous.mediaPath, mediaType: variant.mediaType, linkUrl: variant.linkUrl, sticker });
      } else {
        throw new HttpException({ code: 'PUBLISH_RETRY_NOT_AVAILABLE' }, HttpStatus.CONFLICT);
      }
      await this.prisma.snsInstagramAccount.update({ where: { id: previous.accountId }, data: { status: 'ACTIVE', lastPublishedAt: new Date() } });
      await this.prisma.snsMediaAsset.updateMany({ where: { organizationId: org.id, storageKey: previous.mediaPath, isFinal: true }, data: { publishedAt: new Date() } });
      if (previous.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: previous.pipelineRunId }, data: { status: 'PUBLISHED', currentStep: 'PUBLISH', completedAt: new Date(), errorCode: null, errorMessage: null } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: previous.pipelineRunId, name: 'PUBLISH' }, data: { status: 'COMPLETED', completedAt: new Date(), errorCode: null, errorMessage: null } }),
      ]);
      return this.prisma.snsPublishRecord.update({ where: { id: record.id }, data: { status: 'PUBLISHED', mediaId: result.mediaId, postUrl: result.postUrl, publishedAt: new Date(result.publishedAt), rawResponse: result as any } });
    } catch (error) {
      const status = error instanceof HttpException ? error.getStatus() : 502;
      const detail = error instanceof HttpException ? error.getResponse() : { code: 'IG_REQUEST_FAILED' };
      const code = typeof detail === 'object' ? (detail as any)?.code : undefined;
      await this.prisma.snsPublishRecord.update({ where: { id: record.id }, data: { status: 'FAILED', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: code || 'Instagram could not complete the request.' } });
      if (previous.pipelineRunId) await this.prisma.$transaction([
        this.prisma.snsPipelineRun.update({ where: { id: previous.pipelineRunId }, data: { status: 'FAILED', currentStep: 'PUBLISH', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: code || 'Instagram could not complete the request.' } }),
        this.prisma.snsPipelineStep.updateMany({ where: { runId: previous.pipelineRunId, name: 'PUBLISH' }, data: { status: 'FAILED', errorCode: code || 'IG_REQUEST_FAILED', errorMessage: code || 'Instagram could not complete the request.', completedAt: new Date() } }),
      ]);
      throw new HttpException(detail, status);
    }
  }

  @Get('/analytics/media/:mediaId')
  async mediaInsights(@GetOrgFromRequest() org: Organization, @Param('mediaId') mediaId: string) {
    const record = await this.prisma.snsPublishRecord.findFirst({ where: { organizationId: org.id, mediaId } });
    if (!record) throw new HttpException('Published media not found', HttpStatus.NOT_FOUND);
    const result = await this.worker(`/insights/media/${encodeURIComponent(mediaId)}?accountId=${encodeURIComponent(record.accountId)}`);
    const normalized = { ...(result as any), metrics: normalizeInstagramMetrics((result as any).metrics) };
    await this.prisma.snsAnalyticsSnapshot.create({ data: { organizationId: org.id, publishRecordId: record.id, metrics: normalized.metrics as any, rawResponse: result as any } });
    return normalized;
  }

  @Get('/analytics')
  analytics(@GetOrgFromRequest() org: Organization) {
    return this.prisma.snsPublishRecord.findMany({ where: { organizationId: org.id, status: 'PUBLISHED' }, orderBy: { publishedAt: 'desc' }, take: 100, include: { account: { select: { username: true } }, snapshots: { orderBy: { capturedAt: 'desc' }, take: 1 } } });
  }

  @Get('/analytics/compare')
  async analyticsCompare(@GetOrgFromRequest() org: Organization, @Query('days') daysValue?: string) {
    const days = Math.min(90, Math.max(1, Number(daysValue) || 30));
    const now = Date.now();
    const currentStart = new Date(now - days * 24 * 60 * 60_000);
    const previousStart = new Date(now - days * 2 * 24 * 60 * 60_000);
    const records = await this.prisma.snsPublishRecord.findMany({
      where: { organizationId: org.id, status: 'PUBLISHED', publishedAt: { gte: previousStart } },
      include: { snapshots: { orderBy: { capturedAt: 'desc' }, take: 1 }, account: { select: { username: true } } },
    });
    const summarize = (rows: typeof records) => {
      const metrics: Record<string, number> = {};
      for (const record of rows) {
        const values = record.snapshots[0]?.metrics;
        if (!values || typeof values !== 'object' || Array.isArray(values)) continue;
        for (const [key, value] of Object.entries(values)) {
          if (typeof value === 'number') metrics[key] = (metrics[key] || 0) + value;
        }
      }
      return { posts: rows.length, metrics };
    };
    return {
      days,
      current: summarize(records.filter((record) => !!record.publishedAt && record.publishedAt >= currentStart)),
      previous: summarize(records.filter((record) => !!record.publishedAt && record.publishedAt < currentStart)),
    };
  }
}
