import { expect, test } from "bun:test";

import { parseMuseUsage } from "./muse-usage";

test("Muse usage preserves both provider windows and their snapshot time", () => {
  expect(
    parseMuseUsage({
      schemaVersion: 1,
      reason: null,
      allowance: {
        asOfMs: 1_795_528_432_820,
        source: "mint",
        tier: "Muse Code Power Usage",
        weekly: { resetsAtMs: 1_795_996_800_000, usedPercent: 98 },
        window: { resetsAtMs: 1_795_531_372_000, usedPercent: 83 },
      },
    }),
  ).toEqual({
    fetchedAt: 1_795_528_432_820,
    tier: "Muse Code Power Usage",
    windows: [
      { label: "rolling", percent: 83, resetsAt: 1_795_531_372_000 },
      { label: "wk", percent: 98, resetsAt: 1_795_996_800_000 },
    ],
  });
});

test("Muse usage without an allowance remains unknown", () => {
  expect(parseMuseUsage({ schemaVersion: 1, reason: "server_sent_no_usage", allowance: null })).toBeUndefined();
  expect(parseMuseUsage({ schemaVersion: 1, allowance: { weekly: { usedPercent: "98" } } })).toBeUndefined();
});
