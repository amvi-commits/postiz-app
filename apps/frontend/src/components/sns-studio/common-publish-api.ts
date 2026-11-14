type Request = (path: string, init?: RequestInit) => Promise<Response>;

async function read(response: Response, fallback: string) {
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const reasons = body?.blockedDeliveries
      ?.flatMap(
        (entry: any) =>
          entry.reasons?.map((reason: any) => reason.message) || []
      )
      .join(' ');
    throw new Error(
      (typeof body?.message === 'string' && body.message) ||
        reasons ||
        body?.code ||
        fallback
    );
  }
  return body;
}

export async function saveCommonContentPlan(
  request: Request,
  payload: unknown,
  id?: string | null
) {
  return read(
    await request(
      id ? `/sns-studio/content-plans/${id}` : '/sns-studio/content-plans',
      {
        method: id ? 'PUT' : 'POST',
        body: JSON.stringify(payload),
      }
    ),
    '投稿内容の保存に失敗しました。'
  );
}

export async function preflightCommonContentPlan(
  request: Request,
  id: string,
  type: 'now' | 'schedule',
  integrationIds: string[]
) {
  return read(
    await request(`/sns-studio/common/content-plans/${id}/preflight`, {
      method: 'POST',
      body: JSON.stringify({ type, integrationIds }),
    }),
    '投稿Policyの確認に失敗しました。'
  );
}

export async function linkCommonContentPosts(
  request: Request,
  id: string,
  result: unknown
) {
  return read(
    await request(`/sns-studio/content-plans/${id}/post-links`, {
      method: 'POST',
      body: JSON.stringify(result),
    }),
    '投稿は受付済みですが、配信履歴の紐付けを確認できません。再送せず履歴を確認してください。'
  );
}
