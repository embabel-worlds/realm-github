// Reacts to a newly-opened pull request in the embabel org.
//
// In scope (see config/actions/.embabel/handler-context.d.ts):
//   signal  — the GitHubPullRequestOpened envelope (its fields are under signal.properties)
//   trigger — "signal" here
//   now     — ISO-8601 timestamp
//   dryRun  — true = observe-only; guard external/write effects with `if (!dryRun)`
//
// Observe-only for now: it logs each new PR (the dry-run feedback surface). When this is trusted and
// marked autonomous, take an effect under `if (!dryRun)` — a notification, a task, or a pack verb.

const props: any = signal?.properties ?? {};
const repo: string = props.repo ?? "(unknown repo)";
const number: string = String(props.number ?? "?");
const title: string = props.title ?? signal?.subject ?? "(no title)";
const author: string = props.author ?? "(unknown)";
const url: string = signal?.url ?? props.url ?? "";

console.log(`New PR ${repo}#${number}: "${title}" by ${author}${url ? " — " + url : ""}`);

if (!dryRun) {
  // TODO (on promote to autonomous): take a real effect via the typed gateway surface, e.g. a
  // notification. Kept observe-only until verified end-to-end.
}
