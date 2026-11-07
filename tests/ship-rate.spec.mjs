/*
 * The Ship rate page, driven headless over envelopes captured from live runs of
 * GitHubChangeRequestThroughput (tests/fixtures/envelopes.json). No network: the appliance runtime
 * is a stub that resolves each call from the fixtures and THROWS on any call with no fixture, so a
 * missing capture fails instead of passing as "no rows". The browser clock is pinned to the capture
 * instant (tests/fixtures/captured-at.json), because the page computes its windows from "now" and
 * the fixture keys carry the `since` those windows produced. Recapture with
 * tests/fixtures/capture.py whenever the view, the app's arguments or the calendar moves on.
 * What runs is the page's own bytes from apps/ship-rate.html.
 */
import { expect, test } from "@playwright/test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const fixtures = JSON.parse(readFileSync(join(here, "fixtures/envelopes.json"), "utf8"));
const capturedAt = new Date(JSON.parse(readFileSync(join(here, "fixtures/captured-at.json"), "utf8")).capturedAt);
const VIEW = "GitHubChangeRequestThroughput";
const REPOS = ["embabel/embabel-agent", "embabel/embabel-agent-examples"];   // the page defaults to the first; the second comes in on the hash
const TWO = "#period=week&repos=" + REPOS.join(",");
const N = { week: 12, month: 12, quarter: 6, year: 1 };

/* The same UTC arithmetic the page does, so the spec can name the fixture a click will ask for. */
function start(period, d) {
  if (period === "week") { const x = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())); x.setUTCDate(x.getUTCDate() - ((x.getUTCDay() + 6) % 7)); return x; }
  if (period === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
  if (period === "quarter") return new Date(Date.UTC(d.getUTCFullYear(), Math.floor(d.getUTCMonth() / 3) * 3, 1));
  return new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
}
function step(period, d, k) {
  if (period === "week") { const x = new Date(d); x.setUTCDate(x.getUTCDate() + 7 * k); return x; }
  if (period === "month") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + k, 1));
  if (period === "quarter") return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 3 * k, 1));
  return new Date(Date.UTC(d.getUTCFullYear() + k, 0, 1));
}
const sinceFor = (period) => step(period, start(period, capturedAt), -N[period]).toISOString().replace(/\.\d{3}Z$/, "Z");
const argsFor = (repo, period) => ({ repo, period, since: sinceFor(period), until: "" });
const key = (args) => `view:${VIEW}:${JSON.stringify(Object.fromEntries(Object.entries(args).sort()))}`;
const envOf = (repo, period) => { const f = fixtures[key(argsFor(repo, period))]; if (!f) throw new Error("no fixture " + key(argsFor(repo, period))); return f; };
const latestComplete = (period) => step(period, start(period, capturedAt), -1).toISOString().slice(0, 10);
const cell = (repo, period, bucket, kind) => envOf(repo, period).data.find((r) => r.period === bucket && r.authorKind === kind);
const cardId = (repo) => "#card-" + repo.replace(/[^A-Za-z0-9]/g, "-");

/* The runtime stub. `overrides` replaces envelopes; `delays` holds a call back, in ms. */
function stub(overrides = {}, delays = {}) {
  return `window.__calls = [];
  window.embabel = (() => {
    const fx = Object.assign(${JSON.stringify(fixtures)}, ${JSON.stringify(overrides)});
    const delays = ${JSON.stringify(delays)};
    const key = (kind, id, args) => kind + ':' + id + ':' + JSON.stringify(Object.fromEntries(Object.entries(args || {}).sort()));
    const invoke = (kind) => async (id, args) => {
      const k = key(kind, id, args);
      window.__calls.push(k);
      if (delays[k]) await new Promise((r) => setTimeout(r, delays[k]));
      const env = fx[k];
      if (!env) throw new Error('NO FIXTURE for ' + k);
      if (env.status === 'FAILED') throw Object.assign(new Error((env.error && env.error.message) || 'failed'), env.error);
      return env;
    };
    const esc = (v) => String(v ?? '').replace(/[&<>'"]/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;',"'":'&#39;','"':'&quot;'}[c]));
    return { views: { invoke: invoke('view') }, lenses: { invoke: invoke('lens') }, html: { escape: esc },
             manifest: { ready: Promise.resolve({ ok: true }), preflight: async () => ({ ok: true }) },
             progress: { subscribe: () => () => {}, label() {} }, cache: { invalidate() {}, clear() {} }, EmbabelError: Error };
  })();`;
}
const pageHtml = (overrides, delays) => readFileSync(join(here, "../apps/ship-rate.html"), "utf8")
  .replace(/<link[^>]*apps-runtime[^>]*>\s*/g, "")
  .replace(/<script src="\/api\/v1\/apps-runtime[^"]*"><\/script>\s*/g, "")
  .replace("</head>", `<script>${stub(overrides, delays)}</script></head>`);

