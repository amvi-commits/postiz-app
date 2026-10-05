import {
  AnalyticsData,
  AuthTokenDetails,
  PendingCheckResponse,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { makeSecureId } from '@gitroom/nestjs-libraries/services/make.secure.id';
import { timer } from '@gitroom/helpers/utils/timer';
import dayjs from 'dayjs';
import {
  BadBody,
  RefreshToken,
  SocialAbstract,
} from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { capitalize, chunk } from 'lodash';
import { Plug } from '@gitroom/helpers/decorators/plug.decorator';
import { Integration } from '@prisma/client';
import { stripHtmlValidation } from '@gitroom/helpers/utils/strip.html.validation';
import { hasExtension } from '@gitroom/helpers/utils/has.extension';
import { ThreadsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/threads.dto';
import {
  ThreadsSettingsData,
  ThreadsValidationRules,
  mapThreadsApiError,
  THREADS_SCOPES,
  THREADS_BASE_GRAPH_URL,
} from '@gitroom/nestjs-libraries/integrations/social/threads.capabilities';

export class ThreadsProvider extends SocialAbstract implements SocialProvider {
  identifier = 'threads';
  name = 'Threads';
  isBetweenSteps = false;
  scopes = [...THREADS_SCOPES];
  override maxConcurrentJob = 2; // Threads has moderate rate limits
  refreshCron = true;
  dto = ThreadsDto;

  editor = 'normal' as const;
  maxLength() {
    return 500;
  }

  override async checkValidity(
    [firstPost, ...comments]: Array<{ path: string }[]>,
    settings: any
  ): Promise<string | true> {
    const mediaCount = (firstPost?.length || 0) + comments.flat().length;
    const validation = ThreadsValidationRules.validate({
      mediaCount,
      settings,
    });
    if (!validation.isValid) {
      return validation.errors[0];
    }
    return true;
  }

  override handleErrors(body: string):
    | {
        type: 'refresh-token' | 'bad-body' | 'retry';
        value: string;
      }
    | undefined {
    console.log(body);
    const mapped = mapThreadsApiError(body);
    if (mapped.category === 'token_expired' || mapped.category === 'auth') {
      return { type: 'refresh-token', value: mapped.userMessage };
    }
    if (mapped.isRetryable) {
      return { type: 'retry', value: mapped.userMessage };
    }
    if (body.includes('Error') || body.includes('error') || body.includes('code')) {
      return {
        type: 'bad-body',
        value: `${mapped.userMessage} (${mapped.suggestedAction})`,
      };
    }

    return undefined;
  }

  async refreshToken(refresh_token: string): Promise<AuthTokenDetails> {
    const { access_token } = await (
      await this.fetch(
        `https://graph.threads.net/refresh_access_token?grant_type=th_refresh_token&access_token=${refresh_token}`
      )
    ).json();

    const { id, name, username, picture } = await this.fetchUserInfo(
      access_token
    );

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: picture || '',
      username: '',
    };
  }

  async generateAuthUrl() {
    const state = makeSecureId(6);
    return {
      url:
        'https://www.threads.net/oauth/authorize' +
        `?client_id=${process.env.THREADS_APP_ID}` +
        `&redirect_uri=${encodeURIComponent(
          `${
            process?.env.FRONTEND_URL?.indexOf('https') == -1
              ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
              : `${process?.env.FRONTEND_URL}`
          }/integrations/social/threads`
        )}` +
        `&response_type=code` +
        `&state=${state}` +
        `&scope=${encodeURIComponent(this.scopes.join(','))}`,
      codeVerifier: makeSecureId(10),
      state,
    };
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const getAccessToken = await (
      await this.fetch(
        'https://graph.threads.net/oauth/access_token' +
          `?client_id=${process.env.THREADS_APP_ID}` +
          `&redirect_uri=${encodeURIComponent(
            `${
              process?.env.FRONTEND_URL?.indexOf('https') == -1
                ? `https://redirectmeto.com/${process?.env.FRONTEND_URL}`
                : `${process?.env.FRONTEND_URL}`
            }/integrations/social/threads`
          )}` +
          `&grant_type=authorization_code` +
          `&client_secret=${process.env.THREADS_APP_SECRET}` +
          `&code=${params.code}`
      )
    ).json();

    const { access_token } = await (
      await this.fetch(
        'https://graph.threads.net/access_token' +
          '?grant_type=th_exchange_token' +
          `&client_secret=${process.env.THREADS_APP_SECRET}` +
          `&access_token=${getAccessToken.access_token}`
      )
    ).json();

    const { id, name, username, picture } = await this.fetchUserInfo(
      access_token
    );

    return {
      id,
      name,
      accessToken: access_token,
      refreshToken: access_token,
      expiresIn: dayjs().add(58, 'days').unix() - dayjs().unix(),
      picture: picture || '',
      username: username,
    };
  }

  // Single, read-only status check of a media container - no loops and no
  // timers, so the post workflow can poll it with durable timers.
  private async checkContainerStatus(
    mediaContainerId: string,
    accessToken: string
  ): Promise<'FINISHED' | 'IN_PROGRESS' | 'PUBLISHED'> {
    const { status, error_message } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${mediaContainerId}?fields=status,error_message&access_token=${accessToken}`
      )
    ).json();

    if (status === 'ERROR' || status === 'EXPIRED') {
      throw new BadBody(
        this.identifier,
        JSON.stringify({ status, error_message }),
        '{}',
        error_message && error_message !== 'UNKNOWN'
          ? error_message
          : 'Threads could not process the media, please check the media format and try again'
      );
    }

    if (status === 'FINISHED' || status === 'PUBLISHED') {
      return status;
    }

    return 'IN_PROGRESS';
  }

  private async checkLoaded(
    mediaContainerId: string,
    accessToken: string
  ): Promise<boolean> {
    // Bounded (the old version recursed forever and could hang the activity
    // into a timeout): ~5.5 minutes at 2.2s intervals.
    for (let i = 0; i < 150; i++) {
      const status = await this.checkContainerStatus(
        mediaContainerId,
        accessToken
      );

      if (status === 'FINISHED' || status === 'PUBLISHED') {
        await timer(2000);
        return true;
      }

      await timer(2200);
    }

    throw new BadBody(
      this.identifier,
      '{}',
      '{}',
      'Threads took too long to process the media, please try again'
    );
  }

  private async fetchUserInfo(accessToken: string) {
    const { id, username, threads_profile_picture_url } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/me?fields=id,username,threads_profile_picture_url&access_token=${accessToken}`
      )
    ).json();

    return {
      id,
      name: username,
      picture: threads_profile_picture_url || '',
      username,
    };
  }

  private async createSingleMediaContent(
    userId: string,
    accessToken: string,
    media: { path: string; alt?: string },
    message: string,
    isCarouselItem = false,
    replyToId?: string,
    settings?: ThreadsSettingsData
  ): Promise<string> {
    const mediaType = hasExtension(media.path, 'mp4')
      ? 'video_url'
      : 'image_url';
    const mediaParams: Record<string, string> = {
      ...(mediaType === 'video_url' ? { video_url: media.path } : {}),
      ...(mediaType === 'image_url' ? { image_url: media.path } : {}),
      ...(isCarouselItem ? { is_carousel_item: 'true' } : {}),
      ...(replyToId ? { reply_to_id: replyToId } : {}),
      media_type: mediaType === 'video_url' ? 'VIDEO' : 'IMAGE',
      text: isCarouselItem ? '' : message,
      access_token: accessToken,
    };

    const effectiveAltText = media.alt || settings?.altText;
    if (effectiveAltText) {
      mediaParams.alt_text = effectiveAltText;
    }

    if (settings?.isSpoilerMedia) {
      mediaParams.is_spoiler_media = 'true';
    }

    if (!isCarouselItem) {
      if (settings?.topicTag) {
        mediaParams.topic_tag = settings.topicTag.replace(/^#/, '');
      }
      if (settings?.locationId) {
        mediaParams.location_id = settings.locationId;
      }
      if (settings?.replyControl) {
        mediaParams.reply_control = settings.replyControl;
      }
      if (settings?.enableReplyApprovals) {
        mediaParams.enable_reply_approvals = 'true';
      }
      if (settings?.quotePostId) {
        mediaParams.quote_post_id = settings.quotePostId;
      }
      if (settings?.textSpoilerRanges?.length) {
        mediaParams.text_entities = JSON.stringify(
          settings.textSpoilerRanges.map((r) => ({
            entity_type: 'SPOILER',
            offset: r.offset,
            length: r.length,
          }))
        );
      }
    }

    const searchParams = new URLSearchParams(mediaParams);
    const response = await this.fetch(
      `https://graph.threads.net/v1.0/${userId}/threads?${searchParams.toString()}`,
      { method: 'POST' }
    );
    const data = await response.json();
    if (!data.id) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(data),
        '{}',
        data.error?.message || 'Failed to create Threads media container'
      );
    }
    return data.id;
  }

  private async createCarouselContent(
    userId: string,
    accessToken: string,
    media: { path: string; alt?: string }[],
    message: string,
    replyToId?: string,
    settings?: ThreadsSettingsData
  ): Promise<string> {
    const mediaIds = [];
    for (const mediaItem of media) {
      const mediaId = await this.createSingleMediaContent(
        userId,
        accessToken,
        mediaItem,
        message,
        true,
        undefined,
        settings
      );
      mediaIds.push(mediaId);
    }

    await Promise.all(
      mediaIds.map((id: string) => this.checkLoaded(id, accessToken))
    );

    const params: Record<string, string> = {
      text: message,
      media_type: 'CAROUSEL',
      children: mediaIds.join(','),
      ...(replyToId ? { reply_to_id: replyToId } : {}),
      access_token: accessToken,
    };

    if (settings?.topicTag) {
      params.topic_tag = settings.topicTag.replace(/^#/, '');
    }
    if (settings?.locationId) {
      params.location_id = settings.locationId;
    }
    if (settings?.replyControl) {
      params.reply_control = settings.replyControl;
    }
    if (settings?.enableReplyApprovals) {
      params.enable_reply_approvals = 'true';
    }
    if (settings?.quotePostId) {
      params.quote_post_id = settings.quotePostId;
    }
    if (settings?.isSpoilerMedia) {
      params.is_spoiler_media = 'true';
    }
    if (settings?.textSpoilerRanges?.length) {
      params.text_entities = JSON.stringify(
        settings.textSpoilerRanges.map((r) => ({
          entity_type: 'SPOILER',
          offset: r.offset,
          length: r.length,
        }))
      );
    }

    const searchParams = new URLSearchParams(params);
    const response = await this.fetch(
      `https://graph.threads.net/v1.0/${userId}/threads?${searchParams.toString()}`,
      { method: 'POST' }
    );
    const data = await response.json();
    if (!data.id) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(data),
        '{}',
        data.error?.message || 'Failed to create Threads carousel container'
      );
    }
    return data.id;
  }

  private assertGifProvider(settings?: ThreadsSettingsData): void {
    if (settings?.gifAttachment?.gif_id) {
      const message = ThreadsValidationRules.gifProviderError(
        settings.gifAttachment.provider
      );
      if (message) {
        // A Tenor ID cannot be made into a GIPHY ID by relabeling its provider.
        throw new BadBody(this.identifier, '{}', '{}', message);
      }
    }
  }

  private async createTextContent(
    userId: string,
    accessToken: string,
    message: string,
    replyToId?: string,
    quoteId?: string,
    settings?: ThreadsSettingsData
  ): Promise<string> {
    this.assertGifProvider(settings);
    const form = new FormData();
    form.append('media_type', 'TEXT');
    form.append('text', message);
    form.append('access_token', accessToken);

    if (replyToId) {
      form.append('reply_to_id', replyToId);
    }

    const effectiveQuoteId = quoteId || settings?.quotePostId;
    if (effectiveQuoteId) {
      form.append('quote_post_id', effectiveQuoteId);
    }

    if (settings?.isGhostPost) {
      form.append('is_ghost_post', 'true');
    }

    if (settings?.poll?.options?.length) {
      const pollAttachment: Record<string, string> = {};
      const alphabet = ['option_a', 'option_b', 'option_c', 'option_d'];
      settings.poll.options.slice(0, 4).forEach((opt, idx) => {
        pollAttachment[alphabet[idx]] = opt;
      });
      form.append('poll_attachment', JSON.stringify(pollAttachment));
    }

    if (settings?.topicTag) {
      form.append('topic_tag', settings.topicTag.replace(/^#/, ''));
    }

    if (settings?.locationId) {
      form.append('location_id', settings.locationId);
    }

    if (settings?.textSpoilerRanges?.length) {
      form.append(
        'text_entities',
        JSON.stringify(
          settings.textSpoilerRanges.map((r) => ({
            entity_type: 'SPOILER',
            offset: r.offset,
            length: r.length,
          }))
        )
      );
    }

    if (settings?.textAttachment) {
      if (typeof settings.textAttachment === 'string') {
        try {
          JSON.parse(settings.textAttachment);
          form.append('text_attachment', settings.textAttachment);
        } catch {
          form.append(
            'text_attachment',
            JSON.stringify({ plaintext: settings.textAttachment })
          );
        }
      } else {
        form.append('text_attachment', JSON.stringify(settings.textAttachment));
      }
    }

    if (settings?.gifAttachment?.gif_id) {
      form.append(
        'gif_attachment',
        JSON.stringify({
          gif_id: settings.gifAttachment.gif_id,
          provider: 'GIPHY',
        })
      );
    }

    if (settings?.linkAttachment) {
      form.append('link_attachment', settings.linkAttachment);
    }

    if (settings?.replyControl) {
      form.append('reply_control', settings.replyControl);
    }

    if (settings?.enableReplyApprovals) {
      form.append('enable_reply_approvals', 'true');
    }

    const response = await this.fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
      method: 'POST',
      body: form,
    });
    const data = await response.json();
    if (!data.id) {
      throw new BadBody(
        this.identifier,
        JSON.stringify(data),
        '{}',
        data.error?.message || 'Failed to create Threads text container'
      );
    }
    return data.id;
  }

  private async publishThread(
    userId: string,
    accessToken: string,
    creationId: string
  ): Promise<{ threadId: string; permalink: string }> {
    await this.checkLoaded(creationId, accessToken);

    const { id: threadId } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${userId}/threads_publish?creation_id=${creationId}&access_token=${accessToken}`,
        {
          method: 'POST',
        }
      )
    ).json();

    const { permalink } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${threadId}?fields=id,permalink&access_token=${accessToken}`
      )
    ).json();

    return { threadId, permalink };
  }

  private async createThreadContent(
    userId: string,
    accessToken: string,
    postDetails: PostDetails<ThreadsSettingsData>,
    replyToId?: string,
    quoteId?: string
  ): Promise<string> {
    const settings = postDetails.settings || {};
    this.assertGifProvider(settings);
    if (!postDetails.media || postDetails.media.length === 0) {
      return await this.createTextContent(
        userId,
        accessToken,
        postDetails.message,
        replyToId,
        quoteId,
        settings
      );
    } else if (postDetails.media.length === 1) {
      return await this.createSingleMediaContent(
        userId,
        accessToken,
        postDetails.media[0],
        postDetails.message,
        false,
        replyToId,
        settings
      );
    } else {
      return await this.createCarouselContent(
        userId,
        accessToken,
        postDetails.media,
        postDetails.message,
        replyToId,
        settings
      );
    }
  }

  // The thread is live, the permalink is only cosmetic: never fail (and risk
  // re-publishing) a live post over it.
  private async threadPermalink(
    threadId: string,
    accessToken: string,
    integration: Integration
  ): Promise<string> {
    try {
      const { permalink } = await (
        await this.fetch(
          `https://graph.threads.net/v1.0/${threadId}?fields=id,permalink&access_token=${accessToken}`
        )
      ).json();
      return permalink;
    } catch (err) {
      return `https://www.threads.net/@${integration.profile}`;
    }
  }

  async postPending(
    userId: string,
    accessToken: string,
    postDetails: PostDetails<ThreadsSettingsData>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    if (!postDetails.length) {
      return [];
    }

    const [firstPost] = postDetails;
    const settings: ThreadsSettingsData = firstPost.settings || {};
    this.assertGifProvider(settings);

    // Carousels
    if ((firstPost.media?.length || 0) > 1) {
      const childIds = [];
      for (const mediaItem of firstPost.media!) {
        childIds.push(
          await this.createSingleMediaContent(
            userId,
            accessToken,
            mediaItem,
            firstPost.message,
            true,
            undefined,
            settings
          )
        );
      }

      return [
        {
          id: firstPost.id,
          postId: '',
          releaseURL: '',
          status: 'pending',
          pendingData: {
            step: 'children',
            childIds,
            message: firstPost.message,
            settings,
          },
        },
      ];
    }

    // Text / single media
    const containerId =
      !firstPost.media || firstPost.media.length === 0
        ? await this.createTextContent(
            userId,
            accessToken,
            firstPost.message,
            undefined,
            undefined,
            settings
          )
        : await this.createSingleMediaContent(
            userId,
            accessToken,
            firstPost.media[0],
            firstPost.message,
            false,
            undefined,
            settings
          );

    return [
      {
        id: firstPost.id,
        postId: '',
        releaseURL: '',
        status: 'pending',
        pendingData: { step: 'container', containerId, settings },
      },
    ];
  }

  override async checkPostStatus(
    accessToken: string,
    pendingData: {
      step: 'children' | 'container';
      childIds?: string[];
      containerId?: string;
      message?: string;
      settings?: ThreadsSettingsData;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    this.assertGifProvider(pendingData.settings);
    if (pendingData.step === 'children') {
      for (const childId of pendingData.childIds || []) {
        const status = await this.checkContainerStatus(childId, accessToken);
        if (status === 'IN_PROGRESS') {
          return { status: 'pending', pendingData };
        }
      }
      return { status: 'ready', pendingData };
    }

    const status = await this.checkContainerStatus(
      pendingData.containerId!,
      accessToken
    );

    if (status === 'IN_PROGRESS') {
      return { status: 'pending', pendingData };
    }

    if (status === 'PUBLISHED') {
      return {
        status: 'completed',
        postId: pendingData.containerId!,
        releaseURL: `https://www.threads.net/@${integration.profile}`,
      };
    }

    return { status: 'ready', pendingData };
  }

  override async finalizePost(
    accessToken: string,
    pendingData: {
      step: 'children' | 'container';
      childIds?: string[];
      containerId?: string;
      message?: string;
      settings?: ThreadsSettingsData;
    },
    integration: Integration
  ): Promise<PendingCheckResponse> {
    this.assertGifProvider(pendingData.settings);
    if (pendingData.step === 'children') {
      const settings = pendingData.settings;
      const params: Record<string, string> = {
        text: pendingData.message || '',
        media_type: 'CAROUSEL',
        children: (pendingData.childIds || []).join(','),
        access_token: accessToken,
      };

      if (settings?.topicTag) {
        params.topic_tag = settings.topicTag.replace(/^#/, '');
      }
      if (settings?.locationId) {
        params.location_id = settings.locationId;
      }
      if (settings?.replyControl) {
        params.reply_control = settings.replyControl;
      }
      if (settings?.enableReplyApprovals && !settings?.isGhostPost) {
        params.enable_reply_approvals = 'true';
      }
      if (settings?.quotePostId) {
        params.quote_post_id = settings.quotePostId;
      }
      if (settings?.isSpoilerMedia) {
        params.is_spoiler_media = 'true';
      }
      if (settings?.textSpoilerRanges?.length) {
        params.text_entities = JSON.stringify(
          settings.textSpoilerRanges.map((r) => ({
            entity_type: 'SPOILER',
            offset: r.offset,
            length: r.length,
          }))
        );
      }

      const searchParams = new URLSearchParams(params);
      const { id: containerId } = await (
        await this.fetch(
          `https://graph.threads.net/v1.0/${integration.internalId}/threads?${searchParams.toString()}`,
          {
            method: 'POST',
          }
        )
      ).json();

      return {
        status: 'pending',
        pendingData: { step: 'container', containerId, settings },
      };
    }

    const { id: threadId } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${integration.internalId}/threads_publish?creation_id=${pendingData.containerId}&access_token=${accessToken}`,
        {
          method: 'POST',
        }
      )
    ).json();

    return {
      status: 'completed',
      postId: threadId,
      releaseURL: await this.threadPermalink(threadId, accessToken, integration),
    };
  }

  async post(
    userId: string,
    accessToken: string,
    postDetails: PostDetails<ThreadsSettingsData>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    if (!postDetails.length) {
      return [];
    }

    if (process.env.THREADS_PUBLISH_TRANSPORT === 'browser') {
      return this.postViaBrowser(postDetails, integration);
    }

    const [firstPost] = postDetails;
    const [response] = await this.postPending(
      userId,
      accessToken,
      postDetails,
      integration
    );

    let pendingData = response.pendingData;
    const started = Date.now();

    while (true) {
      if (Date.now() - started > 8 * 60 * 1000) {
        throw new BadBody(
          this.identifier,
          '{}',
          '{}',
          'Threads took too long to process the media, please try again'
        );
      }

      const check = await this.checkPostStatus(
        accessToken,
        pendingData,
        integration
      );

      if (check.status === 'pending') {
        pendingData = check.pendingData;
        await timer(2200);
        continue;
      }

      const result =
        check.status === 'ready'
          ? await this.finalizePost(accessToken, check.pendingData, integration)
          : check;

      if (result.status === 'completed') {
        return [
          {
            id: firstPost.id,
            postId: result.postId,
            status: 'success',
            releaseURL: result.releaseURL,
          },
        ];
      }

      pendingData = result.pendingData;
      await timer(2200);
    }
  }

  async comment(
    userId: string,
    postId: string,
    lastCommentId: string | undefined,
    accessToken: string,
    postDetails: PostDetails<ThreadsSettingsData>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    if (!postDetails.length) {
      return [];
    }

    const [commentPost] = postDetails;
    const replyToId = lastCommentId || postId;

    // Create reply content
    const replyContentId = await this.createThreadContent(
      userId,
      accessToken,
      commentPost,
      replyToId
    );

    // Publish the reply
    const { threadId: replyThreadId, permalink } = await this.publishThread(
      userId,
      accessToken,
      replyContentId
    );

    return [
      {
        id: commentPost.id,
        postId: replyThreadId,
        status: 'success',
        releaseURL: permalink,
      },
    ];
  }

  async analytics(
    id: string,
    accessToken: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const until = dayjs().endOf('day').unix();
    const since = dayjs().subtract(date, 'day').unix();

    const { data, ...all } = await (
      await fetch(
        `https://graph.threads.net/v1.0/${id}/threads_insights?metric=views,likes,replies,reposts,quotes&access_token=${accessToken}&period=day&since=${since}&until=${until}`
      )
    ).json();

    return (
      data?.map((d: any) => ({
        label: capitalize(d.name),
        percentageChange: 5,
        data: d.total_value
          ? [{ total: d.total_value.value, date: dayjs().format('YYYY-MM-DD') }]
          : d.values.map((v: any) => ({
              total: v.value,
              date: dayjs(v.end_time).format('YYYY-MM-DD'),
            })),
      })) || []
    );
  }

  @Plug({
    identifier: 'threads-autoPlugPost',
    title: 'Auto plug post',
    description:
      'When a post reached a certain number of likes, add another post to it so you followers get a notification about your promotion',
    runEveryMilliseconds: 21600000,
    totalRuns: 3,
    fields: [
      {
        name: 'likesAmount',
        type: 'number',
        placeholder: 'Amount of likes',
        description: 'The amount of likes to trigger the repost',
        validation: /^\d+$/,
      },
      {
        name: 'post',
        type: 'richtext',
        placeholder: 'Post to plug',
        description: 'Message content to plug',
        validation: /^[\s\S]{3,}$/g,
      },
    ],
  })
  async autoPlugPost(
    integration: Integration,
    id: string,
    fields: { likesAmount: string; post: string }
  ) {
    const { data } = await (
      await fetch(
        `https://graph.threads.net/v1.0/${id}/insights?metric=likes&access_token=${integration.token}`
      )
    ).json();

    const {
      values: [value],
    } = data.find((p: any) => p.name === 'likes');

    if (value.value >= fields.likesAmount) {
      await timer(2000);

      const form = new FormData();
      form.append('media_type', 'TEXT');
      form.append('text', stripHtmlValidation('normal', fields.post, true));
      form.append('reply_to_id', id);
      form.append('access_token', integration.token);

      const { id: replyId } = await (
        await this.fetch('https://graph.threads.net/v1.0/me/threads', {
          method: 'POST',
          body: form,
        })
      ).json();

      await (
        await this.fetch(
          `https://graph.threads.net/v1.0/${integration.internalId}/threads_publish?creation_id=${replyId}&access_token=${integration.token}`,
          {
            method: 'POST',
          }
        )
      ).json();
      return true;
    }

    return false;
  }

  async postAnalytics(
    integrationId: string,
    accessToken: string,
    postId: string,
    date: number
  ): Promise<AnalyticsData[]> {
    const today = dayjs().format('YYYY-MM-DD');

    try {
      // Fetch thread insights from Threads API
      const { data } = await (
        await fetch(
          `https://graph.threads.net/v1.0/${postId}/insights?metric=views,likes,replies,reposts,quotes&access_token=${accessToken}`
        )
      ).json();

      if (!data || data.length === 0) {
        return [];
      }

      const result: AnalyticsData[] = [];

      for (const metric of data) {
        const value = metric.values?.[0]?.value ?? metric.total_value?.value;
        if (value === undefined) continue;

        let label = '';

        switch (metric.name) {
          case 'views':
            label = 'Views';
            break;
          case 'likes':
            label = 'Likes';
            break;
          case 'replies':
            label = 'Replies';
            break;
          case 'reposts':
            label = 'Reposts';
            break;
          case 'quotes':
            label = 'Quotes';
            break;
        }

        if (label) {
          result.push({
            label,
            percentageChange: 0,
            data: [{ total: String(value), date: today }],
          });
        }
      }

      return result;
    } catch (err) {
      console.error('Error fetching Threads post analytics:', err);
      return [];
    }
  }

  /** Single explicit cleanup call; not connected to publishing or workflows. */
  async deleteThread(accessToken: string, threadId: string): Promise<Response> {
    const id = typeof threadId === 'string' ? threadId.trim() : '';
    if (!id || id === '.' || id === '..') {
      throw new BadBody(
        this.identifier,
        '{}',
        '{}',
        'A valid Threads post ID is required for deletion.'
      );
    }

    try {
      return await this.fetch(
        `${THREADS_BASE_GRAPH_URL}/${encodeURIComponent(id)}`,
        {
          method: 'DELETE',
          headers: { Authorization: `Bearer ${accessToken}` },
          redirect: 'error',
        },
        this.identifier,
        // Starting past the existing retry limit makes this one request only
        // and bypasses handleErrors, which logs the raw provider response.
        3
      );
    } catch (error) {
      const json =
        error instanceof BadBody
          ? (error.details?.[0] as { json?: string })?.json
          : undefined;
      let mapped = mapThreadsApiError(json);
      if (
        mapped.category === 'publish_failed' &&
        json?.includes('threads_delete')
      ) {
        mapped = mapThreadsApiError('Missing permission: threads_delete');
      }
      // Do not retain raw response bodies, URLs or transport errors: they may
      // echo the token. Only the mapper's fixed user message/code is exposed.
      const message = `${mapped.userMessage} (${mapped.code})`;
      if (mapped.category === 'auth' || mapped.category === 'token_expired') {
        throw new RefreshToken(this.identifier, '{}', '{}', message);
      }
      throw new BadBody(this.identifier, '{}', '{}', message);
    }
  }

  async fetchPendingReplies(accessToken: string, mediaId: string) {
    const res = await this.fetch(
      `https://graph.threads.net/v1.0/${mediaId}/pending_replies?fields=id,text,timestamp,username,from,hide_status&access_token=${accessToken}`
    );
    return res.json();
  }

  async managePendingReply(
    accessToken: string,
    replyId: string,
    approve: boolean
  ) {
    const res = await this.fetch(
      `https://graph.threads.net/v1.0/${replyId}/manage_pending_reply?approve=${approve}&access_token=${accessToken}`,
      { method: 'POST' }
    );
    return res.json();
  }

  async manageReply(
    accessToken: string,
    replyId: string,
    hide: boolean
  ) {
    const res = await this.fetch(
      `https://graph.threads.net/v1.0/${replyId}/manage_reply?hide=${hide}&access_token=${accessToken}`,
      { method: 'POST' }
    );
    return res.json();
  }

  async fetchConversation(accessToken: string, mediaId: string) {
    const res = await this.fetch(
      `https://graph.threads.net/v1.0/${mediaId}/conversation?fields=id,text,timestamp,username,permalink,hide_status&access_token=${accessToken}`
    );
    return res.json();
  }

  async fetchUserThreads(accessToken: string, limit = 25) {
    const res = await this.fetch(
      `https://graph.threads.net/v1.0/me/threads?fields=id,media_product_type,media_type,text,permalink,timestamp,shortcode,is_quote_post&limit=${limit}&access_token=${accessToken}`
    );
    return res.json();
  }

  async keywordSearch(
    accessToken: string,
    query: string,
    searchType: 'TOP' | 'RECENT' = 'RECENT',
    searchMode: 'KEYWORD' | 'TAG' = 'KEYWORD'
  ) {
    const params = new URLSearchParams({
      q: query,
      search_type: searchType,
      search_mode: searchMode,
      access_token: accessToken,
    });
    const res = await this.fetch(
      `https://graph.threads.net/v1.0/keyword_search?${params.toString()}`
    );
    return res.json();
  }

  async replyToThread(
    userId: string,
    accessToken: string,
    replyToId: string,
    text: string
  ): Promise<{ threadId: string; permalink: string }> {
    const form = new FormData();
    form.append('media_type', 'TEXT');
    form.append('text', text);
    form.append('reply_to_id', replyToId);
    form.append('access_token', accessToken);

    const { id: replyCreationId } = await (
      await this.fetch(`https://graph.threads.net/v1.0/${userId}/threads`, {
        method: 'POST',
        body: form,
      })
    ).json();

    const { id: publishedId } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${userId}/threads_publish?creation_id=${replyCreationId}&access_token=${accessToken}`,
        { method: 'POST' }
      )
    ).json();

    const { permalink } = await (
      await this.fetch(
        `https://graph.threads.net/v1.0/${publishedId}?fields=id,permalink&access_token=${accessToken}`
      )
    ).json();

    return { threadId: publishedId, permalink: permalink || '' };
  }

  async searchLocations(
    accessToken: string,
    query: string
  ): Promise<{ data: Array<{ id: string; name: string }> }> {
    const params = new URLSearchParams({
      q: query,
      access_token: accessToken,
    });
    const res = await this.fetch(
      `${THREADS_BASE_GRAPH_URL}/location_search?${params.toString()}`
    );
    return res.json();
  }

  async fetchPublishingLimit(
    accessToken: string,
    userId: string
  ): Promise<{
    data: Array<{
      quota_usage?: number;
      config?: {
        quota_total?: number;
        quota_duration?: number;
        reply_quota_total?: number;
        reply_quota_duration?: number;
      };
      reply_quota_usage?: number;
    }>;
  }> {
    const res = await this.fetch(
      `${THREADS_BASE_GRAPH_URL}/${userId}/threads_publishing_limit?fields=quota_usage,config,reply_quota_usage&access_token=${accessToken}`
    );
    return res.json();
  }

  private async postViaBrowser(
    postDetails: PostDetails<ThreadsSettingsData>[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const [firstPost] = postDetails;
    const sidecarUrl =
      process.env.THREADS_BROWSER_SERVICE_URL || 'http://127.0.0.1:8017';
    const serviceKey = process.env.THREADS_BROWSER_SERVICE_KEY;
    const accountName =
      (firstPost?.settings as any)?.account ||
      integration.name?.replace(/[^A-Za-z0-9_-]/g, '_') ||
      'main';

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (serviceKey) {
      headers['X-Threads-Service-Key'] = serviceKey;
    }

    const mediaUrls = (firstPost.media || [])
      .map((m) => m.path)
      .filter((p): p is string => Boolean(p));

    const payload: Record<string, any> = {
      account: accountName,
      text: firstPost.message,
      is_ghost: Boolean((firstPost.settings as any)?.isGhostPost),
      request_id: makeSecureId(16),
      dry_run: false,
    };

    if (mediaUrls.length > 0) {
      payload.media_urls = mediaUrls;
    }

    const res = await this.fetch(`${sidecarUrl}/api/threads/post`, {
      method: 'POST',
      headers,
      body: JSON.stringify(payload),
    });

    const data = await res.json().catch(() => ({}));
    if (!res.ok || data?.status === 'error') {
      const errCode = data?.code || 'POST_SUBMIT_FAILED';
      const errMsg = data?.message || 'Threadsブラウザ投稿に失敗しました。';
      throw new BadBody(
        this.identifier,
        JSON.stringify(payload),
        JSON.stringify(data),
        `[${errCode}] ${errMsg}`
      );
    }

    const releaseURL =
      data?.url ||
      (integration.name
        ? `https://www.threads.net/@${integration.name}`
        : 'https://www.threads.net');

    return [
      {
        id: data?.post_id || firstPost.id,
        postId: data?.post_id || makeSecureId(16),
        releaseURL,
        status: 'completed',
      },
    ];
  }
}


