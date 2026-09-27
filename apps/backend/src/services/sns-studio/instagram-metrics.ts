const METRIC_ALIASES = {
  views: ['views', 'view_count', 'views_count'],
  plays: ['plays', 'play_count', 'plays_count'],
  likes: ['likes', 'like_count'],
  comments: ['comments', 'comment_count'],
  saves: ['saves', 'save_count'],
  storyViews: ['storyViews', 'story_views', 'story_view_count'],
} as const;

export type NormalizedInstagramMetrics = Record<keyof typeof METRIC_ALIASES, number | null>;

export function normalizeInstagramMetrics(value: unknown): NormalizedInstagramMetrics {
  const source = value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
  const normalized = {} as NormalizedInstagramMetrics;
  for (const [name, aliases] of Object.entries(METRIC_ALIASES) as Array<[keyof typeof METRIC_ALIASES, readonly string[]]>) {
    const metric = aliases.map((alias) => source[alias]).find((candidate) => candidate !== undefined && candidate !== null);
    normalized[name] = typeof metric === 'number' && Number.isFinite(metric) ? metric : null;
  }
  return normalized;
}
