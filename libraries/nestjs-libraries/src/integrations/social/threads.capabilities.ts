export const THREADS_API_VERSION = 'v1.0';
export const THREADS_BASE_GRAPH_URL = `https://graph.threads.net/${THREADS_API_VERSION}`;

export const THREADS_SCOPES = [
  'threads_basic',
  'threads_content_publish',
  'threads_manage_replies',
  'threads_read_replies',
  'threads_manage_insights',
  'threads_keyword_search',
  'threads_location_tagging',
  'threads_manage_mentions',
  'threads_delete',
] as const;

export type ThreadsScope = (typeof THREADS_SCOPES)[number];

export type ThreadsReplyControl =
  | 'everyone'
  | 'accounts_you_follow'
  | 'mentioned_only'
  | 'parent_post_author_only'
  | 'followers_only';

export const THREADS_REPLY_CONTROL_OPTIONS: Array<{
  value: ThreadsReplyControl;
  label: string;
  description: string;
}> = [
  {
    value: 'everyone',
    label: '全員',
    description: '誰でもこの投稿に返信できます（デフォルト）',
  },
  {
    value: 'accounts_you_follow',
    label: 'フォロー中',
    description: '自分がフォローしているアカウントのみ返信できます',
  },
  {
    value: 'mentioned_only',
    label: 'メンションした人のみ',
    description: '本文で@メンションされたアカウントのみ返信できます',
  },
  {
    value: 'parent_post_author_only',
    label: '親投稿者のみ',
    description: 'スレッドの元投稿者のみ返信できます',
  },
  {
    value: 'followers_only',
    label: 'フォロワーのみ',
    description: 'あなたをフォローしているアカウントのみ返信できます',
  },
];

export const THREADS_THREAD_INTERVALS: Array<{
  value: number;
  label: string;
}> = [
  { value: 0, label: '即時' },
  { value: 1, label: '1分' },
  { value: 2, label: '2分' },
  { value: 5, label: '5分' },
  { value: 10, label: '10分' },
  { value: 15, label: '15分' },
  { value: 30, label: '30分' },
  { value: 60, label: '1時間' },
  { value: 120, label: '2時間' },
];

export interface ThreadsPollConfig {
  options: string[]; // 2 to 4 options, each 1 to 25 chars
}

export interface ThreadsTextSpoilerRange {
  offset: number;
  length: number;
}

export interface ThreadsTextAttachmentObject {
  plaintext: string;
  link_attachment_url?: string;
  text_with_styling_info?: any;
}

export type ThreadsTextAttachment = string | ThreadsTextAttachmentObject;

export interface ThreadsGifAttachment {
  gif_id: string;
  provider?: 'GIPHY';
}

export interface ThreadsSettingsData {
  isGhostPost?: boolean;
  poll?: ThreadsPollConfig;
  topicTag?: string;
  locationId?: string;
  locationName?: string;
  isSpoilerMedia?: boolean;
  textSpoilerRanges?: ThreadsTextSpoilerRange[];
  textAttachment?: ThreadsTextAttachment;
  linkAttachment?: string;
  gifAttachment?: ThreadsGifAttachment;
  replyControl?: ThreadsReplyControl;
  enableReplyApprovals?: boolean;
  quotePostId?: string;
  altText?: string;
  active_thread_finisher?: boolean;
  thread_finisher?: string;
  threadInterval?: number; // In minutes: 0, 1, 2, 5, 10, 15, 30, 60, 120
}

export interface ThreadsCapabilityDef {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  apiVersion: string;
  parameter?: string;
  endpoint?: string;
  requiredPermission?: ThreadsScope;
  mediaRestrictions?: 'text_only' | 'media_only' | 'any';
  incompatibleFeatures?: string[];
}

export interface ThreadsFeatureFlags {
  ghostPost: boolean;
  poll: boolean;
  topicTag: boolean;
  location: boolean;
  spoiler: boolean;
  textAttachment: boolean;
  replyControl: boolean;
  replyApproval: boolean;
  search: boolean;
  aiAutoReply: boolean;
  autoPlug: boolean;
}

