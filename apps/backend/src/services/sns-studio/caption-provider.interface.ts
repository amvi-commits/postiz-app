export const SNS_STUDIO_CAPTION_PROVIDER = 'SNS_STUDIO_CAPTION_PROVIDER';

export interface CaptionProvider {
  generate(sourceText: string, profile: Record<string, unknown>): Promise<string>;
}
