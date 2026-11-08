---
name: github-workflows
description: GitHub — issues, pull requests, repos, commits, releases, users, orgs. Activate BEFORE any GitHub call; it returns the namespaces and rules to follow.
---

# GitHub Workflows

## Namespaces

Calls go through `gateway.<ns>.<method>(args)` from inside `execute_javascript`
or `execute_python`. Never call them as top-level tools.

| Namespace | Notes |
|---|---|
| `gateway.gh.*` | OpenAPI-typed. Methods are **camelCase** (`issuesListForRepo`, `usersGetByUsername`). TYPED API SURFACE has the exact shapes; full file at `/world/interfaces.ts`. |

**Naming**: method is camelCase, args are snake_case (`per_page`, `issue_number`, `pull_number`, `q`).
If a call returns `gateway.gh.foo is not a world tool`, the error lists every valid method — pick from it. Never re-send the same call.

## Authorship questions go to the views, not the API

"What share of comments are machine-written", "pull requests by agents versus people", "do
assisted PRs draw more review", "how big are the agents' commits", "which files change most"
are ANSWERED views, not things to page out of `gateway.gh` by hand: run `GitHubAuthorship`,
`GitHubChangeRequestsByAuthorKind`, `GitHubReviewBurden`, `GitHubCommitSize` or
`GitHubFileHotspots` (`views/vocabulary.yml`) with `repo: owner/repo`; "what was the PR merge rate last
week / this month / this quarter / this year, and how much of the volume was people versus machines" is
`GitHubChangeRequestThroughput` with `period: week|month|quarter|year` and a `since` on the period's first
day (its rate is merged ÷ resolved; the page `apps/ship-rate.html` shows it for repositories side by side); and for "does this comment read as
written by a person or a machine" `GitHubCommentReadsAs` or the agreement matrix `GitHubCommentProvenance`.
"How big are the PRs, how much of each was tests or docs, what languages did they touch" is
`GitHubChangeRequestSize` (per PR) and `GitHubChangeRequestSizeByAuthorKind`; "what were the PRs about, how
many were fixes, which area did the agents work on" is the judged `GitHubChangeRequestConcern` and its matrix
`GitHubChangeRequestConcernMix`; "what languages is the repo in, is it Spring Boot or Node, what build tool"
is `GitHubRepositoryLanguages` and `GitHubRepositoryProfile`; "who is committing and what do we know about
them" is `GitHubCommitAuthors`, which reads the world's Person spine beside the commits.
Every view takes `since` (pushed to GitHub) and `until` (applied in the graph); every figure they return
was reconciled against GitHub's API by `tests/verify.sh`. "Who breaks the build" is the Actions realm's
`ActionsBreakageByAuthorKind`. A free-text question that does not say "github" may be routed to no realm by
the ask door; pass `scope: 'github'` (the focus in `focuses/github.yml`) and it sees only these realms. Every issue, PR,
comment, review and commit the realm reads carries the dev vocabulary's `authorKind` —
`human`, `bot`, `agent`, `assisted` (a person's record declaring an agent's hand), `unknown`
— and the vocabulary's labels (`Issue`, `ChangeRequest`, `Comment`, `Review`, `Commit`,
`FileChange`), so a Cypher question names `:Issue` rather than `:GitHubIssue` unless it is
GitHub-specific. Repeat the vocabulary's limit in any answer: a person who pasted an agent's
text with no trailer and no marker counts as human.

## Cardinal rules

1. **Don't fabricate.** Issue numbers, SHAs, usernames, URLs — every one comes from a tool result.
2. **`owner` and `repo` always required.** No "current repo" default.
3. **Cap pagination.** Default to 1–3 pages of `per_page: 100`; stop early.
4. **Render every linkable thing as a markdown link** using the response's `html_url` field.

## Counting (how many / total / top-N)

For any **"how many"**, **"count"**, **"number of"**, or **"top N raisers/authors/labels"** question, use search and read `total_count`. **Do not** list-then-`.length` — `issuesListForRepo` caps at 100/page so the count is wrong on any large repo, and the payload wastes context.

```javascript
const r = await gateway.gh.searchIssuesAndPullRequests({
  q: "repo:embabel/embabel-agent is:issue is:open",
  per_page: 1,            // count-only — items not needed
});
console.log(`Open issues: ${r.total_count}`);
```

| Question | `q` |
|---|---|
| open issues in repo | `repo:owner/name is:issue is:open` |
| closed issues in repo | `repo:owner/name is:issue is:closed` |
| open PRs in repo | `repo:owner/name is:pr is:open` |
| issues by author | `repo:owner/name author:login` |
| issues with label | `repo:owner/name label:bug is:open` |

