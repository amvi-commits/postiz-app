import { AccountProtectionService, accountProtectionMetricAttributes, retryAfterMilliseconds, sanitizeAccountSecurityMetadata } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-protection.service';
import { LocalEncryptedSecretStore } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-secret-store';
import { flushAccountProtectionTelemetry, recordAccountProtectionEvent, startAccountProtectionTelemetry, stopAccountProtectionTelemetry } from '../../../../../libraries/nestjs-libraries/src/database/prisma/account-protection-telemetry';
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
  it('exports denied and authentication events to in-memory metrics and traces without account data', async () => {
    const oldEnabled = process.env.OTEL_ENABLED, oldNodeEnv = process.env.NODE_ENV, oldEndpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_ENABLED = 'true'; process.env.NODE_ENV = 'test'; delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    try {
      await startAccountProtectionTelemetry();
      recordAccountProtectionEvent('instagram', 'PUBLISH', 'safety_guard_denied');
      recordAccountProtectionEvent('instagram', 'PUBLISH', 'auth_failure');
      const result = await flushAccountProtectionTelemetry();
      expect(result.metrics.length).toBeGreaterThan(0);
      expect(result.spans.length).toBeGreaterThan(0);
      const attributes = JSON.stringify({
        metrics: result.metrics.flatMap((resource: import('@opentelemetry/sdk-metrics').ResourceMetrics) => resource.scopeMetrics.flatMap((scope: import('@opentelemetry/sdk-metrics').ScopeMetrics) => scope.metrics.flatMap((metric: import('@opentelemetry/sdk-metrics').MetricData) => metric.dataPoints.map((point: import('@opentelemetry/sdk-metrics').MetricData['dataPoints'][number]) => point.attributes)))),
        spans: result.spans.map((span: import('@opentelemetry/sdk-trace-base').ReadableSpan) => span.attributes),
      });
      expect(attributes).not.toContain('accountId');
      expect(attributes).not.toContain('token');
      expect(attributes).not.toContain('secret');
    } finally {
      await stopAccountProtectionTelemetry();
      if (oldEnabled === undefined) delete process.env.OTEL_ENABLED; else process.env.OTEL_ENABLED = oldEnabled;
      if (oldNodeEnv === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = oldNodeEnv;
      if (oldEndpoint === undefined) delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT; else process.env.OTEL_EXPORTER_OTLP_ENDPOINT = oldEndpoint;
    }
  }, 20000);
  it('parses both Retry-After seconds and HTTP-date forms', () => {
    const now = Date.parse('2026-09-29T00:00:00.000Z');
    expect(retryAfterMilliseconds('30', now)).toBe(30_000);
    expect(retryAfterMilliseconds('Tue, 29 Sep 2026 00:01:00 GMT', now)).toBe(60_000);
    expect(retryAfterMilliseconds('not-a-date', now)).toBeUndefined();
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
      await store.setSecret('account', 'updated-cookie-value');
      await expect(store.getSecret('account')).resolves.toBe('updated-cookie-value');
      const configuredKey = process.env.ACCOUNT_SECRET_ENCRYPTION_KEY!;
      process.env.ACCOUNT_SECRET_ENCRYPTION_KEY = Buffer.alloc(32, 10).toString('base64');
      await expect(store.getSecret('account')).rejects.toThrow();
      process.env.ACCOUNT_SECRET_ENCRYPTION_KEY = configuredKey;
      await store.deleteSecret('account');
      await expect(store.getSecret('account')).resolves.toBeNull();
      delete process.env.ACCOUNT_SECRET_ENCRYPTION_KEY;
      await expect(store.setSecret('account', 'x')).rejects.toThrow('ACCOUNT_SECRET_ENCRYPTION_KEY');
      await expect(store.getSecret('missing')).rejects.toThrow('ACCOUNT_SECRET_ENCRYPTION_KEY');
      await expect(store.deleteSecret('missing')).rejects.toThrow('ACCOUNT_SECRET_ENCRYPTION_KEY');
    } finally {
      if (oldKey === undefined) delete process.env.ACCOUNT_SECRET_ENCRYPTION_KEY; else process.env.ACCOUNT_SECRET_ENCRYPTION_KEY = oldKey;
      if (oldPath === undefined) delete process.env.ACCOUNT_SECRET_STORE_PATH; else process.env.ACCOUNT_SECRET_STORE_PATH = oldPath;
      await rm(dir, { recursive: true, force: true });
    }
  });
});
