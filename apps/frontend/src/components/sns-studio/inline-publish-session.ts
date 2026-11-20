// Holds server identities across edits. A failed/ambiguous registration must never
// become a new submission simply because the user presses the button again.
export class InlinePublishSession {
  planId = '';
  linked = false;
  uncertain = false;
  async prepare(request: (path: string, init: any) => Promise<Response>, payload: any) {
    if (this.uncertain) throw new Error('結果を確認できません。履歴で状態を確認してください。再送は停止しています。');
    if (this.linked) return this.planId; // Post is the canonical editable draft.
    let response: Response;
    try {
      response = await request(this.planId ? `/sns-studio/content-plans/${this.planId}` : '/sns-studio/content-plans', {
        method: this.planId ? 'PUT' : 'POST', body: JSON.stringify(payload),
      });
    } catch (error) { this.uncertain = true; throw error; }
    let data: any;
    try { data = await response.json(); } catch (error) { this.uncertain = true; throw error; }
    if (!response.ok || !data.id) {
      if (response.status >= 500 || (response.ok && !data.id)) this.uncertain = true;
      throw new Error(data.message || '下書きの準備に失敗しました。');
    }
    this.planId = data.id;
    return this.planId;
  }
}

export function initialDestinations(accounts: Array<{id: string; identifier: string}>, destinationId?: string, platform?: string) {
  return destinationId ? accounts.filter(a => a.id === destinationId).map(a => a.id)
    : accounts.filter(a => !platform || (a.identifier.startsWith('instagram') ? 'instagram' : a.identifier.startsWith('tiktok') ? 'tiktok' : a.identifier) === platform).map(a => a.id);
}

// These are persisted connection settings returned by /integrations/list.
// A display name, refreshNeeded, or missing token is never a transport signal.
export function threadsConnection(settings: string, metadata?: { transport?: string; isBrowser?: boolean; browserAccount?: string }): { transport: 'browser' | 'official' | 'unknown'; browserAccount?: string } {
  let fields: Array<{ title: string; value: any }> = [];
  try { const parsed = JSON.parse(settings || '[]'); if (Array.isArray(parsed)) fields = parsed; } catch { /* unknown is fail closed */ }
  const saved = fields.find(f => f.title === 'transport')?.value;
  const savedAlias = fields.find(f => f.title === 'browserAccount')?.value;
  const reported = metadata?.isBrowser ? 'browser' : metadata?.transport;
  const normalize = (v: string) => v === 'api' ? 'official' : v;
  if (saved && reported && normalize(saved) !== normalize(reported)) return { transport: 'unknown' as const };
  const kind = reported || saved;
  if (kind === 'browser') {
    if (savedAlias && metadata?.browserAccount && savedAlias !== metadata.browserAccount) return { transport: 'unknown' as const };
    const alias = metadata?.browserAccount || savedAlias;
    return { transport: 'browser' as const, browserAccount: typeof alias === 'string' && alias.trim() ? alias : undefined };
  }
  return { transport: kind === 'api' || kind === 'official' ? 'official' as const : 'unknown' as const };
}
