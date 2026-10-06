import { State } from '@prisma/client';
import {
  CommonPostPublicationContext,
  ProviderPublicationDetail,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';

function storedSettings(value: string | null | undefined) {
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

export function tiktokPublicationDetail(
  post: CommonPostPublicationContext
): ProviderPublicationDetail | undefined {
  if (post.state !== State.PUBLISHED) return undefined;

  const settings = storedSettings(post.settings);
  if (
    settings.content_posting_method !== 'UPLOAD' &&
    post.releaseId !== 'missing'
  ) {
    return undefined;
  }

  return {
    providerStatus: 'uploaded_to_inbox',
    label: 'TikTokの受信箱へアップロード済み（公開前）',
    publicPublication: false,
  };
}
