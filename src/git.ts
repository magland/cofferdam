import { execFile } from 'child_process';

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {}

export interface ExecGitOptions {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
}

export function execGit(repoDir: string, args: string[], opts: ExecGitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repoDir, ...args],
      { maxBuffer: MAX_BUFFER, encoding: 'buffer' as BufferEncoding, env: opts.env },
      (err, stdout, stderr) => {
        if (err) {
          const msg = stderr ? stderr.toString().trim() : err.message;
          reject(new GitError(`git ${args[0]} failed: ${msg}`));
        } else {
          resolve(Buffer.from(stdout));
        }
      }
    );
    if (child.stdin) {
      if (opts.input !== undefined) child.stdin.write(opts.input);
      child.stdin.end();
    }
  });
}

export interface RefInfo {
  name: string;
  sha: string;
  date: string;
  subject: string;
}

export interface TreeEntry {
  mode: string;
  type: string;
  sha: string;
  size: number | null;
  name: string;
}

export interface CommitSummary {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface CommitDetail {
  sha: string;
  author: string;
  email: string;
  date: string;
  parents: string[];
  message: string;
}

export function isValidRefName(ref: string): boolean {
  if (ref.length === 0 || ref.length > 300) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._@+/-]*$/.test(ref)) return false;
  if (ref.includes('..') || ref.endsWith('/') || ref.endsWith('.lock')) return false;
  return true;
}

export function isValidRepoPath(p: string): boolean {
  if (p === '') return true;
  // eslint-disable-next-line no-control-regex
  if (p.startsWith('/') || p.endsWith('/') || /[\x00-\x1f]/.test(p)) return false;
  return p.split('/').every((seg) => seg !== '' && seg !== '.' && seg !== '..');
}

export function isValidSha(s: string): boolean {
  return /^[0-9a-f]{40}$/i.test(s);
}

export class GitRepo {
  constructor(public dir: string, public collection: string, public name: string) {}

  private async lines(args: string[]): Promise<string[]> {
    const out = (await execGit(this.dir, args)).toString('utf8');
    return out.split('\n').filter((l) => l.length > 0);
  }

  async listRefs(kind: 'heads' | 'tags'): Promise<RefInfo[]> {
    const fmt = '%(refname:short)%00%(objectname)%00%(creatordate:iso8601-strict)%00%(contents:subject)';
    const ls = await this.lines(['for-each-ref', `--format=${fmt}`, '--sort=-creatordate', `refs/${kind}`]);
    return ls.map((l) => {
      const [name, sha, date, subject] = l.split('\0');
      return { name, sha, date, subject: subject ?? '' };
    });
  }

  async defaultBranch(branches: RefInfo[]): Promise<string | null> {
    try {
      const out = (await execGit(this.dir, ['symbolic-ref', '--short', 'HEAD'])).toString('utf8').trim();
      if (branches.some((b) => b.name === out)) return out;
    } catch {
      // detached or unborn HEAD; fall through
    }
    return branches.length > 0 ? branches[0].name : null;
  }

  async lastUpdated(): Promise<string | null> {
    const ls = await this.lines([
      'for-each-ref',
      '--count=1',
      '--sort=-committerdate',
      '--format=%(committerdate:iso8601-strict)',
      'refs/heads',
    ]);
    return ls[0] ?? null;
  }

  async listTree(ref: string, path: string): Promise<TreeEntry[]> {
    const spec = path ? `${ref}:${path}` : ref;
    const out = (await execGit(this.dir, ['ls-tree', '-z', '-l', spec])).toString('utf8');
    const entries: TreeEntry[] = [];
    for (const item of out.split('\0')) {
      if (!item) continue;
      const m = item.match(/^(\S+) (\S+) (\S+) +(\S+)\t([\s\S]*)$/);
      if (!m) continue;
      entries.push({
        mode: m[1],
        type: m[2],
        sha: m[3],
        size: m[4] === '-' ? null : parseInt(m[4], 10),
        name: m[5],
      });
    }
    entries.sort((a, b) => {
      const ad = a.type === 'tree' ? 0 : 1;
      const bd = b.type === 'tree' ? 0 : 1;
      return ad !== bd ? ad - bd : a.name.localeCompare(b.name);
    });
    return entries;
  }

  async entryType(ref: string, path: string): Promise<string | null> {
    const spec = path ? `${ref}:${path}` : ref;
    try {
      return (await execGit(this.dir, ['cat-file', '-t', spec])).toString('utf8').trim();
    } catch {
      return null;
    }
  }

  async catBlob(ref: string, path: string): Promise<Buffer> {
    return execGit(this.dir, ['cat-file', 'blob', `${ref}:${path}`]);
  }

  async log(ref: string, skip: number, limit: number, path?: string): Promise<CommitSummary[]> {
    const fmt = '%H%x00%an%x00%aI%x00%s';
    const args = ['log', `--format=${fmt}`, '-n', String(limit), `--skip=${skip}`, ref, '--'];
    if (path) args.push(path);
    let ls: string[];
    try {
      ls = await this.lines(args);
    } catch {
      return [];
    }
    return ls.map((l) => {
      const [sha, author, date, subject] = l.split('\0');
      return { sha, author, date, subject: subject ?? '' };
    });
  }

  /**
   * The newest commit touching each of `paths`, keyed by path: what fills the
   * message and age columns of a directory listing. One `git log -1` per path
   * is what git itself would do to answer this, so the work is bounded by
   * running a few at a time and by the caller capping how many paths it asks
   * about. A path with no commit (a submodule gitlink, say) is simply absent
   * from the map.
   */
  async lastCommits(ref: string, paths: string[], concurrency = 8): Promise<Map<string, CommitSummary>> {
    const found = new Map<string, CommitSummary>();
    let next = 0;
    const worker = async () => {
      for (let i = next++; i < paths.length; i = next++) {
        const [commit] = await this.log(ref, 0, 1, paths[i]);
        if (commit) found.set(paths[i], commit);
      }
    };
    await Promise.all(Array.from({ length: Math.min(concurrency, paths.length) }, worker));
    return found;
  }

  async commitCount(ref: string): Promise<number> {
    const out = (await execGit(this.dir, ['rev-list', '--count', ref, '--'])).toString('utf8').trim();
    return parseInt(out, 10);
  }

  async commit(sha: string): Promise<CommitDetail | null> {
    const fmt = '%H%x00%an%x00%ae%x00%aI%x00%P%x00%B';
    let out: string;
    try {
      out = (await execGit(this.dir, ['log', '-1', `--format=${fmt}`, sha, '--'])).toString('utf8');
    } catch {
      return null;
    }
    const [h, an, ae, date, parents, message] = out.split('\0');
    if (!h) return null;
    return {
      sha: h,
      author: an,
      email: ae,
      date,
      parents: parents ? parents.split(' ').filter((p) => p) : [],
      message: (message ?? '').replace(/\n+$/, ''),
    };
  }

  async commitPatch(sha: string): Promise<string> {
    return (await execGit(this.dir, ['show', '--format=', '--patch', '--no-color', sha, '--'])).toString('utf8');
  }

  resolveRefAndPath(rest: string, refNames: string[]): { ref: string; path: string } {
    const sorted = [...refNames].sort((a, b) => b.length - a.length);
    for (const r of sorted) {
      if (rest === r) return { ref: r, path: '' };
      if (rest.startsWith(r + '/')) return { ref: r, path: rest.slice(r.length + 1) };
    }
    const i = rest.indexOf('/');
    if (i === -1) return { ref: rest, path: '' };
    return { ref: rest.slice(0, i), path: rest.slice(i + 1) };
  }
}
