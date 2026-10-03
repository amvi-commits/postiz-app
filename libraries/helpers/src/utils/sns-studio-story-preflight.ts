export const STORY_PREFLIGHT_ENDPOINT = '/sns-studio/media/preflight/story';

export type StorySticker = {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation: number;
};

export type StoryPreflightDraft = {
  accountId?: string;
  mediaPath?: string;
  mediaType?: string;
  linkUrl?: string;
} & StorySticker;

export type StoryPreflightPayload = {
  accountId: string;
  mediaPath: string;
  mediaType: 'image' | 'video';
  linkUrl: string;
  sticker: StorySticker;
};

export type StoryPreflightMedia = {
  kind?: string;
  sizeBytes?: number;
  durationSeconds?: number;
  video?: { codec?: string; width?: number; height?: number };
  hasAudio?: boolean;
};

export type StoryPreflightResult = {
  ready: boolean;
  errors: string[];
  warnings: string[];
  account?: { id: string; username: string; status: string };
  media?: StoryPreflightMedia | null;
};

export type StoryPreflightRequest = (
  path: string,
  init?: RequestInit
) => Promise<unknown>;

export const createStoryPreflightPayload = (
  draft: StoryPreflightDraft,
  defaultAccountId = ''
): StoryPreflightPayload => ({
  accountId: (draft.accountId || defaultAccountId).trim(),
  mediaPath: (draft.mediaPath || '').trim(),
  mediaType: (draft.mediaType || '') as 'image' | 'video',
  linkUrl: (draft.linkUrl || '').trim(),
  sticker: {
    x: draft.x,
    y: draft.y,
    width: draft.width,
    height: draft.height,
    rotation: draft.rotation,
  },
});

export const validateStoryPreflightPayload = (
  payload: StoryPreflightPayload
): string[] => {
  const errors: string[] = [];
  if (!payload.accountId) errors.push('STORY_ACCOUNT_REQUIRED');
  if (!payload.mediaPath) errors.push('STORY_MEDIA_PATH_REQUIRED');
  if (!['image', 'video'].includes(payload.mediaType)) {
    errors.push('STORY_MEDIA_TYPE_INVALID');
  }

  try {
    const url = new URL(payload.linkUrl);
    if (!['http:', 'https:'].includes(url.protocol) || !url.hostname) {
      errors.push('STORY_LINK_URL_INVALID');
    }
  } catch {
    errors.push('STORY_LINK_URL_INVALID');
  }

  const { x, y, width, height, rotation } = payload.sticker;
  if (![x, y].every((value) => Number.isFinite(value) && value >= 0 && value <= 1)) {
    errors.push('STORY_STICKER_POSITION_INVALID');
  }
  if (![width, height].every((value) => Number.isFinite(value) && value >= 0.01 && value <= 1)) {
    errors.push('STORY_STICKER_SIZE_INVALID');
  }
  if (!Number.isFinite(rotation) || rotation < -360 || rotation > 360) {
    errors.push('STORY_STICKER_ROTATION_INVALID');
  }
  return errors;
};

export class StoryPreflightInputError extends Error {
  constructor(readonly errors: string[]) {
    super(errors.join(', '));
    this.name = 'StoryPreflightInputError';
  }
}

export const requestStoryPreflight = async (
  request: StoryPreflightRequest,
  payload: StoryPreflightPayload
): Promise<StoryPreflightResult> => {
  const errors = validateStoryPreflightPayload(payload);
  if (errors.length) throw new StoryPreflightInputError(errors);

  const result = await request(STORY_PREFLIGHT_ENDPOINT, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  return result as StoryPreflightResult;
};

export const getStoryPreflightVerdict = (
  result: StoryPreflightResult
): 'PASS' | 'PASS_WITH_WARNINGS' | 'HARD_ERROR' => {
  if (!result.ready || result.errors.length) return 'HARD_ERROR';
  return result.warnings.length ? 'PASS_WITH_WARNINGS' : 'PASS';
};
