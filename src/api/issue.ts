import { Entity } from "@embabel/runtime-types";

// ─── Data shapes ────────────────────────────────────────────────────────────
// Plain records the verbs return. The GitHub write ops echo the updated issue /
// the created comment; these are the slices the methods surface.

/** The GitHub issue representation a write op returns (the slice we read back). */
export interface GitHubIssueRecord {
  id?: number;
  number?: number;
  title?: string;
  state?: string;
  html_url?: string;
  updated_at?: string;
}

/** What `issues/create-comment` returns. */
export interface GitHubComment {
  id?: number;
  html_url?: string;
  body?: string;
}

/** owner/repo, parsed out of an issue's `html_url`. */
export interface RepoRef {
  owner: string;
  repo: string;
}

/**
 * The `gateway.gh` ops the verbs call, typed. The pack types the slice it uses
 * (cf. `Movie`'s `MovieGateway`) so method bodies and return types are fully
 * typed; swap for the generated `GatewayContext` when `embabel-pack sync` lands.
 * Names are the OpenAPI operationIds verbatim, so they are called with brackets:
 * `gh["issues/update"](...)`. A write passes its request body under `body`;
 * every other argument is a path or query parameter (see README "Namespace").
 */
interface GitHubGateway {
  gh: {
    "issues/update"(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: {
        state?: "open" | "closed";
        state_reason?: "completed" | "not_planned" | "reopened";
      };
    }): Promise<GitHubIssueRecord>;
    "issues/create-comment"(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: { body: string };
    }): Promise<GitHubComment>;
    "issues/add-labels"(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: { labels: string[] };
    }): Promise<unknown>;
    "issues/add-assignees"(args: {
      owner: string;
      repo: string;
      issue_number: number;
      body: { assignees: string[] };
    }): Promise<unknown>;
  };
}

const DAY_MS = 86_400_000;

// ─── The type ───────────────────────────────────────────────────────────────

/**
 * A GitHub issue materialized on demand by virtual cypher (see
 * `types/github.yml` + `producers/github.yml`). The read brings the issue in as
 * a transient node and rolls back; a verb acts on the live source, which the
 * rollback never touches.
 *
 * Two kinds of verb (see specs/VIRTUAL_NODE_METHODS.md):
 *  - **pure** — TS compute over the node's own scalar fields (age, staleness,
 *    triage), no I/O. Only scalars persist on a virtual node, so triage is
 *    derived from `state` / `comments` / `created_at`, not from labels (which
 *    arrive as objects and are not stored).
 *  - **effectful** — write back through `this.gateway.gh.*`. GitHub's issue API
 *    is last-write-wins (no If-Match precondition on issues), so these verbs are
 *    written to be idempotent: closing a closed issue, adding a present label,
 *    or assigning a current assignee is a no-op on GitHub's side.
 *
 * `owner`/`repo` aren't stored as fields; they're parsed from `html_url`, which
 * is. A verb that can't locate the repo (malformed/absent url) throws rather
 * than guessing.
 */
export class GitHubIssue extends Entity {
  // `id` (the identity key) is inherited from Entity.
  /** Issue number within its repo — the write ops' `issue_number`. */
  number!: number;
  title?: string;
  html_url?: string;
  state?: string;
  created_at?: string;
  updated_at?: string;
  comments?: number;

  private get api(): GitHubGateway {
    return this.gateway as unknown as GitHubGateway;
  }

  // ── pure verbs: compute over node state, no I/O ──

  /** Days since the issue was opened. */
  ageDays(now: number = Date.now()): number {
    return this.created_at ? Math.floor((now - Date.parse(this.created_at)) / DAY_MS) : 0;
  }

  /** Days since the issue was last touched. */
  daysSinceUpdate(now: number = Date.now()): number {
    return this.updated_at ? Math.floor((now - Date.parse(this.updated_at)) / DAY_MS) : 0;
  }

  isOpen(): boolean {
    return this.state === "open";
  }

  /** Open and untouched for `days` (default 30) — a candidate for a nudge or close. */
  isStale(days = 30, now: number = Date.now()): boolean {
    return this.isOpen() && this.daysSinceUpdate(now) > days;
  }

  /** Open, no comments, and older than `days` (default 7) — nobody has triaged it. */
  needsTriage(days = 7, now: number = Date.now()): boolean {
    return this.isOpen() && (this.comments ?? 0) === 0 && this.ageDays(now) > days;
  }

  /** `owner`/`repo` parsed from `html_url`. Throws if it can't be located. */
  repoRef(): RepoRef {
    const m = this.html_url?.match(/github\.com\/([^/]+)\/([^/]+)\/issues\//);
    if (!m) throw new Error(`cannot locate owner/repo from html_url: ${this.html_url ?? "(none)"}`);
    return { owner: m[1]!, repo: m[2]! };
  }

  /** Short human ref, e.g. `octocat/hello-world#42`. */
  ref(): string {
    const { owner, repo } = this.repoRef();
    return `${owner}/${repo}#${this.number}`;
  }

  // ── effectful verbs: write back through gateway.gh (the source) ──

  /** Close the issue. `reason` records why (GitHub `state_reason`). Idempotent. */
  async close(reason: "completed" | "not_planned" = "completed"): Promise<GitHubIssueRecord> {
    const { owner, repo } = this.repoRef();
    return this.api.gh["issues/update"]({ owner, repo, issue_number: this.number, body: { state: "closed", state_reason: reason } });
  }

  /** Reopen the issue. Idempotent. */
  async reopen(): Promise<GitHubIssueRecord> {
    const { owner, repo } = this.repoRef();
    return this.api.gh["issues/update"]({ owner, repo, issue_number: this.number, body: { state: "open", state_reason: "reopened" } });
  }

  /** Add a comment. */
  async comment(body: string): Promise<GitHubComment> {
    const { owner, repo } = this.repoRef();
    return this.api.gh["issues/create-comment"]({ owner, repo, issue_number: this.number, body: { body } });
  }

  /** Add labels (additive; GitHub ignores ones already present). Refuses an empty list. */
  async addLabels(...labels: string[]): Promise<unknown> {
    if (labels.length === 0) throw new Error("addLabels needs at least one label");
    const { owner, repo } = this.repoRef();
    return this.api.gh["issues/add-labels"]({ owner, repo, issue_number: this.number, body: { labels } });
  }

  /** Assign GitHub logins (additive; GitHub ignores ones already assigned). */
  async assign(...assignees: string[]): Promise<unknown> {
    const { owner, repo } = this.repoRef();
    return this.api.gh["issues/add-assignees"]({ owner, repo, issue_number: this.number, body: { assignees } });
  }
}
