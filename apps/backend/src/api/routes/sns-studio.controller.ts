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
import { Organization, Prisma } from '@prisma/client';
import { IsBoolean, IsIn, IsNumber, IsOptional, IsString, IsUrl, Max, MaxLength, Min, MinLength, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { createReadStream, existsSync, readFileSync, statSync, unlinkSync } from 'fs';
import { Readable } from 'stream';
import { randomUUID } from 'crypto';
import { extname, resolve, sep } from 'path';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AccountProtectionService, ProtectedAction } from '@gitroom/nestjs-libraries/database/prisma/account-protection.service';
import { ApiTags } from '@nestjs/swagger';
import { chooseShuffleBagItem } from '@gitroom/helpers/utils/shuffle-bag';
import { GoogleDriveStorageProvider } from '@gitroom/backend/services/sns-studio/google-drive.storage';
import { GoogleDriveGenerationProvider } from '@gitroom/backend/services/sns-studio/google-drive.generation-provider';
import { SNS_STUDIO_CAPTION_PROVIDER } from '@gitroom/backend/services/sns-studio/caption-provider.interface';
import type { CaptionProvider } from '@gitroom/backend/services/sns-studio/caption-provider.interface';
import { normalizeInstagramMetrics } from '@gitroom/backend/services/sns-studio/instagram-metrics';
import { MediaService } from '@gitroom/nestjs-libraries/database/prisma/media/media.service';
import { UploadFactory } from '@gitroom/nestjs-libraries/upload/upload.factory';
import { uploadStreamToStorage } from '@gitroom/nestjs-libraries/upload/custom.upload.validation';

class InstagramLoginDto {
  @IsString() @MinLength(1) @MaxLength(100) username!: string;
  @IsString() @MinLength(1) @MaxLength(512) password!: string;
  @IsOptional() @IsString() @MaxLength(2048) proxy?: string;
  @IsOptional() @IsString() @MaxLength(32) verificationCode?: string;
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
  private readonly postizStorage = UploadFactory.createStorage();
  constructor(
    private readonly prisma: PrismaService,
    private readonly googleDrive: GoogleDriveStorageProvider,
    private readonly generationProvider: GoogleDriveGenerationProvider,
    private readonly mediaService: MediaService,
    private readonly accountProtection: AccountProtectionService,
    @Inject(SNS_STUDIO_CAPTION_PROVIDER) private readonly captionProvider: CaptionProvider,
  ) {}

  private protectedInstagram<T>(org: Organization, accountId: string, action: ProtectedAction, operation: () => Promise<T>) {
    return this.accountProtection.run({ organizationId: org.id, accountId, accountType: 'SNS_INSTAGRAM', provider: 'instagram-worker', action }, operation);
  }

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

  private snsPlatform(providerIdentifier: string) {
    if (providerIdentifier.startsWith('instagram')) return 'instagram';
    if (providerIdentifier.startsWith('tiktok')) return 'tiktok';
    if (providerIdentifier === 'youtube') return 'youtube';
    if (providerIdentifier === 'threads') return 'threads';
    if (providerIdentifier === 'x') return 'x';
    return providerIdentifier;
  }

  private snsHashtags(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((item) => (item.startsWith('#') ? item : `#${item}`));
  }

