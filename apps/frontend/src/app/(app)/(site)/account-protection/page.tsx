'use client';

import useSWR from 'swr';
import { useState } from 'react';

type AccountRow = { accountId: string; accountType: string; label: string; provider: string; connected: boolean; protection: any };

export default function AccountProtectionPage() {
  const [message, setMessage] = useState('');
  const fetcher = async (url: string) => { const response = await fetch(url); if (!response.ok) throw new Error('アカウント保護情報を読み込めませんでした。'); return response.json(); };
  const { data: accounts = [], mutate } = useSWR<AccountRow[]>('/account-protection', fetcher);
  const act = async (account: AccountRow, action: string) => {
    setMessage('');
    const response = await fetch(`/account-protection/${encodeURIComponent(account.accountType)}/${encodeURIComponent(account.accountId)}/${action}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: action === 'pause' ? JSON.stringify({ reason: 'Paused by user' }) : '{}' });
    if (!response.ok) { const body = await response.json().catch(() => ({})); setMessage(body.message || '操作に失敗しました。'); return; }
    setMessage(action === 'pause' ? '自動操作を一時停止しました。' : action === 'resume' ? '自動操作を再開しました。' : 'セッション状態を確認しました。');
    await mutate();
  };
  return <main className="p-8">
    <header className="mb-6"><h1 className="text-2xl font-semibold">Account Protection</h1><p className="mt-2 opacity-70">アカウント別の一時停止、認証状態、クールダウン、安全ログを確認します。</p></header>
    {message && <p role="status" className="mb-4">{message}</p>}
    <div className="grid gap-4">
      {accounts.map((account) => {
        const p = account.protection;
        return <section key={`${account.accountType}:${account.accountId}`} className="rounded-lg border p-5">
          <div className="flex flex-wrap items-start justify-between gap-4">
            <div><h2 className="text-lg font-medium">{account.label}</h2><p className="opacity-70">{account.provider} · {account.connected ? '接続済み' : '未接続'}</p></div>
            <div className="flex gap-2">
              <button className="rounded border px-3 py-2" onClick={() => void act(account, 'session-check')}>セッション確認</button>
              {p?.automationPaused ? <button className="rounded border px-3 py-2" onClick={() => void act(account, 'resume')}>再開</button> : <button className="rounded border px-3 py-2" onClick={() => void act(account, 'pause')}>一時停止</button>}
            </div>
          </div>
          <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            <p>保護状態: {p?.securityState || 'HEALTHY'}</p><p>セッション: {p?.session || 'UNKNOWN'}</p>
            <p>ブラウザ: {p?.browser?.status || '未作成'}</p>
            <p>クールダウン: {p?.cooldownUntil ? new Date(p.cooldownUntil).toLocaleString() : 'なし'}</p>
            <p>実行回路: {p?.circuits?.map((c: any) => `${c.actionType}: ${c.state}`).join(', ') || 'CLOSED'}</p>
          </div>
          <details className="mt-4"><summary className="cursor-pointer">操作上限とセキュリティログ</summary>
            <p className="mt-2">レート状態: {p?.rateBudgets?.map((b: any) => `${b.actionType} ${b.usedActions}/${b.maxActions}`).join(' · ') || '安全側の初期値を適用'}</p>
            <Audit account={account} />
          </details>
        </section>;
      })}
      {!accounts.length && <p>接続済みアカウントはありません。</p>}
    </div>
  </main>;
}

function Audit({ account }: { account: AccountRow }) {
  const { data } = useSWR(`/account-protection/${encodeURIComponent(account.accountType)}/${encodeURIComponent(account.accountId)}/audit`, async (url: string) => { const response = await fetch(url); return response.ok ? response.json() : []; });
  return <ul className="mt-3 grid gap-1">{(data || []).map((entry: any, index: number) => <li key={index}>{new Date(entry.createdAt).toLocaleString()} · {entry.severity} · {entry.message}</li>)}</ul>;
}
