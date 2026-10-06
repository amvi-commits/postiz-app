'use client';

import {
  PostComment,
  withProvider,
} from '@gitroom/frontend/components/new-launch/providers/high.order.provider';
import { ThreadsSettings } from '@gitroom/frontend/components/new-launch/providers/threads/threads.settings';
import { ThreadsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/threads.dto';

export default withProvider({
  postComment: PostComment.POST,
  minimumCharacters: [],
  SettingsComponent: ThreadsSettings,
  CustomPreviewComponent: undefined,
  dto: ThreadsDto,
  maximumCharacters: 500,
});
