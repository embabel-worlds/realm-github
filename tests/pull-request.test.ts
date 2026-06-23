/**
 * Tests for the `GitHubPullRequest` verb class — the PR-shaped sibling of
 * `GitHubIssue`. Same mocked-gateway approach: `entityForTest` builds a real PR
 * with its fields set and the mock `gateway.gh` injected, so the verb runs
 * unchanged. Pure verbs asserted by return value; effectful by the op + args
 * (owner/repo parsed from a `/pull/` html_url, pull_number from number).
 */
import { describe, it, expect, vi } from "vitest";
import { entityForTest, mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { GitHubPullRequest } from "../src/api/pull-request";

const NOW = Date.parse("2026-06-22T00:00:00Z");
const daysAgo = (n: number) => new Date(NOW - n * 86_400_000).toISOString();

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function pr(fields: Partial<GitHubPullRequest>, gh: Record<string, (args: any) => any> = {}) {
  return entityForTest(
    GitHubPullRequest,
    { html_url: "https://github.com/octocat/hello-world/pull/7", number: 7, state: "open", ...fields },
    mockGateway<GenericGatewayContext>({ gh }),
  );
}

describe("GitHubPullRequest pure verbs", () => {
  it("ageDays / daysSinceUpdate compute from the timestamps", () => {
    const p = pr({ created_at: daysAgo(20), updated_at: daysAgo(2) });
    expect(p.ageDays(NOW)).toBe(20);
    expect(p.daysSinceUpdate(NOW)).toBe(2);
  });

  it("isDraft / isReadyForReview track the draft + state flags", () => {
    expect(pr({ draft: true }).isDraft()).toBe(true);
    expect(pr({ draft: true }).isReadyForReview()).toBe(false);
    expect(pr({ draft: false }).isReadyForReview()).toBe(true);
    expect(pr({ state: "closed", draft: false }).isReadyForReview()).toBe(false);
  });

  it("isStale: open and untouched past the window", () => {
    expect(pr({ updated_at: daysAgo(20) }).isStale(14, NOW)).toBe(true);
    expect(pr({ updated_at: daysAgo(3) }).isStale(14, NOW)).toBe(false);
  });

  it("repoRef / ref parse owner+repo from a /pull/ html_url", () => {
    expect(pr({}).repoRef()).toEqual({ owner: "octocat", repo: "hello-world" });
    expect(pr({}).ref()).toBe("octocat/hello-world#7");
  });

  it("repoRef throws when html_url can't be located", () => {
    expect(() => pr({ html_url: "not-a-github-url" }).repoRef()).toThrow(/cannot locate owner\/repo/);
  });
});

describe("GitHubPullRequest effectful verbs", () => {
  it("merge defaults to squash and passes pull_number to pulls_merge", async () => {
    const pulls_merge = vi.fn().mockResolvedValue({ merged: true, sha: "abc" });
    const r = await pr({}, { pulls_merge }).merge();

    expect(pulls_merge).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      pull_number: 7,
      merge_method: "squash",
      commit_title: undefined,
      commit_message: undefined,
    });
    expect(r).toMatchObject({ merged: true });
  });

  it("merge honours an explicit method + commit message", async () => {
    const pulls_merge = vi.fn().mockResolvedValue({ merged: true });
    await pr({}, { pulls_merge }).merge({ method: "rebase", title: "Ship it", message: "details" });
    expect(pulls_merge).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      pull_number: 7,
      merge_method: "rebase",
      commit_title: "Ship it",
      commit_message: "details",
    });
  });

  it("requestReviewers passes the reviewers array", async () => {
    const pulls_request_reviewers = vi.fn().mockResolvedValue({ number: 7 });
    await pr({}, { pulls_request_reviewers }).requestReviewers("alice", "bob");
    expect(pulls_request_reviewers).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      pull_number: 7,
      reviewers: ["alice", "bob"],
    });
  });

  it("close uses the issues endpoint with the PR number", async () => {
    const issues_update = vi.fn().mockResolvedValue({ number: 7, state: "closed" });
    await pr({}, { issues_update }).close();
    expect(issues_update).toHaveBeenCalledWith({
      owner: "octocat",
      repo: "hello-world",
      issue_number: 7,
      state: "closed",
      state_reason: "not_planned",
    });
  });

  it("comment / addLabels / assign reuse the issues ops keyed by the PR number", async () => {
    const issues_create_comment = vi.fn().mockResolvedValue({ id: 1 });
    const issues_add_labels = vi.fn().mockResolvedValue([]);
    const issues_add_assignees = vi.fn().mockResolvedValue([]);
    const p = pr({}, { issues_create_comment, issues_add_labels, issues_add_assignees });

    await p.comment("LGTM");
    await p.addLabels("needs-review");
    await p.assign("octocat");

    expect(issues_create_comment).toHaveBeenCalledWith({ owner: "octocat", repo: "hello-world", issue_number: 7, body: "LGTM" });
    expect(issues_add_labels).toHaveBeenCalledWith({ owner: "octocat", repo: "hello-world", issue_number: 7, labels: ["needs-review"] });
    expect(issues_add_assignees).toHaveBeenCalledWith({ owner: "octocat", repo: "hello-world", issue_number: 7, assignees: ["octocat"] });
  });

  it("an effectful verb refuses when the repo can't be located", async () => {
    const pulls_merge = vi.fn();
    await expect(pr({ html_url: "garbage" }, { pulls_merge }).merge()).rejects.toThrow(/cannot locate/);
    expect(pulls_merge).not.toHaveBeenCalled();
  });
});
