// SQLite nonce store (Rev 4.8 §8): the guarantees the design requires,
// proven, not asserted.
//   - atomic consumption: one INSERT OR IGNORE admits exactly one
//     consumer, in-process and across two processes sharing the file;
//   - restart persistence: a consumed nonce stays consumed after the
//     process exits without a clean close (no resurrection);
//   - interrupted-write recovery: a corrupted file surfaces as an error,
//     never as a silent "nonce unseen";
//   - expiry + bounds: expired nonces are pruned, the live set stays
//     bounded by the validity window;
//   - the file is created 0600.
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { SqliteNonceStore, NONCE_VALIDITY_SECONDS } from '../src/api-server/nonce-store.js';

const execFileAsync = promisify(execFile);
const CHILD = new URL('./nonce-consume-child.mjs', import.meta.url).pathname;

function nonce() {
  return randomBytes(16).toString('hex');
}

async function makeStore() {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-nonce-'));
  const dbPath = path.join(dir, 'nonces.db');
  const store = new SqliteNonceStore(dbPath);
  return {
    store,
    dbPath,
    dir,
    cleanup: async () => {
      try { store.close(); } catch { /* ignore */ }
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('consume admits the first caller and rejects the replay', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const n = nonce();
  assert.equal(ctx.store.consume('worker', n, Date.now() + 360_000), true);
  assert.equal(ctx.store.consume('worker', n, Date.now() + 360_000), false);
  assert.equal(ctx.store.has('worker', n), true);
  assert.equal(ctx.store.count(), 1);
});

test('the same nonce under a different key id is a different nonce (v13 §3 D-2.3)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const n = nonce();
  const expiry = Date.now() + 360_000;
  assert.equal(ctx.store.consume('worker', n, expiry), true);
  assert.equal(ctx.store.consume('worker', n, expiry), false);
  assert.equal(ctx.store.consume('nexora-v1', n, expiry), true);
  assert.equal(ctx.store.consume('nexora-v1', n, expiry), false);
  assert.equal(ctx.store.has('worker', n), true);
  assert.equal(ctx.store.has('nexora-v1', n), true);
  assert.equal(ctx.store.has('other-key', n), false);
  assert.equal(ctx.store.count(), 2);
});

test('a pre-v13 single-column nonces.db is migrated, not rejected', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  ctx.store.close();
  // Rewrite the file with the OLD schema (nonce TEXT PRIMARY KEY, no
  // key_id) and a live row in it, then reopen: the constructor drops
  // and recreates the table.
  const { DatabaseSync } = await import('node:sqlite');
  const legacy = new DatabaseSync(ctx.dbPath);
  legacy.exec('DROP TABLE nonces');
  legacy.exec('CREATE TABLE nonces (nonce TEXT PRIMARY KEY, expires_at INTEGER NOT NULL)');
  legacy.prepare('INSERT INTO nonces (nonce, expires_at) VALUES (?, ?)').run(nonce(), Date.now() + 360_000);
  legacy.close();
  const reopened = new SqliteNonceStore(ctx.dbPath);
  t.after(() => { try { reopened.close(); } catch { /* ignore */ } });
  const n = nonce();
  assert.equal(reopened.consume('worker', n, Date.now() + 360_000), true);
  assert.equal(reopened.consume('worker', n, Date.now() + 360_000), false);
});

test('two processes sharing one file admit exactly one consumer', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const n = nonce();
  const expiresAt = Date.now() + NONCE_VALIDITY_SECONDS * 1000;
  // Two children, started together, each consuming the same nonce.
  // The store file is shared; exactly one must print "true".
  const run = () => execFileAsync(process.execPath, [CHILD, ctx.dbPath, 'worker', n, String(expiresAt)], { timeout: 30_000 });
  const [a, b] = await Promise.all([run(), run()]);
  const results = [a.stdout.trim(), b.stdout.trim()].sort();
  assert.deepEqual(results, ['false', 'true']);
  // And the parent sees the nonce as consumed.
  assert.equal(ctx.store.has('worker', n), true);
});

test('a consumed nonce stays consumed after an unclean exit (restart persistence)', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const n = nonce();
  // The child consumes and exits WITHOUT closing the store (no clean
  // close — the process just ends). The commit is durable anyway.
  const { stdout } = await execFileAsync(process.execPath, [CHILD, ctx.dbPath, 'worker', n, String(Date.now() + 360_000)], { timeout: 30_000 });
  assert.equal(stdout.trim(), 'true');
  // Reopen in this process: the nonce is still consumed.
  ctx.store.close();
  const reopened = new SqliteNonceStore(ctx.dbPath);
  t.after(() => { try { reopened.close(); } catch { /* ignore */ } });
  assert.equal(reopened.consume('worker', n, Date.now() + 360_000), false);
  assert.equal(reopened.has('worker', n), true);
});

test('a corrupted file surfaces as an error, never as a silent "unseen"', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'nova-nonce-corrupt-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const dbPath = path.join(dir, 'nonces.db');
  await writeFile(dbPath, 'this is not a sqlite database at all');
  assert.throws(() => new SqliteNonceStore(dbPath), /file is not a database|database disk image is malformed|not a database/i);
});

test('expired nonces are pruned and can never grow the live set', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const now = Date.now();
  // Ten nonces, all already expired: each consume prunes the previous
  // expired rows first, so the live set never grows past 1.
  for (let i = 0; i < 10; i++) {
    assert.equal(ctx.store.consume('worker', nonce(), now - 1_000), true);
  }
  assert.equal(ctx.store.count(), 1);
  // Consuming a fresh nonce prunes the last expired one.
  assert.equal(ctx.store.consume('worker', nonce(), now + 360_000), true);
  assert.equal(ctx.store.count(), 1);
  // An expired nonce can be consumed again after pruning (its row is
  // gone) — the validity window, not the row, is the authority.
  const n = nonce();
  assert.equal(ctx.store.consume('worker', n, now - 1_000), true);
  assert.equal(ctx.store.consume('worker', n, now + 360_000), true);
  // Explicit prune removes expired rows and reports the count.
  assert.equal(ctx.store.consume('worker', nonce(), now - 1_000), true);
  assert.equal(ctx.store.prune(now), 1);
});

test('invalid nonces are rejected, never stored', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  assert.throws(() => ctx.store.consume('worker', 'too-short', Date.now() + 360_000), /32-hex/);
  assert.throws(() => ctx.store.consume('worker', 'zz'.repeat(16), Date.now() + 360_000), /32-hex/);
  assert.throws(() => ctx.store.consume('worker', nonce(), Number.NaN), /finite/);
  assert.equal(ctx.store.count(), 0);
});

test('the nonce file is created 0600', async (t) => {
  const ctx = await makeStore();
  t.after(ctx.cleanup);
  const mode = (await stat(ctx.dbPath)).mode & 0o777;
  assert.equal(mode, 0o600);
});

test('the validity window is the design 360 seconds', () => {
  assert.equal(NONCE_VALIDITY_SECONDS, 360);
});
