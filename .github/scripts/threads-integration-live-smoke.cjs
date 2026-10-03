'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { randomUUID } = require('node:crypto');
const { PrismaClient } = require('@prisma/client');
const { sign } = require('jsonwebtoken');
const { chromium } = require('playwright');

const FRONTEND_URL = (process.env.FRONTEND_URL || 'http://127.0.0.1:4200').replace(/\/$/, '');
const BACKEND_URL = (process.env.BACKEND_INTERNAL_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
const CI_ORG_PREFIX = 'threads-ci-e2e-org-';
const CI_USER_PREFIX = 'threads-ci-e2e-user-';
const TEST_ORG_PREFIXES = [CI_ORG_PREFIX, 'org-test-threads-a-', 'org-test-threads-b-'];
const ARTIFACT_DIR = process.env.THREADS_CI_ARTIFACT_DIR || path.join(process.env.RUNNER_TEMP || process.cwd(), 'threads-ci');
const EGRESS_LOG = process.env.THREADS_CI_EGRESS_LOG;
const JWT_SECRET = process.env.JWT_SECRET;
const localHosts = new Set(['127.0.0.1', 'localhost', '::1']);

const summary = {
  result: 'NOT_RUN',
  currentHead: process.env.GITHUB_SHA || null,
  frontend: FRONTEND_URL,
  backend: BACKEND_URL,
  totalBrowserRequests: 0,
  localHttpResponses: 0,
  browser2xx: 0,
  browserExpected4xx: 0,
  browserUnexpected4xx: 0,
  backendResponses: 0,
  backend2xx: 0,
  backendExpected4xx: 0,
  backendUnexpected4xx: 0,
  unexpected404: 0,
  unexpected500: 0,
  browserExternalAttempts: [],
  calendarResponses: 0,
  calendarArrayResponse: false,
  calendarGhostVisible: false,
  calendarRegularVisible: false,
  calendarLoopFree: false,
  inboxResponse: false,
  inboxNormalizedFieldsVisible: false,
  aiReplyDraftSaved: false,
  researchSearchCalls: 0,
  researchBlockedStatus: 'NOT_VERIFIED',
  settingsApiRoundTrip: false,
  settingsDirectDbVerified: false,
  referenceApiRoundTrip: false,
  referenceDirectDbVerified: false,
  commonPublishingInvariant: false,
  consoleErrors: [],
  pageErrors: [],
  fixtureCleanup: 'NOT_RUN',
};

let prisma;
let browser;
let page;
let fixture;
let networkRecords = [];

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function safeText(value) {
  const text = String(value == null ? '' : value);
  return text
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g, '[redacted-jwt]')
    .replace(/([?&](?:access_token|token|secret|password|auth|jwt)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/\bci_mock_token\b/g, '[dummy-provider-token]');
}

function localUrl(url) {
  try {
    return localHosts.has(new URL(url).hostname.replace(/^\[|\]$/g, ''));
  } catch {
    return false;
  }
}

function pathname(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return '/';
  }
}

function backendPath(url) {
  try {
    const parsed = new URL(url);
    if (parsed.port !== '3000') return null;
    return parsed.pathname;
  } catch {
    return null;
  }
}

function prismaClient() {
  const url = process.env.DATABASE_URL;
  assert(url, 'DATABASE_URL is required for disposable CI PostgreSQL.');
  const parsed = new URL(url);
  assert(parsed.protocol === 'postgresql:', 'Refusing a non-PostgreSQL database target.');
  assert(parsed.hostname === '127.0.0.1' || parsed.hostname === 'localhost', 'Refusing a non-local database target.');
  assert(parsed.pathname === '/threads_integration_ci', 'Refusing a non-disposable database name.');
  assert(decodeURIComponent(parsed.username) === 'postgres', 'Refusing an unexpected database user.');
  return new PrismaClient({ datasourceUrl: url });
}

function prefixedOrganizationFilter() {
  return {
    OR: TEST_ORG_PREFIXES.map((prefix) => ({ id: { startsWith: prefix } })),
  };
}

async function deleteCommonContentForOrganizations(database, organizationIds) {
  const content = await database.snsContent.findMany({
    where: { organizationId: { in: organizationIds } },
    select: { id: true },
  });
  const contentIds = content.map((item) => item.id);
  if (!contentIds.length) return [];
  await database.snsDelivery.deleteMany({ where: { contentId: { in: contentIds } } });
  await database.snsContentPlatformOverride.deleteMany({ where: { contentId: { in: contentIds } } });
  await database.snsContentVariant.deleteMany({ where: { contentId: { in: contentIds } } });
  await database.snsContent.deleteMany({ where: { id: { in: contentIds } } });
  return contentIds;
}

