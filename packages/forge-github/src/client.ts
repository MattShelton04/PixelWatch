import { parseDocument, parseJson, type Config, type JsonObject, type JsonValue } from "@pixelwatch/schemas";
import { ForgeError, LIMITS } from "./errors.ts";
import { FetchTransport, RealTiming, type HttpRequest, type HttpResponse, type HttpTransport, type Timing } from "./transport.ts";
import { verifySource, type VerifiedSource, type VerifySourceInput } from "./source.ts";

const API_ORIGIN = "https://api.github.com";
const encoder = new TextEncoder();
const REDIRECTS = new Set([301, 302, 303, 307, 308]);
const header = (response: HttpResponse, key: string): string | undefined => {
  const values = Object.entries(response.headers).filter(([name]) => name.toLowerCase() === key);
  if (values.length > 1) throw new ForgeError("invalid-response");
  return values[0]?.[1];
};
const object = (value: JsonValue | undefined): JsonObject => {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new ForgeError("invalid-response");
  return value;
};
const integer = (value: JsonValue | undefined, minimum = 0): number => {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum) throw new ForgeError("invalid-response");
  return value;
};
const id = (value: JsonValue | undefined): string => String(integer(value, 1));
const trustedId = (value: string): string => {
  if (!/^[1-9][0-9]{0,18}$/.test(value) || !Number.isSafeInteger(Number(value))) throw new ForgeError("invalid-identity");
  return value;
};
const text = (value: JsonValue | undefined, maxBytes = 1024): string => {
  if (typeof value !== "string" || !value.isWellFormed() || encoder.encode(value).byteLength > maxBytes) throw new ForgeError("invalid-response");
  return value;
};
const parse = (response: HttpResponse): JsonValue => {
  try { return parseJson(response.body, { maxBytes: LIMITS.maxJsonBytes, maxDepth: 32 }); }
  catch { throw new ForgeError("invalid-response"); }
};

export interface ArtifactDescriptor {
  readonly artifactId: string;
  readonly artifactName: string;
  readonly sizeBytes: number;
  readonly expired: boolean;
}
export interface DownloadedArtifact { readonly artifactId: string; readonly artifactName: string; readonly zip: Uint8Array }
export interface MissingArtifact { readonly artifactId: string; readonly artifactName: string; readonly reason: "expired" | "unavailable" | "retry-exhausted" }
export interface DownloadResult { readonly artifacts: readonly DownloadedArtifact[]; readonly missing: readonly MissingArtifact[] }
export interface BotComment { readonly commentId: string; readonly body: string }
export interface CommentInput {
  readonly prNumber: string;
  readonly botId: string;
  readonly body: string;
  readonly beforeMutation: (existing: BotComment | null) => Promise<boolean>;
  readonly signal?: AbortSignal;
}
export type CommentResult =
  | { readonly status: "unchanged" | "created" | "updated" | "recovered"; readonly commentId: string }
  | { readonly status: "deferred" };
export interface PullRequestMetadata { readonly prNumber: string; readonly state: "open" | "closed"; readonly headSha: string; readonly headRepositoryId: string | null }
export interface PagesMetadata { readonly url: string; readonly customDomain: string | null }
export interface RepositoryMetadata { readonly repositoryId: string; readonly owner: string; readonly name: string; readonly defaultBranch: string }
export interface DefaultConfig { readonly repository: RepositoryMetadata; readonly config: Config; readonly configSha: string }
export interface GitHubClientOptions {
  readonly owner: string;
  readonly repo: string;
  readonly repositoryId: string;
  readonly token: string;
  readonly transport?: HttpTransport;
  readonly timing?: Timing;
}

/** Trusted destination construction is independent of all artifact content. */
export class GitHubClient {
  readonly #prefix: string;
  readonly #owner: string;
  readonly #repo: string;
  readonly #repositoryId: string;
  readonly #token: string;
  readonly #transport: HttpTransport;
  readonly #timing: Timing;
  readonly #listed = new WeakMap<ArtifactDescriptor, string>();

