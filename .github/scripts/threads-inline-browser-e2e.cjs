// Real production frontend + real Postiz repository + disposable PostgreSQL.
// API/account/transport fixtures are synthetic. No provider executor is loaded.
// Match the production Linux server; the browser explicitly uses Asia/Tokyo.
process.env.TZ = 'UTC';
const assert = require('node:assert/strict');
const http = require('node:http');
const { randomUUID } = require('node:crypto');
const { mkdtempSync, readFileSync, rmSync, openSync, closeSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { PrismaClient } = require('@prisma/client');
const { chromium } = require('playwright');
const { PostsRepository } = require('../../apps/backend/dist/libraries/nestjs-libraries/src/database/prisma/posts/posts.repository.js');

const target = new URL(process.env.DATABASE_URL || '');
assert(['localhost', '127.0.0.1'].includes(target.hostname));
assert.equal(target.pathname, '/sns_studio_threads_inline_e2e');
assert.equal(target.port, '5549');
assert.equal(process.env.THREADS_BROWSER_ALLOW_REAL_POST, 'false');
const origin = 'http://127.0.0.1:4290';
const prisma = new PrismaClient();
const adapter = { model: prisma };
const repository = new PostsRepository(adapter, adapter, adapter, adapter, adapter, adapter);
const fixtureRoot = mkdtempSync(join(tmpdir(), 'sns-threads-inline-'));
const orgs = [randomUUID(), randomUUID()];
const accounts = [];
let browser, server, frontend, frontendLog;
let writes = 0;
let failDraftReads = false, corruptNextReceipt = false;
const errors = [];

async function main() {
  assert.equal(await prisma.organization.count(), 0, 'Refusing a nonempty fixture DB');
  await prisma.organization.createMany({ data: orgs.map((id, index) => ({ id, name: `Inline fixture organization ${index + 1}` })) });
  for (const [index, organizationId] of [orgs[0], orgs[0], orgs[1]].entries()) {
    accounts.push(await prisma.integration.create({ data: { organizationId, name: `Inline fixture account ${index + 1}`, internalId: `threads_browser_fixture_${index + 1}`, providerIdentifier: 'threads', type: 'social', token: '', additionalSettings: '[]' } }));
  }
  const video = join(fixtureRoot, 'fixture.mp4');
  const ffmpeg = spawnSync('ffmpeg', ['-v', 'error', '-y', '-f', 'lavfi', '-i', 'testsrc2=size=320x568:rate=16', '-t', '1', '-c:v', 'libx264', '-pix_fmt', 'yuv420p', video]);
  assert.equal(ffmpeg.status, 0, 'Fixture FFmpeg failed');
  const media = await prisma.media.create({ data: { organizationId: orgs[0], name: 'Inline fixture.mp4', type: 'video', path: `${origin}/api/fixture.mp4` } });
  const cookie = (request, name) => String(request.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(name + '='))?.slice(name.length + 1);
  server = http.createServer(async (request, response) => {
    const url = new URL(request.url, origin);
    if (!url.pathname.startsWith('/api/')) {
      const upstream = http.request({ hostname: '127.0.0.1', port: 4291, path: request.url, method: request.method, headers: request.headers }, received => { response.writeHead(received.statusCode, received.headers); received.pipe(response); });
      upstream.on('error', () => { response.writeHead(502); response.end(); });
      request.pipe(upstream); return;
    }
    const org = request.headers.showorg || cookie(request, 'showorg') || orgs[0];
    const json = (data, status = 200) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    const owned = accounts.filter(a => a.organizationId === org);
    try {
      assert(orgs.includes(org));
      const chunks = []; for await (const chunk of request) chunks.push(chunk);
      const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
      const path = url.pathname.slice(4);
      if (path === '/user/self') return json({ id: 'synthetic-ui-user', email: 'inline@example.invalid', name: 'Inline fixture', orgId: org, tier: 'FREE', role: 'SUPERADMIN', totalChannels: 2, activated: true, timezone: 0, allowTrial: false });
      if (path === '/user/organizations') return json(orgs.map((id, i) => ({ id, name: `Inline fixture organization ${i + 1}`, users: [{ role: 'SUPERADMIN' }] })));
      if (path === '/user/change-org') { assert(orgs.includes(body.id)); response.setHeader('showorg', body.id); response.setHeader('set-cookie', `showorg=${body.id}; Path=/; SameSite=Lax`); return json({ id: body.id }); }
      if (path === '/integrations/list') return json({ integrations: owned.map(a => ({ ...a, identifier: 'threads' })) });
      if (path === '/threads-studio/accounts') return json(owned.map(a => ({ id: a.id, name: a.name, transport: 'browser', browserAccount: a.internalId.replace(/^threads_browser_/, ''), publishBlockedReason: 'Browser投稿ロック中です。実投稿は無効です。' })));
      if (path === '/media') return json({ results: org === orgs[0] ? [media] : [], pages: 1 });
      if (path === '/fixture.mp4') {
        const bytes = readFileSync(video), range = String(request.headers.range || '').match(/^bytes=(\d+)-(\d*)$/);
        if (range) { const start = +range[1], end = range[2] ? Math.min(+range[2], bytes.length - 1) : bytes.length - 1; response.writeHead(206, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 }); response.end(bytes.subarray(start, end + 1)); return; }
        response.writeHead(200, { 'content-type': 'video/mp4', 'accept-ranges': 'bytes', 'content-length': bytes.length }); response.end(bytes); return;
      }
      if (path === '/posts/valid') return json(body.posts.map(post => ({ id: post.integration.id, identifier: 'threads', name: 'Fixture', valid: true, errors: true, tooLong: false, emptyContent: !post.value.some(value => value.content || value.image?.length) })));
      if (path === '/posts/should-shortlink') return json({ ask: false });
      if (path === '/posts' && request.method === 'POST') {
        assert.equal(body.type, 'draft', 'Execution is forbidden in this fixture');
        assert.equal(body.posts.length, 1);
        const post = body.posts[0]; assert(owned.some(a => a.id === post.integration.id));
        for (const value of post.value) {
          if (value.id) {
            // Postiz also accepts a new client-assigned ID on the first upsert.
            // Existing IDs must still belong to this exact account and org.
            const existing = await prisma.post.findUnique({ where: { id: value.id } });
            if (existing) {
              assert.equal(existing.organizationId, org);
              assert.equal(existing.integrationId, post.integration.id);
              assert.equal(existing.state, 'DRAFT');
            }
          }
          for (const image of value.image || []) assert.equal(image.id, org === orgs[0] ? media.id : 'forbidden');
        }
        const saved = await repository.createOrUpdatePost('draft', org, body.date, post, [], 'WEB'); writes++;
        if (corruptNextReceipt) {
          corruptNextReceipt = false;
          response.writeHead(200, { 'content-type': 'application/json' }); response.end('{incomplete'); return;
        }
        return json([{ postId: saved.posts[0].id, integration: post.integration.id }]);
      }
      if (/^\/posts\/[^/]+$/.test(path) && request.method === 'GET') {
        const post = await prisma.post.findFirst({ where: { id: path.split('/').pop(), organizationId: org, deletedAt: null } });
        if (!post) return json({}, 404);
        if (failDraftReads) return json({ code: 'FIXTURE_TRACKING_UNAVAILABLE' }, 503);
        return json({ group: post.group, integration: post.integrationId, settings: JSON.parse(post.settings || '{}'), posts: [{ ...post, image: JSON.parse(post.image || '[]') }] });
      }
      if (path === '/sns-studio/dashboard') return json({ accounts: [] });
      if (path === '/sns-studio/drive/status') return json({ connected: false });
      if (path === '/sns-studio/settings') return json({});
      if (path === '/integrations') return json({ social: [], article: [] });
      if (request.method !== 'GET') return json({ code: 'FIXTURE_OPERATION_FORBIDDEN' }, 403);
      return json([]);
    } catch (error) { errors.push(error.message); return json({ code: 'FIXTURE_ASSERTION_FAILED' }, 400); }
  });
  await new Promise(done => server.listen(4290, '127.0.0.1', done));
  // spawn requires an already-open descriptor; WriteStream opens asynchronously.
  frontendLog = openSync(join(fixtureRoot, 'frontend.log'), 'w');
  frontend = spawn(process.execPath, [require.resolve('next/dist/bin/next'), 'start', '-p', '4291', '--hostname', '127.0.0.1'], { cwd: resolve('apps/frontend'), windowsHide: true, env: { ...process.env, FRONTEND_URL: origin, NEXT_PUBLIC_BACKEND_URL: origin + '/api', NOT_SECURED: '1', STORAGE_PROVIDER: 'local', NEXT_TELEMETRY_DISABLED: '1' }, stdio: ['ignore', frontendLog, frontendLog] });
  // Use the official channel for H.264 MP4 codec coverage on Linux as well.
  // https://playwright.dev/docs/browsers#media-codecs
  browser = await chromium.launch({ headless: true, channel: 'chrome' });
  const context = await browser.newContext({ timezoneId: 'Asia/Tokyo' });
  await context.route('**/*', route => ['127.0.0.1', 'localhost'].includes(new URL(route.request().url()).hostname) ? route.continue() : route.abort());
  await context.addCookies([{ name: 'auth', value: 'synthetic-fixture-only', url: origin }, { name: 'showorg', value: orgs[0], url: origin }]);
  const page = await context.newPage(); page.on('dialog', dialog => dialog.accept());
  page.setDefaultTimeout(30000);
  for (let n = 0; n < 40; n++) { try { if ((await fetch(origin + '/auth/login', { redirect: 'manual' })).status < 500) break; } catch {} await new Promise(done => setTimeout(done, 500)); }
  const openThreads = async () => { await page.getByRole('button', { name: 'Threads', exact: true }).click(); await page.getByRole('button', { name: '投稿作成', exact: true }).click(); };
  await page.goto(origin + '/sns-studio', { waitUntil: 'domcontentloaded' }); await openThreads();
  const selection = page.getByLabel('投稿先アカウント');
  await selection.selectOption(accounts[0].id);
  const editor = page.locator('[aria-label="Threads 投稿作成"] [contenteditable=true]:visible').first();
  const waitText = async expected => {
    await editor.waitFor();
    await page.waitForFunction(text => document.querySelector('[aria-label="Threads 投稿作成"] [contenteditable=true]')?.textContent?.includes(text), expected);
  };
  const waitBlank = async () => {
    await editor.waitFor();
    await page.waitForFunction(() => document.querySelector('[aria-label="Threads 投稿作成"] [contenteditable=true]')?.textContent?.trim() === '');
  };
  const checkSettings = async account => {
    const details = page.locator('[aria-label="Threads 投稿作成"] details');
    if (!(await details.evaluate(element => element.open))) await details.locator('summary').click();
    const settings = page.locator(`[aria-label="Threads 投稿作成"] #social-settings [data-id="${account}"]`);
    await settings.getByText('Browser接続では通常の本文・画像／動画を利用できます。Ghost・Pollなどの公式API専用設定は利用できません。').waitFor();
    assert.equal(await page.locator('[aria-label="Threads 投稿作成"] #social-settings [data-id]').count(), 1);
  };
  const switchOrganization = async (from, to) => {
    await page.getByText(`Inline fixture organization ${from}`, { exact: true }).hover();
    const reloaded = page.waitForEvent('domcontentloaded');
    await page.getByText(`Inline fixture organization ${to}`).click();
    await reloaded;
  };
  await editor.fill('Inline browser draft one');
  await checkSettings(accounts[0].id);
  // The responsive toolbar hides its text label at the default viewport;
  // click the visible media control containing that label, never force-click.
  await page.getByText('Insert Media', { exact: true }).locator('..').locator('..').click();
  // This existing custom modal has a visible title but no dialog role.
  const mediaDialog = page.getByText('Media Library', { exact: true }).locator('..').locator('..');
  await mediaDialog.locator('video').first().click({ position: { x: 15, y: 15 } });
  await mediaDialog.getByRole('button', { name: 'Add selected media', exact: true }).click();
  const preview = page.locator('[aria-label="Threads 投稿作成"] aside video').first();
  await preview.waitFor();
  // The production preview intentionally loops (VideoOrImage). Observe a
  // complete natural cycle rather than waiting for an ended flag it never sets.
  const previewEvidence = await preview.evaluate(element => new Promise((done, reject) => {
    let previous = 0, maximumTime = 0;
    const started = performance.now();
    const finish = (error) => {
      clearInterval(poll); clearTimeout(timeout);
      if (error) reject(error);
      else done({ loop: element.loop, duration: element.duration, maximumTime, elapsedMs: performance.now() - started, fullCycle: true });
    };
    const poll = setInterval(() => {
      if (element.error) return finish(new Error('Fixture preview decode failed'));
      const current = element.currentTime;
      maximumTime = Math.max(maximumTime, current);
      if (element.ended || (element.loop && previous > element.duration * 0.75 && current < element.duration * 0.25)) return finish();
      previous = current;
    }, 25);
    const timeout = setTimeout(() => finish(new Error('Fixture preview did not complete a natural cycle')), 15000);
    element.currentTime = 0; element.play().catch(finish);
  }));
  assert(previewEvidence.fullCycle);
  assert(previewEvidence.duration > 0);
  assert(previewEvidence.maximumTime > previewEvidence.duration * 0.75);
  assert(previewEvidence.elapsedMs >= previewEvidence.duration * 700);
  assert(await page.getByRole('note').filter({ hasText: 'Browser投稿ロック' }).isVisible());
  await page.getByRole('button', { name: '今すぐ投稿', exact: true }).click();
  const confirmation = page.getByRole('dialog', { name: '投稿内容の最終確認' });
  await confirmation.waitFor();
  assert(await confirmation.getByRole('button', { name: '内容を確認して投稿する', exact: true }).isDisabled());
  await confirmation.getByRole('button', { name: '編集に戻る', exact: true }).click();
  await page.getByLabel('予約日時（日本時間）').fill('2027-01-15T12:30');
  const firstSaveResponse = page.waitForResponse(r => new URL(r.url()).pathname === '/api/posts' && r.request().method() === 'POST');
  await page.getByRole('button', { name: '下書き保存', exact: true }).click();
  assert((await firstSaveResponse).ok(), 'Fixture draft request was rejected');
  await page.getByText('下書きを保存しました。同じ下書きを続けて編集できます。', { exact: true }).waitFor();
  const first = await prisma.post.findFirstOrThrow({ where: { organizationId: orgs[0], integrationId: accounts[0].id, deletedAt: null } });
  assert.equal(first.state, 'DRAFT'); assert.equal(first.publishDate.toISOString(), '2027-01-15T03:30:00.000Z');
  assert.equal(JSON.parse(first.image)[0].id, media.id);
  await page.locator('[aria-label="Threads 投稿作成"] #social-content svg[class*="-end-[4px]"][class*="-top-[4px]"]').click();
  await preview.waitFor({ state: 'hidden' });
  await editor.fill('Inline browser draft two');
  const savedAgain = page.waitForResponse(r => new URL(r.url()).pathname === '/api/posts' && r.request().method() === 'POST');
  await page.getByRole('button', { name: '下書き保存', exact: true }).click(); assert((await savedAgain).ok());
  await page.getByText('下書きを保存しました。同じ下書きを続けて編集できます。', { exact: true }).waitFor();
  assert.equal(await prisma.post.count({ where: { organizationId: orgs[0], integrationId: accounts[0].id, deletedAt: null } }), 1);
  const reloaded = await prisma.post.findUniqueOrThrow({ where: { id: first.id } }); assert(reloaded.content.includes('Inline browser draft two')); assert.deepEqual(JSON.parse(reloaded.image), []);
  await page.reload(); await openThreads(); await waitText('Inline browser draft two');
  await selection.selectOption(accounts[1].id); await waitBlank();
  await checkSettings(accounts[1].id);
  await editor.fill('Unsaved account B text');
  await selection.selectOption(accounts[0].id); await waitText('Inline browser draft two'); assert(!(await editor.innerText()).includes('Unsaved account B text'));
  await checkSettings(accounts[0].id);

  // A saved draft with a failed follow-up read remains locked; reload performs
  // read-only recovery and never repeats creation.
  await selection.selectOption(accounts[1].id); await waitBlank();
  await editor.fill('Tracking recovery draft'); failDraftReads = true;
  await page.getByRole('button', { name: '下書き保存', exact: true }).click();
  const pending = page.getByText(/受付済み、または結果確認が必要な投稿/);
  await pending.waitFor();
  assert(await page.getByRole('button', { name: '下書き保存', exact: true }).isDisabled());
  await page.reload(); await openThreads(); await pending.waitFor(); assert.equal(writes, 3);
  failDraftReads = false;
  await page.reload(); await openThreads(); await waitText('Tracking recovery draft'); assert.equal(writes, 3);
  assert.equal(await prisma.post.count({ where: { integrationId: accounts[1].id } }), 1);

  // A corrupt receipt represents an unknown result after persistence. Do not
  // confirm another create request, even after a complete page reload.
  await page.getByRole('button', { name: '新しい投稿を作成', exact: true }).click(); await waitBlank();
  await editor.fill('Unknown response draft'); corruptNextReceipt = true;
  await page.getByRole('button', { name: '下書き保存', exact: true }).click();
  await page.getByText(/投稿登録の結果を確認できません/).waitFor();
  assert(await page.getByRole('button', { name: '下書き保存', exact: true }).isDisabled());
  await page.reload(); await openThreads(); await pending.waitFor(); assert.equal(writes, 4);
  assert.equal(await prisma.post.count({ where: { integrationId: accounts[1].id } }), 2);

  await switchOrganization(1, 2); await openThreads(); await selection.selectOption(accounts[2].id); await waitBlank();
  assert.equal(await pending.count(), 0);
  assert.equal(await prisma.post.count({ where: { organizationId: orgs[1] } }), 0);
  assert.equal(await prisma.snsContent.count(), 0); assert.equal(await prisma.snsDelivery.count(), 0);
  assert.equal(await prisma.post.count({ where: { state: { not: 'DRAFT' } } }), 0);
  await switchOrganization(2, 1);
  await page.getByRole('button', { name: '共通機能', exact: true }).click();
  await page.getByRole('button', { name: '複数SNSに投稿', exact: true }).click();
  await page.getByRole('heading', { name: '複数SNSに投稿', exact: true }).waitFor();
  assert.equal(await page.locator('[aria-label="Threads 投稿作成"]').count(), 0);
  assert.equal(await prisma.snsContent.count(), 0); assert.equal(await prisma.snsDelivery.count(), 0);
  assert.equal(process.env.THREADS_BROWSER_ALLOW_REAL_POST, 'false'); assert.equal(writes, 4); assert.deepEqual(errors, []);
  return { result: 'PASS', realProductionEditor: true, samePostIdAcrossSaveAndReload: true, accountIsolation: true, organizationIsolation: true, settingsPortalIsolation: true, blockedPostConfirmation: true, uncertainResultNoResend: true, trackingFailureReadOnlyRecovery: true, multiSnsNavigation: true, jstToUtc: true, mediaAttachRemoveAndPreview: true, previewEvidence, draftWrites: writes, realSnsPosts: 0, reservations: 0, providerCalls: 0 };
}
let report;
main().then(result => { report = result; }).catch(async error => {
  console.error(error.stack);
  if (errors.length) console.error('Synthetic API diagnostics:', errors.map(message => message.slice(-1800)));
  const page = browser?.contexts()[0]?.pages()[0];
  if (page) {
    // Only the synthetic, loopback fixture is opened by this browser context.
    const text = await page.locator('body').innerText({ timeout: 2000 }).catch(() => 'Fixture document unavailable');
    console.error('Visible fixture diagnostics:', text.slice(0, 2000));
  }
  process.exitCode = 1;
}).finally(async () => {
  if (browser) await browser.close();
  if (frontend && frontend.exitCode === null) { frontend.kill(); await new Promise(done => frontend.once('exit', done)); }
  if (frontendLog !== undefined) closeSync(frontendLog);
  if (server) await new Promise(done => server.close(done));
  // Media's ownership FK is restrictive. Delete ONLY this run's fixture rows
  // in dependency order; never rely on a cascade for synthetic media cleanup.
  const owned = { organizationId: { in: orgs } };
  await prisma.$transaction([
    prisma.post.deleteMany({ where: owned }),
    prisma.media.deleteMany({ where: owned }),
    prisma.integration.deleteMany({ where: owned }),
    prisma.organization.deleteMany({ where: { id: { in: orgs } } }),
  ]);
  assert.equal(await prisma.organization.count(), 0);
  assert.equal(await prisma.post.count(), 0);
  assert.equal(await prisma.media.count(), 0);
  assert.equal(await prisma.integration.count(), 0);
  await prisma.$disconnect();
  // Only the unique fixture folder created above is eligible for cleanup.
  assert(fixtureRoot.startsWith(join(tmpdir(), 'sns-threads-inline-')));
  rmSync(fixtureRoot, { recursive: true, force: true });
  if (report && process.exitCode !== 1) console.log(JSON.stringify({ ...report, cleanupVerified: true }));
}).catch(error => { console.error('Fixture cleanup failed:', error.message); process.exitCode = 1; });
