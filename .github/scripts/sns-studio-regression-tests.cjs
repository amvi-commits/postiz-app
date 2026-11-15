// CPU/component contracts only. Disposable DB/browser suites run separately.
// Discover frontend contracts from the checked-out head, including stacked PRs.
const { existsSync, readdirSync } = require('node:fs');
const { resolve } = require('node:path');
const { spawnSync } = require('node:child_process');
const frontend = 'apps/frontend/src/components/sns-studio';
const backend = 'apps/backend/src/services/sns-studio';
const providers = 'libraries/nestjs-libraries/src/integrations/social';
const specs = [
  ...[
    'account-protection', 'common-delivery-view.service', 'common-publishing.service',
    'generation-contract', 'instagram-metrics', 'instagram-publish',
    'sns-studio-common-publishing.controller',
    'tiktok-analytics.adapter', 'tiktok-publish.adapter', 'tiktok-publish.guard',
    'tiktok-status.adapter', 'video-input', 'video-tools',
  ].map(name => `${backend}/${name}.spec.ts`),
  ...readdirSync(frontend).filter(name => name.endsWith('.spec.ts')).sort()
    .map(name => `${frontend}/${name}`),
  ...[
    'threads.browser-provider', 'threads.capabilities', 'threads.delete-provider',
    'threads.gif-provider', 'tiktok.provider.preflight', 'tiktok-publication-status.adapter',
  ].map(name => `${providers}/${name}.spec.ts`),
  'apps/backend/src/services/posts/provider-publish-pre-create-protection.service.spec.ts',
];
const threadsMetadata = `${backend}/threads-compose-metadata.spec.ts`;
if (existsSync(threadsMetadata)) specs.push(threadsMetadata);
console.log(`SNS Studio contracts: ${specs.length} suites from this checkout; no real SNS/Drive/GPU.`);
const result = spawnSync(process.execPath, [
  '--require', resolve('tests/jsdom-optional-canvas.cjs'),
  require.resolve('jest/bin/jest'), '--runInBand', '--runTestsByPath', ...specs,
  ...process.argv.slice(2),
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exit(result.status ?? 1);
