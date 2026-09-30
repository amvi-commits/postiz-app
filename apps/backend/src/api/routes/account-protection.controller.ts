import { Body, Controller, Get, Param, Post, BadRequestException, NotFoundException } from '@nestjs/common';
import { Organization } from '@prisma/client';
import { GetOrgFromRequest } from '@gitroom/nestjs-libraries/user/org.from.request';
import { PrismaService } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import { AccountProtectionService } from '@gitroom/nestjs-libraries/database/prisma/account-protection.service';

@Controller('/account-protection')
export class AccountProtectionController {
  constructor(private readonly prisma: PrismaService, private readonly protection: AccountProtectionService) {}

  private async resolveProfile(org: Organization, type: string, id: string) {
    let provider: string | undefined;
    if (type === 'POSTIZ_INTEGRATION') {
      const account = await this.prisma.integration.findFirst({ where: { organizationId: org.id, internalId: id, deletedAt: null }, select: { providerIdentifier: true } });
      provider = account?.providerIdentifier;
    } else if (type === 'SNS_INSTAGRAM') {
      const account = await this.prisma.snsInstagramAccount.findFirst({ where: { organizationId: org.id, id, archivedAt: null }, select: { id: true } });
      if (account) provider = 'instagram-worker';
    }
    if (!provider) throw new NotFoundException('Account not found');
    return this.protection.ensureProfile(org.id, id, type, provider);
  }

  @Get()
  async list(@GetOrgFromRequest() org: Organization) {
    const [integrations, instagram, profiles] = await Promise.all([
      this.prisma.integration.findMany({ where: { organizationId: org.id, deletedAt: null }, select: { id: true, internalId: true, name: true, providerIdentifier: true, disabled: true } }),
      this.prisma.snsInstagramAccount.findMany({ where: { organizationId: org.id, archivedAt: null }, select: { id: true, username: true, status: true } }),
      this.prisma.accountSecurityProfile.findMany({ where: { organizationId: org.id }, include: { browserProfile: true, sessionHealth: true, actionBudgets: true, circuitStates: true }, orderBy: { updatedAt: 'desc' } }),
    ]);
    const rows = [
      ...integrations.map((account) => ({ accountId: account.internalId, accountType: 'POSTIZ_INTEGRATION', label: account.name, provider: account.providerIdentifier, connected: !account.disabled })),
      ...instagram.map((account) => ({ accountId: account.id, accountType: 'SNS_INSTAGRAM', label: account.username, provider: 'instagram-worker', connected: account.status === 'CONNECTED' })),
    ];
    return rows.map((account) => {
      const profile = profiles.find((item) => item.accountId === account.accountId && item.accountType === account.accountType);
      return { ...account, protection: profile ? { id: profile.id, enabled: profile.enabled, securityState: profile.securityState, automationPaused: profile.automationPaused, pauseReason: profile.pauseReason, cooldownUntil: profile.cooldownUntil, browser: profile.browserProfile ? { status: profile.browserProfile.status, engine: profile.browserProfile.browserEngine } : null, session: profile.sessionHealth?.status || 'UNKNOWN', rateBudgets: profile.actionBudgets.map(({ actionType, maxActions, usedActions, resetAt }) => ({ actionType, maxActions, usedActions, resetAt })), circuits: profile.circuitStates.map(({ actionType, state, openedUntil }) => ({ actionType, state, openedUntil })) } : null };
    });
  }

  @Post(':accountType/:accountId/pause')
  async pause(@GetOrgFromRequest() org: Organization, @Param('accountType') type: string, @Param('accountId') id: string, @Body() body: { reason?: string }) {
    const profile = await this.resolveProfile(org, type, id);
    const updated = await this.prisma.accountSecurityProfile.update({ where: { id: profile.id }, data: { automationPaused: true, securityState: 'PAUSED', pauseReason: (body?.reason || 'Paused by user').slice(0, 200) } });
    await this.protection.audit(updated, 'MANUAL_PAUSE');
    return { ok: true };
  }

  @Post(':accountType/:accountId/resume')
  async resume(@GetOrgFromRequest() org: Organization, @Param('accountType') type: string, @Param('accountId') id: string) {
    const profile = await this.prisma.accountSecurityProfile.findFirst({ where: { organizationId: org.id, accountId: id, accountType: type } });
    if (!profile) throw new BadRequestException('Account protection profile not found');
    if (profile.securityState === 'REAUTH_REQUIRED') throw new BadRequestException('Provider authentication is required before resuming');
    await this.prisma.accountSecurityProfile.update({ where: { id: profile.id }, data: { automationPaused: false, securityState: 'HEALTHY', pauseReason: null } });
    await this.protection.audit(profile, 'MANUAL_RESUME');
    return { ok: true };
  }

  @Post(':accountType/:accountId/session-check')
  async sessionCheck(@GetOrgFromRequest() org: Organization, @Param('accountType') type: string, @Param('accountId') id: string) {
    const profile = await this.resolveProfile(org, type, id);
    const check = await this.prisma.accountSessionHealth.upsert({ where: { securityProfileId: profile.id }, create: { securityProfileId: profile.id, provider: profile.provider, status: 'UNKNOWN', checkedAt: new Date() }, update: { status: 'UNKNOWN', checkedAt: new Date() } });
    await this.protection.audit(profile, 'SESSION_CHECK_REQUESTED');
    return { status: check.status, checkedAt: check.checkedAt, note: 'This provider does not expose a safe session validation API.' };
  }

  @Get(':accountType/:accountId/audit')
  async audit(@GetOrgFromRequest() org: Organization, @Param('accountType') type: string, @Param('accountId') id: string) {
    const profile = await this.prisma.accountSecurityProfile.findFirst({ where: { organizationId: org.id, accountId: id, accountType: type }, select: { id: true } });
    if (!profile) return [];
    return this.prisma.accountSecurityAuditLog.findMany({ where: { organizationId: org.id, securityProfileId: profile.id }, select: { event: true, severity: true, message: true, metadata: true, createdAt: true }, orderBy: { createdAt: 'desc' }, take: 100 });
  }
}
