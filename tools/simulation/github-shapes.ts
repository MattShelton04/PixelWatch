// Hand-written subsets of GitHub's official REST response schemas. See ADR 0015 sources.
// Keep REST numeric IDs here; forge-github will validate and convert them to contract strings.
export interface GitHubRepository { id: number; name: string; full_name: string; default_branch?: string }
export interface GitHubUser { id: number; login: string; type: string }
export interface GitHubPullRequest {
  id: number; number: number; state: "open" | "closed";
  head: { sha: string; ref: string; repo: GitHubRepository | null };
  base: { sha: string; ref: string; repo: GitHubRepository };
}
export interface GitHubRun {
  id: number; workflow_id: number; run_attempt: number; event: string;
  head_sha: string; head_branch: string | null; status: string; conclusion: string | null;
  created_at: string; repository: GitHubRepository;
  pull_requests: { id: number; number: number; head: { sha: string; ref: string }; base: { sha: string; ref: string } }[];
}
export interface GitHubWorkflow { id: number; name: string; path: string; state: string }
export interface GitHubArtifact {
  id: number; name: string; size_in_bytes: number; expired: boolean;
  created_at: string; expires_at: string; archive_download_url: string;
}
export interface GitHubArtifacts { total_count: number; artifacts: GitHubArtifact[] }
export interface GitHubComment { id: number; body: string; user: GitHubUser; created_at: string; updated_at: string }
export interface GitHubPages { html_url: string; status: string | null; build_type: "workflow" | "legacy" }
export interface GitHubPagesDeployment { id: string; page_url: string; status_url: string }
export interface GitHubApiError { message: string; documentation_url?: string }
export type GitHubBody = GitHubRun | GitHubWorkflow | GitHubPullRequest | GitHubPullRequest[] |
  GitHubArtifacts | GitHubArtifact | GitHubComment | GitHubComment[] | GitHubPages |
  GitHubPagesDeployment | GitHubApiError | Uint8Array;
