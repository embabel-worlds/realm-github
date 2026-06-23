"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubIssue = void 0;
const runtime_types_1 = require("@embabel/runtime-types");
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
class GitHubIssue extends runtime_types_1.Entity {
    // `id` (the identity key) is inherited from Entity.
    /** Issue number within its repo — the write ops' `issue_number`. */
    number;
    title;
    html_url;
    state;
    created_at;
    updated_at;
    comments;
    get api() {
        return this.gateway;
    }
    // ── pure verbs: compute over node state, no I/O ──
    /** Days since the issue was opened. */
    ageDays(now = Date.now()) {
        return this.created_at ? Math.floor((now - Date.parse(this.created_at)) / DAY_MS) : 0;
    }
    /** Days since the issue was last touched. */
    daysSinceUpdate(now = Date.now()) {
        return this.updated_at ? Math.floor((now - Date.parse(this.updated_at)) / DAY_MS) : 0;
    }
    isOpen() {
        return this.state === "open";
    }
    /** Open and untouched for `days` (default 30) — a candidate for a nudge or close. */
    isStale(days = 30, now = Date.now()) {
        return this.isOpen() && this.daysSinceUpdate(now) > days;
    }
    /** Open, no comments, and older than `days` (default 7) — nobody has triaged it. */
    needsTriage(days = 7, now = Date.now()) {
        return this.isOpen() && (this.comments ?? 0) === 0 && this.ageDays(now) > days;
    }
    /** `owner`/`repo` parsed from `html_url`. Throws if it can't be located. */
    repoRef() {
        const m = this.html_url?.match(/github\.com\/([^/]+)\/([^/]+)\/issues\//);
        if (!m)
            throw new Error(`cannot locate owner/repo from html_url: ${this.html_url ?? "(none)"}`);
        return { owner: m[1], repo: m[2] };
    }
    /** Short human ref, e.g. `octocat/hello-world#42`. */
    ref() {
        const { owner, repo } = this.repoRef();
        return `${owner}/${repo}#${this.number}`;
    }
    // ── effectful verbs: write back through gateway.gh (the source) ──
    /** Close the issue. `reason` records why (GitHub `state_reason`). Idempotent. */
    async close(reason = "completed") {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_update({ owner, repo, issue_number: this.number, state: "closed", state_reason: reason });
    }
    /** Reopen the issue. Idempotent. */
    async reopen() {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_update({ owner, repo, issue_number: this.number, state: "open", state_reason: "reopened" });
    }
    /** Add a comment. */
    async comment(body) {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_create_comment({ owner, repo, issue_number: this.number, body });
    }
    /** Add labels (additive; GitHub ignores ones already present). */
    async addLabels(...labels) {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_add_labels({ owner, repo, issue_number: this.number, labels });
    }
    /** Assign GitHub logins (additive; GitHub ignores ones already assigned). */
    async assign(...assignees) {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_add_assignees({ owner, repo, issue_number: this.number, assignees });
    }
}
exports.GitHubIssue = GitHubIssue;
