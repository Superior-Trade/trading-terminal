import assert from "node:assert/strict";
import { test } from "vitest";

import {
  beforeSendFilterLocalhost,
  isLocalhostHost,
  shouldEnableSentry,
} from "./sentry-config.ts";

test("isLocalhostHost detects loopback hosts", () => {
  for (const host of [
    "localhost",
    "localhost:3200",
    "127.0.0.1",
    "127.0.0.1:3200",
    "127.10.20.30",
    "[::1]",
    "::1",
    "0.0.0.0",
  ]) {
    assert.equal(isLocalhostHost(host), true);
  }

  assert.equal(isLocalhostHost("terminal.superior.trade"), false);
});

test("shouldEnableSentry requires a DSN and rejects development and localhost", () => {
  assert.equal(shouldEnableSentry(undefined, "terminal.superior.trade"), false);
  assert.equal(
    shouldEnableSentry("https://example@sentry.io/1", {
      hostname: "terminal.superior.trade",
      nodeEnv: "development",
    }),
    false,
  );
  assert.equal(
    shouldEnableSentry("https://example@sentry.io/1", "localhost"),
    false,
  );
  assert.equal(
    shouldEnableSentry("https://example@sentry.io/1", "terminal.superior.trade"),
    true,
  );
});

test("beforeSendFilterLocalhost drops localhost request events", () => {
  const event = { request: { url: "http://localhost:3200/deployments" } };

  assert.equal(beforeSendFilterLocalhost(event), null);
  assert.equal(
    beforeSendFilterLocalhost({
      request: { headers: { Host: "127.0.0.1:3200" } },
    }),
    null,
  );
  assert.deepEqual(
    beforeSendFilterLocalhost({
      request: { url: "https://terminal.superior.trade/deployments" },
    }),
    { request: { url: "https://terminal.superior.trade/deployments" } },
  );
});

test("beforeSendFilterLocalhost drops known Hyperliquid large payload transactions", () => {
  const event = {
    type: "transaction",
    spans: [
      {
        op: "http.client",
        description: "POST https://api.hyperliquid.xyz/info",
        data: {
          "http.response_content_length": 220235,
          "http.request_method": "POST",
          "http.url": "https://api.hyperliquid.xyz/info",
        },
      },
    ],
    request: { url: "https://terminal.superior.trade/backtests" },
  };

  assert.equal(beforeSendFilterLocalhost(event), null);
});
