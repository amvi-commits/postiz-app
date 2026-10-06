import {
  ThreadsProvider,
  validateBrowserSidecarUrl,
  isBrowserIntegration,
  getThreadsTransport,
  getBrowserAccount,
  isBrowserToken,
  assertNotBrowserToken,
} from './threads.provider';
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
    expect(result[0].id).toBe('post_001');
    expect(result[0].postId).toBe('th_sidecar_abc123');
    expect(result[0].releaseURL).toBe('https://www.threads.net/@threads_user');
    expect(result[0].status).toBe('completed');
  });

  it('maps sidecar error to BadBody exception with error code and message', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

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
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

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
    expect(result[0].id).toBe('post_single_media');
    expect(result[0].postId).toBe('th_sidecar_media_1');
  });

  it('includes multiple media URLs for carousel in sidecar payload', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

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
    expect(result[0].id).toBe('post_carousel');
    expect(result[0].postId).toBe('th_sidecar_carousel_1');
  });

  it('throws BadBody with [CONFIGURATION_ERROR] when THREADS_BROWSER_SERVICE_KEY is missing', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    delete process.env.THREADS_BROWSER_SERVICE_KEY;

    await expect(
      provider.post('user_1', 'token_1', samplePostDetails, mockIntegration)
    ).rejects.toThrow(BadBody);

    try {
      await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);
    } catch (e: any) {
      expect(e.message).toContain('[CONFIGURATION_ERROR]');
      expect(e.nonRetryable).toBe(true);
    }
  });

  it('prioritizes browserAccount over account and integration name', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

    const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          account: 'precedence_winner',
          post_id: 'real_post_999',
          url: 'https://www.threads.net/post/real_post_999',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const postDetailsWithPrecedence = [
      {
        id: 'post_002',
        message: 'Precedence test',
        media: [],
        settings: {
          browserAccount: 'precedence_winner',
          account: 'precedence_loser',
        } as any,
      },
    ];

    await provider.post('user_1', 'token_1', postDetailsWithPrecedence, mockIntegration);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8017/api/threads/post',
      expect.objectContaining({
        body: expect.stringContaining('"account":"precedence_winner"'),
      })
    );
  });

  it('prioritizes THREADS_BROWSER_DEFAULT_ACCOUNT over integration name when post settings omit account', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';
    process.env.THREADS_BROWSER_DEFAULT_ACCOUNT = 'main';

    const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'ok',
          account: 'main',
          post_id: 'real_post_999',
          url: 'https://www.threads.net/post/real_post_999',
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);

    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8017/api/threads/post',
      expect.objectContaining({
        body: expect.stringContaining('"account":"main"'),
      })
    );
  });

  it('maps submitted status with null post_id to undefined postId and status submitted', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

    jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'submitted',
          account: 'threads_user',
          post_id: null,
          url: null,
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    );

    const result = await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);

    expect(result).toHaveLength(1);
    expect(result[0].id).toBe('post_001');
    expect(result[0].postId).toBeUndefined();
    expect(result[0].releaseURL).toBeUndefined();
    expect(result[0].status).toBe('submitted');
  });

  it('throws non-retryable BadBody when sidecar returns POST_STATUS_UNKNOWN', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

    jest.spyOn(provider as any, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'error',
          code: 'POST_STATUS_UNKNOWN',
          message: 'Post submission timed out while waiting for confirmation dialog to dismiss',
        }),
        { status: 500, headers: { 'Content-Type': 'application/json' } }
      )
    );

    let thrownError: any = null;
    try {
      await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);
    } catch (e: any) {
      thrownError = e;
    }

    expect(thrownError).toBeInstanceOf(BadBody);
    expect(thrownError.message).toContain('[POST_STATUS_UNKNOWN]');
    expect(thrownError.nonRetryable).toBe(true);
  });

  describe('THREADS_BROWSER_ALLOW_REAL_POST fail-closed guard', () => {
    beforeEach(() => {
      process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
      process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';
      process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';
    });

    it('enforces dry_run=true when THREADS_BROWSER_ALLOW_REAL_POST is unset', async () => {
      delete process.env.THREADS_BROWSER_ALLOW_REAL_POST;
      const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'dry_run_ok', post_id: null, url: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8017/api/threads/post',
        expect.objectContaining({
          body: expect.stringContaining('"dry_run":true'),
        })
      );
      expect(result[0].postId).toBeUndefined();
      expect(result[0].releaseURL).toBeUndefined();
    });

    it('enforces dry_run=true when THREADS_BROWSER_ALLOW_REAL_POST is "false"', async () => {
      process.env.THREADS_BROWSER_ALLOW_REAL_POST = 'false';
      const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({ status: 'dry_run_ok', post_id: null, url: null }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8017/api/threads/post',
        expect.objectContaining({
          body: expect.stringContaining('"dry_run":true'),
        })
      );
    });

    it('enforces dry_run=true for ambiguous or invalid values (fail-closed)', async () => {
      for (const invalidVal of ['1', 'yes', 'TRUE_MAYBE', 'enabled', '0']) {
        process.env.THREADS_BROWSER_ALLOW_REAL_POST = invalidVal;
        const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
          new Response(
            JSON.stringify({ status: 'dry_run_ok', post_id: null, url: null }),
            { status: 200, headers: { 'Content-Type': 'application/json' } }
          )
        );

        await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);
        expect(fetchSpy).toHaveBeenCalledWith(
          'http://127.0.0.1:8017/api/threads/post',
          expect.objectContaining({
            body: expect.stringContaining('"dry_run":true'),
          })
        );
      }
    });

    it('only sets dry_run=false when THREADS_BROWSER_ALLOW_REAL_POST is explicitly "true"', async () => {
      process.env.THREADS_BROWSER_ALLOW_REAL_POST = 'true';
      const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ok',
            account: 'threads_user',
            post_id: 'real_id_123',
            url: 'https://threads.net/p/123',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await provider.post('user_1', 'token_1', samplePostDetails, mockIntegration);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8017/api/threads/post',
        expect.objectContaining({
          body: expect.stringContaining('"dry_run":false'),
        })
      );
      expect(result[0].postId).toBe('real_id_123');
      expect(result[0].status).toBe('completed');
    });
  });

  describe('verifyBrowserTransport diagnostics', () => {
    beforeEach(() => {
      process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
      process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';
      process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';
    });

    it('performs health check and session check', async () => {
      jest.spyOn(provider as any, 'fetch').mockImplementation(async (url: string) => {
        if (url.includes('/health')) {
          return new Response(JSON.stringify({ status: 'ok', playwright: true }), { status: 200 });
        }
        if (url.includes('/session/check')) {
          return new Response(JSON.stringify({ account: 'main', status: 'SESSION_OK' }), { status: 200 });
        }
        return new Response('{}', { status: 404 });
      });

      const res = await provider.verifyBrowserTransport({
        checkHealth: true,
        checkSession: true,
      });

      expect(res.health).toEqual({ status: 'ok', playwright: true });
      expect(res.session).toEqual({ account: 'main', status: 'SESSION_OK' });
      expect(res.post).toBeUndefined();
    });

    it('performs dry-run post verification strictly with dry_run=true', async () => {
      const fetchSpy = jest.spyOn(provider as any, 'fetch').mockImplementation(async (url: string, opts: any) => {
        if (url.includes('/post')) {
          const body = JSON.parse(opts.body);
          expect(body.dry_run).toBe(true);
          return new Response(
            JSON.stringify({ status: 'dry_run_ok', post_id: null, url: null }),
            { status: 200 }
          );
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      });

      const res = await provider.verifyBrowserTransport({
        checkHealth: false,
        dryRunPost: true,
        text: 'SNS Studio 4017 Threads browser dry-run test',
      });

      expect(res.post).toEqual({
        status: 'dry_run_ok',
        post_id: null,
        url: null,
        dry_run: true,
      });
    });

    it('handles Ghost post rejection as unsupported with HTTP 409', async () => {
      jest.spyOn(provider as any, 'fetch').mockImplementation(async (url: string) => {
        if (url.includes('/post')) {
          return new Response(
            JSON.stringify({
              status: 'error',
              code: 'GHOST_NOT_AVAILABLE',
              message: 'Threads Web UI上でGhost Post操作が利用できません。',
            }),
            { status: 409 }
          );
        }
        return new Response(JSON.stringify({ status: 'ok' }), { status: 200 });
      });

      const res = await provider.verifyBrowserTransport({
        checkHealth: false,
        dryRunPost: true,
        isGhost: true,
      });

      expect(res.post).toEqual({
        status: 'unsupported',
        code: 'GHOST_NOT_AVAILABLE',
        message: 'Threads Web UI上でGhost Post操作が利用できません。',
        httpStatus: 409,
        dry_run: true,
      });
    });
  });

  describe('SSRF Hardening and Sidecar URL Validation', () => {
    it('allows valid sidecar URLs and normalizes trailing slashes', () => {
      expect(validateBrowserSidecarUrl('http://127.0.0.1:8017')).toBe('http://127.0.0.1:8017');
      expect(validateBrowserSidecarUrl('http://127.0.0.1:8017/')).toBe('http://127.0.0.1:8017');
      expect(validateBrowserSidecarUrl('http://127.0.0.1:8017/some/path')).toBe('http://127.0.0.1:8017');
      expect(validateBrowserSidecarUrl('http://host.docker.internal:8017')).toBe('http://host.docker.internal:8017');
      expect(validateBrowserSidecarUrl('http://localhost:8017')).toBe('http://localhost:8017');
      expect(validateBrowserSidecarUrl('http://threads-browser-worker:8017')).toBe('http://threads-browser-worker:8017');
    });

    it('rejects https protocol', () => {
      expect(() => validateBrowserSidecarUrl('https://127.0.0.1:8017')).toThrow(BadBody);
      try {
        validateBrowserSidecarUrl('https://127.0.0.1:8017');
      } catch (e: any) {
        expect(e.message).toContain('[SECURITY_ERROR]');
        expect(e.message).toContain('must use http: protocol');
      }
    });

    it('rejects disallowed hostnames', () => {
      expect(() => validateBrowserSidecarUrl('http://attacker.com:8017')).toThrow(BadBody);
      expect(() => validateBrowserSidecarUrl('http://192.168.1.1:8017')).toThrow(BadBody);
      expect(() => validateBrowserSidecarUrl('http://169.254.169.254:8017')).toThrow(BadBody);
    });

    it('rejects non-8017 ports', () => {
      expect(() => validateBrowserSidecarUrl('http://127.0.0.1:80')).toThrow(BadBody);
      expect(() => validateBrowserSidecarUrl('http://127.0.0.1:3000')).toThrow(BadBody);
      expect(() => validateBrowserSidecarUrl('http://127.0.0.1')).toThrow(BadBody);
    });

    it('rejects URLs containing credentials', () => {
      expect(() => validateBrowserSidecarUrl('http://user:pass@127.0.0.1:8017')).toThrow(BadBody);
    });

    it('rejects malformed URLs', () => {
      expect(() => validateBrowserSidecarUrl('not-a-valid-url')).toThrow(BadBody);
    });

    it('fails closed in postViaBrowser when THREADS_BROWSER_SERVICE_URL is invalid', async () => {
      process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
      process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';
      process.env.THREADS_BROWSER_SERVICE_URL = 'http://attacker.com:8017';

      const fetchSpy = jest.spyOn(provider as any, 'fetch');

      await expect(
        provider.post('user_1', 'token_1', samplePostDetails, mockIntegration)
      ).rejects.toThrow(BadBody);

      expect(fetchSpy).not.toHaveBeenCalled();
    });

    it('fails closed in verifyBrowserTransport when THREADS_BROWSER_SERVICE_URL is invalid', async () => {
      process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';
      process.env.THREADS_BROWSER_SERVICE_URL = 'http://attacker.com:8017';

      const fetchSpy = jest.spyOn(provider as any, 'fetch');

      const res = await provider.verifyBrowserTransport({
        checkHealth: true,
        checkSession: true,
        dryRunPost: true,
      });

      expect(res.health?.status).toBe('error');
      expect(res.health?.error).toContain('[SECURITY_ERROR]');
      expect(res.session?.status).toBe('error');
      expect(res.post?.status).toBe('error');
      expect(fetchSpy).not.toHaveBeenCalled();
    });
  });

  describe('Browser Integration helpers and fail-closed official API protection', () => {
    it('correctly identifies browser integrations via various metadata', () => {
      expect(isBrowserIntegration(null)).toBe(false);
      expect(isBrowserIntegration({ providerIdentifier: 'instagram' })).toBe(false);
      expect(isBrowserIntegration({ providerIdentifier: 'threads', internalId: '123456789' })).toBe(false);
      
      expect(isBrowserIntegration({
        providerIdentifier: 'threads',
        internalId: 'threads_browser_main',
      })).toBe(true);

      expect(isBrowserIntegration({
        providerIdentifier: 'threads',
        token: 'managed:threads-browser:main',
      })).toBe(true);

      expect(isBrowserIntegration({
        providerIdentifier: 'threads',
        customInstanceDetails: JSON.stringify({ transport: 'browser', browserAccount: 'main' }),
      })).toBe(true);

      expect(isBrowserIntegration({
        providerIdentifier: 'threads',
        additionalSettings: JSON.stringify([{ title: 'transport', value: 'browser' }]),
      })).toBe(true);
    });

    it('determines transport correctly via getThreadsTransport', () => {
      delete process.env.THREADS_PUBLISH_TRANSPORT;
      expect(getThreadsTransport(null)).toBe('official_api');
      expect(getThreadsTransport({ providerIdentifier: 'threads', token: 'official_token' })).toBe('official_api');

      expect(getThreadsTransport({
        providerIdentifier: 'threads',
        internalId: 'threads_browser_main',
      })).toBe('browser');

      process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
      expect(getThreadsTransport(null)).toBe('browser');
    });

    it('extracts browser profile alias correctly via getBrowserAccount', () => {
      delete process.env.THREADS_BROWSER_DEFAULT_ACCOUNT;
      expect(getBrowserAccount(null)).toBe('main');

      expect(getBrowserAccount({
        customInstanceDetails: JSON.stringify({ browserAccount: 'sub_acc' }),
      })).toBe('sub_acc');

      expect(getBrowserAccount({
        additionalSettings: JSON.stringify([{ title: 'browserAccount', value: 'settings_acc' }]),
      })).toBe('settings_acc');

      expect(getBrowserAccount({
        internalId: 'threads_browser_custom',
      })).toBe('custom');
    });

    it('asserts non-browser tokens and detects browser tokens', () => {
      expect(isBrowserToken('test_official_token')).toBe(false);
      expect(isBrowserToken('managed:threads-browser:main')).toBe(true);
      expect(isBrowserToken('managed:browser:main')).toBe(true);

      expect(() => assertNotBrowserToken('test_official_token')).not.toThrow();
      expect(() => assertNotBrowserToken('managed:threads-browser:main', 'testOperation')).toThrow(BadBody);

      try {
        assertNotBrowserToken('managed:threads-browser:main', 'testOperation');
      } catch (err: any) {
        expect(err.message).toContain('[BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE]');
        expect(err.message).toContain('testOperation');
      }
    });

    it('routes browser integration to postViaBrowser in post() even if THREADS_PUBLISH_TRANSPORT is unset', async () => {
      delete process.env.THREADS_PUBLISH_TRANSPORT;
      process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';
      process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

      const browserIntegration: Integration = {
        ...mockIntegration,
        internalId: 'threads_browser_main',
        token: 'managed:threads-browser:main',
        customInstanceDetails: JSON.stringify({ transport: 'browser', browserAccount: 'main' }),
      };

      const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ok',
            account: 'main',
            post_id: 'th_browser_123',
            url: 'https://www.threads.net/@main',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const result = await provider.post('user_1', 'managed:threads-browser:main', samplePostDetails, browserIntegration);
      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8017/api/threads/post',
        expect.anything()
      );
      expect(result).toHaveLength(1);
      expect(result[0].postId).toBe('th_browser_123');
    });

    it('fails closed when official Graph API methods are called with managed browser token', async () => {
      const browserToken = 'managed:threads-browser:main';

      await expect(provider.fetchUserThreads(browserToken)).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.fetchPublishingLimit(browserToken, 'user_1')).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.keywordSearch(browserToken, 'query')).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.replyToThread('user_1', browserToken, 'reply_1', 'text')).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.searchLocations(browserToken, 'query')).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.refreshToken(browserToken)).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.postPending('user_1', browserToken, samplePostDetails, mockIntegration)).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.deleteThread(browserToken, 'post_123')).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.comment('user_1', 'post_1', undefined, browserToken, samplePostDetails, mockIntegration)).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.analytics('post_1', browserToken, 7)).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
      await expect(provider.postAnalytics('int_1', browserToken, 'post_1', 7)).rejects.toThrow(
        /BROWSER_ACCOUNT_OFFICIAL_API_UNAVAILABLE/
      );
    });

    it('fetches browser profile from sidecar via getBrowserProfile', async () => {
      process.env.THREADS_BROWSER_SERVICE_URL = 'http://127.0.0.1:8017';
      process.env.THREADS_BROWSER_SERVICE_KEY = 'test_secret_key';

      const fetchSpy = jest.spyOn(provider as any, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            status: 'ok',
            account: 'main',
            username: 'my_threads_handle',
            name: 'My Threads User',
            picture: 'https://example.com/avatar.jpg',
            profile_url: 'https://www.threads.net/@my_threads_handle',
            session_status: 'SESSION_OK',
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        )
      );

      const profile = await provider.getBrowserProfile('main');
      expect(profile.username).toBe('my_threads_handle');
      expect(profile.session_status).toBe('SESSION_OK');

      expect(fetchSpy).toHaveBeenCalledWith(
        'http://127.0.0.1:8017/api/threads/accounts/main/profile',
        expect.objectContaining({
          headers: expect.objectContaining({
            'X-Threads-Service-Key': 'test_secret_key',
          }),
        })
      );
    });
  });
});


