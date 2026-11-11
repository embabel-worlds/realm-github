# realm-github

GitHub via the official OpenAPI 3 spec. It gives the LLM full request **and**
response types so it doesn't have to guess pagination shape, field names,
or wrapper-vs-array.

## Why

Untyped GitHub tooling forces the LLM to shape-probe on every call.
Common failures observed in production traces:

- `.forEach` on the listIssues result (it's `{issues, totalCount, pageInfo}`,
  not a bare array)
- `i.user.login` vs `i.author.login` field-name guessing
- `q` vs `query` argument-name confusion

This realm carries a vendored, trimmed copy of the canonical GitHub
OpenAPI 3 spec from `github/rest-api-description` in
`apis/api.github.com.json`. It holds only the operations `apis/apis.yml`
lists, plus the schemas they reference. Each write's request body is
reduced to the subset the host accepts: `type`, `properties`, `required`,
`items`, `enum` and `description`, with one form chosen for each field
where GitHub accepts several (label names as strings, a milestone as its
integer number). The LLM gets full typed `interfaces.ts` including
pagination wrappers and response field names.

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
                     -[:HAS_COMMIT]->         (Commit)      a PR's commits through the issue door (the windowed one)
                     -[:CHANGED]->            (FileChange)  a PR's diff through the issue door
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
first (up to 1,000, reported PARTIAL beyond; the issue door goes to 4,000, because a quarter of
an active repository is more than a thousand records), the subject door reads one issue's, PR's or
commit's, one call each. Narrow the subjects before hopping, and never converge the two doors
on one node. A literal lower bound on `openedAt` (issues and PRs through `HAS_ISSUE`),
`createdAt` (comments) or `authoredAt` (commits) is pushed to GitHub as `since`, so a window
is a complete read, not the newest 1,000 — GitHub's `pulls/list` takes no `since`, so
`HAS_PULL_REQUEST` is always the newest 1,000 and a count over it a lower bound.

### The views, and the queries behind them

Fifteen saved views answer the questions the vocabulary exists for (`views/vocabulary.yml`); each
takes `repo`, a `since` GitHub applies itself and an `until` the graph applies, and every figure
below was reconciled to the row against GitHub's REST API by `tests/verify.sh`:

| View | Answers | Reads |
|---|---|---|
| `GitHubAuthorship` | share of issues, PRs, comments, review-line comments and commits by `authorKind` | the five repository doors, one page walk each |
| `GitHubChangeRequestsByAuthorKind` | PRs per month × authorKind × outcome, mean hours to merge | the issue door (its `since` is pushed) |
| `GitHubChangeRequestThroughput` | per week, month, quarter or year: PRs opened, merged and closed without merging, the merge rate and mean hours to merge, by authorKind and in total | the issue door, up to 4,000 records touched since `since` |
| `GitHubReviewBurden` | reviews and line comments per PR by the PR author's kind, for PRs merged in a window | one call per merged PR for reviews, one for line comments |
| `GitHubCommitSize` | files, lines, test files per commit by authorKind | one call per commit, cached a week |
| `GitHubFileHotspots` | the paths that change most, and who changes them | the same commits |
| `GitHubChangeRequestSize` | per PR opened in a window: files, lines, the files and lines per kind (source, test, docs, build, config, data, other), the languages touched | the issue door, then one diff call per PR (cached an hour) |
| `GitHubChangeRequestSizeByAuthorKind` | mean and largest PR by authorKind, the share of changed lines that are tests and docs | the same diffs |
| `GitHubChangeRequestConcern` | per PR: a judged concern (fix, feature, refactor, dependency…) and the area or technology it is about | the issue door, one batched model call per dimension |
| `GitHubChangeRequestConcernMix` | the concern × authorKind matrix | the same |
| `GitHubRepositoryLanguages` | the repository's languages, bytes and share, as GitHub counts them | one call, cached a day |
| `GitHubRepositoryProfile` | languages, build tools from the root manifests, Spring settings counted, and an opinion sentence built from those facts by rule | the language table plus realm-java-project's files and settings |
| `GitHubCommitAuthors` | per committer: commits, kinds seen, and what the world knows about the person through its Person spine | the commit door; the spine is read, not fetched |
| `GitHubCommentReadsAs`, `GitHubCommentProvenance` | what a comment's TEXT reads as (human, machine, unsure) beside what its record declares | one batched model call per window |

