import * as fs from 'fs';
import * as path from 'path';
import { GitRepo } from './git';

// Names the UI owns as top-level path segments, plus vault fixtures. None of
// these may ever be a collection or repo name.
const RESERVED_NAMES = new Set([
  'vault.json',
  'config.json',
  'api',
  'assets',
  'login',
  'logout',
  'new',
  'import',
  'admin',
  'settings',
]);

export function isValidName(name: string): boolean {
  if (RESERVED_NAMES.has(name)) return false;
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) && !name.includes('..');
}

export function isBareRepo(dir: string): boolean {
  try {
    return (
      fs.statSync(path.join(dir, 'HEAD')).isFile() &&
      fs.statSync(path.join(dir, 'objects')).isDirectory() &&
      fs.statSync(path.join(dir, 'refs')).isDirectory()
    );
  } catch {
    return false;
  }
}

export function displayName(dirName: string): string {
  return dirName.replace(/\.git$/, '');
}

export function listRepoDirs(root: string, collection: string): string[] {
  const collectionDir = path.join(root, collection);
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(collectionDir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidName(e.name) && isBareRepo(path.join(collectionDir, e.name)))
    .map((e) => e.name)
    .sort();
}

export function listCollections(root: string): { name: string; repoCount: number }[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isDirectory() && isValidName(e.name))
    .map((e) => ({ name: e.name, repoCount: listRepoDirs(root, e.name).length }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function findRepo(root: string, collection: string, repoName: string): GitRepo | null {
  if (!isValidName(collection) || !isValidName(repoName)) return null;
  const base = displayName(repoName);
  for (const cand of [base, base + '.git']) {
    const dir = path.join(root, collection, cand);
    if (isBareRepo(dir)) return new GitRepo(dir, collection, base);
  }
  return null;
}

export function pagesDir(root: string, collection: string, repoName: string): string | null {
  if (!isValidName(collection) || !isValidName(repoName)) return null;
  const dir = path.join(root, collection, `${displayName(repoName)}.pages`);
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    // no pages directory
  }
  return null;
}

export function repoDescription(dir: string): string | null {
  try {
    const t = fs.readFileSync(path.join(dir, 'description'), 'utf8').trim();
    if (!t || t.startsWith('Unnamed repository')) return null;
    return t;
  } catch {
    return null;
  }
}
