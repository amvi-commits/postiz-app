import { TikTokPublishGuard } from './tiktok-publish.guard';

const ORGANIZATION_ID = 'org_123';
const INTEGRATION_ID = 'tiktok_123';
const NOW = new Date('2026-10-02T12:00:00.000Z');

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: 'post_1',
    organizationId: ORGANIZATION_ID,
    integrationId: INTEGRATION_ID,
    state: 'PUBLISHED',
    publishDate: new Date(NOW.getTime() - 60 * 60 * 1000),
    deletedAt: null,
    settings: '{"content_posting_method":"DIRECT_POST"}',
    image: JSON.stringify([{ id: 'media_1', path: '/uploads/video.mp4' }]),
    ...overrides,
  };
}

function setup(settingValue?: unknown, posts: any[] = []) {
  const prisma: any = {
    snsAppSetting: {
      findUnique: jest.fn().mockResolvedValue(
        settingValue === undefined ? null : { value: settingValue }
      ),
    },
    post: {
      findMany: jest.fn().mockImplementation(({ where }: any) => {
        const publishDateRange = where.publishDate;
        return Promise.resolve(
          posts.filter((post) => {
            const publishDate = new Date(post.publishDate);
            return (
              publishDate >= publishDateRange.gte &&
              publishDate <= publishDateRange.lte
            );
          })
        );
      }),
    },
  };

  return { prisma, guard: new TikTokPublishGuard(prisma) };
}

function guardInput(overrides: Record<string, unknown> = {}) {
  return {
    organizationId: ORGANIZATION_ID,
    integrationId: INTEGRATION_ID,
    now: NOW,
    ...overrides,
  };
}