On `embabel/embabel-agent` for the 40 days to 7 November 2026: 83 PRs (76 human, 7 assisted,
1 bot), 344 conversation comments (289 human, 55 bot), 522 review-line comments (512 human, 10
by Copilot — the only `agent` rows), 65 commits (61 human, 4 assisted). Each figure equals the
count from GitHub directly.

The same questions as raw Virtual Cypher, for a `kg_query` or a view of your own. Project
first, then filter — the rule that lets the engine push the filter to GitHub and share the
cached read:

```cypher
// open pull requests by who opened them (36 human, 2 assisted, 1 bot on embabel-agent, 7 Nov 2026)
MATCH (:GitHubRepository {full_name:'embabel/embabel-agent'})-[:HAS_PULL_REQUEST]->(pr:ChangeRequest)
WITH pr, pr.status AS status, pr.authorKind AS kind WHERE status = 'open'
RETURN kind, count(*) AS n ORDER BY n DESC

// the line comments on one recent PR, with who wrote each: narrow the PRs by a pushed bound first,
// then hop — never hop from the whole repository
MATCH (:GitHubRepository {full_name:'embabel/embabel-agent'})-[:HAS_ISSUE]->(pr:Issue)
WITH pr, pr.updatedAt AS updatedAt, pr.number AS number
WHERE updatedAt >= '2026-10-20T00:00:00Z' AND number = 2182
MATCH (pr)-[:HAS_REVIEW_COMMENT]->(c:Comment)
RETURN c.authorKind AS kind, c.authorLogin AS who, c.line AS line, left(c.body, 50) AS opening
ORDER BY c.createdAt

// with realm-github-actions installed: the commit behind every failed push run on main, and whose it was
MATCH (:GitHubRepository {full_name:'embabel/embabel-agent'})-[:HAS_RUN_HISTORY]->(run:WorkflowRun)
WITH run, run.created_at AS at, run.event AS event, run.head_branch AS branch, run.status AS status, run.conclusion AS conclusion
WHERE at >= '2026-10-24T00:00:00Z' AND event = 'push' AND branch = 'main' AND status = 'completed' AND conclusion = 'failure'
MATCH (run)-[:BUILT]->(c:Commit)
RETURN c.authorKind AS kind, c.authorLogin AS who, c.title AS title, c.coAuthors AS coAuthors, run.html_url AS run
```

The Actions realm's `ActionsBreakageByAuthorKind` is the last of those as a view: pushes,
broken pushes and failed runs by the commit author's kind — "are humans or machines more likely
to break the build" in one row per kind.

### Volume and time: the merge rate, by time box

"What was the PR merge rate last week? This month, quarter, year? How much of the volume was
people and how much machines?" is `GitHubChangeRequestThroughput(repo, period, since, until)`.
It unwinds each pull request into its dated events — opened, merged, or closed without merging —
and buckets each in the period it happened (`date.truncate($period, …)`, so `week`, `month`,
`quarter` and `year` are one query), by `authorKind` and once more under `all`. The merge rate is
merged ÷ (merged + closed without merging) among the PRs resolved in the period; a period's merges
can exceed its openings, because they are different PRs.

```sh
# the last complete ISO week, one row per author kind and one for all
view_run GitHubChangeRequestThroughput {"repo":"embabel/embabel-agent","period":"week","since":"2026-10-26T00:00:00Z","until":"2026-11-02T00:00:00Z"}
```

`embabel/embabel-agent` for the year to 7 November 2026, every cell reconciled against GitHub's
API by `tests/verify.sh`:

