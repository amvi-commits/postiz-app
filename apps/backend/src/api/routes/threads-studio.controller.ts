import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { ApiTags } from '@nestjs/swagger';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { ThreadsStudioService } from '@gitroom/backend/services/sns-studio/threads-studio.service';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  MinLength,
} from 'class-validator';

class UpdateAccountSettingsDto {
  @IsOptional() @IsString() displayName?: string;
  @IsOptional() @IsBoolean() autoPostEnabled?: boolean;
  @IsOptional() @IsString() defaultReplyControl?: string;
  @IsOptional() @IsBoolean() aiReplyEnabled?: boolean;
  @IsOptional() @IsBoolean() autoReplyEnabled?: boolean;
  @IsOptional() autoReplyRules?: any;
  @IsOptional() @IsNumber() maxPostsPerDay?: number;
  @IsOptional() @IsNumber() maxRepliesPerDay?: number;
  @IsOptional() defaultPostTimes?: any;
  @IsOptional() @IsString() aiCharacter?: string;
  @IsOptional() @IsString() tone?: string;
  @IsOptional() ngWords?: any;
  @IsOptional() @IsBoolean() autoPlugEnabled?: boolean;
  @IsOptional() autoPlugRules?: any;
}

class ReplyInboxDto {
  @IsString() @MinLength(1) text!: string;
}

class HideInboxDto {
  @IsBoolean() hide!: boolean;
}

class ApproveInboxDto {
  @IsBoolean() approve!: boolean;
}

class AiReplyDraftDto {
  @IsOptional() @IsString() itemId?: string;
  @IsString() @MinLength(1) replyText!: string;
  @IsOptional() @IsString() postSnippet?: string;
  @IsOptional() @IsString() replierUsername?: string;
  @IsOptional() @IsIn(['polite', 'casual', 'concise']) tone?: 'polite' | 'casual' | 'concise';
  @IsOptional() @IsString() customPrompt?: string;
}

class SaveReferencePostDto {
  @IsString() threadsPostId!: string;
  @IsString() authorUsername!: string;
  @IsOptional() @IsString() authorProfilePic?: string;
  @IsString() content!: string;
  @IsOptional() @IsArray() mediaUrls?: string[];
  @IsOptional() @IsString() topicTag?: string;
  @IsOptional() @IsString() permalink?: string;
  @IsOptional() @IsNumber() likesCount?: number;
  @IsOptional() @IsNumber() repliesCount?: number;
  @IsOptional() @IsNumber() repostsCount?: number;
  @IsOptional() @IsNumber() quotesCount?: number;
  @IsOptional() @IsNumber() viewsCount?: number;
  @IsOptional() @IsString() category?: string;
  @IsOptional() @IsString() notes?: string;
}

class GenerateThreadsPostDto {
  @IsIn(['standard', 'short', 'long', 'thread', 'ghost', 'poll'])
  mode!: 'standard' | 'short' | 'long' | 'thread' | 'ghost' | 'poll';
  @IsString() @MinLength(1) topic!: string;
  @IsOptional() @IsArray() referencePostIds?: string[];
  @IsOptional() @IsString() tone?: string;
  @IsOptional() @IsString() topicTag?: string;
}

class SyncInboxDto {
  @IsOptional() @IsString() integrationId?: string;
}

class ConnectThreadsBrowserDto {
  @IsOptional() @IsString() account?: string;
}

class VerifyThreadsBrowserDto {
  @IsOptional() @IsString() account?: string;
  @IsOptional() @IsString() text?: string;
  @IsOptional() @IsArray() mediaUrls?: string[];
  @IsOptional() @IsBoolean() isGhost?: boolean;
  @IsOptional() @IsBoolean() checkHealth?: boolean;
  @IsOptional() @IsBoolean() checkSession?: boolean;
  @IsOptional() @IsBoolean() dryRunPost?: boolean;
}

@ApiTags('Threads Studio')
@Controller('/threads-studio')
export class ThreadsStudioController {
  constructor(private readonly threadsStudioService: ThreadsStudioService) {}

  @Get('/capabilities')
  getCapabilities() {
    return this.threadsStudioService.getCapabilities();
  }

  @Get('/accounts')
  getAccounts(@GetOrgFromRequest() org: Organization) {
    return this.threadsStudioService.getAccounts(org);
  }

  @Put('/accounts/:integrationId/settings')
  updateAccountSettings(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: UpdateAccountSettingsDto
  ) {
    return this.threadsStudioService.updateAccountSettings(
      org,
      integrationId,
      body
    );
  }

