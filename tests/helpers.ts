import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// Shared fabric for the unit tests: a throwaway vault directory, and the
// smallest thing scan.ts accepts as a bare repository (a HEAD file and the
// two directories isBareRepo stats). No git binary is involved, which is what
// keeps these tests at milliseconds.

export function makeVaultDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'feorge-unit-'));
}

export function makeBareRepo(root: string, collection: string, repo: string): string {
  const dir = path.join(root, 'collections', collection, 'repos', `${repo}.git`);
  fs.mkdirSync(path.join(dir, 'objects'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'refs'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'HEAD'), 'ref: refs/heads/main\n');
  return dir;
}

export function removeBareRepo(root: string, collection: string, repo: string): void {
  fs.rmSync(path.join(root, 'collections', collection, 'repos', `${repo}.git`), {
    recursive: true,
    force: true,
  });
}
