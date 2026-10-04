export type Platform = 'common' | 'youtube' | 'instagram' | 'tiktok' | 'threads';
export type Tab = 'Dashboard' | 'Accounts' | 'Content Inbox' | 'Create' | 'Publish' | 'Threads' | 'Common Queue' | 'Common History' | 'Common Analytics' | 'Story Pools' | 'Automation Recipes' | 'Queue' | 'Analytics' | 'Settings' | 'Calendar' | 'YouTube Overview' | 'YouTube Video Composer' | 'Shorts Composer' | 'Channels' | 'Playlists' | 'Instagram Overview' | 'TikTok Overview' | 'Threads Overview';

export const platforms: Array<{ id: Platform; label: string }> = [
  { id: 'common', label: '共通機能' },
  { id: 'youtube', label: 'YouTube' },
  { id: 'instagram', label: 'Instagram' },
  { id: 'tiktok', label: 'TikTok' },
  { id: 'threads', label: 'Threads' },
];

export const platformSections: Record<Platform, Array<{ label: string; tab: Tab }>> = {
  common: [
    { label: 'Dashboard', tab: 'Dashboard' },
    { label: 'Content Inbox', tab: 'Content Inbox' },
    { label: 'Video Tools', tab: 'Create' },
    { label: 'Automation', tab: 'Automation Recipes' },
    { label: 'Queue', tab: 'Common Queue' },
    { label: 'Calendar', tab: 'Calendar' },
    { label: 'Analytics', tab: 'Common Analytics' },
    { label: 'Settings', tab: 'Settings' },
    { label: 'Cross Post', tab: 'Publish' },
    { label: 'History', tab: 'Common History' },
    { label: '制作Queue', tab: 'Queue' },
  ],
  youtube: [
    { label: 'Overview', tab: 'YouTube Overview' },
    { label: '通常動画', tab: 'YouTube Video Composer' },
    { label: 'Shorts', tab: 'Shorts Composer' },
    { label: 'Channels', tab: 'Channels' },
    { label: 'Playlists', tab: 'Playlists' },
  ],
  instagram: [
    { label: 'Overview', tab: 'Instagram Overview' },
    { label: 'Reel', tab: 'Create' },
    { label: 'Story', tab: 'Create' },
    { label: 'Accounts', tab: 'Accounts' },
    { label: 'Story Pools', tab: 'Story Pools' },
    { label: 'Analytics', tab: 'Analytics' },
  ],
  tiktok: [
    { label: 'Overview', tab: 'TikTok Overview' },
    { label: 'Videos', tab: 'Publish' },
    { label: 'Accounts', tab: 'Accounts' },
  ],
  threads: [
    { label: 'Overview', tab: 'Threads Overview' },
    { label: 'Workspace', tab: 'Threads' },
  ],
};

export function navigationForTab(tab: Tab, preferredPlatform: Platform) {
  const candidates = [preferredPlatform, ...platforms.map(({ id }) => id)];
  for (const platform of candidates) {
    const section = platformSections[platform].find((item) => item.tab === tab);
    if (section) return { platform, section: section.label };
  }
  throw new Error('SNS Studio tab has no navigation entry');
}
