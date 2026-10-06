const { PrismaClient, Provider, Role, SubscriptionTier, Period } = require('@prisma/client');
const bcrypt = require('bcrypt');

const prisma = new PrismaClient();

async function main() {
  console.log('[seed-review] Seeding Review Runtime database...');

  // 1. Organization
  const org = await prisma.organization.upsert({
    where: { id: 'c7f99999-0000-4000-a000-000000000002' },
    update: {},
    create: {
      id: 'c7f99999-0000-4000-a000-000000000002',
      name: 'SNS Studio Review Organization',
    },
  });
  console.log('[seed-review] Organization seeded:', org.id);

  // 2. Reviewer User
  const email = process.env.REVIEW_USER_EMAIL || 'reviewer@sweet-honey-works.com';
  const rawPassword = process.env.REVIEW_USER_PASSWORD;
  if (!rawPassword || rawPassword.trim().length === 0) {
    throw new Error('[seed-review] FAIL-CLOSED: REVIEW_USER_PASSWORD environment variable is required.');
  }
  const passwordHash = bcrypt.hashSync(rawPassword, 10);
  const user = await prisma.user.upsert({
    where: { id: 'c7f99999-0000-4000-a000-000000000001' },
    update: {
      email,
      password: passwordHash,
    },
    create: {
      id: 'c7f99999-0000-4000-a000-000000000001',
      email,
      password: passwordHash,
      providerName: Provider.LOCAL,
      name: 'TikTok App Reviewer',
      timezone: 0,
    },
  });
  console.log('[seed-review] User seeded (credentials masked):', user.email);

  // 3. UserOrganization
  const userOrg = await prisma.userOrganization.upsert({
    where: {
      userId_organizationId: {
        userId: user.id,
        organizationId: org.id,
      },
    },
    update: {
      role: Role.ADMIN,
      disabled: false,
    },
    create: {
      userId: user.id,
      organizationId: org.id,
      role: Role.ADMIN,
      disabled: false,
    },
  });
  console.log('[seed-review] UserOrganization seeded:', userOrg.id);

  // 4. Subscription
  const sub = await prisma.subscription.upsert({
    where: { organizationId: org.id },
    update: {},
    create: {
      organizationId: org.id,
      subscriptionTier: SubscriptionTier.STANDARD,
      period: Period.YEARLY,
      totalChannels: 10,
      isLifetime: true,
      provider: 'local',
    },
  });
  console.log('[seed-review] Subscription seeded:', sub.id);

  // 5. TikTok Personal Integration (review fixture)
  const tiktokIntegration = await prisma.integration.upsert({
    where: { id: 'c7f99999-0000-4000-a000-000000000003' },
    update: {
      disabled: false,
      refreshNeeded: false,
      token: 'mock_review_token_tiktok_personal',
    },
    create: {
      id: 'c7f99999-0000-4000-a000-000000000003',
      internalId: 'review_tiktok_personal_001',
      organizationId: org.id,
      name: 'Reviewer TikTok Personal',
      picture: 'https://sns-studio.sweet-honey-works.com/icons/platforms/tiktok.png',
      providerIdentifier: 'tiktok',
      type: 'social',
      token: 'mock_review_token_tiktok_personal',
      refreshToken: 'mock_review_refresh_token',
      tokenExpiration: new Date(Date.now() + 365 * 24 * 3600 * 1000),
      disabled: false,
      refreshNeeded: false,
      postingTimes: '[{"time":120},{"time":400},{"time":700}]',
    },
  });
  console.log('[seed-review] TikTok Personal Integration seeded:', tiktokIntegration.id);
  console.log('[seed-review] Seeding completed successfully.');
}

main()
  .catch((e) => {
    console.error('[seed-review] Error:', e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
