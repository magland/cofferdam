import * as fs from 'fs';
import { GitRepo, RefInfo } from '../git';
import { runsDir } from './runs';

// Whether to show a repository's Actions tab. Two cheap questions: does the
// repository have any run history on disk, and does its default branch carry
// a workflow file? The second needs git, so the answer is memoized against
// the branch tip: one ls-tree per repository per new commit, not one per page
// view. A vault with no CI in it never grows the tab.

const memo = new Map<string, { sha: string; has: boolean }>();

async function hasWorkflowsAt(repo: GitRepo, sha: string): Promise<boolean> {
  const cached = memo.get(repo.dir);
  if (cached && cached.sha === sha) return cached.has;
  let has = false;
  for (const dir of ['.github/workflows', '.feorge/workflows']) {
    try {
      const entries = await repo.listTree(sha, dir);
      if (entries.some((e) => e.type === 'blob' && /\.(yml|yaml)$/i.test(e.name))) {
        has = true;
        break;
      }
    } catch {
      // no such directory at this commit
    }
  }
  if (memo.size > 2000) memo.clear();
  memo.set(repo.dir, { sha, has });
  return has;
}

export async function hasCiState(
  root: string,
  repo: GitRepo,
  defaultBranch: string | null,
  branches: RefInfo[]
): Promise<boolean> {
  const dir = runsDir(root, repo.collection, repo.name);
  if (dir) {
    try {
      if (fs.statSync(dir).isDirectory()) return true;
    } catch {
      // no runs yet
    }
  }
  const tip = branches.find((b) => b.name === defaultBranch);
  if (!tip) return false;
  return hasWorkflowsAt(repo, tip.sha);
}