async function cleanupFixtureData(database) {
  const orgs = await database.organization.findMany({
    where: prefixedOrganizationFilter(),
    select: { id: true },
  });
  const organizationIds = orgs.map((item) => item.id);
  let commonContentIds = [];

  if (organizationIds.length) {
    commonContentIds = await deleteCommonContentForOrganizations(database, organizationIds);

    await database.snsThreadsPostMetadata.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await database.snsThreadsInboxItem.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await database.snsThreadsReferencePost.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await database.snsThreadsAccountSetting.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await database.snsThreadsAutomationRule.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await database.post.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await database.integration.deleteMany({ where: { organizationId: { in: organizationIds } } });
    await database.userOrganization.deleteMany({ where: { organizationId: { in: organizationIds } } });
  }

  await database.user.deleteMany({
    where: {
      OR: [
        { email: { startsWith: CI_USER_PREFIX } },
        { email: { startsWith: 'org-test-threads-' } },
      ],
    },
  });
  await database.organization.deleteMany({ where: prefixedOrganizationFilter() });

  const remaining = {
    organizations: await database.organization.count({ where: prefixedOrganizationFilter() }),
    users: await database.user.count({
      where: { OR: [{ email: { startsWith: CI_USER_PREFIX } }, { email: { startsWith: 'org-test-threads-' } }] },
    }),
    userOrganizations: await database.userOrganization.count({
      where: { OR: TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })) },
    }),
    integrations: await database.integration.count({
      where: {
        OR: [
          { id: { startsWith: 'threads-ci-e2e-integration-' } },
          { internalId: { startsWith: 'threads-ci-e2e-account-' } },
          ...TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })),
        ],
      },
    }),
    posts: await database.post.count({
      where: {
        OR: [
          { id: { startsWith: 'threads-ci-e2e-post-' } },
          ...TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })),
        ],
      },
    }),
    threadsMetadata: await database.snsThreadsPostMetadata.count({
      where: { OR: TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })) },
    }),
    threadsInbox: await database.snsThreadsInboxItem.count({
      where: { OR: TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })) },
    }),
    threadsReferences: await database.snsThreadsReferencePost.count({
      where: { OR: TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })) },
    }),
    threadsSettings: await database.snsThreadsAccountSetting.count({
      where: { OR: TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })) },
    }),
    threadsRules: await database.snsThreadsAutomationRule.count({
      where: { OR: TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })) },
    }),
    commonContent: await database.snsContent.count({
      where: { OR: TEST_ORG_PREFIXES.map((prefix) => ({ organizationId: { startsWith: prefix } })) },
    }),
    commonDeliveries: commonContentIds.length
      ? await database.snsDelivery.count({ where: { contentId: { in: commonContentIds } } })
      : 0,
    commonVariants: commonContentIds.length
      ? await database.snsContentVariant.count({ where: { contentId: { in: commonContentIds } } })
      : 0,
    commonOverrides: commonContentIds.length
      ? await database.snsContentPlatformOverride.count({ where: { contentId: { in: commonContentIds } } })
      : 0,
  };

  assert(Object.values(remaining).every((count) => count === 0), 'Disposable CI fixtures remain after cleanup: ' + JSON.stringify(remaining));
  return remaining;
}

