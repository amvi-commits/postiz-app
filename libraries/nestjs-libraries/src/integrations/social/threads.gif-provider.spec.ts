import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { Integration } from '@prisma/client';
import { ThreadsDto } from '../../dtos/posts/providers-settings/threads.dto';
import type { PostDetails } from './social.integrations.interface';
import type {
  ThreadsGifAttachment,
  ThreadsSettingsData,
} from './threads.capabilities';
import { ThreadsValidationRules } from './threads.capabilities';
import { ThreadsProvider } from './threads.provider';

describe('Threads GIF provider contract', () => {
  const integration = {
    internalId: 'test-user',
    profile: 'test-account',
  } as Integration;
  let provider: ThreadsProvider;
  let metaFetch: jest.SpyInstance;
  let networkFetch: jest.SpyInstance;

  const posts = (
    gifAttachment: { gif_id: string; provider?: unknown },
    mediaCount = 0
  ): PostDetails<ThreadsSettingsData>[] => [
    {
      id: 'test-post',
      message: 'GIF contract test',
      settings: { gifAttachment: gifAttachment as ThreadsGifAttachment },
      media: Array.from({ length: mediaCount }, () => ({
        type: 'image' as const,
        path: 'https://example.invalid/test.jpg',
      })),
    },
  ];

  beforeEach(() => {
    networkFetch = jest
      .spyOn(globalThis, 'fetch')
      .mockImplementation(async () => {
        throw new Error(
          'Real network access is forbidden in GIF contract tests'
        );
      });
    provider = new ThreadsProvider();
    metaFetch = jest.spyOn(provider as any, 'fetch').mockResolvedValue({
      json: async () => ({ id: 'test-container' }),
    });
  });

  afterEach(() => {
    try {
      expect(networkFetch).not.toHaveBeenCalled();
    } finally {
      jest.restoreAllMocks();
    }
  });

  it.each([
    ['omitted', { gif_id: 'giphy-test-id' }],
    ['explicit GIPHY', { gif_id: 'giphy-test-id', provider: 'GIPHY' }],
  ] as const)(
    '%s emits exactly one GIPHY attachment without mutating settings',
    async (_label, gif) => {
      const input = Object.freeze(gif);
      await provider.postPending(
        'test-user',
        'test-token',
        posts(input),
        integration
      );
      expect(metaFetch).toHaveBeenCalledTimes(1);
      const form = metaFetch.mock.calls[0][1].body as FormData;
      const attachments = form.getAll('gif_attachment');
      expect(attachments).toHaveLength(1);
      const payload = attachments[0] as string;
      expect(JSON.parse(payload)).toEqual({
        gif_id: 'giphy-test-id',
        provider: 'GIPHY',
      });
      expect(payload.match(/"provider"/g) || []).toHaveLength(1);
      expect(input).toEqual(gif);
    }
  );

  describe.each(['TENOR', 'UNKNOWN', '', null, 123])(
    'invalid provider %s',
    (rawProvider) => {
      it.each([0, 1, 2])(
        'rejects before any Meta fetch with %i media',
        async (mediaCount) => {
          const gif = Object.freeze({
            gif_id: 'legacy-gif-id',
            provider: rawProvider,
          });
          await expect(
            provider.postPending(
              'test-user',
              'test-token',
              posts(gif, mediaCount),
              integration
            )
          ).rejects.toThrow(
            ThreadsValidationRules.gifProviderError(rawProvider)
          );
          expect(metaFetch).not.toHaveBeenCalled();
          expect(gif.provider).toBe(rawProvider);
        }
      );
    }
  );

  describe.each(['TENOR', 'UNKNOWN'])('saved provider %s', (rawProvider) => {
    const error = ThreadsValidationRules.gifProviderError(rawProvider);
    const gif = Object.freeze({
      gif_id: 'legacy-gif-id',
      provider: rawProvider,
    });

    it('rejects the direct post path before any Meta fetch', async () => {
      await expect(
        provider.post('test-user', 'test-token', posts(gif), integration)
      ).rejects.toThrow(error);
      expect(metaFetch).not.toHaveBeenCalled();
    });

    it('rejects a reply before any Meta fetch', async () => {
      await expect(
        provider.comment(
          'test-user',
          'parent-post',
          undefined,
          'test-token',
          posts(gif, 1),
          integration
        )
      ).rejects.toThrow(error);
      expect(metaFetch).not.toHaveBeenCalled();
    });

    it('guards text serialization even when called without postPending', async () => {
      await expect(
        (provider as any).createTextContent(
          'test-user',
          'test-token',
          'test',
          undefined,
          undefined,
          posts(gif)[0].settings
        )
      ).rejects.toThrow(error);
      expect(metaFetch).not.toHaveBeenCalled();
    });

    it.each(['children', 'container'] as const)(
      'rejects saved %s status and finalization without fetching',
      async (step) => {
        const pendingData = {
          step,
          childIds: ['test-child'],
          containerId: 'test-container',
          settings: posts(gif)[0].settings,
        };
        await expect(
          provider.checkPostStatus('test-token', pendingData, integration)
        ).rejects.toThrow(error);
        await expect(
          provider.finalizePost('test-token', pendingData, integration)
        ).rejects.toThrow(error);
        expect(metaFetch).not.toHaveBeenCalled();
        expect(pendingData.settings.gifAttachment?.provider).toBe(rawProvider);
      }
    );
  });

  describe('nested DTO validation', () => {
    it.each([undefined, 'GIPHY'])('accepts provider %s', (rawProvider) => {
      const dto = plainToInstance(ThreadsDto, {
        gifAttachment: { gif_id: 'giphy-test-id', provider: rawProvider },
      });
      expect(validateSync(dto)).toEqual([]);
    });

    it.each(['TENOR', 'UNKNOWN'])(
      'rejects provider %s with a clear selection error',
      (rawProvider) => {
        const dto = plainToInstance(ThreadsDto, {
          gifAttachment: { gif_id: 'legacy-gif-id', provider: rawProvider },
        });
        const gifError = validateSync(dto).find(
          (entry) => entry.property === 'gifAttachment'
        );
        const providerError = gifError?.children?.find(
          (entry) => entry.property === 'provider'
        );
        expect(providerError?.constraints?.isIn).toBe(
          ThreadsValidationRules.gifProviderError(rawProvider)
        );
      }
    );
  });
});
