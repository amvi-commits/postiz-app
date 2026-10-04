import { navigationForTab, platforms, platformSections, type Tab } from './studio-navigation';

describe('SNS Studio integration navigation', () => {
  it('exposes the five platforms and verified YouTube submenus', () => {
    expect(platforms.map(({ label }) => label)).toEqual(['共通機能', 'YouTube', 'Instagram', 'TikTok', 'Threads']);
    expect(platformSections.youtube.map(({ label }) => label)).toEqual(['Overview', '通常動画', 'Shorts', 'Channels', 'Playlists']);
  });

  it('keeps every existing Integration workspace reachable', () => {
    const tabs: Tab[] = ['Dashboard', 'Accounts', 'Content Inbox', 'Create', 'Publish', 'Threads', 'Common Queue', 'Common History', 'Common Analytics', 'Story Pools', 'Automation Recipes', 'Queue', 'Analytics', 'Settings'];
    for (const tab of tabs) expect(navigationForTab(tab, 'common')).toBeDefined();
    expect(navigationForTab('Publish', 'threads')).toEqual({ platform: 'common', section: 'Cross Post' });
    expect(navigationForTab('Threads', 'common')).toEqual({ platform: 'threads', section: 'Workspace' });
  });

  it('retains shared publishing and account routes for TikTok and Instagram', () => {
    expect(navigationForTab('Publish', 'tiktok')).toEqual({ platform: 'tiktok', section: 'Videos' });
    expect(navigationForTab('Accounts', 'tiktok')).toEqual({ platform: 'tiktok', section: 'Accounts' });
    expect(navigationForTab('Create', 'instagram')).toEqual({ platform: 'instagram', section: 'Reel' });
    expect(platformSections.common.slice(0, 9).map(({ label }) => label)).toEqual(['Dashboard', 'Content Inbox', 'Video Tools', 'Automation', 'Queue', 'Calendar', 'Analytics', 'Settings', 'Cross Post']);
  });
});
