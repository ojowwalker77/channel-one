// Which check each room route declares (src/relay/route.ts). Loosening one is a deliberate edit here.

import { expect, test } from "bun:test";
import { routeTable } from "../src/relay/route.ts";

test("every route declares its check", () => {
  expect(routeTable.map((r) => `${r.method} ${r.path} ${r.guard}`)).toEqual([
    "GET /info public",
    "POST /create public",
    "POST /requests public",
    "GET /usage public",
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
