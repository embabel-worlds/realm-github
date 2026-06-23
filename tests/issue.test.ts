/**
 * Tests for the `GitHubIssue` verb class. Each runs against a MOCKED gateway (no
 * live GitHub, no OAuth): `entityForTest` builds a real `GitHubIssue` with its
 * fields set and the mock gateway injected — exactly what the host does after
 * virtual cypher materializes the issue — so the verb under test runs unchanged.
 *
 * Pure verbs are asserted by their return value; effectful verbs by the
 * `gateway.gh.*` op they call and the args they pass (owner/repo parsed from
 * html_url, issue_number from number). A fixed `now` keeps age math deterministic.
 */
import { describe, it, expect, vi } from "vitest";
import { entityForTest, mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { GitHubIssue } from "../src/api/issue";

const NOW = Date.parse("2026-06-22T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function issue(fields: Partial<GitHubIssue>, gh: Record<string, (args: any) => any> = {}) {
  return entityForTest(
    GitHubIssue,
    { html_url: "https://github.com/octocat/hello-world/issues/42", number: 42, state: "open", ...fields },
    mockGateway<GenericGatewayContext>({ gh }),
  );
}

describe("GitHubIssue pure verbs", () => {
  it("ageDays / daysSinceUpdate compute from the timestamps", () => {
    const i = issue({ created_at: daysAgo(10), updated_at: daysAgo(3) });
    expect(i.ageDays(NOW)).toBe(10);
    expect(i.daysSinceUpdate(NOW)).toBe(3);
  });

  it("isStale: open and untouched past the window", () => {
    expect(issue({ updated_at: daysAgo(40) }).isStale(30, NOW)).toBe(true);
    expect(issue({ updated_at: daysAgo(5) }).isStale(30, NOW)).toBe(false);
    expect(issue({ state: "closed", updated_at: daysAgo(40) }).isStale(30, NOW)).toBe(false);
  });

  it("needsTriage: open, no comments, older than the window", () => {
    expect(issue({ created_at: daysAgo(10), comments: 0 }).needsTriage(7, NOW)).toBe(true);
    expect(issue({ created_at: daysAgo(10), comments: 3 }).needsTriage(7, NOW)).toBe(false);
    expect(issue({ created_at: daysAgo(2), comments: 0 }).needsTriage(7, NOW)).toBe(false);
  });

  it("repoRef / ref parse owner+repo from html_url", () => {
    const i = issue({});
    expect(i.repoRef()).toEqual({ owner: "octocat", repo: "hello-world" });
    expect(i.ref()).toBe("octocat/hello-world#42");
  });

  it("repoRef throws when html_url can't be located", () => {
    expect(() => issue({ html_url: "not-a-github-url" }).repoRef()).toThrow(/cannot locate owner\/repo/);
  });
});

describe("GitHubIssue effectful verbs", () => {
  it("close updates state to closed with a reason, scoped to the parsed repo", async () => {
    const issues_update = vi.fn().mockResolvedValue({ number: 42, state: "closed" });
    const r = await issue({}, { issues_update }).close("not_planned");

    expect(issues_update).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      state: "closed",
      state_reason: "not_planned",
    });
    expect(r).toMatchObject({ state: "closed" });
  });

  it("reopen sets state open", async () => {
    const issues_update = vi.fn().mockResolvedValue({ number: 42, state: "open" });
    await issue({}, { issues_update }).reopen();
    expect(issues_update).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      state: "open",
      state_reason: "reopened",
    });
  });

  it("comment creates a comment", async () => {
    const issues_create_comment = vi.fn().mockResolvedValue({ id: 1 });
    await issue({}, { issues_create_comment }).comment("ping — still relevant?");
    expect(issues_create_comment).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      body: "ping — still relevant?",
    });
  });

  it("addLabels passes the labels array", async () => {
    const issues_add_labels = vi.fn().mockResolvedValue([]);
    await issue({}, { issues_add_labels }).addLabels("stale", "needs-triage");
    expect(issues_add_labels).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      labels: ["stale", "needs-triage"],
    });
  });

  it("assign passes the assignees array", async () => {
    const issues_add_assignees = vi.fn().mockResolvedValue([]);
    await issue({}, { issues_add_assignees }).assign("octocat");
    expect(issues_add_assignees).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      issue_number: 42,
      assignees: ["octocat"],
    });
  });

  it("an effectful verb refuses when the repo can't be located", async () => {
    const issues_update = vi.fn();
    await expect(issue({ html_url: "garbage" }, { issues_update }).close()).rejects.toThrow(/cannot locate/);
    expect(issues_update).not.toHaveBeenCalled();
  });
});
