import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';

// Owner-authorized, empty-database initialization. Never a migration/reset tool.
export const DISABLED_PASSWORD_HASH = '$2b$disabled-website-service-account';

export function assertStagingIdentity(env) {
  // Expected identities are supplied privately by the approving operator,
  // never committed to this public repository or inferred from a live binding.
  if (!env.SDR_STAGING_EXPECTED_REPL_ID || !/^[a-f0-9]{64}$/.test(env.SDR_STAGING_EXPECTED_DATABASE_SHA256 ?? '')) throw new Error('PRIVATE_STAGING_CONFIGURATION_REQUIRED');
  if (env.REPL_ID !== env.SDR_STAGING_EXPECTED_REPL_ID || env.PROD_DATABASE_URL) throw new Error('STAGING_IDENTITY_MISMATCH');
  const url = new URL(env.DATABASE_URL);
  const fingerprint = createHash('sha256').update(url.hostname + url.pathname).digest('hex');
  if (fingerprint !== env.SDR_STAGING_EXPECTED_DATABASE_SHA256) throw new Error('STAGING_DATABASE_MISMATCH');
  return fingerprint;
}

export function validateCreateOnlyDdl(source, expectedSha) {
  const sha = createHash('sha256').update(source).digest('hex');
  if (!/^[a-f0-9]{64}$/.test(expectedSha ?? '') || sha !== expectedSha) throw new Error('DDL_REVIEW_HASH_MISMATCH');
  const statements = source.replace(/--[^\n]*/g, '').split(';').map(s => s.trim()).filter(Boolean);
  if (!statements.length || statements.some(s => !/^(?:CREATE (?:TABLE|(?:UNIQUE )?INDEX|TYPE|SEQUENCE)\b|ALTER TABLE\s+"[^"]+"\s+ADD CONSTRAINT\b)/i.test(s))) throw new Error('DDL_NOT_CREATE_ONLY');
  if (statements.some(s => /\b(?:DROP|TRUNCATE|DELETE|UPDATE|INSERT|RENAME)\b/i.test(s.replace(/'[^']*'/g, '').replace(/\bON\s+(?:DELETE|UPDATE)\s+(?:NO ACTION|SET NULL|SET DEFAULT|CASCADE|RESTRICT)\b/gi, '')))) throw new Error('DDL_DESTRUCTIVE_TOKEN');
  return { sha, statementCount: statements.length };
}

async function verify(client, labId, receiverId) {
  const identity = await client.query(`select o.id lab_id, o.name, o.type, u.id receiver_id,
    u.role user_role, u.user_type, u.is_active, u.password = $3 password_disabled,
    u.email is null no_email, u.phone is null no_phone,
    m.role membership_role, m.status membership_status,
    (select count(*)::int from lab_memberships where user_id=u.id) membership_count,
    s.status subscription_status, s.provider subscription_provider,
    s.payment_method_on_file, s.trial_end_at
    from organizations o join lab_memberships m on m.lab_id=o.id
    join users u on u.id=m.user_id
    join subscriptions s on s.subject_type='lab_org' and s.subject_id=o.id
    where o.id=$1 and u.id=$2`, [labId, receiverId, DISABLED_PASSWORD_HASH]);
  const row = identity.rows[0];
  if (identity.rowCount !== 1 || row.type !== 'lab' || row.user_type !== 'lab' || row.user_role !== 'user'
      || !row.is_active || !row.password_disabled || !row.no_email || !row.no_phone
      || row.membership_role !== 'user' || row.membership_status !== 'active' || row.membership_count !== 1
      || row.subscription_status !== 'trialing' || row.subscription_provider !== 'none' || row.payment_method_on_file) throw new Error('RECEIVER_VERIFICATION_FAILED');
  const counts = await client.query(`select
    (select count(*)::int from organizations) organizations,
    (select count(*)::int from users) users,
    (select count(*)::int from user_sessions) sessions,
    (select count(*)::int from lab_cases) legacy_cases,
    (select count(*)::int from cases) cases,
    (select count(*)::int from invoices) invoices,
    (select count(*)::int from lab_inbox_files) inbox_files,
    (select count(*)::int from website_intake_submissions) website_submissions`);
  return { receiver: row, counts: counts.rows[0] };
}

export async function main(args = process.argv.slice(2), env = process.env) {
  const fingerprint = assertStagingIdentity(env);
  const labId = env.SDR_WEBSITE_LAB_ORG_ID;
  const receiverId = env.SDR_WEBSITE_INTAKE_USER_ID;
  if (![labId,receiverId].every(value => /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(value ?? ''))) throw new Error('PRIVATE_STAGING_ACCOUNT_IDS_REQUIRED');
  const [mode, ddlPath, expectedSha] = args;
  if (!['--apply', '--verify'].includes(mode)) throw new Error('EXPLICIT_APPLY_OR_VERIFY_REQUIRED');
  const source = mode === '--apply' ? await readFile(ddlPath, 'utf8') : null;
  const review = source === null ? null : validateCreateOnlyDdl(source, expectedSha);
  const { default: pg } = await import('pg');
  const client = new pg.Client({ connectionString: env.DATABASE_URL, connectionTimeoutMillis: 15000 });
  await client.connect();
  let transactionOpen = false;
  try {
    if (mode === '--apply') {
      await client.query('BEGIN'); transactionOpen = true;
      await client.query("select pg_advisory_xact_lock(hashtextextended('sdr-website-staging-bootstrap',0))");
      const existing = await client.query("select count(*)::int n from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind in ('r','p','v','m','S')");
      if (existing.rows[0].n !== 0) throw new Error('DATABASE_NOT_EMPTY_NO_WRITES_PERFORMED');
      await client.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
      await client.query(source);
      await client.query(`insert into users (id,username,password,first_name,last_name,user_type,role,is_active,email,phone)
        values ($1,'sdr-website-receiver-staging',$2,'Website','Receiver (staging)','lab','user',true,null,null)`, [receiverId, DISABLED_PASSWORD_HASH]);
      await client.query(`insert into organizations (id,type,name,display_name,is_active,created_by_user_id)
        values ($1,'lab','SDR Website Intake — STAGING ONLY','SDR Intake Staging',true,$2)`, [labId, receiverId]);
      await client.query(`insert into lab_memberships (lab_id,user_id,role,status,joined_at)
        values ($1,$2,'user','active',now())`, [labId, receiverId]);
      // Ordinary new-lab trial, not a paid subscription or an entitlement bypass.
      const trialDays = Math.max(1, parseInt(env.SUBSCRIPTION_TRIAL_DAYS ?? '30', 10));
      if (!Number.isSafeInteger(trialDays) || trialDays > 30) throw new Error('UNEXPECTED_TRIAL_CONFIGURATION');
      const subscription = await client.query(`insert into subscriptions
        (subject_type,subject_id,provider,status,trial_start_at,trial_end_at)
        values ('lab_org',$1,'none','trialing',now(),now()+($2::int*interval '1 day')) returning id,trial_end_at`, [labId, trialDays]);
      await client.query(`insert into subscription_events
        (subscription_id,subject_type,subject_id,event_type,provider,status_after,raw_payload_json)
        values ($1,'lab_org',$2,'trial_started','none','trialing',$3::jsonb)`,
        [subscription.rows[0].id, labId, JSON.stringify({trialDays, trialEndAt:subscription.rows[0].trial_end_at.toISOString(), actorUserId:receiverId, stagingOnly:true, ownerAuthorized:true})]);
      const result = await verify(client, labId, receiverId);
      if (Object.entries(result.counts).some(([key,value]) => value !== (['organizations','users'].includes(key) ? 1 : 0))) throw new Error('INITIAL_DATA_VERIFICATION_FAILED');
      await client.query('COMMIT'); transactionOpen = false;
      console.log(JSON.stringify({ action:'initialized_empty_staging', fingerprint, ddl:review, ...result }));
    } else {
      console.log(JSON.stringify({ action:'verified_existing_staging_read_only', fingerprint, ...await verify(client, labId, receiverId) }));
    }
  } finally {
    if (transactionOpen) await client.query('ROLLBACK');
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => {
    const message = error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'STAGING_SETUP_FAILED';
    console.error(JSON.stringify({ error:message, sqlState: /^[0-9A-Z]{5}$/.test(error?.code ?? '') ? error.code : undefined }));
    process.exitCode = 1;
  });
}
