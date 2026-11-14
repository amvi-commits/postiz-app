import { saveCommonContentPlan, preflightCommonContentPlan, linkCommonContentPosts } from './common-publish-api';

describe('shared content plan requests', () => {
  const response = (body: unknown, ok = true) => ({ ok, json: async () => body } as Response);
  it('creates then updates the returned plan ID with the same API contract', async () => {
    const request = jest.fn().mockResolvedValue(response({ id: 'plan-1' }));
    const plan = await saveCommonContentPlan(request, { commonContent: 'Draft' });
    await saveCommonContentPlan(request, { commonContent: 'Updated' }, plan.id);
    expect(request.mock.calls.map(([url, init]) => [url, init.method])).toEqual([
      ['/sns-studio/content-plans', 'POST'], ['/sns-studio/content-plans/plan-1', 'PUT'],
    ]);
  });
  it('surfaces a failed save without returning an ID', async () => {
    const request = jest.fn().mockResolvedValue(response({ code: 'CONTENT_PLAN_LOCKED_AFTER_POSTIZ_CREATE' }, false));
    await expect(saveCommonContentPlan(request, {}, 'plan-1')).rejects.toThrow('CONTENT_PLAN_LOCKED_AFTER_POSTIZ_CREATE');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('keeps policy blocks visible rather than treating them as an empty response', async () => {
    const request = jest.fn().mockResolvedValue(response({ blockedDeliveries: [{ reasons: [{ message: '承認が必要です。' }] }] }, false));
    await expect(preflightCommonContentPlan(request, 'plan-1', 'now', ['account-1'])).rejects.toThrow('承認が必要です。');
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual({ type: 'now', integrationIds: ['account-1'] });
  });
  it('records provider settings only as post-link execution data', async () => {
    const request = jest.fn().mockResolvedValue(response({}));
    const result = { type: 'now', items: [{ postId: 'post-1', integration: 'account-1', content: 'Final', settings: { browserAccount: 'saved-alias' } }] };
    await linkCommonContentPosts(request, 'plan-1', result);
    expect(JSON.parse(request.mock.calls[0][1].body)).toEqual(result);
    expect(request).toHaveBeenCalledTimes(1);
  });
});
