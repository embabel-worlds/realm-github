# pack-github

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

This pack reads the canonical GitHub OpenAPI 3 spec from
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

GitHub App (`embabel`) + PKCE. Single Embabel-owned App, no per-deployment
registration, no `client_secret`.

In the assistant: Settings → Connected Services → Authorize for GitHub.
First time on a given account, GitHub shows its install screen (pick repos)
before consent. Token lands in the wallet credential store under
`gh_OAUTH2#${login}` and rotates (~8h access, ~6mo refresh).

To add or remove repos later, use the "Manage installation on GitHub" link
in the same UI.

Falling back to a self-registered OAuth App is still supported if an org
admin policy blocks installing the Embabel App — see `pack-format` docs
for the `pkce: false` + `client-secret` shape.

## Tag filter

The full spec is 600+ operations. This pack filters to five high-value
tags: `issues`, `pulls`, `repos`, `users`, `search`. Edit `apis/apis.yml`
to add more (e.g. `actions`, `git`, `code-scanning`).
