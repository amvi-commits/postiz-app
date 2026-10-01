import {
  ConflictException,
  HttpException,
  HttpStatus,
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
  dailyPostLimit: number;
  postsInLast24Hours: number;
  remaining: number;
  duplicateWindowDays: number;
  duplicateDetected: false;
}

export interface TikTokPublishGuardInput {
  organizationId: string;
  integrationId: string;
  settings?: Record<string, unknown>;
  media?: TikTokGuardMediaItem[];
  now?: Date;
}

export interface TikTokPublishGuardPolicy {
  dailyPostLimit: number;
  duplicateWindowDays: number;
}

type StoredPost = {
  id: string;
  organizationId: string;
  integrationId: string;
  state: State;
  publishDate: Date;
  deletedAt: Date | null;
  settings: string | null;
  image: string | null;
};

const DAY_MS = 24 * 60 * 60 * 1000;
const DEFAULT_DAILY_POST_LIMIT = 2;
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

function isDirectPost(post: StoredPost): boolean {
  const settings = asRecord(parseStoredJson(post.settings));
  const method = settings?.content_posting_method;
  // Existing posts without a method used Postiz's DIRECT_POST behavior.
  // Malformed JSON is handled the same way so old rows cannot break publishing.
  return method === undefined || method === null || method === '' || method === 'DIRECT_POST';
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
      dailyPostLimit: inRangeInteger(
        value?.dailyPostLimit,
        1,
        100,
        DEFAULT_DAILY_POST_LIMIT
      ),
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
    const dailyWindowStart = new Date(now.getTime() - DAY_MS);
    const duplicateWindowStart = new Date(
      now.getTime() - policy.duplicateWindowDays * DAY_MS
    );
    const posts = await this.findEligiblePosts(input, dailyWindowStart);

    const eligiblePosts = posts.filter((post) =>
      isEligiblePost(post, input.organizationId, input.integrationId)
    );
    const recentDirectPosts = eligiblePosts.filter((post) => {
      const publishDate = asDate(post.publishDate)!;
      return publishDate >= dailyWindowStart && isDirectPost(post);
    });
    const remaining = Math.max(0, policy.dailyPostLimit - recentDirectPosts.length);
    const candidateMethod = input.settings?.content_posting_method;
    const candidateIsDirectPost =
      candidateMethod === undefined ||
      candidateMethod === null ||
      candidateMethod === '' ||
      candidateMethod === 'DIRECT_POST';

    if (candidateIsDirectPost && recentDirectPosts.length >= policy.dailyPostLimit) {
      const oldestPost = recentDirectPosts.reduce((oldest, post) =>
        asDate(post.publishDate)!.getTime() < asDate(oldest.publishDate)!.getTime()
          ? post
          : oldest
      );
      const nextAllowedAt = new Date(
        asDate(oldestPost.publishDate)!.getTime() + DAY_MS
      ).toISOString();

      throw new HttpException(
        {
          code: 'TIKTOK_DAILY_LIMIT_REACHED',
          message: 'このTikTokアカウントは直近24時間の投稿上限に達しています。',
          dailyPostLimit: policy.dailyPostLimit,
          used: recentDirectPosts.length,
          remaining,
          windowHours: 24,
          nextAllowedAt,
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    if (policy.duplicateWindowDays > 0 && (input.media || []).length > 0) {
      const duplicatePosts = await this.findEligiblePosts(
        input,
        duplicateWindowStart
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
      dailyPostLimit: policy.dailyPostLimit,
      postsInLast24Hours: recentDirectPosts.length,
      remaining,
      duplicateWindowDays: policy.duplicateWindowDays,
      duplicateDetected: false,
    };
  }

  private async findEligiblePosts(
    input: TikTokPublishGuardInput,
    publishDateStart: Date
  ): Promise<StoredPost[]> {
    return (await this.prisma.post.findMany({
      where: {
        organizationId: input.organizationId,
        integrationId: input.integrationId,
        deletedAt: null,
        state: { in: [State.QUEUE, State.PUBLISHED] },
        publishDate: { gte: publishDateStart },
      },
      select: {
        id: true,
        organizationId: true,
        integrationId: true,
        state: true,
        publishDate: true,
        deletedAt: true,
        settings: true,
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
}
