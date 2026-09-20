import assert from "node:assert/strict";
import test from "node:test";
import { formatTravelDays, renderDelivery } from "../skills/wondertoken/scripts/progress-run.mjs";

test("travel days use a concise value in the final presentation", () => {
  assert.equal(formatTravelDays(6), "6");
  assert.equal(formatTravelDays(6.04), "6");
  assert.equal(formatTravelDays(6.14), "6.1");
  assert.equal(formatTravelDays(6.16), "6.2");
});

test("final travel delivery uses playful semantic emoji labels", () => {
  const output = renderDelivery({
    presentation: { content: "今天看见了雪山。", originalCost: "120", charged: "80", balance: "920", travelDays: 6 },
    itinerary: "第6天：看雪山",
    route: "拉萨 → 林芝",
    images: "![旅行纪念照](/tmp/memory.png)",
  });

  for (const label of ["📮 今天", "🧭 行程摘要", "🗺️ 实际路线", "🪙 原始费用", "💸 实际扣费", "👛 余额", "🗓️ 旅行日", "📸 旅行纪念照"])
    assert.match(output, new RegExp(label, "u"));
});
