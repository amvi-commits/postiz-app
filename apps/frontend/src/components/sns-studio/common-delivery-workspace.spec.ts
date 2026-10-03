const mockSWR = jest.fn();

jest.mock(
  '@gitroom/helpers/utils/custom.fetch',
  () => ({ useFetch: () => jest.fn() }),
  { virtual: true }
);
jest.mock('swr', () => ({
  __esModule: true,
  default: (...args: unknown[]) => mockSWR(...args),
}));

import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { CommonDeliveryWorkspace } from './common-delivery-workspace';

const sampleRow: any = {
  deliveryId: 'delivery-one',
  contentId: 'content-one',
  contentTitle: 'Shared short video',
  content: 'A caption',
  finalBody: 'A final caption',
  platform: 'threads',
  integrationId: 'integration-one',
  accountName: '@account-one',
  status: 'planned',
  deliveryStatus: 'PLANNED',
  effectivePublishAt: '2026-10-04T09:00:00.000Z',
  publishedAt: null,
  approvalRequired: true,
  approvedAt: null,
  policy: {
    decision: 'approval_required',
    allowed: false,
    reasons: [{ code: 'approval_required', message: '投稿前に承認してください。' }],
  },
  postId: 'post-one',
  providerPostId: null,
  postUrl: null,
  postState: 'QUEUE',
  failureInformation: null,
  providerPublicationDetail: null,
  analyticsAvailable: true,
  normalizedMetrics: { likes: null, comments: null, shares: null, views: null, reach: null, impressions: null, saves: null, clicks: null },
  selectedVariant: { name: 'Threads variant', mediaAsset: { fileName: 'source.mp4' } },
  settingsOverride: { user: 'selected' },
  providerSettingsSnapshot: { sent: 'actual' },
  resolvedHashtags: ['#shared'],
};

describe('CommonDeliveryWorkspace UI smoke', () => {
  beforeEach(() => {
    mockSWR.mockReset();
    mockSWR.mockImplementation((key: unknown) => ({
      data:
        key === '/sns-studio/common/account-policies'
          ? [{ integrationId: 'integration-one', accountName: '@account-one', providerIdentifier: 'threads' }]
          : [sampleRow],
      mutate: jest.fn(),
      isLoading: false,
    }));
  });

  it.each([
    ['queue', '共通投稿Queue', 'Postiz ID:'],
    ['history', '共通投稿History', 'settingsOverride（ユーザー指定値）'],
    ['analytics', '共通Analytics', '指標を更新'],
  ] as const)('renders the %s view from the Common Delivery API', (view, title, expected) => {
    const html = renderToStaticMarkup(
      React.createElement(CommonDeliveryWorkspace, { view })
    );

    expect(html).toContain(title);
    expect(html).toContain(expected);
    expect(html).toContain('Shared short video');
    expect(mockSWR).toHaveBeenCalledWith(
      `/sns-studio/common/${view === 'queue' ? 'queue' : view === 'history' ? 'history' : 'analytics'}`,
      expect.any(Function)
    );
  });
});