| PRs opened | merged | closed unmerged | merge rate | mean hours to merge | opened by people | assisted |
|---|---|---|---|---|---|---|
| 619 | 509 | 74 | 87.3% | 70.6 | 590 (95%) | 25 (4%) |

The 25 assisted PRs merged at 82.6%. The repository labels no pull request by author, so the split
comes from the account and the PR description as the vocabulary defines it, not from a label; a
repository where machines write most of the code reads very differently on the same view, and the
view is the same.

### Size, concern, people and project

Four more questions, each answered against the vocabulary rather than GitHub, so a GitLab or
Bitbucket child answers them with the same views.

**How big, and of what.** The forge's pull-request list carries no file counts, so size is read
from the diff: one call per change request, each file carrying the vocabulary's `kind` — source,
test, docs, build, config, data or other, decided from the path by the ordered rule stated in
realm-dev-vocabulary's contract and computed identically in both file producers here
(`tests/kind_rule.py` is the same rule in Python, which is what the battery reconciles against).
`GitHubChangeRequestSize` gives every change request opened in a window its files, lines, per-kind
counts and the code languages it touched (read off extensions, lines per language); the aggregate
splits that by `authorKind`. On `embabel/embabel-agent` for the 54 pull requests opened between 15
October and 8 November 2026, every figure reconciled to GitHub's diff; 41.7% of the changed lines
were tests. One thing the battery caught on the way: a stacked pull request and its stack share a
head commit and so every `blob_url`, and an identity on `blob_url` made the second PR read the
first's line counts, so a `GitHubFileChange` is now identified by subject and path, as the
vocabulary defines it.

