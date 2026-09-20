import assert from "node:assert/strict";
import { stat, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

// The installed plugin runtime is intentionally plain ESM without a build step.
// @ts-expect-error JavaScript plugin helper has no declaration file.
import * as offlineRuntime from "../scripts/offline-travel.mjs";

const {
  lockOfflineProgress, offlineStatus, openOfflineDatabase, prepareOfflineProgress,
  startOfflineJourney, submitOfflineProgress,
} = offlineRuntime;

const HOME = {
  provider: "amap",
  placeId: "home-1",
  name: "家园",
  address: "测试家园",
  district: "东城区",
  city: "北京市",
  province: "北京市",
  adcode: "110101",
  longitude: 116.4,
  latitude: 39.9,
};

function permit(issuedAt: string) {
  return {
    schemaVersion: "offline-sync-v1",
    permit: "a".repeat(43),
    permitId: "00000000-0000-4000-8000-000000000001",
    issuedAt,
    baselineHash: "b".repeat(64),
    balanceReference: "5000",
    firstJourneyFreeAvailable: true,
    pet: {
      name: "团子",
      heightCm: 36,
      personality: ["好奇"],
      home: HOME,
      visual: { source: "official", assetId: "shiba", displayName: "柴犬", description: "测试", imageUrl: "https://example.test/pet.png", fingerprint: "c".repeat(64) },
      journeyCount: 0,
    },
    rules: {
      rulesetVersion: "journey-rules-v1",
      activityCatalogVersion: "activity-v1",
      maximumVirtualDays: 28,
      firstJourneyRealMinutesPerVirtualDay: 1 / 6,
      laterJourneyRealMinutesPerVirtualDay: 1 / 6,
      maximumEventsPerSync: 64,
      encounterRate: 0.3,
    },
    defaultRoute: { id: "tibet-autumn-loop-v1", title: "测试路线", travelMode: "self-drive", days: [] },
    unlockedEncounterCodes: [],
    classicEncounterCatalog: [],
  };
}

test("offline SQLite keeps a durable pending journey without storing player credentials", async () => {
  const root = await mkdtemp(join(tmpdir(), "wondertoken-offline-"));
  const issuedAt = "2026-09-03T00:00:00.000Z";
  let db = await openOfflineDatabase(root);
  const snapshot = permit(issuedAt);
  db.prepare("INSERT INTO permits (id,token,snapshot_json,status,issued_at) VALUES (?,?,?,?,?)")
    .run(snapshot.permitId, snapshot.permit, JSON.stringify(snapshot), "available", issuedAt);
  const started = startOfflineJourney(db, {
    journeyId: "00000000-0000-4000-8000-000000000010",
    eventId: "00000000-0000-4000-8000-000000000011",
    startedAt: "2026-09-03T00:01:00.000Z",
  });
  assert.equal(started.pending, true);
  const prepared = prepareOfflineProgress(db, {
    eventId: "00000000-0000-4000-8000-000000000012",
    asOf: "2026-09-03T00:01:20.000Z",
  });
  assert.equal(prepared.progressAvailable, true);
  assert.equal(prepared.elapsedTravelDays, 2);
  lockOfflineProgress(db, {
    eventId: prepared.eventId,
    toAt: prepared.window.toAt,
    movements: [],
    activities: [],
    expenses: [],
    expenseTotal: "0",
    returnExpenseEstimate: "0",
    finalize: false,
  });
  const paragraph = "团子把沿途风声和光影记进旅行本，也记得这一切仍要等旅行信箱确认。";
  const content = [paragraph.repeat(5), paragraph.repeat(5), paragraph.repeat(5)].join("\n\n");
  const submitted = submitOfflineProgress(db, {
    occurredAt: "2026-09-03T00:01:21.000Z",
    content,
    continuity: {
      currentSituation: "仍在家园附近观察",
      petMood: "好奇",
      recentFacts: ["记下风声"],
      openThreads: [],
    },
  });
  assert.equal(submitted.notice, "待旅行信箱确认");
  assert.equal(offlineStatus(db).pendingCount, 2);
  db.close();

  db = await openOfflineDatabase(root);
  assert.equal(offlineStatus(db).pendingCount, 2);
  assert.equal(JSON.stringify(offlineStatus(db)).includes("playerKey"), false);
  db.close();
  if (process.platform !== "win32") assert.equal((await stat(root)).mode & 0o777, 0o700);
  if (process.platform !== "win32") assert.equal((await stat(join(root, "offline.sqlite"))).mode & 0o777, 0o600);
});


test("offline first and paid journeys preserve fractional days and the 280-second cap", async () => {
  for (const free of [true, false]) {
    const root = await mkdtemp(join(tmpdir(), "wondertoken-fast-offline-"));
    const issuedAt = "2026-09-03T00:00:00.000Z";
    const db = await openOfflineDatabase(root);
    try {
      const snapshot = permit(issuedAt);
      snapshot.firstJourneyFreeAvailable = free;
      db.prepare("INSERT INTO permits (id,token,snapshot_json,status,issued_at) VALUES (?,?,?,?,?)")
        .run(snapshot.permitId, snapshot.permit, JSON.stringify(snapshot), "available", issuedAt);
      startOfflineJourney(db, { startedAt: issuedAt });
      for (const [seconds, days] of [[5, 0.5], [10, 1], [280, 28], [290, 28]] as const) {
        const prepared = prepareOfflineProgress(db, {
          asOf: new Date(Date.parse(issuedAt) + seconds * 1000).toISOString(),
        });
        assert.equal(prepared.elapsedTravelDays, days);
      }
    } finally { db.close(); }
  }
});

test("offline default first route caps at ten days while explicit free travel keeps 28", async () => {
  for (const routePreference of [undefined, "free"]) {
    const db = await openOfflineDatabase(await mkdtemp(join(tmpdir(), "wondertoken-offline-ten-")));
    try {
      const issuedAt = "2026-09-03T00:00:00.000Z";
      const snapshot = { ...permit(issuedAt), defaultRoute: { id: "tibet-autumn-loop-v1", title: "十日", travelMode: "self-drive", days: [{ day: 10 }] } };
      db.prepare("INSERT INTO permits (id,token,snapshot_json,status,issued_at) VALUES (?,?,?,?,?)")
        .run(snapshot.permitId, snapshot.permit, JSON.stringify(snapshot), "available", issuedAt);
      startOfflineJourney(db, { startedAt: issuedAt, routePreference });
      const prepared = prepareOfflineProgress(db, { asOf: "2026-09-03T01:00:00.000Z" });
      assert.equal(prepared.elapsedTravelDays, routePreference ? 28 : 10);
      assert.equal(prepared.window.automaticHomecoming, true);
      assert.equal(prepared.window.completionTrigger, routePreference ? "maximum-duration" : "planned-homecoming");
      if (routePreference) assert.equal(prepared.routePlan, undefined);
    } finally { db.close(); }
  }
});