async function open(page, { overrides, delays, hash = "" } = {}) {
  const errors = [];
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  page.on("pageerror", (e) => errors.push(String(e)));
  await page.clock.install({ time: capturedAt });
  await page.route("http://ship-rate.test/**", (route) => route.fulfill({ contentType: "text/html", body: pageHtml(overrides, delays) }));
  await page.goto("http://ship-rate.test/ship-rate.html" + hash);
  return errors;
}
const settled = (page, repo) => expect(page.locator(cardId(repo) + " [data-state='loading']")).toHaveCount(0);

test("renders both repositories, every tile from the latest complete week, 13 buckets, no console errors", async ({ page }) => {
  const errors = await open(page, { hash: TWO });
  for (const repo of REPOS) await settled(page, repo);
  await expect(page.locator(".card[data-repo]")).toHaveCount(2);
  const lk = latestComplete("week");
  for (const repo of REPOS) {
    const all = cell(repo, "week", lk, "all");
    const card = page.locator(cardId(repo));
    await expect(card.locator("[data-tile='opened'] .val")).toHaveText(all.opened.toLocaleString("en-GB"));
    await expect(card.locator("[data-tile='merged'] .val")).toHaveText(all.merged.toLocaleString("en-GB"));
    await expect(card.locator("[data-tile='merge-rate'] .val")).toContainText(all.mergedPctOfResolved.toFixed(1));
    const opened = ["assisted", "agent", "bot"].reduce((s, k) => s + ((cell(repo, "week", lk, k) || { opened: 0 }).opened), 0);
    await expect(card.locator("[data-tile='machine-share'] .val")).toContainText((100 * opened / all.opened).toFixed(1));
    await expect(card.locator("[data-chart='volume'] g[data-bucket]")).toHaveCount(13);
    await expect(card.locator("[data-chart='merge-rate'] circle.dot")).toHaveCount(envOf(repo, "week").data.filter((r) => r.authorKind === "all" && r.mergedPctOfResolved != null).length);
    await card.locator("details.table summary").click();
    await expect(card.locator("tbody tr[data-row]")).toHaveCount(13);
    await expect(card.locator(`tbody tr[data-row='${lk}'] td`).nth(1)).toHaveText(all.opened.toLocaleString("en-GB"));
    await expect(card.locator(".meta")).toContainText("Latest complete week");
  }
  expect(errors).toEqual([]);
});

test("the badge is visible, non-empty and links out", async ({ page }) => {
  await open(page, { hash: TWO });
  const badge = page.locator("#embabel-badge");
  await expect(badge).toBeVisible();
  await expect(badge).toContainText("Embabel");
  const href = await badge.locator("a").getAttribute("href");
  expect(href).toContain("embabel.com");
  const box = await badge.boundingBox();
  const vp = page.viewportSize();
  expect(box.y + box.height).toBeLessThanOrEqual(vp.height + 1);
  expect(box.width).toBeGreaterThan(0);
});

test("switching the time box asks the view for that period's window and redraws", async ({ page }) => {
  const errors = await open(page, { hash: TWO });
  for (const repo of REPOS) await settled(page, repo);
  for (const period of ["month", "quarter", "year"]) {
    await page.locator(`#period-seg button[data-period='${period}']`).click();
    await expect(page.locator(`#period-seg button[data-period='${period}']`)).toHaveAttribute("aria-pressed", "true");
    for (const repo of REPOS) {
      await settled(page, repo);
      await expect(page.locator(cardId(repo) + " .meta")).toContainText("Latest complete " + period);
      await expect(page.locator(cardId(repo) + " [data-chart='volume'] g[data-bucket]")).toHaveCount(N[period] + 1);
      const all = cell(repo, period, latestComplete(period), "all") || { opened: 0 };
      await expect(page.locator(cardId(repo) + " [data-tile='opened'] .val")).toHaveText(all.opened.toLocaleString("en-GB"));
    }
    const calls = await page.evaluate(() => window.__calls);
    for (const repo of REPOS) expect(calls).toContain(key(argsFor(repo, period)));
  }
  expect(errors).toEqual([]);
});

