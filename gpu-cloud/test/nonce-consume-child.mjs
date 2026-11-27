// Child helper for nonce-store.test.mjs: opens a SqliteNonceStore on the
// file given as argv[2], consumes the nonce given as argv[4] under the
// key id given as argv[3] with the expiry given as argv[5] (ms), and
// prints "true" or "false".
// Run by the cross-process test; never run directly.
import { SqliteNonceStore } from '../src/api-server/nonce-store.js';

const dbPath = process.argv[2];
const keyId = process.argv[3];
const nonce = process.argv[4];
const expiresAtMs = Number(process.argv[5]);
const store = new SqliteNonceStore(dbPath);
console.log(store.consume(keyId, nonce, expiresAtMs) ? 'true' : 'false');
