import {
  createStoryPreflightPayload,
  getStoryPreflightVerdict,
  requestStoryPreflight,
  StoryPreflightInputError,
  StoryPreflightResult,
  validateStoryPreflightPayload,
} from './sns-studio-story-preflight';

const draft = {
  accountId: 'account-1',
  mediaPath: '/uploads/story.mp4',
  mediaType: 'video',
  linkUrl: 'https://example.com/',
  x: 0.5,
  y: 0.5,
  width: 0.51,
  height: 0.26,
  rotation: 0,
};

const pass: StoryPreflightResult = {
  ready: true,
  errors: [],
  warnings: [],
  account: { id: 'account-1', username: 'lovenight_8r', status: 'GREEN' },
  media: { kind: 'video', sizeBytes: 123381, durationSeconds: 3.675, video: { width: 1080, height: 1920, codec: 'h264' }, hasAudio: true },
};

describe('SNS Studio Story Preflight only', () => {
  it('calls only the Story preflight endpoint with the StoryLink fields', async () => {
    const request = jest.fn().mockResolvedValue(pass);
    const payload = createStoryPreflightPayload(draft);

    const result = await requestStoryPreflight(request, payload);

    expect(result).toBe(pass);
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toBe('/sns-studio/media/preflight/story');
    expect(request.mock.calls[0][1]).toMatchObject({ method: 'POST' });
    expect(JSON.parse(request.mock.calls[0][1].body as string)).toEqual({
      accountId: 'account-1',
      mediaPath: '/uploads/story.mp4',
      mediaType: 'video',
      linkUrl: 'https://example.com/',
      sticker: { x: 0.5, y: 0.5, width: 0.51, height: 0.26, rotation: 0 },
    });
    expect(request.mock.calls.map(([path]) => path)).not.toContain('/sns-studio/publish/story');
  });

  it.each([
    ['missing account', { ...draft, accountId: '' }, 'STORY_ACCOUNT_REQUIRED'],
    ['missing media', { ...draft, mediaPath: '' }, 'STORY_MEDIA_PATH_REQUIRED'],
    ['invalid URL', { ...draft, linkUrl: 'not a URL' }, 'STORY_LINK_URL_INVALID'],
    ['sticker outside bounds', { ...draft, x: 1.1 }, 'STORY_STICKER_POSITION_INVALID'],
  ])('blocks %s before sending a request', async (_label, invalidDraft, expectedError) => {
    const request = jest.fn().mockResolvedValue(pass);
    const errors = validateStoryPreflightPayload(createStoryPreflightPayload(invalidDraft));

    expect(errors).toContain(expectedError);
    await expect(requestStoryPreflight(request, createStoryPreflightPayload(invalidDraft)))
      .rejects.toBeInstanceOf(StoryPreflightInputError);
    expect(request).not.toHaveBeenCalled();
  });

  it('keeps a backend hard error as a stop result without a publish request', async () => {
    const hardError: StoryPreflightResult = { ready: false, errors: ['INSTAGRAM_SESSION_NOT_HEALTHY'], warnings: [], account: pass.account, media: pass.media };
    const request = jest.fn().mockResolvedValue(hardError);

    const result = await requestStoryPreflight(request, createStoryPreflightPayload(draft));

    expect(getStoryPreflightVerdict(result)).toBe('HARD_ERROR');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls.map(([path]) => path)).toEqual(['/sns-studio/media/preflight/story']);
  });

  it('distinguishes pass, pass with warnings, and hard error', () => {
    expect(getStoryPreflightVerdict(pass)).toBe('PASS');
    expect(getStoryPreflightVerdict({ ...pass, warnings: ['STORY_VIDEO_MAY_BE_SEGMENTED_BY_INSTAGRAM'] }))
      .toBe('PASS_WITH_WARNINGS');
    expect(getStoryPreflightVerdict({ ...pass, ready: true, errors: ['MEDIA_INVALID'] }))
      .toBe('HARD_ERROR');
  });
});
