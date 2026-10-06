import {
  BadRequestException,
  ConflictException,
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
import { TikTokCreatorInfo } from '@gitroom/nestjs-libraries/integrations/social/tiktok.provider';
import { CreatePostDto } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';
import { CreationMethod, Integration } from '@prisma/client';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import {
  TikTokPublishGuard,
  TikTokPublishGuardResult,
} from './tiktok-publish.guard';
import { CommonPublishingService } from './common-publishing.service';

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
  publishDate?: string;
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
  creatorInfo?: TikTokCreatorInfo;
  warnings: TikTokPreflightWarning[];
  errors: Array<{ code: string; message: string }>;
  guard?: TikTokPublishGuardResult;
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
    // privacy_level has no default - must be explicitly selected
    duet: false,
    stitch: false,
    comment: false,
    autoAddMusic: 'no',
    brand_content_toggle: false,
    brand_organic_toggle: false,
    video_made_with_ai: false,
  };

  constructor(
    private readonly prisma: PrismaService,
    private readonly postsService: PostsService,
    private readonly integrationManager: IntegrationManager,
    private readonly refreshIntegrationService: RefreshIntegrationService,
    private readonly publishGuard: TikTokPublishGuard,
    private readonly commonPublishing: CommonPublishingService
  ) {}

  private async assertCommonPolicyUsesCommonPublisher(
    organizationId: string,
    integrationId: string
  ) {
    const account = (await this.commonPublishing.listAccountPolicies(organizationId))
      .find((item) => item.integrationId === integrationId);

    if (!account) {
      throw new NotFoundException({
        code: 'TIKTOK_INTEGRATION_NOT_FOUND',
      });
    }

    const policy = account.policy;
    if (
      !policy.autoPostEnabled ||
      policy.approvalRequired ||
      policy.maxPostsPerDay !== null ||
      policy.sameContentCooldownDays > 0
    ) {
      throw new ConflictException({
        code: 'COMMON_CONTENT_PLAN_REQUIRED',
        message:
          'このアカウントには共通投稿ポリシーが設定されています。承認・投稿上限・再投稿間隔を適用するため、共通投稿画面から配信計画を投稿してください。',
      });
    }
  }

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

    // 2. Commercial content disclosure rules
    if (merged.disclose === true) {
      if (!merged.brand_organic_toggle && !merged.brand_content_toggle) {
        throw new BadRequestException({
          code: 'TIKTOK_COMMERCIAL_DISCLOSURE_SELECTION_REQUIRED',
          message:
            'When commercial content disclosure is enabled, at least one of Your Brand or Branded Content must be selected.',
        });
      }
    }
    if (merged.brand_content_toggle === true && merged.privacy_level === 'SELF_ONLY') {
      throw new BadRequestException({
        code: 'TIKTOK_BRANDED_CONTENT_PRIVACY_INVALID',
        message: 'Branded content visibility cannot be set to Self Only.',
      });
    }

    // 3. DIRECT_POST validation: privacy level selection & affirmative consent
    if (merged.content_posting_method === 'DIRECT_POST') {
      if (!merged.privacy_level) {
        throw new BadRequestException({
          code: 'TIKTOK_PRIVACY_SELECTION_REQUIRED',
          message: 'TikTok privacy level must be explicitly selected for DIRECT_POST.',
        });
      }
      if (providerIdentifier === 'tiktok' && !merged.consentConfirmed) {
        throw new BadRequestException({
          code: 'TIKTOK_CONSENT_REQUIRED',
          message: 'Explicit user consent to TikTok Music Usage Confirmation is required for DIRECT_POST.',
        });
      }
      if (merged.consentConfirmed && !merged.consentConfirmedAt) {
        merged.consentConfirmedAt = new Date().toISOString();
      }
    }

    // 4. UPLOAD method warning
    if (merged.content_posting_method === 'UPLOAD') {
      warnings.push({
        code: 'TIKTOK_UPLOAD_LIMITED_SETTINGS',
        message:
          'UPLOADではTikTokアプリ内で公開を完了する必要があり、タイトル/本文以外の多くの設定は適用されません。',
      });
    }

    // 5. Validation via Postiz TikTokDto
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
   * Dedicated read endpoint logic for TikTok Personal Creator Info.
   */
  async getCreatorInfo(
    orgId: string,
    integrationId: string
  ): Promise<TikTokCreatorInfo> {
    const integration = await this.validateIntegration(orgId, integrationId);
    if (integration.providerIdentifier !== 'tiktok') {
      throw new BadRequestException({
        code: 'TIKTOK_CREATOR_INFO_PERSONAL_ONLY',
        message: 'Creator Info is only available for TikTok Personal accounts.',
      });
    }

    let accessToken = integration.token;
    const now = new Date();
    if (integration.tokenExpiration && integration.tokenExpiration < now) {
      const refreshed = await this.refreshIntegrationService.refresh(
        integration,
        'creator_info'
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
      if (!provider) {
        throw new Error('TikTok provider not found');
      }
      if (typeof provider.creatorInfo === 'function') {
        return await provider.creatorInfo(accessToken);
      }
      if (typeof provider.maxVideoLength === 'function') {
        const lengthRes = await provider.maxVideoLength(accessToken);
        return {
          creator_avatar_url: '',
          creator_username: '',
          creator_nickname: '',
          privacy_level_options: [
            'PUBLIC_TO_EVERYONE',
            'MUTUAL_FOLLOW_FRIENDS',
            'FOLLOWER_OF_CREATOR',
            'SELF_ONLY',
          ],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: lengthRes.maxDurationSeconds || 600,
        };
      }
      throw new Error('TikTok provider creatorInfo method not found');
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      throw new BadRequestException({
        code: 'TIKTOK_CREATOR_INFO_UNAVAILABLE',
        message:
          err?.message ||
          'TikTok Creator Infoを取得できませんでした。再度ログインするか、しばらく待ってからお試しください。',
      });
    }
  }

  /**
   * Check Creator Info / max video duration / interaction controls / privacy for Personal TikTok DIRECT_POST.
   * Fail-closed on missing Creator Info during DIRECT_POST.
   */
  async checkCreatorInfo(
    integration: Integration,
    resolvedSettings: Record<string, any>,
    media?: TikTokPublishMediaItem[],
    mediaDurationSeconds?: number
  ): Promise<{
    maxDurationSeconds?: number;
    creatorInfo?: TikTokCreatorInfo;
  }> {
    if (
      integration.providerIdentifier !== 'tiktok' ||
      resolvedSettings.content_posting_method !== 'DIRECT_POST'
    ) {
      return {};
    }

    const hasVideo = (media || []).some(
      (m) =>
        hasExtension(m?.path, 'mp4') || (m?.path?.indexOf?.('mp4') ?? -1) > -1
    );

    let accessToken = integration.token;
    const now = new Date();
    if (integration.tokenExpiration && integration.tokenExpiration < now) {
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

    let creatorInfo: TikTokCreatorInfo;
    try {
      const provider = this.integrationManager.getSocialIntegration('tiktok') as any;
      if (!provider) {
        throw new Error('TikTok provider not found');
      }
      if (typeof provider.creatorInfo === 'function') {
        creatorInfo = await provider.creatorInfo(accessToken);
      } else if (typeof provider.maxVideoLength === 'function') {
        const lengthRes = await provider.maxVideoLength(accessToken);
        creatorInfo = {
          creator_avatar_url: '',
          creator_username: '',
          creator_nickname: '',
          privacy_level_options: [
            'PUBLIC_TO_EVERYONE',
            'MUTUAL_FOLLOW_FRIENDS',
            'FOLLOWER_OF_CREATOR',
            'SELF_ONLY',
          ],
          comment_disabled: false,
          duet_disabled: false,
          stitch_disabled: false,
          max_video_post_duration_sec: lengthRes.maxDurationSeconds || 600,
        };
      } else {
        throw new Error('TikTok provider does not implement creator info methods');
      }
    } catch (err: any) {
      if (err instanceof HttpException) throw err;
      // Fail-closed on missing Creator Info during DIRECT_POST
      throw new BadRequestException({
        code: 'TIKTOK_CREATOR_INFO_UNAVAILABLE',
        message:
          'TikTok Creator Infoを取得できなかったため、事前確認を完了できませんでした。再度ログインするか、しばらく待ってからお試しください。',
      });
    }

    // 1. Dynamic privacy validation against creator's privacy_level_options
    if (
      creatorInfo.privacy_level_options &&
      creatorInfo.privacy_level_options.length > 0 &&
      resolvedSettings.privacy_level &&
      !creatorInfo.privacy_level_options.includes(resolvedSettings.privacy_level)
    ) {
      throw new BadRequestException({
        code: 'TIKTOK_PRIVACY_LEVEL_NOT_ALLOWED',
        message: `Selected privacy level "${resolvedSettings.privacy_level}" is not allowed for this creator account. Available options: ${creatorInfo.privacy_level_options.join(', ')}`,
      });
    }

    // 2. Interaction controls validation against creator settings
    if (creatorInfo.comment_disabled && resolvedSettings.comment) {
      throw new BadRequestException({
        code: 'TIKTOK_COMMENT_DISABLED_BY_CREATOR',
        message: 'Comments are disabled in this creator\'s TikTok account settings.',
      });
    }
    if (creatorInfo.duet_disabled && resolvedSettings.duet) {
      throw new BadRequestException({
        code: 'TIKTOK_DUET_DISABLED_BY_CREATOR',
        message: 'Duet is disabled in this creator\'s TikTok account settings.',
      });
    }
    if (creatorInfo.stitch_disabled && resolvedSettings.stitch) {
      throw new BadRequestException({
        code: 'TIKTOK_STITCH_DISABLED_BY_CREATOR',
        message: 'Stitch is disabled in this creator\'s TikTok account settings.',
      });
    }

    // 3. Video duration check
    const maxDuration = creatorInfo.max_video_post_duration_sec;
    if (
      hasVideo &&
      maxDuration &&
      mediaDurationSeconds !== undefined &&
      mediaDurationSeconds > maxDuration
    ) {
      throw new BadRequestException({
        code: 'TIKTOK_MEDIA_DURATION_EXCEEDED',
        message: `Video duration (${mediaDurationSeconds}s) exceeds maximum allowed duration (${maxDuration}s) for this TikTok account.`,
      });
    }

    return {
      maxDurationSeconds: maxDuration,
      creatorInfo,
    };
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

    // 3. Creator info validation (fail-closed for Personal DIRECT_POST)
    const { maxDurationSeconds, creatorInfo } =
      await this.checkCreatorInfo(
        integration,
        resolvedSettings,
        input.media,
        input.mediaDurationSeconds
      );

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

    const guard =
      input.mode === 'draft'
        ? undefined
        : await this.publishGuard.check({
            organizationId: orgId,
            integrationId: integration.id,
            media: input.media,
            ...(input.publishDate
              ? { now: new Date(input.publishDate) }
              : {}),
          });

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
      ...(creatorInfo ? { creatorInfo } : {}),
      warnings,
      errors: [],
      ...(guard ? { guard } : {}),
    };
  }

  /**
   * Publish a TikTok post via Postiz PostsService -> Temporal -> Provider.
   */
  async publish(
    orgId: string,
    input: TikTokPublishInput
  ): Promise<TikTokPublishResult> {
    const isPublishing = input.mode !== 'draft';
    if (isPublishing) {
      await this.assertCommonPolicyUsesCommonPublisher(
        orgId,
        input.integrationId
      );
    }

    // 1. Run Preflight
    const preflightResult = await this.preflight(orgId, input);

    // 2. Build Postiz CreatePostDto
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

    const createPost = async () => {
      // The final provider duplicate check and standard Postiz creation share
      // an account-scoped lock so concurrent requests cannot publish the same media.
      if (isPublishing) {
        await this.publishGuard.check({
          organizationId: orgId,
          integrationId: input.integrationId,
          media: input.media,
        });
      }

      // 4. Map settings and set __type via PostsService.mapTypeToPost()
      const mappedPostDto = await this.postsService.mapTypeToPost(
        createPostDto,
        orgId
      );

      // 5. Delegate to PostsService.createPost with CreationMethod.API
      return this.postsService.createPost(
        orgId,
        mappedPostDto,
        CreationMethod.API
      );
    };

    const createdPosts = isPublishing
      ? await this.publishGuard.withIntegrationLock(
          orgId,
          input.integrationId,
          createPost
        )
      : await createPost();

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
