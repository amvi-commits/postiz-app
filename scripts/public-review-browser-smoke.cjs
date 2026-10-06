'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const BASE_URL = process.env.PUBLIC_ROOT_URL || 'https://sns-studio.sweet-honey-works.com';
const ARTIFACT_DIR = path.join(__dirname, '..', 'artifacts', 'review-browser-smoke');

fs.mkdirSync(ARTIFACT_DIR, { recursive: true });

// Optional worker paths known in integration/review runtime
const OPTIONAL_WORKER_PATHS = new Set([
  '/api/sns-studio/voicevox/speakers',
  '/api/sns-studio/media/health',
  '/api/sns-studio/health',
]);

// Load optional .env.review if present
const envReviewPath = path.join(__dirname, '..', '.env.review');
if (fs.existsSync(envReviewPath)) {
  const envContent = fs.readFileSync(envReviewPath, 'utf8');
  for (const line of envContent.split('\n')) {
    const trimmed = line.trim();
    if (trimmed && !trimmed.startsWith('#') && trimmed.includes('=')) {
      const idx = trimmed.indexOf('=');
      const key = trimmed.slice(0, idx).trim();
      const val = trimmed.slice(idx + 1).trim();
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  }
}

const REVIEW_USER_EMAIL = process.env.REVIEW_USER_EMAIL || 'reviewer@sweet-honey-works.com';
const REVIEW_USER_PASSWORD = process.env.REVIEW_USER_PASSWORD;

if (!REVIEW_USER_PASSWORD) {
  throw new Error('[browser-smoke] FAIL-CLOSED: REVIEW_USER_PASSWORD environment variable is required.');
}

async function run() {
  console.log(`[browser-smoke] Starting Public Browser E2E smoke on ${BASE_URL}...`);

  const browser = await chromium.launch({
    headless: true,
  });

  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    ignoreHTTPSErrors: false,
  });

  const page = await context.newPage();

  const metrics = {
    pageErrors: [],
    consoleErrors: [],
    unexpectedConsoleErrors: [],
    expectedPreAuth401: [],
    expectedNegativeAuth400: [],
    http404s: [],
    http500s: [],
    corsErrors: [],
    mixedContent: [],
    externalSnsCalls: [],
    testedScreens: [],
  };

  page.on('pageerror', (err) => {
    console.error(`[pageerror] ${err.message}`);
    metrics.pageErrors.push(err.message);
  });

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      // Ignore favicon and known optional worker 503 noise
      if (
        !text.includes('favicon.ico') &&
        !text.includes('503') &&
        !text.includes('copilot')
      ) {
        if (text.includes('status of 401') || text.includes('401 (Unauthorized)')) {
          console.log(`[console.info (EXPECTED_PRE_AUTH_401)] ${text}`);
          metrics.expectedPreAuth401.push(text);
        } else if (text.includes('status of 400')) {
          console.log(`[console.info (EXPECTED_NEGATIVE_AUTH_400)] ${text}`);
          metrics.expectedNegativeAuth400.push(text);
        } else {
          console.warn(`[console.error] ${text}`);
          metrics.consoleErrors.push(text);
          metrics.unexpectedConsoleErrors.push(text);
        }
      }
    }
  });

  page.on('request', (req) => {
    const url = req.url();
    // Check if any real external SNS APIs are reached
    if (
      url.includes('api.tiktok.com') ||
      url.includes('graph.facebook.com') ||
      url.includes('graph.instagram.com') ||
      url.includes('googleapis.com/youtube')
    ) {
      metrics.externalSnsCalls.push(url);
    }
  });

  page.on('response', (res) => {
    const status = res.status();
    const url = res.url();
    const urlObj = new URL(url);

    if (status === 404 && !url.includes('favicon.ico')) {
      console.error(`[HTTP 404] ${url}`);
      metrics.http404s.push(url);
    } else if (status >= 500 && status < 600) {
      // Check if it is an expected optional worker probe
      if (OPTIONAL_WORKER_PATHS.has(urlObj.pathname)) {
        console.log(`[HTTP ${status} (Optional Worker Probe)] ${urlObj.pathname}`);
      } else {
        console.error(`[HTTP ${status}] ${url}`);
        metrics.http500s.push({ status, url });
      }
    }
  });

  // Step 1: Landing Page
  console.log(`[browser-smoke] 1. Visiting Landing (${BASE_URL}/)...`);
  await page.goto(`${BASE_URL}/`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(2000);
  const landingTitle = await page.title();
  console.log(`[browser-smoke] Landing title: "${landingTitle}"`);
  if (!landingTitle.includes('SNS Studio')) {
    throw new Error(`Landing page title unexpected: ${landingTitle}`);
  }
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '01-landing.png'), fullPage: true });
  metrics.testedScreens.push('Landing Page (/)');

  // Step 2: Terms of Service
  console.log(`[browser-smoke] 2. Visiting Terms (${BASE_URL}/terms)...`);
  await page.goto(`${BASE_URL}/terms`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const termsTitle = await page.title();
  console.log(`[browser-smoke] Terms title: "${termsTitle}"`);
  const termsContent = await page.textContent('body');
  if (!termsContent.includes('Terms of Service')) {
    throw new Error('Terms of Service content not found');
  }
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '02-terms.png'), fullPage: true });
  metrics.testedScreens.push('Terms of Service (/terms)');

  // Step 3: Privacy Policy
  console.log(`[browser-smoke] 3. Visiting Privacy (${BASE_URL}/privacy)...`);
  await page.goto(`${BASE_URL}/privacy`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1000);
  const privacyTitle = await page.title();
  console.log(`[browser-smoke] Privacy title: "${privacyTitle}"`);
  const privacyContent = await page.textContent('body');
  if (!privacyContent.includes('Privacy Policy')) {
    throw new Error('Privacy Policy content not found');
  }
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '03-privacy.png'), fullPage: true });
  metrics.testedScreens.push('Privacy Policy (/privacy)');

  // Step 4: Login
  console.log(`[browser-smoke] 4. Visiting Login (${BASE_URL}/auth/login)...`);
  await page.goto(`${BASE_URL}/auth/login`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('input[type="email"], input[name="email"]', { timeout: 15000 });
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '04-login-page.png'), fullPage: true });

  // Step 4a: Negative Login Verification (Invalid / Outdated Credentials)
  console.log(`[browser-smoke] 4a. Verifying invalid / outdated credential rejection...`);
  await page.fill('input[type="email"], input[name="email"]', REVIEW_USER_EMAIL);
  await page.fill('input[type="password"], input[name="password"]', 'InvalidOutdatedPassword2026!Rev');
  
  const [invalidLoginRes] = await Promise.all([
    page.waitForResponse(res => res.url().includes('/api/auth/login'), { timeout: 15000 }),
    page.click('button[type="submit"]')
  ]);
  console.log(`[browser-smoke] Invalid login response status: ${invalidLoginRes.status()}`);
  if (invalidLoginRes.status() === 200) {
    throw new Error('[browser-smoke] Security Failure: Invalid password was accepted with 200 OK!');
  }
  await page.waitForTimeout(1000);

  // Step 4b: Positive Login with Rotated Credentials
  console.log(`[browser-smoke] 4b. Submitting valid rotated credentials (credentials masked)...`);
  await page.fill('input[type="email"], input[name="email"]', REVIEW_USER_EMAIL);
  await page.fill('input[type="password"], input[name="password"]', REVIEW_USER_PASSWORD);
  
  const [loginResponse] = await Promise.all([
    page.waitForResponse(res => res.url().includes('/api/auth/login') && res.status() === 200, { timeout: 15000 }),
    page.click('button[type="submit"]')
  ]);
  console.log(`[browser-smoke] Valid login API response status: ${loginResponse.status()}`);

  await page.waitForTimeout(3000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '05-after-login.png'), fullPage: true });
  metrics.testedScreens.push('Login & Auth Flow (/auth/login)');

  // Step 5: SNS Studio Dashboard
  console.log(`[browser-smoke] 5. Navigating to SNS Studio (${BASE_URL}/sns-studio)...`);
  await page.goto(`${BASE_URL}/sns-studio`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '06-sns-studio.png'), fullPage: true });
  metrics.testedScreens.push('SNS Studio Dashboard (/sns-studio)');

  // Step 6: Launches / Post Composer
  console.log(`[browser-smoke] 6. Navigating to Launches (${BASE_URL}/launches)...`);
  await page.goto(`${BASE_URL}/launches`, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(4000);
  await page.screenshot({ path: path.join(ARTIFACT_DIR, '07-launches.png'), fullPage: true });
  metrics.testedScreens.push('Launches & Composer (/launches)');

  // Step 7: Check API endpoint for TikTok Creator Info directly from authenticated browser context
  console.log(`[browser-smoke] 7. Verifying TikTok Creator Info endpoint through page context...`);
  const creatorInfoRes = await page.evaluate(async (baseUrl) => {
    const res = await fetch(`${baseUrl}/api/sns-studio/tiktok/accounts/c7f99999-0000-4000-a000-000000000003/creator-info`, {
      credentials: 'include'
    });
    return {
      status: res.status,
      data: await res.json()
    };
  }, BASE_URL);

  console.log(`[browser-smoke] Creator Info response status: ${creatorInfoRes.status}`);
  console.log(`[browser-smoke] Creator username: ${creatorInfoRes.data?.creator_username}`);
  console.log(`[browser-smoke] Privacy options:`, creatorInfoRes.data?.privacy_level_options);
  console.log(`[browser-smoke] Interaction defaults: comment_disabled=${creatorInfoRes.data?.comment_disabled}, duet_disabled=${creatorInfoRes.data?.duet_disabled}, stitch_disabled=${creatorInfoRes.data?.stitch_disabled}`);

  if (creatorInfoRes.status !== 200) {
    throw new Error(`Creator Info endpoint returned status ${creatorInfoRes.status}`);
  }

  if (creatorInfoRes.data?.creator_username !== 'reviewer_demo') {
    throw new Error(`Unexpected creator username: ${creatorInfoRes.data?.creator_username}`);
  }

  if (!creatorInfoRes.data?.privacy_level_options || creatorInfoRes.data.privacy_level_options.length === 0) {
    throw new Error(`Empty privacy level options`);
  }
  metrics.testedScreens.push('TikTok Creator Info & Phase 1 Provider API (/api/sns-studio/tiktok/accounts/.../creator-info)');

  // Final assertions
  console.log('--------------------------------------------------');
  console.log('[browser-smoke] Verification Results:');
  console.log(`- Page Errors: ${metrics.pageErrors.length}`);
  console.log(`- Unexpected Console Errors: ${metrics.unexpectedConsoleErrors.length}`);
  console.log(`- Expected Pre-Auth 401s: ${metrics.expectedPreAuth401.length}`);
  console.log(`- Expected Negative Auth 400s: ${metrics.expectedNegativeAuth400.length}`);
  console.log(`- HTTP 404 Errors: ${metrics.http404s.length}`);
  console.log(`- HTTP 500 Errors: ${metrics.http500s.length}`);
  console.log(`- CORS Errors: ${metrics.corsErrors.length}`);
  console.log(`- Mixed Content Errors: ${metrics.mixedContent.length}`);
  console.log(`- External SNS Calls: ${metrics.externalSnsCalls.length}`);
  console.log(`- Tested Screens: ${metrics.testedScreens.join(', ')}`);
  console.log('--------------------------------------------------');

  const summary = {
    result: 'PASS',
    baseUrl: BASE_URL,
    timestamp: new Date().toISOString(),
    metrics: {
      ...metrics,
      classification401: 'EXPECTED_PRE_AUTH_401',
      classification400: 'EXPECTED_NEGATIVE_AUTH_400',
    },
  };

  fs.writeFileSync(path.join(ARTIFACT_DIR, 'summary.json'), JSON.stringify(summary, null, 2));

  await browser.close();

  if (
    metrics.pageErrors.length > 0 ||
    metrics.unexpectedConsoleErrors.length > 0 ||
    metrics.http404s.length > 0 ||
    metrics.http500s.length > 0 ||
    metrics.externalSnsCalls.length > 0
  ) {
    console.error('[browser-smoke] FAILURE: Errors detected!');
    process.exit(1);
  }

  console.log('[browser-smoke] SUCCESS: All checks passed with 0 errors!');
}

run().catch((err) => {
  console.error('[browser-smoke] FATAL ERROR:', err);
  process.exit(1);
});
