import { AccountProtectionService, sanitizeAccountSecurityMetadata } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-protection.service';
import { LocalEncryptedSecretStore } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-secret-store';
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