For top-N-by-author / top-N-by-label, paginate the same `searchIssuesAndPullRequests` call and aggregate client-side — its per-item shape is much smaller than `issuesListForRepo`.

## Listing issues / PRs

```javascript
const r = await gateway.gh.issuesListForRepo({
  owner, repo,
  state: "open",          // open | closed | all   (default: open)
  sort: "created",        // created | updated | comments
  direction: "desc",
  per_page: 30,
});
// r is a bare array. Each item: number, title, state, user.login, html_url,
// created_at, updated_at, labels[], assignees[]. PRs are also returned —
// filter with `i.pull_request !== undefined` for PRs only, or use pullsList.
```

If the user gives a number, fetch directly — don't list-and-filter:
```javascript
await gateway.gh.issuesGet({ owner, repo, issue_number: 42 });
```

## Searching content

Search returns `{ total_count, items, incomplete_results }` — **not** a bare array.

```javascript
const s = await gateway.gh.searchIssuesAndPullRequests({
  q: "repo:embabel/embabel-agent state:open label:bug pagination",
  per_page: 10,
});
for (const hit of s.items) console.log(`#${hit.number} ${hit.title} — ${hit.html_url}`);
```

Useful operators: `repo:`, `org:`, `user:`, `is:open|closed|merged`, `state:`, `label:`, `author:`, `assignee:`, `mentions:`, `created:>2025-01-01`, `updated:<2026-01-01`, `in:title`, `in:body`.

## Paginating safely

```javascript
let all = [];
for (let page = 1; page <= 3; page++) {                // hard cap
  const r = await gateway.gh.issuesListForRepo({ owner, repo, state: "all", per_page: 100, page });
  if (!r || r.length === 0) break;                     // empty page → done
  all.push(...r);
  if (r.length < 100) break;                           // partial page → last page
}
```

Both break conditions are required. Without `r.length < 100` you waste one extra request.

## Users and repos

```javascript
await gateway.gh.usersGetByUsername({ username: "johnsonr" });
// fields: login, name, bio, company, blog, location, public_repos, followers, html_url, avatar_url

await gateway.gh.usersGetAuthenticated();              // no args — current user

await gateway.gh.reposGet({ owner, repo });            // metadata
await gateway.gh.reposGetReadme({ owner, repo });
await gateway.gh.reposGetLatestRelease({ owner, repo });
await gateway.gh.reposListForUser({ username });
await gateway.gh.reposListForAuthenticatedUser({ per_page: 100 });
```

## Writing — issues and comments

Confirm with the user first; both are publicly visible.

```javascript
const i = await gateway.gh.issuesCreate({
  owner, repo,
  title: "Short imperative title",
  body: "## Context\n…\n## Repro\n…\n## Expected\n…",
  labels: ["bug"],
});

await gateway.gh.issuesCreateComment({ owner, repo, issue_number: 42, body: "…" });
```

## When a call returns 404

A 404 from `/repos/{owner}/{repo}*` does **NOT** mean "no permission." GitHub
returns the same 404 for: repo doesn't exist, repo was renamed (and the
old-name redirect lapsed or was never established for the sub-resource),
repo was deleted, repo is private and the token can't see it, or you simply
typo'd the name. Saying "I don't have permission" is almost always the wrong
interpretation — try the cheap recovery first.

When you see a 404 on a repo path:

1. **Search for it** to see if it exists under a different name:
   ```javascript
   const s = await gateway.gh.searchRepos({ q: "embabel assistant", per_page: 5 });
   for (const r of s.items) console.log(`${r.full_name} — ${r.description ?? ""}`);
   ```
2. **Confirm the current name with the user** if the search doesn't yield an obvious match.
3. Only if the repo is found and accessible but the *sub-resource* (e.g. `/issues/9999`) returns 404 — then it really is "doesn't exist within that repo."

Do not say "no permission" unless you actually saw a `403`. 404 is an identity
problem, not an access problem.

## Pitfalls

- Method names are **camelCase**; arg names are **snake_case**. Most "not a world tool" errors come from snake_case method names.
- Search uses **`q`**, not `query`.
- Search returns `{ total_count, items }`; listings return a bare array.
- Field is **`i.user.login`**, not `i.author.login`.
- `per_page` silently caps at 100.
- `state` defaults to `open` — pass `"all"` to include closed.
- Auth limit: 5,000 req/h; **search limit: 30 req/min** — never loop a search.
- A `404` is an identity problem (wrong owner/repo, renamed, deleted) — not an access problem. Use `searchRepos` to recover, then ask the user.
