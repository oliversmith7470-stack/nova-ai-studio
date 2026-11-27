// NOVA AI Studio — strict-open file reader (Kaggle design v13, §3.3).
//
// activation.conf, the commissioning permit and the licence record are
// `root:nova-api` 0440. The reader takes expected (owner, group, mode)
// per file. Node has no openat, so it first lstats the parent directory
// (not a symlink, uid 0, no group/other write bit), then opens the file
// O_NOFOLLOW|O_CLOEXEC and fstats the fd (regular, nlink 1, uid 0,
// gid `nova-api`, mode 0440). Read + parse + hash happen from that same
// descriptor, so a symlink swap or a replace-between-check-and-read
// cannot slip past it.
//
// Expected values are overridable per call (tests run as a non-root
// user with temp files); production uses the defaults (uid 0, gid of
// `nova-api`, mode 0440, parent uid 0). A null expected group gid skips
// the group check; a null expected owner uid skips the owner check.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export function sha256Hex(text) {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

// Resolve a username to its uid from /etc/passwd. Returns the uid, or
// null when the user does not exist or /etc/passwd is unreadable.
export function resolveUserUid(username) {
  try {
    const text = fs.readFileSync('/etc/passwd', 'utf8');
    for (const line of text.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === username) {
        const uid = Number(parts[2]);
        return Number.isSafeInteger(uid) ? uid : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// Resolve a group name to its gid from /etc/group. Returns the gid, or
// null when the group does not exist or /etc/group is unreadable.
export function resolveGroupGid(groupname) {
  try {
    const text = fs.readFileSync('/etc/group', 'utf8');
    for (const line of text.split('\n')) {
      const parts = line.split(':');
      if (parts[0] === groupname) {
        const gid = Number(parts[2]);
        return Number.isSafeInteger(gid) ? gid : null;
      }
    }
  } catch {
    return null;
  }
  return null;
}

// The production expected values for a §3.3 file (activation.conf,
// commissioning permit, licence record).
export function defaultStrictFileExpected() {
  return {
    ownerUid: 0,
    groupGid: resolveGroupGid('nova-api'),
    mode: 0o440,
    parentUid: 0,
  };
}

// Strict-open read of one file. Returns { ok: true, text, sha256 } or
// { ok: false, reason } where reason is one of 'missing' |
// 'parent-symlink' | 'parent-not-root' | 'parent-writable' | 'symlink' |
// 'unreadable' | 'not-regular' | 'hardlink' | 'wrong-owner' |
// 'wrong-group' | 'wrong-mode'. Never throws for file problems (only a
// programming error throws).
export function verifyStrictFile(filePath, {
  expectedOwnerUid = 0,
  expectedGroupGid = resolveGroupGid('nova-api'),
  expectedMode = 0o440,
  expectedParentUid = 0,
} = {}) {
  // Parent directory first: not a symlink, root-owned, no group/other
  // write bit. A parent the API cannot trust means the file inside it
  // cannot be trusted either.
  const parentDir = path.dirname(filePath);
  let parentStat;
  try {
    parentStat = fs.lstatSync(parentDir);
  } catch {
    return { ok: false, reason: 'unreadable' };
  }
  if (parentStat.isSymbolicLink()) return { ok: false, reason: 'parent-symlink' };
  if (expectedParentUid !== null && parentStat.uid !== expectedParentUid) {
    return { ok: false, reason: 'parent-not-root' };
  }
  if ((parentStat.mode & 0o022) !== 0) return { ok: false, reason: 'parent-writable' };

  let st;
  try {
    st = fs.lstatSync(filePath);
  } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, reason: 'missing' };
    return { ok: false, reason: 'unreadable' };
  }
  if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
  let fd;
  try {
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_CLOEXEC);
  } catch (err) {
    if (err && err.code === 'ELOOP') return { ok: false, reason: 'symlink' };
    return { ok: false, reason: 'unreadable' };
  }
  try {
    const fst = fs.fstatSync(fd);
    if (!fst.isFile()) return { ok: false, reason: 'not-regular' };
    if (fst.nlink !== 1) return { ok: false, reason: 'hardlink' };
    if (expectedOwnerUid !== null && fst.uid !== expectedOwnerUid) {
      return { ok: false, reason: 'wrong-owner' };
    }
    if (expectedGroupGid !== null && fst.gid !== expectedGroupGid) {
      return { ok: false, reason: 'wrong-group' };
    }
    if ((fst.mode & 0o7777) !== expectedMode) return { ok: false, reason: 'wrong-mode' };
    const text = fs.readFileSync(fd, 'utf8');
    return { ok: true, text, sha256: sha256Hex(text) };
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

// Write a §3.3 file by write-temp-and-rename (operator procedure): the
// temp file is created in the same directory, chown root:nova-api and
// chmod 0440 BEFORE the rename, so the live file is never observable
// with the wrong owner or mode. `expected` carries the owner uid /
// group gid / mode to set (production: 0 / nova-api gid / 0440).
// Throws on failure (the operator procedure must not claim an
// unrecorded change).
export function writeStrictFile(filePath, text, {
  ownerUid = 0,
  groupGid = resolveGroupGid('nova-api'),
  mode = 0o440,
} = {}) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const tmp = `${filePath}.tmp-${process.pid}`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeFileSync(fd, text, 'utf8');
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  try {
    if (ownerUid !== null && groupGid !== null) fs.chownSync(tmp, ownerUid, groupGid);
    else if (ownerUid !== null) fs.chownSync(tmp, ownerUid, -1);
    else if (groupGid !== null) fs.chownSync(tmp, -1, groupGid);
  } catch (err) {
    try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    throw new Error(`writeStrictFile chown failed for ${filePath}: ${err?.message ?? err}`);
  }
  fs.chmodSync(tmp, mode);
  fs.renameSync(tmp, filePath);
  return filePath;
}
