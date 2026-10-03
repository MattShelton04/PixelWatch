import type { HttpTransport, Timing } from "./transport.ts";

/** Trusted report-job context, separate from the authenticated capture source envelope. */
export interface ReportJobIdentity {
  readonly runId: string;
  readonly attempt: number;
  readonly workflowPath: string;
  readonly workflowId?: string;
  readonly headSha: string;
  readonly ref: string;
  readonly runnerName: string;
}
export interface PublicMetadataOptions {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryId: string;
  readonly transport?: HttpTransport;
  readonly timing?: Timing;
}
export type EnvironmentDeploymentState = "waiting" | "queued" | "pending" | "in_progress"
  | "success" | "failure" | "error" | "inactive";
export interface EnvironmentMetadata {
  readonly environmentId: string;
  readonly defaultBranch: string;
}
export interface DeploymentHistory {
  /** Unique authenticated current job. Neither SHA nor a response URL grants this identity. */
  readonly current: {readonly deploymentId: string; readonly jobId: string; readonly states: readonly EnvironmentDeploymentState[]};
  readonly priorDeploymentIds: readonly string[];
  readonly complete: true;
}
/** Public GitHub.com reads only; no credential or arbitrary-destination parameter exists. */
export interface PublicPagesMetadata {
  readEnvironment(defaultBranch: string, signal?: AbortSignal): Promise<EnvironmentMetadata>;
  readDeploymentHistory(defaultBranch: string, report: ReportJobIdentity, signal?: AbortSignal): Promise<DeploymentHistory>;
}