describe('TikTokPublishGuard', () => {
  describe('account settings', () => {
    it('uses dailyPostLimit=2 and duplicateWindowDays=30 by default', async () => {
      const { guard } = setup();

      await expect(guard.getPolicy(ORGANIZATION_ID, INTEGRATION_ID)).resolves.toEqual({
        dailyPostLimit: 2,
        duplicateWindowDays: 30,
      });
    });

    it('applies custom account settings', async () => {
      const { guard } = setup({ dailyPostLimit: 5, duplicateWindowDays: 60 });

      await expect(guard.getPolicy(ORGANIZATION_ID, INTEGRATION_ID)).resolves.toEqual({
        dailyPostLimit: 5,
        duplicateWindowDays: 60,
      });
    });

    it('falls back to defaults for invalid stored values', async () => {
      const { guard } = setup({
        dailyPostLimit: 1.5,
        duplicateWindowDays: 366,
      });

      await expect(guard.getPolicy(ORGANIZATION_ID, INTEGRATION_ID)).resolves.toEqual({
        dailyPostLimit: 2,
        duplicateWindowDays: 30,
      });
    });

    it('accepts duplicateWindowDays=0 as a complete duplicate-check disable', async () => {
      const { guard } = setup({ duplicateWindowDays: 0 });

      await expect(guard.getPolicy(ORGANIZATION_ID, INTEGRATION_ID)).resolves.toEqual({
        dailyPostLimit: 2,
        duplicateWindowDays: 0,
      });
    });

    it('reads settings from the integration-specific SnsAppSetting key', async () => {
      const { guard, prisma } = setup();

      await guard.getPolicy(ORGANIZATION_ID, INTEGRATION_ID);

      expect(prisma.snsAppSetting.findUnique).toHaveBeenCalledWith({
        where: {
          organizationId_key: {
            organizationId: ORGANIZATION_ID,
            key: `sns:tiktok:account:${INTEGRATION_ID}`,
          },
        },
      });
    });
  });

  describe('rolling 24-hour daily limit', () => {
    it('allows zero recent posts', async () => {
      const { guard } = setup();

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        dailyPostLimit: 2,
        postsInLast24Hours: 0,
        remaining: 2,
      });
    });

    it('allows one post when the default limit is two', async () => {
      const { guard } = setup(undefined, [makePost()]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 1,
        remaining: 1,
      });
    });

    it('blocks the third direct post and returns the oldest post expiry time', async () => {
      const oldestDate = new Date(NOW.getTime() - 20 * 60 * 60 * 1000);
      const nextDate = new Date(NOW.getTime() - 3 * 60 * 60 * 1000);
      const { guard } = setup(undefined, [
        makePost({ id: 'oldest', publishDate: oldestDate }),
        makePost({ id: 'newer', publishDate: nextDate }),
      ]);

      await expect(guard.check(guardInput())).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_DAILY_LIMIT_REACHED',
          dailyPostLimit: 2,
          used: 2,
          remaining: 0,
          windowHours: 24,
          nextAllowedAt: new Date(oldestDate.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        },
      });
    });

    it('returns HTTP 429 when the rolling daily limit is reached', async () => {
      const { guard } = setup(undefined, [makePost({ id: 'one' }), makePost({ id: 'two' })]);
      const error = await guard.check(guardInput()).catch((caught) => caught);

      expect(error.getStatus()).toBe(429);
      expect(error.getResponse()).toMatchObject({ code: 'TIKTOK_DAILY_LIMIT_REACHED' });
    });

    it('excludes posts older than the rolling 24-hour window', async () => {
      const { guard } = setup(undefined, [
        makePost({ publishDate: new Date(NOW.getTime() - 25 * 60 * 60 * 1000) }),
      ]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 0,
        remaining: 2,
      });
    });

    it('does not count future QUEUE rows as recent posts', async () => {
      const { guard } = setup(undefined, [
        makePost({
          state: 'QUEUE',
          publishDate: new Date(NOW.getTime() + 60 * 60 * 1000),
        }),
      ]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 0,
        remaining: 2,
      });
    });

    it('does not count future PUBLISHED fixtures as recent posts', async () => {
      const { guard } = setup(undefined, [
        makePost({
          state: 'PUBLISHED',
          publishDate: new Date(NOW.getTime() + 60 * 60 * 1000),
        }),
      ]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 0,
        remaining: 2,
      });
    });

    it('continues to count a past QUEUE row', async () => {
      const { guard } = setup(undefined, [
        makePost({
          state: 'QUEUE',
          publishDate: new Date(NOW.getTime() - 60 * 60 * 1000),
        }),
      ]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 1,
        remaining: 1,
      });
    });

    it('counts a post published exactly at now', async () => {
      const { guard } = setup(undefined, [
        makePost({ state: 'QUEUE', publishDate: NOW }),
      ]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 1,
        remaining: 1,
      });
    });

    it('counts a post exactly at the 24-hour boundary', async () => {
      const { guard } = setup(undefined, [
        makePost({
          state: 'QUEUE',
          publishDate: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
        }),
      ]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 1,
        remaining: 1,
      });
    });

    it('uses only past posts for limit usage and nextAllowedAt', async () => {
      const pastDate = new Date(NOW.getTime() - 60 * 60 * 1000);
      const { guard } = setup({ dailyPostLimit: 1 }, [
        makePost({ id: 'past', publishDate: pastDate }),
        makePost({
          id: 'future',
          state: 'QUEUE',
          publishDate: new Date(NOW.getTime() + 60 * 60 * 1000),
        }),
      ]);

      await expect(guard.check(guardInput())).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_DAILY_LIMIT_REACHED',
          used: 1,
          nextAllowedAt: new Date(pastDate.getTime() + 24 * 60 * 60 * 1000).toISOString(),
        },
      });
    });

    it('counts QUEUE and PUBLISHED rows regardless of API or WEB creation method', async () => {
      const { guard } = setup(undefined, [
        makePost({ id: 'queue-api', state: 'QUEUE', creationMethod: 'API' }),
        makePost({ id: 'published-web', state: 'PUBLISHED', creationMethod: 'WEB' }),
      ]);

      await expect(guard.check(guardInput())).rejects.toMatchObject({
        response: { code: 'TIKTOK_DAILY_LIMIT_REACHED', used: 2 },
      });
    });

    it.each(['DRAFT', 'ERROR'])('does not count %s rows', async (state) => {
      const { guard } = setup(undefined, [makePost({ state })]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 0,
        remaining: 2,
      });
    });

    it('does not count deleted posts', async () => {
      const { guard } = setup(undefined, [makePost({ deletedAt: NOW })]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 0,
        remaining: 2,
      });
    });

    it('counts DIRECT_POST and legacy rows with no posting method, but excludes UPLOAD', async () => {
      const { guard } = setup({ dailyPostLimit: 3 }, [
        makePost({ id: 'direct' }),
        makePost({ id: 'legacy', settings: null }),
        makePost({
          id: 'upload',
          settings: '{"content_posting_method":"UPLOAD"}',
        }),
      ]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 2,
        remaining: 1,
      });
    });

    it('treats malformed historical settings JSON as the legacy direct-post default', async () => {
      const { guard } = setup(undefined, [makePost({ settings: '{invalid' })]);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        postsInLast24Hours: 1,
        remaining: 1,
      });
    });

    it('uses a custom dailyPostLimit=5', async () => {
      const rows = Array.from({ length: 4 }, (_, index) =>
        makePost({ id: `post_${index}` })
      );
      const { guard } = setup({ dailyPostLimit: 5 }, rows);

      await expect(guard.check(guardInput())).resolves.toMatchObject({
        dailyPostLimit: 5,
        postsInLast24Hours: 4,
        remaining: 1,
      });
    });

    it('does not apply the daily limit to a new UPLOAD while still reporting usage', async () => {
      const rows = [makePost({ id: 'one' }), makePost({ id: 'two' })];
      const { guard } = setup(undefined, rows);

      await expect(
        guard.check(
          guardInput({ settings: { content_posting_method: 'UPLOAD' } })
        )
      ).resolves.toMatchObject({
        postsInLast24Hours: 2,
        remaining: 0,
      });
    });

    it('queries only the current organization and TikTok integration', async () => {
      const { guard, prisma } = setup();

      await guard.check(guardInput());

      expect(prisma.post.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            organizationId: ORGANIZATION_ID,
            integrationId: INTEGRATION_ID,
            deletedAt: null,
            state: { in: ['QUEUE', 'PUBLISHED'] },
            publishDate: {
              gte: new Date(NOW.getTime() - 24 * 60 * 60 * 1000),
              lte: NOW,
            },
          }),
        })
      );
    });
  });

  describe('duplicate media prevention', () => {
    it('matches an equal media.id even when its path changed', async () => {
      const { guard } = setup(undefined, [makePost()]);

      await expect(
        guard.check(
          guardInput({ media: [{ id: 'media_1', path: '/uploads/processed.mp4' }] })
        )
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_DUPLICATE_MEDIA',
          duplicateWindowDays: 30,
          matchedPostId: 'post_1',
        },
      });
    });

    it('matches a canonical path when media IDs differ', async () => {
      const { guard } = setup(undefined, [makePost()]);

      await expect(
        guard.check(
          guardInput({ media: [{ id: 'different-id', path: '/uploads/video.mp4' }] })
        )
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_DUPLICATE_MEDIA' },
      });
    });

    it.each([
      [
        'query-string-only URL difference',
        'https://cdn.example/video.mp4?signature=old',
        'https://cdn.example/video.mp4?signature=new',
      ],
      [
        'hash-only URL difference',
        'https://cdn.example/video.mp4#old',
        'https://cdn.example/video.mp4#new',
      ],
    ])('canonicalizes %s', async (_label, storedPath, requestedPath) => {
      const { guard } = setup(undefined, [
        makePost({
          image: JSON.stringify([{ id: 'stored-id', path: storedPath }]),
        }),
      ]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'new-id', path: requestedPath }] }))
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_DUPLICATE_MEDIA' },
      });
    });

    it('normalizes slash direction in local paths', async () => {
      const { guard } = setup(undefined, [
        makePost({ image: JSON.stringify([{ path: 'C:\\uploads\\video.mp4' }]) }),
      ]);

      await expect(
        guard.check(guardInput({ media: [{ path: 'C:/uploads/video.mp4' }] }))
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_DUPLICATE_MEDIA' },
      });
    });

    it('does not match a new processed variant with a different ID and path', async () => {
      const { guard } = setup(undefined, [makePost()]);

      await expect(
        guard.check(
          guardInput({ media: [{ id: 'variant-id', path: '/uploads/video-edited.mp4' }] })
        )
      ).resolves.toMatchObject({ duplicateDetected: false });
    });

    it('requires matching media count, order, and identity', async () => {
      const { guard } = setup(undefined, [
        makePost({
          image: JSON.stringify([
            { id: 'first', path: '/uploads/first.mp4' },
            { id: 'second', path: '/uploads/second.mp4' },
          ]),
        }),
      ]);

      await expect(
        guard.check(
          guardInput({
            media: [
              { id: 'second', path: '/uploads/second.mp4' },
              { id: 'first', path: '/uploads/first.mp4' },
            ],
          })
        )
      ).resolves.toMatchObject({ duplicateDetected: false });
    });

    it('does not match media arrays with different item counts', async () => {
      const { guard } = setup(undefined, [makePost()]);

      await expect(
        guard.check(
          guardInput({
            media: [
              { id: 'media_1', path: '/uploads/video.mp4' },
              { id: 'media_2', path: '/uploads/second.mp4' },
            ],
          })
        )
      ).resolves.toMatchObject({ duplicateDetected: false });
    });

    it('blocks within the default 30-day window and returns nextAllowedAt', async () => {
      const previous = new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000);
      const { guard } = setup(undefined, [makePost({ publishDate: previous })]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_DUPLICATE_MEDIA',
          duplicateWindowDays: 30,
          matchedPostId: 'post_1',
          previousPublishDate: previous.toISOString(),
          nextAllowedAt: new Date(previous.getTime() + 30 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
    });

    it('does not treat a future QUEUE duplicate as historical', async () => {
      const { guard } = setup(undefined, [
        makePost({
          state: 'QUEUE',
          publishDate: new Date(NOW.getTime() + 60 * 60 * 1000),
        }),
      ]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).resolves.toMatchObject({ duplicateDetected: false });
    });

    it('does not treat a future PUBLISHED duplicate fixture as historical', async () => {
      const { guard } = setup(undefined, [
        makePost({
          state: 'PUBLISHED',
          publishDate: new Date(NOW.getTime() + 60 * 60 * 1000),
        }),
      ]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).resolves.toMatchObject({ duplicateDetected: false });
    });

    it('treats a duplicate published exactly at now as historical', async () => {
      const { guard } = setup(undefined, [makePost({ publishDate: NOW })]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_DUPLICATE_MEDIA', matchedPostId: 'post_1' },
      });
    });

    it('includes a duplicate exactly at the cooldown lower boundary', async () => {
      const boundaryDate = new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000);
      const { guard } = setup(undefined, [makePost({ publishDate: boundaryDate })]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_DUPLICATE_MEDIA',
          previousPublishDate: boundaryDate.toISOString(),
        },
      });
    });

    it('queries duplicates between the cooldown boundary and the same now value', async () => {
      const { guard, prisma } = setup(
        { duplicateWindowDays: 30 },
        [makePost({ publishDate: new Date(NOW.getTime() - 10 * 24 * 60 * 60 * 1000) })]
      );

      await guard.check(
        guardInput({ media: [{ id: 'new-media', path: '/uploads/new-video.mp4' }] })
      );

      expect(prisma.post.findMany).toHaveBeenLastCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({
            publishDate: {
              gte: new Date(NOW.getTime() - 30 * 24 * 60 * 60 * 1000),
              lte: NOW,
            },
          }),
        })
      );
    });

    it('returns HTTP 409 for duplicate media', async () => {
      const { guard } = setup(undefined, [makePost()]);
      const error = await guard
        .check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
        .catch((caught) => caught);

      expect(error.getStatus()).toBe(409);
      expect(error.getResponse()).toMatchObject({ code: 'TIKTOK_DUPLICATE_MEDIA' });
    });

    it('allows a duplicate whose prior publishDate is outside the configured window', async () => {
      const { guard } = setup(
        { duplicateWindowDays: 30 },
        [makePost({ publishDate: new Date(NOW.getTime() - 31 * 24 * 60 * 60 * 1000) })]
      );

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).resolves.toMatchObject({ duplicateDetected: false });
    });

    it('applies a custom duplicateWindowDays value', async () => {
      const previous = new Date(NOW.getTime() - 45 * 24 * 60 * 60 * 1000);
      const { guard } = setup(
        { duplicateWindowDays: 60 },
        [makePost({ publishDate: previous })]
      );

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).rejects.toMatchObject({
        response: {
          code: 'TIKTOK_DUPLICATE_MEDIA',
          duplicateWindowDays: 60,
          nextAllowedAt: new Date(previous.getTime() + 60 * 24 * 60 * 60 * 1000).toISOString(),
        },
      });
    });

    it('disables duplicate checks when duplicateWindowDays is zero', async () => {
      const { guard } = setup({ duplicateWindowDays: 0 }, [makePost()]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).resolves.toMatchObject({
        duplicateWindowDays: 0,
        duplicateDetected: false,
      });
    });

    it.each(['DRAFT', 'ERROR'])('excludes %s posts from duplicate checks', async (state) => {
      const { guard } = setup(undefined, [makePost({ state })]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).resolves.toMatchObject({ duplicateDetected: false });
    });

    it('excludes deleted posts and applies duplicate protection to UPLOAD posts', async () => {
      const { guard } = setup(undefined, [
        makePost({
          id: 'deleted',
          deletedAt: NOW,
          image: JSON.stringify([{ id: 'media_1', path: '/uploads/video.mp4' }]),
        }),
        makePost({
          id: 'upload',
          state: 'QUEUE',
          settings: '{"content_posting_method":"UPLOAD"}',
        }),
      ]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_DUPLICATE_MEDIA', matchedPostId: 'upload' },
      });
    });

    it('applies duplicate protection to a new UPLOAD as well as an existing UPLOAD', async () => {
      const { guard } = setup(
        undefined,
        [makePost({ settings: '{"content_posting_method":"UPLOAD"}' })]
      );

      await expect(
        guard.check(
          guardInput({
            settings: { content_posting_method: 'UPLOAD' },
            media: [{ id: 'media_1', path: '/uploads/video.mp4' }],
          })
        )
      ).rejects.toMatchObject({
        response: { code: 'TIKTOK_DUPLICATE_MEDIA' },
      });
    });

    it('does not compare media from another organization or integration', async () => {
      const { guard, prisma } = setup(undefined, [
        makePost({
          id: 'other-account',
          integrationId: 'another-tiktok-account',
        }),
      ]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).resolves.toMatchObject({ duplicateDetected: false });
      expect(prisma.post.findMany.mock.calls[0][0].where.integrationId).toBe(INTEGRATION_ID);
    });

    it('does not fail when an older Post image field contains invalid JSON', async () => {
      const { guard } = setup(undefined, [makePost({ image: '{invalid' })]);

      await expect(
        guard.check(guardInput({ media: [{ id: 'media_1', path: '/uploads/video.mp4' }] }))
      ).resolves.toMatchObject({ duplicateDetected: false });
    });
  });
});