export const DEFAULT_THREADS_FEATURE_FLAGS: ThreadsFeatureFlags = {
  ghostPost: true,
  poll: true,
  topicTag: true,
  location: true,
  spoiler: true,
  textAttachment: true,
  replyControl: true,
  replyApproval: true,
  search: true,
  aiAutoReply: false, // Default OFF per requirements (Section 13)
  autoPlug: true,
};

export const getThreadsFeatureFlags = (
  envOverrides?: Partial<Record<string, string>>
): ThreadsFeatureFlags => {
  const env = envOverrides || (typeof process !== 'undefined' ? process.env : {});
  return {
    ghostPost: env.THREADS_FEATURE_GHOST_POST !== 'false',
    poll: env.THREADS_FEATURE_POLL !== 'false',
    topicTag: env.THREADS_FEATURE_TOPIC_TAG !== 'false',
    location: env.THREADS_FEATURE_LOCATION !== 'false',
    spoiler: env.THREADS_FEATURE_SPOILER !== 'false',
    textAttachment: env.THREADS_FEATURE_TEXT_ATTACHMENT !== 'false',
    replyControl: env.THREADS_FEATURE_REPLY_CONTROL !== 'false',
    replyApproval: env.THREADS_FEATURE_REPLY_APPROVAL !== 'false',
    search: env.THREADS_FEATURE_SEARCH !== 'false',
    aiAutoReply: env.THREADS_FEATURE_AI_AUTO_REPLY === 'true', // Opt-in
    autoPlug: env.THREADS_FEATURE_AUTO_PLUG !== 'false',
  };
};

export const THREADS_CAPABILITIES: Record<string, ThreadsCapabilityDef> = {
  ghostPost: {
    id: 'ghostPost',
    name: 'Ghost Post (ゴースト投稿)',
    description: '公開から24時間後にMetaにより自動アーカイブされる一時投稿（Threads公式仕様・テキスト専用）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'is_ghost_post',
    requiredPermission: 'threads_content_publish',
    mediaRestrictions: 'text_only',
    incompatibleFeatures: ['media', 'spoilerMedia'],
  },
  poll: {
    id: 'poll',
    name: 'Poll / 投票',
    description: '2〜4個の選択肢による公式アンケート（テキスト専用、各1〜25文字）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'poll_attachment',
    requiredPermission: 'threads_content_publish',
    mediaRestrictions: 'text_only',
    incompatibleFeatures: ['media', 'linkAttachment', 'textAttachment'],
  },
  topicTag: {
    id: 'topicTag',
    name: 'Topic Tag / トピックタグ',
    description: '1投稿につき1件まで設定可能な公式トピックタグ（1〜50文字、記号#不要、ピリオド・アンパサンド禁止）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'topic_tag',
    requiredPermission: 'threads_content_publish',
  },
  location: {
    id: 'location',
    name: 'Location / 位置情報',
    description: 'Threads投稿に位置情報（Location）を紐付け',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'location_id',
    endpoint: '/location_search',
    requiredPermission: 'threads_location_tagging',
  },
  mediaSpoiler: {
    id: 'mediaSpoiler',
    name: 'Media Spoiler / 画像・動画ネタバレ防止',
    description: '画像や動画をぼかし表示し、タップするまで内容を隠します',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'is_spoiler_media',
    requiredPermission: 'threads_content_publish',
    mediaRestrictions: 'media_only',
  },
  textSpoiler: {
    id: 'textSpoiler',
    name: 'Text Spoiler / テキストネタバレ防止',
    description: '本文の特定文字範囲をタップするまで伏字表示',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'text_entities',
    requiredPermission: 'threads_content_publish',
  },
  textAttachment: {
    id: 'textAttachment',
    name: 'Text Attachment / 長文テキスト添付',
    description: '最大10,000文字の長文テキストを投稿に添付（plaintext / link_attachment_url構造）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'text_attachment',
    requiredPermission: 'threads_content_publish',
    mediaRestrictions: 'text_only',
    incompatibleFeatures: ['poll'],
  },
  linkAttachment: {
    id: 'linkAttachment',
    name: 'Link Attachment / リンクカード',
    description: '外部URLのプレビューカードを投稿に添付',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'link_attachment',
    requiredPermission: 'threads_content_publish',
    incompatibleFeatures: ['poll'],
  },
  gifAttachment: {
    id: 'gifAttachment',
    name: 'GIF Attachment / GIF添付',
    description: 'GIPHY連携によるGIFアニメーション添付（gif_id, provider: GIPHY）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'gif_attachment',
    requiredPermission: 'threads_content_publish',
  },
  quotePost: {
    id: 'quotePost',
    name: 'Quote Post / 引用投稿',
    description: '既存のThreads投稿を引用して投稿',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'quote_post_id',
    requiredPermission: 'threads_content_publish',
  },
  replyControl: {
    id: 'replyControl',
    name: 'Reply Control / 返信許可範囲',
    description: '返信を許可する対象を指定（全員、フォロー中、メンションした人のみ等）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'reply_control',
    requiredPermission: 'threads_content_publish',
  },
  replyApproval: {
    id: 'replyApproval',
    name: 'Reply Approvals / 返信承認制',
    description: '投稿への返信を承認制にし、許可するまで非公開にします',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'enable_reply_approvals',
    requiredPermission: 'threads_manage_replies',
  },
  altText: {
    id: 'altText',
    name: 'Alt Text / 代替テキスト',
    description: 'メディア（画像・動画）にアクセシビリティ用の説明文を設定（最大1,000文字）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    parameter: 'alt_text',
    requiredPermission: 'threads_content_publish',
    mediaRestrictions: 'media_only',
  },
  search: {
    id: 'search',
    name: 'Threads Keyword Search / 投稿検索',
    description: 'Threads上の公開投稿をキーワードやトピックタグで検索',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    endpoint: '/keyword_search',
    requiredPermission: 'threads_keyword_search',
  },
  inbox: {
    id: 'inbox',
    name: 'Threads Inbox / 返信・メンション管理',
    description: '複数Threadsアカウントの返信・メンションの一元管理・非表示・承認操作',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    requiredPermission: 'threads_manage_replies',
  },
  insights: {
    id: 'insights',
    name: 'Threads Insights / 分析',
    description: 'Views, Likes, Replies, Reposts, Quotesの公式指標を取得',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    requiredPermission: 'threads_manage_insights',
  },
  publishingLimit: {
    id: 'publishingLimit',
    name: 'Threads Publishing Limit / 投稿上限クォータ',
    description: '24時間移動枠での投稿枠・返信枠の使用状況を取得（GET /{threads-user-id}/threads_publishing_limit）',
    enabled: true,
    apiVersion: THREADS_API_VERSION,
    endpoint: '/threads_publishing_limit',
    requiredPermission: 'threads_basic',
  },
};