async function seedFixtures(database) {
  const id = randomUUID();
  const organizationId = CI_ORG_PREFIX + id;
  const userId = CI_USER_PREFIX + id;
  const integrationId = 'threads-ci-e2e-integration-' + id;
  const internalId = 'threads-ci-e2e-account-' + id;
  const accountName = 'threads-ci-e2e-account-' + id.slice(0, 8);
  const ghostPostId = 'threads-ci-e2e-post-ghost-' + id;
  const regularPostId = 'threads-ci-e2e-post-regular-' + id;
  const now = new Date();
  const ghostExpiresAt = new Date(now.getTime() + 23 * 60 * 60 * 1000);
  const publishDate = new Date(now.getTime() + 60 * 60 * 1000);

  await database.organization.create({
    data: { id: organizationId, name: 'Threads CI E2E ' + id.slice(0, 8), apiKey: randomUUID() },
  });
  await database.user.create({
    data: {
      id: userId,
      email: userId + '@example.invalid',
      name: 'Threads CI E2E User',
      providerName: 'LOCAL',
      timezone: 0,
      activated: true,
    },
  });
  await database.userOrganization.create({
    data: { userId, organizationId, role: 'USER' },
  });
  await database.integration.create({
    data: {
      id: integrationId,
      internalId,
      organizationId,
      name: accountName,
      profile: accountName,
      providerIdentifier: 'threads',
      type: 'social',
      token: 'ci_mock_token',
      disabled: false,
    },
  });
  await database.snsThreadsAccountSetting.create({
    data: {
      organizationId,
      integrationId,
      displayName: accountName,
      autoPostEnabled: false,
      defaultReplyControl: 'everyone',
      aiReplyEnabled: true,
      autoReplyEnabled: false,
      maxPostsPerDay: 10,
      maxRepliesPerDay: 50,
      aiCharacter: 'Threads CI E2E assistant',
      tone: 'polite',
      ngWords: ['spam'],
    },
  });
  await database.post.create({
    data: {
      id: ghostPostId,
      organizationId,
      integrationId,
      content: 'threads-ci-e2e-ghost-post',
      group: 'threads-ci-e2e-ghost-' + id,
      publishDate,
    },
  });
  await database.snsThreadsPostMetadata.create({
    data: {
      id: 'threads-ci-e2e-metadata-ghost-' + id,
      organizationId,
      postId: ghostPostId,
      isGhostPost: true,
      ghostExpiresAt,
      topicTag: 'threads-ci-e2e-topic',
      characterCount: 28,
    },
  });
  await database.post.create({
    data: {
      id: regularPostId,
      organizationId,
      integrationId,
      content: 'threads-ci-e2e-regular-post',
      group: 'threads-ci-e2e-regular-' + id,
      publishDate: new Date(now.getTime() + 2 * 60 * 60 * 1000),
    },
  });
  await database.snsThreadsPostMetadata.create({
    data: {
      id: 'threads-ci-e2e-metadata-regular-' + id,
      organizationId,
      postId: regularPostId,
      isGhostPost: false,
      topicTag: 'threads-ci-e2e-regular-topic',
      characterCount: 30,
    },
  });
  await database.snsThreadsInboxItem.create({
    data: {
      id: 'threads-ci-e2e-inbox-' + id,
      organizationId,
      integrationId,
      threadsMediaId: 'threads-ci-e2e-media-' + id,
      threadsReplyId: 'threads-ci-e2e-reply-' + id,
      senderId: 'threads-ci-e2e-sender-id-' + id,
      senderUsername: 'threads_ci_e2e_sender',
      text: 'threads-ci-e2e-inbox-text: How did you prepare this?',
      postSnippet: 'threads-ci-e2e-parent-snippet: A sample parent post.',
      itemType: 'REPLY',
      status: 'PENDING_APPROVAL',
      approvalStatus: 'PENDING',
      isPendingApproval: true,
      isHidden: false,
      repliedAt: now,
      metadata: { ciFixture: true },
    },
  });

  return { id, organizationId, userId, integrationId, internalId, accountName, ghostPostId, regularPostId };
}

function responseMatches(response, pathName, method) {
  return backendPath(response.url()) === pathName && response.request().method() === method;
}

function observeResponse(responsePromise) {
  return responsePromise.then((response) => ({ response }), (error) => ({ error }));
}

function responseFromObservation(result, context) {
  assert(!result.error, context + ': ' + (result.error?.message || 'response was not observed'));
  return result.response;
}

async function browserApi(pageInstance, args) {
  return pageInstance.evaluate(async (request) => {
    const response = await fetch(request.backendUrl + request.path, {
      method: request.method || 'GET',
      credentials: 'include',
      headers: {
        auth: request.token,
        showorg: request.organizationId,
        ...(request.body ? { 'content-type': 'application/json' } : {}),
      },
      ...(request.body ? { body: JSON.stringify(request.body) } : {}),
    });
    const body = await response.json().catch(() => ({}));
    return { status: response.status, body };
  }, args);
}