  @Get('/inbox')
  getInbox(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationId') integrationId?: string,
    @Query('status') status?: string,
    @Query('itemType') itemType?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number
  ) {
    return this.threadsStudioService.getInboxItems(org, {
      integrationId,
      status,
      itemType,
      page,
      limit,
    });
  }

  @Post('/inbox/sync')
  syncInbox(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SyncInboxDto
  ) {
    return this.threadsStudioService.syncInbox(org, body?.integrationId);
  }

  @Post('/inbox/:id/reply')
  replyToInbox(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: ReplyInboxDto
  ) {
    return this.threadsStudioService.replyToInboxItem(org, id, body.text);
  }

  @Post('/inbox/:id/hide')
  hideInbox(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: HideInboxDto
  ) {
    return this.threadsStudioService.hideInboxItem(org, id, body.hide);
  }

  @Post('/inbox/:id/approval')
  approveInbox(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string,
    @Body() body: ApproveInboxDto
  ) {
    return this.threadsStudioService.approvePendingReply(org, id, body.approve);
  }

  @Post('/inbox/ai-reply-draft')
  generateAiReplyDraft(
    @GetOrgFromRequest() org: Organization,
    @Body() body: AiReplyDraftDto
  ) {
    return this.threadsStudioService.generateAiReplyDraft(org, body);
  }

  @Post('/inbox/:id/auto-reply-check')
  checkAutoReply(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.threadsStudioService.checkAndRunAutoReply(org, id);
  }

  @Get('/research')
  searchThreads(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationId') integrationId: string,
    @Query('q') query: string,
    @Query('searchType') searchType?: 'TOP' | 'RECENT',
    @Query('searchMode') searchMode?: 'KEYWORD' | 'TAG'
  ) {
    return this.threadsStudioService.searchThreads(
      org,
      integrationId,
      query,
      searchType,
      searchMode
    );
  }

  @Get('/locations/search')
  searchLocations(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationId') integrationId: string,
    @Query('query') query: string
  ) {
    return this.threadsStudioService.searchLocations(org, integrationId, query);
  }

  @Get('/accounts/:integrationId/quota')
  getPublishingLimit(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string
  ) {
    return this.threadsStudioService.getPublishingLimit(org, integrationId);
  }

  @Post('/reference-posts')
  saveReferencePost(
    @GetOrgFromRequest() org: Organization,
    @Body() body: SaveReferencePostDto
  ) {
    return this.threadsStudioService.saveReferencePost(org, body);
  }

  @Get('/reference-posts')
  getReferencePosts(
    @GetOrgFromRequest() org: Organization,
    @Query('category') category?: string
  ) {
    return this.threadsStudioService.getReferencePosts(org, category);
  }

  @Delete('/reference-posts/:id')
  deleteReferencePost(
    @GetOrgFromRequest() org: Organization,
    @Param('id') id: string
  ) {
    return this.threadsStudioService.deleteReferencePost(org, id);
  }

  @Post('/ai-generate-post')
  generatePost(
    @GetOrgFromRequest() org: Organization,
    @Body() body: GenerateThreadsPostDto
  ) {
    return this.threadsStudioService.generateThreadsPost(org, body);
  }

  @Get('/calendar')
  getCalendar(
    @GetOrgFromRequest() org: Organization,
    @Query('from') from: string,
    @Query('to') to: string
  ) {
    return this.threadsStudioService.getCalendarItems(org, from, to);
  }

  @Get('/analytics')
  getAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Query('integrationId') integrationId?: string,
    @Query('fromDate') fromDate?: string,
    @Query('toDate') toDate?: string
  ) {
    return this.threadsStudioService.getThreadsAnalytics(org, {
      integrationId,
      fromDate,
      toDate,
    });
  }

  @Post('/auto-plug/:postId')
  checkAutoPlug(
    @GetOrgFromRequest() org: Organization,
    @Param('postId') postId: string
  ) {
    return this.threadsStudioService.checkAndTriggerAutoPlug(org, postId);
  }

  @Post('/browser/verify')
  verifyBrowserTransport(
    @Body() body: VerifyThreadsBrowserDto,
    @GetOrgFromRequest() org?: Organization
  ) {
    return this.threadsStudioService.verifyBrowserTransport(body, org);
  }

  @Post('/browser/connect')
  connectBrowserAccount(
    @GetOrgFromRequest() org: Organization,
    @Body() body: ConnectThreadsBrowserDto
  ) {
    return this.threadsStudioService.connectBrowserAccount(org, body);
  }
}

