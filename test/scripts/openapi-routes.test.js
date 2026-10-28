// Every fixed route the account API serves is documented in openapi.yaml, method by method. A merge once dropped
// PATCH /v1/me from the spec while the Worker still served it (#74).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "yaml";

const read = (path) => readFileSync(new URL(`../../${path}`, import.meta.url), "utf8");
const spec = parse(read("openapi.yaml"));
const routes = [...read("src/index.ts").matchAll(/^\s*"(\/[^"]*)": \{\s*method: "([^"]+)"/gm)];

test("the route table is found", () => {
  assert.ok(routes.length > 10);
});

for (const [, path, methods] of routes) {
  for (const method of methods.split(",").map((m) => m.trim().toLowerCase())) {
    test(`${method.toUpperCase()} ${path} is documented`, () => {
      assert.ok(spec.paths[path]?.[method], `${method.toUpperCase()} ${path} is missing from openapi.yaml`);
    });
  }
}
