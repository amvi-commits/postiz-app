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

import { SnsStudioCommonPublishingController } from '../../api/routes/sns-studio-common-publishing.controller';

describe('SnsStudioCommonPublishingController', () => {
  it('keeps policy writes scoped to the requesting organization', async () => {
    const service = {
      updateAccountPolicy: jest.fn().mockResolvedValue({ policy: {} }),
    };
    const controller = new SnsStudioCommonPublishingController(service as any);

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
    const controller = new SnsStudioCommonPublishingController(service as any);

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
    const controller = new SnsStudioCommonPublishingController(service as any);

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
});
