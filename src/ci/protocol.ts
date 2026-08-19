// The wire types of the runner protocol: what the server hands a runner when
// it acquires a job, and what the runner reports back. Both sides of the
// protocol live in this package (src/ci for the server, src/runner for the
// client), so these types are the single definition.

import { Conclusion, StepState } from './runs';
import { WorkflowStep } from './workflow';

export interface JobAddress {
  collection: string;
  repo: string;
  run: number;
  job: string;
}

// Everything a runner needs to execute one job. Step-level expressions
// arrive unevaluated together with the contexts to evaluate them in; the
// runner owns evaluation because step conditions and env depend on the
// outputs of earlier steps, which only the runner sees.
export interface JobSpec {
  address: JobAddress;
  lease: string;
  name: string;
  runsOn: string[];
  sha: string;
  ref: string;
  refName: string;
  workflowName: string;
  workflowPath: string;
  runNumber: number;
  env: Record<string, string>; // workflow env merged under job env, unevaluated
  defaults?: { shell?: string; workingDirectory?: string };
  steps: WorkflowStep[];
  matrix: Record<string, unknown> | null;
  strategy: { failFast: boolean; jobIndex: number; jobTotal: number } | null;
  needs: Record<string, { result: string; outputs: Record<string, string> }>;
  outputsTemplate: Record<string, string>;
  github: Record<string, unknown>; // the github context, built per acquire
  inputs: Record<string, unknown> | null;
  timeoutMinutes: number;
  /**
   * Where this repository's site is served, decided by the vault rather than
   * by the runner: a vault with a sites hostname serves each site at the root
   * of an origin of its own, and the runner cannot know that. Absent from an
   * older vault, which the runner falls back for.
   */
  site?: { url: string; basePath: string };
}

export interface AcquireRequest {
  labels: string[];
}

export interface HeartbeatResponse {
  cancel: boolean;
}

export interface StatusReport {
  lease: string;
  status: 'running' | 'completed';
  conclusion?: Conclusion;
  stepStates?: StepState[];
  outputs?: Record<string, string>;
  summaries?: string[];
}

// One log line as shipped and stored: step index, ISO time, text.
export interface LogLine {
  s: number;
  t: string;
  l: string;
}