  private snsOptionalDate(value: unknown, code: string): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value);
    const normalized = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(text)
      ? `${text}Z`
      : text;
    const date = new Date(normalized);
    if (Number.isNaN(date.getTime())) {
      throw new HttpException({ code }, HttpStatus.BAD_REQUEST);
    }
    return date;
  }

  private async contentPlan(organizationId: string, id: string) {
    return this.prisma.snsContent.findFirst({
      where: { id, organizationId },
      include: {
        originalAsset: { select: { id: true, storageKey: true, fileName: true, mimeType: true, width: true, height: true, duration: true } },
        variants: {
          include: { mediaAsset: { select: { id: true, storageKey: true, fileName: true, mimeType: true, width: true, height: true, duration: true } } },
          orderBy: [{ isDefault: 'desc' }, { createdAt: 'asc' }],
        },
        platformOverrides: { orderBy: { platform: 'asc' } },
        deliveries: { orderBy: { createdAt: 'asc' } },
      },
    });
  }

  private async saveContentPlan(
    organizationId: string,
    body: Record<string, any>,
    contentId?: string
  ) {
    const title = typeof body.title === 'string' ? body.title.trim().slice(0, 200) : '';
    const commonContent = typeof body.commonContent === 'string' ? body.commonContent : '';
    const commonHashtags = this.snsHashtags(body.commonHashtags);
    const commonScheduledAt = this.snsOptionalDate(body.commonScheduledAt, 'COMMON_SCHEDULE_INVALID');
    const originalAssetId = typeof body.originalAssetId === 'string' && body.originalAssetId ? body.originalAssetId : null;
    const platformOverrides = Array.isArray(body.platformOverrides) ? body.platformOverrides : [];
    const deliveryInput = Array.isArray(body.deliveries) ? body.deliveries : [];
    const variantInput = Array.isArray(body.variants) ? body.variants : [];

    const assetIds = Array.from(
      new Set([
        ...(originalAssetId ? [originalAssetId] : []),
        ...variantInput
          .map((variant: any) => String(variant?.mediaAssetId || ''))
          .filter(Boolean),
      ])
    );
    if (assetIds.length) {
      const assets = await this.prisma.snsMediaAsset.findMany({
        where: { id: { in: assetIds }, organizationId },
        select: { id: true },
      });
      if (assets.length !== assetIds.length) {
        throw new HttpException({ code: 'CONTENT_ASSET_NOT_FOUND' }, HttpStatus.NOT_FOUND);
      }
    }

    const integrationIds = Array.from(
      new Set(
        deliveryInput
          .map((delivery: any) => String(delivery?.integrationId || ''))
          .filter(Boolean)
      )
    );
    const integrations = integrationIds.length
      ? await this.prisma.integration.findMany({
          where: {
            id: { in: integrationIds },
            organizationId,
            deletedAt: null,
            disabled: false,
          },
        })
      : [];
    if (integrations.length !== integrationIds.length) {
      throw new HttpException({ code: 'CONTENT_DELIVERY_ACCOUNT_INVALID' }, HttpStatus.BAD_REQUEST);
    }
    const integrationById = new Map(integrations.map((integration) => [integration.id, integration]));

    const existing = contentId ? await this.contentPlan(organizationId, contentId) : null;
    if (contentId && !existing) {
      throw new HttpException({ code: 'CONTENT_PLAN_NOT_FOUND' }, HttpStatus.NOT_FOUND);
    }
    if (existing?.deliveries.some((delivery) => delivery.status !== 'PLANNED')) {
      throw new HttpException({ code: 'CONTENT_PLAN_LOCKED_AFTER_POSTIZ_CREATE' }, HttpStatus.CONFLICT);
    }

    const savedId = await this.prisma.$transaction(async (tx) => {
      const content = existing
        ? await tx.snsContent.update({
            where: { id: existing.id },
            data: {
              title: title || null,
              commonContent,
              commonHashtags: commonHashtags as any,
              commonScheduledAt,
              originalAssetId,
              status: deliveryInput.length ? 'READY' : 'DRAFT',
            },
          })
        : await tx.snsContent.create({
            data: {
              organizationId,
              title: title || null,
              commonContent,
              commonHashtags: commonHashtags as any,
              commonScheduledAt,
              originalAssetId,
              status: deliveryInput.length ? 'READY' : 'DRAFT',
            },
          });

      let variants = [...(existing?.variants || [])];
      for (let index = 0; index < variantInput.length; index += 1) {
        const item = variantInput[index];
        const mediaAssetId =
          typeof item?.mediaAssetId === 'string' ? item.mediaAssetId : '';
        if (!mediaAssetId) continue;
        const makeDefault =
          item.isDefault === true || (!variants.length && index === 0);
        if (makeDefault) {
          await tx.snsContentVariant.updateMany({
            where: { contentId: content.id },
            data: { isDefault: false },
          });
          variants = variants.map((variant: any) => ({
            ...variant,
            isDefault: false,
          }));
        }
        const variant = await tx.snsContentVariant.upsert({
          where: {
            contentId_mediaAssetId: {
              contentId: content.id,
              mediaAssetId,
            },
          },
          create: {
            contentId: content.id,
            mediaAssetId,
            name:
              typeof item.name === 'string' && item.name.trim()
                ? item.name.trim().slice(0, 100)
                : `Variant ${index + 1}`,
            isDefault: makeDefault,
            metadata:
              item.metadata &&
              typeof item.metadata === 'object' &&
              !Array.isArray(item.metadata)
                ? item.metadata as any
                : undefined,
          },
          update: {
            name:
              typeof item.name === 'string' && item.name.trim()
                ? item.name.trim().slice(0, 100)
                : undefined,
            ...(makeDefault ? { isDefault: true } : {}),
            metadata:
              item.metadata &&
              typeof item.metadata === 'object' &&
              !Array.isArray(item.metadata)
                ? item.metadata as any
                : undefined,
          },
        });
        variants = [
          ...variants.filter(
            (candidate: any) => candidate.mediaAssetId !== mediaAssetId
          ),
          variant as any,
        ];
      }

      if (
        originalAssetId &&
        !variants.some(
          (variant: any) => variant.mediaAssetId === originalAssetId
        )
      ) {
        const makeDefault = !variants.some((variant: any) => variant.isDefault);
        const variant = await tx.snsContentVariant.create({
          data: {
            contentId: content.id,
            mediaAssetId: originalAssetId,
            name: 'Default',
            isDefault: makeDefault,
          },
        });
        variants = [...variants, variant as any];
      }

      await tx.snsContentPlatformOverride.deleteMany({ where: { contentId: content.id } });
      for (const item of platformOverrides) {
        const platform = typeof item?.platform === 'string' ? item.platform.trim().toLowerCase() : '';
        if (!platform) continue;
        await tx.snsContentPlatformOverride.create({
          data: {
            contentId: content.id,
            platform,
            contentOverride: typeof item.contentOverride === 'string' && item.contentOverride !== '' ? item.contentOverride : null,
            hashtagsOverride: Array.isArray(item.hashtagsOverride) ? this.snsHashtags(item.hashtagsOverride) as any : undefined,
            scheduledAtOverride: this.snsOptionalDate(item.scheduledAtOverride, 'PLATFORM_SCHEDULE_INVALID'),
            settingsOverride: item.settingsOverride && typeof item.settingsOverride === 'object' && !Array.isArray(item.settingsOverride) ? item.settingsOverride as any : undefined,
          },
        });
      }

      await tx.snsDelivery.deleteMany({ where: { contentId: content.id, status: 'PLANNED' } });
      const defaultVariant = variants.find((variant: any) => variant.isDefault) || variants[0];
      const platformMap = new Map(
        platformOverrides
          .filter((item: any) => typeof item?.platform === 'string')
          .map((item: any) => [String(item.platform).trim().toLowerCase(), item])
      );

      for (const item of deliveryInput) {
        const integration = integrationById.get(String(item.integrationId || ''));
        if (!integration) continue;
        const platform = this.snsPlatform(integration.providerIdentifier);
        const platformOverride: any = platformMap.get(platform) || {};
        const resolvedContent =
          typeof item.contentOverride === 'string' && item.contentOverride !== ''
            ? item.contentOverride
            : typeof platformOverride.contentOverride === 'string' && platformOverride.contentOverride !== ''
              ? platformOverride.contentOverride
              : commonContent;
        const resolvedHashtags = Array.isArray(item.hashtagsOverride)
          ? this.snsHashtags(item.hashtagsOverride)
          : Array.isArray(platformOverride.hashtagsOverride)
            ? this.snsHashtags(platformOverride.hashtagsOverride)
            : commonHashtags;
        const resolvedScheduledAt =
          this.snsOptionalDate(item.scheduledAtOverride, 'ACCOUNT_SCHEDULE_INVALID') ||
          this.snsOptionalDate(platformOverride.scheduledAtOverride, 'PLATFORM_SCHEDULE_INVALID') ||
          commonScheduledAt;
        const accountSettings =
          item.settingsOverride && typeof item.settingsOverride === 'object' && !Array.isArray(item.settingsOverride)
            ? item.settingsOverride
            : {};
        const requestedVariantId =
          typeof item.variantId === 'string' ? item.variantId : null;
        const requestedVariantAssetId =
          typeof item.variantAssetId === 'string' ? item.variantAssetId : null;
        const requestedVariant =
          (requestedVariantAssetId &&
            variants.find(
              (candidate: any) =>
                candidate.mediaAssetId === requestedVariantAssetId
            )) ||
          (requestedVariantId &&
            variants.find(
              (candidate: any) => candidate.id === requestedVariantId
            )) ||
          null;
        if (
          (requestedVariantAssetId || requestedVariantId) &&
          !requestedVariant
        ) {
          throw new HttpException(
            { code: 'CONTENT_VARIANT_INVALID' },
            HttpStatus.BAD_REQUEST
          );
        }
        const variant = requestedVariant || defaultVariant || null;

        await tx.snsDelivery.create({
          data: {
            contentId: content.id,
            variantId: variant?.id || null,
            integrationId: integration.id,
            providerIdentifier: integration.providerIdentifier,
            accountName: integration.name,
            contentOverride: typeof item.contentOverride === 'string' && item.contentOverride !== '' ? item.contentOverride : null,
            hashtagsOverride: Array.isArray(item.hashtagsOverride) ? this.snsHashtags(item.hashtagsOverride) as any : undefined,
            scheduledAtOverride: this.snsOptionalDate(item.scheduledAtOverride, 'ACCOUNT_SCHEDULE_INVALID'),
            settingsOverride: Object.keys(accountSettings).length ? accountSettings as any : undefined,
            resolvedContent,
            resolvedHashtags: resolvedHashtags as any,
            resolvedScheduledAt,
          },
        });
      }

      return content.id;
    });

    return this.contentPlan(organizationId, savedId);
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
          const data: Prisma.SnsContentInboxItemUncheckedCreateInput = {
            organizationId: org.id,
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
      await this.prisma.snsGenerationJob.update({ where: { i€é¸Ó⁄$z{-ÆÈ‹j◊ù–ÄòòÅ…ïçΩ…êπ¡’â±•Õ°ïë–Ä¯ÙÅç’……ïπ—M—Ö…–§§∞(ÄÄÄÄÄÅ¡…ïŸ•Ω’ÃËÅÕ’µµÖ…•Èî°…ïçΩ…ëÃπô•±—ï»†°…ïçΩ…ê§ÄÙ¯ÄÑÖ…ïçΩ…êπ¡’â±•Õ°ïë–ÄòòÅ…ïçΩ…êπ¡’â±•Õ°ïë–ÄÅç’……ïπ—M—Ö…–§§∞(ÄÄÄÅÙÏ(ÄÅÙ)Ù(