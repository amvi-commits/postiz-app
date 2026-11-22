jest.mock('@gitroom/nestjs-libraries/database/prisma/prisma.service', () => ({
  PrismaService: class {},
}));
jest.mock(
  '@gitroom/nestjs-libraries/database/prisma/media/media.service',
  () => ({ MediaService: class {} })
);
jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({
  IntegrationManager: class {},
}));

import { ThreadsPostReuseService } from './threads-post-reuse.service';

describe('Threads public account post reuse', () => {
  const findFirst = jest.fn();
  const fetchPublicProfilePosts = jest.fn();
  const uploadFromUrl = jest.fn();
  const service = new ThreadsPostReuseService(
    { integration: { findFirst } } as any,
    { getSocialIntegration: () => ({ fetchPublicProfilePosts }) } as any,
    { uploadFromUrl } as any
  );
  const image = {
    id: 'image-asset',
    media_type: 'IMAGE',
    media_url: 'https://media.cdninstagram.com/image.jpg',
  };
  const video = {
    id: 'video-asset',
    media_type: 'VIDEO',
    media_url: 'https://video.fbcdn.net/video.mp4',
  };
  const album = {
    id: 'album',
    username: 'public.author',
    media_type: 'CAROUSEL_ALBUM',
    children: { data: [image, video] },
  };
  const input = {
    username: '@public.author',
    postId: 'album',
    confirmedRights: true,
  };

  beforeEach(() => {
    jest.resetAllMocks();
    findFirst.mockResolvedValue({ internalId: '1234', token: 'fixture-only' });
    fetchPublicProfilePosts.mockResolvedValue({
      posts: [album],
      nextCursor: null,
    });
    uploadFromUrl.mockImplementation(async (_org, url: string) => ({
      id: url.includes('image') ? 'image' : 'video',
      path: '/uploads/' + url.split('/').pop(),
    }));
  });

  it('uses the selected org connection only for authorization and queries the public username', async () => {
    fetchPublicProfilePosts.mockResolvedValue({
      posts: [
        album,
        { id: 'other', username: 'different' },
        { id: 'text', text: '本文' },
        image,
        video,
      ],
      nextCursor: 'next',
    });
    const result = await service.list(
      'org-a',
      'my-auth-account',
      '@public.author',
      'current'
    );
    expect(findFirst.mock.calls[0][0].where).toEqual({
      id: 'my-auth-account',
      providerIdentifier: 'threads',
      organizationId: 'org-a',
      deletedAt: null,
    });
    expect(fetchPublicProfilePosts).toHaveBeenCalledWith('fixture-only', {
      username: 'public.author',
      after: 'current',
      limit: 20,
    });
    expect(result.posts.map(({ id, mediaCount }) => [id, mediaCount])).toEqual([
      ['album', 2],
      ['text', 0],
      ['image-asset', 1],
      ['video-asset', 1],
    ]);
    expect(result.nextCursor).toBe('next');
    expect(JSON.stringify(result)).not.toMatch(
      /fixture-only|cdninstagram|fbcdn/
    );
    expect(uploadFromUrl).not.toHaveBeenCalled();
  });

  it('extracts the handle from an HTTPS Threads profile URL', async () => {
    await service.list(
      'org-a',
      'connection',
      'https://www.threads.com/@public.author/'
    );
    expect(fetchPublicProfilePosts).toHaveBeenCalledWith(
      'fixture-only',
      expect.objectContaining({ username: 'public.author' })
    );
  });

  it.each([
    '',
    'https://example.test/@public.author',
    'https://threads.com/@public.author/post/abc',
    'public/author',
  ])('rejects invalid username without a Graph call: %s', async (username) => {
    await expect(service.list('org-a', 'connection', username)).rejects.toThrow(
      'ユーザー名'
    );
    expect(fetchPublicProfilePosts).not.toHaveBeenCalled();
  });

  it('rejects unavailable connections and does not fall back to other organizations', async () => {
    findFirst.mockResolvedValue(null);
    await expect(
      service.list('org-a', 'org-b-connection', 'public.author')
    ).rejects.toThrow('見つかりません');
    expect(fetchPublicProfilePosts).not.toHaveBeenCalled();
  });

  it('rejects Browser-only connections before the external read', async () => {
    findFirst.mockResolvedValue({
      internalId: 'threads-browser:main',
      token: 'fixture-only',
    });
    await expect(
      service.list('org-a', 'browser', 'public.author')
    ).rejects.toThrow('公式API');
    expect(fetchPublicProfilePosts).not.toHaveBeenCalled();
  });

  it('reports missing external access without exposing provider details', async () => {
    fetchPublicProfilePosts.mockRejectedValue(
      new Error('sensitive upstream response')
    );
    await expect(
      service.list('org-a', 'connection', 'public.author')
    ).rejects.toThrow('threads_profile_discovery');
  });

  it('imports the image and video in carousel order into this organization', async () => {
    const imported = await service.importMedia('org-a', 'connection', input);
    expect(
      uploadFromUrl.mock.calls.map(([org, url, opts]) => [
        org,
        url,
        opts.redirect,
      ])
    ).toEqual([
      ['org-a', image.media_url, 'error'],
      ['org-a', video.media_url, 'error'],
    ]);
    expect(imported).toEqual({
      media: [
        { id: 'image', path: '/uploads/image.jpg' },
        { id: 'video', path: '/uploads/video.mp4' },
      ],
      failed: 0,
    });
  });

  it('reports partial imports so the form can continue with the successful asset', async () => {
    uploadFromUrl.mockRejectedValueOnce(new Error('expired media'));
    await expect(
      service.importMedia('org-a', 'connection', input)
    ).resolves.toEqual({
      media: [{ id: 'video', path: '/uploads/video.mp4' }],
      failed: 1,
    });
  });

  it('requires permission confirmation and an ID present in the requested feed', async () => {
    await expect(
      service.importMedia('org-a', 'connection', {
        ...input,
        confirmedRights: false,
      })
    ).rejects.toThrow();
    expect(fetchPublicProfilePosts).not.toHaveBeenCalled();
    await expect(
      service.importMedia('org-a', 'connection', {
        ...input,
        postId: 'not-in-feed',
      })
    ).rejects.toThrow();
    expect(uploadFromUrl).not.toHaveBeenCalled();
  });

  it('loads only HTTPS multimedia files on the permitted CDNs', async () => {
    fetchPublicProfilePosts.mockResolvedValue({
      posts: [
        {
          ...image,
          id: 'bad',
          media_url: 'https://cdninstagram.com.example.test/image.jpg',
        },
      ],
      nextCursor: null,
    });
    const page = await service.list('org-a', 'connection', 'public.author');
    expect(page.posts[0].mediaUnavailable).toBe(true);
    await expect(
      service.importMedia('org-a', 'connection', { ...input, postId: 'bad' })
    ).rejects.toThrow();
    expect(uploadFromUrl).not.toHaveBeenCalled();
  });
});
