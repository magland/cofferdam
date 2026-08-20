import assert from 'node:assert/strict';
import * as fs from 'fs';
import * as path from 'path';
import { test } from 'node:test';
import { fileCache } from '../src/filecache';
import { makeVaultDir } from './helpers';

test('a file is read once per stat, and a changed file is read again', () => {
  const dir = makeVaultDir();
  const file = path.join(dir, 'state.txt');
  fs.writeFileSync(file, 'one');
  let reads = 0;
  const cache = fileCache<string>({
    read: (f) => {
      reads++;
      return fs.readFileSync(f, 'utf8');
    },
    missing: () => 'absent',
  });
  assert.equal(cache.get(file), 'one');
  assert.equal(cache.get(file), 'one');
  assert.equal(reads, 1);
  // A different size guarantees the stat check sees the change, whatever the
  // filesystem's mtime granularity.
  fs.writeFileSync(file, 'two is longer');
  assert.equal(cache.get(file), 'two is longer');
  assert.equal(reads, 2);
});

test('two files are cached side by side rather than thrashing one slot', () => {
  const dir = makeVaultDir();
  const a = path.join(dir, 'a.txt');
  const b = path.join(dir, 'b.txt');
  fs.writeFileSync(a, 'aaa');
  fs.writeFileSync(b, 'bbbb');
  let reads = 0;
  const cache = fileCache<string>({
    read: (f) => {
      reads++;
      return fs.readFileSync(f, 'utf8');
    },
    missing: () => 'absent',
  });
  assert.equal(cache.get(a), 'aaa');
  assert.equal(cache.get(b), 'bbbb');
  assert.equal(cache.get(a), 'aaa');
  assert.equal(cache.get(b), 'bbbb');
  assert.equal(reads, 2);
});

test('a missing file is answered but not cached, so its appearance is noticed', () => {
  const dir = makeVaultDir();
  const file = path.join(dir, 'late.txt');
  const cache = fileCache<string>({
    read: (f) => fs.readFileSync(f, 'utf8'),
    missing: () => 'absent',
  });
  assert.equal(cache.get(file), 'absent');
  fs.writeFileSync(file, 'here now');
  assert.equal(cache.get(file), 'here now');
  // And a deletion is noticed the same way.
  fs.rmSync(file);
  assert.equal(cache.get(file), 'absent');
});

test('invalidate forces a reread whatever the stat says', () => {
  const dir = makeVaultDir();
  const file = path.join(dir, 'state.txt');
  fs.writeFileSync(file, 'one');
  let reads = 0;
  const cache = fileCache<string>({
    read: (f) => {
      reads++;
      return fs.readFileSync(f, 'utf8');
    },
    missing: () => 'absent',
  });
  cache.get(file);
  cache.invalidate(file);
  cache.get(file);
  assert.equal(reads, 2);
});
