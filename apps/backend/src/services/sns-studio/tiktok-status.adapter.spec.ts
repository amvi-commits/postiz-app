jest.mock('@gitroom/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaService: class PrismaService {},
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { State } from '@prisma/client';
import * as fs from 'fs';
import * as path from 'path';
import { TikTokStatusAdapter } from './tiktok-status.adapter';

const ORG_ID = 'org_1';
const POST_ID = 'post_1';
const PUBLISH_DATE = new Date('2026-09-30T10:00:00.000Z');
const CREATED_AT = new Date('2026-09-29T10:00:00.000Z');
const UPDATED_AT = new Date('2026-10-01T10:00:00.000Z');

function makePost(overrides: Record<string, unknown> = {}) {
  return {
    id: POST_ID,
    organizationId: ORG_ID,
    integrationId: 'integration_1',
    state: State.PUBLISHED,
    publishDate: PUBLISH_DATE,
    settings: '{"content_posting_method":"DIRECT_POST"}',
    image: '[{"path":"/uploads/video.mp4"}]',
    error: null,
    releaseId: 'release_1',
    releaseURL: 'https://www.tiktok.com/@creator/video/123',
    createdAt: CREATED_AT,
    updatedAt: UPDATED_AT,
    deletedAt: null,
    integration: {
      providerIdentifier: 'tiktok',
      token: 'integration-access-secret',
      refreshToken: 'integration-refresh-secret',
    },
    ...overrides,
  };
}

function makeError(index: number, overrides: Record<string, unknown> = {}) {
  return {
    id: `error_${index}`,
    message: `error ${index}`,
    platform: 'tiktok',
    createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, index)),
    body: `private request ${index}`,
    ...overrides,
  };
}

function makeSetup() {
  const prisma: any = {
    post: {
      findFirst: jest.fn().mockResolvedValue(makePost()),
    },
    errors: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };

  return { prisma, adapter: new TikTokStatusAdapter(prisma) };
}

