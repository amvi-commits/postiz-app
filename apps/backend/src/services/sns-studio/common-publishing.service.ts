import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma, State } from '@prisma/client';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';

export type CommonAccountPolicy = {
  autoPostEnabled: boolean;
  approvalRequired: boolean;
  maxPostsPerDay: number | null;
  sameContentCooldownDays: number;
};

export type CommonPublishMode = 'draft' | 'now' | 'schedule';

export type CommonPolicyReasonCode =
  | 'approval_required'
  | 'posting_limit'
  | 'same_content_cooldown'
  | 'delivery_already_linked'
  | 'account_unavailable';

export type CommonPolicyReason = {
  code: CommonPolicyReasonCode;
  message: string;
};

export type CommonDeliveryDecision = {
  deliveryId: string;
  integrationId: string;
  providerIdentifier: string;
  accountName: string;
  deliveryStatus: string;
  approvedAt: Date | null;
  policy: CommonAccountPolicy;
  approvalRequired: boolean;
  allowed: boolean;
  decision: 'allowed' | 'blocked' | 'approval_required';
  reasons: CommonPolicyReason[];
};

const POLICY_KEY_PREFIX = 'sns:common:account-policy:v1:';
const DEFAULT_POLICY: CommonAccountPolicy = {
  autoPostEnabled: true,
  approvalRequired: false,
  maxPostsPerDay: null,
  sameContentCooldownDays: 0,
};
const DAY_MS = 24 * 60 * 60 * 1000;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function accountPolicyKey(integrationId: string) {
  return `${POLICY_KEY_PREFIX}${integrationId}`;
}

function normalizeStoredPolicy(value: unknown): CommonAccountPolicy {
  const record = asRecord(value) || {};
  return {
    autoPostEnabled:
      typeof record.autoPostEnabled === 'boolean'
        ? record.autoPostEnabled
        : DEFAULT_POLICY.autoPostEnabled,
    approvalRequired:
      typeof record.approvalRequired === 'boolean'
        ? record.approvalRequired
        : DEFAULT_POLICY.approvalRequired,
    maxPostsPerDay:
      record.maxPostsPerDay === null
        ? null
        : typeof record.maxPostsPerDay === 'number' &&
            Number.isInteger(record.maxPostsPerDay) &&
            record.maxPostsPerDay >= 1 &&
            record.maxPostsPerDay <= 100
          ? record.maxPostsPerDay
          : DEFAULT_POLICY.maxPostsPerDay,
    sameContentCooldownDays:
      typeof record.sameContentCooldownDays === 'number' &&
      Number.isInteger(record.sameContentCooldownDays) &&
      (record.sameContentCooldownDays as number) >= 0 &&
      (record.sameContentCooldownDays as number) <= 365
        ? (record.sameContentCooldownDays as number)
        : DEFAULT_POLICY.sameContentCooldownDays,
  };
}

@Injectable()
export class CommonPublishingService {
  constructor(private readonly prisma: PrismaService) {}

  async listAccountPolicies(organizationId: string) {
    const integrations = await this.prisma.integration.findMany({
      where: { organizationId, deletedAt: null },
      select: {
        id: true,
        name: true,
        profile: true,
        providerIdentifier: true,
        disabled: true,
      },
      orderBy: [{ providerIdentifier: 'asc' }, { name: 'asc' }],
    });
    if (!integrations.length) return [];

    const settings = await this.prisma.snsAppSetting.findMany({
      where: {
        organizationId,
        key: { in: integrations.map(({ id }) => accountPolicyKey(id)) },
      },
      select: { key: true, value: true },
    });
    const policyByKey = new Map(settings.map((item) => [item.key, item.value]));

    return integrations.map((integration) => ({
      integrationId: integration.id,
      accountName: integration.profile || integration.name,
      providerIdentifier: integration.providerIdentifier,
      disabled: integration.disabled,
      policy: normalizeStoredPolicy(
        policyByKey.get(accountPolicyKey(integration.id))
      ),
    }));
  }

