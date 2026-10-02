import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import { State } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

const TIKTOK_PROVIDER_IDENTIFIERS = ['tiktok', 'tiktok-business'] as const;
const MAX_ERROR_MESSAGE_LENGTH = 1000;

type TikTokProviderIdentifier = (typeof TIKTOK_PROVIDER_IDENTIFIERS)[number];
type TikTokDeliveryMode = 'direct_post' | 'upload';

/** Remove common credential forms before exposing stored Postiz error text. */
export function sanitizeTikTokStatusErrorMessage(message: string): string {
  const sanitized = message
    .replace(
      /(["']?authorization["']?\s*[:=]\s*["']?)([^"'\r\n},]*)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(["']?(?:cookie|set-cookie)["']?\s*[:=]\s*["']?)([^"'\r\n}]*)/gi,
      '$1[REDACTED]'
    )
    .replace(
      /(["']?(?:access[_-]?token|refresh[_-]?token|client[_-]?secret|oauth[ _-]?secret|credentials)["']?\s*[:=]\s*["']?)([^"'\s&,;}]+)/gi,
      '$1[REDACTED]'
    )
    .replace(/\bBearer\s+[^\s"',;}\])]+/gi, 'Bearer [REDACTED]');

  if (sanitized.length <= MAX_ERROR_MESSAGE_LENGTH) {
    return sanitized;
  }
  return `${sanitized.slice(0, MAX_ERROR_MESSAGE_LENGTH - 1)}…`;
}

function resolveDeliveryMode(settings: string | null): TikTokDeliveryMode {
  if (typeof settings !== 'string') {
    return 'direct_post';
  }

  try {
    const parsed: unknown = JSON.parse(settings);
    if (
      parsed &&
      typeof parsed === 'object' &&
      !Array.isArray(parsed) &&
      (parsed as Record<string, unknown>).content_posting_method === 'UPLOAD'
    ) {
      return 'upload';
    }
  } catch {
    // Older and malformed Post settings follow TikTok's DIRECT_POST default.
  }

  return 'direct_post';
}

function normalizeState(state: State): 'draft' | 'pending' | 'published' | 'error' {
  switch (state) {
    case State.DRAFT:
      return 'draft';
    case State.QUEUE:
      return 'pending';
    case State.PUBLISHED:
      return 'published';
    case State.ERROR:
      return 'error';
    default:
      return 'pending';
  }
}

@Injectable()
export class TikTokStatusAdapter {
  constructor(private readonly prisma: PrismaService) {}

  async getPostStatus(organizationId: string, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: {
        id: postId,
        organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
        organizationId: true,
        integrationId: true,
        state: true,
        publishDate: true,
        settings: true,
        image: true,
        error: true,
        releaseId: true,
        releaseURL: true,
        createdAt: true,
        updatedAt: true,
        deletedAt: true,
        integration: {
          select: {
            providerIdentifier: true,
          },
        },
      },
    });

    if (!post) {
      throw new NotFoundException({ code: 'TIKTOK_POST_NOT_FOUND' });
    }

    const providerIdentifier = post.integration.providerIdentifier;
    if (!(TIKTOK_PROVIDER_IDENTIFIERS as readonly string[]).includes(providerIdentifier)) {
      throw new BadRequestException({ code: 'TIKTOK_POST_NOT_TIKTOK' });
    }

    const deliveryMode = resolveDeliveryMode(post.settings);
    const status = normalizeState(post.state);
    const errorHistory = await this.prisma.errors.findMany({
      where: {
        organizationId,
        postId: post.id,
      },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        message: true,
        platform: true,
        createdAt: true,
      },
    });

    const latestError =
      post.state === State.ERROR && post.error
        ? {
            message: sanitizeTikTokStatusErrorMessage(post.error),
            // Post has no dedicated error timestamp; updatedAt is its last
            // persisted status timestamp and is the closest available value.
            occurredAt: post.updatedAt.toISOString(),
          }
        : null;

    const warnings =
      deliveryMode === 'upload'
        ? [
            {
              code: 'TIKTOK_UPLOAD_REQUIRES_APP_PUBLISH',
              message: 'TikTokアプリ側で公開操作を完了する必要があります。',
            },
          ]
        : [];

    return {
      postId: post.id,
      integrationId: post.integrationId,
      platform: 'tiktok' as const,
      providerIdentifier,
      accountType: providerIdentifier === 'tiktok-business' ? 'business' : 'personal',
      status,
      postState: post.state,
      deliveryMode,
      ...(deliveryMode === 'upload'
        ? { publicationSemantics: 'tiktok_inbox_upload' as const }
        : status === 'published'
          ? { publicationSemantics: 'public_post' as const }
          : {}),
      publishDate: post.publishDate.toISOString(),
      createdAt: post.createdAt.toISOString(),
      updatedAt: post.updatedAt.toISOString(),
      releaseId: post.releaseId,
      releaseURL: post.releaseURL,
      latestError,
      errorHistory: errorHistory.map((error) => ({
        id: error.id,
        message: sanitizeTikTokStatusErrorMessage(error.message),
        platform: error.platform,
        createdAt: error.createdAt.toISOString(),
      })),
      warnings,
    };
  }
}
