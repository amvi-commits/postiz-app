import { AccountProtectionService, accountProtectionMetricAttributes, sanitizeAccountSecurityMetadata } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-protection.service';
import { LocalEncryptedSecretStore } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-secret-store';
import { assertBrowserProfileBinding } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-browser-profile.manager';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';

describe('SNS Studio account protection safety primitives', () => {
  afterEach(() => { delete process.env.ACCOUNT_PROTECTION_ENABLED; });
  it('leaves the publisher operation unchanged when protection is disabled', async () => {
    process.env.ACCOUNT_PROTECTION_ENABLED = 'false';
    const action = jest.fn().mockResolvedValue('ok');
    await expect(new AccountProtectionService({} as any).run({ organizationId: 'org', accountId: 'account', accountType: 'POSTIZ_INTEGRATION', provider: 'instagram', action: 'PUBLISH' }, action)).resolves.toBe('ok');
    expect(action).toHaveBeenCalledTimes(1);
  });
  it('redacts sensitive audit metadata recursively', () => {
    expect(sanitizeAccountSecurityMetadata({ status: 429, token: 'secret', nested: { password: 'secret', count: 2 } })).toEqual({ status: 429, token: '[REDACTED]', nested: { password: '[REDACTED]', count: 2 } });
  });
  it('keeps account identifiers and credentials out of telemetry attributes', () => {
    expect(accountProtectionMetricAttributes('instagram', 'PUBLISH', 'succeeded')).toEqual({ provider: 'instagram', action: 'PUBLISH', outcome: 'succeeded' });
  });
  it('rejects a profile bound to another account or path', () => {
    const root = 'C:/sns-profiles';
    const expected = { accountId: 'account-b', accountType: 'POSTIZ_INTEGRATION', provider: 'threads' };
    expect(() => assertBrowserProfileBinding(expected, { ...expected, accountId: 'account-a', profileKey: 'e1c2eac8-20f0-4f76-b5c7-4f209cc45aa0', profilePath: `${root}/e1c2eac8-20f0-4f76-b5c7-4f209cc45aa0` }, root)).toThrow('PROFILE_BINDING_MISMATCH');
    expect(() => assertBrowserProfileBinding(expected, { ...expected, profileKey: 'e1c2eac8-20f0-4f76-b5c7-4f209cc45aa0', profilePath: `${root}/another-profile` }, root)).toThrow('PROFILE_BINDING_MISMATCH');
  });
  it('encrypts local secrets at rest and requires a key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'sns-protection-test-'));
    const oldKey = process.env.ACCOUNT_SECRET_ENCRYPTION_KEY, oldPath = process.env.ACCOUNT_SECRET_STORE_PATH;
    try {
      process.env.ACCOUNT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 9).toString('base64');
      process.env.ACCOUNT_SECRET_STORE_PATH = join(dir, 'secrets.json');
      const store = new LocalEncryptedSecretStore();
      await store.setSecret('account', 'cookie-value');
      expect(await readFile(process.env.ACCOUNT_SECRET_STORE_PATH, 'utf8')).not.toContain('cookie-value');
      await expect(store.getSecret('account')).resolves.toBe('cookie-value');
      delete process.env.ACCOUNT_SECRET_ENCRYPTION_KEY;
      await expect(store.setSecret('account', 'x')).rejects.toThrow('ACCOUNT_SECRET_ENCRYPTION_KEY');
    } finally {
      if (oldKey === undefined) delete process.env.ACCOUNT_SECRET_ENCRYPTION_KEY; else process.env.ACCOUNT_SECRET_ENCRYPTION_KEY = oldKey;
      if (oldPath === undefined) delete process.env.ACCOUNT_SECRET_STORE_PATH; else process.env.ACCOUNT_SECRET_STORE_PATH = oldPath;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
