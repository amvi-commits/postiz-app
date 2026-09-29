import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { randomUUID } from 'crypto';
import { PrismaService } from './prisma.service';

export type ProtectedAction = 'PUBLISH' | 'LOGIN' | 'SESSION_REFRESH' | 'BROWSER' | 'ACCOUNT_MUTATION';

const SENSITIVE_KEY = /(authorization|token|secret|password|cookie|session|credential|email|username|body|content)/i;

export function sanitizeAccountSecurityMetadata(value: unknown): unknown {
  if (Array.isArray(value)) return value.slice(0, 30).map(sanitizeAccountSecurityMetadata);
  if (!value || typeof value !== 'object') return typeof value === 'string' ? value.slice(0, 300) : value;
  return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => [key, SENSITIVE_KEY.test(key) ? '[REDACTED]' : sanitizeAccountSecurityMetadata(item)]));
}

@Injectable()
export class AccountProtectionService {
  constructor(private readonly prisma: PrismaService) {}

  enabled() { return process.env.ACCOUNT_PROTECTION_ENABLED !== 'false'; }

  async ensureProfile(organizationId: string, accountId: string, accountType: string, provider: string) {
    return this.prisma.accountSecurityProfile.upsert({
      where: { organizationId_accountType_accountId: { organizationId, accountType, accountId } },
      create: { organizationId, accountId, accountType, provider },
      update: { provider },
    });
  }

  async audit(profile: { id: string; organizationId: string; accountId: string; provider: string }, event: string, severity = 'INFO', metadata?: unknown) {
    await this.prisma.accountSecurityAuditLog.create({ data: {
      organizationId: profile.organizationId, securityProfileId: profile.id,
      accountId: profile.accountId, provider: profile.provider, event, severity,
      message: event.replace(/_/g, ' ').toLowerCase(),
      metadata: sanitizeAccountSecurityMetadata(metadata) as any,
    } });
  }

