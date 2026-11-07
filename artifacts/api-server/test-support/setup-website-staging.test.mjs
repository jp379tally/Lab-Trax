import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { assertStagingIdentity, validateCreateOnlyDdl, DISABLED_PASSWORD_HASH } from './setup-website-staging.mjs';
const hash = text => createHash('sha256').update(text).digest('hex');
const expected = {SDR_STAGING_EXPECTED_REPL_ID:'synthetic-staging-project',SDR_STAGING_EXPECTED_DATABASE_SHA256:hash('localhost/synthetic_staging')};
test('requires independently approved private staging configuration', () => {
  assert.throws(() => assertStagingIdentity({REPL_ID:'synthetic-staging-project'}), /PRIVATE_STAGING_CONFIGURATION_REQUIRED/);
});
test('rejects live or unrelated Replit projects before any connection', () => {
  for (const id of [undefined, 'synthetic-production-project', 'other']) assert.throws(() => assertStagingIdentity({...expected,REPL_ID:id}), /STAGING_IDENTITY_MISMATCH/);
});
test('rejects any production database binding', () => {
  assert.throws(() => assertStagingIdentity({...expected,REPL_ID:expected.SDR_STAGING_EXPECTED_REPL_ID, PROD_DATABASE_URL:'configured'}), /STAGING_IDENTITY_MISMATCH/);
});
test('rejects any other database even inside approved staging project', () => {
  assert.throws(() => assertStagingIdentity({...expected,REPL_ID:expected.SDR_STAGING_EXPECTED_REPL_ID,DATABASE_URL:'postgresql://localhost/unrelated'}), /STAGING_DATABASE_MISMATCH/);
});
test('requires exact reviewed DDL bytes', () => {
  const sql='CREATE TABLE "test" ("id" text);';
  assert.throws(() => validateCreateOnlyDdl(sql, hash(sql+' ')), /DDL_REVIEW_HASH_MISMATCH/);
  assert.throws(() => validateCreateOnlyDdl(sql, undefined), /DDL_REVIEW_HASH_MISMATCH/);
});
test('accepts generated create-only statements and additive foreign keys', () => {
  const sql='CREATE TABLE "a" ("id" text);--> statement-breakpoint\nCREATE UNIQUE INDEX "a_id" ON "a" ("id");\nALTER TABLE "a" ADD CONSTRAINT "a_fk" FOREIGN KEY ("id") REFERENCES "b"("id") ON DELETE set null ON UPDATE no action;';
  assert.equal(validateCreateOnlyDdl(sql,hash(sql)).statementCount,3);
});
test('rejects resets, data writes, lossy changes, grants and unrecognized statements', () => {
  for(const sql of ['DROP TABLE "a";','TRUNCATE "a";','DELETE FROM "a";','UPDATE "a" SET id=1;','ALTER TABLE "a" DROP COLUMN "id";','GRANT ALL ON "a" TO public;','SELECT 1;']) assert.throws(() => validateCreateOnlyDdl(sql,hash(sql)), /DDL_NOT_CREATE_ONLY/);
});
test('does not store a plaintext-login fallback sentinel', () => {
  assert.ok(DISABLED_PASSWORD_HASH.startsWith('$2'));
  assert.ok(DISABLED_PASSWORD_HASH.length !== 60);
});
