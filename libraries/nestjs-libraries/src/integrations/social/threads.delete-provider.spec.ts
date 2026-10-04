import { timer } from '@gitroom/helpers/utils/timer';
import {
  BadBody,
  RefreshToken,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { THREADS_BASE_GRAPH_URL, THREADS_SCOPES } from './threads.capabilities';
import { ThreadsProvider } from './threads.provider';

jest.mock('@gitroom/helpers/utils/timer', () => ({ timer: jest.fn() }));

describe('Threads delete helper contract', () => {
  const token = 'delete-test-token';
  let provider: ThreadsProvider;
  let networkFetch: jest.SpyInstance;
  let providerFetch: jest.SpyInstance;
  let log: jest.SpyInstance;
  let warn: jest.SpyInstance;
  let errorLog: jest.SpyInstance;

  const response = (body: unknown, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { 'Content-Type': 'application/json' },
    });

  const failure = async () =>
    provider.deleteThread(token, 'thread-123').then(
      () => {
        throw new Error('Expected deletion to reject');
      },
      (error: unknown) => error as BadBody | RefreshToken
    );

  const expectSafeFailure = (error: BadBody | RefreshToken) => {
    expect(error.nonRetryable).toBe(true);
    expect(error.message).not.toContain(token);
    expect(error.stack).not.toContain(token);
    expect(String(error)).not.toContain(token);
    expect(JSON.stringify(error)).not.toContain(token);
    expect(error.details).toEqual([
      { identifier: 'threads', json: '{}', body: '{}' },
    ]);
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(networkFetch).toHaveBeenCalledTimes(1);
  };

  beforeEach(() => {
    jest.clearAllMocks();
    networkFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        throw new Error('Unconfigured fetch: real network is forbidden');
      });
    provider = new ThreadsProvider();
    // Call the real shared wrapper so retry/error tests verify HTTP call counts.
    providerFetch = jest.spyOn(provider, 'fetch');
    log = jest.spyOn(console, 'log').mockImplementation(() => {});
    warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    try {
      expect(timer).not.toHaveBeenCalled();
      expect(log).not.toHaveBeenCalled();
      expect(warn).not.toHaveBeenCalled();
      expect(errorLog).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it('returns the successful response after exactly one DELETE', async () => {
    const result = response({ success: true });
    networkFetch.mockResolvedValueOnce(result);

    expect(await provider.deleteThread(token, 'thread-123')).toBe(result);
    expect(await result.json()).toEqual({ success: true });
    expect(providerFetch).toHaveBeenCalledTimes(1);
    expect(providerFetch).toHaveBeenCalledWith(
      `${THREADS_BASE_GRAPH_URL}/thread-123`,
      {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` },
        redirect: 'error',
      },
      'threads',
      3
    );
    expect(networkFetch).toHaveBeenCalledTimes(1);
    const [url, options] = networkFetch.mock.calls[0];
    expect(url).toBe('https://graph.threads.net/v1.0/thread-123');
    expect(url).not.toContain(token);
    expect(new URL(url).search).toBe('');
    expect(options.method).toBe('DELETE');
    expect(options.headers).toEqual({ Authorization: `Bearer ${token}` });
    expect(options.redirect).toBe('error');
    expect(options).not.toHaveProperty('body');
  });

  it.each([{}, { deleted: 'thread-123' }])(
    'does not require a success field in an HTTP success body: %j',
    async (body) => {
      const result = response(body, 201);
      networkFetch.mockResolvedValueOnce(result);
      expect(await provider.deleteThread(token, 'thread-123')).toBe(result);
      expect(result.bodyUsed).toBe(false);
      expect(networkFetch).toHaveBeenCalledTimes(1);
    }
  );

  it('does not parse or assume JSON in a successful response', async () => {
    const result = new Response('', { status: 200 });
    networkFetch.mockResolvedValueOnce(result);
    expect(await provider.deleteThread(token, 'thread-123')).toBe(result);
    expect(result.bodyUsed).toBe(false);
  });

  it.each(['', ' ', '\t\n', '.', '..'])(
    'rejects unsafe/empty ID %j before fetch',
    async (id) => {
      await expect(provider.deleteThread(token, id)).rejects.toThrow(
        'A valid Threads post ID is required for deletion.'
      );
      expect(providerFetch).not.toHaveBeenCalled();
      expect(networkFetch).not.toHaveBeenCalled();
    }
  );

  it('encodes the ID into one path segment, without adding query or fragment', async () => {
    networkFetch.mockResolvedValueOnce(response({}));
    const id = 'thread/other?access_token=untrusted#fragment';
    await provider.deleteThread(token, id);
    const url = new URL(networkFetch.mock.calls[0][0]);
    expect(url.origin).toBe('https://graph.threads.net');
    expect(url.pathname).toBe(`/v1.0/${encodeURIComponent(id)}`);
    expect(url.search).toBe('');
    expect(url.hash).toBe('');
  });

  it.each([
    [400, 'OAuthException', 'Invalid OAuth access token', 'THREADS_AUTH_ERROR'],
    [
      400,
      'OAuthException',
      'Error validating access token: Session has expired',
      'THREADS_TOKEN_EXPIRED',
    ],
    [401, 'OAuthException', 'Invalid OAuth access token', 'THREADS_AUTH_ERROR'],
  ])(
    'maps HTTP %i %s: %s without exposing the token',
    async (status, type, message, code) => {
      networkFetch.mockResolvedValueOnce(
        response(
          { error: { type, message: `${message} ${token}` } },
          status as number
        )
      );
      const error = await failure();
      expect(error).toBeInstanceOf(RefreshToken);
      expect(error.message).toContain(code);
      expectSafeFailure(error);
    }
  );

  it.each([
    'Missing permission: threads_delete',
    'Requires threads_delete scope',
  ])('maps missing deletion permission: %s', async (message) => {
    networkFetch.mockResolvedValueOnce(
      response({ error: { message: `${message} ${token}` } }, 403)
    );
    const error = await failure();
    expect(error).toBeInstanceOf(BadBody);
    expect(error.message).toContain('THREADS_PERMISSION_MISSING');
    expectSafeFailure(error);
  });

  it.each([400, 404, 429, 500, 503])(
    'rejects HTTP %i without retrying or exposing the raw response',
    async (status) => {
      networkFetch.mockResolvedValueOnce(
        response({ error: { message: `API failure ${token}` } }, status)
      );
      const error = await failure();
      expect(error).toBeInstanceOf(BadBody);
      expect(error.message).toContain('THREADS_API_ERROR');
      expectSafeFailure(error);
    }
  );

  it('does not retry rate-limit errors even when the mapper marks them retryable', async () => {
    networkFetch.mockResolvedValueOnce(
      response(
        { error: { message: `Rate limit exceeded ${token}`, code: 4279009 } },
        429
      )
    );
    const error = await failure();
    expect(error.message).toContain('THREADS_RATE_LIMITED');
    expectSafeFailure(error);
  });

  it('does not expose a non-JSON error body', async () => {
    networkFetch.mockResolvedValueOnce(
      new Response(`upstream failure ${token}`, { status: 502 })
    );
    expectSafeFailure(await failure());
  });

  it('does not expose a rejected transport URL, token or cause', async () => {
    networkFetch.mockRejectedValueOnce(
      new Error(
        `https://graph.threads.net/v1.0/thread-123?access_token=${token}`
      )
    );
    const error = await failure();
    expect(error).toBeInstanceOf(BadBody);
    expect(error.cause).toBeUndefined();
    expectSafeFailure(error);
  });

  it('uses the existing scopes without adding OAuth permissions', () => {
    expect(THREADS_SCOPES).toContain('threads_delete');
    expect(provider.scopes).toEqual([...THREADS_SCOPES]);
    expect(networkFetch).not.toHaveBeenCalled();
  });
});