export interface ThreadsValidationContext {
  message?: string;
  mediaCount?: number;
  settings?: ThreadsSettingsData;
}

export interface ThreadsValidationResult {
  isValid: boolean;
  errors: string[];
  warnings: string[];
  disabledFeatures: Record<string, string>;
  sanitizedSettings: ThreadsSettingsData;
}

export class ThreadsValidationRules {
  static gifProviderError(provider: unknown): string | undefined {
    if (provider === undefined || provider === 'GIPHY') {
      return undefined;
    }
    if (provider === 'TENOR') {
      return 'Tenor GIF is no longer supported. Please select the GIF again using GIPHY.';
    }
    return 'Threads GIF provider must be GIPHY. Please select the GIF again using GIPHY.';
  }

  static validate(context: ThreadsValidationContext): ThreadsValidationResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    const disabledFeatures: Record<string, string> = {};
    const settings = { ...(context.settings || {}) };
    const mediaCount = context.mediaCount || 0;
    const hasMedia = mediaCount > 0;
    const message = (context.message || '').trim();

    // 1. Text length validation
    if (message.length > 500 && !settings.textAttachment) {
      errors.push('Threadsの本文は通常500文字以内です。500文字を超える場合は「長文テキスト添付」をご利用ください。');
    }

    // 2. Media vs Text-only features
    if (hasMedia) {
      if (settings.isGhostPost) {
        errors.push('ゴースト投稿（Ghost Post）はThreads公式API仕様によりテキスト専用です。画像・動画が含まれる投稿では利用できません。');
        disabledFeatures.ghostPost = 'メディア付き投稿ではゴースト投稿は利用できません';
      }
      if (settings.poll && settings.poll.options?.length) {
        errors.push('投票（Poll）はテキスト専用です。メディア付き投稿では投票を作成できません。');
        disabledFeatures.poll = 'メディア付き投稿では投票は利用できません';
      }
      if (settings.textAttachment) {
        errors.push('長文テキスト添付はテキスト専用です。メディア付き投稿では利用できません。');
        disabledFeatures.textAttachment = 'メディア付き投稿では長文添付は利用できません';
      }
    } else {
      // No media: media-only features are disabled
      if (settings.isSpoilerMedia) {
        errors.push('画像・動画スポイラーはメディアが添付されている場合のみ利用できます。');
        disabledFeatures.mediaSpoiler = 'メディアがないため利用できません';
      }
      if (settings.altText) {
        warnings.push('メディアが添付されていないため、代替テキスト（Alt Text）は送信されません。');
      }
    }

