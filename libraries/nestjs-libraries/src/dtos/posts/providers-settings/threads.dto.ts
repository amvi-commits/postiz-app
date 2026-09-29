import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { Type } from 'class-transformer';
import { JSONSchema } from 'class-validator-jsonschema';
import type {
  ThreadsReplyControl,
  ThreadsTextAttachment,
  ThreadsGifAttachment,
} from '@gitroom/nestjs-libraries/integrations/social/threads.capabilities';

export class ThreadsPollDto {
  @IsArray()
  @IsString({ each: true })
  @JSONSchema({
    description: 'Poll options (2 to 4 options, each up to 25 characters)',
  })
  options: string[];
}

export class ThreadsTextSpoilerRangeDto {
  @IsNumber()
  offset: number;

  @IsNumber()
  length: number;
}

export class ThreadsTextAttachmentDto {
  @IsString()
  @MaxLength(10000, { message: 'Text attachment plaintext must be 10000 characters or less' })
  @JSONSchema({
    description: 'Plaintext for long-form text attachment up to 10,000 characters',
  })
  plaintext: string;

  @IsOptional()
  @IsString()
  @JSONSchema({
    description: 'Optional URL for link attachment inside the text attachment',
  })
  link_attachment_url?: string;
}

export class ThreadsGifDto {
  @IsString()
  @JSONSchema({
    description: 'GIF ID from GIPHY',
  })
  gif_id: string;

  @IsOptional()
  @IsString()
  @JSONSchema({
    description: 'GIF provider (defaults to GIPHY)',
  })
  provider?: string;
}

export class ThreadsDto {
  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description: 'Ghost post: auto-archives 24 hours after publishing (official Threads feature, text only)',
  })
  isGhostPost?: boolean;

  @IsOptional()
  @ValidateNested()
  @Type(() => ThreadsPollDto)
  @JSONSchema({
    description: 'Poll attachment with 2-4 options (text-only posts)',
  })
  poll?: ThreadsPollDto;

  @IsOptional()
  @IsString()
  @MaxLength(50, { message: 'Topic tag must be 50 characters or less' })
  @JSONSchema({
    description: 'Official topic tag for the post (without #, up to 50 characters, no period or ampersand)',
  })
  topicTag?: string;

  @IsOptional()
  @IsString()
  @JSONSchema({
    description: 'Location ID for tagging a place on Threads (obtained from location search)',
  })
  locationId?: string;

  @IsOptional()
  @IsString()
  locationName?: string;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description: 'Obscure attached media as a spoiler until clicked',
  })
  isSpoilerMedia?: boolean;

  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => ThreadsTextSpoilerRangeDto)
  @JSONSchema({
    description: 'Text ranges in the post content to mask as spoilers',
  })
  textSpoilerRanges?: ThreadsTextSpoilerRangeDto[];

  @IsOptional()
  @JSONSchema({
    description: 'Long-form text attachment up to 10,000 characters (string or { plaintext, link_attachment_url })',
  })
  textAttachment?: ThreadsTextAttachment;

  @IsOptional()
  @IsString()
  linkAttachment?: string;

  @IsOptional()
  @ValidateNested()
  @Type(() => ThreadsGifDto)
  @JSONSchema({
    description: 'GIF attachment via GIPHY',
  })
  gifAttachment?: ThreadsGifAttachment;

  @IsOptional()
  @IsIn([
    'everyone',
    'accounts_you_follow',
    'mentioned_only',
    'parent_post_author_only',
    'followers_only',
  ])
  @JSONSchema({
    description: 'Who can reply to this Threads post',
  })
  replyControl?: ThreadsReplyControl;

  @IsOptional()
  @IsBoolean()
  @JSONSchema({
    description: 'Require author approval before replies appear publicly',
  })
  enableReplyApprovals?: boolean;

  @IsOptional()
  @IsString()
  @JSONSchema({
    description: 'Threads post ID or permalink to quote',
  })
  quotePostId?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000, { message: 'Alt text must be 1000 characters or less' })
  @JSONSchema({
    description: 'Accessibility alt text for images/videos',
  })
  altText?: string;

  @IsOptional()
  @IsBoolean()
  active_thread_finisher?: boolean;

  @IsOptional()
  @IsString()
  thread_finisher?: string;

  @IsOptional()
  @IsNumber()
  @JSONSchema({
    description: 'Interval in minutes between subsequent thread posts (0 for immediate, 1, 2, 5, 10, 15, 30, 60, 120)',
  })
  threadInterval?: number;
}
