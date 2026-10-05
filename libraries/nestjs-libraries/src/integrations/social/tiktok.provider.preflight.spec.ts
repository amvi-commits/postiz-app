import { TiktokProvider } from './tiktok.provider';

describe('TiktokProvider preflight boundary', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('captures the Personal DIRECT_POST request immediately before network dispatch', async () => {
    const provider = new TiktokProvider() as any;
    const networkBlocked = new Error('PRE_PROVIDER_NETWORK_GUARD');
    let capturedRequest: Record<string, unknown> | undefined;

    provider.mediaSize = jest.fn().mockResolvedValue(1024 * 1024);
    provider.fetch = jest.fn(async (url: string, options: RequestInit) => {
      const headers = options.headers as Record<string, string>;
      capturedRequest = {
        url,
        method: options.method,
        body: JSON.parse(String(options.body)),
        authorizationHeaderPresent: typeof headers.Authorization === 'string',
      };
      throw networkBlocked;
    });
    const outboundFetch = jest.fn();
    global.fetch = outboundFetch as any;

    await expect(
      provider.postPending(
        'post-preflight-test',
        'test-token-redacted',
        [
          {
            id: 'post-preflight-test',
            message: 'SNS Studio TikTok Sandbox preflight test',
            media: [
              { path: 'https://media.example.invalid/preflight-test.mp4' },
            ],
            settings: {
              __type: 'tiktok',
              content_posting_method: 'DIRECT_POST',
              privacy_level: 'PUBLIC_TO_EVERYONE',
              duet: false,
              stitch: false,
              comment: true,
              brand_content_toggle: false,
              brand_organic_toggle: false,
              video_made_with_ai: false,
            },
          },
        ],
        {} as any
      )
    ).rejects.toBe(networkBlocked);

    expect(provider.mediaSize).toHaveBeenCalledWith(
      'https://media.example.invalid/preflight-test.mp4',
      'tiktok-error-upload'
    );
    expect(provider.fetch).toHaveBeenCalledTimes(1);
    expect(capturedRequest).toEqual({
      url: 'https://open.tiktokapis.com/v2/post/publish/video/init/',
      method: 'POST',
      body: {
        post_info: {
          title: 'SNS Studio TikTok Sandbox preflight test',
          privacy_level: 'PUBLIC_TO_EVERYONE',
          disable_duet: true,
          disable_comment: false,
          disable_stitch: true,
          is_aigc: false,
          brand_content_toggle: false,
          brand_organic_toggle: false,
        },
        source_info: {
          source: 'FILE_UPLOAD',
          video_size: 1024 * 1024,
          chunk_size: 1024 * 1024,
          total_chunk_count: 1,
        },
      },
      authorizationHeaderPresent: true,
    });
    expect(outboundFetch).not.toHaveBeenCalled();
  });
});
