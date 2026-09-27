import { normalizeInstagramMetrics } from './instagram-metrics';

describe('normalizeInstagramMetrics', () => {
  it('keeps known numeric metrics, including zero, and fills unavailable metrics with null', () => {
    expect(normalizeInstagramMetrics({ views: 0, play_count: 12, like_count: 3, unexpected: 99 })).toEqual({
      views: 0,
      plays: 12,
      likes: 3,
      comments: null,
      saves: null,
      storyViews: null,
    });
  });

  it('returns a stable null shape when the API supplies no metrics', () => {
    expect(normalizeInstagramMetrics(undefined)).toEqual({
      views: null,
      plays: null,
      likes: null,
      comments: null,
      saves: null,
      storyViews: null,
    });
  });
});
