// Parsing the `uses:` value of a step. Four shapes exist:
//
//   actions/checkout@v4                     a repository at a ref
//   flatironinstitute/numbl/.github/actions/build-site@main   a subdirectory of one
//   ./.github/actions/thing                 a directory of the repository being built
//   docker://alpine:3                       a container image
//
// Parsing lives here, on the server side of the tree, rather than in the
// runner: the server does not resolve actions, but knowing what a workflow
// refers to is useful to it (and to any future UI that wants to say so),
// and the syntax is part of the workflow language rather than of execution.

export type ActionRef =
  | { kind: 'repo'; owner: string; repo: string; subpath: string; ref: string; raw: string }
  | { kind: 'local'; path: string; raw: string }
  | { kind: 'docker'; image: string; raw: string };

export class ActionRefError extends Error {}

const NAME = /^[A-Za-z0-9._-]+$/;

// Refs may be branches, tags, or shas, so the character set is git's minus
// the shapes that would let one escape a path when used as a cache key.
const REF = /^[A-Za-z0-9._\-/]+$/;

export function parseActionRef(uses: string): ActionRef {
  const raw = uses.trim();
  if (raw === '') throw new ActionRefError('empty uses:');

  if (raw.startsWith('docker://')) {
    const image = raw.slice('docker://'.length);
    if (image === '' || /\s/.test(image)) throw new ActionRefError(`invalid docker image in uses: ${raw}`);
    return { kind: 'docker', image, raw };
  }

  if (raw.startsWith('./') || raw.startsWith('.\\')) {
    const p = raw.replace(/\\/g, '/').replace(/^\.\//, '');
    if (p === '' || p.split('/').some((seg) => seg === '' || seg === '.' || seg === '..')) {
      throw new ActionRefError(`invalid local action path in uses: ${raw}`);
    }
    return { kind: 'local', path: p, raw };
  }

  const at = raw.lastIndexOf('@');
  if (at === -1) {
    throw new ActionRefError(
      `uses: ${raw} has no version; an action reference needs @ref (for example actions/checkout@v4)`
    );
  }
  const ref = raw.slice(at + 1);
  const pathPart = raw.slice(0, at);
  if (!REF.test(ref) || ref.includes('..')) throw new ActionRefError(`invalid ref in uses: ${raw}`);

  const segs = pathPart.split('/');
  if (segs.length < 2) throw new ActionRefError(`uses: ${raw} is not owner/repo[/path]@ref`);
  const [owner, repo, ...rest] = segs;
  if (!NAME.test(owner) || !NAME.test(repo)) throw new ActionRefError(`invalid owner or repository in uses: ${raw}`);
  if (rest.some((s) => s === '' || s === '.' || s === '..' || !NAME.test(s))) {
    throw new ActionRefError(`invalid path in uses: ${raw}`);
  }
  return { kind: 'repo', owner, repo, subpath: rest.join('/'), ref, raw };
}

// A stable, filesystem-safe key for an action, used both as a cache
// directory name and as the directory the action is copied to inside a job's
// container. Slashes in a ref (release/v1) become a safe separator.
export function actionCacheKey(ref: ActionRef): string {
  if (ref.kind === 'repo') {
    return `${ref.owner}__${ref.repo}__${ref.ref.replace(/\//g, '--')}`;
  }
  if (ref.kind === 'local') return `local__${ref.path.replace(/\//g, '--')}`;
  return `docker__${ref.image.replace(/[^A-Za-z0-9._-]/g, '-')}`;
}

// Whether a ref names an immutable object. A full sha never needs
// re-fetching; a branch does, since it moves.
export function refIsImmutable(ref: ActionRef): boolean {
  return ref.kind === 'repo' && /^[0-9a-f]{40}$/i.test(ref.ref);
}
