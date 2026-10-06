import { Inject, Injectable } from '@nestjs/common';
import { CreatePostDto, Post } from '@gitroom/nestjs-libraries/dtos/posts/create.post.dto';

export type ProviderPublishPreCreateContext = {
  organizationId: string;
  type: CreatePostDto['type'];
  publishDate: string;
  contentPlanId?: string;
  posts: Post[];
};

export interface ProviderPublishPreCreateHook {
  readonly providerIdentifier: string;
  protect<T>(
    context: ProviderPublishPreCreateContext,
    recheckCommonPolicy: (posts: Post[]) => Promise<void>,
    createPost: () => Promise<T>
  ): Promise<T>;
}

export const PROVIDER_PUBLISH_PRE_CREATE_HOOKS = Symbol(
  'PROVIDER_PUBLISH_PRE_CREATE_HOOKS'
);

@Injectable()
export class ProviderPublishPreCreateProtection {
  private readonly hooksByProvider: Map<string, ProviderPublishPreCreateHook>;

  constructor(
    @Inject(PROVIDER_PUBLISH_PRE_CREATE_HOOKS)
    hooks: ProviderPublishPreCreateHook[] = []
  ) {
    this.hooksByProvider = new Map(
      hooks.map((hook) => [hook.providerIdentifier, hook])
    );
  }

  run<T>(
    context: ProviderPublishPreCreateContext,
    recheckCommonPolicy: (posts: Post[]) => Promise<void>,
    createPost: () => Promise<T>
  ): Promise<T> {
    const providerIdentifiers = Array.from(
      new Set(
        context.posts.flatMap((post) => {
          const providerIdentifier = post.settings?.__type;
          return providerIdentifier ? [providerIdentifier] : [];
        })
      )
    ).sort();

    const hooks = providerIdentifiers
      .map((providerIdentifier) => this.hooksByProvider.get(providerIdentifier))
      .filter((hook): hook is ProviderPublishPreCreateHook => !!hook);

    let run = createPost;
    for (const hook of hooks.reverse()) {
      const next = run;
      const providerPosts = context.posts.filter(
        (post) => post.settings?.__type === hook.providerIdentifier
      );
      run = () =>
        hook.protect(
          { ...context, posts: providerPosts },
          recheckCommonPolicy,
          next
        );
    }

    return run();
  }
}
