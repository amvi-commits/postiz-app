'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import useSWR from 'swr';
import { useFetch } from '@gitroom/helpers/utils/custom.fetch';

type Policy = {
  autoPostEnabled: boolean;
  approvalRequired: boolean;
  maxPostsPerDay: number | null;
  sameContentCooldownDays: number;
};

type Account = {
  id: string;
  name: string;
  identifier: string;
  disabled?: boolean;
};

type AccountPolicyRecord = {
  integrationId: string;
  policy: Policy;
};

type PolicyEvaluation = {
  deliveries: Array<{
    deliveryId: string;
    integrationId: string;
    approvalRequired: boolean;
    approvedAt: string | null;
    allowed: boolean;
    decision: 'allowed' | 'blocked' | 'approval_required';
    reasons: Array<{ code: string; message: string }>;
  }>;
};

const defaults: Policy = {
  autoPostEnabled: true,
  approvalRequired: false,
  maxPostsPerDay: null,
  sameContentCooldownDays: 0,
};

const card = 'rounded-lg border border-blockSeparator p-4';
const field =
  'w-full rounded-lg border border-blockSeparator bg-newBgColorInner px-3 py-2 text-newTextColor outline-none focus:border-[#7774ff]';
const button =
  'rounded-lg border border-blockSeparator px-3 py-2 text-sm font-semibold hover:bg-boxFocused disabled:opacity-50';

