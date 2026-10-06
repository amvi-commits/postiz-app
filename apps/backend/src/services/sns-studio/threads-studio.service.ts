import {
  BadRequestException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Integration, Organization, Post, Prisma } from '@prisma/client';
import dayjs from 'dayjs';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { IntegrationManager } from '@gitroom/nestjs-libraries/integrations/integration.manager';
import { ThreadsProvider } from '@gitroom/nestjs-libraries/integrations/social/threads.provider';
import {
  DEFAULT_THREADS_FEATURE_FLAGS,
  getThreadsFeatureFlags,
  mapThreadsApiError,
  THREADS_CAPABILITIES,
  ThreadsSettingsData,
} from '@gitroom/nestjs-libraries/integrations/social/threads.capabilities';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';

@Injectable()
export class ThreadsStudioService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly integrationManager: IntegrationManager,
    private readonly openaiService: OpenaiService
  ) {}

  private getThreadsProvider(): ThreadsProvider {
    return this.integrationManager.getSocialIntegration('threads') as ThreadsProvider;
  }

  // 1. Capabilities & Feature Flags
  getCapabilities() {
    return {
      capabilities: THREADS_CAPABILITIES,
      featureFlags: getThreadsFeatureFlags(),
      timestamp: new Date().toISOString(),
    };
  }

  // 2. Accounts Management
  async getAccounts(org: Organization) {
    const integrations = await this.prisma.integration.findMany({
      where: {
        organizationId: org.id,
        providerIdentifier: 'threads',
        disabled: false,
      },
      select: {
        id: true,
        name: true,
        profile: true,
        picture: true,
        inBetweenSteps: true,
        refreshNeeded: true,
        createdAt: true,
        updatedAt: true,
      },
    });

    const settingsList = await this.prisma.snsThreadsAccountSetting.findMany({
      where: { organizationId: org.id },
    });
    const settingsMap = new Map(settingsList.map((s) => [s.integrationId, s]));

    return integrations.map((integration) => {
      const setting = settingsMap.get(integration.id);
      return {
        ...integration,
        threadsSettings: setting || {
          displayName: integration.name || integration.profile,
          autoPostEnabled: true,
          defaultReplyControl: 'everyone',
          aiReplyEnabled: true,
          autoReplyEnabled: false,
          maxPostsPerDay: 10,
          maxRepliesPerDay: 50,
          tone: 'polite',
          ngWords: [],
          autoPlugEnabled: false,
          autoPlugRules: null,
          autoReplyRules: null,
        },
      };
    });
  }

  async updateAccountSettings(
    org: Organization,
    integrationId: string,
    data: {
      displayName?: string;
      autoPostEnabled?: boolean;
      defaultReplyControl?: string;
      aiReplyEnabled?: boolean;
      autoReplyEnabled?: boolean;
      autoReplyRules?: any;
      maxPostsPerDay?: number;
      maxRepliesPerDay?: number;
      defaultPostTimes?: any;
      aiCharacter?: string;
      tone?: string;
      ngWords?: any;
      autoPlugEnabled?: boolean;
      autoPlugRules?: any;
    }
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organizationId: org.id, providerIdentifier: 'threads' },
    });
    if (!integration) {
      throw new NotFoundException('Threads integration not found');
    }

    return this.prisma.snsThreadsAccountSetting.upsert({
      where: { integrationId },
      create: {
        organizationId: org.id,
        integrationId,
        displayName: data.displayName || integration.name,
        autoPostEnabled: data.autoPostEnabled ?? true,
        defaultReplyControl: data.defaultReplyControl || 'everyone',
        aiReplyEnabled: data.aiReplyEnabled ?? true,
        autoReplyEnabled: data.autoReplyEnabled ?? false,
        autoReplyRules: data.autoReplyRules ?? null,
        maxPostsPerDay: data.maxPostsPerDay ?? 10,
        maxRepliesPerDay: data.maxRepliesPerDay ?? 50,
        defaultPostTimes: data.defaultPostTimes ?? null,
        aiCharacter: data.aiCharacter ?? null,
        tone: data.tone ?? 'polite',
        ngWords: data.ngWords ?? [],
        autoPlugEnabled: data.autoPlugEnabled ?? false,
        autoPlugRules: data.autoPlugRules ?? null,
      },
      update: {
        ...(data.displayName !== undefined ? { displayName: data.displayName } : {}),
        ...(data.autoPostEnabled !== undefined ? { autoPostEnabled: data.autoPostEnabled } : {}),
        ...(data.defaultReplyControl !== undefined ? { defaultReplyControl: data.defaultReplyControl } : {}),
        ...(data.aiReplyEnabled !== undefined ? { aiReplyEnabled: data.aiReplyEnabled } : {}),
        ...(data.autoReplyEnabled !== undefined ? { autoReplyEnabled: data.autoReplyEnabled } : {}),
        ...(data.autoReplyRules !== undefined ? { autoReplyRules: data.autoReplyRules } : {}),
        ...(data.maxPostsPerDay !== undefined ? { maxPostsPerDay: data.maxPostsPerDay } : {}),
        ...(data.maxRepliesPerDay !== undefined ? { maxRepliesPerDay: data.maxRepliesPerDay } : {}),
        ...(data.defaultPostTimes !== undefined ? { defaultPostTimes: data.defaultPostTimes } : {}),
        ...(data.aiCharacter !== undefined ? { aiCharacter: data.aiCharacter } : {}),
        ...(data.tone !== undefined ? { tone: data.tone } : {}),
        ...(data.ngWords !== undefined ? { ngWords: data.ngWords } : {}),
        ...(data.autoPlugEnabled !== undefined ? { autoPlugEnabled: data.autoPlugEnabled } : {}),
        ...(data.autoPlugRules !== undefined ? { autoPlugRules: data.autoPlugRules } : {}),
      },
    });
  }

  // 3. Post Metadata & Ghost Post Expiration
  async recordPostMetadata(
    orgId: string,
    postId: string,
    settings: ThreadsSettingsData,
    publishedAt: Date = new Date(),
    mediaCount = 0,
    characterCount = 0,
    threadCount = 1
  ) {
    const isGhostPost = Boolean(settings.isGhostPost);
    const ghostExpiresAt = isGhostPost
      ? dayjs(publishedAt).add(24, 'hours').toDate()
      : null;

    let mediaType = 'NONE';
    if (mediaCount === 1) mediaType = 'IMAGE_OR_VIDEO';
    else if (mediaCount > 1) mediaType = 'CAROUSEL';

    return this.prisma.snsThreadsPostMetadata.upsert({
      where: { postId },
      create: {
        organizationId: orgId,
        postId,
        isGhostPost,
        ghostExpiresAt,
        isArchived: false,
        topicTag: settings.topicTag || null,
        locationId: settings.locationId || null,
        locationName: settings.locationName || null,
        hasPoll: Boolean(settings.poll?.options?.length),
        hasSpoiler: Boolean(settings.isSpoilerMedia || settings.textSpoilerRanges?.length),
        hasTextAttachment: Boolean(settings.textAttachment),
        quotePostId: settings.quotePostId || null,
        replyControl: settings.replyControl || 'everyone',
        replyApprovalsEnabled: Boolean(settings.enableReplyApprovals),
        characterCount,
        threadCount,
        mediaType,
        rawSettings: settings as any,
      },
      update: {
        isGhostPost,
        ghostExpiresAt,
        topicTag: settings.topicTag || null,
        locationId: settings.locationId || null,
        locationName: settings.locationName || null,
        hasPoll: Boolean(settings.poll?.options?.length),
        hasSpoiler: Boolean(settings.isSpoilerMedia || settings.textSpoilerRanges?.length),
        hasTextAttachment: Boolean(settings.textAttachment),
        quotePostId: settings.quotePostId || null,
        replyControl: settings.replyControl || 'everyone',
        replyApprovalsEnabled: Boolean(settings.enableReplyApprovals),
        characterCount,
        threadCount,
        mediaType,
        rawSettings: settings as any,
      },
    });
  }

  async checkAndArchiveExpiredGhostPosts(orgId: string) {
    const now = new Date();
    const expiredList = await this.prisma.snsThreadsPostMetadata.findMany({
      where: {
        organizationId: orgId,
        isGhostPost: true,
        isArchived: false,
        ghostExpiresAt: { lte: now },
      },
    });

    if (expiredList.length) {
      await this.prisma.snsThreadsPostMetadata.updateMany({
        where: {
          id: { in: expiredList.map((item) => item.id) },
        },
        data: { isArchived: true },
      });
    }

    return expiredList.length;
  }

  // 4. Multi-Account Inbox & Reply Approvals
  async syncInbox(org: Organization, targetIntegrationId?: string) {
    await this.checkAndArchiveExpiredGhostPosts(org.id);

    const integrations = await this.prisma.integration.findMany({
      where: {
        organizationId: org.id,
        providerIdentifier: 'threads',
        disabled: false,
        ...(targetIntegrationId ? { id: targetIntegrationId } : {}),
      },
    });

    const provider = this.getThreadsProvider();
    let totalSynced = 0;

    for (const integration of integrations) {
      try {
        const userThreadsRes = await provider.fetchUserThreads(integration.token, 15);
        const userThreads = userThreadsRes?.data || [];

        for (const thread of userThreads) {
          // Fetch conversation / replies
          try {
            const convRes = await provider.fetchConversation(integration.token, thread.id);
            const replies = convRes?.data || [];

            for (const reply of replies) {
              const replyId = String(reply.id);
              await this.prisma.snsThreadsInboxItem.upsert({
                where: { threadsReplyId: replyId },
                create: {
                  organizationId: org.id,
                  integrationId: integration.id,
                  threadsMediaId: thread.id,
                  threadsReplyId: replyId,
                  senderId: reply.from?.id || reply.username || 'unknown',
                  senderUsername: reply.username || reply.from?.username || 'user',
                  senderProfilePic: reply.from?.threads_profile_picture_url || null,
                  text: reply.text || '',
                  postSnippet: (thread.text || '').slice(0, 100),
                  itemType: 'REPLY',
                  status: reply.hide_status === 'HIDDEN' ? 'HIDDEN' : 'UNHANDLED',
                  isHidden: reply.hide_status === 'HIDDEN',
                  repliedAt: reply.timestamp ? new Date(reply.timestamp) : new Date(),
                },
                update: {
                  text: reply.text || '',
                  isHidden: reply.hide_status === 'HIDDEN',
                  status: reply.hide_status === 'HIDDEN' ? 'HIDDEN' : undefined,
                },
              });
              totalSynced++;
            }
          } catch (err) {
            console.error(`Failed to fetch conversation for thread ${thread.id}:`, err);
          }

          // Fetch pending approval replies if applicable
          try {
            const pendingRes = await provider.fetchPendingReplies(integration.token, thread.id);
            const pendingReplies = pendingRes?.data || [];

            for (const pending of pendingReplies) {
              const pendingId = String(pending.id);
              await this.prisma.snsThreadsInboxItem.upsert({
                where: { threadsReplyId: pendingId },
                create: {
                  organizationId: org.id,
                  integrationId: integration.id,
                  threadsMediaId: thread.id,
                  threadsReplyId: pendingId,
                  senderId: pending.from?.id || pending.username || 'unknown',
                  senderUsername: pending.username || pending.from?.username || 'user',
                  senderProfilePic: pending.from?.threads_profile_picture_url || null,
                  text: pending.text || '',
                  postSnippet: (thread.text || '').slice(0, 100),
                  itemType: 'REPLY',
                  status: 'PENDING_APPROVAL',
                  approvalStatus: 'PENDING',
                  isPendingApproval: true,
                  repliedAt: pending.timestamp ? new Date(pending.timestamp) : new Date(),
                },
                update: {
                  text: pending.text || '',
                  isPendingApproval: true,
                  approvalStatus: 'PENDING',
                  status: 'PENDING_APPROVAL',
                },
              });
              totalSynced++;
            }
          } catch (err) {
            // Not all threads have reply approvals enabled; ignore 400
          }
        }
      } catch (err) {
        console.error(`Failed to sync Threads inbox for integration ${integration.id}:`, err);
      }
    }

    return { totalSynced, accountsCount: integrations.length };
  }

  async getInboxItems(
    org: Organization,
    query: {
      integrationId?: string;
      status?: string;
      itemType?: string;
      page?: number;
      limit?: number;
    }
  ) {
    const page = Math.max(1, Number(query.page) || 1);
    const limit = Math.min(100, Math.max(1, Number(query.limit) || 30));
    const skip = (page - 1) * limit;

    const where: Prisma.SnsThreadsInboxItemWhereInput = {
      organizationId: org.id,
      ...(query.integrationId ? { integrationId: query.integrationId } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.itemType ? { itemType: query.itemType } : {}),
    };

    const [items, total, unhandledCount, pendingApprovalCount] =
      await Promise.all([
        this.prisma.snsThreadsInboxItem.findMany({
          where,
          orderBy: { repliedAt: 'desc' },
          skip,
          take: limit,
        }),
        this.prisma.snsThreadsInboxItem.count({ where }),
        this.prisma.snsThreadsInboxItem.count({
          where: { organizationId: org.id, status: 'UNHANDLED' },
        }),
        this.prisma.snsThreadsInboxItem.count({
          where: { organizationId: org.id, status: 'PENDING_APPROVAL' },
        }),
      ]);

    return {
      items,
      pagination: { total, page, limit, pages: Math.ceil(total / limit) },
      counts: {
        unhandled: unhandledCount,
        pendingApproval: pendingApprovalCount,
      },
    };
  }

  async replyToInboxItem(org: Organization, itemId: string, text: string) {
    const item = await this.prisma.snsThreadsInboxItem.findFirst({
      where: { id: itemId, organizationId: org.id },
    });
    if (!item) {
      throw new NotFoundException('Inbox item not found');
    }

    const integration = await this.prisma.integration.findFirst({
      where: { id: item.integrationId, organizationId: org.id },
    });
    if (!integration) {
      throw new NotFoundException('Associated integration not found');
    }

    const provider = this.getThreadsProvider();
    try {
      const result = await provider.replyToThread(
        integration.internalId,
        integration.token,
        item.threadsReplyId,
        text
      );

      return this.prisma.snsThreadsInboxItem.update({
        where: { id: item.id },
        data: {
          ourReplyId: result.threadId,
          ourReplyText: text,
          status: 'HANDLED',
          handledAt: new Date(),
        },
      });
    } catch (err) {
      const mapped = mapThreadsApiError(err);
      throw new BadRequestException(
        `${mapped.userMessage} (${mapped.suggestedAction})`
      );
    }
  }

  async hideInboxItem(org: Organization, itemId: string, hide: boolean) {
    const item = await this.prisma.snsThreadsInboxItem.findFirst({
      where: { id: itemId, organizationId: org.id },
    });
    if (!item) throw new NotFoundException('Inbox item not found');

    const integration = await this.prisma.integration.findFirst({
      where: { id: item.integrationId, organizationId: org.id },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    const provider = this.getThreadsProvider();
    await provider.manageReply(integration.token, item.threadsReplyId, hide);

    return this.prisma.snsThreadsInboxItem.update({
      where: { id: item.id },
      data: {
        isHidden: hide,
        status: hide ? 'HIDDEN' : 'UNHANDLED',
      },
    });
  }

  async approvePendingReply(org: Organization, itemId: string, approve: boolean) {
    const item = await this.prisma.snsThreadsInboxItem.findFirst({
      where: { id: itemId, organizationId: org.id },
    });
    if (!item) throw new NotFoundException('Pending reply not found');

    const integration = await this.prisma.integration.findFirst({
      where: { id: item.integrationId, organizationId: org.id },
    });
    if (!integration) throw new NotFoundException('Integration not found');

    const provider = this.getThreadsProvider();
    await provider.managePendingReply(integration.token, item.threadsReplyId, approve);

    return this.prisma.snsThreadsInboxItem.update({
      where: { id: item.id },
      data: {
        approvalStatus: approve ? 'APPROVED' : 'IGNORED',
        isPendingApproval: false,
        status: approve ? 'HANDLED' : 'HIDDEN',
      },
    });
  }

  // 5. AI Reply Assistant
  async generateAiReplyDraft(
    org: Organization,
    params: {
      itemId?: string;
      replyText: string;
      postSnippet?: string;
      replierUsername?: string;
      tone?: 'polite' | 'casual' | 'concise';
      customPrompt?: string;
    }
  ) {
    const toneInstructions = {
      polite: '敬語で丁寧、感謝を込めた好印象な口調',
      casual: 'フレンドリーで親しみやすく、絵文字を交えたカジュアルな口調',
      concise: '要点だけを短く簡潔にまとめたスマートな口調（1〜2文程度）',
    };

    const toneText = toneInstructions[params.tone || 'polite'] || toneInstructions.polite;
    let draft = '';

    if (process.env.OPENAI_API_KEY) {
      try {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const res = await client.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            {
              role: 'system',
              content: `あなたはThreads運用のプロフェッショナルです。ユーザーからの返信・コメントに対する最適な返信案を作成してください。
文体: ${toneText}
追加指示: ${params.customPrompt || 'ユーザーとの良好なエンゲージメントを深めてください'}
返信案のテキストのみを出力してください（引用符や前置き・後書きは不要です）。`,
            },
            {
              role: 'user',
              content: `元投稿: ${params.postSnippet || 'なし'}
返信者: @${params.replierUsername || 'user'}
返信内容: ${params.replyText}`,
            },
          ],
          max_completion_tokens: 300,
        });
        draft = res.choices[0]?.message?.content?.trim() || '';
      } catch (err) {
        console.error('AI Reply generation error:', err);
      }
    }

    if (!draft) {
      // Fallback rule-based draft
      if (params.tone === 'concise') {
        draft = `@${params.replierUsername || ''} コメントありがとうございます！嬉しいです🙌`;
      } else if (params.tone === 'casual') {
        draft = `@${params.replierUsername || ''} コメントありがとうございます✨ めちゃくちゃ励みになります！また気軽に絡んでくださいね😊`;
      } else {
        draft = `@${params.replierUsername || ''} 素敵なコメントをいただきありがとうございます。大変励みになります。今後ともよろしくお願いいたします。`;
      }
    }

    if (params.itemId) {
      await this.prisma.snsThreadsInboxItem.update({
        where: { id: params.itemId },
        data: { aiDraftText: draft },
      });
    }

    return { draft };
  }

  // 6. Conditional AI Auto-Reply Engine
  async checkAndRunAutoReply(org: Organization, itemId: string) {
    const item = await this.prisma.snsThreadsInboxItem.findFirst({
      where: { id: itemId, organizationId: org.id },
    });
    if (!item) return { executed: false, reason: 'ITEM_NOT_FOUND' };

    const setting = await this.prisma.snsThreadsAccountSetting.findUnique({
      where: { integrationId: item.integrationId },
    });
    if (!setting || !setting.autoReplyEnabled) {
      return { executed: false, reason: 'AUTO_REPLY_DISABLED' };
    }

    // Rate limit check: replies today
    const startOfDay = dayjs().startOf('day').toDate();
    const todayRepliesCount = await this.prisma.snsThreadsInboxItem.count({
      where: {
        integrationId: item.integrationId,
        status: 'HANDLED',
        handledAt: { gte: startOfDay },
      },
    });

    if (todayRepliesCount >= setting.maxRepliesPerDay) {
      return { executed: false, reason: 'DAILY_LIMIT_REACHED' };
    }

    const rules = (setting.autoReplyRules as any) || {};
    const text = item.text.trim();

    // Check NG words
    const ngWords = Array.isArray(setting.ngWords) ? (setting.ngWords as string[]) : [];
    if (ngWords.some((ng) => text.includes(ng))) {
      return { executed: false, reason: 'NG_WORD_DETECTED' };
    }

    // Exclude URLs
    if (rules.excludeUrls && (text.includes('http://') || text.includes('https://') || text.includes('.com') || text.includes('.jp'))) {
      return { executed: false, reason: 'CONTAINS_URL' };
    }

    // Exclude users
    if (Array.isArray(rules.excludedUsers) && rules.excludedUsers.includes(item.senderUsername)) {
      return { executed: false, reason: 'USER_EXCLUDED' };
    }

    // Questions only
    if (rules.questionsOnly) {
      const isQuestion =
        text.includes('?') ||
        text.includes('？') ||
        text.includes('どう') ||
        text.includes('なぜ') ||
        text.includes('何') ||
        text.includes('どこ') ||
        text.includes('教えて');
      if (!isQuestion) {
        return { executed: false, reason: 'NOT_A_QUESTION' };
      }
    }

    // Specific keywords
    if (Array.isArray(rules.requiredKeywords) && rules.requiredKeywords.length > 0) {
      const hasKeyword = rules.requiredKeywords.some((kw: string) => text.includes(kw));
      if (!hasKeyword) {
        return { executed: false, reason: 'KEYWORD_MISMATCH' };
      }
    }

    // Generate draft
    const { draft } = await this.generateAiReplyDraft(org, {
      itemId: item.id,
      replyText: item.text,
      postSnippet: item.postSnippet || undefined,
      replierUsername: item.senderUsername,
      tone: (setting.tone as any) || 'polite',
      customPrompt: setting.aiCharacter || undefined,
    });

    if (!draft) {
      return { executed: false, reason: 'FAILED_TO_GENERATE_DRAFT' };
    }

    // Send reply
    const replyResult = await this.replyToInboxItem(org, item.id, draft);
    return { executed: true, reply: replyResult };
  }

  // 7. Threads Research & Reference Posts
  async searchThreads(
    org: Organization,
    integrationId: string,
    query: string,
    searchType: 'TOP' | 'RECENT' = 'RECENT',
    searchMode: 'KEYWORD' | 'TAG' = 'KEYWORD'
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organizationId: org.id, providerIdentifier: 'threads' },
    });
    if (!integration) throw new NotFoundException('Threads integration not found');

    const provider = this.getThreadsProvider();
    try {
      const res = await provider.keywordSearch(
        integration.token,
        query,
        searchType,
        searchMode
      );
      return res;
    } catch (err) {
      const mapped = mapThreadsApiError(err);
      throw new BadRequestException(`${mapped.userMessage} (${mapped.suggestedAction})`);
    }
  }

  async searchLocations(
    org: Organization,
    integrationId: string,
    query: string
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organizationId: org.id, providerIdentifier: 'threads' },
    });
    if (!integration) throw new NotFoundException('Threads integration not found');

    const provider = this.getThreadsProvider();
    try {
      const res = await provider.searchLocations(integration.token, query);
      return res;
    } catch (err) {
      const mapped = mapThreadsApiError(err);
      throw new BadRequestException(`${mapped.userMessage} (${mapped.suggestedAction})`);
    }
  }

  async getPublishingLimit(
    org: Organization,
    integrationId: string
  ) {
    const integration = await this.prisma.integration.findFirst({
      where: { id: integrationId, organizationId: org.id, providerIdentifier: 'threads' },
    });
    if (!integration) throw new NotFoundException('Threads integration not found');

    const provider = this.getThreadsProvider();
    try {
      const res = await provider.fetchPublishingLimit(
        integration.token,
        integration.internalId
      );
      return res;
    } catch (err) {
      const mapped = mapThreadsApiError(err);
      throw new BadRequestException(`${mapped.userMessage} (${mapped.suggestedAction})`);
    }
  }

  async saveReferencePost(
    org: Organization,
    data: {
      threadsPostId: string;
      authorUsername: string;
      authorProfilePic?: string;
      content: string;
      mediaUrls?: string[];
      topicTag?: string;
      permalink?: string;
      likesCount?: number;
      repliesCount?: number;
      repostsCount?: number;
      quotesCount?: number;
      viewsCount?: number;
      category?: string;
      notes?: string;
    }
  ) {
    return this.prisma.snsThreadsReferencePost.upsert({
      where: {
        organizationId_threadsPostId: {
          organizationId: org.id,
          threadsPostId: data.threadsPostId,
        },
      },
      create: {
        organizationId: org.id,
        threadsPostId: data.threadsPostId,
        authorUsername: data.authorUsername,
        authorProfilePic: data.authorProfilePic || null,
        content: data.content,
        mediaUrls: data.mediaUrls || [],
        topicTag: data.topicTag || null,
        permalink: data.permalink || null,
        likesCount: data.likesCount || 0,
        repliesCount: data.repliesCount || 0,
        repostsCount: data.repostsCount || 0,
        quotesCount: data.quotesCount || 0,
        viewsCount: data.viewsCount || 0,
        category: data.category || 'General',
        notes: data.notes || null,
      },
      update: {
        authorUsername: data.authorUsername,
        authorProfilePic: data.authorProfilePic || null,
        content: data.content,
        mediaUrls: data.mediaUrls || [],
        topicTag: data.topicTag || null,
        permalink: data.permalink || null,
        likesCount: data.likesCount || 0,
        repliesCount: data.repliesCount || 0,
        repostsCount: data.repostsCount || 0,
        quotesCount: data.quotesCount || 0,
        viewsCount: data.viewsCount || 0,
        category: data.category || 'General',
        notes: data.notes || null,
      },
    });
  }

  async getReferencePosts(org: Organization, category?: string) {
    return this.prisma.snsThreadsReferencePost.findMany({
      where: {
        organizationId: org.id,
        ...(category ? { category } : {}),
      },
      orderBy: { savedAt: 'desc' },
    });
  }

  async deleteReferencePost(org: Organization, id: string) {
    const post = await this.prisma.snsThreadsReferencePost.findFirst({
      where: { id, organizationId: org.id },
    });
    if (!post) throw new NotFoundException('Reference post not found');
    await this.prisma.snsThreadsReferencePost.delete({ where: { id } });
    return { success: true };
  }

  // 8. AI Post Generation for Threads
  async generateThreadsPost(
    org: Organization,
    params: {
      mode: 'standard' | 'short' | 'long' | 'thread' | 'ghost' | 'poll';
      topic: string;
      referencePostIds?: string[];
      tone?: string;
      topicTag?: string;
    }
  ) {
    let referencesContent = '';
    if (params.referencePostIds?.length) {
      const refPosts = await this.prisma.snsThreadsReferencePost.findMany({
        where: {
          id: { in: params.referencePostIds },
          organizationId: org.id,
        },
      });
      referencesContent = refPosts
        .map((p, idx) => `[参考投稿${idx + 1} (${p.authorUsername})]: ${p.content}`)
        .join('\n\n');
    }

    const modeGuides: Record<string, string> = {
      standard: '通常のThreads投稿（150〜300文字程度、共感と発見がある構成）',
      short: '短文で鋭いワンフレーズ・フック投稿（50〜100文字程度）',
      long: '長文解説型投稿（テキスト添付を活用した詳細なノウハウやストーリー、500文字以上）',
      thread: 'スレッド連投型（3〜4投稿の連投形式。1投稿目で引きつけ、2〜3で展開、最後でアクション誘導）',
      ghost: '24時間限定のゴースト投稿向け（今だけ共有するリアルタイムな裏話・本音・速報感、200文字以内）',
      poll: '2〜4つの選択肢による投票付き投稿（本文＋読者が回答したくなるアンケート選択肢）',
    };

    const guide = modeGuides[params.mode] || modeGuides.standard;

    if (process.env.OPENAI_API_KEY) {
      try {
        const OpenAI = (await import('openai')).default;
        const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
        const res = await client.chat.completions.create({
          model: 'gpt-4.1-mini',
          messages: [
            {
              role: 'system',
              content: `あなたはThreads運用のエキスパートです。Threadsに最適化されたバズる投稿を作成してください。
形式: ${guide}
トーン: ${params.tone || '親しみやすく知性的'}
トピックタグ指定: ${params.topicTag ? `#${params.topicTag}` : '自然なものを提案'}
${referencesContent ? `以下は過去に保存された参考投稿です。構成や切り口を参考にしてください（完全な丸コピーは厳禁）:\n${referencesContent}` : ''}
JSONフォーマットで回答してください:
{
  "content": "投稿本文（スレッドの場合は投稿1の本文）",
  "threadPosts": ["投稿2本文", "投稿3本文"], // スレッドモードの場合のみ
  "topicTag": "推奨トピックタグ（#なし）",
  "pollOptions": ["選択肢1", "選択肢2"] // 投票モードの場合のみ
}`,
          },
          {
            role: 'user',
            content: `テーマ: ${params.topic}`,
          },
        ],
        response_format: { type: 'json_object' },
      });

      const parsed = JSON.parse(res.choices[0]?.message?.content || '{}');
      return parsed;
      } catch (err) {
        console.error('Error generating Threads post via OpenAI:', err);
      }
    }

    // Fallback template
    return {
      content: `${params.topic}について皆さんはどう思いますか？\n\n最近Threadsで注目されているトピックですが、実践してみると新しい気づきがたくさんありました。\n\nぜひコメントでご意見教えてください！`,
      threadPosts: params.mode === 'thread' ? ['詳細な実践ステップはこちら👇', 'まとめとアクション'] : [],
      topicTag: params.topicTag || 'SNS運用',
      pollOptions: params.mode === 'poll' ? ['やってみたい', 'すでに実践中', 'あまり興味ない'] : undefined,
    };
  }

  // 9. Calendar Items with Ghost Post Expiration Status
  async getCalendarItems(org: Organization, from: string, to: string) {
    await this.checkAndArchiveExpiredGhostPosts(org.id);

    const fromDate = dayjs(from).startOf('day').toDate();
    const toDate = dayjs(to).endOf('day').toDate();

    const posts = await this.prisma.post.findMany({
      where: {
        organizationId: org.id,
        publishDate: { gte: fromDate, lte: toDate },
        integration: { providerIdentifier: 'threads' },
        deletedAt: null,
      },
      include: {
        integration: {
          select: { id: true, name: true, profile: true, picture: true },
        },
      },
    });

    const postIds = posts.map((p) => p.id);
    const metadataList = await this.prisma.snsThreadsPostMetadata.findMany({
      where: { postId: { in: postIds } },
    });
    const metaMap = new Map(metadataList.map((m) => [m.postId, m]));

    return posts.map((post) => {
      const meta = metaMap.get(post.id);
      const now = dayjs();
      let ghostStatus: 'ACTIVE' | 'ARCHIVED' | null = null;
      let remainingMinutes: number | null = null;

      if (meta?.isGhostPost) {
        if (meta.isArchived || (meta.ghostExpiresAt && now.isAfter(dayjs(meta.ghostExpiresAt)))) {
          ghostStatus = 'ARCHIVED';
          remainingMinutes = 0;
        } else if (meta.ghostExpiresAt) {
          ghostStatus = 'ACTIVE';
          remainingMinutes = Math.max(0, dayjs(meta.ghostExpiresAt).diff(now, 'minute'));
        }
      }

      return {
        id: post.id,
        state: post.state,
        publishDate: post.publishDate,
        content: post.content,
        group: post.group,
        releaseURL: post.releaseURL,
        integration: post.integration,
        isGhostPost: Boolean(meta?.isGhostPost),
        ghostStatus,
        remainingMinutes,
        ghostExpiresAt: meta?.ghostExpiresAt,
        topicTag: meta?.topicTag,
        hasPoll: meta?.hasPoll,
        hasSpoiler: meta?.hasSpoiler,
      };
    });
  }

  // 10. Multi-Dimensional Analytics Comparison
  async getThreadsAnalytics(
    org: Organization,
    query: { integrationId?: string; fromDate?: string; toDate?: string }
  ) {
    const from = query.fromDate ? dayjs(query.fromDate).toDate() : dayjs().subtract(30, 'day').toDate();
    const to = query.toDate ? dayjs(query.toDate).toDate() : dayjs().toDate();

    const posts = await this.prisma.post.findMany({
      where: {
        organizationId: org.id,
        publishDate: { gte: from, lte: to },
        integration: {
          providerIdentifier: 'threads',
          ...(query.integrationId ? { id: query.integrationId } : {}),
        },
        state: 'PUBLISHED',
      },
      include: {
        integration: { select: { id: true, name: true, profile: true } },
      },
    });

    const postIds = posts.map((p) => p.id);
    const metadataList = await this.prisma.snsThreadsPostMetadata.findMany({
      where: { postId: { in: postIds } },
    });
    const metaMap = new Map(metadataList.map((m) => [m.postId, m]));

    // Fetch insights from Threads API for live posts if token available
    const provider = this.getThreadsProvider();
    const metricsByPost = new Map<string, Record<string, number>>();

    for (const post of posts.slice(0, 20)) {
      if (post.releaseId) {
        try {
          const integration = await this.prisma.integration.findUnique({
            where: { id: post.integrationId },
          });
          if (integration?.token) {
            const insights = await provider.postAnalytics(
              integration.id,
              integration.token,
              post.releaseId,
              30
            );
            const data: Record<string, number> = {};
            for (const item of insights) {
              const val = Number(item.data?.[0]?.total || 0);
              data[item.label.toLowerCase()] = val;
            }
            metricsByPost.set(post.id, data);
          }
        } catch {
          // ignore individual analytics fetch error
        }
      }
    }

    // Aggregate by dimensions
    const ghostComparison = {
      ghost: { count: 0, views: 0, likes: 0, replies: 0 },
      regular: { count: 0, views: 0, likes: 0, replies: 0 },
    };

    const mediaComparison: Record<string, { count: number; views: number; likes: number }> = {
      NONE: { count: 0, views: 0, likes: 0 },
      IMAGE_OR_VIDEO: { count: 0, views: 0, likes: 0 },
      CAROUSEL: { count: 0, views: 0, likes: 0 },
    };

    const specialFeatures = {
      withPoll: { count: 0, likes: 0 },
      withSpoiler: { count: 0, likes: 0 },
      withTopicTag: { count: 0, likes: 0 },
      withTextAttachment: { count: 0, likes: 0 },
    };

    for (const post of posts) {
      const meta = metaMap.get(post.id);
      const metrics = metricsByPost.get(post.id) || { views: 0, likes: 0, replies: 0 };

      // Ghost comparison
      if (meta?.isGhostPost) {
        ghostComparison.ghost.count++;
        ghostComparison.ghost.views += metrics.views || 0;
        ghostComparison.ghost.likes += metrics.likes || 0;
        ghostComparison.ghost.replies += metrics.replies || 0;
      } else {
        ghostComparison.regular.count++;
        ghostComparison.regular.views += metrics.views || 0;
        ghostComparison.regular.likes += metrics.likes || 0;
        ghostComparison.regular.replies += metrics.replies || 0;
      }

      // Media comparison
      const mType = meta?.mediaType || 'NONE';
      if (!mediaComparison[mType]) {
        mediaComparison[mType] = { count: 0, views: 0, likes: 0 };
      }
      mediaComparison[mType].count++;
      mediaComparison[mType].views += metrics.views || 0;
      mediaComparison[mType].likes += metrics.likes || 0;

      // Special features
      if (meta?.hasPoll) {
        specialFeatures.withPoll.count++;
        specialFeatures.withPoll.likes += metrics.likes || 0;
      }
      if (meta?.hasSpoiler) {
        specialFeatures.withSpoiler.count++;
        specialFeatures.withSpoiler.likes += metrics.likes || 0;
      }
      if (meta?.topicTag) {
        specialFeatures.withTopicTag.count++;
        specialFeatures.withTopicTag.likes += metrics.likes || 0;
      }
      if (meta?.hasTextAttachment) {
        specialFeatures.withTextAttachment.count++;
        specialFeatures.withTextAttachment.likes += metrics.likes || 0;
      }
    }

    return {
      totalPosts: posts.length,
      ghostComparison,
      mediaComparison,
      specialFeatures,
      metricsByPost: Object.fromEntries(metricsByPost),
    };
  }

  // 11. Auto Plug Checker
  async checkAndTriggerAutoPlug(org: Organization, postId: string) {
    const post = await this.prisma.post.findFirst({
      where: { id: postId, organizationId: org.id },
      include: { integration: true },
    });
    if (!post || !post.releaseId || !post.integration?.token) {
      return { triggered: false, reason: 'POST_NOT_FOUND_OR_NOT_PUBLISHED' };
    }

    const setting = await this.prisma.snsThreadsAccountSetting.findUnique({
      where: { integrationId: post.integrationId },
    });
    if (!setting || !setting.autoPlugEnabled || !setting.autoPlugRules) {
      return { triggered: false, reason: 'AUTO_PLUG_DISABLED' };
    }

    const rules = setting.autoPlugRules as any;
    const threshold = Number(rules.likesThreshold) || 100;
    const plugMessage = rules.message || '';

    if (!plugMessage) {
      return { triggered: false, reason: 'NO_PLUG_MESSAGE' };
    }

    const provider = this.getThreadsProvider();
    const insights = await provider.postAnalytics(
      post.integrationId,
      post.integration.token,
      post.releaseId,
      1
    );

    const likes = Number(insights.find((i) => i.label === 'Likes')?.data?.[0]?.total || 0);

    if (likes >= threshold) {
      // Check if already plugged
      const alreadyPlugged = await this.prisma.snsThreadsInboxItem.findFirst({
        where: {
          threadsMediaId: post.releaseId,
          text: plugMessage,
        },
      });

      if (alreadyPlugged) {
        return { triggered: false, reason: 'ALREADY_PLUGGED' };
      }

      const res = await provider.replyToThread(
        post.integration.internalId,
        post.integration.token,
        post.releaseId,
        plugMessage
      );

      return { triggered: true, plugThreadId: res.threadId };
    }

    return { triggered: false, currentLikes: likes, threshold };
  }

  // 13. Browser Transport Diagnostics & Verification
  async verifyBrowserTransport(
    dto?: {
      account?: string;
      text?: string;
      mediaUrls?: string[];
      isGhost?: boolean;
      checkHealth?: boolean;
      checkSession?: boolean;
      dryRunPost?: boolean;
    },
    org?: Organization
  ) {
    const provider = this.getThreadsProvider();
    return provider.verifyBrowserTransport(dto);
  }
}

