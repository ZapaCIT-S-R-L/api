// The membership events this API produces must match what the chat service consumes: MembershipEvent (and the
// schemas it references) in openapi.yaml and services/chat/openapi.yaml are identical. Skipped until the chat
// service is in the repo.
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { parse } from "yaml";

const root = new URL("../../openapi.yaml", import.meta.url);
const chat = new URL("../../services/chat/openapi.yaml", import.meta.url);

test("MembershipEvent is the same in the account and chat specs", { skip: !existsSync(chat) }, () => {
  const a = parse(readFileSync(root, "utf8")).components.schemas;
  const b = parse(readFileSync(chat, "utf8")).components.schemas;
  for (const name of ["MembershipEvent", "AccountId", "Role", "DeviceId"]) {
    assert.deepEqual(a[name], b[name], `${name} differs between openapi.yaml and services/chat/openapi.yaml`);
  }
});

test("the account spec defines MembershipEvent with the family events it sends", () => {
  const schema = parse(readFileSync(root, "utf8")).components.schemas.MembershipEvent;
  assert.ok(schema.properties.type.enum.includes("family.member_added"));
  assert.ok(schema.properties.type.enum.includes("family.member_removed"));
  assert.ok(schema.properties.type.enum.includes("device.removed"));
  assert.ok(schema.properties.type.enum.includes("account.sessions_revoked"));
  const revoked = schema.oneOf.find((v) => v.title === "account.sessions_revoked");
  assert.deepEqual(revoked.required, ["type", "accountId", "epoch"]);
});
