/*
 * Review requested → what this world already knows about it.
 *
 * Observe-only until adopted AND promoted: every external effect is behind `if (!dryRun)`, so a
 * dry run reads and judges for real and reports what it WOULD have sent.
 */
if (trigger !== 'signal' || !signal) {
  console.log('not a signal event — nothing to brief')
} else {
  const { repo, number, author, title } = signal.properties as Record<string, unknown>

  // Has this author's work reached us before? A first-time contributor is the single most useful
  // thing to know at review time, and it is a question about the WORLD, not about this PR.
  const priors = await gateway.kg.query({
    cypher: `MATCH (pr:GitHubPullRequest) WHERE pr.author = $author RETURN count(pr) AS n`,
    params: { author: String(author ?? '') },
  })
  const seenBefore = Number(priors?.rows?.[0]?.n ?? 0)

  const line = seenBefore === 0
    ? `First PR we have seen from ${author}: ${repo}#${number} — ${title}`
    : `${author} (${seenBefore} prior PRs here) wants a review: ${repo}#${number} — ${title}`

  console.log(dryRun ? `WOULD notify: ${line}` : `notifying: ${line}`)
  if (!dryRun) {
    await gateway.notify({ message: line, urgency: seenBefore === 0 ? 'high' : 'normal' })
  }
}
