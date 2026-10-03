import {
  Body,
  ConflictException,
  Controller,
  Get,
  Param,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import { Organization } from '@prisma/client';
import { ApiTags } from '@nestjs/swagger';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import {
  CommonAccountPolicy,
  CommonPublishMode,
  CommonPublishingService,
} from '@gitroom/backend/services/sns-studio/common-publishing.service';
import {
  CommonDeliveryFilters,
  CommonDeliveryViewService,
} from '@gitroom/backend/services/sns-studio/common-delivery-view.service';

function publishMode(value: unknown): CommonPublishMode {
  return value === 'draft' || value === 'now' || value === 'schedule'
    ? value
    : 'schedule';
}

function deliveryFilters(query: Record<string, unknown>): CommonDeliveryFilters {
  const value = (key: string) =>
    typeof query?.[key] === 'string' && query[key].trim()
      ? query[key].trim()
      : undefined;
  return {
    providerIdentifier: value('platform'),
    integrationId: value('accountId'),
    contentId: value('contentId'),
    state: value('state'),
    query: value('q'),
  };
}

@ApiTags('SNS Studio Common Publishing')
@Controller('/sns-studio/common')
export class SnsStudioCommonPublishingController {
  constructor(
    private readonly commonPublishing: CommonPublishingService,
    private readonly deliveryViews: CommonDeliveryViewService
  ) {}

  @Get('/queue')
  listQueue(
    @GetOrgFromRequest() org: Organization,
    @Query() query: Record<string, unknown>
  ) {
    return this.deliveryViews.listQueue(org.id, deliveryFilters(query));
  }

  @Get('/history')
  listHistory(
    @GetOrgFromRequest() org: Organization,
    @Query() query: Record<string, unknown>
  ) {
    return this.deliveryViews.listHistory(org.id, deliveryFilters(query));
  }

  @Get('/analytics')
  listAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Query() query: Record<string, unknown>
  ) {
    return this.deliveryViews.listAnalytics(org.id, deliveryFilters(query));
  }

  @Get('/analytics/:deliveryId')
  deliveryAnalytics(
    @GetOrgFromRequest() org: Organization,
    @Param('deliveryId') deliveryId: string,
    @Query('date') date: string
  ) {
    const timestamp = Number(date);
    return this.deliveryViews.deliveryAnalytics(
      org.id,
      deliveryId,
      Number.isFinite(timestamp) && timestamp > 0 ? timestamp : Date.now()
    );
  }

  @Get('/account-policies')
  listAccountPolicies(@GetOrgFromRequest() org: Organization) {
    return this.commonPublishing.listAccountPolicies(org.id);
  }

  @Put('/account-policies/:integrationId')
  updateAccountPolicy(
    @GetOrgFromRequest() org: Organization,
    @Param('integrationId') integrationId: string,
    @Body() body: Partial<CommonAccountPolicy>
  ) {
    return this.commonPublishing.updateAccountPolicy(
      org.id,
      integrationId,
      body
    );
  }

  @Get('/content-plans/:contentId/policy')
  evaluateContentPlan(
    @GetOrgFromRequest() org: Organization,
    @Param('contentId') contentId: string,
    @Query('mode') mode: string
  ) {
    return this.commonPublishing.evaluateContentPlan(
      org.id,
      contentId,
      undefined,
      publishMode(mode)
    );
  }

  @Post('/content-plans/:contentId/preflight')
  async preflightContentPlan(
    @GetOrgFromRequest() org: Organization,
    @Param('contentId') contentId: string,
    @Body()
    body: {
      type?: string;
      integrationIds?: string[];
    }
  ) {
    const integrationIds = Array.isArray(body?.integrationIds)
      ? body.integrationIds.filter((id): id is string => typeof id === 'string')
      : [];
    const evaluation = await this.commonPublishing.evaluateContentPlan(
      org.id,
      contentId,
      integrationIds,
      publishMode(body?.type)
    );
    const blocked = evaluation.deliveries.filter(({ allowed }) => !allowed);
    if (blocked.length) {
      throw new ConflictException({
        code: 'COMMON_PUBLISH_POLICY_BLOCKED',
        message: blocked
          .flatMap((delivery) =>
            delivery.reasons.map(
              (reason) => `${delivery.accountName}: ${reason.message}`
            )
          )
          .join(' '),
        blockedDeliveries: blocked,
      });
    }
    return evaluation;
  }

  @Post('/content-plans/:contentId/deliveries/:deliveryId/approve')
  approveDelivery(
    @GetOrgFromRequest() org: Organization,
    @Param('contentId') contentId: string,
    @Param('deliveryId') deliveryId: string
  ) {
    return this.commonPublishing.approveDelivery(
      org.id,
      contentId,
      deliveryId
    );
  }
}