  constructor(options: GitHubClientOptions) {
    if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?$/.test(options.owner)
      || !/^[A-Za-z0-9_.-]{1,100}$/.test(options.repo) || options.repo === "." || options.repo === ".."
      || !/^[\x21-\x7e]{1,1024}$/.test(options.token)) throw new ForgeError("invalid-identity");
    this.#repositoryId = trustedId(options.repositoryId);
    this.#owner = options.owner;
    this.#repo = options.repo;
    this.#prefix = `${API_ORIGIN}/repos/${options.owner}/${options.repo}`;
    this.#token = options.token;
    this.#transport = options.transport ?? new FetchTransport();
    this.#timing = options.timing ?? new RealTiming();
  }

  async #request(request: Omit<HttpRequest, "signal">, signal?: AbortSignal): Promise<HttpResponse> {
    const deadline = this.#timing.deadline(LIMITS.requestMs);
    const combined = signal === undefined ? deadline.signal : AbortSignal.any([signal, deadline.signal]);
    let aborted: (() => void) | undefined;
    try {
      if (combined.aborted) throw new ForgeError("request-cancelled");
      const response = await Promise.race([
        Promise.resolve().then(() => this.#transport.request({ ...request, signal: combined })),
        new Promise<never>((_resolve, reject) => {
          aborted = () => { reject(new ForgeError("request-cancelled")); };
          combined.addEventListener("abort", aborted, { once: true });
        }),
      ]);
      if (!Number.isInteger(response.status) || response.status < 100 || response.status > 599 || !(response.body instanceof Uint8Array)) throw new ForgeError("invalid-response");
      if (response.body.byteLength > request.maxBytes) throw new ForgeError("response-too-large");
      return response;
    } catch (error) {
      if (error instanceof ForgeError) throw error;
      throw new ForgeError(combined.aborted ? "request-cancelled" : "request-failed");
    } finally {
      if (aborted !== undefined) combined.removeEventListener("abort", aborted);
      deadline.dispose();
    }
  }

  #headers(authorized = true): Record<string, string> {
    return { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", ...(authorized ? { authorization: `Bearer ${this.#token}` } : {}) };
  }

  #retryDelay(response: HttpResponse, attempt: number): number | null {
    if (response.status >= 500) return 1000 * (attempt + 1);
    const retryAfter = header(response, "retry-after");
    if (response.status !== 429 && !(response.status === 403 && (retryAfter !== undefined || header(response, "x-ratelimit-remaining") === "0"))) return null;
    if (retryAfter === undefined) return 1000 * (attempt + 1);
    if (!/^(0|[1-9][0-9]*)$/.test(retryAfter) || !Number.isSafeInteger(Number(retryAfter)) || Number(retryAfter) > LIMITS.maxRetryDelayMs / 1000) throw new ForgeError("invalid-response");
    return Number(retryAfter) * 1000;
  }

  async #delay(ms: number, signal?: AbortSignal): Promise<void> {
    try { await this.#timing.delay(ms, signal); }
    catch { throw new ForgeError("request-cancelled"); }
  }

  async #get(path: string, signal?: AbortSignal, accept = "application/vnd.github+json"): Promise<HttpResponse> {
    for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt++) {
      let response: HttpResponse;
      try { response = await this.#request({ method: "GET", url: `${this.#prefix}${path}`, headers: { ...this.#headers(), accept }, maxBytes: LIMITS.maxJsonBytes }, signal); }
      catch (error) {
        if (!(error instanceof ForgeError) || error.code !== "request-failed") throw error;
        if (attempt + 1 === LIMITS.maxAttempts) break;
        await this.#delay(1000 * (attempt + 1), signal); continue;
      }
      const delay = this.#retryDelay(response, attempt);
      if (delay === null) return response;
      if (attempt + 1 < LIMITS.maxAttempts) await this.#delay(delay, signal);
    }
    throw new ForgeError("retry-exhausted");
  }

  /** Metadata is always fetched fresh and cannot change this client's trusted API namespace. */
  async getRepository(signal?: AbortSignal): Promise<RepositoryMetadata> {
    const response = await this.#get("", signal);
    if (response.status !== 200) throw new ForgeError("api-refused");
    const value = object(parse(response));
    const owner = text(object(value["owner"])["login"]);
    const name = text(value["name"]);
    const fullName = text(value["full_name"]);
    const branch = text(value["default_branch"]);
    // GitHub owner/repository names are case insensitive. Return only constructor-owned
    // namespace values; API strings and URLs never become destinations.
    if (id(value["id"]) !== this.#repositoryId || owner.toLowerCase() !== this.#owner.toLowerCase()
      || name.toLowerCase() !== this.#repo.toLowerCase() || fullName.toLowerCase() !== `${this.#owner}/${this.#repo}`.toLowerCase()
      || !/^[A-Za-z0-9_-][A-Za-z0-9._/-]{0,127}$/.test(branch) || branch.startsWith("refs/") || branch.includes("..")
      || branch.split("/").some((part) => part === "" || part.startsWith(".") || part.endsWith(".") || part.endsWith(".lock"))) throw new ForgeError("invalid-response");
    return { repositoryId: this.#repositoryId, owner: this.#owner, name: this.#repo, defaultBranch: branch };
  }

  /** Read policy bytes at one authenticated default-branch commit, without a checkout. */
  async readDefaultConfig(signal?: AbortSignal): Promise<DefaultConfig> {
    const repository = await this.getRepository(signal);
    const reference = await this.#get(`/git/ref/heads/${repository.defaultBranch.split("/").map(encodeURIComponent).join("/")}`, signal);
    if (reference.status !== 200) throw new ForgeError("api-refused");
    const value = object(parse(reference));
    const target = object(value["object"]);
    const configSha = text(target["sha"]);
    if (value["ref"] !== `refs/heads/${repository.defaultBranch}` || target["type"] !== "commit" || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(configSha)) throw new ForgeError("invalid-response");
    // Contents raw media avoids base64/JSON overhead and never follows download_url or
    // ref.object.url. This captured OID stays fixed even if the default branch moves.
    const response = await this.#get(`/contents/.pixelwatch/config.json?ref=${configSha}`, signal, "application/vnd.github.raw+json");
    if (response.status !== 200) throw new ForgeError("invalid-config");
    const parsed = parseDocument("config", response.body, { maxBytes: LIMITS.maxJsonBytes, maxDepth: 32 });
    if (!parsed.ok) throw new ForgeError(parsed.issue.code === "unsupported-version" ? "unsupported-config-version" : "invalid-config");
    return { repository, config: parsed.value, configSha };
  }

  async verifySource(input: VerifySourceInput): Promise<VerifiedSource> {
    return verifySource({ repositoryId: this.#repositoryId, namespace: `${this.#owner}/${this.#repo}`, read: async (path, signal) => {
      const response = await this.#get(path, signal);
      if (response.status !== 200) throw new ForgeError("api-refused");
      return parse(response);
    }, lookup: async (path, signal) => {
      const response = await this.#get(path, signal);
      if (response.status === 404) return { status: "not-found" };
      if (response.status !== 200) throw new ForgeError("api-refused");
      return { status: "found", value: parse(response) };
    } }, input);
  }

  async listArtifacts(runId: string, signal?: AbortSignal): Promise<readonly ArtifactDescriptor[]> {
    trustedId(runId);
    const found: ArtifactDescriptor[] = [];
    const seen = new Set<string>();
    let total: number | undefined;
    for (let page = 1; page <= Math.ceil(LIMITS.maxArtifacts / 100); page++) {
      const response = await this.#get(`/actions/runs/${runId}/artifacts?per_page=100&page=${String(page)}`, signal);
      if (response.status !== 200) throw new ForgeError("api-refused");
      const value = object(parse(response));
      const count = integer(value["total_count"]);
      const items = value["artifacts"];
      if (count > LIMITS.maxArtifacts || (total !== undefined && count !== total) || !Array.isArray(items) || items.length > 100) throw new ForgeError("invalid-response");
      total = count;
      for (const item of items) {
        const entry = object(item);
        const artifactId = id(entry["id"]);
        if (seen.has(artifactId) || typeof entry["expired"] !== "boolean") throw new ForgeError("invalid-response");
        seen.add(artifactId);
        const descriptor = Object.freeze({ artifactId, artifactName: text(entry["name"]), sizeBytes: integer(entry["size_in_bytes"]), expired: entry["expired"] });
        this.#listed.set(descriptor, runId);
        found.push(descriptor);
      }
      if (found.length > total) throw new ForgeError("invalid-response");
      if (found.length === total) return Object.freeze(found);
      if (items.length === 0) throw new ForgeError("invalid-response");
    }
    throw new ForgeError("pagination-limit");
  }

  async downloadArtifacts(selected: readonly ArtifactDescriptor[], signal?: AbortSignal): Promise<DownloadResult> {
    const selection = [...selected];
    const seen = new Set<string>();
    let declared = 0;
    let sourceRun: string | undefined;
    if (selection.length > LIMITS.maxArtifacts) throw new ForgeError("artifact-budget");
    for (const descriptor of selection) {
      const runId = this.#listed.get(descriptor);
      if (runId === undefined || (sourceRun !== undefined && runId !== sourceRun) || seen.has(descriptor.artifactId)) throw new ForgeError("artifact-not-listed");
      sourceRun = runId;
      seen.add(descriptor.artifactId);
      if (descriptor.sizeBytes > LIMITS.maxArtifactBytes || descriptor.sizeBytes > LIMITS.maxAttemptBytes - declared) throw new ForgeError("artifact-budget");
      declared += descriptor.sizeBytes;
    }
    const artifacts: DownloadedArtifact[] = [];
    const missing: MissingArtifact[] = [];
    for (const descriptor of selection) {
      const identity = { artifactId: descriptor.artifactId, artifactName: descriptor.artifactName };
      if (descriptor.expired) { missing.push({ ...identity, reason: "expired" }); continue; }
      const outcome = await this.#download(descriptor, signal);
      if (typeof outcome === "string") missing.push({ ...identity, reason: outcome });
      else artifacts.push({ ...identity, zip: outcome });
    }
    return { artifacts, missing };
  }

  async #download(descriptor: ArtifactDescriptor, signal?: AbortSignal): Promise<Uint8Array | "unavailable" | "retry-exhausted"> {
    let authorized = true;
    let redirects = 0;
    let url = `${this.#prefix}/actions/artifacts/${descriptor.artifactId}/zip`;
    for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt++) {
      for (;;) {
        let response: HttpResponse;
        try { response = await this.#request({ method: "GET", url, headers: this.#headers(authorized), maxBytes: LIMITS.maxArtifactBytes }, signal); }
        catch (error) {
          if (!(error instanceof ForgeError) || error.code !== "request-failed") throw error;
          if (attempt + 1 < LIMITS.maxAttempts) await this.#delay(1000 * (attempt + 1), signal);
          break;
        }
        if (REDIRECTS.has(response.status)) {
          if (redirects >= LIMITS.maxRedirects) throw new ForgeError("redirect-limit");
          const location = header(response, "location");
          let next: URL;
          try {
            if (location === undefined || /[^\x21-\x7e]|\\/.test(location)) throw new ForgeError("invalid-redirect");
            next = new URL(location, url);
            if (next.protocol !== "https:" || next.username !== "" || next.password !== "" || next.hash !== "" || next.port !== "") throw new ForgeError("invalid-redirect");
          } catch { throw new ForgeError("invalid-redirect"); }
          if (next.origin !== new URL(url).origin) authorized = false;
          url = next.href;
          redirects++;
          continue;
        }
        if (response.status === 200) {
          if (response.body.byteLength > descriptor.sizeBytes) throw new ForgeError("response-too-large");
          return response.body;
        }
        if (response.status === 404 || response.status === 410) return "unavailable";
        const delay = this.#retryDelay(response, attempt);
        if (delay === null) throw new ForgeError("api-refused");
        if (attempt + 1 < LIMITS.maxAttempts) await this.#delay(delay, signal);
        break;
      }
    }
    return "retry-exhausted";
  }

  #marker(): string { return `<!-- pixelwatch:repo:${this.#repositoryId} -->`; }

  #comment(value: JsonValue): { readonly id: string; readonly body: string; readonly author: string } {
    const entry = object(value);
    return { id: id(entry["id"]), body: text(entry["body"], LIMITS.maxJsonBytes), author: id(object(entry["user"])["id"]) };
  }

  async discoverComment(prNumber: string, botId: string, signal?: AbortSignal): Promise<BotComment | null> {
    trustedId(prNumber); trustedId(botId);
    let found: BotComment | null = null;
    let count = 0;
    const seen = new Set<string>();
    for (let page = 1; page <= Math.ceil(LIMITS.maxComments / 100); page++) {
      const response = await this.#get(`/issues/${prNumber}/comments?per_page=100&page=${String(page)}`, signal);
      if (response.status !== 200) throw new ForgeError("api-refused");
      const entries = parse(response);
      if (!Array.isArray(entries) || entries.length > 100 || count + entries.length > LIMITS.maxComments) throw new ForgeError("invalid-response");
      count += entries.length;
      for (const value of entries) {
        const entry = this.#comment(value);
        if (seen.has(entry.id)) throw new ForgeError("invalid-response");
        seen.add(entry.id);
        if (entry.author === botId && entry.body.includes(this.#marker())) {
          if (found !== null) throw new ForgeError("comment-ambiguous");
          found = { commentId: entry.id, body: entry.body };
        }
      }
      if (entries.length < 100) return found;
    }
    throw new ForgeError("pagination-limit");
  }

  /** Publisher must separately hold the projection lock and recheck head/order/readiness. */
  async reconcileComment(callerInput: CommentInput): Promise<CommentResult> {
    const input: CommentInput = { ...callerInput };
    trustedId(input.prNumber); trustedId(input.botId);
    if (typeof input.beforeMutation !== "function") throw new ForgeError("comment-guard-failed");
    if (!input.body.isWellFormed() || encoder.encode(input.body).byteLength > LIMITS.maxCommentBytes || !input.body.includes(this.#marker())) throw new ForgeError("comment-body");
    let existing = await this.discoverComment(input.prNumber, input.botId, input.signal);
    const originalId = existing?.commentId;
    if (existing?.body === input.body) return { status: "unchanged", commentId: existing.commentId };
    const body = encoder.encode(JSON.stringify({ body: input.body }));
    for (let attempt = 0; attempt < LIMITS.maxAttempts; attempt++) {
      // This callback rechecks publisher-owned head/order/readiness immediately before each
      // mutation, including retries. It cannot be omitted or implicitly defaulted to true.
      let permitted: unknown;
      try { permitted = await input.beforeMutation(existing === null ? null : Object.freeze({ ...existing })); }
      catch { throw new ForgeError("comment-guard-failed"); }
      if (typeof permitted !== "boolean") throw new ForgeError("comment-guard-failed");
      if (!permitted) return { status: "deferred" };
      let response: HttpResponse | undefined;
      try {
        response = await this.#request({
          method: existing === null ? "POST" : "PATCH",
          url: existing === null ? `${this.#prefix}/issues/${input.prNumber}/comments` : `${this.#prefix}/issues/comments/${existing.commentId}`,
          headers: { ...this.#headers(), "content-type": "application/json" }, body, maxBytes: LIMITS.maxJsonBytes,
        }, input.signal);
      } catch (error) {
        if (!(error instanceof ForgeError) || (error.code !== "request-failed" && error.code !== "request-cancelled")) throw error;
        if (input.signal?.aborted === true) throw new ForgeError("request-cancelled");
      }
      if (response !== undefined && (response.status === 200 || response.status === 201)) {
        const written = this.#comment(parse(response));
        if (written.author !== input.botId || written.body !== input.body || (existing !== null && written.id !== existing.commentId)) throw new ForgeError("comment-outcome");
        return { status: existing === null ? "created" : "updated", commentId: written.id };
      }
      let delay = 1000 * (attempt + 1);
      if (response !== undefined) {
        const retry = this.#retryDelay(response, attempt);
        if (retry === null) throw new ForgeError("api-refused");
        delay = retry;
      }
      // Backoff happens before the final owned-comment read and eligibility guard. A comment
      // or PR can change during the delay; a read before sleeping is not a retry authorization.
      if (attempt + 1 < LIMITS.maxAttempts) await this.#delay(delay, input.signal);
      const rediscovered = await this.discoverComment(input.prNumber, input.botId, input.signal);
      if (rediscovered?.body === input.body && (originalId === undefined || rediscovered.commentId === originalId)) return { status: "recovered", commentId: rediscovered.commentId };
      if ((originalId !== undefined && (rediscovered?.commentId !== originalId || rediscovered.body !== existing?.body)) || (originalId === undefined && rediscovered !== null)) throw new ForgeError("comment-outcome");
      existing = rediscovered;
    }
    throw new ForgeError("comment-outcome");
  }

  async getPullRequest(prNumber: string, signal?: AbortSignal): Promise<PullRequestMetadata> {
    trustedId(prNumber);
    const response = await this.#get(`/pulls/${prNumber}`, signal);
    if (response.status !== 200) throw new ForgeError("api-refused");
    const value = object(parse(response));
    const head = object(value["head"]);
    const sha = text(head["sha"]);
    const state = value["state"];
    if (id(value["number"]) !== prNumber || id(object(object(value["base"])["repo"])["id"]) !== this.#repositoryId || !/^[0-9a-f]{40}$/.test(sha) || (state !== "open" && state !== "closed")) throw new ForgeError("invalid-response");
    return { prNumber, state, headSha: sha, headRepositoryId: head["repo"] === null ? null : id(object(head["repo"])["id"]) };
  }

  async getPages(signal?: AbortSignal): Promise<PagesMetadata | null> {
    const response = await this.#get("/pages", signal);
    if (response.status === 404) return null;
    if (response.status !== 200) throw new ForgeError("api-refused");
    try {
      const value = object(parse(response));
      const raw = text(value["html_url"]);
      const cname = value["cname"] === null ? null : text(value["cname"]);
      if (value["build_type"] !== "workflow" || /[^\x21-\x7e]|[\\%]/.test(raw)) throw new ForgeError("pages-metadata");
      const url = new URL(raw);
      const expected = cname ?? `${this.#owner.toLowerCase()}.github.io`;
      if (!/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(expected) || expected.includes("..") || !expected.includes(".") || url.protocol !== "https:" || url.hostname !== expected || url.port !== "" || url.username !== "" || url.password !== "" || url.search !== "" || url.hash !== "" || url.href !== raw || !url.pathname.endsWith("/")) throw new ForgeError("pages-metadata");
      const path = this.#repo.toLowerCase() === `${this.#owner.toLowerCase()}.github.io` || cname !== null ? "/" : `/${this.#repo}/`;
      if (url.pathname !== path) throw new ForgeError("pages-metadata");
      return { url: raw, customDomain: cname };
    } catch { throw new ForgeError("pages-metadata"); }
  }
}