  async run<T>(input: { organizationId: string; accountId: string; accountType: string; provider: string; action: ProtectedAction }, operation: () => Promise<T>): Promise<T> {
    if (!this.enabled()) return operation();
    const profile = await this.ensureProfile(input.organizationId, input.accountId, input.accountType, input.provider);
    const now = new Date();
    if (!profile.enabled || profile.automationPaused || ['PAUSED', 'REAUTH_REQUIRED', 'DISABLED'].includes(profile.securityState)) {
      throw new ServiceUnavailableException({ code: 'ACCOUNT_PROTECTION_BLOCKED', state: profile.securityState, pauseReason: profile.pauseReason });
    }
    if (profile.cooldownUntil && profile.cooldownUntil > now) throw new ServiceUnavailableException({ code: 'ACCOUNT_COOLDOWN', retryAt: profile.cooldownUntil });
    const circuitKey = { securityProfileId_provider_actionType: { securityProfileId: profile.id, provider: input.provider, actionType: input.action } };
    const circuit = await this.prisma.accountCircuitState.findUnique({ where: circuitKey });
    if (circuit?.state === 'OPEN' && circuit.openedUntil && circuit.openedUntil > now) throw new ServiceUnavailableException({ code: 'ACCOUNT_CIRCUIT_OPEN', retryAt: circuit.openedUntil });

    const ownerToken = randomUUID();
    const leaseUntil = new Date(now.getTime() + 2 * 60_000);
    const lease = this.prisma.accountExecutionLease;
    const expired = await lease.updateMany({ where: { securityProfileId: profile.id, expiresAt: { lte: now } }, data: { ownerToken, actionType: input.action, acquiredAt: now, heartbeatAt: now, expiresAt: leaseUntil } });
    if (!expired.count) {
      try { await lease.create({ data: { securityProfileId: profile.id, ownerToken, actionType: input.action, expiresAt: leaseUntil } }); }
      catch { throw new ServiceUnavailableException({ code: 'ACCOUNT_ACTION_ALREADY_RUNNING' }); }
    }
    const heartbeat = setInterval(() => {
      const beat = new Date();
      void lease.updateMany({ where: { securityProfileId: profile.id, ownerToken }, data: { heartbeatAt: beat, expiresAt: new Date(beat.getTime() + 2 * 60_000) } }).catch(() => undefined);
    }, 30_000);
    try {
      const budget = await this.prisma.accountActionBudget.upsert({
        where: { securityProfileId_provider_actionType: { securityProfileId: profile.id, provider: input.provider, actionType: input.action } },
        create: { securityProfileId: profile.id, provider: input.provider, actionType: input.action, maxActions: 1, windowSeconds: 60, resetAt: new Date(now.getTime() + 60_000) },
        update: {},
      });
      if (budget.resetAt <= now) await this.prisma.accountActionBudget.updateMany({ where: { id: budget.id, resetAt: { lte: now } }, data: { usedActions: 0, resetAt: new Date(now.getTime() + budget.windowSeconds * 1000) } });
      const consumed = await this.prisma.accountActionBudget.updateMany({ where: { id: budget.id, resetAt: { gt: now }, usedActions: { lt: budget.maxActions } }, data: { usedActions: { increment: 1 } } });
      if (!consumed.count) throw new ServiceUnavailableException({ code: 'ACCOUNT_ACTION_BUDGET_EXCEEDED', retryAt: budget.resetAt });
      if (circuit?.state === 'OPEN') await this.prisma.accountCircuitState.update({ where: { id: circuit.id }, data: { state: 'HALF_OPEN' } });
      await this.audit(profile, 'ACTION_STARTED');
      try {
        const result = await operation();
        await this.prisma.accountCircuitState.upsert({ where: circuitKey, create: { securityProfileId: profile.id, provider: input.provider, actionType: input.action, state: 'CLOSED', failureCount: 0 }, update: { state: 'CLOSED', failureCount: 0, openedUntil: null } });
        await this.prisma.accountSecurityProfile.update({ where: { id: profile.id }, data: { lastHealthyAt: new Date(), lastSuccessfulActionAt: new Date(), consecutiveProviderFailures: 0, consecutiveAuthFailures: 0, securityState: 'HEALTHY' } });
        await this.audit(profile, 'ACTION_SUCCEEDED');
        return result;
      } catch (error) {
        const err = error as any;
        const status = Number(err?.status || err?.statusCode || err?.response?.status);
        const text = String(err?.message || '').toLowerCase();
        const challenge = /challenge|checkpoint|two.factor|2fa|invalid credential|unauthorized|authentication/.test(text) || status === 401;
        const retryAfter = Number(err?.retryAfter || err?.response?.headers?.['retry-after']);
        const until = status === 429 && Number.isFinite(retryAfter) ? new Date(Date.now() + Math.max(1, retryAfter) * 1000) : undefined;
        if (!challenge && !until) {
          const updated = await this.prisma.accountCircuitState.upsert({ where: circuitKey, create: { securityProfileId: profile.id, provider: input.provider, actionType: input.action, failureCount: 1 }, update: { failureCount: { increment: 1 }, lastFailureAt: new Date() } });
          if (updated.failureCount >= 5) await this.prisma.accountCircuitState.update({ where: { id: updated.id }, data: { state: 'OPEN', openedUntil: new Date(Date.now() + 5 * 60_000) } });
        }
        await this.prisma.accountSecurityProfile.update({ where: { id: profile.id }, data: challenge ? { securityState: 'REAUTH_REQUIRED', automationPaused: true, pauseReason: 'Provider requires user authentication', lastChallengeAt: new Date(), lastAuthFailureAt: new Date(), consecutiveAuthFailures: { increment: 1 } } : until ? { securityState: 'COOLDOWN', cooldownUntil: until, lastWarningAt: new Date() } : { securityState: 'WARNING', lastWarningAt: new Date(), consecutiveProviderFailures: { increment: 1 } } });
        await this.audit(profile, challenge ? 'AUTHENTICATION_REQUIRED' : until ? 'PROVIDER_RATE_LIMIT' : 'PROVIDER_ACTION_FAILED', challenge || until ? 'WARNING' : 'ERROR', { status, retryAfter });
        throw error;
      }
    } finally {
      clearInterval(heartbeat);
      await lease.deleteMany({ where: { securityProfileId: profile.id, ownerToken } });
    }
  }
}