describe('TikTokStatusAdapter', () => {
  it('returns status for an organization-owned Personal TikTok post', async () => {
    const { prisma, adapter } = makeSetup();

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);

    expect(response).toMatchObject({
      postId: POST_ID,
      integrationId: 'integration_1',
      platform: 'tiktok',
      providerIdentifier: 'tiktok',
      accountType: 'personal',
      status: 'published',
      postState: State.PUBLISHED,
      deliveryMode: 'direct_post',
      publicationSemantics: 'public_post',
      publishDate: PUBLISH_DATE.toISOString(),
      createdAt: CREATED_AT.toISOString(),
      updatedAt: UPDATED_AT.toISOString(),
      releaseId: 'release_1',
      releaseURL: 'https://www.tiktok.com/@creator/video/123',
      latestError: null,
      errorHistory: [],
      warnings: [],
    });
    expect(prisma.post.findFirst).toHaveBeenCalledWith({
      where: { id: POST_ID, organizationId: ORG_ID, deletedAt: null },
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
        integration: { select: { providerIdentifier: true } },
      },
    });
  });

  it('allows TikTok Business posts and reports business accountType', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(
      makePost({ integration: { providerIdentifier: 'tiktok-business' } })
    );

    await expect(adapter.getPostStatus(ORG_ID, POST_ID)).resolves.toMatchObject({
      providerIdentifier: 'tiktok-business',
      accountType: 'business',
    });
  });

  it('returns 404 for another organization without loading that Post', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(adapter.getPostStatus('other-org', POST_ID)).rejects.toBeInstanceOf(
      NotFoundException
    );
    expect(prisma.post.findFirst.mock.calls[0][0].where).toEqual({
      id: POST_ID,
      organizationId: 'other-org',
      deletedAt: null,
    });
    expect(prisma.errors.findMany).not.toHaveBeenCalled();
  });

  it('returns 404 for a deleted Post', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(null);

    await expect(adapter.getPostStatus(ORG_ID, 'deleted_post')).rejects.toMatchObject({
      response: { code: 'TIKTOK_POST_NOT_FOUND' },
    });
    expect(prisma.post.findFirst.mock.calls[0][0].where.deletedAt).toBeNull();
  });

  it('rejects other SNS providers with TIKTOK_POST_NOT_TIKTOK', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(
      makePost({ integration: { providerIdentifier: 'instagram' } })
    );

    await expect(adapter.getPostStatus(ORG_ID, POST_ID)).rejects.toMatchObject({
      response: { code: 'TIKTOK_POST_NOT_TIKTOK' },
    });
    expect(prisma.errors.findMany).not.toHaveBeenCalled();
  });

  it.each([
    [State.DRAFT, 'draft'],
    [State.QUEUE, 'pending'],
    [State.PUBLISHED, 'published'],
    [State.ERROR, 'error'],
  ])('maps Postiz state %s to %s and retains postState', async (state, status) => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(makePost({ state }));

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);

    expect(response).toMatchObject({ status, postState: state });
  });

  it('uses DIRECT_POST for explicit settings', async () => {
    const { adapter } = makeSetup();

    await expect(adapter.getPostStatus(ORG_ID, POST_ID)).resolves.toMatchObject({
      deliveryMode: 'direct_post',
      publicationSemantics: 'public_post',
    });
  });

  it('uses UPLOAD semantics and warning even when Postiz state is PUBLISHED', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(
      makePost({ settings: '{"content_posting_method":"UPLOAD"}', state: State.PUBLISHED })
    );

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);

    expect(response).toMatchObject({
      status: 'published',
      postState: State.PUBLISHED,
      deliveryMode: 'upload',
      publicationSemantics: 'tiktok_inbox_upload',
      warnings: [
        {
          code: 'TIKTOK_UPLOAD_REQUIRES_APP_PUBLISH',
          message: 'TikTokアプリ側で公開操作を完了する必要があります。',
        },
      ],
    });
    expect(response.publicationSemantics).not.toBe('public_post');
  });

  it.each([
    ['missing settings', null],
    ['legacy settings without posting method', '{"privacy_level":"PUBLIC_TO_EVERYONE"}'],
    ['malformed settings JSON', '{invalid-json'],
  ])('falls back to DIRECT_POST for %s', async (_label, settings) => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(makePost({ settings }));

    await expect(adapter.getPostStatus(ORG_ID, POST_ID)).resolves.toMatchObject({
      deliveryMode: 'direct_post',
      publicationSemantics: 'public_post',
      warnings: [],
    });
  });

  it('returns only persisted releaseId and releaseURL and does not invent values', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(makePost({ releaseId: null, releaseURL: null }));

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);

    expect(response).toMatchObject({ releaseId: null, releaseURL: null });
    expect(JSON.stringify(response)).not.toContain('tiktok.com');
  });

  it('sanitizes Post.error into latestError and uses the stored Post update timestamp', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(
      makePost({
        state: State.ERROR,
        error: 'Failed: Bearer bearer-secret access_token=query-secret refresh_token=refresh-secret client_secret=client-secret',
      })
    );

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);

    expect(response).toMatchObject({
      status: 'error',
      latestError: {
        occurredAt: UPDATED_AT.toISOString(),
        message: expect.stringContaining('[REDACTED]'),
      },
    });
    for (const credential of [
      'bearer-secret',
      'query-secret',
      'refresh-secret',
      'client-secret',
    ]) {
      expect(JSON.stringify(response)).not.toContain(credential);
    }
  });

  it('redacts JSON token fields, Authorization, Cookie, and OAuth secrets in error history', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.errors.findMany.mockResolvedValue([
      makeError(1, {
        message:
          '"access_token":"json-access" "refresh_token":"json-refresh" Authorization: Bearer auth-secret\nCookie: sid=cookie-secret oauth_secret=oauth-secret OAuth secret: spaced-oauth-secret credentials=credentials-secret',
      }),
    ]);

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);
    const serialized = JSON.stringify(response);

    expect(response.errorHistory[0].message).toContain('[REDACTED]');
    for (const credential of [
      'json-access',
      'json-refresh',
      'auth-secret',
      'cookie-secret',
      'oauth-secret',
      'spaced-oauth-secret',
      'credentials-secret',
    ]) {
      expect(serialized).not.toContain(credential);
    }
  });

  it('truncates each returned error message to at most 1000 characters', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.post.findFirst.mockResolvedValue(makePost({ state: State.ERROR, error: 'x'.repeat(3000) }));
    prisma.errors.findMany.mockResolvedValue([
      makeError(1, { message: 'y'.repeat(3000) }),
    ]);

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);

    expect(response.latestError.message).toHaveLength(1000);
    expect(response.errorHistory[0].message).toHaveLength(1000);
  });

  it('reads the newest five Errors without selecting or returning body', async () => {
    const { prisma, adapter } = makeSetup();
    prisma.errors.findMany.mockResolvedValue(
      [1, 2, 3, 4, 5].map((index) => makeError(index))
    );

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);

    expect(prisma.errors.findMany).toHaveBeenCalledWith({
      where: { organizationId: ORG_ID, postId: POST_ID },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: { id: true, message: true, platform: true, createdAt: true },
    });
    expect(response.errorHistory).toHaveLength(5);
    expect(response.errorHistory[0]).toEqual({
      id: 'error_1',
      message: 'error 1',
      platform: 'tiktok',
      createdAt: new Date(Date.UTC(2026, 9, 2, 0, 0, 1)).toISOString(),
    });
    expect(response.errorHistory[0]).not.toHaveProperty('body');
    expect(JSON.stringify(response)).not.toContain('private request');
  });

  it('does not select Integration credentials or return image/settings', async () => {
    const { prisma, adapter } = makeSetup();

    const response = await adapter.getPostStatus(ORG_ID, POST_ID);
    const query = prisma.post.findFirst.mock.calls[0][0];
    const serialized = JSON.stringify(response);

    expect(query.select.integration.select).toEqual({ providerIdentifier: true });
    expect(query.select).not.toHaveProperty('integration.token');
    expect(serialized).not.toContain('integration-access-secret');
    expect(serialized).not.toContain('integration-refresh-secret');
    expect(response).not.toHaveProperty('image');
    expect(response).not.toHaveProperty('settings');
    expect(response).not.toHaveProperty('retryable');
  });

  it('does not call TikTok APIs, Analytics, Providers, or add a retry route', () => {
    const adapterPath = path.resolve(__dirname, './tiktok-status.adapter.ts');
    const controllerPath = path.resolve(__dirname, '../../api/routes/sns-studio.controller.ts');
    const adapterSource = fs.readFileSync(adapterPath, 'utf8');
    const controllerSource = fs.readFileSync(controllerPath, 'utf8');

    expect(adapterSource).not.toMatch(/TiktokProvider|TiktokBusinessProvider/);
    expect(adapterSource).not.toMatch(/\bfetch\s*\(/);
    expect(adapterSource).not.toMatch(/analytics\s*\(|postAnalytics\s*\(/);
    expect(controllerSource).not.toContain("@Post('/tiktok/posts/:postId/retry')");
  });
});
