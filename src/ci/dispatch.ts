import { GitRepo, isValidRefName } from '../git';
import { OpError } from '../ops';
import { CiEngine } from './engine';
import { RunRecord } from './runs';

// Dispatching a workflow by hand: the sequence between "a caller named a
// workflow and a ref" and engine.handleDispatch, which wants a ref, a sha, and
// the inputs already sorted out.
//
// It lived inside the web form's POST handler, which meant the browser was the
// only place that could do it correctly. Both transports call this now, so
// there is one answer to what a dispatch validates.

export interface DispatchRequest {
  workflow: string;
  /** A branch name. Empty means the repository's default branch. */
  ref: string;
  inputs: Record<string, unknown>;
}

/**
 * Plan a workflow_dispatch run, or throw OpError saying why not.
 *
 * The ref must be a branch this repository has: a dispatch runs a workflow file
 * at a commit, and a ref that is not there has no commit to run at. The caller
 * supplies the branches because it has already listed them.
 */
export async function dispatchWorkflow(
  engine: CiEngine,
  repo: GitRepo,
  branches: { name: string; sha: string }[],
  defaultBranch: string | null,
  actor: string,
  request: DispatchRequest
): Promise<RunRecord> {
  const ref = request.ref || defaultBranch || '';
  if (!isValidRefName(ref) || ref.startsWith('-')) throw new OpError('that is not a usable branch name');
  const branch = branches.find((b) => b.name === ref);
  if (!branch) throw new OpError(`branch ${ref} not found`, 'notfound');
  if (request.workflow.trim() === '') throw new OpError('name the workflow to run');
  try {
    return await engine.handleDispatch(
      repo,
      request.workflow,
      `refs/heads/${ref}`,
      branch.sha,
      actor,
      request.inputs
    );
  } catch (e) {
    // WorkflowError and anything else the engine raises are the caller's
    // problem to be told about, not a server fault.
    throw new OpError(e instanceof Error ? e.message : String(e));
  }
}