    // 3. Poll validation and incompatibilities
    if (settings.poll && settings.poll.options?.length) {
      const validOptions = settings.poll.options.map((opt) => opt.trim()).filter(Boolean);
      if (validOptions.length < 2 || validOptions.length > 4) {
        errors.push('投票（Poll）は2個以上4個以下の選択肢を入力してください。');
      }
      for (let i = 0; i < validOptions.length; i++) {
        if (validOptions[i].length > 25) {
          errors.push(`投票の選択肢 ${i + 1} は25文字以内で入力してください（現在: ${validOptions[i].length}文字）。`);
        }
      }
      if (settings.linkAttachment) {
        errors.push('投票（Poll）とリンク添付（Link Attachment）は同時に利用できません。');
        disabledFeatures.linkAttachment = '投票設定中はリンク添付を利用できません';
      }
      if (settings.textAttachment) {
        errors.push('投票（Poll）と長文テキスト添付（Text Attachment）は同時に利用できません。');
        disabledFeatures.textAttachment = '投票設定中は長文テキスト添付を利用できません';
      }
    }

    // 4. Topic Tag validation
    if (settings.topicTag) {
      const tag = settings.topicTag.trim().replace(/^#/, '');
      if (tag.length === 0 || tag.length > 50) {
        errors.push('トピックタグは1〜50文字で入力してください。');
      }
      if (tag.includes('.') || tag.includes('&')) {
        errors.push('トピックタグにピリオド（.）およびアンパサンド（&）は使用できません。');
      }
    }

    // 5. Text Attachment validation
    if (settings.textAttachment) {
      const plaintext =
        typeof settings.textAttachment === 'string'
          ? settings.textAttachment
          : settings.textAttachment.plaintext || '';
      if (plaintext.length > 10000) {
        errors.push('長文テキスト添付は最大10,000文字までです。');
      }
      if (
        typeof settings.textAttachment !== 'string' &&
        settings.textAttachment.link_attachment_url &&
        settings.linkAttachment
      ) {
        errors.push('投稿のリンクカードと長文テキスト添付内のURLは重複指定できません。');
      }
    }

    // 6. Alt Text validation
    if (settings.altText && settings.altText.length > 1000) {
      errors.push('代替テキスト（Alt Text）は1,000文字以内で入力してください。');
    }

    if (settings.gifAttachment?.gif_id) {
      const gifError = this.gifProviderError(settings.gifAttachment.provider);
      if (gifError) {
        errors.push(gifError);
      }
    }

    // Auto-sanitize disabled features
    const sanitizedSettings: ThreadsSettingsData = { ...settings };
    if (hasMedia) {
      sanitizedSettings.isGhostPost = false;
      delete sanitizedSettings.poll;
      delete sanitizedSettings.textAttachment;
    }
    if (sanitizedSettings.poll && sanitizedSettings.poll.options?.length) {
      delete sanitizedSettings.linkAttachment;
      delete sanitizedSettings.textAttachment;
    }

    return {
      isValid: errors.length === 0,
      errors,
      warnings,
      disabledFeatures,
      sanitizedSettings,
    };
  }
}

