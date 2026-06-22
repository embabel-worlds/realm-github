import { Entity } from "@embabel/runtime-types";

// ─── Data shapes ────────────────────────────────────────────────────────────

/** The PR representation a write op returns (the slice we read back). */
export interface GitHubPullRequestRecord {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  draft?: boolean;
  merged?: boolean;
  html_url?: string;
  updated_at?: string;
}

/** What `issues/create-comment` returns (PR comments use the issues endpoint). */
export interface GitHubComment {
  id?: number;
  html_url?: string;
  body?: string;
}

/** What `pulls/merge` returns. */
export interface GitHubMergeResult {
  sha?: string;
  merged?: boolean;
  message?: string;
}

/** owner/repo, parsed out of a PR's `html_url`. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * The `gateway.gh` ops the verbs call, typed. A PR IS an issue for state /
 * comments / labels / assignees, so those reuse the `issues_*` ops keyed by the
 * PR number; merge + review requests use the `pulls_*` ops. Names are the
 * OpenAPI operationIds, `/` and `-` → `_` (see README "Namespace").
 */
interface GitHubGateway {
  gh: {
    pulls_merge(args: {
      owner: string;
      repo: string;
      pull_number: number;
      merge_method?: "merge" | "squash" | "rebase";
      commit_title?: string;
      commit_message?: string;
    }): Promise<GitHubMergeResult>;
    pulls_request_reviewers(args: {
      owner: string;
      repo: string;
      pull_number: number;
      reviewers: string[];
    }): Promise<GitHubPullRequestRecord>;
    // Shared with issues — a PR's state/comments/labels/assignees live on the issues endpoint.
    issues_update(args: {
      owner: string;
      repo: string;
      issue_number: number;
      state?: "open" | "closed";
      state_reason?: "completed" | "not_planned" | "reopened";
    }): Promise<GitHubPullRequestRecord>;
    issues_create_comment(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: string;
    }): Promise<GitHubComment>;
    issues_add_labels(args: {
      owner: string;
      repo: string;
      issue_number: number;
      labels: string[];
    }): Promise<unknown>;
    issues_add_assignees(args: {
      owner: string;
      repo: string;
      issue_number: number;
      assignees: string[];
    }): Promise<unknown>;
  };
}

const DAY_MS = 86_400_000;

// ─── The type ───────────────────────────────────────────────────────────────

/**
 * A GitHub pull request materialized on demand by virtual cypher (see
 * `types/github.yml` + `producers/github.yml`). The PR-shaped sibling of
 * `GitHubIssue`: the read brings it in transiently and rolls back; a verb acts
 * on the live source, which the rollback never touches.
 *
 * Two kinds of verb (see specs/VIRTUAL_NODE_METHODS.md):
 *  - **pure** — TS compute over the node's own scalar fields (age, staleness,
 *    draft, ready-to-review), no I/O. Only scalars persist on a virtual node, so
 *    these read `state` / `draft` / `comments` / `created_at` — not `labels` /
 *    `requested_reviewers` (objects/arrays, not stored).
 *  - **effectful** — write back through `this.gateway.gh.*`. State / comment /
 *    labels / assignees reuse the `issues_*` ops (a PR is an issue for those);
 *    `merge` and `requestReviewers` use `pulls_*`. GitHub has no `If-Match`
 *    precondition here, so the verbs are written to be idempotent where the API
 *    allows (closing a closed PR, adding a present label).
 *
 * `owner`/`repo` aren't stored; they're parsed from `html_url` (a verb that
 * can't locate the repo throws rather than guessing). A PR's `html_url` is
 * `.../pull/{n}`, so the parser accepts both `/pull/` and `/issues/`.
 */
export class GitHubPullRequest extends Entity {
  // `id` (the identity key) is inherited from Entity.
  /** PR number within its repo — the ops' `pull_number` / `issue_number`. */
  number!: number;
  title?: string;
  html_url?: string;
  state?: string;
  draft?: boolean;
  created_at?: string;
  updated_at?: string;
  comments?: number;