  async updateAccountPolicy(
    organizationId: string,
    integrationId: string,
    input: unknown
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organizationId, deletedAt: null },
      select: {
        id: true,
        name: true,
        profile: true,
        providerIdentifier: true,
        disabled: true,
      },
    });
    if (!integration) {
      throw new NotFoundException({ code: 'COMMON_ACCOUNT_NOT_FOUND' });
    }

    const values = asRecord(input);
    if (!values) {
      throw new BadRequestException({ code: 'COMMON_ACCOUNT_POLICY_INVALID' });
    }

    const key = accountPolicyKey(integrationId);
    const currentSetting = await this.prisma.snsAppSetting.findUnique({
      where: { organizationId_key: { organizationId, key } },
      select: { value: true },
    });
    const current = normalizeStoredPolicy(currentSetting?.value);
    const next: CommonAccountPolicy = { ...current };

    if (values.autoPostEnabled !== undefined) {
      if (typeof values.autoPostEnabled !== 'boolean') {
        throw new BadRequestException({ code: 'COMMON_ACCOUNT_POLICY_INVALID' });
      }
      next.autoPostEnabled = values.autoPostEnabled;
    }
    if (values.approvalRequired !== undefined) {
      if (typeof values.approvalRequired !== 'boolean') {
        throw new BadRequestException({ code: 'COMMON_ACCOUNT_POLICY_INVALID' });
      }
      next.approvalRequired = values.approvalRequired;
    }
    if (values.maxPostsPerDay !== undefined) {
      const limit = values.maxPostsPerDay;
      if (
        limit !== null &&
        (typeof limit !== 'number' ||
          !Number.isInteger(limit) ||
          limit < 1 ||
          limit > 100)
      ) {
        throw new BadRequestException({ code: 'COMMON_ACCOUNT_POLICY_INVALID' });
      }
      next.maxPostsPerDay = limit as number | null;
    }
    if (values.sameContentCooldownDays !== undefined) {
      const days = values.sameContentCooldownDays;
      if (
        typeof days !== 'number' ||
        !Number.isInteger(days) ||
        days < 0 ||
        days > 365
      ) {
        throw new BadRequestException({ code: 'COMMON_ACCOUNT_POLICY_INVALID' });
      }
      next.sameContentCooldownDays = days as number;
    }

    await this.prisma.snsAppSetting.upsert({
      where: { organizationId_key: { organizationId, key } },
      create: { organizationId, key, value: next as Prisma.InputJsonValue },
      update: { value: next as Prisma.InputJsonValue },
    });

    return {
      integrationId: integration.id,
      accountName: integration.profile || integration.name,
      providerIdentifier: integration.providerIdentifier,
      disabled: integration.disabled,
      policy: next,
    };
  }

  async evaluateContentPlan(
    organizationId: string,
    contentId: string,
    integrationIds?: string[],
    mode: CommonPublishMode = 'schedule',
    now = new Date()
  ) {
    const plan = await this.prisma.snsContent.findFirst({
      where: { id: contentId, organizationId },
      include: {
        variants: { select: { id: true, mediaAssetId: true } },
        deliveries: {
          orderBy: { createdAt: 'asc' },
          select: {
            id: true,
            contentId: true,
            variantId: true,
            integrationId: true,
            providerIdentifier: true,
            accountName: true,
            status: true,
            postId: true,
            approvedAt: true,
          },
        },
      },
    });
    if (!plan) throw new NotFoundException({ code: 'CONTENT_PLAN_NOT_FOUND' });

    const requestedIds =
      integrationIds !== undefined
        ? Array.from(new Set(integrationIds))
        : plan.deliveries.map(({ integrationId }) => integrationId);
    if (!requestedIds.length) {
      throw new BadRequestException({ code: 'COMMON_DELIVERIES_REQUIRED' });
    }

    const deliveryByIntegration = new Map(
      plan.deliveries.map((delivery) => [delivery.integrationId, delivery])
    );
    if (requestedIds.some((id) => !deliveryByIntegration.has(id))) {
      throw new BadRequestException({ code: 'COMMON_DELIVERY_ACCOUNT_MISMATCH' });
    }

    const integrations = await this.prisma.integration.findMany({
      where: {
        id: { in: requestedIds },
        organizationId,
        deletedAt: null,
      },
      select: {
        id: true,
        name: true,
        profile: true,
        providerIdentifier: true,
        disabled: true,
      },
    });
    if (integrations.length !== requestedIds.length) {
      throw new BadRequestException({ code: 'CONTENT_DELIVERY_ACCOUNT_INVALID' });
    }
    const integrationById = new Map(integrations.map((item) => [item.id, item]));

    const settings = await this.prisma.snsAppSetting.findMany({
      where: {
        organizationId,
        key: { in: requestedIds.map(accountPolicyKey) },
      },
      select: { key: true, value: true },
    });
    const settingsByKey = new Map(settings.map((setting) => [setting.key, setting.value]));

    const decisions: CommonDeliveryDecision[] = [];
    for (const integrationId of requestedIds) {
      const delivery = deliveryByIntegration.get(integrationId)!;
      const integration = integrationById.get(integrationId)!;
      const policy = normalizeStoredPolicy(
        settingsByKey.get(accountPolicyKey(integrationId))
      );
      const requiresApproval =
        policy.approvalRequired || !policy.autoPostEnabled;
      const reasons: CommonPolicyReason[] = [];

      if (integration.disabled) {
        reasons.push({
          code: 'account_unavailable',
          message: 'この配信アカウントは無効です。再接続後に投稿してください。',
        });
      }
      if (delivery.postId || delivery.status !== 'PLANNED') {
        reasons.push({
          code: 'delivery_already_linked',
          message: 'この配信先はすでにPostizへ登録済みです。投稿履歴を確認してください。',
        });
      }

      if (mode !== 'draft' && !delivery.postId && delivery.status === 'PLANNED') {
        if (requiresApproval && !delivery.approvedAt) {
          reasons.push({
            code: 'approval_required',
            message: '投稿前にこの配信先を承認してください。',
          });
        }

        if (policy.maxPostsPerDay !== null) {
          const start = new Date(now.getTime() - DAY_MS);
          const recentPosts = await this.prisma.post.findMany({
            where: {
              organizationId,
              integrationId,
              deletedAt: null,
              state: { in: [State.QUEUE, State.PUBLISHED] },
              publishDate: { gte: start, lte: now },
            },
            select: { id: true },
          });
          if (recentPosts.length >= policy.maxPostsPerDay) {
            reasons.push({
              code: 'posting_limit',
              message: `このアカウントは直近24時間の投稿上限（${policy.maxPostsPerDay}件）に達しています。`,
            });
          }
        }

        if (policy.sameContentCooldownDays > 0) {
          const variantAssetId = plan.variants.find(
            ({ id }) => id === delivery.variantId
          )?.mediaAssetId;
          const contentAssetId = plan.originalAssetId || variantAssetId;
          if (
            contentAssetId &&
            (await this.hasRecentSameContentPost({
              organizationId,
              integrationId,
              contentId,
              contentAssetId,
              cooldownDays: policy.sameContentCooldownDays,
              now,
            }))
          ) {
            reasons.push({
              code: 'same_content_cooldown',
              message: `同じ元素材を使った投稿が再投稿禁止期間（${policy.sameContentCooldownDays}日）内にあります。`,
            });
          }
        }
      }

      const allowed = reasons.length === 0;
      const decision = allowed
        ? 'allowed'
        : reasons.every((reason) => reason.code === 'approval_required')
          ? 'approval_required'
          : 'blocked';
      decisions.push({
        deliveryId: delivery.id,
        integrationId,
        providerIdentifier: integration.providerIdentifier,
        accountName: integration.profile || integration.name || delivery.accountName || '',
        deliveryStatus: delivery.status,
        approvedAt: delivery.approvedAt,
        policy,
        approvalRequired: requiresApproval,
        allowed,
        decision,
        reasons,
      });
    }

    return { contentId, mode, checkedAt: now, deliveries: decisions };
  }

  async assertPlanAllowsPost(
    organizationId: string,
    contentId: string,
    mode: CommonPublishMode,
    posts: unknown
  ) {
    if (!Array.isArray(posts)) {
      throw new BadRequestException({ code: 'COMMON_POSTS_INVALID' });
    }
    const integrationIds = posts
      .map((item) => {
        const record = asRecord(item);
        const integration = asRecord(record?.integration);
        return typeof integration?.id === 'string' ? integration.id : '';
      })
      .filter(Boolean);
    if (!integrationIds.length) {
      throw new BadRequestException({ code: 'COMMON_DELIVERIES_REQUIRED' });
    }

    const evaluation = await this.evaluateContentPlan(
      organizationId,
      contentId,
      integrationIds,
      mode
    );
    const blocked = evaluation.deliveries.filter(({ allowed }) => !allowed);
    if (blocked.length) {
      const messages = blocked.flatMap((delivery) =>
        delivery.reasons.map(
          (reason) => `${delivery.accountName}: ${reason.message}`
        )
      );
      throw new ConflictException({
        code: 'COMMON_PUBLISH_POLICY_BLOCKED',
        message: messages.join(' '),
        blockedDeliveries: blocked,
      });
    }
    return evaluation;
  }

  async approveDelivery(
    organizationId: string,
    contentId: string,
    deliveryId: string
  ) {
    const plan = await this.prisma.snsContent.findFirst({
      where: { id: contentId, organizationId },
      include: { deliveries: true },
    });
    if (!plan) throw new NotFoundException({ code: 'CONTENT_PLAN_NOT_FOUND' });
    const delivery = plan.deliveries.find(({ id }) => id === deliveryId);
    if (!delivery) {
      throw new NotFoundException({ code: 'COMMON_DELIVERY_NOT_FOUND' });
    }
    if (delivery.postId || delivery.status !== 'PLANNED') {
      throw new ConflictException({ code: 'COMMON_DELIVERY_ALREADY_LINKED' });
    }

    return this.prisma.snsDelivery.update({
      where: { id: deliveryId },
      data: { approvedAt: new Date() },
    });
  }

  private async hasRecentSameContentPost(input: {
    organizationId: string;
    integrationId: string;
    contentId: string;
    contentAssetId: string;
    cooldownDays: number;
    now: Date;
  }) {
    const matchingContents = await this.prisma.snsContent.findMany({
      where: {
        organizationId: input.organizationId,
        id: { not: input.contentId },
        OR: [
          { originalAssetId: input.contentAssetId },
          { variants: { some: { mediaAssetId: input.contentAssetId } } },
        ],
      },
      select: { id: true },
    });
    if (!matchingContents.length) return false;

    const priorDeliveries = await this.prisma.snsDelivery.findMany({
      where: {
        integrationId: input.integrationId,
        contentId: { in: matchingContents.map(({ id }) => id) },
        postId: { not: null },
      },
      select: { postId: true },
    });
    const postIds = priorDeliveries
      .map(({ postId }) => postId)
      .filter((id): id is string => !!id);
    if (!postIds.length) return false;

    const cooldownStart = new Date(
      input.now.getTime() - input.cooldownDays * DAY_MS
    );
    const recentPosts = await this.prisma.post.findMany({
      where: {
        id: { in: postIds },
        organizationId: input.organizationId,
        integrationId: input.integrationId,
        deletedAt: null,
        state: { in: [State.QUEUE, State.PUBLISHED] },
        publishDate: { gte: cooldownStart, lte: input.now },
      },
      select: { id: true },
      take: 1,
    });
    return recentPosts.length > 0;
  }
}
