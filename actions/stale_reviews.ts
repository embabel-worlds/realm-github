/*
 * Reviews that have gone quiet, as ONE message.
 *
 * The shape matters as much as the query: the failure mode of review reminders is N notifications,
 * which trains people to ignore all of them. One digest, or nothing at all when there is nothing.
 */
const STALE_DAYS = 2

const waiting = await gateway.kg.query({
  cypher: `
    MATCH (pr:GitHubPullRequest)
    WHERE pr.state = 'open'
    RETURN pr.full_name AS repo, pr.number AS number, pr.title AS title, pr.updated_at AS updated
    ORDER BY pr.updated_at ASC
    LIMIT 25
  `,
})

const cutoff = new Date(now).getTime() - STALE_DAYS * 24 * 60 * 60 * 1000
const stale = (waiting?.rows ?? []).filter((r: Record<string, unknown>) => {
  const updated = r.updated ? new Date(String(r.updated)).getTime() : NaN
  return !Number.isNaN(updated) && updated < cutoff
})

if (stale.length === 0) {
  // SILENCE IS THE RIGHT OUTPUT. A digest that says "nothing today" every day is a digest people
  // filter, and then they miss the day it says something.
  console.log('no reviews have gone stale — saying nothing')
} else {
  const body = stale
    .map((r: Record<string, unknown>) => `· ${r.repo}#${r.number} — ${r.title}`)
    .join('\n')
  const message = `${stale.length} review(s) quiet for ${STALE_DAYS}+ days:\n${body}`
  console.log(dryRun ? `WOULD notify:\n${message}` : `notifying:\n${message}`)
  if (!dryRun) await gateway.notify({ message, urgency: 'normal' })
}
