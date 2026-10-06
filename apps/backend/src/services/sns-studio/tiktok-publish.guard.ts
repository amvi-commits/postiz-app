import {
  ConflictException,
  Injectable,
} from '@nestjs/common';
import { State } from '@prisma/client';
import { Mutex } from 'async-mutex';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export interface TikTokGuardMediaItem {
  id?: string;
  path: string;
}

export interface TikTokPublishGuardResult {
  duplicateWindowDays: number;
  duplicateDetected: false;
}

export interface TikTokPublishGuardInput {
  organizationId: string;
  integrationId: string;
  media?: TikTokGuardMediaItem[];
  now?: Date;
}

export interface TikTokPublishGuardPolicy {
  duplicateWindowDays: number;
}

type StoredPost = {
  id: string;
  organizationId: string;
  integrationId: string;
  state: State;
  publishDate: Date;
  deletedAt: Date | null;
  image: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DUPLICATE_WINDOW_DAYS = 30;
const SETTINGS_KEY_PREFIX = 'sns:tiktok:account:';

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value === 'string') {
    try {
      const parsed: unknown = JSON.parse(value);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : undefined;
    } catch {
      return undefined;
    }
  }

  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function inRangeInteger(
  value: unknown,
  minimum: number,
  maximum: number,
  fallback: number
): number {
  return typeof value === 'number' && Number.isInteger(value) &&
    value >= minimum && value <= maximum
    ? value
    : fallback;
}

function parseStoredJson(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return undefined;
  }
}

function asDate(value: unknown): Date | undefined {
  const date = value instanceof Date ? value : new Date(value as string | number);
  return Number.isNaN(date.getTime()) ? undefined : date;
}

function isEligiblePost(post: StoredPost, organizationId: string, integrationId: string) {
  return (
    post.organizationId === organizationId &&
    post.integrationId === integrationId &&
    post.deletedAt === null &&
    (post.state === State.QUEUE || post.state === State.PUBLISHED) &&
    !!asDate(post.publishDate)
  );
}

function canonicalizeMediaPath(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value.trim()) return undefined;
  const path = value.trim();

  try {
    const url = new URL(path);
    if (url.protocol === 'http:' || url.protocol === 'https:') {
      return `${url.origin}${url.pathname}`;
    }
  } catch {
    // Treat non-URL values as local Postiz paths.
  }

  return path.split(/[?#]/, 1)[0].replace(/\\/g, '/');
}

function sameMediaItem(left: unknown, right: unknown): boolean {
  const leftItem = asRecord(left);
  const rightItem = asRecord(right);
  if (!leftItem || !rightItem) return false;

  const leftId = typeof leftItem.id === 'string' ? leftItem.id : undefined;
  const rightId = typeof rightItem.id === 'string' ? rightItem.id : undefined;
  if (leftId && rightId && leftId === rightId) return true;

  const leftPath = canonicalizeMediaPath(leftItem.path);
  const rightPath = canonicalizeMediaPath(rightItem.path);
  return !!leftPath && !!rightPath && leftPath === rightPath;
}

function sameMediaSequence(input: TikTokGuardMediaItem[], stored: unknown): boolean {
  if (!input.length || !Array.isArray(stored) || stored.length !== input.length) {
    return false;
  }

  return input.every((item, index) => sameMediaItem(item, stored[index]));
}

@Injectable()
export class TikTokPublishGuard {
  private readonly publishMutexes = new Map<string, Mutex>();

  constructor(private readonly prisma: PrismaService) {}

  async getPolicy(
    organizationId: string,
    integrationId: string
  ): Promise<TikTokPublishGuardPolicy> {
    const record = await this.prisma.snsAppSetting.findUnique({
      where: {
        organizationId_key: {
          organizationId,
          key: `${SETTINGS_KEY_PREFIX}${integrationId}`,
        },
      },
    });
    const value = asRecord(record?.value);

    return {
      duplicateWindowDays: inRangeInteger(
        value?.duplicateWindowDays,
        0,
        365,
        DEFAULT_DUPLICATE_WINDOW_DAYS
      ),
    };
  }

  async check(input: TikTokPublishGuardInput): Promise<TikTokPublishGuardResult> {
    const policy = await this.getPolicy(input.organizationId, input.integrationId);
    const now = input.now || new Date();
    const duplicateWindowStart = new Date(
      now.getTime() - policy.duplicateWindowDays * DAY_MS
    );

    if (policy.duplicateWindowDays > 0 && (input.media || []).length > 0) {
      const duplicatePosts = await this.findEligiblePosts(
        input,
        duplicateWindowStart,
        now
      );
      const duplicate = duplicatePosts
        .filter((post) =>
          isEligiblePost(post, input.organizationId, input.integrationId)
        )
        .filter((post) => asDate(post.publishDate)! >= duplicateWindowStart)
        .filter((post) => {
          const storedMedia = parseStoredJson(post.image);
          return sameMediaSequence(input.media || [], storedMedia);
        })
        .sort(
          (left, right) =>
            asDate(right.publishDate)!.getTime() - asDate(left.publishDate)!.getTime()
        )[0];

      if (duplicate) {
        const previousPublishDate = asDate(duplicate.publishDate)!;
        throw new ConflictException({
          code: 'TIKTOK_DUPLICATE_MEDIA',
          message:
            '同じメディアがこのTikTokアカウントへ再投稿禁止期間内に使用されています。',
          duplicateWindowDays: policy.duplicateWindowDays,
          matchedPostId: duplicate.id,
          previousPublishDate: previousPublishDate.toISOString(),
          nextAllowedAt: new Date(
            previousPublishDate.getTime() + policy.duplicateWindowDays * DAY_MS
          ).toISOString(),
        });
      }
    }

    return {
      duplicateWindowDays: policy.duplicateWindowDays,
      duplicateDetected: false,
    };
  }

  private async findEligiblePosts(
    input: TikTokPublishGuardInput,
    publishDateStart: Date,
    publishDateEnd: Date
  ): Promise<StoredPost[]> {
    return (await this.prisma.post.findMany({
      where: {
        organizationId: input.organizationId,
        integrationId: input.integrationId,
        deletedAt: null,
        state: { in: [State.QUEUE, State.PUBLISHED] },
        publishDate: {
          gte: publishDateStart,
          lte: publishDateEnd,
        },
      },
      select: {
        id: true,
        organizationId: true,
        integrationId: true,
        state: true,
        publishDate: true,
        deletedAt: true,
        image: true,
      },
    })) as StoredPost[];
  }

  withIntegrationLock<T>(
    organizationId: string,
    integrationId: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const key = JSON.stringify([organizationId, integrationId]);
    let mutex = this.publishMutexes.get(key);
    if (!mutex) {
      mutex = new Mutex();
      this.publishMutexes.set(key, mutex);
    }

    const activeMutex = mutex;
    return activeMutex.runExclusive(operation).finally(() => {
      if (!activeMutex.isLocked() && this.publishMutexes.get(key) === activeMutex) {
        this.publishMutexes.delete(key);
      }
    });
  }

  withIntegrationLocks<T>(
    organizationId: string,
    integrationIds: string[],
    operation: () => Promise<T>
  ): Promise<T> {
    const orderedIntegrationIds = Array.from(new Set(integrationIds)).sort();
    const acquire = (index: number): Promise<T> => {
      if (index >= orderedIntegrationIds.length) return operation();
      return this.withIntegrationLock(
        organizationId,
        orderedIntegrationIds[index],
        () => acquire(index + 1)
      );
    };

    return acquire(0);
  }
}
