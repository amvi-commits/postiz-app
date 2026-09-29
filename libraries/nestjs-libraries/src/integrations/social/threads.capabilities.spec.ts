import {
  ThreadsValidationRules,
  mapThreadsApiError,
  THREADS_CAPABILITIES,
  THREADS_API_VERSION,
  THREADS_SCOPES,
  THREADS_THREAD_INTERVALS,
} from './threads.capabilities';

describe('Threads Capabilities & Validation Rules', () => {
  describe('Constants & Capabilities', () => {
    it('defines API version v1.0 and required official scopes', () => {
      expect(THREADS_API_VERSION).toBe('v1.0');
      expect(THREADS_SCOPES).toContain('threads_basic');
      expect(THREADS_SCOPES).toContain('threads_content_publish');
      expect(THREADS_SCOPES).toContain('threads_manage_replies');
      expect(THREADS_SCOPES).toContain('threads_read_replies');
      expect(THREADS_SCOPES).toContain('threads_manage_insights');
      expect(THREADS_SCOPES).toContain('threads_keyword_search');
    });

    it('has full capability definitions for official Threads features', () => {
      expect(THREADS_CAPABILITIES.ghostPost.parameter).toBe('is_ghost_post');
      expect(THREADS_CAPABILITIES.poll.parameter).toBe('poll_attachment');
      expect(THREADS_CAPABILITIES.topicTag.parameter).toBe('topic_tag');
      expect(THREADS_CAPABILITIES.mediaSpoiler.parameter).toBe('is_spoiler_media');
      expect(THREADS_CAPABILITIES.textSpoiler.parameter).toBe('text_entities');
      expect(THREADS_CAPABILITIES.textAttachment.parameter).toBe('text_attachment');
      expect(THREADS_CAPABILITIES.quotePost.parameter).toBe('quote_post_id');
      expect(THREADS_CAPABILITIES.replyControl.parameter).toBe('reply_control');
      expect(THREADS_CAPABILITIES.replyApproval.parameter).toBe('enable_reply_approvals');
    });

    it('supports defined thread intervals from immediate to 120 mins', () => {
      const values = THREADS_THREAD_INTERVALS.map((t) => t.value);
      expect(values).toEqual([0, 1, 2, 5, 10, 15, 30, 60, 120]);
    });
  });

  describe('ThreadsValidationRules', () => {
    it('validates a standard text post successfully', () => {
      const result = ThreadsValidationRules.validate({
        message: 'Hello Threads world!',
        mediaCount: 0,
        settings: {
          replyControl: 'everyone',
        },
      });
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects ghost post when media is attached (text-only constraint)', () => {
      const result = ThreadsValidationRules.validate({
        message: 'Ghost post with picture',
        mediaCount: 1,
        settings: {
          isGhostPost: true,
        },
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('ゴースト投稿') && e.includes('テキスト専用'))).toBe(true);
      expect(result.disabledFeatures.ghostPost).toBeDefined();
    });

    it('permits ghost post with reply approvals enabled per official Meta specs', () => {
      const result = ThreadsValidationRules.validate({
        message: 'Ghost post with reply approval',
        mediaCount: 0,
        settings: {
          isGhostPost: true,
          enableReplyApprovals: true,
        },
      });
      expect(result.isValid).toBe(true);
      expect(result.errors).toHaveLength(0);
    });

    it('rejects poll when media is attached (text-only constraint)', () => {
      const result = ThreadsValidationRules.validate({
        message: 'Poll with image',
        mediaCount: 1,
        settings: {
          poll: {
            options: ['Yes', 'No'],
          },
        },
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('投票（Poll）はテキスト専用'))).toBe(true);
    });

    it('rejects poll when combined with link attachment or text attachment', () => {
      const result = ThreadsValidationRules.validate({
        message: 'Poll with link',
        mediaCount: 0,
        settings: {
          poll: {
            options: ['Option 1', 'Option 2'],
          },
          linkAttachment: 'https://example.com',
        },
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.some((e) => e.includes('投票（Poll）とリンク添付'))).toBe(true);
    });

    it('validates poll option count between 2 and 4 and length <= 25', () => {
      const underOptions = ThreadsValidationRules.validate({
        message: 'Invalid poll',
        mediaCount: 0,
        settings: {
          poll: { options: ['Only One'] },
        },
      });
      expect(underOptions.isValid).toBe(false);
      expect(underOptions.errors.some((e) => e.includes('2個以上4個以下'))).toBe(true);

      const tooLongOption = ThreadsValidationRules.validate({
        message: 'Invalid option length',
        mediaCount: 0,
        settings: {
          poll: {
            options: ['Normal', 'This option is way too long because it exceeds twenty-five characters'],
          },
        },
      });
      expect(tooLongOption.isValid).toBe(false);
      expect(tooLongOption.errors.some((e) => e.includes('25文字以内で入力してください'))).toBe(true);
    });

    it('validates topic tag limits (max 50 chars, no periods or ampersands)', () => {
      const invalidTag = ThreadsValidationRules.validate({
        message: 'Topic tag test',
        mediaCount: 0,
        settings: {
          topicTag: 'tech.news&trends',
        },
      });
      expect(invalidTag.isValid).toBe(false);
      expect(invalidTag.errors.some((e) => e.includes('ピリオド') || e.includes('&'))).toBe(true);
    });

    it('validates text attachment up to 10,000 characters and handles both string and object', () => {
      const validStringAttachment = ThreadsValidationRules.validate({
        message: 'Intro hook',
        mediaCount: 0,
        settings: {
          textAttachment: 'A'.repeat(5000),
        },
      });
      expect(validStringAttachment.isValid).toBe(true);

      const validObjectAttachment = ThreadsValidationRules.validate({
        message: 'Intro hook',
        mediaCount: 0,
        settings: {
          textAttachment: {
            plaintext: 'Detailed explanation text',
            link_attachment_url: 'https://example.com/blog',
          },
        },
      });
      expect(validObjectAttachment.isValid).toBe(true);

      const tooLongAttachment = ThreadsValidationRules.validate({
        message: 'Intro hook',
        mediaCount: 0,
        settings: {
          textAttachment: 'B'.repeat(10001),
        },
      });
      expect(tooLongAttachment.isValid).toBe(false);
      expect(tooLongAttachment.errors.some((e) => e.includes('10,000文字'))).toBe(true);
    });
  });

  describe('mapThreadsApiError', () => {
    it('maps OAuth token errors to user-friendly Japanese reconnect message', () => {
      const mapped = mapThreadsApiError({
        code: 190,
        error_subcode: 463,
        message: 'Error validating access token: Session has expired',
      });
      expect(mapped.category).toBe('token_expired');
      expect(mapped.code).toBe('THREADS_TOKEN_EXPIRED');
      expect(mapped.suggestedAction).toContain('再連携');
      expect(mapped.userMessage).toContain('有効期限が切れました');
    });

    it('maps rate limit errors to rate_limit category', () => {
      const mapped = mapThreadsApiError({
        code: 4279009,
        message: 'Application rate limit reached',
      });
      expect(mapped.category).toBe('rate_limit');
      expect(mapped.isRetryable).toBe(true);
      expect(mapped.userMessage).toContain('利用制限');
    });

    it('maps text too long error to combination_invalid category', () => {
      const mapped = mapThreadsApiError({
        message: 'text must be at most 500 characters',
      });
      expect(mapped.category).toBe('combination_invalid');
      expect(mapped.userMessage).toContain('500文字');
    });
  });
});
