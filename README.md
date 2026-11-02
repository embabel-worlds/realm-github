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

## Namespace

Methods land under `gateway.gh`, named by GitHub's OpenAPI operationIds
exactly as written. An operationId holds `/` and `-`, so call it with
brackets:

- `gateway.gh["issues/list-for-repo"]({owner, repo, ...})`
- `gateway.gh["users/get-by-username"]({username})`
- `gateway.gh["search/issues-and-pull-requests"]({q})`
- `gateway.gh["issues/create"]({owner, repo, body: {title, body}})`

A write takes its request body under a reserved `body` argument. Every
other argument has to be a path or query parameter the operation
declares; the host refuses anything else. A write is an id listed under
`write-operation-ids` in `apis/apis.yml`; any other listed operation is a
read, which sends no body.

See `skills/github-workflows/SKILL.md` for usage patterns.

## Auth

GitHub OAuth, with your own OAuth app.

1. Register a GitHub OAuth app at https://github.com/settings/developers.
   Set its callback URL to `http(s)://<host>/api/v1/auth/oauth2/callback`,
   where `<host>` is the address you reach the assistant on, for example
   `http://localhost:8042`. One route serves every provider.
2. In the console, open Settings > Keys and connections > gh, choose
   "Use my own OAuth app", enter the app's client id and client secret,
   and press Authorize.
3. GitHub asks you to approve the app, then returns you to the same page
   with the account connected.

## Tag filter

The full spec is 600+ operations. This realm does not filter by tag; it
keeps an explicit allowlist in `apis/apis.yml`. Reads go under
`operation-ids` and writes under `write-operation-ids`, and an id may not
be in both. To add an operation, add its id to the right list and
regenerate the vendored spec as the comment at the top of `apis/apis.yml`
describes.
