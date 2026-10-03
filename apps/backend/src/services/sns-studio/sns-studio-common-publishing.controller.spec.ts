import { ConflictException } from '@nestjs/common';

jest.mock(
  '@gitroom/nestjs-libraries/user/org.from.request',
  () => ({ GetOrgFromRequest: () => () => undefined }),
  { virtual: true }
);
jest.mock(
  '@gitroom/backend/services/sns-studio/common-publishing.service',
  () => ({ CommonPublishingService: class CommonPublishingService {} }),
  { virtual: true }
);
jest.mock(
  '@gitroom/backend/services/sns-studio/common-delivery-view.service',
  () => ({ CommonDeliveryViewService: class CommonDeliveryViewService {} }),
  { virtual: true }
);

import { SnsStudioCommonPublishingController } from '../../api/routes/sns-studio-common-publishing.controller';

describe('SnsStudioCommonPublishingController', () => {
  it('keeps policy writes scoped to the requesting organization', async () => {
    const service = {
      updateAccountPolicy: jest.fn().mockResolvedValue({ policy: {} }),
    };
    const controller = new SnsStudioCommonPublishingController(service as any, {} as any);

    await controller.updateAccountPolicy(
      { id: 'org-one' } as any,
      'integration-one',
      { autoPostEnabled: false }
    );

    expect(service.updateAccountPolicy).toHaveBeenCalledWith(
      'org-one',
      'integration-one',
      { autoPostEnabled: false }
    );
  });

  it('rejects common preflight when any delivery is blocked and returns the reason', async () => {
    const service = {
      evaluateContentPlan: jest.fn().mockResolvedValue({
        deliveries: [
          {
            accountName: '@account-one',
            allowed: false,
            reasons: [{ code: 'approval_required', message: '承認が必要です。' }],
          },
        ],
      }),
    };
    const controller = new SnsStudioCommonPublishingController(service as any, {} as any);

    await expect(
      controller.preflightContentPlan(
        { id: 'org-one' } as any,
        'content-one',
        { type: 'schedule', integrationIds: ['integration-one'] }
      )
    ).rejects.toBeInstanceOf(ConflictException);
    expect(service.evaluateContentPlan).toHaveBeenCalledWith(
      'org-one',
      'content-one',
      ['integration-one'],
      'schedule'
    );
  });

  it('uses a safe publish mode fallback for unknown preflight mode input', async () => {
    const service = {
      evaluateContentPlan: jest.fn().mockResolvedValue({ deliveries: [] }),
    };
    const controller = new SnsStudioCommonPublishingController(service as any, {} as any);

    await expect(
      controller.preflightContentPlan(
        { id: 'org-one' } as any,
        'content-one',
        { type: 'unexpected', integrationIds: ['integration-one'] }
      )
    ).resolves.toEqual({ deliveries: [] });
    expect(service.evaluateContentPlan).toHaveBeenCalledWith(
      'org-one',
      'content-one',
      ['integration-one'],
      'schedule'
    );
  });

  it('keeps common Queue filters inside the requesting organization scope', () => {
    const service = { listQueue: jest.fn().mockResolvedValue([]) };
    const controller = new SnsStudioCommonPublishingController(
      {} as any,
      service as any
    );

    controller.listQueue(
      { id: 'org-one' } as any,
      {
        platform: 'threads',
        accountId: 'integration-one',
        contentId: 'content-one',
        state: 'planned',
        q: 'caption',
      }
    );

    expect(service.listQueue).toHaveBeenCalledWith('org-one', {
      providerIdentifier: 'threads',
      integrationId: 'integration-one',
      contentId: 'content-one',
      state: 'planned',
      query: 'caption',
    });
  });

  it('routes Common Analytics refresh to the selected delivery under the current organization', () => {
    const service = { deliveryAnalytics: jest.fn().mockResolvedValue({ available: false }) };
    const controller = new SnsStudioCommonPublishingController(
      {} as any,
      service as any
    );

    controller.deliveryAnalytics(
      { id: 'org-one' } as any,
      'delivery-one',
      '1760000000000'
    );

    expect(service.deliveryAnalytics).toHaveBeenCalledWith(
      'org-one',
      'delivery-one',
      1760000000000
    );
  });

  it('routes History and Analytics lists through the requesting organization and filters', () => {
    const service = {
      listHistory: jest.fn().mockResolvedValue([]),
      listAnalytics: jest.fn().mockResolvedValue([]),
    };
    const controller = new SnsStudioCommonPublishingController(
      {} as any,
      service as any
    );
    const filters = { platform: 'youtube', accountId: 'integration-two', state: 'published' };

    controller.listHistory({ id: 'org-two' } as any, filters);
    controller.listAnalytics({ id: 'org-two' } as any, filters);

    expect(service.listHistory).toHaveBeenCalledWith('org-two', {
      providerIdentifier: 'youtube',
      integrationId: 'integration-two',
      contentId: undefined,
      state: 'published',
      query: undefined,
    });
    expect(service.listAnalytics).toHaveBeenCalledWith('org-two', {
      providerIdentifier: 'youtube',
      integrationId: 'integration-two',
      contentId: undefined,
      state: 'published',
      query: undefined,
    });
  });
});
