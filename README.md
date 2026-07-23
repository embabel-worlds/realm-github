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