export const CommonAccountPolicyPanel = ({
  accounts,
  contentPlanId,
}: {
  accounts: Account[];
  contentPlanId: string | null;
}) => {
  const fetch = useFetch();
  const [drafts, setDrafts] = useState<Record<string, Policy>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [message, setMessage] = useState('');

  const request = useCallback(
    async (path: string, init?: RequestInit) => {
      const response = await fetch(path, {
        ...init,
        headers: {
          ...(init?.body ? { 'Content-Type': 'application/json' } : {}),
          ...init?.headers,
        },
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) {
        throw new Error(payload?.message || payload?.code || '処理に失敗しました。');
      }
      return payload;
    },
    [fetch]
  );
  const { data: savedPolicies = [], mutate: refreshPolicies } = useSWR<
    AccountPolicyRecord[]
  >('/sns-studio/common/account-policies', (path: string) => request(path));
  const evaluationUrl = contentPlanId
    ? `/sns-studio/common/content-plans/${contentPlanId}/policy?mode=schedule`
    : null;
  const { data: evaluation, mutate: refreshEvaluation } = useSWR<PolicyEvaluation>(
    evaluationUrl,
    (path: string) => request(path)
  );

  const accountPolicy = useMemo(() => {
    const saved = new Map(
      savedPolicies.map((record) => [record.integrationId, record.policy])
    );
    return Object.fromEntries(
      accounts.map((account) => [
        account.id,
        drafts[account.id] || saved.get(account.id) || defaults,
      ])
    ) as Record<string, Policy>;
  }, [accounts, drafts, savedPolicies]);

  useEffect(() => {
    setDrafts((current) => {
      const next = { ...current };
      for (const record of savedPolicies) {
        if (!next[record.integrationId]) next[record.integrationId] = record.policy;
      }
      return next;
    });
  }, [savedPolicies]);

  const update = (accountId: string, patch: Partial<Policy>) => {
    setDrafts((current) => ({
      ...current,
      [accountId]: { ...(accountPolicy[accountId] || defaults), ...patch },
    }));
  };

  const save = async (account: Account) => {
    setSaving((current) => ({ ...current, [account.id]: true }));
    setMessage('');
    try {
      await request(`/sns-studio/common/account-policies/${account.id}`, {
        method: 'PUT',
        body: JSON.stringify(accountPolicy[account.id] || defaults),
      });
      await refreshPolicies();
      await refreshEvaluation();
      setMessage(`${account.name} の投稿Policyを保存しました。`);
    } catch (error) {
      setMessage(
        error instanceof Error
          ? error.message
          : '投稿Policyを保存できませんでした。'
      );
    } finally {
      setSaving((current) => ({ ...current, [account.id]: false }));
    }
  };

  const approve = async (deliveryId: string) => {
    if (!contentPlanId) return;
    setMessage('');
    try {
      await request(
        `/sns-studio/common/content-plans/${contentPlanId}/deliveries/${deliveryId}/approve`,
        { method: 'POST', body: '{}' }
      );
      await refreshEvaluation();
      setMessage('配信先を承認しました。');
    } catch (error) {
      setMessage(
        error instanceof Error ? error.message : '配信先を承認できませんでした。'
      );
    }
  };

  const evaluationByAccount = new Map(
    (evaluation?.deliveries || []).map((delivery) => [
      delivery.integrationId,
      delivery,
    ])
  );

  return (
    <section className="grid gap-4 rounded-xl border border-blockSeparator bg-newBgColorInner p-5">
      <div>
        <h3 className="font-semibold">アカウント投稿Policy</h3>
        <p className="mt-1 text-xs text-textItemBlur">
          Common Publishingのアカウント単位設定です。上限は直近24時間、同一コンテンツは同じ元素材IDで判定します。
        </p>
      </div>
      {message && <p className="text-sm">{message}</p>}
      {accounts.length === 0 ? (
        <p className="text-sm text-textItemBlur">共通投稿に使えるアカウントがありません。</p>
      ) : (
        <div className="grid gap-3">
          {accounts.map((account) => {
            const policy = accountPolicy[account.id] || defaults;
            const currentEvaluation = evaluationByAccount.get(account.id);
            return (
              <div key={account.id} className={card}>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <div className="font-semibold">{account.name}</div>
                    <div className="text-xs text-textItemBlur">
                      {account.identifier}
                      {account.disabled ? ' · 無効' : ''}
                    </div>
                  </div>
                  <button
                    type="button"
                    className={button}
                    disabled={!!saving[account.id] || !!account.disabled}
                    onClick={() => void save(account)}
                  >
                    {saving[account.id] ? '保存中...' : 'Policyを保存'}
                  </button>
                </div>

                <div className="mt-4 grid gap-3 md:grid-cols-2">
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.autoPostEnabled}
                      onChange={(event) =>
                        update(account.id, { autoPostEnabled: event.target.checked })
                      }
                    />
                    自動投稿を許可する
                  </label>
                  <label className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={policy.approvalRequired}
                      onChange={(event) =>
                        update(account.id, { approvalRequired: event.target.checked })
                      }
                    />
                    投稿前に承認を必須にする
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span>直近24時間の投稿上限（空欄=上限なし）</span>
                    <input
                      className={field}
                      type="number"
                      min={1}
                      max={100}
                      value={policy.maxPostsPerDay ?? ''}
                      onChange={(event) =>
                        update(account.id, {
                          maxPostsPerDay:
                            event.target.value === '' ? null : Number(event.target.value),
                        })
                      }
                    />
                  </label>
                  <label className="grid gap-1 text-xs">
                    <span>同じ元素材の再投稿待機期間（日）</span>
                    <input
                      className={field}
                      type="number"
                      min={0}
                      max={365}
                      value={policy.sameContentCooldownDays}
                      onChange={(event) =>
                        update(account.id, {
                          sameContentCooldownDays: Number(event.target.value),
                        })
                      }
                    />
                  </label>
                </div>

                {currentEvaluation && (
                  <div className="mt-4 border-t border-blockSeparator pt-3 text-sm">
                    <div className="font-medium">
                      {currentEvaluation.allowed
                        ? '投稿可能'
                        : currentEvaluation.decision === 'approval_required'
                          ? '承認待ち'
                          : '投稿ブロック'}
                    </div>
                    {currentEvaluation.reasons.map((reason) => (
                      <p key={reason.code} className="mt-1 text-xs text-textItemBlur">
                        {reason.message}
                      </p>
                    ))}
                    {currentEvaluation.approvalRequired &&
                      !currentEvaluation.approvedAt &&
                      contentPlanId && (
                        <button
                          type="button"
                          className={`${button} mt-3`}
                          onClick={() => void approve(currentEvaluation.deliveryId)}
                        >
                          この配信先を承認
                        </button>
                      )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      )}
    </section>
  );
};
