# realm-github

GitHub via the official OpenAPI 3 spec — gives the LLM full request **and**
response types so it doesn't have to guess pagination shape, field names,
or wrapper-vs-array.

## Why

Untyped GitHub tooling forces the LLM to shape-probe on every call.
Common failures observed in production traces:

- `.forEach` on the listIssues result (it's `{issues, totalCount, pageInfo}`,
  not a bare array)
- `i.user.login` vs `i.author.login` field-name guessing
- `q` vs `query` argument-name confusion

This realm reads the canonical GitHub OpenAPI 3 spec from
`github/rest-api-description` and surfaces it via the assistant's
existing OpenAPI learner. The LLM gets full typed `interfaces.ts`
including pagination wrappers and response field names.

## The dev vocabulary: who wrote what

Every issue, pull request, comment, review and commit this realm reads is also a type of the
[dev vocabulary](https://github.com/embabel-worlds/realm-dev-vocabulary) (`realm-dev-vocabulary`,
installed first): a `GitHubIssue` is an `Issue`, a `GitHubPullRequest` a `ChangeRequest`, a
`GitHubComment` a `Comment`, a `GitHubReview` a `Review`, a `GitHubCommit` a `Commit`, and the
files a commit or PR touched are `FileChange`s. A view written against the vocabulary's labels
names no vendor, and keeps answering when GitLab or Jira is installed beside GitHub.

```
(GitHubRepository {full_name})                     pin it as a single literal 'owner/repo'
   -[:HAS_ISSUE]->          (GitHubIssue:Issue)              every issue (PRs included: isChangeRequest)
   -[:HAS_PULL_REQUEST]->   (GitHubPullRequest:ChangeRequest)
   -[:HAS_COMMENT]->        (GitHubComment:Comment)          every conversation comment, newest first; `since` pushed down
   -[:HAS_REVIEW_COMMENT]-> (GitHubComment:Comment)          every comment on a line of a diff
   -[:HAS_COMMIT]->         (GitHubCommit:Commit)            newest first on the default branch; since/until/author pushed down
(GitHubIssue)        -[:HAS_COMMENT]->        (Comment)     one issue's thread, one call each
(GitHubPullRequest)  -[:HAS_COMMENT]->        (Comment)     one PR's conversation
                     -[:HAS_REVIEW_COMMENT]-> (Comment)     one PR's line comments
                     -[:HAS_REVIEW]->         (GitHubReview:Review)
                     -[:HAS_COMMIT]->         (Commit)      the commits the PR carries
                     -[:CHANGED]->            (GitHubFileChange:FileChange)   the PR's diff, one call
(GitHubCommit)       -[:CHANGED]->            (FileChange)  the commit's files, one call each, cached a week
```

Every one of them carries **`authorKind`**: `human`, `bot` (Dependabot, a CI commenter),
`agent` (a coding agent under its own login), `assisted` (a person's record declaring an
agent's hand — a `Co-Authored-By` trailer naming an agent, a description Claude Code
generated), or `unknown`. So the questions nobody could ask of the Actions tab or the PR list
are one `GROUP BY`:

```cypher
// what share of this repository's comments are machine-written, and on what
MATCH (:GitHubRepository {full_name:'owner/repo'})-[:HAS_COMMENT]->(c:Comment)
WITH c.authorKind AS kind, c.subjectKind AS on, count(*) AS n RETURN kind, on, n

// pull requests opened by agents versus people, by month, with how they ended
MATCH (:GitHubRepository {full_name:'owner/repo'})-[:HAS_PULL_REQUEST]->(pr:ChangeRequest)
WITH substring(pr.openedAt, 0, 7) AS month, pr.authorKind AS kind, pr.status AS status, count(*) AS n
RETURN month, kind, status, n

// agent-assisted commits, with the agent named in the trailer
MATCH (:GitHubRepository {full_name:'owner/repo'})-[:HAS_COMMIT]->(c:Commit)
WITH c, c.authorKind AS kind WHERE kind = 'assisted'
RETURN c.title, c.authorLogin, c.coAuthors, c.projectKey
```

The honest limit, which the vocabulary states and any view over it must repeat: a person who
pastes an agent's text with no trailer and no marker is `human` here. The field reports what
the record declares, never a guess about its prose.

A commit's `projectKey` (`https://github.com/owner/repo@sha`) is what `realm-java-project`
and its siblings pin a project by, so a commit reaches the source it produced, parsed at that
commit — and a `FileChange`'s `changedLines` (the hunks' line ranges, after the change) is what
a declaration's extent is intersected with to say which methods a commit touched.

Two doors to comments and commits, and one rule: the repository door reads everything newest
first (up to 1,000, reported PARTIAL beyond), the subject door reads one issue's, PR's or
commit's, one call each. Narrow the subjects before hopping, and never converge the two doors
on one node.

## Namespace

Methods land under `gateway.gh`. E.g.:

- `gateway.gh.issues_list_for_repo({owner, repo, ...})`
- `gateway.gh.users_get_by_username({username})`
- `gateway.gh.search_issues({q})`
- `gateway.gh.issues_create({owner, repo, title, body})`

See `prompts/examples.md` for usage patterns.

## Auth

GitHub OAuth. Two supported registrations: a classic **OAuth App** (simplest)
or a **GitHub App** (fine-grained per-repo permissions, rotating tokens).
Both expose the same user-to-server endpoints, so the setup is identical
from the assistant's perspective.

1. Register an app at https://github.com/settings/developers.
   Callback URL: `http://localhost:8042/api/v1/auth/oauth2/callback`
   (single route for all providers; state carries the provider id).
2. In the assistant: open the drawer → Auth → Wallet → Provider
   credentials. Paste `client_id` and `client_secret` under provider
   `gh`. Both are encrypted client-side; the server holds no plaintext
   copy.
3. Settings → Connected Services → Authorize for GitHub. The access
   token lands in the wallet under `gh_OAUTH2#${login}`.

## Tag filter

The full spec is 600+ operations. This realm filters to five high-value
tags: `issues`, `pulls`, `repos`, `users`, `search`. Edit `apis/apis.yml`
to add more (e.g. `actions`, `git`, `code-scanning`).