test("a repository with no pull requests in the window says so, loudly, and a failed view shows its error", async ({ page }) => {
  const emptyArgs = argsFor("acme/quiet", "week"), failArgs = argsFor("acme/broken", "week");
  const overrides = {
    [key(emptyArgs)]: { status: "SUCCEEDED", outcome: "EMPTY", data: [], warnings: [], metrics: {} },
    [key(failArgs)]: { status: "FAILED", error: { message: "GitHub answered 403: rate limit exceeded" } },
  };
  const errors = await open(page, { overrides, hash: "#period=week&repos=acme/quiet,acme/broken" });
  for (const repo of ["acme/quiet", "acme/broken"]) await settled(page, repo);
  await expect(page.locator(cardId("acme/quiet") + " [data-state='empty']")).toContainText("No pull requests were opened, merged or closed in acme/quiet");
  await expect(page.locator(cardId("acme/broken") + " [data-state='error']")).toContainText("rate limit exceeded");
  await expect(page.locator(cardId("acme/broken") + " [data-tile]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("an incomplete read is flagged on the card as lower bounds", async ({ page }) => {
  const env = JSON.parse(JSON.stringify(envOf("embabel/embabel-agent-examples", "week")));
  env.warnings = ["PARTIAL_RESULT: producer 'issuesByRepo' results truncated at 4000"];
  const errors = await open(page, { overrides: { [key(argsFor("embabel/embabel-agent-examples", "week"))]: env }, hash: TWO });
  for (const repo of REPOS) await settled(page, repo);
  await expect(page.locator(cardId("embabel/embabel-agent-examples") + " [data-warnings='partial']")).toContainText("lower bound");
  await expect(page.locator(cardId("embabel/embabel-agent") + " [data-warnings]")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("adding a repository validates, refuses a duplicate, and a name the world cannot read fails loudly", async ({ page }) => {
  const errors = await open(page, { hash: TWO });
  for (const repo of REPOS) await settled(page, repo);
  await page.fill("#add-input", "not-a-repo");
  await page.click("#add-btn");
  await expect(page.locator("#add-err")).toContainText("owner/repo");
  await page.fill("#add-input", "Embabel/EMBABEL-agent-examples");
  await page.click("#add-btn");
  await expect(page.locator("#add-err")).toContainText("already on the page");
  await expect(page.locator(".card[data-repo]")).toHaveCount(2);
  await page.fill("#add-input", "https://github.com/acme/widgets/");
  await page.click("#add-btn");
  await expect(page.locator("[data-chip='acme/widgets']")).toHaveCount(1);
  await settled(page, "acme/widgets");
  await expect(page.locator(cardId("acme/widgets") + " [data-state='error']")).toContainText("NO FIXTURE");
  await expect(page.locator(".card[data-repo]")).toHaveCount(3);
  await page.click("[data-remove='acme/widgets']");
  await expect(page.locator(".card[data-repo]")).toHaveCount(2);
  await page.click("[data-remove='embabel/embabel-agent-examples']");
  await page.click("[data-remove='embabel/embabel-agent']");
  await expect(page.locator("#add-err")).toContainText("at least one");
  await expect(page.locator(".card[data-repo]")).toHaveCount(1);
  expect(errors).toEqual([]);
});

test("a control answers at once while a slow call is in flight, and the slow result never paints over the newer choice", async ({ page }) => {
  const slowKey = key(argsFor("embabel/embabel-agent-examples", "week"));
  const errors = await open(page, { delays: { [slowKey]: 700 }, hash: TWO });
  await settled(page, "embabel/embabel-agent");
  await expect(page.locator(cardId("embabel/embabel-agent-examples") + " [data-state='loading']")).toHaveCount(1);
  await page.locator("#period-seg button[data-period='quarter']").click();
  await expect(page.locator("#period-seg button[data-period='quarter']")).toHaveAttribute("aria-pressed", "true");
  await page.clock.runFor(1000);
  for (const repo of REPOS) await settled(page, repo);
  await expect(page.locator(cardId("embabel/embabel-agent-examples") + " .meta")).toContainText("Latest complete quarter");
  await expect(page.locator(cardId("embabel/embabel-agent-examples") + " [data-chart='volume'] g[data-bucket]")).toHaveCount(N.quarter + 1);
  expect(errors).toEqual([]);
});

test("hovering a bucket shows its breakdown, and How it works opens in-page with the query that runs", async ({ page }) => {
  const errors = await open(page, { hash: TWO });
  for (const repo of REPOS) await settled(page, repo);
  await page.locator(cardId("embabel/embabel-agent-examples") + " [data-hit='volume']").first().hover();
  await expect(page.locator("#tip")).toBeVisible();
  await expect(page.locator("#tip")).toContainText("Opened");
  await page.click("footer a[href='#how-it-works']");
  await expect(page.locator("#how-it-works")).toBeVisible();
  await expect(page.locator("#how-it-works pre")).toContainText("date.truncate($period");
  await expect(page.locator("#how-it-works")).toContainText("assisted");
  expect(errors).toEqual([]);
});