export interface ThreadsApiError {
  code: string;
  category:
    | 'auth'
    | 'token_expired'
    | 'permission_missing'
    | 'rate_limit'
    | 'media_format'
    | 'combination_invalid'
    | 'publish_failed'
    | 'transient_down';
  userMessage: string;
  suggestedAction: string;
  isRetryable: boolean;
  rawError?: unknown;
}

export const mapThreadsApiError = (error: any): ThreadsApiError => {
  const errorStr = typeof error === 'string' ? error : JSON.stringify(error || {});
  const msg = error?.message || errorStr;

  if (errorStr.includes('Error validating access token') || errorStr.includes('Session has expired')) {
    return {
      code: 'THREADS_TOKEN_EXPIRED',
      category: 'token_expired',
      userMessage: 'Threadsのアクセストークンの有効期限が切れました。',
      suggestedAction: 'SNS Studioまたは設定画面からThreadsアカウントを再連携してください。',
      isRetryable: false,
      rawError: error,
    };
  }

  if (errorStr.includes('OAuthException') || errorStr.includes('Invalid OAuth access token')) {
    return {
      code: 'THREADS_AUTH_ERROR',
      category: 'auth',
      userMessage: 'Threadsの認証に失敗しました。',
      suggestedAction: 'アカウント連携を一度解除し、再度Threadsと接続してください。',
      isRetryable: false,
      rawError: error,
    };
  }

  if (
    errorStr.includes('permission') ||
    errorStr.includes('threads_keyword_search') ||
    errorStr.includes('threads_manage_replies') ||
    errorStr.includes('threads_location_tagging') ||
    errorStr.includes('threads_manage_mentions')
  ) {
    return {
      code: 'THREADS_PERMISSION_MISSING',
      category: 'permission_missing',
      userMessage: 'Threads APIの必要な権限（スコープ）が不足しています。',
      suggestedAction: 'Meta Developerポータルのアプリ設定で該当スコープが追加され、App Reviewが完了しているか確認してください。',
      isRetryable: false,
      rawError: error,
    };
  }

  if (
    errorStr.includes('4279009') ||
    errorStr.includes('rate limit') ||
    errorStr.includes('2207051') ||
    errorStr.includes('User restricted')
  ) {
    return {
      code: 'THREADS_RATE_LIMITED',
      category: 'rate_limit',
      userMessage: 'Threads APIの利用制限（Rate Limit）に達しました。',
      suggestedAction: 'Threadsの24時間投稿上限（250件）またはAPI制限に達した可能性があります。しばらく時間を置いてから再試行してください。',
      isRetryable: true,
      rawError: error,
    };
  }

  if (
    errorStr.includes('The media could not be fetched') ||
    errorStr.includes('media') ||
    errorStr.includes('aspect ratio')
  ) {
    return {
      code: 'THREADS_MEDIA_FORMAT_ERROR',
      category: 'media_format',
      userMessage: 'メディアの取得またはフォーマット処理に失敗しました。',
      suggestedAction: 'メディアURLが外部からアクセス可能か、およびThreads対応形式（MP4/JPEG/PNG等）かご確認ください。',
      isRetryable: false,
      rawError: error,
    };
  }

  if (errorStr.includes('text must be at most 500 characters')) {
    return {
      code: 'THREADS_TEXT_TOO_LONG',
      category: 'combination_invalid',
      userMessage: '本文が500文字の制限を超えています。',
      suggestedAction: '本文を500文字以内に短縮するか、「長文テキスト添付」をご利用ください。',
      isRetryable: false,
      rawError: error,
    };
  }

  if (errorStr.includes('THREADS_API__LINK_LIMIT_EXCEEDED')) {
    return {
      code: 'THREADS_LINK_LIMIT_EXCEEDED',
      category: 'combination_invalid',
      userMessage: '1投稿あたりのURL数が上限（5件）を超えています。',
      suggestedAction: '本文および長文テキスト添付に含まれるURLの数を5件以内に減らしてください。',
      isRetryable: false,
      rawError: error,
    };
  }

  return {
    code: 'THREADS_API_ERROR',
    category: 'publish_failed',
    userMessage: 'Threads APIの呼び出しでエラーが発生しました。',
    suggestedAction: msg ? `詳細: ${msg}` : '時間をおいて再試行してください。',
    isRetryable: false,
    rawError: error,
  };
};
