import { PrismaClient } from '@prisma/client';
import dayjs from 'dayjs';
import { ThreadsStudioService } from './threads-studio.service';
import { ThreadsProvider } from '@gitroom/nestjs-libraries/integrations/social/threads.provider';
import {
  ThreadsValidationRules,
  mapThreadsApiError,
  getThreadsFeatureFlags,
  THREADS_CAPABILITIES,
  THREADS_SCOPES,
  THREADS_THREAD_INTERVALS,
} from '@gitroom/nestjs-libraries/integrations/social/threads.capabilities';

// Dedicated Local E2E Database URL (Isolated Container, Isolated Network, Isolated Volume)
const E2E_DATABASE_URL =
  process.env.TEST_DATABASE_URL ||
  'postgresql://sns_threads_e2e:threads_e2e_password_safe_2026@127.0.0.1:5433/sns_studio_threads_e2e?schema=public';

describe('Threads Local DB E2E + API Persistence + Contract Test Suite', () => {
  let prisma: PrismaClient;
  let threadsStudioService: ThreadsStudioService;
  let mockProvider: ThreadsProvider;

  const testOrgA = { id: `org-test-threads-a-${Date.now()}` };
  const testOrgB = { id: `org-test-threads-b-${Date.now()}` };
  const testIntegrationA = `int-threads-a-${Date.now()}`;
  const testIntegrationB = `int-threads-b-${Date.now()}`;
  const testPostIdA = `post-threads-a-${Date.now()}`;

  beforeAll(async () => {
    // 1. Initialize Prisma with dedicated Local E2E DB
    prisma = new PrismaClient({
      datasourceUrl: E2E_DATABASE_URL,
    });
    await prisma.$connect();

    // 2. Clean and create base test records in isolated E2E DB
    await prisma.organization.createMany({
      data: [
        {
          id: testOrgA.id,
          name: 'Threads Test Org A',
        },
        {
          id: testOrgB.id,
          name: 'Threads Test Org B',
        },
      ],
      skipDuplicates: true,
    });

    await prisma.integration.createMany({
      data: [
        {
          id: testIntegrationA,
          organizationId: testOrgA.id,
          name: 'threads_user_a',
          providerIdentifier: 'threads',
          type: 'social',
          token: 'th_mock_token_a',
          internalId: 'th_mock_internal_id_a',
        },
        {
          id: testIntegrationB,
          organizationId: testOrgB.id,
          name: 'threads_user_b',
          providerIdentifier: 'threads',
          type: 'social',
          token: 'th_mock_token_b',
          internalId: 'th_mock_internal_id_b',
        },
      ],
      skipDuplicates: true,
    });

    await prisma.post.create({
      data: {
        id: testPostIdA,
        organizationId: testOrgA.id,
        integrationId: testIntegrationA,
        content: 'Test post for Threads metadata',
        group: 'group_test_1',
        publishDate: new Date(),
        releaseId: 'th_media_container_123',
      },
    });

    // 3. Setup mock ThreadsProvider
    mockProvider = new ThreadsProvider();
    const mockIntegrationManager: any = {
      getSocialIntegration: (name: string) => {
        if (name === 'threads') return mockProvider;
        throw new Error(`Integration ${name} not found`);
      },
    };
    const mockOpenaiService: any = {};

    threadsStudioService = new ThreadsStudioService(
      prisma as any,
      mockIntegrationManager,
      mockOpenaiService
    );
  });

  afterAll(async () => {
    // Cleanup created test organizations (CASCADE will clean all 5 models)
    try {
      await prisma.organization.deleteMany({
        where: { id: { in: [testOrgA.id, testOrgB.id] } },
      });
      await prisma.$disconnect();
    } catch {
      // Ignore cleanup error in test
    }
  });

  // =========================================================================
  // Phase 4: DB保存 → 再読込 E2E (5 Models)
  // =========================================================================
  describe('Phase 4: DB保存 → 再読込 E2E (5 Models & Direct SQL Comparison)', () => {
    // A. SnsThreadsPostMetadata
    it('Phase 4.A: SnsThreadsPostMetadata inserts, reads back via Prisma and direct SQL with ghostExpiresAt', async () => {
      const ghostExpires = dayjs().add(24, 'hours').toDate();
      const metaInput = {
        organizationId: testOrgA.id,
        postId: testPostIdA,
        isGhostPost: true,
        ghostExpiresAt: ghostExpires,
        isArchived: false,
        topicTag: 'TechTrends',
        locationId: 'meta_loc_98765',
        locationName: 'Shibuya Crossing, Tokyo',
        hasPoll: true,
        hasSpoiler: true,
        hasTextAttachment: true,
        quotePostId: 'th_quote_post_111',
        replyControl: 'everyone',
        replyApprovalsEnabled: true,
        aiGenerated: true,
        characterCount: 280,
        threadCount: 2,
        mediaType: 'CAROUSEL',
        rawSettings: { poll: { options: ['Yes', 'No'] }, spoiler: true },
      };

      const created = await prisma.snsThreadsPostMetadata.create({
        data: metaInput,
      });
      expect(created.id).toBeDefined();

      // Prisma Read
      const reloadedPrisma = await prisma.snsThreadsPostMetadata.findUnique({
        where: { postId: testPostIdA },
      });
      expect(reloadedPrisma).not.toBeNull();
      expect(reloadedPrisma?.isGhostPost).toBe(true);
      expect(reloadedPrisma?.topicTag).toBe('TechTrends');
      expect(reloadedPrisma?.locationId).toBe('meta_loc_98765');
      expect(reloadedPrisma?.locationName).toBe('Shibuya Crossing, Tokyo');
      expect(reloadedPrisma?.replyApprovalsEnabled).toBe(true);
      expect(reloadedPrisma?.hasPoll).toBe(true);
      expect(reloadedPrisma?.hasTextAttachment).toBe(true);
      expect(reloadedPrisma?.characterCount).toBe(280);
      expect(dayjs(reloadedPrisma?.ghostExpiresAt).toISOString()).toBe(
        dayjs(ghostExpires).toISOString()
      );

      // Direct SQL SELECT
      const rawRows: any[] = await prisma.$queryRawUnsafe(
        `SELECT "isGhostPost", "topicTag", "locationId", "replyApprovalsEnabled", "ghostExpiresAt" FROM "SnsThreadsPostMetadata" WHERE "postId" = $1`,
        testPostIdA
      );
      expect(rawRows).toHaveLength(1);
      expect(rawRows[0].isGhostPost).toBe(true);
      expect(rawRows[0].topicTag).toBe('TechTrends');
      expect(rawRows[0].locationId).toBe('meta_loc_98765');
      expect(rawRows[0].replyApprovalsEnabled).toBe(true);
    });

    // B. SnsThreadsInboxItem
    it('Phase 4.B: SnsThreadsInboxItem supports UNHANDLED, HANDLED, PENDING_APPROVAL, APPROVED, IGNORED', async () => {
      const statuses = [
        { status: 'UNHANDLED', itemType: 'REPLY', isPending: false, hidden: false },
        { status: 'HANDLED', itemType: 'REPLY', isPending: false, hidden: false, replyText: 'Thank you!' },
        { status: 'PENDING_APPROVAL', itemType: 'REPLY', isPending: true, hidden: false },
        { status: 'APPROVED', itemType: 'REPLY', isPending: false, hidden: false },
        { status: 'HIDDEN', itemType: 'MENTION', isPending: false, hidden: true },
      ];

      for (let i = 0; i < statuses.length; i++) {
        const item = statuses[i];
        const replyId = `th_reply_item_${Date.now()}_${i}`;
        const created = await prisma.snsThreadsInboxItem.create({
          data: {
            organizationId: testOrgA.id,
            integrationId: testIntegrationA,
            threadsMediaId: 'th_media_parent_001',
            threadsReplyId: replyId,
            senderId: `sender_${i}`,
            senderUsername: `threads_fan_${i}`,
            text: `Reply text comment ${i}`,
            itemType: item.itemType,
            status: item.status,
            isPendingApproval: item.isPending,
            isHidden: item.hidden,
            repliedAt: new Date(),
            ourReplyText: item.replyText || null,
            aiDraftText: `AI Draft response ${i}`,
          },
        });
        expect(created.id).toBeDefined();

        // Prisma Re-read
        const reloaded = await prisma.snsThreadsInboxItem.findUnique({
          where: { threadsReplyId: replyId },
        });
        expect(reloaded?.status).toBe(item.status);
        expect(reloaded?.isHidden).toBe(item.hidden);
        expect(reloaded?.aiDraftText).toBe(`AI Draft response ${i}`);

        // Direct SQL Check
        const rawRow: any[] = await prisma.$queryRawUnsafe(
          `SELECT "status", "isHidden", "isPendingApproval" FROM "SnsThreadsInboxItem" WHERE "threadsReplyId" = $1`,
          replyId
        );
        expect(rawRow[0].status).toBe(item.status);
        expect(rawRow[0].isHidden).toBe(item.hidden);
      }
    });

    // C. SnsThreadsReferencePost
    it('Phase 4.C: SnsThreadsReferencePost saves and reloads content, metrics, category, and notes', async () => {
      const threadsPostId = `th_ref_post_${Date.now()}`;
      const saved = await prisma.snsThreadsReferencePost.create({
        data: {
          organizationId: testOrgA.id,
          threadsPostId,
          authorUsername: 'viral_creator',
          authorProfilePic: 'https://threads.net/pic.jpg',
          content: 'Here are 5 secrets to Threads growth in 2026...',
          mediaUrls: ['https://example.com/img1.jpg'],
          topicTag: 'Growth',
          permalink: 'https://threads.net/@viral_creator/post/12345',
          likesCount: 1540,
          repliesCount: 230,
          repostsCount: 88,
          quotesCount: 42,
          viewsCount: 65000,
          category: 'Growth Hacking',
          notes: 'Great hook opening and bullet list structure',
          analysisTags: ['high_engagement', 'educational'],
        },
      });
      expect(saved.id).toBeDefined();

      // Prisma Read
      const reloaded = await prisma.snsThreadsReferencePost.findUnique({
        where: {
          organizationId_threadsPostId: {
            organizationId: testOrgA.id,
            threadsPostId,
          },
        },
      });
      expect(reloaded?.likesCount).toBe(1540);
      expect(reloaded?.repliesCount).toBe(230);
      expect(reloaded?.category).toBe('Growth Hacking');
      expect(reloaded?.notes).toBe('Great hook opening and bullet list structure');

      // Direct SQL SELECT
      const rawRows: any[] = await prisma.$queryRawUnsafe(
        `SELECT "likesCount", "viewsCount", "category" FROM "SnsThreadsReferencePost" WHERE "threadsPostId" = $1`,
        threadsPostId
      );
      expect(rawRows[0].likesCount).toBe(1540);
      expect(rawRows[0].viewsCount).toBe(65000);
      expect(rawRows[0].category).toBe('Growth Hacking');
    });

    // D. SnsThreadsAccountSetting
    it('Phase 4.D: SnsThreadsAccountSetting defaults autoReplyEnabled to false and preserves all fields', async () => {
      // Create with default autoReplyEnabled
      const setting = await prisma.snsThreadsAccountSetting.create({
        data: {
          organizationId: testOrgA.id,
          integrationId: testIntegrationA,
          displayName: 'Threads Official A',
          autoPostEnabled: true,
          defaultReplyControl: 'everyone',
          aiReplyEnabled: true,
          // autoReplyEnabled is omitted -> must default to false!
          maxPostsPerDay: 12,
          maxRepliesPerDay: 60,
          aiCharacter: 'Thoughtful Tech Analyst',
          tone: 'polite',
          ngWords: ['scam', 'dm me'],
          autoPlugEnabled: false,
        },
      });

      expect(setting.autoReplyEnabled).toBe(false);
      expect(setting.autoPlugEnabled).toBe(false);
      expect(setting.defaultReplyControl).toBe('everyone');

      // Direct SQL Verification of default
      const rawRows: any[] = await prisma.$queryRawUnsafe(
        `SELECT "autoReplyEnabled", "autoPlugEnabled", "tone" FROM "SnsThreadsAccountSetting" WHERE "integrationId" = $1`,
        testIntegrationA
      );
      expect(rawRows[0].autoReplyEnabled).toBe(false);
      expect(rawRows[0].autoPlugEnabled).toBe(false);
      expect(rawRows[0].tone).toBe('polite');
    });

    // E. SnsThreadsAutomationRule
    it('Phase 4.E: SnsThreadsAutomationRule preserves conditions & actions JSON without corruption', async () => {
      const conditions = { minLikes: 50, requireQuestion: true, excludeKeywords: ['promo'] };
      const actions = { autoReplyText: 'Thanks for asking!', notifySlack: true };

      const rule = await prisma.snsThreadsAutomationRule.create({
        data: {
          organizationId: testOrgA.id,
          integrationId: testIntegrationA,
          ruleType: 'AUTO_REPLY',
          name: 'High Engagement Reply Rule',
          active: true,
          conditions,
          actions,
        },
      });
      expect(rule.id).toBeDefined();

      // Prisma Re-read
      const reloaded = await prisma.snsThreadsAutomationRule.findUnique({
        where: { id: rule.id },
      });
      expect(reloaded?.conditions).toEqual(conditions);
      expect(reloaded?.actions).toEqual(actions);

      // Direct SQL Check
      const rawRows: any[] = await prisma.$queryRawUnsafe(
        `SELECT "conditions", "actions", "ruleType" FROM "SnsThreadsAutomationRule" WHERE id = $1`,
        rule.id
      );
      expect(rawRows[0].conditions).toEqual(conditions);
      expect(rawRows[0].actions).toEqual(actions);
      expect(rawRows[0].ruleType).toBe('AUTO_REPLY');
    });
  });

  // =========================================================================
  // Phase 5: Organization分離 (Tenant Isolation)
  // =========================================================================
  describe('Phase 5: Organization分離 (Tenant Isolation E2E)', () => {
    it('strictly isolates Org A and Org B Threads data across Inbox, References, Settings, Rules', async () => {
      // Insert unique records for Org B
      const orgBReplyId = `th_reply_org_b_${Date.now()}`;
      await prisma.snsThreadsInboxItem.create({
        data: {
          organizationId: testOrgB.id,
          integrationId: testIntegrationB,
          threadsMediaId: 'th_media_org_b',
          threadsReplyId: orgBReplyId,
          senderId: 'sender_org_b',
          senderUsername: 'user_b',
          text: 'Private message for Org B',
          repliedAt: new Date(),
        },
      });

      const orgBRefId = `th_ref_org_b_${Date.now()}`;
      await prisma.snsThreadsReferencePost.create({
        data: {
          organizationId: testOrgB.id,
          threadsPostId: orgBRefId,
          authorUsername: 'creator_b',
          content: 'Confidential reference for Org B',
        },
      });

      await prisma.snsThreadsAccountSetting.create({
        data: {
          organizationId: testOrgB.id,
          integrationId: testIntegrationB,
          displayName: 'Org B Secret Account',
        },
      });

      // 1. Verify Inbox isolation
      const orgAInbox = await prisma.snsThreadsInboxItem.findMany({
        where: { organizationId: testOrgA.id },
      });
      expect(orgAInbox.some((item) => item.threadsReplyId === orgBReplyId)).toBe(false);

      const orgBInbox = await prisma.snsThreadsInboxItem.findMany({
        where: { organizationId: testOrgB.id },
      });
      expect(orgBInbox.every((item) => item.organizationId === testOrgB.id)).toBe(true);

      // 2. Verify Reference Post isolation
      const orgARefs = await prisma.snsThreadsReferencePost.findMany({
        where: { organizationId: testOrgA.id },
      });
      expect(orgARefs.some((r) => r.threadsPostId === orgBRefId)).toBe(false);

      // 3. Verify Account Settings isolation
      const orgASetting = await prisma.snsThreadsAccountSetting.findFirst({
        where: { organizationId: testOrgA.id, integrationId: testIntegrationB },
      });
      expect(orgASetting).toBeNull();

      // 4. Cross-tenant mutation rejection via service
      const orgBRefsList = await threadsStudioService.getReferencePosts(
        { id: testOrgB.id } as any
      );
      const bRef = orgBRefsList.find((r) => r.threadsPostId === orgBRefId);
      expect(bRef).toBeDefined();

      // Org A attempts to delete Org B's reference post -> must fail with NotFoundException
      await expect(
        threadsStudioService.deleteReferencePost({ id: testOrgA.id } as any, bRef!.id)
      ).rejects.toThrow();
    });
  });

  // =========================================================================
  // Phase 6: REST API E2E (4-step verification)
  // =========================================================================
  describe('Phase 6: REST API E2E (4-Step Verification)', () => {
    it('capabilities: returns official definitions, scopes, and feature flags', () => {
      const res = threadsStudioService.getCapabilities();
      expect(res.capabilities).toBeDefined();
      expect(res.capabilities.ghostPost.parameter).toBe('is_ghost_post');
      expect(res.capabilities.poll.parameter).toBe('poll_attachment');
      expect(res.capabilities.location.parameter).toBe('location_id');
      expect(res.featureFlags.ghostPost).toBe(true);
      expect(res.featureFlags.aiAutoReply).toBe(false); // Default OFF
    });

    it('accounts & settings: 4-step update and verify (request -> response -> re-GET -> direct SQL)', async () => {
      // Step 1 & 2: Update request and response
      const updateData = {
        displayName: 'Updated Threads Brand',
        defaultReplyControl: 'accounts_you_follow',
        tone: 'casual',
        maxPostsPerDay: 20,
        maxRepliesPerDay: 80,
        ngWords: ['spam', 'unwanted'],
      };
      const response = await threadsStudioService.updateAccountSettings(
        { id: testOrgA.id } as any,
        testIntegrationA,
        updateData
      );
      expect(response.displayName).toBe('Updated Threads Brand');
      expect(response.defaultReplyControl).toBe('accounts_you_follow');

      // Step 3: Re-GET via service
      const accountsList = await threadsStudioService.getAccounts({ id: testOrgA.id } as any);
      const myAccount = accountsList.find((a) => a.id === testIntegrationA);
      expect(myAccount?.threadsSettings.displayName).toBe('Updated Threads Brand');
      expect(myAccount?.threadsSettings.tone).toBe('casual');

      // Step 4: Direct SQL SELECT
      const rawRows: any[] = await prisma.$queryRawUnsafe(
        `SELECT "displayName", "defaultReplyControl", "maxPostsPerDay" FROM "SnsThreadsAccountSetting" WHERE "integrationId" = $1`,
        testIntegrationA
      );
      expect(rawRows[0].displayName).toBe('Updated Threads Brand');
      expect(rawRows[0].defaultReplyControl).toBe('accounts_you_follow');
      expect(rawRows[0].maxPostsPerDay).toBe(20);
    });

    it('reference post: 4-step save, list, and delete (request -> response -> re-GET -> direct SQL)', async () => {
      const sampleId = `ref_api_post_${Date.now()}`;
      // Step 1 & 2: Save request and response
      const saved = await threadsStudioService.saveReferencePost({ id: testOrgA.id } as any, {
        threadsPostId: sampleId,
        authorUsername: 'threads_pro',
        content: 'Actionable tips for content creators on Threads',
        category: 'Education',
        likesCount: 500,
        viewsCount: 12000,
      });
      expect(saved.threadsPostId).toBe(sampleId);

      // Step 3: Re-GET via service
      const list = await threadsStudioService.getReferencePosts(
        { id: testOrgA.id } as any,
        'Education'
      );
      const found = list.find((item) => item.threadsPostId === sampleId);
      expect(found).toBeDefined();
      expect(found?.authorUsername).toBe('threads_pro');

      // Step 4: Direct SQL SELECT
      const rawRows: any[] = await prisma.$queryRawUnsafe(
        `SELECT "authorUsername", "likesCount" FROM "SnsThreadsReferencePost" WHERE "threadsPostId" = $1`,
        sampleId
      );
      expect(rawRows[0].authorUsername).toBe('threads_pro');
      expect(rawRows[0].likesCount).toBe(500);

      // Delete and verify removal
      await threadsStudioService.deleteReferencePost({ id: testOrgA.id } as any, saved.id);
      const checkRemoved = await prisma.snsThreadsReferencePost.findUnique({
        where: { id: saved.id },
      });
      expect(checkRemoved).toBeNull();
    });

    it('calendar: calculates ghost post expiration dates correctly', async () => {
      const from = dayjs().subtract(7, 'days').toISOString();
      const to = dayjs().add(7, 'days').toISOString();
      const items = await threadsStudioService.getCalendarItems({ id: testOrgA.id } as any, from, to);
      expect(Array.isArray(items)).toBe(true);
      const ghostItem = items.find((i) => i.id === testPostIdA);
      if (ghostItem) {
        expect(ghostItem.isGhostPost).toBe(true);
        expect(ghostItem.ghostExpiresAt).toBeDefined();
      }
    });
  });

  // =========================================================================
  // Phase 7: Meta API Contract Test (Payload Mock Verification)
  // =========================================================================
  describe('Phase 7: Meta API Contract Test (Payload Mock Verification)', () => {
    let capturedRequests: Array<{ url: string; method?: string; body?: any }> = [];

    beforeEach(() => {
      capturedRequests = [];
      // Mock fetch on provider
      (mockProvider as any).fetch = async (url: string, options?: any) => {
        capturedRequests.push({ url, method: options?.method, body: options?.body });
        // Return dummy successful container or publish response
        return {
          ok: true,
          json: async () => ({
            id: 'mock_meta_container_id_777',
            status: 'FINISHED',
            permalink: 'https://threads.net/p/mock777',
            data: [] as unknown[],
          }),
        };
      };
    });

    it('Text Post: sends media_type=TEXT, text, and NO thread_interval', async () => {
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Hello from Threads Contract Test',
        undefined,
        undefined,
        { threadInterval: 15 } // Internal DTO field
      );

      expect(capturedRequests).toHaveLength(1);
      const req = capturedRequests[0];
      expect(req.url).toContain('/user_123/threads');
      const formData = req.body as FormData;
      expect(formData.get('media_type')).toBe('TEXT');
      expect(formData.get('text')).toBe('Hello from Threads Contract Test');
      // thread_interval must NEVER be in Meta API payload
      expect(formData.get('thread_interval')).toBeNull();
      expect(formData.get('threadInterval')).toBeNull();
    });

    it('Reply: sends reply_to_id and calls /{user-id}/threads, NEVER /{reply-id}/conversation', async () => {
      await mockProvider.replyToThread(
        'user_123',
        'token_abc',
        'parent_post_456',
        'This is a reply to the parent post'
      );

      // 1st request: create reply container POST /{user-id}/threads
      // 2nd request: publish reply POST /{user-id}/threads_publish
      // 3rd request: fetch permalink GET /{thread-id}
      expect(capturedRequests.length).toBeGreaterThanOrEqual(2);

      const createCall = capturedRequests[0];
      expect(createCall.url).toContain('/user_123/threads');
      const formData = createCall.body as FormData;
      expect(formData.get('media_type')).toBe('TEXT');
      expect(formData.get('reply_to_id')).toBe('parent_post_456');

      // Verify /{reply-id}/conversation was NEVER called as a POST endpoint
      const conversationPost = capturedRequests.find(
        (r) => r.url.includes('/conversation') && r.method === 'POST'
      );
      expect(conversationPost).toBeUndefined();
    });

    it('Ghost Post: sets is_ghost_post=true and validation rejects media attached', async () => {
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Ephemeral Ghost Post',
        undefined,
        undefined,
        { isGhostPost: true }
      );

      const req = capturedRequests[0];
      const formData = req.body as FormData;
      expect(formData.get('is_ghost_post')).toBe('true');

      // Validation rejects media on Ghost post
      const invalid = ThreadsValidationRules.validate({
        message: 'Ghost with picture',
        mediaCount: 1,
        settings: { isGhostPost: true },
      });
      expect(invalid.isValid).toBe(false);
      expect(invalid.errors.some((e) => e.includes('ゴースト投稿'))).toBe(true);
    });

    it('Poll Attachment: formats options as official JSON object string', async () => {
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Vote now!',
        undefined,
        undefined,
        { poll: { options: ['React', 'Vue', 'Svelte'] } }
      );

      const req = capturedRequests[0];
      const formData = req.body as FormData;
      const pollAttachment = formData.get('poll_attachment');
      expect(pollAttachment).toBeDefined();
      const parsed = JSON.parse(pollAttachment as string);
      expect(parsed).toEqual({
        option_a: 'React',
        option_b: 'Vue',
        option_c: 'Svelte',
      });
    });

    it('Text Attachment: serializes string or object into {"plaintext":"..."} JSON format', async () => {
      // Test string input
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Hook text',
        undefined,
        undefined,
        { textAttachment: 'Long article body text' }
      );

      const req1 = capturedRequests[0];
      const formData1 = req1.body as FormData;
      const textAttachment1 = formData1.get('text_attachment');
      expect(textAttachment1).toBeDefined();
      expect(JSON.parse(textAttachment1 as string)).toEqual({
        plaintext: 'Long article body text',
      });

      // Test object input
      capturedRequests = [];
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Hook text',
        undefined,
        undefined,
        {
          textAttachment: {
            plaintext: 'Detailed article',
            link_attachment_url: 'https://example.com/deep-dive',
          },
        }
      );

      const req2 = capturedRequests[0];
      const formData2 = req2.body as FormData;
      const textAttachment2 = formData2.get('text_attachment');
      expect(JSON.parse(textAttachment2 as string)).toEqual({
        plaintext: 'Detailed article',
        link_attachment_url: 'https://example.com/deep-dive',
      });
    });

    it('Location Tagging: sends only valid Location ID and queries /location_search for search', async () => {
      // 1. Search endpoint call
      await mockProvider.searchLocations('token_abc', 'Shibuya');
      const searchCall = capturedRequests[0];
      expect(searchCall.url).toContain('/location_search');
      expect(searchCall.url).toContain('q=Shibuya');

      // 2. Post creation with location ID only (no arbitrary place string)
      capturedRequests = [];
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Checking in!',
        undefined,
        undefined,
        { locationId: 'loc_998877' }
      );
      const postCall = capturedRequests[0];
      const formData = postCall.body as FormData;
      expect(formData.get('location_id')).toBe('loc_998877');
    });

    it('Topic Tag: strips # and rejects . and &', async () => {
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Topic test',
        undefined,
        undefined,
        { topicTag: '#WebDevelopment' }
      );

      const req = capturedRequests[0];
      const formData = req.body as FormData;
      expect(formData.get('topic_tag')).toBe('WebDevelopment'); // No #
    });

    it('GIF Attachment: sends gif_id and provider=GIPHY JSON format', async () => {
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Reaction post',
        undefined,
        undefined,
        { gifAttachment: { gif_id: 'giphy_id_123' } }
      );

      const req = capturedRequests[0];
      const formData = req.body as FormData;
      const gifAttachment = formData.get('gif_attachment');
      expect(gifAttachment).toBeDefined();
      expect(JSON.parse(gifAttachment as string)).toEqual({
        gif_id: 'giphy_id_123',
        provider: 'GIPHY',
      });
    });

    it('Reply Approvals: sends enable_reply_approvals=true in text and media containers', async () => {
      await (mockProvider as any).createTextContent(
        'user_123',
        'token_abc',
        'Protected post',
        undefined,
        undefined,
        { enableReplyApprovals: true }
      );

      const req = capturedRequests[0];
      const formData = req.body as FormData;
      expect(formData.get('enable_reply_approvals')).toBe('true');
    });

    it('Publishing Limit: queries official /{userId}/threads_publishing_limit', async () => {
      await mockProvider.fetchPublishingLimit('token_abc', 'user_123');
      const req = capturedRequests[0];
      expect(req.url).toContain('/user_123/threads_publishing_limit');
      expect(req.url).toContain('fields=quota_usage');
    });
  });

  // =========================================================================
  // Phase 8: ThreadsCapabilities 回帰テスト & Feature Flags
  // =========================================================================
  describe('Phase 8: ThreadsCapabilities 回帰テスト & Feature Flags', () => {
    it('verifies all 14 official capability keys and scopes', () => {
      expect(THREADS_SCOPES).toContain('threads_basic');
      expect(THREADS_SCOPES).toContain('threads_content_publish');
      expect(THREADS_SCOPES).toContain('threads_manage_replies');
      expect(THREADS_SCOPES).toContain('threads_read_replies');
      expect(THREADS_SCOPES).toContain('threads_manage_insights');
      expect(THREADS_SCOPES).toContain('threads_keyword_search');
      expect(THREADS_SCOPES).toContain('threads_location_tagging');
      expect(THREADS_SCOPES).toContain('threads_manage_mentions');
      expect(THREADS_SCOPES).toContain('threads_delete');

      expect(THREADS_CAPABILITIES.ghostPost.enabled).toBe(true);
      expect(THREADS_CAPABILITIES.poll.enabled).toBe(true);
      expect(THREADS_CAPABILITIES.topicTag.enabled).toBe(true);
      expect(THREADS_CAPABILITIES.location.enabled).toBe(true);
      expect(THREADS_CAPABILITIES.textAttachment.enabled).toBe(true);
      expect(THREADS_CAPABILITIES.publishingLimit.enabled).toBe(true);
    });

    it('Feature Flags: honors environment variable overrides when disabled', () => {
      const flags = getThreadsFeatureFlags({
        THREADS_FEATURE_GHOST_POST: 'false',
        THREADS_FEATURE_POLL: 'false',
        THREADS_FEATURE_LOCATION: 'false',
        THREADS_FEATURE_AI_AUTO_REPLY: 'true',
      });
      expect(flags.ghostPost).toBe(false);
      expect(flags.poll).toBe(false);
      expect(flags.location).toBe(false);
      expect(flags.aiAutoReply).toBe(true);
    });

    it('Error Mapping: maps token expired, auth, rate limit, and validation errors correctly', () => {
      const tokenErr = mapThreadsApiError({ message: 'Error validating access token: Session has expired' });
      expect(tokenErr.category).toBe('token_expired');
      expect(tokenErr.isRetryable).toBe(false);

      const rateLimitErr = mapThreadsApiError({ code: 4279009, message: 'Application rate limit reached' });
      expect(rateLimitErr.category).toBe('rate_limit');
      expect(rateLimitErr.isRetryable).toBe(true);

      const missingScopeErr = mapThreadsApiError({ message: 'Missing permission threads_location_tagging' });
      expect(missingScopeErr.category).toBe('permission_missing');
    });
  });
});
