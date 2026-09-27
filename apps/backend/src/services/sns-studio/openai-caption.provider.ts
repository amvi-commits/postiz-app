import { Injectable } from '@nestjs/common';
import { OpenaiService } from '@gitroom/nestjs-libraries/openai/openai.service';
import type { CaptionProvider } from './caption-provider.interface';

@Injectable()
export class OpenAICaptionProvider implements CaptionProvider {
  constructor(private readonly openai: OpenaiService) {}

  generate(sourceText: string, profile: Record<string, unknown>) {
    return this.openai.generateInstagramCaption(sourceText, profile);
  }
}
