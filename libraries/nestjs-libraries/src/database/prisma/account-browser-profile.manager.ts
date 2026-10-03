import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { BrowserContext } from 'playwright';
import { randomUUID } from 'crypto';
import { mkdir } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { PrismaService } from './prisma.service';
import { AccountProtectionService, ProtectedAction } from './account-protection.service';

export function assertBrowserProfileBinding(expected: { accountId: string; accountType: string; provider: string }, actual: { accountId: string; accountType: string; provider: string; profileKey: string; profilePath: string }, root: string) {
  const expectedPath = resolve(root, actual.profileKey);
  if (actual.accountId !== expected.accountId || actual.accountType !== expected.accountType || actual.provider !== expected.provider || !/^[0-9a-f-]{36}$/i.test(actual.profileKey) || resolve(actual.profilePath) !== expectedPath) {
    const error = new Error('PROFILE_BINDING_MISMATCH');
    (error as any).code = 'PROFILE_BINDING_MISMATCH';
    throw error;
  }
}

@Injectable()
export class AccountBrowserProfileManager {
  constructor(private readonly prisma: PrismaService, private readonly protection: AccountProtectionService) {}

  private root() { return resolve(process.env.BROWSER_PROFILE_ROOT || join(process.env.SNS_STUDIO_DATA_DIR || '.sns-studio-data', 'browser-profiles')); }

  async withProfile<T>(input: { organizationId: string; accountId: string; accountType: string; provider: string; action?: ProtectedAction }, operation: (context: BrowserContext) => Promise<T>): Promise<T> {
    return this.protection.run({ ...input, action: input.action || 'BROWSER' }, async () => {
      const profile = await this.protection.ensureProfile(input.organizationId, input.accountId, input.accountType, input.provider);
      let browser = await this.prisma.accountBrowserProfile.findUnique({ where: { securityProfileId: profile.id }, include: { securityProfile: { select: { accountId: true, accountType: true, provider: true } } } });
      if (!browser) {
        const profileKey = randomUUID();
        const profilePath = resolve(this.root(), profileKey);
        browser = await this.prisma.accountBrowserProfile.create({ data: { securityProfileId: profile.id, profileKey, profilePath, browserEngine: 'chromium', osFamily: process.platform } , include: { securityProfile: { select: { accountId: true, accountType: true, provider: true } } } });
      }
      try {
        assertBrowserProfileBinding({ accountId: input.accountId, accountType: input.accountType, provider: input.provider }, { accountId: browser.securityProfile.accountId, accountType: browser.securityProfile.accountType, provider: browser.securityProfile.provider, profileKey: browser.profileKey, profilePath: browser.profilePath }, this.root());
      } catch {
        await this.prisma.accountSecurityProfile.update({ where: { id: profile.id }, data: { securityState: 'PAUSED', automationPaused: true, pauseReason: 'Browser profile binding verification failed' } });
        await this.protection.audit(profile, 'PROFILE_BINDING_MISMATCH', 'ERROR');
        throw new ServiceUnavailableException({ code: 'PROFILE_BINDING_MISMATCH' });
      }
      await mkdir(dirname(browser.profilePath), { recursive: true, mode: 0o700 });
      await mkdir(browser.profilePath, { recursive: true, mode: 0o700 });
      const { chromium } = require('playwright') as typeof import('playwright');
      let context: BrowserContext;
      try {
        context = await chromium.launchPersistentContext(browser.profilePath, {
          headless: true,
          locale: process.env.SNS_STUDIO_BROWSER_LOCALE || 'en-US',
          timezoneId: process.env.SNS_STUDIO_BROWSER_TIMEZONE || 'UTC',
        });
      } catch {
        await this.prisma.accountBrowserProfile.update({ where: { id: browser.id }, data: { status: 'ERROR' } });
        await this.protection.audit(profile, 'BROWSER_PROFILE_UNAVAILABLE', 'WARNING');
        throw new ServiceUnavailableException({ code: 'BROWSER_PROFILE_UNAVAILABLE' });
      }
      const browserMajorVersion = String(context.browser()?.version() || '').split('.')[0] || null;
      const locale = process.env.SNS_STUDIO_BROWSER_LOCALE || 'en-US';
      const timezone = process.env.SNS_STUDIO_BROWSER_TIMEZONE || 'UTC';
      const environmentChanged = (!!browser.browserMajorVersion && browser.browserMajorVersion !== browserMajorVersion) || (!!browser.osFamily && browser.osFamily !== process.platform) || (!!browser.locale && browser.locale !== locale) || (!!browser.timezone && browser.timezone !== timezone);
      await this.prisma.accountBrowserProfile.update({ where: { id: browser.id }, data: { status: 'READY', lastOpenedAt: new Date(), browserMajorVersion, locale, timezone, osFamily: process.platform } });
      if (environmentChanged) {
        await this.prisma.accountSecurityProfile.update({ where: { id: profile.id }, data: { securityState: 'WARNING', lastWarningAt: new Date() } });
        await this.protection.audit(profile, 'BROWSER_ENVIRONMENT_CHANGED', 'WARNING', { browserMajorVersion, osFamily: process.platform, locale, timezone });
      }
      try { return await operation(context); }
      finally {
        await context.close();
        await this.prisma.accountBrowserProfile.update({ where: { id: browser.id }, data: { lastClosedAt: new Date(), status: 'READY' } });
      }
    });
  }
}
