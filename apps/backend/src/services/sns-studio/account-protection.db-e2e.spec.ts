import { createServer, Server } from 'http';
import { randomBytes, randomUUID } from 'crypto';
import { execFileSync } from 'child_process';
import { mkdir, rm } from 'fs/promises';
import { resolve, join } from 'path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import cookieParser from 'cookie-parser';
import { sign as signJwt } from 'jsonwebtoken';
jest.mock('file-type', () => ({ fileTypeFromBuffer: jest.fn() }));

import { AuthMiddleware } from '../auth/auth.middleware';
import { AccountProtectionController } from '../../api/routes/account-protection.controller';
import { AccountProtectionService } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-protection.service';
import { AccountBrowserProfileManager } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-browser-profile.manager';
import { PrismaService } from '../../../../../libraries/nestjs-libraries/src/database/prisma/prisma.service';

const enabled = process.env.ACCOUNT_PROTECTION_DB_E2E === '1';
const describeDb = enabled ? describe : describe.skip;

async function expectErrorCode(promise: Promise<unknown>, code: string) {
  let caught: any;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const response = typeof caught?.getResponse === 'function' ? caught.getResponse() : caught?.response;
  expect(response?.code).toBe(code);
}


@Module({
  controllers: [AccountProtectionController],
  providers: [
    PrismaService,
    AccountProtectionService,
    {
      provide: AuthMiddleware,
      inject: [PrismaService],
      useFactory: (database: PrismaService) =>
        new AuthMiddleware(
          {
            getOrgsByUserId: (userId: string) =>
              database.organization.findMany({
                where: { users: { some: { userId, disabled: false } } },
                include: { users: { where: { userId } } },
              }),
          } as any,
          {
            getUserById: (id: string) => database.user.findUnique({ where: { id } }),
          } as any,
        ),
    },
  ],
})
class AccountProtectionAuthenticatedE2eModule {}

