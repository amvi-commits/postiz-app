import {
  ProviderPublishPreCreateContext,
  ProviderPublishPreCreateHook,
  ProviderPublishPreCreateProtection,
} from './provider-publish-pre-create-protection.service';

function makeContext(
  providers: Array<{ integrationId: string; providerIdentifier: string }>
): ProviderPublishPreCreateContext {
  return {
    organizationId: 'org-hook-test',
    type: 'now',
    publishDate: new Date().toISOString(),
    contentPlanId: 'plan-hook-test',
    posts: providers.map(({ integrationId, providerIdentifier }) => ({
      integration: { id: integrationId },
      value: [{ content: `${providerIdentifier} caption`, image: [] }],
      settings: { __type: providerIdentifier } as any,
    })) as any,
  };
}

describe('ProviderPublishPreCreateProtection', () => {
  it('keeps the existing create path unchanged when no provider hook applies', async () => {
    const protection = new ProviderPublishPreCreateProtection([]);
    const recheckCommonPolicy = jest.fn();
    const createPost = jest.fn().mockResolvedValue('created');

    await expect(
      protection.run(
        makeContext([{ integrationId: 'instagram-1', providerIdentifier: 'instagram' }]),
        recheckCommonPolicy,
        createPost
      )
    ).resolves.toBe('created');

    expect(recheckCommonPolicy).not.toHaveBeenCalled();
    expect(createPost).toHaveBeenCalledTimes(1);
  });

  it('passes only the matching provider posts to a hook and preserves cross-post data', async () => {
    let receivedContext: ProviderPublishPreCreateContext | undefined;
    const hook: ProviderPublishPreCreateHook = {
      providerIdentifier: 'tiktok',
      protect: jest.fn(async (context, _recheck, createPost) => {
        receivedContext = context;
        return createPost();
      }),
    };
    const protection = new ProviderPublishPreCreateProtection([hook]);
    const context = makeContext([
      { integrationId: 'tiktok-1', providerIdentifier: 'tiktok' },
      { integrationId: 'instagram-1', providerIdentifier: 'instagram' },
    ]);
    const createPost = jest.fn().mockResolvedValue('created');

    await expect(
      protection.run(context, jest.fn(), createPost)
    ).resolves.toBe('created');

    expect(receivedContext?.posts).toHaveLength(1);
    expect(receivedContext?.posts[0].integration.id).toBe('tiktok-1');
    expect(createPost).toHaveBeenCalledTimes(1);
    expect(context.posts).toHaveLength(2);
  });
});
