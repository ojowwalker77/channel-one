// Which check each room route declares (src/relay/route.ts). Loosening one is a deliberate edit here.

import { expect, test } from "bun:test";
import { routeTable } from "../src/relay/route.ts";

test("every route declares its check", () => {
  expect(routeTable.map((r) => `${r.method} ${r.path} ${r.guard}`)).toEqual([
    "GET /info public",
    "POST /create creator",
    "POST /requests joiner",
    "GET /usage ownerPerson",
    "POST /^\\/requests\\/([0-9a-f-]{36})\\/reveal$/ requester",
    "GET /^\\/requests\\/([0-9a-f-]{36})$/ requester",
    "GET / member",
    "GET /messages member",
    "POST /messages member",
    "GET /keys member",
    "GET /icon member",
    "PUT /icon owner",
    "PUT /title owner",
    "GET /members member",
    "DELETE /members/me member",
    "GET /requests member",
    "POST /^\\/requests\\/([0-9a-f-]{36})\\/nonce$/ owner",
    "POST /^\\/requests\\/([0-9a-f-]{36})\\/deny$/ owner",
    "POST /members owner",
    "DELETE /^\\/members\\/([A-Za-z0-9_-]{20,})$/ owner",
    "POST /epochs owner",
    "DELETE / owner",
  ]);
});

test("the only public room route is the one meant to be", () => {
  // GET /info answers anyone holding the join code (it's how a joiner pins the owner key). A new public
  // row has to be added here on purpose, with its own refusal rows in the auth table if it checks anything.
  expect(routeTable.filter((r) => r.guard === "public").map((r) => `${r.method} ${r.path}`)).toEqual(["GET /info"]);
});

test("a person's routes declare their checks too, and only the link page is public", async () => {
  const { vaultRouteTable } = await import("../src/relay/vault.ts");
  const { deviceRouteTable } = await import("../src/relay/devices.ts");
  const { machineRouteTable } = await import("../src/relay/machines.ts");
  const rows = [...vaultRouteTable, ...deviceRouteTable, ...machineRouteTable].map((r) => `${r.method} ${r.path} ${r.guard}`);
  expect(rows).toEqual([
    "GET /v1/me/vault person",
    "PUT /v1/me/vault person",
    "DELETE /v1/me/vault person",
    "POST /v1/me/devices/transfers person",
    "HEAD /^\\/v1\\/me\\/devices\\/transfers\\/([0-9a-f-]{36})$/ person",
    "GET /^\\/v1\\/me\\/devices\\/transfers\\/([0-9a-f-]{36})$/ person",
    "DELETE /^\\/v1\\/me\\/devices\\/transfers\\/([0-9a-f-]{36})$/ person",
    "POST /v1/machines selfSigned",
    "GET /^\\/v1\\/machines\\/([A-Za-z0-9_-]{20,})\\/public$/ public",
    "POST /^\\/v1\\/machines\\/([A-Za-z0-9_-]{20,})\\/confirm$/ person",
    "GET /^\\/v1\\/machines\\/([A-Za-z0-9_-]{20,})$/ computer",
    "DELETE /^\\/v1\\/machines\\/([A-Za-z0-9_-]{20,})$/ computer",
    "GET /v1/me/machines person",
    "DELETE /^\\/v1\\/me\\/machines\\/([A-Za-z0-9_-]{20,})$/ person",
  ]);
  // The confirm page shows a pending link's label and code to whoever has the link: nothing secret.
  expect(rows.filter((r) => r.endsWith(" public"))).toEqual(["GET /^\\/v1\\/machines\\/([A-Za-z0-9_-]{20,})\\/public$/ public"]);
});