function addBrowserMonitors(pageInstance) {
  pageInstance.on('console', (message) => {
    if (message.type() === 'error') summary.consoleErrors.push(safeText(message.text()));
  });
  pageInstance.on('pageerror', (error) => summary.pageErrors.push(safeText(error.message)));
  pageInstance.on('request', () => { summary.totalBrowserRequests += 1; });
  pageInstance.on('response', (response) => {
    if (!localUrl(response.url())) return;
    const parsedUrl = new URL(response.url());
    const status = response.status();
    summary.localHttpResponses += 1;
    networkRecords.push({
      method: response.request().method(),
      host: parsedUrl.hostname,
      port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? '443' : '80'),
      path: parsedUrl.pathname,
      status,
    });
    if (status >= 200 && status < 300) summary.browser2xx += 1;
    if (status >= 400 && status < 500) summary.browserUnexpected4xx += 1;
    if (status === 404) summary.unexpected404 += 1;
    if (status >= 500) summary.unexpected500 += 1;

    const apiPath = backendPath(response.url());
    if (!apiPath) return;
    summary.backendResponses += 1;
    if (status >= 200 && status < 300) summary.backend2xx += 1;
    else if (status >= 400 && status < 500) {
      const quotaExpected = apiPath.startsWith('/threads-studio/accounts/') && apiPath.endsWith('/quota');
      if (quotaExpected) {
        summary.backendExpected4xx += 1;
        summary.browserExpected4xx += 1;
        summary.browserUnexpected4xx -= 1;
      }
      else summary.backendUnexpected4xx += 1;
    }
    if (apiPath === '/threads-studio/research') summary.researchSearchCalls += 1;
  });
  pageInstance.route('**/*', async (route) => {
    const url = route.request().url();
    if (localUrl(url)) {
      await route.continue();
      return;
    }
    try {
      const parsed = new URL(url);
      summary.browserExternalAttempts.push({ host: parsed.hostname, path: parsed.pathname });
    } catch {
      summary.browserExternalAttempts.push({ host: 'unparseable', path: '/' });
    }
    await route.abort('blockedbyclient');
  });
}

