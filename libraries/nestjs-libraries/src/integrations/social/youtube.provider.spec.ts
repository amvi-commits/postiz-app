import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate upload I/O from OAuth, decorators, and Temporal. The provider's
// actual resolver, file reads, and remote request branches run in these tests.
jest.mock('@gitroom/nestjs-libraries/services/make.secure.id', () => ({ makeSecureId: () => 'fixture-state' }), {
  virtual: true,
});
jest.mock('googleapis', () => ({ google: { auth: { OAuth2: jest.fn() }, youtube: jest.fn(), oauth2: jest.fn() } }));
jest.mock(
  '@gitroom/nestjs-libraries/dtos/posts/providers-settings/youtube.settings.dto',
  () => ({
    YoutubeSettingsDto: class {},
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/integrations/social.abstract',
  () => ({
    SocialAbstract: class { checkScopes = jest.fn(); },
    BadBody: class extends Error {},
    RefreshToken: class extends Error {},
    stripQuery: (value: string) => value.split('?')[0],
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/dtos/webhooks/ssrf.safe.dispatcher',
  () => ({
    getSsrfSafeDispatcher: jest.fn(() => 'ssrf-safe-dispatcher'),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/temporal/temporal.heartbeat',
  () => ({
    setHeartbeatDetails: jest.fn(),
  }),
  { virtual: true }
);
jest.mock(
  '@gitroom/nestjs-libraries/chat/rules.description.decorator',
  () => ({
    Rules: () => (target: unknown) => target,
  }),
  { virtual: true }
);

import { YoutubeProvider } from './youtube.provider';
import { google } from 'googleapis';

type UploadIo = {
  youtubeLocalUploadPath(url: string): string | null;
  youtubeMediaSize(url: string): Promise<number>;
  youtubeChunkStream(
    url: string,
    start: number,
    end: number
  ): Promise<AsyncIterable<Buffer>>;
};

describe('YouTube local upload I/O', () => {
  let fixtureRoot: string;
  let uploadRoot: string;
  let provider: UploadIo;
  let originalEnv: Array<[string, string | undefined]>;
  let fetchMock: jest.SpyInstance;

  beforeEach(() => {
    fixtureRoot = mkdtempSync(join(tmpdir(), 'youtube-upload-test-'));
    uploadRoot = join(fixtureRoot, 'uploads');
    mkdirSync(uploadRoot);
    writeFileSync(join(uploadRoot, 'test.mp4'), '0123456789');
    writeFileSync(join(fixtureRoot, 'outside.mp4'), 'outside');
    originalEnv = ['FRONTEND_URL', 'UPLOAD_DIRECTORY', 'STORAGE_PROVIDER'].map(
      (key) => [key, process.env[key]]
    );
    process.env.FRONTEND_URL = 'http://localhost:4007';
    process.env.UPLOAD_DIRECTORY = uploadRoot;
    process.env.STORAGE_PROVIDER = 'local';
    provider = new YoutubeProvider() as unknown as UploadIo;
    fetchMock = jest.spyOn(globalThis, 'fetch');
  });

  afterEach(() => {
    fetchMock.mockRestore();
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    rmSync(fixtureRoot, { recursive: true, force: true });
  });

  it('resolves an existing same-origin /uploads/test.mp4 inside the allowed root', () => {
    expect(
      provider.youtubeLocalUploadPath('http://localhost:4007/uploads/test.mp4')
    ).toBe(realpathSync(join(uploadRoot, 'test.mp4')));
  });

  it('reads local size and the requested byte range without an HTTP request', async () => {
    const url = 'http://localhost:4007/uploads/test.mp4';
    expect(await provider.youtubeMediaSize(url)).toBe(10);
    const chunks: Buffer[] = [];
    for await (const chunk of await provider.youtubeChunkStream(url, 2, 5))
      chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('2345');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects a bare filesystem path outside the upload root in both I/O methods', async () => {
    const path = join(fixtureRoot, 'outside.mp4');
    await expect(provider.youtubeMediaSize(path)).rejects.toThrow();
    await expect(provider.youtubeChunkStream(path, 0, 2)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('resolves a root-relative /uploads/ URL and reads only the configured upload root', async () => {
    const url = '/uploads/test.mp4';
    expect(provider.youtubeLocalUploadPath(url)).toBe(realpathSync(join(uploadRoot, 'test.mp4')));
    expect(await provider.youtubeMediaSize(url)).toBe(10);
    const chunks: Buffer[] = [];
    for await (const chunk of await provider.youtubeChunkStream(url, 2, 5)) chunks.push(chunk);
    expect(Buffer.concat(chunks).toString()).toBe('2345');
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each(['bare upload file', 'bare traversal', 'file URL'])(
    'rejects an unverified local input in both I/O methods: %s',
    async (input) => {
      const path = input === 'bare upload file'
        ? join(uploadRoot, 'test.mp4')
        : input === 'bare traversal'
          ? `${uploadRoot}/../outside.mp4`
          : `file://${join(fixtureRoot, 'outside.mp4')}`;
      await expect(provider.youtubeMediaSize(path)).rejects.toThrow();
      await expect(provider.youtubeChunkStream(path, 0, 2)).rejects.toThrow();
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it.each([
    '/uploads/../outside.mp4',
    '/uploads/nested/../test.mp4',
    '/uploads/%2foutside.mp4',
    '/outside.mp4',
  ])('rejects unsafe root-relative inputs without reading or fetching: %s', async (path) => {
    await expect(provider.youtubeMediaSize(path)).rejects.toThrow();
    await expect(provider.youtubeChunkStream(path, 0, 2)).rejects.toThrow();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects root-relative and bare paths through a symlink outside the upload root', async () => {
    symlinkSync(fixtureRoot, join(uploadRoot, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
    for (const path of ['/uploads/escape/outside.mp4', join(uploadRoot, 'escape', 'outside.mp4')]) {
      await expect(provider.youtubeMediaSize(path)).rejects.toThrow();
      await expect(provider.youtubeChunkStream(path, 0, 2)).rejects.toThrow();
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/uploads/../outside.mp4',
    '/uploads/nested/../test.mp4',
    '/uploads/nested/%2e%2e/test.mp4',
    '/uploads/nested%2f..%2ftest.mp4',
    '/uploads/%2e%2e/outside.mp4',
    '/uploads/..%2foutside.mp4',
    '/uploads/%2foutside.mp4',
    '/uploads/%',
    '/uploads/',
    '/outside.mp4',
    '/uploads-sibling/outside.mp4',
  ])(
    'rejects traversal, an absolute escape, or a non-upload path: %s',
    (path) => {
      expect(
        provider.youtubeLocalUploadPath(`http://localhost:4007${path}`)
      ).toBeNull();
    }
  );

  it('rejects a symlink whose target escapes the upload root', () => {
    symlinkSync(
      fixtureRoot,
      join(uploadRoot, 'escape'),
      process.platform === 'win32' ? 'junction' : 'dir'
    );
    expect(
      provider.youtubeLocalUploadPath(
        'http://localhost:4007/uploads/escape/outside.mp4'
      )
    ).toBeNull();
  });

  it.each([
    'https://localhost:4007/uploads/test.mp4',
    'http://localhost:4008/uploads/test.mp4',
    'https://media.example.test/uploads/test.mp4',
    'http://user:password@localhost:4007/uploads/test.mp4',
    'file:///uploads/test.mp4',
  ])(
    'does not convert an unexpected origin or scheme to a local file: %s',
    (url) => {
      expect(provider.youtubeLocalUploadPath(url)).toBeNull();
    }
  );

  it('does not enable local mapping for nonlocal storage or absent configuration', () => {
    process.env.STORAGE_PROVIDER = 's3';
    expect(
      provider.youtubeLocalUploadPath('http://localhost:4007/uploads/test.mp4')
    ).toBeNull();
    process.env.STORAGE_PROVIDER = 'local';
    delete process.env.UPLOAD_DIRECTORY;
    expect(
      provider.youtubeLocalUploadPath('http://localhost:4007/uploads/test.mp4')
    ).toBeNull();
  });

  it.each([
    'http://media.example.test/video.mp4',
    'https://media.example.test/video.mp4',
  ])(
    'keeps remote HEAD and ranged GET on the SSRF-safe dispatcher: %s',
    async (url) => {
      const remoteBody = { remote: true };
      fetchMock
        .mockResolvedValueOnce({
          headers: new Headers({ 'content-length': '10' }),
        })
        .mockResolvedValueOnce({ status: 206, body: remoteBody });
      expect(await provider.youtubeMediaSize(url)).toBe(10);
      expect(await provider.youtubeChunkStream(url, 2, 5)).toBe(remoteBody);
      expect(fetchMock).toHaveBeenNthCalledWith(1, url, {
        method: 'HEAD',
        headers: { 'accept-encoding': 'identity' },
        dispatcher: 'ssrf-safe-dispatcher',
      });
      expect(fetchMock).toHaveBeenNthCalledWith(2, url, {
        headers: { Range: 'bytes=2-5', 'accept-encoding': 'identity' },
        dispatcher: 'ssrf-safe-dispatcher',
      });
    }
  );

  it('still rejects remote storage responses that ignore the requested range', async () => {
    fetchMock.mockResolvedValue({ status: 200, body: 'full-file' });
    await expect(
      provider.youtubeChunkStream('https://media.example.test/video.mp4', 2, 5)
    ).rejects.toThrow();
  });
});

describe('YouTube OAuth and channel adapter', () => {
  let originalEnv: Array<[string, string | undefined]>;
  let client: { generateAuthUrl: jest.Mock; setCredentials: jest.Mock; getToken: jest.Mock; getTokenInfo: jest.Mock };
  let list: jest.Mock;
  const channel = { id: 'fixture-channel-id', snippet: { title: 'Fixture Channel', customUrl: '@fixture-channel', thumbnails: { default: { url: 'https://example.test/channel.png' } } }, statistics: { subscriberCount: '1' } };

  beforeEach(() => {
    originalEnv = ['FRONTEND_URL', 'YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'].map((key) => [key, process.env[key]]);
    process.env.FRONTEND_URL = 'http://localhost:4017';
    process.env.YOUTUBE_CLIENT_ID = 'fixture-client';
    process.env.YOUTUBE_CLIENT_SECRET = 'fixture-secret';
    client = {
      generateAuthUrl: jest.fn(() => 'https://accounts.example.test/oauth'),
      setCredentials: jest.fn(),
      getToken: jest.fn(async () => ({ tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh', expiry_date: Date.now() + 3600000 } })),
      getTokenInfo: jest.fn(async () => ({ scopes: [] })),
    };
    (google.auth.OAuth2 as unknown as jest.Mock).mockImplementation(() => client);
    list = jest.fn(async () => ({ data: { items: [channel] } }));
    (google.youtube as jest.Mock).mockReturnValue({ channels: { list } });
    (google.oauth2 as jest.Mock).mockReturnValue({ userinfo: { get: jest.fn(async () => ({ data: { id: 'fixture-user', name: 'Fixture User' } })) } });
  });
  afterEach(() => {
    for (const [key, value] of originalEnv) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    jest.clearAllMocks();
  });

  it('uses the configured frontend callback and a nonempty state', async () => {
    const auth = await new YoutubeProvider().generateAuthUrl();
    expect(google.auth.OAuth2).toHaveBeenCalledWith({ clientId: 'fixture-client', clientSecret: 'fixture-secret', redirectUri: 'http://localhost:4017/integrations/social/youtube' });
    expect(client.generateAuthUrl).toHaveBeenCalledWith(expect.objectContaining({ redirect_uri: 'http://localhost:4017/integrations/social/youtube', state: auth.state, access_type: 'offline' }));
    expect(auth.state).toBeTruthy();
  });
  it.each(['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET'])('rejects missing credentials: %s', async (key) => {
    delete process.env[key];
    await expect(new YoutubeProvider().generateAuthUrl()).rejects.toThrow('credentials are not configured');
    expect(client.generateAuthUrl).not.toHaveBeenCalled();
  });
  it('keeps the OAuth callback token exchange', async () => {
    const result = await new YoutubeProvider().authenticate({ code: 'fixture-code', codeVerifier: 'fixture-verifier' });
    expect(client.getToken).toHaveBeenCalledWith('fixture-code');
    expect(result).toEqual(expect.objectContaining({ id: 'fixture-user', accessToken: 'fixture-access', refreshToken: 'fixture-refresh' }));
  });
  it('maps authorized channels and their handles', async () => {
    expect(await new YoutubeProvider().pages('fixture-access')).toEqual([expect.objectContaining({ id: channel.id, name: 'Fixture Channel', username: '@fixture-channel' })]);
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ mine: true }));
  });
  it('fetches the selected channel without changing its identity', async () => {
    expect(await new YoutubeProvider().fetchPageInformation('fixture-access', { id: channel.id })).toEqual(expect.objectContaining({ id: channel.id, name: 'Fixture Channel', username: '@fixture-channel' }));
    expect(list).toHaveBeenCalledWith(expect.objectContaining({ id: [channel.id] }));
  });
});
