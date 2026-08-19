import { execFile, spawn } from 'child_process';

const MAX_BUFFER = 256 * 1024 * 1024;

export class GitError extends Error {}

export interface ExecGitOptions {
  env?: NodeJS.ProcessEnv;
  input?: Buffer | string;
  /** Kill the command after this many milliseconds. */
  timeoutMs?: number;
}

export function execGit(repoDir: string, args: string[], opts: ExecGitOptions = {}): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = execFile(
      'git',
      ['-C', repoDir, ...args],
      { maxBuffer: MAX_BUFFER, encoding: 'buffer' as BufferEncoding, env: opts.env, timeout: opts.timeoutMs },
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

/** One matching line from a search over the files at a ref. */
export interface SearchHit {
  path: string;
  line: number;
  text: string;
}

/** One line of `git blame` output, with the commit that last touched it. */
export interface BlameLine {
  sha: string;
  author: string;
  date: string;
  summary: string;
  /** The commit and path this line came from before that change, if any. */
  previous: { sha: string; path: string } | null;
  text: string;
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

  async log(
    ref: string,
    skip: number,
    limit: number,
    path?: string,
    author?: string
  ): Promise<CommitSummary[]> {
    const fmt = '%H%x00%an%x00%aI%x00%s';
    const args = ['log', `--format=${fmt}`, '-n', String(limit), `--skip=${skip}`];
    // -F makes --author a literal string rather than a pattern, so a name
    // with a dot or a plus in it means itself.
    if (author) args.push('-F', `--author=${author}`);
    args.push(ref, '--');
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

  async commitCount(ref: string, path?: string, author?: string): Promise<number> {
    const args = ['rev-list', '--count'];
    if (author) args.push('-F', `--author=${author}`);
    args.push(ref, '--');
    if (path) args.push(path);
    const out = (await execGit(this.dir, args)).toString('utf8').trim();
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

  /** Every file at a ref, in git's order. */
  async listPaths(ref: string, limit: number): Promise<{ paths: string[]; truncated: boolean }> {
    const out = (await execGit(this.dir, ['ls-tree', '-r', '--name-only', '-z', ref])).toString('utf8');
    const all = out.split('\0').filter((p) => p !== '');
    return { paths: all.slice(0, limit), truncated: all.length > limit };
  }

  /**
   * Text search over the files at a ref, as `git grep` does it: fixed strings
   * rather than a regular expression, since a search box is not a place to
   * hand a reader's typing to a matcher that can be made to run away, and
   * skipping binary files, which have no lines to show. The query travels as
   * the argument of -e, so a leading dash is a search term and not an option.
   *
   * Both the number of results and the time git may spend are bounded: this
   * is the one read in the interface whose cost the caller cannot predict.
   */
  async search(
    ref: string,
    query: string,
    limit = 200,
    timeoutMs = 10000
  ): Promise<{ hits: SearchHit[]; truncated: boolean }> {
    let out: string;
    try {
      out = (
        await execGit(
          this.dir,
          ['grep', '-I', '-n', '-z', '--fixed-strings', '--ignore-case', '-e', query, ref, '--'],
          { timeoutMs }
        )
      ).toString('utf8');
    } catch {
      // git grep exits non-zero when nothing matched, which is not an error.
      return { hits: [], truncated: false };
    }
    const hits: SearchHit[] = [];
    let truncated = false;
    for (const line of out.split('\n')) {
      if (line === '') continue;
      if (hits.length >= limit) {
        truncated = true;
        break;
      }
      // <rev>:<path>\0<lineno>\0<text>
      const [head, lineNo, ...rest] = line.split('\0');
      if (lineNo === undefined) continue;
      const colon = head.indexOf(':');
      if (colon === -1) continue;
      hits.push({ path: head.slice(colon + 1), line: parseInt(lineNo, 10), text: rest.join('\0') });
    }
    return { hits, truncated };
  }

  /**
   * `git blame` for one file, one entry per line in file order. The porcelain
   * format repeats every header for every line, which costs a little output
   * and saves the parser from carrying state between lines; the caller groups
   * consecutive lines that share a commit.
   */
  async blame(ref: string, path: string): Promise<BlameLine[]> {
    const out = (
      await execGit(this.dir, ['blame', '--line-porcelain', ref, '--', path])
    ).toString('utf8');
    const lines: BlameLine[] = [];
    let cur: Partial<BlameLine> & { time?: number } = {};
    for (const line of out.split('\n')) {
      if (line.startsWith('\t')) {
        // The content line closes an entry: everything before it described it.
        lines.push({
          sha: cur.sha ?? '',
          author: cur.author ?? '',
          date: cur.time ? new Date(cur.time * 1000).toISOString() : '',
          summary: cur.summary ?? '',
          previous: cur.previous ?? null,
          text: line.slice(1),
        });
        cur = {};
        continue;
      }
      const m = line.match(/^([0-9a-f]{40}) \d+ \d+/);
      if (m) {
        cur = { sha: m[1] };
        continue;
      }
      const sp = line.indexOf(' ');
      const key = sp === -1 ? line : line.slice(0, sp);
      const value = sp === -1 ? '' : line.slice(sp + 1);
      if (key === 'author') cur.author = value;
      else if (key === 'author-time') cur.time = parseInt(value, 10);
      else if (key === 'summary') cur.summary = value;
      else if (key === 'previous') {
        const sep = value.indexOf(' ');
        if (sep !== -1) cur.previous = { sha: value.slice(0, sep), path: value.slice(sep + 1) };
      }
    }
    return lines;
  }

  /**
   * Comparing two revisions, the way `git log base..head` and
   * `git diff base...head` do: the commits head has that base does not, and
   * the patch that would bring base up to head. The three-dot diff is taken
   * from the merge base, so a base that has moved on of its own does not show
   * up as changes head made; that is the comparison GitHub shows and the one
   * a reader almost always means.
   */
  async compare(
    base: string,
    head: string,
    limit = 250
  ): Promise<{ ahead: number; behind: number; commits: CommitSummary[]; patch: string; mergeBase: string | null }> {
    const fmt = '%H%x00%an%x00%aI%x00%s';
    const [counts, log, patch, mergeBase] = await Promise.all([
      execGit(this.dir, ['rev-list', '--left-right', '--count', `${base}...${head}`])
        .then((b) => b.toString('utf8').trim().split(/\s+/))
        .catch(() => ['0', '0']),
      execGit(this.dir, ['log', `--format=${fmt}`, '-n', String(limit), `${base}..${head}`, '--'])
        .then((b) => b.toString('utf8'))
        .catch(() => ''),
      execGit(this.dir, ['diff', '--no-color', `${base}...${head}`])
        .then((b) => b.toString('utf8'))
        .catch(() => ''),
      execGit(this.dir, ['merge-base', base, head])
        .then((b) => b.toString('utf8').trim())
        .catch(() => null),
    ]);
    const commits = log
      .split('\n')
      .filter((l) => l !== '')
      .map((l) => {
        const [sha, author, date, subject] = l.split('\0');
        return { sha, author, date, subject: subject ?? '' };
      });
    return {
      behind: parseInt(counts[0], 10) || 0,
      ahead: parseInt(counts[1], 10) || 0,
      commits,
      patch,
      mergeBase: mergeBase || null,
    };
  }

  /**
   * Who has committed here and how much, as `git shortlog -sne` reports it,
   * ordered by commit count. Mail addresses come back so that an avatar and a
   * contact are both available; the interface shows the name.
   */
  async contributors(ref: string): Promise<{ name: string; email: string; commits: number }[]> {
    let out: string;
    try {
      out = (await execGit(this.dir, ['shortlog', '-sne', '--no-merges', ref, '--'])).toString('utf8');
    } catch {
      return [];
    }
    const people: { name: string; email: string; commits: number }[] = [];
    for (const line of out.split('\n')) {
      const m = line.match(/^\s*(\d+)\t(.*?)\s*<([^>]*)>\s*$/);
      if (m) people.push({ commits: parseInt(m[1], 10), name: m[2], email: m[3] });
    }
    return people;
  }

  async commitPatch(sha: string): Promise<string> {
    return (await execGit(this.dir, ['show', '--format=', '--patch', '--no-color', sha, '--'])).toString('utf8');
  }

  /**
   * Stream `git archive` for `ref` into `out`, as GitHub's source downloads
   * do. Streamed rather than buffered because an archive of a large
   * repository has no business sitting in memory, which also means the
   * caller must satisfy itself that the ref exists before the first byte
   * goes out: once the response has begun there is no status code left to
   * change. `prefix` is the directory the archive unpacks into.
   */
  archiveTo(ref: string, format: 'tar.gz' | 'zip', prefix: string, out: NodeJS.WritableStream): Promise<void> {
    return new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', this.dir, 'archive', `--format=${format}`, `--prefix=${prefix}`, ref], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      let stderr = '';
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString();
      });
      child.stdout.on('data', (chunk: Buffer) => {
        if (!out.write(chunk)) {
          child.stdout.pause();
          out.once('drain', () => child.stdout.resume());
        }
      });
      child.on('error', reject);
      child.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new GitError(`git archive failed: ${stderr.trim() || `exit ${code}`}`));
      });
    });
  }

  /** The object a rev names, or null if git does not know it. */
  async resolve(rev: string): Promise<string | null> {
    try {
      return (await execGit(this.dir, ['rev-parse', '--verify', '--end-of-options', `${rev}^{commit}`]))
        .toString('utf8')
        .trim();
    } catch {
      return null;
    }
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