async function runBrowserSmoke(database, testFixture) {
  assert(JWT_SECRET, 'JWT_SECRET test value is missing.');
  browser = await chromium.launch({
    headless: true,
    args: ['--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1'],
  });
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const token = sign({ id: testFixture.userId }, JWT_SECRET, { expiresIn: '5m' });
  await context.addCookies([
    { name: 'auth', value: token, url: FRONTEND_URL, httpOnly: false, sameSite: 'Lax' },
    { name: 'showorg', value: testFixture.organizationId, url: FRONTEND_URL, httpOnly: false, sameSite: 'Lax' },
  ]);
  page = await context.newPage();
  addBrowserMonitors(page);

  await page.goto(FRONTEND_URL + '/sns-studio', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.getByRole('button', { name: 'Threads', exact: true }).waitFor({ state: 'visible', timeout: 60000 });
  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('heading', { name: 'Threads Studio' }).waitFor({ state: 'visible', timeout: 30000 });

  const calendarPath = '/threads-studio/calendar';
  const calendarBefore = networkRecords.filter((item) => item.path === calendarPath).length;
  const firstCalendarResponse = observeResponse(page.waitForResponse((response) => backendPath(response.url()) === calendarPath && response.request().method() === 'GET', { timeout: 30000 }));
  await page.getByRole('button', { name: 'カレンダー (Ghost消滅)', exact: true }).click();
  const firstCalendar = responseFromObservation(await firstCalendarResponse, 'Initial calendar response was not observed');
  assert(firstCalendar.ok(), 'Live Threads calendar endpoint returned ' + firstCalendar.status());
  const calendarBody = await firstCalendar.json();
  assert(Array.isArray(calendarBody), 'Live calendar response did not use the expected array contract.');
  summary.calendarArrayResponse = true;
  summary.calendarResponses = networkRecords.filter((item) => item.path === calendarPath).length - calendarBefore;
  await page.getByText('👻 GHOST POST', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByText('REGULAR', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByText('#threads-ci-e2e-topic', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  summary.calendarGhostVisible = true;
  summary.calendarRegularVisible = true;
  await page.waitForTimeout(5000);
  const calendarStableCount = networkRecords.filter((item) => item.path === calendarPath).length - calendarBefore;
  assert(calendarStableCount === 1, 'Calendar revalidation loop detected; initial fetch count was ' + calendarStableCount + '.');
  const refreshCalendarResult = observeResponse(page.waitForResponse((response) => backendPath(response.url()) === calendarPath && response.request().method() === 'GET', { timeout: 30000 }));
  const calendarPanel = page.getByRole('heading', { name: /Threads投稿カレンダー/ }).locator('xpath=../../..');
  await calendarPanel.getByRole('button', { name: '更新', exact: true }).click();
  const refreshedCalendar = responseFromObservation(await refreshCalendarResult, 'Calendar refresh response was not observed');
  assert(refreshedCalendar.ok(), 'Manual calendar refresh failed with ' + refreshedCalendar.status());
  summary.calendarResponses = networkRecords.filter((item) => item.path === calendarPath).length - calendarBefore;
  await page.waitForTimeout(2500);
  assert(networkRecords.filter((item) => item.path === calendarPath).length - calendarBefore === 2, 'Calendar made unexpected background requests after manual refresh.');
  summary.calendarLoopFree = true;

  const inboxPath = '/threads-studio/inbox';
  const inboxResponsePromise = observeResponse(page.waitForResponse((response) => backendPath(response.url()) === inboxPath && response.request().method() === 'GET', { timeout: 30000 }));
  await page.getByRole('button', { name: 'Inbox & 返信', exact: true }).click();
  const inboxResponse = responseFromObservation(await inboxResponsePromise, 'Live Threads inbox response was not observed');
  assert(inboxResponse.ok(), 'Live Threads inbox endpoint returned ' + inboxResponse.status());
  const inboxBody = await inboxResponse.json();
  assert(inboxBody && Array.isArray(inboxBody.items), 'Live inbox response did not contain items.');
  const inboxFixture = inboxBody.items.find((item) => item.senderUsername === 'threads_ci_e2e_sender');
  assert(inboxFixture, 'Seeded Threads inbox item was not returned by the live backend.');
  assert(inboxFixture.text.includes('threads-ci-e2e-inbox-text'), 'Inbox text field is missing.');
  assert(inboxFixture.postSnippet.includes('threads-ci-e2e-parent-snippet'), 'Inbox parent snippet is missing.');
  assert(inboxFixture.status === 'PENDING_APPROVAL', 'Inbox approval status is incorrect.');
  await page.getByText('@threads_ci_e2e_sender', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByText('threads-ci-e2e-inbox-text: How did you prepare this?', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByText(/承認待ち/).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByText(/親投稿: threads-ci-e2e-parent-snippet/).waitFor({ state: 'visible', timeout: 30000 });
  summary.inboxResponse = true;
  summary.inboxNormalizedFieldsVisible = true;

  await page.getByRole('button', { name: /💬 返信/ }).first().click();
  await page.getByRole('heading', { name: /AI返信アシスタント/ }).waitFor({ state: 'visible', timeout: 30000 });
  const aiDraftResponsePromise = observeResponse(page.waitForResponse((response) => responseMatches(response, '/threads-studio/inbox/ai-reply-draft', 'POST'), { timeout: 30000 }));
  await page.getByRole('button', { name: 'AI返信下書きを生成', exact: true }).click();
  const aiDraftResponse = responseFromObservation(await aiDraftResponsePromise, 'AI Reply draft response was not observed');
  assert(aiDraftResponse.ok(), 'AI Reply draft endpoint failed with ' + aiDraftResponse.status());
  const savedDraft = await database.snsThreadsInboxItem.findUnique({
    where: { id: inboxFixture.id },
    select: { aiDraftText: true },
  });
  assert(savedDraft && savedDraft.aiDraftText, 'AI Reply draft did not persist through the live backend.');
  summary.aiReplyDraftSaved = true;

  await page.getByRole('button', { name: 'リサーチ (Search)', exact: true }).click();
  await page.getByRole('button', { name: 'Threads検索を実行', exact: true }).waitFor({ state: 'visible', timeout: 30000 });
  const researchStatusText = await page.locator('body').innerText();
  summary.researchBlockedStatus = /(?:BLOCKED|Meta.{0,12}(?:未接続|認証)|認証が必要|権限が必要)/i.test(researchStatusText)
    ? 'PRESENT'
    : 'NOT_PRESENT';
  assert(summary.researchSearchCalls === 0, 'Research unexpectedly called a provider-backed Meta search endpoint.');

  const referencePostId = 'threads-ci-e2e-reference-' + testFixture.id;
  const referenceResponse = await browserApi(page, {
    backendUrl: BACKEND_URL,
    path: '/threads-studio/reference-posts',
    method: 'POST',
    token,
    organizationId: testFixture.organizationId,
    body: {
      threadsPostId: referencePostId,
      authorUsername: 'threads_ci_e2e_reference_author',
      content: 'threads-ci-e2e-reference-content',
      topicTag: 'threads-ci-e2e-reference-topic',
      category: 'threads-ci-e2e-validation',
      notes: 'Live backend persistence fixture.',
      likesCount: 7,
      repliesCount: 2,
    },
  });
  assert(referenceResponse.status >= 200 && referenceResponse.status < 300, 'Live reference-post create API returned ' + referenceResponse.status);
  const persistedReference = await database.snsThreadsReferencePost.findFirst({
    where: { organizationId: testFixture.organizationId, threadsPostId: referencePostId },
  });
  assert(persistedReference && persistedReference.content === 'threads-ci-e2e-reference-content', 'Reference post was not persisted in PostgreSQL.');
  summary.referenceApiRoundTrip = true;
  summary.referenceDirectDbVerified = true;

  const referenceGetPromise = observeResponse(page.waitForResponse((response) => backendPath(response.url()) === '/threads-studio/reference-posts' && response.request().method() === 'GET', { timeout: 30000 }));
  await page.getByRole('button', { name: '参考投稿ストック', exact: true }).click();
  const referenceGet = responseFromObservation(await referenceGetPromise, 'Live reference-post GET response was not observed');
  assert(referenceGet.ok(), 'Live reference-post GET returned ' + referenceGet.status());
  await page.getByText('threads-ci-e2e-reference-content', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });

  const analyticsPromise = observeResponse(page.waitForResponse((response) => backendPath(response.url()) === '/threads-studio/analytics' && response.request().method() === 'GET', { timeout: 30000 }));
  await page.getByRole('button', { name: '分析', exact: true }).click();
  const analyticsResponse = responseFromObservation(await analyticsPromise, 'Live Threads analytics response was not observed');
  assert(analyticsResponse.ok(), 'Live Threads analytics endpoint returned ' + analyticsResponse.status());
  await page.getByText('Total Views', { exact: true }).waitFor({ state: 'visible', timeout: 30000 });

  const quotaPathPrefix = '/threads-studio/accounts/' + testFixture.integrationId + '/quota';
  const quotaPromise = observeResponse(page.waitForResponse((response) => backendPath(response.url()) === quotaPathPrefix && response.request().method() === 'GET', { timeout: 30000 }));
  await page.getByRole('button', { name: 'アカウント・自動化', exact: true }).click();
  const quotaResponse = responseFromObservation(await quotaPromise, 'Threads quota response was not observed');
  assert(quotaResponse.ok(), 'CI-only Threads quota stub did not return a successful response.');
  const settingsValue = 'threads-ci-e2e-ai-character-updated';
  const characterField = page.locator('label').filter({ hasText: 'AIキャラクター / 役割設定' }).locator('xpath=..').locator('input').first();
  await characterField.waitFor({ state: 'visible', timeout: 30000 });
  await characterField.fill(settingsValue);
  const settingsPutPromise = observeResponse(page.waitForResponse((response) => responseMatches(response, '/threads-studio/accounts/' + testFixture.integrationId + '/settings', 'PUT'), { timeout: 30000 }));
  await page.getByRole('button', { name: '設定を保存', exact: true }).click();
  const settingsPut = responseFromObservation(await settingsPutPromise, 'Live Threads settings response was not observed');
  assert(settingsPut.ok(), 'Live Threads settings update returned ' + settingsPut.status());

  const accountReget = await browserApi(page, {
    backendUrl: BACKEND_URL,
    path: '/threads-studio/accounts',
    method: 'GET',
    token,
    organizationId: testFixture.organizationId,
  });
  assert(accountReget.status === 200, 'Threads accounts re-GET returned ' + accountReget.status);
  const account = Array.isArray(accountReget.body) ? accountReget.body.find((item) => item.id === testFixture.integrationId) : null;
  assert(account && account.threadsSettings && account.threadsSettings.aiCharacter === settingsValue, 'Settings value did not survive a live accounts re-GET.');
  const dbSetting = await database.snsThreadsAccountSetting.findUnique({ where: { integrationId: testFixture.integrationId } });
  assert(dbSetting && dbSetting.aiCharacter === settingsValue, 'Settings value did not persist in PostgreSQL.');
  const sqlSetting = await database.$queryRaw`SELECT "aiCharacter" FROM "SnsThreadsAccountSetting" WHERE "integrationId" = ${testFixture.integrationId}`;
  assert(sqlSetting.length === 1 && sqlSetting[0].aiCharacter === settingsValue, 'Direct SQL could not verify the saved Threads setting.');
  summary.settingsApiRoundTrip = true;
  summary.settingsDirectDbVerified = true;

  await page.getByRole('button', { name: 'Threads', exact: true }).click();
  await page.getByRole('heading', { name: 'Threads Studio' }).waitFor({ state: 'visible', timeout: 30000 });
  await page.getByRole('button', { name: '投稿 (Publish)', exact: true }).click();
  await page.getByRole('button', { name: /Threadsプリセットで共通投稿を開く/ }).click();
  await page.getByRole('heading', { name: '共通投稿・配信' }).waitFor({ state: 'visible', timeout: 30000 });
  const planTitle = 'threads-ci-e2e-common-plan-' + testFixture.id.slice(0, 8);
  await page.getByLabel('管理名').fill(planTitle);
  await page.getByLabel('共通投稿文').fill('threads-ci-e2e-common-content');
  const accountCheckbox = page.locator('label').filter({ hasText: testFixture.accountName }).locator('input[type="checkbox"]').first();
  await accountCheckbox.waitFor({ state: 'visible', timeout: 30000 });
  if (!(await accountCheckbox.isChecked())) await accountCheckbox.check();
  const planResponsePromise = observeResponse(page.waitForResponse((response) => responseMatches(response, '/sns-studio/content-plans', 'POST'), { timeout: 30000 }));
  await page.getByRole('button', { name: '配信計画を保存', exact: true }).click();
  const planResponse = responseFromObservation(await planResponsePromise, 'Common Publishing save response was not observed');
  assert(planResponse.ok(), 'Common Publishing save endpoint returned ' + planResponse.status());
  const plan = await database.snsContent.findFirst({
    where: { organizationId: testFixture.organizationId, title: planTitle },
  });
  assert(plan && plan.commonContent === 'threads-ci-e2e-common-content', 'Common Publishing record was not persisted through the backend.');
  const delivery = await database.snsDelivery.findFirst({ where: { contentId: plan.id, integrationId: testFixture.integrationId } });
  assert(delivery, 'Common Publishing Threads delivery row was not created.');
  const commonColumns = await database.$queryRaw`SELECT "column_name" FROM information_schema.columns WHERE "table_schema" = 'public' AND "table_name" = 'SnsDelivery' AND "column_name" IN ('settingsOverride', 'providerSettingsSnapshot')`;
  const commonColumnNames = commonColumns.map((item) => item.column_name);
  assert(commonColumnNames.includes('settingsOverride') && commonColumnNames.includes('providerSettingsSnapshot'), 'Common Publishing settingsOverride/providerSettingsSnapshot columns are not independently present.');
  await page.getByRole('button', { name: 'この配信計画で投稿を作成', exact: true }).click();
  await page.getByText(/Ghost Post/).last().waitFor({ state: 'visible', timeout: 30000 });
  summary.commonPublishingInvariant = true;

  const egressRecords = EGRESS_LOG && fs.existsSync(EGRESS_LOG)
    ? fs.readFileSync(EGRESS_LOG, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
    : [];
  const blockedEgress = egressRecords.filter((record) => record.kind === 'blocked_node_egress');
  const providerStubs = egressRecords.filter((record) => record.kind === 'provider_stub');
  assert(blockedEgress.length === 0, 'Backend/frontend attempted blocked external HTTP: ' + JSON.stringify(blockedEgress));
  assert(providerStubs.length >= 1, 'Expected the Settings quota request to use the local-only Threads provider stub.');
  assert(summary.browserExternalAttempts.length === 0, 'Browser attempted an external network request: ' + JSON.stringify(summary.browserExternalAttempts));
  assert(summary.researchSearchCalls === 0, 'Threads research must remain unopened at the provider API layer.');
  assert(summary.unexpected404 === 0, 'Browser Smoke received an unexpected 404.');
  const unexpected500Responses = networkRecords.filter((item) => item.status >= 500).map(({ method, path, status }) => ({ method, path, status }));
  assert(summary.unexpected500 === 0, 'Browser Smoke received an unexpected 500: ' + JSON.stringify(unexpected500Responses));
  assert(summary.backendUnexpected4xx === 0, 'Browser Smoke received an unexpected 4xx.');
  assert(summary.browserUnexpected4xx === 0, 'Browser Smoke received an unexpected local HTTP 4xx.');
  assert(summary.consoleErrors.length === 0, 'Browser console.error was emitted: ' + JSON.stringify(summary.consoleErrors));
  assert(summary.pageErrors.length === 0, 'Browser pageerror was emitted.');
  assert(summary.researchBlockedStatus === 'PRESENT', 'Research did not display a blocked/auth-required status while its provider-backed action was intentionally not invoked.');
  summary.providerStubInvocations = providerStubs.length;
  summary.metaWireRequests = 0;
}

async function writeSummary(fileName = 'threads-browser-summary.json') {
  await fs.promises.mkdir(ARTIFACT_DIR, { recursive: true });
  const report = {
    ...summary,
    browserExternalAttempts: summary.browserExternalAttempts,
    consoleErrors: summary.consoleErrors.map(safeText),
    pageErrors: summary.pageErrors.map(safeText),
    networkResponses: networkRecords,
  };
  await fs.promises.writeFile(path.join(ARTIFACT_DIR, fileName), JSON.stringify(report, null, 2), { mode: 0o600 });
}

async function main() {
  prisma = prismaClient();
  await prisma.$connect();

  if (process.argv.includes('--cleanup-only')) {
    const remaining = await cleanupFixtureData(prisma);
    summary.fixtureCleanup = 'PASS';
    summary.cleanupCounts = remaining;
    await writeSummary('threads-cleanup-summary.json');
    await prisma.$disconnect();
    console.log('Threads CI fixture cleanup PASS: ' + JSON.stringify(remaining));
    return;
  }

  await cleanupFixtureData(prisma);
  fixture = await seedFixtures(prisma);

  let caught;
  try {
    await runBrowserSmoke(prisma, fixture);
    summary.result = 'PASS';
  } catch (error) {
    caught = error;
    summary.result = 'FAIL';
    summary.failure = safeText(error && error.stack ? error.stack : error);
    if (page) {
      try {
        await fs.promises.mkdir(ARTIFACT_DIR, { recursive: true });
        await page.screenshot({ path: path.join(ARTIFACT_DIR, 'threads-browser-failure.png'), fullPage: true, timeout: 15000 });
      } catch (screenshotError) {
        summary.screenshotError = safeText(screenshotError.message);
      }
    }
  }

  try {
    const remaining = await cleanupFixtureData(prisma);
    summary.fixtureCleanup = 'PASS';
    summary.cleanupCounts = remaining;
  } catch (cleanupError) {
    summary.fixtureCleanup = 'FAIL';
    summary.cleanupFailure = safeText(cleanupError && cleanupError.stack ? cleanupError.stack : cleanupError);
    caught = caught || cleanupError;
  }

  if (browser) await browser.close().catch(() => {});
  if (prisma) await prisma.$disconnect().catch(() => {});
  await writeSummary();

  console.log(JSON.stringify({
    result: summary.result,
    calendarArrayResponse: summary.calendarArrayResponse,
    calendarGhostVisible: summary.calendarGhostVisible,
    calendarRegularVisible: summary.calendarRegularVisible,
    calendarLoopFree: summary.calendarLoopFree,
    calendarResponses: summary.calendarResponses,
    inboxResponse: summary.inboxResponse,
    inboxNormalizedFieldsVisible: summary.inboxNormalizedFieldsVisible,
    aiReplyDraftSaved: summary.aiReplyDraftSaved,
    researchSearchCalls: summary.researchSearchCalls,
    researchBlockedStatus: summary.researchBlockedStatus,
    settingsApiRoundTrip: summary.settingsApiRoundTrip,
    settingsDirectDbVerified: summary.settingsDirectDbVerified,
    referenceApiRoundTrip: summary.referenceApiRoundTrip,
    referenceDirectDbVerified: summary.referenceDirectDbVerified,
    commonPublishingInvariant: summary.commonPublishingInvariant,
    totalBrowserRequests: summary.totalBrowserRequests,
    localHttpResponses: summary.localHttpResponses,
    browser2xx: summary.browser2xx,
    browserExpected4xx: summary.browserExpected4xx,
    browserUnexpected4xx: summary.browserUnexpected4xx,
    backendResponses: summary.backendResponses,
    backend2xx: summary.backend2xx,
    backendExpected4xx: summary.backendExpected4xx,
    backendUnexpected4xx: summary.backendUnexpected4xx,
    unexpected404: summary.unexpected404,
    unexpected500: summary.unexpected500,
    browserExternalAttempts: summary.browserExternalAttempts.length,
    consoleErrors: summary.consoleErrors.length,
    pageErrors: summary.pageErrors.length,
    fixtureCleanup: summary.fixtureCleanup,
  }, null, 2));

  if (caught) {
    console.error(safeText(caught && caught.stack ? caught.stack : caught));
    process.exitCode = 1;
  }
}

main().catch(async (error) => {
  summary.result = 'FAIL';
  summary.failure = safeText(error && error.stack ? error.stack : error);
  if (prisma) {
    try {
      await cleanupFixtureData(prisma);
      summary.fixtureCleanup = 'PASS';
    } catch (cleanupError) {
      summary.fixtureCleanup = 'FAIL';
      summary.cleanupFailure = safeText(cleanupError && cleanupError.stack ? cleanupError.stack : cleanupError);
    }
    await prisma.$disconnect().catch(() => {});
  }
  await writeSummary().catch(() => {});
  console.error(safeText(error && error.stack ? error.stack : error));
  process.exitCode = 1;
});
