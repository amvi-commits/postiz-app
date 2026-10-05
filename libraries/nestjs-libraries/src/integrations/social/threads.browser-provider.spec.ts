import { ThreadsProvider } from './threads.provider';
import { BadBody } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import type { Integration } from '@prisma/client';

describe('Threads Browser Publish Transport', () => {
  let provider: ThreadsProvider;
  const originalEnv = process.env;

  const mockIntegration: Integration = {
    id: 'int_123',
    internalId: 'internal_123',
    organizationId: 'org_123',
    name: 'threads_user',
    providerIdentifier: 'threads',
    type: 'social',
    token: 'test_token',
    refreshToken: null,
    expiresIn: null,
    timezone: null,
    postingTimes: '[]',
    refreshNeeded: false,
    inBetweenSteps: false,
    disabled: false,
    picture: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    deletedAt: null,
  };

  const samplePostDetails = [
    {
      id: 'post_001',
      message: 'Hello from Browser Transport Test!',
      media: [],
      settings: {
        isGhostPost: false,
      } as any,
    },
  ];

  beforeEach(() => {
    jest.resetModules();
    process.env = { ...originalEnv };
    provider = new ThreadsProvider();
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  it('preserves official API publishing when THREADS_PUBLISH_TRANSPORT is not "browser"', async () => {
    delete process.env.THREADS_PUBLISH_TRANSPORT;
    const postPendingSpy = jest
      .spyOn(provider as any, 'postPending')
      .mockResolvedValue([{ pendingData: 'pending_123' }]);
    const checkPostStatusSpy = jest
      .spyOn(provider as any, 'checkPostStatus')
      .mockResolvedValue({ status: 'completed' });

    const result = await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);
    expect(postPendingSpy).toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it('delegates publishing to FastAPI sidecar when THREADS_PUBLISH_TRANSPORT is "browser"', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

    const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          account: 'threads_user',
          post_id: 'th_sidecar_abc123',
          url: 'https://www.threads.net/@threads_user',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8017/api/threads/post',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': 'application/json',
          'X-Threads-Service-Key': 'test_secret_key',
        }),
        body: expect.stringContaining('"account":"threads_user"'),
      })
    );

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('th_sidecar_abc123');
    expect(result[0].releaseURL).toBe('https://www.threads.net/@threads_user');
    expect(result[0].status).toBe('completed');
  });

  it('maps sidecar error to BadBody exception with error code and message', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';

    jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          code: 'AUTH_REQUIRED',
          message: 'Threadsへの再ログインが必要です。',
        }),
        { status: 401, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await expect(
      provider.post('user_1', 'token_1', samplePostDetails, mockIntegration)
    ).rejects.toThrow(BadBody);
  });

  it('includes single media URL in sidecar payload when media is attached', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';

    const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          account: 'threads_user',
          post_id: 'th_sidecar_media_1',
          url: 'https://www.threads.net/@threads_user',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const postWithSingleMedia = [
      {
        id: 'post_single_media',
        message: 'Post with image',
        media: [{ type: 'image' as const, path: 'https://cdn.example.com/image1.jpg' }],
        settings: {} as any,
      },
    ];

    const result = await provider.post('user_1', 'token_1', postWithSingleMedia, mockIntegration);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8017/api/threads/post',
      expect.objectContaining({
        body: expect.stringContaining('"media_urls":["https://cdn.example.com/image1.jpg"]'),
      })
    );
    expect(result[0].id).toBe('th_sidecar_media_1');
  });

  it('includes multiple media URLs for carousel in sidecar payload', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';

    const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          account: 'threads_user',
          post_id: 'th_sidecar_carousel_1',
          url: 'https://www.threads.net/@threads_user',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const postWithMultipleMedia = [
      {
        id: 'post_carousel',
        message: 'Post with carousel',
        media: [
          { type: 'image' as const, path: 'https://cdn.example.com/img1.png' },
          { type: 'image' as const, path: 'https://cdn.example.com/img2.webp' },
        ],
        settings: {} as any,
      },
    ];

    const result = await provider.post('user_1', 'token_1', postWithMultipleMedia, mockIntegration);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8017/api/threads/post',
      expect.objectContaining({
        body: expect.stringContaining('"media_urls":["https://cdn.example.com/img1.png","https://cdn.example.com/img2.webp"]'),
      })
    );
    expect(result[0].id).toBe('th_sidecar_carousel_1');
  });
});
