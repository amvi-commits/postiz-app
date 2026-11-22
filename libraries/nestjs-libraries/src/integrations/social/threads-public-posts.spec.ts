import { THREADS_BASE_GRAPH_URL } from './threads.capabilities';
import { ThreadsProvider } from './threads.provider';

describe('Threads public profile posts HTTP contract', () => {
  const provider = new ThreadsProvider();
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fetchMock = jest.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('Unexpected request'));
  });

  afterEach(() => jest.restoreAllMocks());

  it('reads the requested profile with a bounded page and exposes only the next cursor', async () => {
    const post = { id: 'id', media_type: 'CAROUSEL_ALBUM', text: 'example' };
    fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({
      data: [post],
      paging: { next: 'https://example.test/ignored', cursors: { after: 'next-page' } },
    })));
    const result = await provider.fetchPublicProfilePosts('fixture-token', {
      username: 'public.author', after: 'page', limit: 20,
    });
    const [url, request] = fetchMock.mock.calls[0];
    expect(url.origin + url.pathname).toBe(`${THREADS_BASE_GRAPH_URL}/profile_posts`);
    expect(url.searchParams.get('username')).toBe('public.author');
    expect(url.searchParams.get('after')).toBe('page');
    expect(url.searchParams.get('limit')).toBe('20');
    expect(url.searchParams.get('fields')).toContain('children{id,media_type,media_url}');
    expect(url.searchParams.has('access_token')).toBe(false);
    expect(request).toMatchObject({ headers: { Authorization: 'Bearer fixture-token' }, redirect: 'error' });
    expect(result).toEqual({ posts: [post], nextCursor: 'next-page' });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('stops on a permission error without returning upstream details or retrying', async () => {
    fetchMock.mockResolvedValueOnce(new Response('upstream message', { status: 403 }));
    await expect(provider.fetchPublicProfilePosts('fixture-token', {
      username: 'public.author', limit: 20,
    })).rejects.toThrow('Threads read request failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
