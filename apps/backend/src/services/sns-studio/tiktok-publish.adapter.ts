import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { PostsService } from '@gitroom/nestjs-libraries/database/prisma/posts/posts.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { RefreshIntegrationService } from '@gitroom/nestjs-libraries/integrations/refresh.integration.service';
import { TikTokDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/tiktok.dto';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { CreationMethod, Integration } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';

export interface TikTokPublishMediaItem {
  id?: string;
  path: string;
  thumbnail?: string;
}

export interface TikTokPublishInput {
  integrationId: string;
  content: string;
  media: TikTokPublishMediaItem[];
  settings?: Partial<TikTokDto>;
  mode?: 'now' | 'draft';
  approved?: boolean;
  mediaDurationSeconds?: number;
}

export interface TikTokPreflightWarning {
  code: string;
  message: string;
}

export interface TikTokPreflightResult {
  valid: boolean;
  integrationId: string;
  platform: 'tiktok';
  providerIdentifier: 'tiktok' | 'tiktok-business';
  accountType: 'personal' | 'business';
  resolvedSettings: Record<string, any>;
  maxDurationSeconds?: number;
  warnings: TikTokPreflightWarning[];
  errors: Array<{ code: string; message: string }>;
}

export interface TikTokPublishResult {
  postId: string;
  integrationId: string;
  platform: 'tiktok';
  providerIdentifier: string;
  mode: 'now' | 'draft';
  resolvedSettings: Record<string, any>;
  warnings: TikTokPreflightWarning[];
}

@Injectable()
export class TikTokPublishAdapter {
  private readonly DEFAULT_TIKTOK_SETTINGS: Partial<TikTokDto> = {
    content_posting_method: 'DIRECT_POST',
    privacy_level: 'PUBLIC_TO_EVERYONE',
    duet: false,
    stitch: false,
    comment: true,
    autoAddMusic: 'no',
    brand_content_toggle: false,
    brand_organic_toggle: false,
    video_made_with_ai: false,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsService: PostsService,
    private readonly integrationManager: IntegrationManager,
    private readonly refreshIntegrationService: RefreshIntegrationService
  ) {}

  /**
   * Validate Integration ownership, status, and TikTok platform suitability.
   */
  async validateIntegration(
    orgId: string,
    integrationId: string
  ): Promise<Integration> {
    const integration = await this.prisma.integration.findFirst({
      where: {
        id: integrationId,
        organizationId: orgId,
        deletedAt: null,
      },
    });

    if (!integration) {
      throw new NotFoundException({
        code: 'TIKTOK_INTEGRATION_NOT_FOUND',
        message: `TikTok integration ${integrationId} not found or does not belong to this organization.`,
      });
    }

    if (
      integration.providerIdentifier !== 'tiktok' &&
      integration.providerIdentifier !== 'tiktok-business'
    ) {
      throw new BadRequestException({
        code: 'TIKTOK_INVALID_PROVIDER',
        message: `Integration ${integrationId} has providerIdentifier "${integration.providerIdentifier}", expected "tiktok" or "tiktok-business".`,
      });
    }

    if (integration.disabled) {
      throw new BadRequestException({
        code: 'TIKTOK_INTEGRATION_DISABLED',
        message: `TikTok integration ${integrationId} is disabled. Reconnect in Postiz settings.`,
      });
    }

    if (integration.refreshNeeded) {
      throw new BadRequestException({
        code: 'TIKTOK_REAUTH_REQUIRED',
        message: `TikTok integration ${integrationId} requires re-authorization.`,
      });
    }

    return integration;
  }

  /**
   * Normalize and validate TikTok settings according to account type (Personal vs Business).
   */
  async normalizeAndValidateSettings(
    providerIdentifier: string,
    rawSettings?: Partial<TikTokDto>
  ): Promise<{
    resolvedSettings: Record<string, any>;
    warnings: TikTokPreflightWarning[];
  }> {
    const warnings: TikTokPreflightWarning[] = [];

    // Merge default values with user-supplied values
    const merged: Record<string, any> = {
      ...this.DEFAULT_TIKTOK_SETTINGS,
      ...(rawSettings || {}),
    };

    // Ensure DIRECT_POST is default if empty
    if (!merged.content_posting_method) {
      merged.content_posting_method = 'DIRECT_POST';
    }

    // 1. Personal account constraints: music & location are NOT supported
    if (providerIdentifier === 'tiktok') {
      if (merged.music) {
        throw new BadRequestException({
          code: 'TIKTOK_SETTING_UNSUPPORTED',
          message:
            'Music selection is only supported on TikTok Business accounts. Please remove the music setting for Personal TikTok accounts.',
        });
      }
      if (merged.location) {
        throw new BadRequestException({
          code: 'TIKTOK_SETTING_UNSUPPORTED',
          message:
            'Location tagging is only supported on TikTok Business accounts. Please remove the location setting for Personal TikTok accounts.',
        });
      }
    }

    // 2. UPLOAD method warning
    if (merged.content_posting_method === 'UPLOAD') {
      warnings.push({
        code: 'TIKTOK_UPLOAD_LIMITED_SETTINGS',
        message:
          'UPLOADではTikTokアプリ内で公開を完了する必要があり、タイトル/本文以外の多くの設定は適用されません。',
      });
    }

    // 3. Validation via Postiz TikTokDto
    const dtoInstance = plainToInstance(TikTokDto, merged, {
      enableImplicitConversion: true,
    });
    const validationErrors = await validate(dtoInstance, {
      skipMissingProperties: false,
    });

    if (validationErrors.length > 0) {
      const messages = validationErrors
        .map((e) => Object.values(e.constraints || {}).join(', '))
        .join('; ');
      throw new BadRequestException({
        code: 'TIKTOK_INVALID_SETTINGS',
        message: `TikTok settings validation failed: ${messages}`,
      });
    }

    return { resolvedSettings: merged, warnings };
  }

  /**
   * Check Creator Info / max video duration for Personal TikTok DIRECT_POST with video.
   */
  async checkCreatorInfo(
    integration: Integration,
    resolvedSettings: Record<string, any>,
    media?: TikTokPublishMediaItem[],
    mediaDurationSeconds?: number
  ): Promise<{
    maxDurationSeconds?: number;
    warning?: TikTokPreflightWarning;
  }> {
    // Only Personal TikTok with DIRECT_POST and video media checks creator_info
    const hasVideo = (media || []).some(
      (m) =>
        hasExtension(m?.path, 'mp4') || (m?.path?.indexOf?.('mp4') ?? -1) > -1
    );

    if (
      integration.providerIdentifier !== 'tiktok' ||
      resolvedSettings.content_posting_method !== 'DIRECT_POST' ||
      !hasVideo
    ) {
      return {};
    }

    let accessToken = integration.token;
    const now = new Date();
    if (integration.tokenExpiration && integration.tokenExpiration < now) {
      // Token expired; attempt refresh via RefreshIntegrationService
      const refreshed = await this.refreshIntegrationService.refresh(
        integration,
        'creator_info_preflight'
      );
      if (!refreshed || !refreshed.accessToken) {
        throw new BadRequestException({
          code: 'TIKTOK_REAUTH_REQUIRED',
          message: 'TikTok token expired and refresh failed. Please re-authorize.',
        });
      }
      accessToken = refreshed.accessToken;
    }

    try {
      const provider = this.integrationManager.getSocialIntegration('tiktok') as any;
      if (!provider || typeof provider.maxVideoLength !== 'function') {
        return {};
      }

      const creatorInfo = await provider.maxVideoLength(accessToken);
      const maxDuration = creatorInfo?.maxDurationSeconds;

      if (
        maxDuration &&
        mediaDurationSeconds !== undefined &&
        mediaDurationSeconds > maxDuration
      ) {
        throw new BadRequestException({
          code: 'TIKTOK_MEDIA_DURATION_EXCEEDED',
          message: `Video duration (${mediaDurationSeconds}s) exceeds maximum allowed duration (${maxDuration}s) for this TikTok account.`,
        });
      }

      return { maxDurationSeconds: maxDuration };
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      // Network or API failure querying creator info is treated as non-fatal warning
      return {
        warning: {
          code: 'TIKTOK_CREATOR_INFO_UNAVAILABLE',
          message:
            'TikTok Creator Infoを取得できなかったため、アカウント固有の動画尺上限を事前確認できませんでした。',
        },
      };
    }
  }

  /**
   * Preflight checks for a TikTok post before submission.
   */
  async preflight(
    orgId: string,
    input: TikTokPublishInput
  ): Promise<TikTokPreflightResult> {
    // 1. Validate Integration
    const integration = await this.validateIntegration(orgId, input.integrationId);

    // 2. Normalize and validate settings
    const { resolvedSettings, warnings } =
      await this.normalizeAndValidateSettings(
        integration.providerIdentifier,
        input.settings
      );

    // 3. Creator info duration check (only for Personal video DIRECT_POST)
    const { maxDurationSeconds, warning: creatorWarning } =
      await this.checkCreatorInfo(
        integration,
        resolvedSettings,
        input.media,
        input.mediaDurationSeconds
      );

    if (creatorWarning) {
      warnings.push(creatorWarning);
    }

    // 4. Delegate validation to PostsService.validatePosts()
    const postsValidationPayload = [
      {
        integration: { id: integration.id },
        value: [
          {
            content: input.content || '',
            image: (input.media || []).map((m) => ({
              id: m.id || '',
              path: m.path,
              thumbnail: m.thumbnail,
            })),
          },
        ],
        settings: resolvedSettings,
      },
    ];

    const [validationResult] = await this.postsService.validatePosts(
      orgId,
      postsValidationPayload as any
    );

    if (validationResult) {
      // 4a. Check emptyContent
      if (validationResult.emptyContent) {
        throw new BadRequestException({
          code: 'TIKTOK_EMPTY_CONTENT',
          message: 'TikTok post requires content or media.',
        });
      }

      // 4b. Check settings DTO valid
      if (!validationResult.valid) {
        throw new BadRequestException({
          code: 'TIKTOK_PREFLIGHT_FAILED',
          message:
            validationResult.settingsError ||
            'TikTok settings validation failed.',
        });
      }

      // 4c. Check Provider checkValidity
      if (validationResult.errors !== true) {
        throw new BadRequestException({
          code: 'TIKTOK_MEDIA_INVALID',
          message:
            typeof validationResult.errors === 'string'
              ? validationResult.errors
              : 'TikTok media validation failed.',
        });
      }

      // 4d. Check tooLong
      if (validationResult.tooLong) {
        throw new BadRequestException({
          code: 'TIKTOK_CONTENT_TOO_LONG',
          message: `TikTok content exceeds the maximum length (${validationResult.maximumCharacters}).`,
        });
      }
    }

    return {
      valid: true,
      integrationId: integration.id,
      platform: 'tiktok',
      providerIdentifier: integration.providerIdentifier as 'tiktok' | 'tiktok-business',
      accountType:
        integration.providerIdentifier === 'tiktok-business'
          ? 'business'
          : 'personal',
      resolvedSettings,
      maxDurationSeconds,
      warnings,
      errors: [],
    };
  }

  /**
   * Publish a TikTok post via Postiz PostsService -> Temporal -> Provider.
   */
  async publish(
    orgId: string,
    input: TikTokPublishInput
  ): Promise<TikTokPublishResult> {
    // 1. Run Preflight
    const preflightResult = await this.preflight(orgId, input);

    // 2. Check autoPublishEnabled setting in SnsAppSetting (only publishing requires approval, not draft)
    const isPublishing = input.mode !== 'draft';

    const settingKey = `sns:tiktok:account:${input.integrationId}`;
    const settingRecord = await this.prisma.snsAppSetting.findUnique({
      where: {
        organizationId_key: {
          organizationId: orgId,
          key: settingKey,
        },
      },
    });

    const settingValue =
      settingRecord?.value && typeof settingRecord.value === 'object'
        ? (settingRecord.value as Record<string, any>)
        : {};
    const autoPublishEnabled =
      typeof settingValue.autoPublishEnabled === 'boolean'
        ? settingValue.autoPublishEnabled
        : true;

    if (isPublishing && !autoPublishEnabled && input.approved !== true) {
      throw new ForbiddenException({
        code: 'TIKTOK_APPROVAL_REQUIRED',
        message:
          'Auto-publish is disabled for this TikTok account. Explicit approval (approved: true) is required to publish.',
      });
    }

    // 3. Build Postiz CreatePostDto
    const createPostDto = {
      type: input.mode === 'draft' ? 'draft' : 'now',
      shortLink: false,
      date: new Date().toISOString(),
      tags: [],
      posts: [
        {
          integration: {
            id: input.integrationId,
          },
          value: [
            {
              content: input.content || '',
              image: (input.media || []).map((m) => ({
                id: m.id || '',
                path: m.path,
                thumbnail: m.thumbnail,
              })),
            },
          ],
          settings: preflightResult.resolvedSettings as any,
        },
      ],
    } as unknown as CreatePostDto;

    // 4. Map settings and set __type via PostsService.mapTypeToPost()
    const mappedPostDto = await this.postsService.mapTypeToPost(
      createPostDto,
      orgId
    );

    // 5. Delegate to PostsService.createPost with CreationMethod.API
    const createdPosts = await this.postsService.createPost(
      orgId,
      mappedPostDto,
      CreationMethod.API
    );

    const postId = createdPosts?.[0]?.postId;

    if (!postId) {
      throw new BadRequestException({
        code: 'TIKTOK_POST_CREATE_FAILED',
        message: 'Postiz did not return a postId for the TikTok post.',
      });
    }

    return {
      postId,
      integrationId: input.integrationId,
      platform: 'tiktok',
      providerIdentifier: preflightResult.providerIdentifier,
      mode: input.mode || 'now',
      resolvedSettings: preflightResult.resolvedSettings,
      warnings: preflightResult.warnings,
    };
  }
}
