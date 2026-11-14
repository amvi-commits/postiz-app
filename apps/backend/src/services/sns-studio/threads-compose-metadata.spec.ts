jest.mock('@gitroom/nestjs-libraries/integrations/integration.manager', () => ({ IntegrationManager: class {} }));
jest.mock('@gitroom/nestjs-libraries/openai/openai.service', () => ({ OpenaiService: class {} }));
import { ThreadsStudioService } from './threads-studio.service';

describe('Threads composer account display metadata', () => {
  const originalTransport = process.env.THREADS_PUBLISH_TRANSPORT;
  const originalGuard = process.env.THREADS_BROWSER_ALLOW_REAL_POST;
  afterEach(() => {
    if (originalTransport === undefined) delete process.env.THREADS_PUBLISH_TRANSPORT; else process.env.THREADS_PUBLISH_TRANSPORT = originalTransport;
    if (originalGuard === undefined) delete process.env.THREADS_BROWSER_ALLOW_REAL_POST; else process.env.THREADS_BROWSER_ALLOW_REAL_POST = originalGuard;
  });
  const accounts = async (overrides: Record<string, unknown> = {}) => {
    const prisma = { integration: { findMany: jest.fn().mockResolvedValue([{ id: 'owned-account', internalId: 'threads_browser_saved_alias', name: 'Different display name', profile: 'public-profile', inBetweenSteps: false, refreshNeeded: false, ...overrides }]) }, snsThreadsAccountSetting: { findMany: jest.fn().mockResolvedValue([]) } };
    const service = new ThreadsStudioService(prisma as any, {} as any, {} as any);
    return { result: await service.getAccounts({ id: 'current-org' } as any), prisma };
  };
  it('uses the saved identity and preserves the fail-closed real post guard', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser'; delete process.env.THREADS_BROWSER_ALLOW_REAL_POST;
    const { result, prisma } = await accounts();
    expect(result[0]).toMatchObject({ transport: 'browser', browserAccount: 'saved_alias', publishBlockedReason: expect.stringContaining('ロック') });
    expect(prisma.integration.findMany).toHaveBeenCalledWith(expect.objectContaining({ where: expect.objectContaining({ organizationId: 'current-org', providerIdentifier: 'threads' }) }));
  });
  it('does not fall back to display name or main when saved identity is invalid', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser'; process.env.THREADS_BROWSER_ALLOW_REAL_POST = 'true';
    expect((await accounts({ internalId: 'threads_browser_../invalid' })).result[0]).toMatchObject({ browserAccount: null, publishBlockedReason: expect.stringContaining('識別情報') });
  });
  it('keeps official API capabilities separate and exposes no Browser alias', async () => {
    delete process.env.THREADS_PUBLISH_TRANSPORT;
    expect((await accounts({ internalId: 'official-id' })).result[0]).toMatchObject({ transport: 'official', browserAccount: null, publishBlockedReason: null });
  });
  it('retains authentication checks even when a Browser routing alias exists', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser'; process.env.THREADS_BROWSER_ALLOW_REAL_POST = 'true';
    expect((await accounts({ refreshNeeded: true })).result[0].publishBlockedReason).toContain('認証');
  });
  it('labels stored official connections correctly and blocks a mismatched global route', async () => {
    process.env.THREADS_PUBLISH_TRANSPORT = 'browser';
    expect((await accounts({ internalId: 'official-id' })).result[0]).toMatchObject({ transport: 'official', browserAccount: null, publishBlockedReason: expect.stringContaining('一致しません') });
  });
});
