"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.GitHubPullRequest = void 0;
const runtime_types_1 = require("@embabel/runtime-types");
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
class GitHubPullRequest extends runtime_types_1.Entity {
    // `id` (the identity key) is inherited from Entity.
    /** PR number within its repo — the ops' `pull_number` / `issue_number`. */
    number;
    title;
    html_url;
    state;
    draft;
    created_at;
    updated_at;
    comments;
    get api() {
        return this.gateway;
    }
    // ── pure verbs: compute over node state, no I/O ──
    /** Days since the PR was opened. */
    ageDays(now = Date.now()) {
        return this.created_at ? Math.floor((now - Date.parse(this.created_at)) / DAY_MS) : 0;
    }
    /** Days since the PR was last touched. */
    daysSinceUpdate(now = Date.now()) {
        return this.updated_at ? Math.floor((now - Date.parse(this.updated_at)) / DAY_MS) : 0;
    }
    isOpen() {
        return this.state === "open";
    }
    /** A work-in-progress PR not yet ready for review. */
    isDraft() {
        return this.draft === true;
    }
    /** Open and out of draft — a reviewer can act on it now. */
    isReadyForReview() {
        return this.isOpen() && !this.isDraft();
    }
    /** Open and untouched for `days` (default 14) — a candidate for a nudge. */
    isStale(days = 14, now = Date.now()) {
        return this.isOpen() && this.daysSinceUpdate(now) > days;
    }
    /** `owner`/`repo` parsed from `html_url`. Throws if it can't be located. */
    repoRef() {
        const m = this.html_url?.match(/github\.com\/([^/]+)\/([^/]+)\/(?:pull|issues)\//);
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
    /** Merge the PR. `method` selects merge/squash/rebase (default squash). */
    async merge(args = {}) {
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
    async requestReviewers(...reviewers) {
        const { owner, repo } = this.repoRef();
        return this.api.gh.pulls_request_reviewers({ owner, repo, pull_number: this.number, reviewers });
    }
    /** Close the PR without merging. `reason` records why. Idempotent. */
    async close(reason = "not_planned") {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_update({ owner, repo, issue_number: this.number, state: "closed", state_reason: reason });
    }
    /** Reopen the PR. Idempotent. */
    async reopen() {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_update({ owner, repo, issue_number: this.number, state: "open", state_reason: "reopened" });
    }
    /** Add a comment (PR comments go through the issues endpoint). */
    async comment(body) {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_create_comment({ owner, repo, issue_number: this.number, body });
    }
    /** Add labels (additive; GitHub ignores ones already present). */
    async addLabels(...labels) {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_add_labels({ owner, repo, issue_number: this.number, labels });
    }
    /** Assign GitHub logins (additive; distinct from reviewers). */
    async assign(...assignees) {
        const { owner, repo } = this.repoRef();
        return this.api.gh.issues_add_assignees({ owner, repo, issue_number: this.number, assignees });
    }
}
exports.GitHubPullRequest = GitHubPullRequest;
