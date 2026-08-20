import { GitRepo } from './git';
import { renderMarkdown } from './markdown';
import { esc, isBinary } from './render';
import { findRepo } from './scan';
import { encPath } from './views';

/**
 * A collection's profile README: the page a collection shows above its
 * repository listing, so that a collection can say what it is rather than
 * leaving a visitor to infer it from the names in the list.
 *
 * Where it comes from is a convention rather than a new place in the vault. A
 * repository named `.cofferdam` in the collection holds it at
 * `profile/README.md`, on the repository's default branch. GitHub reads an
 * organization's profile out of a `.github` repository the same way, and the
 * borrowed shape carries a real advantage: the file is edited, reviewed,
 * diffed, and reverted by everything the forge already does to a file in a
 * repository, and the collection page only reads it.
 *
 * The repository is otherwise ordinary. It appears in the collection's listing
 * like any other, its own README shows on its own page, and push scope over it
 * is what decides who may change the profile.
 */
export const PROFILE_REPO = '.cofferdam';

/** The directory inside PROFILE_REPO the README is read from. */
export const PROFILE_DIR = 'profile';

/** The README names accepted in PROFILE_DIR; the first one in the tree wins. */
const README_RE = /^readme(\.(md|markdown|txt))?$/i;

const MAX_PROFILE_SIZE = 1024 * 1024;

export interface CollectionProfile {
  /** The rendered README, or null when the collection has none. */
  readme: { html: string; name: string; url: string } | null;
  /**
   * Where a viewer who may write one is sent: the in-browser editor at
   * `profile/` when the repository exists, and the new-repository form
   * otherwise. Offered to nobody by the profile itself; the caller decides who
   * sees it.
   */
  addUrl: string;
}

/**
 * Read and render a collection's profile README. Never throws: a collection
 * without the repository, without the file, or with a file that is not text
 * reads as no profile at all, since the collection page is worth serving
 * either way.
 */
export async function collectionProfile(root: string, collection: string): Promise<CollectionProfile> {
  const enc = encodeURIComponent(collection);
  const newRepoUrl = `/new?collection=${enc}&name=${encodeURIComponent(PROFILE_REPO)}`;
  const repo = findRepo(root, collection, PROFILE_REPO);
  if (!repo) return { readme: null, addUrl: newRepoUrl };
  const base = `/${enc}/${encodeURIComponent(PROFILE_REPO)}`;
  let branch: string | null = null;
  try {
    branch = await repo.defaultBranch(await repo.listRefs('heads'));
  } catch {
    branch = null;
  }
  // An empty repository has no branch to read and none to edit on; the editor
  // creates one, and the form's own default is main.
  if (branch === null) return { readme: null, addUrl: `${base}/new/main/${PROFILE_DIR}` };
  const addUrl = `${base}/new/${encPath(branch)}/${PROFILE_DIR}`;
  const readme = await readProfileReadme(repo, branch);
  if (!readme) return { readme: null, addUrl };
  const html = /\.(md|markdown)$/i.test(readme.name) || !readme.name.includes('.')
    ? renderMarkdown(readme.text, {
        rawBase: `${base}/raw/${encPath(branch)}/${PROFILE_DIR}`,
        blobBase: `${base}/blob/${encPath(branch)}/${PROFILE_DIR}`,
        issueBase: `${base}/issues`,
        commitBase: `${base}/commit`,
      })
    : `<pre>${esc(readme.text)}</pre>`;
  return {
    readme: {
      html,
      name: `${PROFILE_DIR}/${readme.name}`,
      url: `${base}/blob/${encPath(branch)}/${PROFILE_DIR}/${encPath(readme.name)}`,
    },
    addUrl,
  };
}

async function readProfileReadme(
  repo: GitRepo,
  branch: string
): Promise<{ name: string; text: string } | null> {
  let entries;
  try {
    entries = await repo.listTree(branch, PROFILE_DIR);
  } catch {
    return null;
  }
  // The name is matched the way a repository's own README is, so that a
  // profile written as README.markdown or readme.txt is not silently ignored.
  const entry = entries.find((e) => e.type === 'blob' && README_RE.test(e.name));
  if (!entry || (entry.size ?? 0) > MAX_PROFILE_SIZE) return null;
  let buf: Buffer;
  try {
    buf = await repo.catBlob(branch, `${PROFILE_DIR}/${entry.name}`);
  } catch {
    return null;
  }
  if (isBinary(buf)) return null;
  const text = buf.toString('utf8');
  // A file with nothing in it is no profile: an empty box above the listing
  // would say less than the listing alone, and the prompt to write one is
  // still worth offering.
  if (text.trim() === '') return null;
  return { name: entry.name, text };
}
