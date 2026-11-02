/*
 * The verbs call `gateway.gh` the way the host will accept.
 *
 * The host only lets a guest call an operation listed in apis/apis.yml, and it checks the
 * arguments strictly: every argument other than `body` has to be a path or query parameter the
 * spec declares, and a write's body has to fit the request body schema exactly, with no extra
 * keys. A mismatch is refused at call time, so a mocked gateway on its own would never notice.
 * These tests run each verb against a recording gateway and check what it sent against the
 * vendored spec and the allowlist.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { entityForTest, mockGateway } from "@embabel/runtime-types";
import type { GenericGatewayContext } from "@embabel/runtime-types";
import { GitHubIssue } from "../src/api/issue";
import { GitHubPullRequest } from "../src/api/pull-request";

const root = new URL("../", import.meta.url).pathname;

/** The ids listed under one key of apis.yml, read line by line. */
function listedIds(key: string): string[] {
  const lines = readFileSync(join(root, "apis/apis.yml"), "utf8").split("\n");
  const start = lines.findIndex((line) => line.trim() === `${key}:`);
  if (start < 0) return [];
  const ids: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    if (!trimmed.startsWith("- ")) break;
    ids.push(trimmed.slice(2).trim());
  }
  return ids;
}

const writes = listedIds("write-operation-ids");
const reads = listedIds("operation-ids");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const spec: Json = JSON.parse(readFileSync(join(root, "apis/api.github.com.json"), "utf8"));

function resolve(node: Json): Json {
  if (!node?.$ref) return node;
  return resolve(node.$ref.slice(2).split("/").reduce((at: Json, part: string) => at[part], spec));
}

interface Operation {
  params: { name: string; in: string; required: boolean }[];
  body?: Json;
}

const operations = new Map<string, Operation>();
for (const path of Object.values<Json>(spec.paths)) {
  for (const op of Object.values<Json>(path)) {
    if (!op?.operationId) continue;
    operations.set(op.operationId, {
      params: (op.parameters ?? []).map(resolve).map((p: Json) => ({ name: p.name, in: p.in, required: !!p.required })),
      body: op.requestBody?.content?.["application/json"]?.schema,
    });
  }
}

/** The host's body rules: closed objects, required keys, typed arrays, scalar kinds and enums. */
function fits(schema: Json, value: Json, at: string): string[] {
  const s = resolve(schema);
  switch (s.type) {
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) return [`${at} is not an object`];
      const props = s.properties ?? {};
      const extra = Object.keys(value).filter((k) => !(k in props)).map((k) => `${at}.${k} is not declared`);
      const missing = (s.required ?? []).filter((k: string) => !(k in value)).map((k: string) => `${at}.${k} is required`);
      const nested = Object.keys(value).filter((k) => k in props).flatMap((k) => fits(props[k], value[k], `${at}.${k}`));
      return [...extra, ...missing, ...nested];
    }
    case "array":
      return Array.isArray(value) ? value.flatMap((v, i) => fits(s.items, v, `${at}[${i}]`)) : [`${at} is not an array`];
    default: {
      const kind =
        (s.type === "string" && typeof value === "string") ||
        (s.type === "integer" && Number.isInteger(value)) ||
        (s.type === "number" && Number.isFinite(value)) ||
        (s.type === "boolean" && typeof value === "boolean");
      if (!kind) return [`${at} is not a ${s.type}`];
      return s.enum && !s.enum.includes(value) ? [`${at} is off its enum`] : [];
    }
  }
}

/** Keywords outside the subset the host reads from a write's request body. */
function unsupported(schema: Json, at: string): string[] {
  const allowed = new Set(["type", "properties", "required", "items", "enum", "description"]);
  const here = Object.keys(schema).filter((k) => !allowed.has(k)).map((k) => `${at}/${k}`);
  const props = Object.entries<Json>(schema.properties ?? {}).flatMap(([k, v]) => unsupported(v, `${at}/properties/${k}`));
  const items = schema.items ? unsupported(schema.items, `${at}/items`) : [];
  return [...here, ...props, ...items];
}

/** Every `gh["..."]` id the verb sources call. */
const calledIds = [
  ...new Set(
    readdirSync(join(root, "src/api"))
      .filter((name) => name.endsWith(".ts"))
      .flatMap((name) => [...readFileSync(join(root, "src/api", name), "utf8").matchAll(/gh\["([^"]+)"\]\(/g)].map((m) => m[1])),
  ),
];

interface Call {
  id: string;
  args: Json;
}

function recorder() {
  const calls: Call[] = [];
  const gh = Object.fromEntries(
    calledIds.map((id) => [id, async (args: Json) => {
      // What goes on the wire: JSON drops keys whose value is undefined.
      calls.push({ id, args: JSON.parse(JSON.stringify(args)) });
      return {};
    }]),
  );
  return { calls, gateway: mockGateway<GenericGatewayContext>({ gh }) };
}

async function everyVerbCall(): Promise<Call[]> {
  const { calls, gateway } = recorder();
  const issue = entityForTest(GitHubIssue, { html_url: "https://github.com/octocat/hello-world/issues/42", number: 42 }, gateway);
  await issue.close();
  await issue.reopen();
  await issue.comment("text");
  await issue.addLabels("bug");
  await issue.assign("octocat");
  const pr = entityForTest(GitHubPullRequest, { html_url: "https://github.com/octocat/hello-world/pull/7", number: 7 }, gateway);
  await pr.merge();
  await pr.merge({ method: "rebase", title: "t", message: "m" });
  await pr.requestReviewers("alice");
  await pr.close();
  await pr.reopen();
  await pr.comment("text");
  await pr.addLabels("bug");
  await pr.assign("octocat");
  return calls;
}

describe("the gh operations the verbs call", () => {
  it("no id is listed as both a read and a write", () => {
    expect(writes.length).toBeGreaterThan(0);
    expect(writes.filter((id) => reads.includes(id))).toEqual([]);
  });

  it("every id the verbs call is listed and present in the spec", () => {
    expect(calledIds.length).toBeGreaterThan(0);
    for (const id of calledIds) {
      expect(writes.includes(id) || reads.includes(id), `${id} is not in apis.yml`).toBe(true);
      expect(operations.has(id), `${id} is not in the spec`).toBe(true);
    }
  });

  it("every listed write has a request body in the subset the host reads", () => {
    for (const id of writes) {
      const body = operations.get(id)?.body;
      expect(body, `${id} has no request body`).toBeDefined();
      expect(unsupported(resolve(body), id), id).toEqual([]);
    }
  });

  it("every call passes declared parameters, with the body under `body` fitting its schema", async () => {
    const calls = await everyVerbCall();
    expect(new Set(calls.map((c) => c.id))).toEqual(new Set(calledIds));
    for (const { id, args } of calls) {
      const op = operations.get(id);
      if (!op) throw new Error(`${id} is not in the spec`);
      const { body, ...rest } = args;
      const declared = op.params.filter((p) => p.in === "path" || p.in === "query").map((p) => p.name);
      expect(Object.keys(rest).filter((k) => !declared.includes(k)), `${id}: undeclared arguments`).toEqual([]);
      const missing = op.params.filter((p) => p.required && !(p.name in rest)).map((p) => p.name);
      expect(missing, `${id}: missing parameters`).toEqual([]);
      if (writes.includes(id)) {
        expect(body, `${id}: a write sends its body under body`).toBeDefined();
        expect(fits(op.body, body, "body"), id).toEqual([]);
      } else {
        expect(body, `${id}: a read sends no body`).toBeUndefined();
      }
    }
  });
});