**What it concerns.** `GitHubChangeRequestConcern` asks a model, from the title, body and labels,
for one of eleven concerns (feature, fix, refactor, test, docs, build, dependency, ci,
performance, security, chore) and for the area or technology the change is about, in a few
words; `GitHubChangeRequestConcernMix` is the matrix by author kind. The population is a fact and
the battery reconciles it; the labels are an opinion and are only shape-checked. The model reads
the first 800 characters of each change request; the envelope currently reports that as an
incomplete result, which it is not (embabel/me#3623).

**Who makes the changes.** A commit carries its author's email, and the vocabulary's
`authorPersonEmail` keys the world's Person spine for a person at a real mailbox — never a bot, an
agent or a `users.noreply.github.com` address, so no Person is ever minted for Dependabot. The
author's name travels onto the Person it mints. `GitHubCommitAuthors` lists each committer with
what the world holds about them: the canonical name, every address, which sources contributed the
person and what else is linked to them, so a committer who is also a CRM contact or a helpdesk
agent is one node. On an appliance holding nothing but this realm, that column is honestly empty.
Two engine gaps are open around it: a query written against `:Commit` (the vocabulary's label)
does not yet mint the spine, only one against `:GitHubCommit` does (embabel/me#3621, fix in
#3622); and a minted Person is reached through the user's `HAS_CONTACT` edge, not yet by a bare
`(p:Person)` in the same scope (embabel/me#3624), which is the form the view uses.

**What the project is.** `GitHubRepositoryLanguages` is GitHub's own language table (bytes and
share; `embabel/embabel-agent` is 86.3% Kotlin and 13.3% Java). `GitHubRepositoryProfile` adds,
where realm-java-project is installed, the build tools read off the manifests at the project
root, whether it runs GitHub Actions, and a count of `spring.*` settings in its configuration
(`spring.ai.*` for Spring AI) — so "Spring Boot" is a count, not a guess — and assembles an
opinion sentence from exactly those facts by rule, not by a model: "A Java project (Java 65.8%,
Kotlin 26.7%, …) built with Maven, Docker, GitHub Actions; Spring Boot, judging by 142 spring.*
settings in 8 configuration files, 140 of them Spring AI; 129 files" for
`embabel/embabel-agent-examples`. On `embabel/embabel-agent` itself the settings read can come back FAILED /
SOURCE_UNAVAILABLE through the public view endpoint, because the repository carries three
deliberately malformed YAML test fixtures and the source-tree reader reports a skipped file as a
failed source (embabel/me#3625); the rows are right when they arrive, and the battery names the
issue if the view fails. A Node framework named only
inside `package.json` is not visible to the profile yet, and the opinion says what it saw and no
more.

### The page

The Ship rate page that draws the throughput view lives in its own realm, `ship-rate`, which
requires this one: this realm is the data and the views, and a page over them is installed
beside it, not inside it.

### Verify before anyone asks it anything

`tests/verify.sh` is the ladder that stands behind every figure above:

```sh
GH_TOKEN=... EMBABEL_TOKEN=... APPLIANCE=http://127.0.0.1:11043 sh tests/verify.sh [owner/repo]
```

L0 reads GitHub directly for two fixed windows (40 days for the list doors, 18 for the hops,
both ending two hours ago) and replicates the producers' `authorKind` rule; L1 counts each door
through the engine; L2 runs all fifteen views and asserts every count, share, mean and path equal
to the row (the throughput view by week and by month; every change request's files, lines and
kinds; the language table; each committer's counts); L3 asks `tests/questions.yml` through the ask door, reconciling each figure with the
view that claims the question and asking the adversarial half three times; L6 forces an unknown
repository (must be LOUD: `NOT_FOUND` named) and a window in the future (must be an exact
empty). It exits nonzero on any drift. The Ship rate page's browser harness ships with the `ship-rate` realm.

What the ladder found on 7 November 2026, so nobody finds it by falling over it: every L0–L2
figure reconciles exactly; the natural-language battery is routed to this realm only when a
question says `github` in lower case — a question that says "pull requests in owner/repo", or
"GitHub issues", is resolved to no realm by the appliance's ask door and answered from the wrong
schema. That is an engine defect in how a question's words are matched to a realm's labels
([embabel/me#3591](https://github.com/embabel/me/issues/3591)), not a reason to reword the
battery; the battery is written as people type and stays red until the fix lands. Until then a
caller that knows what it is asking about names the scope: `focuses/github.yml` declares
`github` — the two GitHub realms with the vocabulary they are children of — so
`kg_ask(question, scope: 'github')` and `/focus github` see this realm's schema and views and
nothing else ("which pull requests in owner/repo are open" answers correctly that way today).

## Namespace

Methods land under `gateway.gh`, named after GitHub's OpenAPI operationIds.
A script sees them in its own language's style: camelCase in JavaScript,
snake_case in Python.

- `gateway.gh.issuesListForRepo({owner, repo, ...})`
- `gateway.gh.usersGetByUsername({username})`
- `gateway.gh.searchIssuesAndPullRequests({q})`

The realm's own verbs in `src/api/` call the operationId as written, with
brackets, and put a write's fields under a reserved `body` argument:
`gh["issues/update"]({owner, repo, issue_number, body: {state: "closed"}})`.
Every other argument has to be a path or query parameter the operation
declares. A write is an id listed under `write-operation-ids` in
`apis/apis.yml`; any other listed operation is a read, which sends no body.

See `skills/github-workflows/SKILL.md` for usage patterns.

## Auth

A GitHub token. The API entry declares one credential, `gh`, and the
world's owner binds a wallet item holding a token to it. On an appliance,
`GH_TOKEN` fills that item. Reads and writes both go out with that token,
so anything the realm writes is attributed to the token's owner. Give the
token only the repositories and permissions the realm should have.

The OAuth declaration is kept as a comment in `apis/apis.yml`. An entry
uses a token or OAuth, never both, and under OAuth every call is refused
for a user who has not connected a GitHub account.

## Tag filter

The full spec is 600+ operations. This realm does not filter by tag; it
keeps an explicit allowlist in `apis/apis.yml`. Reads go under
`operation-ids` and writes under `write-operation-ids`, and an id may not
be in both. To add an operation, add its id to the right list and
regenerate the vendored spec as the comment at the top of `apis/apis.yml`
describes.
