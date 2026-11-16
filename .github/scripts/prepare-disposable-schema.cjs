// CI-only, fresh fixture schema preparation. Never db push or reset a database.
const assert = require('node:assert/strict');
const { mkdtempSync, readFileSync, rmSync } = require('node:fs');
const { tmpdir } = require('node:os');
const { join } = require('node:path');
const { spawnSync } = require('node:child_process');

assert.equal(process.env.GITHUB_ACTIONS, 'true', 'Only isolated GitHub CI may prepare this schema');
const target = new URL(process.env.DATABASE_URL || '');
const fixtures = new Map([
  ['/sns_studio_bmode_e2e', '5548'],
  ['/sns_studio_account_protection_e2e', '5432'],
  ['/sns_studio_threads_inline_e2e', '5549'],
]);
assert.equal(target.protocol, 'postgresql:');
assert(['localhost', '127.0.0.1'].includes(target.hostname));
assert(fixtures.has(target.pathname), 'Unknown disposable database');
assert.equal(target.port, fixtures.get(target.pathname));
assert.equal(decodeURIComponent(target.username), 'postgres');

const { PrismaClient } = require('@prisma/client');
const schema = 'libraries/nestjs-libraries/src/database/prisma/schema.prisma';
const cli = require.resolve('prisma/build/index.js');
function run(args) {
  const result = spawnSync(process.execPath, [cli, ...args], { stdio: 'inherit' });
  if (result.error) throw result.error;
  assert.equal(result.status, 0, 'Disposable schema command failed');
}
(async () => {
  const prisma = new PrismaClient();
  try {
    const [row] = await prisma.$queryRaw`SELECT COUNT(*)::int AS count FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog', 'information_schema')`;
    assert.equal(row.count, 0, 'Refusing an existing database schema');
  } finally {
    await prisma.$disconnect();
  }
  const folder = mkdtempSync(join(tmpdir(), 'sns-ci-schema-'));
  try {
    const file = join(folder, 'create.sql');
    run(['migrate', 'diff', '--from-empty', '--to-schema-datamodel', schema, '--script', '--output', file]);
    const sql = readFileSync(file, 'utf8');
    assert(/CREATE TABLE\s/.test(sql));
    assert(!/^\s*(?:DROP|TRUNCATE|DELETE|UPDATE)\b/im.test(sql), 'Destructive SQL is forbidden');
    run(['db', 'execute', '--schema', schema, '--file', file]);
    console.log('Prepared CREATE-only schema in an empty, guarded CI fixture database.');
  } finally {
    rmSync(folder, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
