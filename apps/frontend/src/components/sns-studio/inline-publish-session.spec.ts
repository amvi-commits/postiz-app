import { InlinePublishSession, initialDestinations, threadsConnection } from './inline-publish-session';

describe('persisted Threads connection metadata', () => {
  const saved = JSON.stringify([{ title: 'transport', value: 'browser' }, { title: 'browserAccount', value: 'qa-profile' }]);
  it('uses persisted explicit connection settings without a metadata API extension', () => {
    expect(threadsConnection(saved)).toEqual({ transport: 'browser', browserAccount: 'qa-profile' });
  });
  it('does not infer transport or main when metadata is missing', () => {
    expect(threadsConnection('[]')).toEqual({ transport: 'unknown' });
  });
  it('does not replace a missing Browser alias', () => {
    expect(threadsConnection('[{"title":"transport","value":"browser"}]')).toEqual({ transport: 'browser', browserAccount: undefined });
  });
  it('fails closed for conflicting saved and reported transport', () => {
    expect(threadsConnection(saved, { transport: 'api' }).transport).toBe('unknown');
  });
  it('fails closed for conflicting profile bindings', () => {
    expect(threadsConnection(saved, { transport: 'browser', browserAccount: 'other' }).transport).toBe('unknown');
  });
  it('recognizes explicit Official API metadata', () => {
    expect(threadsConnection('[]', { transport: 'api' }).transport).toBe('official');
  });
  it('keeps malformed settings unknown', () => {
    expect(threadsConnection('invalid').transport).toBe('unknown');
  });
});

const response = (id: string, ok = true) => ({ ok, json: async () => ({ id }) } as Response);
describe('inline publisher server identities', () => {
  const accounts = [{ id: 'a', identifier: 'threads' }, { id: 'b', identifier: 'threads' }, { id: 'c', identifier: 'youtube' }];
  it('gives an explicit account priority over a platform preset', () => {
    expect(initialDestinations(accounts, 'b', 'threads')).toEqual(['b']);
  });
  it('never substitutes a missing explicit account', () => {
    expect(initialDestinations(accounts, 'missing', 'threads')).toEqual([]);
  });
  it('uses only Threads for a platform preset', () => {
    expect(initialDestinations(accounts, undefined, 'threads')).toEqual(['a', 'b']);
  });
  it('updates a saved plan rather than creating another', async () => {
    const fetch = jest.fn().mockResolvedValue(response('plan'));
    const session = new InlinePublishSession();
    await session.prepare(fetch, { commonContent: 'first' });
    await session.prepare(fetch, { commonContent: 'edited' });
    expect(fetch.mock.calls.map(c => c[1].method)).toEqual(['POST', 'PUT']);
    expect(fetch.mock.calls[1][0]).toBe('/sns-studio/content-plans/plan');
  });
  it('keeps the canonical Post draft after it has been linked', async () => {
    const fetch = jest.fn().mockResolvedValue(response('plan'));
    const session = new InlinePublishSession();
    await session.prepare(fetch, {}); session.linked = true;
    expect(await session.prepare(fetch, { commonContent: 'edit in Post' })).toBe('plan');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('does not proceed after a rejected save', async () => {
    const fetch = jest.fn().mockResolvedValue(response('', false));
    const session = new InlinePublishSession();
    await expect(session.prepare(fetch, {})).rejects.toThrow();
    expect(session.planId).toBe('');
  });
  it('stops automatic resubmission after a timeout', async () => {
    const fetch = jest.fn().mockRejectedValue(new Error('timeout'));
    const session = new InlinePublishSession();
    await expect(session.prepare(fetch, {})).rejects.toThrow('timeout');
    await expect(session.prepare(fetch, {})).rejects.toThrow('再送');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('stops after a successful save with an unreadable response', async () => {
    const fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => { throw new Error('invalid json'); } });
    const session = new InlinePublishSession();
    await expect(session.prepare(fetch, {})).rejects.toThrow();
    expect(session.uncertain).toBe(true);
  });
  it('does not share server identities between organizations', () => {
    const first = new InlinePublishSession(); first.planId = 'org-a'; first.uncertain = true;
    const second = new InlinePublishSession();
    expect(second.planId).toBe(''); expect(second.uncertain).toBe(false);
  });
});
