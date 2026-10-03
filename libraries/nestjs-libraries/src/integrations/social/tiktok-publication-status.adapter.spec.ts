import { State } from '@prisma/client';
import { tiktokPublicationDetail } from './tiktok-publication-status.adapter';

describe('TikTok common publication status', () => {
  const published = {
    state: State.PUBLISHED,
    settings: JSON.stringify({ content_posting_method: 'UPLOAD' }),
    releaseId: 'release-123',
  };

  it('keeps UPLOAD in the inbox distinct from a public publication', () => {
    expect(tiktokPublicationDetail(published as any)).toEqual({
      providerStatus: 'uploaded_to_inbox',
      label: 'TikTokの受信箱へアップロード済み（公開前）',
      publicPublication: false,
    });
  });

  it('does not label ordinary released posts as inbox uploads', () => {
    expect(tiktokPublicationDetail({
      ...published,
      settings: JSON.stringify({ content_posting_method: 'DIRECT_POST' }),
    } as any)).toBeUndefined();
  });

  it('does not mark an UPLOAD as published until Postiz says it is published', () => {
    expect(tiktokPublicationDetail({
      ...published,
      state: State.QUEUED,
    } as any)).toBeUndefined();
  });
});