describeDb('Account Protection database and browser E2E', () => {
  let prisma: PrismaService;
  let protection: AccountProtectionService;
  let controller: AccountProtectionController;
  let organizationId: string;
  let accountA: string;
  let accountB: string;
  let server: Server | undefined;
  let profileRoot: string;
  let originalProfileRoot: string | undefined;

  beforeAll(async () => {
    const databaseUrl = new URL(process.env.DATABASE_URL || '');
    expect(databaseUrl.protocol).toBe('postgresql:');
    expect(databaseUrl.pathname).toBe('/sns_studio_account_protection_e2e');
    expect(['localhost', '127.0.0.1', 'account-protection-db', 'postgres']).toContain(databaseUrl.hostname);
    expect(['sns_account_e2e', 'postgres']).toContain(decodeURIComponent(databaseUrl.username));
    originalProfileRoot = process.env.BROWSER_PROFILE_ROOT;
    process.env.OTEL_ENABLED = 'false';
    prisma = new PrismaService();
    await prisma.$connect();
    protection = new AccountProtectionService(prisma);
    controller = new AccountProtectionController(prisma, protection);
    organizationId = randomUUID();
    accountA = 'fixture-account-a-' + randomUUID();
    accountB = 'fixture-account-b-' + randomUUID();

    await prisma.organization.create({ data: { id: organizationId, name: 'Account Protection E2E', apiKey: randomUUID() } });
    await prisma.integration.createMany({
      data: [
        { internalId: accountA, organizationId, name: 'Fixture A', providerIdentifier: 'instagram', type: 'profile', token: '' },
        { internalId: accountB, organizationId, name: 'Fixture B', providerIdentifier: 'tiktok', type: 'profile', token: '' },
      ],
    });
    await protection.ensureProfile(organizationId, accountB, 'POSTIZ_INTEGRATION', 'tiktok');

    profileRoot = resolve(process.cwd(), '.sns-studio-data', 'browser-profiles-e2e-' + process.pid);
    process.env.BROWSER_PROFILE_ROOT = profileRoot;
    await mkdir(profileRoot, { recursive: true });
  }, 120000);

  afterAll(async () => {
    if (server) {
      await new Promise<void>((resolveClose) => server!.close(() => resolveClose()));
    }
    if (prisma) {
      await prisma.integration.deleteMany({ where: { organizationId } });
      await prisma.accountSecurityProfile.deleteMany({ where: { organizationId } });
      await prisma.organization.deleteMany({ where: { id: organizationId } });
      await prisma.$disconnect();
    }
    if (profileRoot) await rm(profileRoot, { recursive: true, force: true });
    if (originalProfileRoot === undefined) delete process.env.BROWSER_PROFILE_ROOT;
    else process.env.BROWSER_PROFILE_ROOT = originalProfileRoot;
  }, 120000);

  it('persists pause/resume, session status, and audit state for A without changing B', async () => {
    const org = await prisma.organization.findUniqueOrThrow({ where: { id: organizationId } });
    await controller.pause(org, 'POSTIZ_INTEGRATION', accountA, { reason: 'E2E pause' });

    const profileA = await prisma.accountSecurityProfile.findUniqueOrThrow({
      where: { organizationId_accountType_accountId: { organizationId, accountType: 'POSTIZ_INTEGRATION', accountId: accountA } },
    });
    const profileB = await prisma.accountSecurityProfile.findUniqueOrThrow({
      where: { organizationId_accountType_accountId: { organizationId, accountType: 'POSTIZ_INTEGRATION', accountId: accountB } },
    });
    expect(profileA.automationPaused).toBe(true);
    expect(profileA.securityState).toBe('PAUSED');
    expect(profileB.automationPaused).toBe(false);
    expect(profileB.securityState).toBe('HEALTHY');

    await controller.resume(org, 'POSTIZ_INTEGRATION', accountA);
    const resumedA = await prisma.accountSecurityProfile.findUniqueOrThrow({ where: { id: profileA.id } });
    expect(resumedA.automationPaused).toBe(false);
    expect(resumedA.securityState).toBe('HEALTHY');
    expect(resumedA.pauseReason).toBeNull();

    const session = await controller.sessionCheck(org, 'POSTIZ_INTEGRATION', accountA);
    expect(session.status).toBe('UNKNOWN');
    const persistedSession = await prisma.accountSessionHealth.findUniqueOrThrow({ where: { securityProfileId: profileA.id } });
    expect(persistedSession.status).toBe('UNKNOWN');

    const audit = await prisma.accountSecurityAuditLog.findMany({ where: { securityProfileId: profileA.id } });
    expect(audit.map((item) => item.event)).toEqual(expect.arrayContaining(['MANUAL_PAUSE', 'MANUAL_RESUME', 'SESSION_CHECK_REQUESTED']));
  });

  it('acquires isolated execution leases, heartbeats, releases, enforces rate limits, and recovers expired leases', async () => {
    const inputA = { organizationId, accountId: 'lease-a-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'instagram', action: 'PUBLISH' as const };
    const inputB = { organizationId, accountId: 'lease-b-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'tiktok', action: 'PUBLISH' as const };
    const profileA = await protection.ensureProfile(organizationId, inputA.accountId, inputA.accountType, inputA.provider);
    const profileB = await protection.ensureProfile(organizationId, inputB.accountId, inputB.accountType, inputB.provider);

    let enterOperation!: () => void;
    let releaseOperation!: () => void;
    const entered = new Promise<void>((resolveEntered) => { enterOperation = resolveEntered; });
    const hold = new Promise<void>((resolveRelease) => { releaseOperation = resolveRelease; });
    const pendingA = protection.run(inputA, async () => {
      enterOperation();
      await hold;
      return 'A';
    });
    await entered;

    const leaseBefore = await prisma.accountExecutionLease.findUniqueOrThrow({ where: { securityProfileId: profileA.id } });
    expect(leaseBefore.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await expectErrorCode(protection.run(inputA, async () => 'unexpected'), 'ACCOUNT_ACTION_ALREADY_RUNNING');
    await expect(protection.run(inputB, async () => 'B')).resolves.toBe('B');
    const accountBAudit = await prisma.accountSecurityAuditLog.findMany({ where: { securityProfileId: profileB.id } });
    expect(accountBAudit.some((item) => item.event === 'ACTION_SUCCEEDED')).toBe(true);

    await new Promise<void>((resolveWait) => setTimeout(resolveWait, 31000));
    const leaseAfter = await prisma.accountExecutionLease.findUniqueOrThrow({ where: { securityProfileId: profileA.id } });
    expect(leaseAfter.heartbeatAt.getTime()).toBeGreaterThan(leaseBefore.heartbeatAt.getTime());
    expect(leaseAfter.expiresAt.getTime()).toBeGreaterThan(leaseBefore.expiresAt.getTime());

    releaseOperation();
    await expect(pendingA).resolves.toBe('A');
    expect(await prisma.accountExecutionLease.findUnique({ where: { securityProfileId: profileA.id } })).toBeNull();

    await expectErrorCode(protection.run(inputB, async () => 'unexpected'), 'ACCOUNT_ACTION_BUDGET_EXCEEDED');
    const leaseProfile = await prisma.accountSecurityProfile.findUniqueOrThrow({ where: { id: profileA.id } });
    await prisma.accountExecutionLease.create({
      data: { securityProfileId: profileA.id, ownerToken: randomUUID(), actionType: inputA.action, expiresAt: new Date(Date.now() - 1000) },
    });
    await prisma.accountActionBudget.updateMany({
      where: { securityProfileId: profileA.id, provider: inputA.provider, actionType: inputA.action },
      data: { resetAt: new Date(Date.now() - 1000), usedActions: 0 },
    });
    await expect(protection.run(inputA, async () => 'recovered')).resolves.toBe('recovered');
    expect(await prisma.accountExecutionLease.findUnique({ where: { securityProfileId: leaseProfile.id } })).toBeNull();
  }, 120000);

  it('maps authentication challenges, cooldown, transient failures, and circuit transitions to persisted safety state', async () => {
    const challenges = [
      ['invalid-credential', 'invalid credentials'],
      ['session-invalid', 'session invalid'],
      ['challenge', 'challenge required'],
      ['checkpoint', 'checkpoint required'],
      ['two-factor', 'two-factor authentication required'],
    ] as const;

    for (const [label, message] of challenges) {
      const input = { organizationId, accountId: label + '-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'instagram', action: 'PUBLISH' as const };
      const profile = await protection.ensureProfile(organizationId, input.accountId, input.accountType, input.provider);
      const operation = jest.fn(async () => { throw Object.assign(new Error(message), { status: 401 }); });
      await expect(protection.run(input, operation)).rejects.toMatchObject({ message });
      expect(operation).toHaveBeenCalledTimes(1);
      const updated = await prisma.accountSecurityProfile.findUniqueOrThrow({ where: { id: profile.id } });
      expect(updated.securityState).toBe('REAUTH_REQUIRED');
      expect(updated.automationPaused).toBe(true);
      expect(updated.pauseReason).toBe('Provider requires user authentication');
      const logs = await prisma.accountSecurityAuditLog.findMany({ where: { securityProfileId: profile.id } });
      expect(logs.some((item) => item.event === 'AUTHENTICATION_REQUIRED')).toBe(true);
      expect(JSON.stringify(logs)).not.toContain(message);
    }

    const rateInput = { organizationId, accountId: 'rate-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'threads', action: 'PUBLISH' as const };
    const rateProfile = await protection.ensureProfile(organizationId, rateInput.accountId, rateInput.accountType, rateInput.provider);
    const throttled = Object.assign(new Error('private-provider-response-should-not-be-persisted'), { status: 429, retryAfter: '45' });
    await expect(protection.run(rateInput, async () => { throw throttled; })).rejects.toBe(throttled);
    const cooldown = await prisma.accountSecurityProfile.findUniqueOrThrow({ where: { id: rateProfile.id } });
    expect(cooldown.securityState).toBe('COOLDOWN');
    expect(cooldown.cooldownUntil!.getTime()).toBeGreaterThan(Date.now() + 40000);
    const retryOperation = jest.fn(async () => 'should not run');
    await expectErrorCode(protection.run(rateInput, retryOperation), 'ACCOUNT_COOLDOWN');
    expect(retryOperation).not.toHaveBeenCalled();

    const transientInput = { organizationId, accountId: 'transient-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'youtube', action: 'PUBLISH' as const };
    const transientProfile = await protection.ensureProfile(organizationId, transientInput.accountId, transientInput.accountType, transientInput.provider);
    const transientOperation = jest.fn(async () => { throw Object.assign(new Error('temporary provider failure'), { status: 503 }); });
    await expect(protection.run(transientInput, transientOperation)).rejects.toBeInstanceOf(Error);
    expect(transientOperation).toHaveBeenCalledTimes(1);
    const transientState = await prisma.accountSecurityProfile.findUniqueOrThrow({ where: { id: transientProfile.id } });
    expect(transientState.securityState).toBe('WARNING');
    expect(transientState.consecutiveProviderFailures).toBe(1);

    const circuitInput = { organizationId, accountId: 'circuit-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'instagram', action: 'PUBLISH' as const };
    const circuitProfile = await protection.ensureProfile(organizationId, circuitInput.accountId, circuitInput.accountType, circuitInput.provider);
    await prisma.accountActionBudget.create({
      data: { securityProfileId: circuitProfile.id, provider: circuitInput.provider, actionType: circuitInput.action, maxActions: 6, windowSeconds: 300, resetAt: new Date(Date.now() + 300000) },
    });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await expect(protection.run(circuitInput, async () => { throw Object.assign(new Error('temporary failure'), { status: 503 }); })).rejects.toBeInstanceOf(Error);
    }
    const circuit = await prisma.accountCircuitState.findUniqueOrThrow({
      where: { securityProfileId_provider_actionType: { securityProfileId: circuitProfile.id, provider: circuitInput.provider, actionType: circuitInput.action } },
    });
    expect(circuit.state).toBe('OPEN');
    const blocked = jest.fn(async () => 'must not run');
    await expectErrorCode(protection.run(circuitInput, blocked), 'ACCOUNT_CIRCUIT_OPEN');
    expect(blocked).not.toHaveBeenCalled();

    const audit = await prisma.accountSecurityAuditLog.findMany({ where: { organizationId } });
    expect(JSON.stringify(audit)).not.toContain('temporary provider failure');
    expect(JSON.stringify(audit)).not.toContain('private-provider-response-should-not-be-persisted');
  }, 120000);

  it('isolates real Chromium persistent profiles, cookies, localStorage, IndexedDB, and rejects mismatched bindings before launch', async () => {
    const { chromium } = require('playwright') as typeof import('playwright');
    expect(chromium).toBeDefined();
    let requestCount = 0;
    server = createServer((_request, response) => {
      requestCount += 1;
      response.writeHead(200, { 'content-type': 'text/html' });
      response.end('<!doctype html><title>Account Protection fixture page</title><p>local test only</p>');
    });
    await new Promise<void>((resolveListen) => server!.listen(0, '127.0.0.1', resolveListen));
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('Local test server did not start');
    const origin = 'http://127.0.0.1:' + address.port;

    const inputA = { organizationId, accountId: 'browser-a-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'instagram', action: 'BROWSER' as const };
    const inputB = { organizationId, accountId: 'browser-b-' + randomUUID(), accountType: 'POSTIZ_INTEGRATION', provider: 'tiktok', action: 'BROWSER' as const };
    const profileA = await protection.ensureProfile(organizationId, inputA.accountId, inputA.accountType, inputA.provider);
    const profileB = await protection.ensureProfile(organizationId, inputB.accountId, inputB.accountType, inputB.provider);
    for (const profile of [profileA, profileB]) {
      await prisma.accountActionBudget.create({
        data: { securityProfileId: profile.id, provider: profile.provider, actionType: 'BROWSER', maxActions: 6, windowSeconds: 300, resetAt: new Date(Date.now() + 300000) },
      });
    }
    const manager = new AccountBrowserProfileManager(prisma, protection);
    const markerA = 'fixture-a';
    const markerB = 'fixture-b';

    const writeMarker = async (context: import('playwright').BrowserContext, marker: string) => {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(origin);
      await page.context().addCookies([{ name: 'account-marker', value: marker, url: origin, expires: Math.floor(Date.now() / 1000) + 3600 }]);
      await page.evaluate((value) => localStorage.setItem('account-marker', value), marker);
      await page.evaluate(async (value) => {
        const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
          const request = indexedDB.open('account-protection-e2e', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('state');
          request.onsuccess = () => resolveDb(request.result);
          request.onerror = () => rejectDb(request.error);
        });
        await new Promise<void>((resolveWrite, rejectWrite) => {
          const transaction = db.transaction('state', 'readwrite');
          transaction.objectStore('state').put(value, 'marker');
          transaction.oncomplete = () => resolveWrite();
          transaction.onerror = () => rejectWrite(transaction.error);
        });
        db.close();
      }, marker);
    };
    const readMarker = async (context: import('playwright').BrowserContext) => {
      const page = context.pages()[0] || await context.newPage();
      await page.goto(origin);
      const cookie = (await page.context().cookies(origin)).find((item) => item.name === 'account-marker')?.value || null;
      const local = await page.evaluate(() => localStorage.getItem('account-marker'));
      const indexed = await page.evaluate(async () => {
        const db = await new Promise<IDBDatabase>((resolveDb, rejectDb) => {
          const request = indexedDB.open('account-protection-e2e', 1);
          request.onupgradeneeded = () => request.result.createObjectStore('state');
          request.onsuccess = () => resolveDb(request.result);
          request.onerror = () => rejectDb(request.error);
        });
        const value = await new Promise<unknown>((resolveRead, rejectRead) => {
          const transaction = db.transaction('state', 'readonly');
          const request = transaction.objectStore('state').get('marker');
          request.onsuccess = () => resolveRead(request.result ?? null);
          request.onerror = () => rejectRead(request.error);
        });
        db.close();
        return value;
      });
      return { cookie, local, indexed };
    };

    await manager.withProfile(inputA, async (context) => writeMarker(context, markerA));
    await manager.withProfile(inputB, async (context) => expect(await readMarker(context)).toEqual({ cookie: null, local: null, indexed: null }));
    await manager.withProfile(inputA, async (context) => expect(await readMarker(context)).toEqual({ cookie: markerA, local: markerA, indexed: markerA }));

    const browserA = await prisma.accountBrowserProfile.findUniqueOrThrow({ where: { securityProfileId: profileA.id } });
    const browserB = await prisma.accountBrowserProfile.findUniqueOrThrow({ where: { securityProfileId: profileB.id } });
    expect(browserA.profilePath).not.toBe(browserB.profilePath);
    expect(browserA.status).toBe('READY');
    expect(browserB.status).toBe('READY');
    expect(requestCount).toBeGreaterThan(0);
    expect(execFileSync('git', ['check-ignore', '-q', join('.sns-studio-data', 'browser-profiles-e2e-' + process.pid, 'profile', 'Default', 'Cookies')], { stdio: 'ignore' })).toBeDefined();

    await prisma.accountBrowserProfile.update({ where: { id: browserB.id }, data: { profilePath: browserA.profilePath } });
    const mismatched = jest.fn(async () => 'should not launch');
    await expectErrorCode(manager.withProfile(inputB, mismatched), 'PROFILE_BINDING_MISMATCH');
    expect(mismatched).not.toHaveBeenCalled();
  }, 120000);

  const authUiTest = process.env.ACCOUNT_PROTECTION_AUTH_UI_E2E === '1' ? it : it.skip;

  authUiTest('authenticated Account Protection UI smoke uses the real controller and database', async () => {
    const { chromium } = require('playwright') as typeof import('playwright');
    const frontendUrl = 'http://localhost:4200';
    const userId = randomUUID();
    const previousJwtSecret = process.env.JWT_SECRET;
    let app: import('@nestjs/common').INestApplication | undefined;
    let browser: import('playwright').Browser | undefined;

    try {
    await prisma.user.create({
      data: {
        id: userId,
        email: 'account-protection-e2e-' + userId + '@example.invalid',
        name: 'Account Protection E2E User',
        providerName: 'LOCAL',
        timezone: 0,
        activated: true,
      },
    });
    await prisma.userOrganization.create({ data: { userId, organizationId, role: 'USER' } });
      process.env.JWT_SECRET = randomBytes(32).toString('hex');
      const token = signJwt({ id: userId }, process.env.JWT_SECRET, { expiresIn: '5m' });
      app = await NestFactory.create(AccountProtectionAuthenticatedE2eModule, { logger: false });
      app.use(cookieParser());
      const authMiddleware = app.get(AuthMiddleware);
      app.use((request, response, next) => authMiddleware.use(request, response, next));
      await app.listen(3000, '127.0.0.1');

      browser = await chromium.launch({ headless: true });
      const page = await browser.newPage();
      await page.context().addCookies([
        { name: 'auth', value: token, url: frontendUrl, httpOnly: true, sameSite: 'Lax' },
        { name: 'showorg', value: organizationId, url: frontendUrl, httpOnly: true, sameSite: 'Lax' },
      ]);

      const accountResponsePromise = page.waitForResponse((response) =>
        new URL(response.url()).pathname === '/account-protection' && response.request().method() === 'GET'
      );
      await page.goto(frontendUrl + '/account-protection', { waitUntil: 'domcontentloaded', timeout: 120000 });
      const accountResponse = await accountResponsePromise;
      expect(accountResponse.status()).toBe(200);
      await page.getByRole('heading', { name: 'Account Protection' }).waitFor({ state: 'visible', timeout: 120000 });

      const accountSection = page.locator('section').filter({ hasText: 'Fixture A' });
      await accountSection.getByRole('button', { name: '一時停止' }).waitFor({ state: 'visible', timeout: 30000 });
      const pauseResponsePromise = page.waitForResponse((response) =>
        response.request().method() === 'POST' && new URL(response.url()).pathname.includes('/account-protection/')
      );
      await accountSection.getByRole('button', { name: '一時停止' }).click();
      const pauseResponse = await pauseResponsePromise;
      expect(pauseResponse.ok()).toBe(true);
      await accountSection.getByText('保護状態: PAUSED').waitFor({ state: 'visible', timeout: 30000 });

      const saved = await prisma.accountSecurityProfile.findUniqueOrThrow({
        where: { organizationId_accountType_accountId: { organizationId, accountType: 'POSTIZ_INTEGRATION', accountId: accountA } },
      });
      expect(saved.automationPaused).toBe(true);
      expect(saved.securityState).toBe('PAUSED');
      const audit = await prisma.accountSecurityAuditLog.findMany({ where: { securityProfileId: saved.id } });
      expect(audit.some((item) => item.event === 'MANUAL_PAUSE')).toBe(true);
    } finally {
      if (browser) await browser.close();
      if (app) await app.close();
      await prisma.userOrganization.deleteMany({ where: { userId } });
      await prisma.user.deleteMany({ where: { id: userId } });
      if (previousJwtSecret === undefined) delete process.env.JWT_SECRET;
      else process.env.JWT_SECRET = previousJwtSecret;
    }
  }, 120000);
});

