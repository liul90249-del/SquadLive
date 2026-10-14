import test from "node:test";
import assert from "node:assert/strict";
import { clientIPAddress } from "../client-network.mjs";

test("Render uses its forwarded client IP instead of conflicting caller headers", () => {
  const req = {
    headers: {
      "x-forwarded-for": "203.0.113.9, 10.0.0.4",
      "cf-connecting-ip": "17.0.0.1",
      "true-client-ip": "17.0.0.2",
      "x-real-ip": "17.0.0.3",
      "cf-ipcountry": "US"
    },
    socket: { remoteAddress: "10.0.0.4" }
  };
  assert.equal(clientIPAddress(req, { onRender: true }), "203.0.113.9");
});

test("Direct connections ignore all caller-provided forwarding headers", () => {
  const req = {
    headers: { "x-forwarded-for": "17.0.0.1", "cf-connecting-ip": "17.0.0.2" },
    socket: { remoteAddress: "::ffff:192.0.2.10" }
  };
  assert.equal(clientIPAddress(req, { onRender: false }), "192.0.2.10");
});