  private get api(): GitHubGateway {
    return this.gateway as unknown as GitHubGateway;
  }

  // ── pure verbs: compute over node state, no I/O ──

  /** Days since the PR was opened. */
  ageDays(now: number = Date.now()): number {
    return this.created_at ? Math.floor((now - Date.parse(this.created_at)) / DAY_MS) : 0;
  }

  /** Days since the PR was last touched. */
  daysSinceUpdate(now: number = Date.now()): number {
    return this.updated_at ? Math.floor((now - Date.parse(this.updated_at)) / DAY_MS) : 0;
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  /** A work-in-progress PR not yet ready for review. */
  isDraft(): boolean {
    return this.draft === true;
  }

  /** Open and out of draft — a reviewer can act on it now. */
  isReadyForReview(): boolean {
    return this.isOpen() && !this.isDraft();
  }

  /** Open and untouched for `days` (default 14) — a candidate for a nudge. */
  isStale(days = 14, now: number = Date.now()): boolean {
    return this.isOpen() && this.daysSinceUpdate(now) > days;
  }

  /** `owner`/`repo` parsed from `html_url`. Throws if it can't be located. */
  repoRef(): RepoRef {
    const m = this.html_url?.match(/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\//);
    if (!m) throw new Error(`cannot locate owner/repo from html_url: ${this.html_url ?? "(none)"}`);
    return { owner: m[1]!, repo: m[2]! };
  }

  /** Short human ref, e.g. `octocat/hello-world#42`. */
  ref(): string {
    const { owner, repo } = this.repoRef();
    return `${owner}/${repo}#${this.number}`;
  }

  // ── effectful verbs: write back through gateway.gh (the source) ──

  /** Merge the PR. `method` selects merge/squash/rebase (default squash). */
  async merge(args: { method?: "merge" | "squash" | "rebase"; title?: string; message?: string } = {}): Promise<GitHubMergeResult> {
    const { owner, repo } = this.repoRef();
    return this.api.gh.pulls_merge({
      owner,
      repo,
      pull_number: this.number,
      merge_method: args.method ?? "squash",
      commit_title: args.title,
      commit_message: args.message,
    });
  }

  /** Request reviews from GitHub logins (additive). */
  async requestReviewers(...reviewers: string[]): Promise<GitHubPullRequestRecord> {
    const { owner, repo } = this.repoRef();
    return this.api.gh.pulls_request_reviewers({ owner, repo, pull_number: this.number, reviewers });
  }

  /** Close the PR without merging. `reason` records why. Idempotent. */
  async close(reason: "completed" | "not_planned" = "not_planned"): Promise<GitHubPullRequestRecord> {
    const { owner, repo } = this.repoRef();
    return this.api.gh.issues_update({ owner, repo, issue_number: this.number, state: "closed", state_reason: reason });
  }

  /** Reopen the PR. Idempotent. */
  async reopen(): Promise<GitHubPullRequestRecord> {
    const { owner, repo } = this.repoRef();
    return this.api.gh.issues_update({ owner, repo, issue_number: this.number, state: "open", state_reason: "reopened" });
  }

  /** Add a comment (PR comments go through the issues endpoint). */
  async comment(body: string): Promise<GitHubComment> {
    const { owner, repo } = this.repoRef();
    return this.api.gh.issues_create_comment({ owner, repo, issue_number: this.number, body });
  }

  /** Add labels (additive; GitHub ignores ones already present). */
  async addLabels(...labels: string[]): Promise<unknown> {
    const { owner, repo } = this.repoRef();
    return this.api.gh.issues_add_labels({ owner, repo, issue_number: this.number, labels });
  }

  /** Assign GitHub logins (additive; distinct from reviewers). */
  async assign(...assignees: string[]): Promise<unknown> {
    const { owner, repo } = this.repoRef();
    return this.api.gh.issues_add_assignees({ owner, repo, issue_number: this.number, assignees });
  }
}
