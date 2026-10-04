/*
 * The actions call the gateway the way the gateway is declared.
 *
 * `gateway.kg.query` takes `cypher`. Both actions passed `query`, so `stale-reviews` threw every
 * morning at 08:00 and `review-brief` threw on every review request — and because an action's
 * failure arrives in chat, a broken routine read as the assistant being broken. Nothing caught it:
 * an action's body is a string compiled in the sandbox, so a wrong key is not a type error here.
 *
 * Reading the source is a poor test in general and the right one here: the mistake is a literal
 * key, the signature is stable, and the failure is silent until a schedule fires.
 */
import { readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const dir = new URL('../actions/', import.meta.url).pathname
const actions = readdirSync(dir).filter((name) => name.endsWith('.ts'))

describe('gateway calls in actions', () => {
  it('has actions to check', () => {
    expect(actions.length).toBeGreaterThan(0)
  })

  for (const name of actions) {
    const source = readFileSync(join(dir, name), 'utf8')

    it(`${name}: every kg.query passes cypher, not query`, () => {
      /* The call and the next few lines, so the key is read from the object it belongs to. */
      const calls = source.split('kg.query({').slice(1)
      for (const call of calls) {
        const head = call.slice(0, call.indexOf('})') + 1)
        expect(head, `in ${name}`).toMatch(/\bcypher\s*:/)
        expect(head, `in ${name}: 'query' is not a parameter of kg.query`).not.toMatch(/\bquery\s*:/)
      }
    })
  }
})
