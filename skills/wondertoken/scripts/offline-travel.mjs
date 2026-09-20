#!/usr/bin/env node
import { isMain } from "./local.mjs";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, stat, mkdtemp, writeFile, rm } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { realisticFacts, realisticWindowEnd } from "./offline-itinerary.generated.mjs";
import { DatabaseSync } from "node:sqlite";

const scriptRoot = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptRoot, "..");
import { cli, localConnection, stateRoot, protect, withStateLock } from "./local.mjs";
const databasePath = join(stateRoot, "offline.sqlite");
const MAX_EVENTS = 64;
const ACTIVITY_CATEGORIES = new Set([
  "sightseeing", "culture", "nature", "outdoor", "food", "craft",
  "local-life", "rest", "shopping", "transit", "other",
]);
const ACTIVITY_TAGS = new Set([
  "landmark", "museum", "historic-site", "exhibition", "hiking", "cycling",
  "self-drive", "boat", "night-tour", "sunrise-sunset", "snow", "lake-mountain",
  "wildlife", "food-tasting", "market", "handcraft", "festival", "photography",
  "quiet-observation",
]);

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort((left, right) => left.localeCompare(right)).map((key) =>
      `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function hashEvent(event) {
  const { eventHash: _eventHash, ...canonical } = event;
  return createHash("sha256").update(stableJson(canonical)).digest("hex");
}

function parse(value) {
  return JSON.parse(String(value));
}

function iso(value = new Date()) {
  const date = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error("INVALID_OFFLINE_TIME");
  return date.toISOString();
}

function uuid(value, code = "INVALID_OFFLINE_ID") {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new Error(code);
  }
  return value;
}

export async function openOfflineDatabase(root = stateRoot) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  await protect(root, true);
  const path = join(root, "offline.sqlite");
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA busy_timeout=5000;
    PRAGMA foreign_keys=ON;
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS permits (
      id TEXT PRIMARY KEY,
      token TEXT NOT NULL,
      snapshot_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('available','consumed','revoked')),
      issued_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS local_journeys (
      id TEXT PRIMARY KEY,
      permit_id TEXT NOT NULL REFERENCES permits(id),
      snapshot_json TEXT NOT NULL,
      started_at TEXT NOT NULL,
      reported_through_at TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('travelling','returning','pending-completion','synced')),
      current_ref_json TEXT NOT NULL,
      draft_json TEXT,
      canonical_journey_id TEXT
    );
    CREATE TABLE IF NOT EXISTS offline_events (
      event_id TEXT PRIMARY KEY,
      journey_id TEXT NOT NULL REFERENCES local_journeys(id),
      permit_id TEXT NOT NULL REFERENCES permits(id),
      sequence INTEGER NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('start','directive','progress')),
      occurred_at TEXT NOT NULL,
      previous_hash TEXT,
      event_hash TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending','accepted','rejected','local-only')),
      canonical_resource_id TEXT,
      rejection_code TEXT,
      UNIQUE (permit_id, sequence)
    );
    CREATE INDEX IF NOT EXISTS offline_events_pending_idx
      ON offline_events (permit_id, status, sequence);
  `);
  await protect(path);
  return db;
}

/** Online queries inspect the queue without creating a DB, lock or WAL. */
export async function inspectOfflineQueue(root = stateRoot) {
  const path = join(root, "offline.sqlite");
  const stamp = async (file) => {
    try { const s = await stat(file, { bigint: true }); return `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}`; }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  };
  if (!await stamp(path)) return { pendingCount: 0, rejectedCount: 0 };
  // SQLite's readOnly flag can still create WAL shared-memory files. Inspect a
  // stable DB+WAL snapshot in private scratch space, never the identity directory.
  // Do not use immutable=1: it would silently ignore pending events in the WAL.
  const scratch = await mkdtemp(join(tmpdir(), "wondertoken-queue-read-"));
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      const paths = [path, `${path}-wal`];
      const before = await Promise.all(paths.map(stamp));
      let buffers;
      try { buffers = await Promise.all(paths.map((file, i) => before[i] ? readFile(file) : null)); }
      catch (error) { if (error.code === "ENOENT") continue; throw error; }
      const after = await Promise.all(paths.map(stamp));
      if (before.some((value, i) => value !== after[i])) continue;
      if (!buffers[0]) continue;
      const snapshot = join(scratch, "offline.sqlite");
      await writeFile(snapshot, buffers[0], { mode: 0o600 });
      if (buffers[1]) await writeFile(`${snapshot}-wal`, buffers[1], { mode: 0o600 });
      const db = new DatabaseSync(snapshot, { readOnly: true });
      try {
        return {
          pendingCount: Number(db.prepare("SELECT count(*) AS count FROM offline_events WHERE status='pending'").get().count),
          rejectedCount: Number(db.prepare("SELECT count(*) AS count FROM offline_events WHERE status IN ('rejected','local-only')").get().count),
        };
      } finally { db.close(); }
    }
    throw new Error("LOCAL_STATE_BUSY_RETRY");
  } finally { await rm(scratch, { recursive: true, force: true }); }
}

const connection = localConnection;

async function request(endpoint, operationId, body) {
  const { playerKey, mcpUrl } = await connection();
  const response = await fetch(new URL(endpoint, mcpUrl), {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-wondertoken-player-key": playerKey,
      "x-wondertoken-operation-id": operationId,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30_000),
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok || !payload?.data) {
    throw new Error(payload?.error?.code ?? payload?.error ?? `OFFLINE_HTTP_${response.status}`);
  }
  return payload.data;
}

function latestPermit(db) {
  const row = db.prepare(
    "SELECT snapshot_json FROM permits WHERE status='available' ORDER BY issued_at DESC LIMIT 1",
  ).get();
  if (!row) throw new Error("OFFLINE_PERMIT_NOT_CACHED");
  return parse(row.snapshot_json);
}

function activeJourney(db) {
  const row = db.prepare(
    `SELECT * FROM local_journeys
     WHERE status IN ('travelling','returning','pending-completion')
     ORDER BY started_at DESC LIMIT 1`,
  ).get();
  if (!row) return null;
  return {
    id: row.id,
    permitId: row.permit_id,
    snapshot: parse(row.snapshot_json),
    startedAt: row.started_at,
    reportedThroughAt: row.reported_through_at,
    status: row.status,
    currentRef: parse(row.current_ref_json),
    draft: row.draft_json ? parse(row.draft_json) : null,
  };
}

function storePermit(db, snapshot) {
  db.prepare(
    `INSERT INTO permits (id, token, snapshot_json, status, issued_at)
     VALUES (?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET token=excluded.token,
       snapshot_json=excluded.snapshot_json, status='available', issued_at=excluded.issued_at`,
  ).run(snapshot.permitId, snapshot.permit, JSON.stringify(snapshot), "available", snapshot.issuedAt);
  if (snapshot.activeJourney) {
    const current = { kind: "confirmed", place: snapshot.activeJourney.currentLocation };
    db.prepare(
      `INSERT INTO local_journeys
       (id, permit_id, snapshot_json, started_at, reported_through_at, status,
        current_ref_json, canonical_journey_id)
       VALUES (?,?,?,?,?,?,?,?)
       ON CONFLICT(id) DO UPDATE SET permit_id=excluded.permit_id,
         snapshot_json=excluded.snapshot_json,
         status=CASE WHEN local_journeys.draft_json IS NULL
           THEN excluded.status ELSE local_journeys.status END,
         reported_through_at=CASE WHEN local_journeys.draft_json IS NULL
           THEN excluded.reported_through_at ELSE local_journeys.reported_through_at END,
         current_ref_json=CASE WHEN local_journeys.draft_json IS NULL
           THEN excluded.current_ref_json ELSE local_journeys.current_ref_json END,
         canonical_journey_id=excluded.canonical_journey_id`,
    ).run(
      snapshot.activeJourney.journeyId,
      snapshot.permitId,
      JSON.stringify(snapshot),
      snapshot.activeJourney.startedAt,
      snapshot.activeJourney.reportedThroughAt,
      snapshot.activeJourney.status,
      JSON.stringify(current),
      snapshot.activeJourney.journeyId,
    );
  }
}

export async function refreshPermit(db, operationId = randomUUID()) {
  const snapshot = await request("/offline/permits", uuid(operationId), undefined);
  if (snapshot.schemaVersion !== "offline-sync-v1") throw new Error("INVALID_OFFLINE_PERMIT");
  storePermit(db, snapshot);
  return {
    refreshed: true,
    permitId: snapshot.permitId,
    issuedAt: snapshot.issuedAt,
    petName: snapshot.pet.name,
    activeJourneyId: snapshot.activeJourney?.journeyId,
    balanceReference: snapshot.balanceReference,
  };
}

function appendEvent(db, journey, payload) {
  const rows = db.prepare(
    `SELECT sequence, event_hash, occurred_at FROM offline_events
     WHERE permit_id=? ORDER BY sequence DESC LIMIT 1`,
  ).get(journey.permitId);
  const sequence = Number(rows?.sequence ?? 0) + 1;
  if (sequence > MAX_EVENTS) throw new Error("OFFLINE_EVENT_LIMIT_EXCEEDED");
  if (payload.occurredAt < journey.snapshot.issuedAt ||
      rows?.occurred_at && payload.occurredAt < String(rows.occurred_at)) {
    throw new Error("OFFLINE_EVENT_TIME_INVALID");
  }
  const event = {
    ...payload,
    sequence,
    ...(rows?.event_hash ? { previousHash: String(rows.event_hash) } : {}),
  };
  event.eventHash = hashEvent(event);
  db.prepare(
    `INSERT INTO offline_events
     (event_id, journey_id, permit_id, sequence, kind, occurred_at, previous_hash,
      event_hash, payload_json, status)
     VALUES (?,?,?,?,?,?,?,?,?,'pending')`,
  ).run(
    event.eventId, journey.id, journey.permitId, sequence, event.kind, event.occurredAt,
    event.previousHash ?? null, event.eventHash, JSON.stringify(event),
  );
  return event;
}

export function startOfflineJourney(db, input = {}) {
  if (activeJourney(db)) throw new Error("ACTIVE_OFFLINE_JOURNEY_EXISTS");
  const permit = latestPermit(db);
  if (permit.activeJourney) throw new Error("ACTIVE_JOURNEY_EXISTS");
  if (permit.travelPolicyVersion === 'realistic-v2') throw new Error('OFFLINE_CONFIRMED_PLAN_REQUIRED');
  const journeyId = uuid(input.journeyId ?? randomUUID(), "INVALID_JOURNEY_ID");
  const startedAt = iso(input.startedAt);
  if (startedAt < permit.issuedAt) throw new Error("OFFLINE_START_BEFORE_PERMIT");
  if (input.routePreference !== undefined && input.routePreference !== "free") {
    throw new Error("INVALID_ROUTE_PREFERENCE");
  }
  if (input.anchorDestination) placeKey(input.anchorDestination);
  const start = {
    kind: "start",
    eventId: uuid(input.eventId ?? randomUUID()),
    occurredAt: startedAt,
    journeyId,
    ...(input.routePreference === "free" ? { routePreference: "free" } : {}),
    ...(input.anchorDestination ? { anchorDestination: input.anchorDestination } : {}),
  };
  db.prepare(
    `INSERT INTO local_journeys
     (id, permit_id, snapshot_json, started_at, reported_through_at, status,
      current_ref_json)
     VALUES (?,?,?,?,?,'travelling',?)`,
  ).run(
    journeyId, permit.permitId, JSON.stringify({ ...permit,
      defaultRoute: input.anchorDestination || input.routePreference === "free" ? undefined : permit.defaultRoute,
    }), startedAt, startedAt,
    JSON.stringify({ kind: "confirmed", place: permit.pet.home }),
  );
  const journey = activeJourney(db);
  const event = appendEvent(db, journey, start);
  return { pending: true, journeyId, eventId: event.eventId, startedAt };
}

function virtualDayDurationMs(journey) {
  const permit = journey.snapshot;
  if (permit.activeJourney) {
    // Active journeys keep the clock frozen at departure. Missing snapshots are
    // pre-change journeys and therefore retain the former ten-second pace.
    return permit.activeJourney.virtualDayDurationMs ?? 10_000;
  }
  return (permit.firstJourneyFreeAvailable
    ? permit.rules.firstJourneyRealMinutesPerVirtualDay
    : permit.rules.laterJourneyRealMinutesPerVirtualDay) * 60_000;
}

export function prepareOfflineProgress(db, input = {}) {
  const journey = activeJourney(db);
  if (!journey) throw new Error("OFFLINE_JOURNEY_NOT_FOUND");
  if (journey.draft) {
    return {
      phase: "locked",
      ...journey.draft,
      elapsedTravelDays: journey.draft.window.toVirtualDay,
      pending: true,
    };
  }
  const now = new Date(input.asOf ?? new Date());
  const duration = virtualDayDurationMs(journey);
  const routePlan = journey.snapshot.activeJourney
    ? journey.snapshot.activeJourney.routePlan
    : journey.snapshot.firstJourneyFreeAvailable ? journey.snapshot.defaultRoute : undefined;
  const reportedDay = (new Date(journey.reportedThroughAt).getTime() - new Date(journey.startedAt).getTime()) / duration;
  const realistic = journey.snapshot.activeJourney?.travelPolicyVersion === 'realistic-v2';
  const plan = journey.snapshot.activeJourney?.executionPlan;
  if (realistic && !plan?.plannedHomecomingDay) throw new Error('OFFLINE_CONFIRMED_PLAN_REQUIRED');
  const plannedDay = realistic ? plan.plannedHomecomingDay : routePlan?.days.at(-1)?.day ?? 28;
  const durationDays = realistic ? plannedDay : reportedDay >= plannedDay ? 28 : plannedDay;
  const cap = new Date(new Date(journey.startedAt).getTime() + durationDays * duration);
  const returnDue = journey.snapshot.activeJourney?.returnDueVirtualDay;
  const returnAt = returnDue === undefined
    ? cap
    : new Date(new Date(journey.startedAt).getTime() + returnDue * duration);
  let toAt = new Date(Math.min(now.getTime(), cap.getTime(), returnAt.getTime()));
  const fromAt = new Date(journey.reportedThroughAt);
  const fromVirtualDay = (fromAt.getTime() - new Date(journey.startedAt).getTime()) / duration;
  let toVirtualDay = (toAt.getTime() - new Date(journey.startedAt).getTime()) / duration;
  if (realistic && toVirtualDay > fromVirtualDay) {
    toVirtualDay = realisticWindowEnd({fromVirtualDay,toVirtualDay},plan);
    toAt = new Date(new Date(journey.startedAt).getTime()+toVirtualDay*duration);
  }
  if (toAt <= fromAt) {
    return {
      progressAvailable: false,
      reason: "NO_NEW_TRAVEL_TIME",
      elapsedTravelDays: fromVirtualDay,
      pending: true,
    };
  }
  return {
    progressAvailable: true,
    phase: "prepared",
    pending: true,
    journeyId: journey.id,
    eventId: input.eventId ?? randomUUID(),
    currentLocation: journey.currentRef,
    elapsedTravelDays: toVirtualDay,
    window: {
      fromAt: fromAt.toISOString(),
      toAt: toAt.toISOString(),
      fromVirtualDay,
      toVirtualDay,
      hardCapReached: toVirtualDay >= 28,
      automaticHomecoming: toVirtualDay >= durationDays || returnDue !== undefined && toVirtualDay >= returnDue,
      ...(toVirtualDay >= durationDays ? { completionTrigger: durationDays < 28 ? "planned-homecoming" : "maximum-duration" }
        : returnDue !== undefined && toVirtualDay >= returnDue ? { completionTrigger: "return-arrival" } : {}),
    },
    ...(realistic ? {plannedFacts: offlinePlannedFacts(journey,{fromVirtualDay,toVirtualDay})} : {}),
    balanceReference: journey.snapshot.balanceReference,
    routePlan,
    soulContext: journey.snapshot.soulContext,
  };
}

function placeKey(reference) {
  if (reference?.kind === "confirmed" && reference.place?.placeId) {
    return reference.place.placeId;
  }
  if (reference?.kind === "temporary") {
    const keys = Object.keys(reference);
    if (!String(reference.name ?? "").trim() || !String(reference.query ?? "").trim() ||
        !String(reference.cityHint ?? "").trim() ||
        keys.some((key) => !["kind", "name", "query", "cityHint", "provinceHint"].includes(key))) {
      throw new Error("INVALID_OFFLINE_PLACE");
    }
    return `${reference.provinceHint ?? ""}:${reference.cityHint}:${reference.name}`;
  }
  throw new Error("INVALID_OFFLINE_PLACE");
}

function offlinePlannedFacts(journey, query) {
  const active=journey.snapshot.activeJourney, plan=active.executionPlan;
  const facts=realisticFacts({origin:active.origin,currentLocation:journey.currentRef.place},query,plan);
  const ref=(id)=>id===journey.currentRef.place.placeId?'current':facts.movements.findIndex(m=>m.destination.placeId===id);
  return {movements:facts.movements.map(({distanceKm,encounter,travelerEncounter,ordinaryIncident,...m})=>({...m,destination:{kind:'confirmed',place:m.destination}})),
    activities:facts.activities.map(({placeId,...a})=>({...a,placeRef:ref(placeId)})),
    expenses:facts.expenses.map(({placeId,...e})=>({...e,amount:String(e.amount),placeRef:ref(placeId)})),
    expenseTotal:String(facts.expenseTotal),returnExpenseEstimate:String(facts.returnExpenseEstimate),finalize:facts.finalize};
}
function validateFacts(prepared, facts, journey) {
  if (prepared.plannedFacts) {
    for (const field of ['movements','activities','expenses','expenseTotal','returnExpenseEstimate','finalize']) {
      if (stableJson(facts[field])!==stableJson(prepared.plannedFacts[field])) throw new Error('ITINERARY_FACTS_MISMATCH');
    }
    return;
  }
  if (!Array.isArray(facts.movements) || facts.movements.length > 20) {
    throw new Error("INVALID_PROGRESS_FACTS");
  }
  let last = prepared.window.fromVirtualDay;
  const cities = new Set();
  let priorPlace = placeKey(journey.currentRef);
  for (const movement of facts.movements) {
    const departed = movement.departedVirtualDay ?? last;
    if (departed < last || movement.arrivedVirtualDay < departed ||
        movement.arrivedVirtualDay > prepared.window.toVirtualDay) {
      throw new Error("FUTURE_SEGMENT_NOT_ALLOWED");
    }
    const destinationKey = placeKey(movement.destination);
    const city = movement.destination.kind === "confirmed"
      ? movement.destination.place.city
      : movement.destination.cityHint;
    cities.add(city);
    if (cities.size > 5 || !String(movement.transportMode ?? "").trim() ||
        !String(movement.travelTimeReasoning ?? "").trim() ||
        (destinationKey !== priorPlace &&
          (!Array.isArray(movement.landmarkNames) || movement.landmarkNames.length < 1))) {
      throw new Error("INVALID_PROGRESS_FACTS");
    }
    priorPlace = destinationKey;
    last = movement.arrivedVirtualDay;
  }
  const validPlaceRef = (reference) => reference === "current" ||
    Number.isInteger(reference) && reference >= 0 && reference < facts.movements.length;
  if (!Array.isArray(facts.expenses) || facts.expenses.length > 40) {
    throw new Error("INVALID_EXPENSE_WINDOW");
  }
  for (const expense of facts.expenses) {
    if (!validPlaceRef(expense.placeRef) ||
        !/^(0|[1-9][0-9]*)$/u.test(String(expense.amount)) ||
        expense.fromVirtualDay < prepared.window.fromVirtualDay ||
        expense.toVirtualDay > prepared.window.toVirtualDay ||
        expense.toVirtualDay < expense.fromVirtualDay ||
        (expense.category === "transport" && !String(expense.transportMode ?? "").trim())) {
      throw new Error("INVALID_EXPENSE_WINDOW");
    }
    if (expense.category !== "transport") {
      const location = expense.placeRef === "current" ? journey.currentRef : facts.movements[expense.placeRef].destination;
      const stops = [{ location: journey.currentRef, from: prepared.window.fromVirtualDay },
        ...facts.movements.map((movement) => ({ location: movement.destination, from: movement.arrivedVirtualDay }))];
      if (!stops.some((stop, index) => placeKey(stop.location) === placeKey(location) &&
          expense.fromVirtualDay >= stop.from &&
          expense.toVirtualDay <= (facts.movements[index]?.departedVirtualDay ?? prepared.window.toVirtualDay))) {
        throw new Error("INVALID_EXPENSE_LOCATION_TIME");
      }
    }
  }
  const activities = facts.activities ?? [];
  if (!Array.isArray(activities) || activities.length > 40) {
    throw new Error("INVALID_JOURNEY_ACTIVITY");
  }
  for (const activity of activities) {
    const tags = Array.isArray(activity.tags) ? activity.tags : [];
    if (!validPlaceRef(activity.placeRef) ||
        !ACTIVITY_CATEGORIES.has(activity.category) || tags.length > 5 ||
        new Set(tags).size !== tags.length || tags.some((tag) => !ACTIVITY_TAGS.has(tag)) ||
        activity.fromVirtualDay < prepared.window.fromVirtualDay ||
        activity.toVirtualDay > prepared.window.toVirtualDay ||
        activity.toVirtualDay < activity.fromVirtualDay ||
        !String(activity.displayName ?? "").trim()) {
      throw new Error("INVALID_JOURNEY_ACTIVITY");
    }
  }
  const total = facts.expenses.reduce((sum, item) => sum + BigInt(item.amount), 0n);
  if (total !== BigInt(facts.expenseTotal)) throw new Error("EXPENSE_TOTAL_MISMATCH");
  const returnEstimate = BigInt(facts.returnExpenseEstimate);
  if (total + returnEstimate > BigInt(journey.snapshot.balanceReference)) {
    throw new Error("INSUFFICIENT_RETURN_RESERVE");
  }
  const finalPlace = facts.movements.at(-1)?.destination ?? journey.currentRef;
  const home = { kind: "confirmed", place: journey.snapshot.pet.home };
  if (!facts.finalize && placeKey(finalPlace) !== placeKey(home) && returnEstimate <= 0n) {
    throw new Error("INVALID_RETURN_EXPENSE_ESTIMATE");
  }
  if (prepared.window.hardCapReached && !facts.finalize) {
    throw new Error("JOURNEY_MUST_COMPLETE");
  }
  if (facts.finalize && BigInt(facts.returnExpenseEstimate) !== 0n) {
    throw new Error("INVALID_RETURN_EXPENSE_ESTIMATE");
  }
}

function selectClassicEncounters(db, journey, eventId, movements) {
  if (movements.some((movement) => movement.destination?.kind !== "confirmed")) return undefined;
  const catalog = journey.snapshot.classicEncounterCatalog ?? [];
  const unlocked = journey.snapshot.unlockedEncounterCodes ?? [];
  const earlier = db.prepare(
    "SELECT payload_json FROM offline_events WHERE journey_id=? AND kind='progress' ORDER BY sequence",
  ).all(journey.id).map((row) => parse(row.payload_json));
  const encounteredCities = new Set();
  for (const event of earlier) {
    if (!event.expectedClassicEncounterCodes?.length) continue;
    for (const movement of event.movements ?? []) {
      if (movement.destination?.kind === "confirmed") {
        encounteredCities.add(movement.destination.place.city);
      }
    }
  }
  const codes = [];
  for (const [index, movement] of movements.entries()) {
    const place = movement.destination.place;
    if (encounteredCities.has(place.city)) continue;
    const digest = createHash("sha256")
      .update(`${journey.id}:${eventId}:${place.placeId}:${index}`)
      .digest();
    const force = (journey.snapshot.activeJourney?.freeWaiverApplied ?? journey.snapshot.firstJourneyFreeAvailable) &&
      unlocked.length === 0 && encounteredCities.size === 0;
    const roll = digest.readUInt32BE(0) / 0xffffffff;
    if (!force && roll >= (journey.snapshot.rules.encounterRate ?? 0.3)) continue;
    const options = catalog.filter((entry) => entry.city === place.city);
    if (!options.length) return undefined;
    const unseen = options.filter((entry) => !unlocked.includes(entry.code));
    const pool = unseen.length ? unseen : options;
    const encounter = pool[digest.readUInt32BE(4) % pool.length];
    if (encounter) {
      codes.push(encounter.code);
      encounteredCities.add(place.city);
    }
  }
  return codes;
}

export function lockOfflineProgress(db, input) {
  const journey = activeJourney(db);
  if (!journey) throw new Error("OFFLINE_JOURNEY_NOT_FOUND");
  if (journey.draft) return { phase: "locked", ...journey.draft, pending: true };
  const prepared = prepareOfflineProgress(db, { asOf: input.toAt, eventId: input.eventId });
  if (!prepared.progressAvailable) throw new Error("NO_NEW_TRAVEL_TIME");
  if (journey.snapshot.activeJourney?.travelPolicyVersion === 'realistic-v2' &&
    db.prepare("SELECT 1 FROM offline_events WHERE journey_id=? AND kind='directive' AND status='pending' LIMIT 1").get(journey.id)) {
    throw new Error('OFFLINE_REPLAN_REQUIRES_CONNECTION');
  }
  validateFacts(prepared, input, journey);
  const expectedClassicEncounterCodes = input.expectedClassicEncounterCodes ??
    selectClassicEncounters(db, journey, input.eventId, input.movements);
  const draft = {
    eventId: uuid(input.eventId),
    toAt: prepared.window.toAt,
    movements: input.movements,
    activities: input.activities ?? [],
    expenses: input.expenses,
    expenseTotal: String(input.expenseTotal),
    returnExpenseEstimate: String(input.returnExpenseEstimate),
    finalize: Boolean(input.finalize || prepared.window.automaticHomecoming),
    expectedClassicEncounterCodes,
    window: prepared.window,
  };
  db.prepare("UPDATE local_journeys SET draft_json=? WHERE id=?")
    .run(JSON.stringify(draft), journey.id);
  const classicEncounters = expectedClassicEncounterCodes?.map((code) =>
    journey.snapshot.classicEncounterCatalog.find((entry) => entry.code === code))
    .filter(Boolean) ?? [];
  return { phase: "locked", pending: true, journeyId: journey.id, ...draft, classicEncounters };
}

function validateContent(content, continuity, realistic = false) {
  const text = String(content).trim();
  if (text.length < (realistic ? 20 : 450) || text.length > 500) throw new Error("INVALID_PROGRESS_LENGTH");
  const paragraphs = text.split(/\r?\n\s*\r?\n/u).map((part) => part.trim()).filter(Boolean);
  if (paragraphs.length < (realistic ? 1 : 3) || paragraphs.length > (realistic ? 12 : 4)) {
    throw new Error("INVALID_PROGRESS_PARAGRAPH_COUNT");
  }
  if (!continuity?.currentSituation || !continuity?.petMood ||
      continuity.recentFacts?.length > 8 || continuity.openThreads?.length > 5) {
    throw new Error("INVALID_PROGRESS_FACTS");
  }
  return text;
}

export function submitOfflineProgress(db, input) {
  const journey = activeJourney(db);
  if (!journey?.draft) throw new Error("OFFLINE_PROGRESS_NOT_LOCKED");
  const content = validateContent(input.content, input.continuity, journey.snapshot.activeJourney?.travelPolicyVersion === 'realistic-v2');
  const event = appendEvent(db, journey, {
    kind: "progress",
    eventId: journey.draft.eventId,
    occurredAt: iso(input.occurredAt),
    journeyId: journey.id,
    toAt: journey.draft.toAt,
    movements: journey.draft.movements,
    activities: journey.draft.activities,
    expenses: journey.draft.expenses,
    expenseTotal: journey.draft.expenseTotal,
    returnExpenseEstimate: journey.draft.returnExpenseEstimate,
    finalize: journey.draft.finalize,
    content,
    continuity: input.continuity,
    ...(input.recalledSoulMemoryIds ? { recalledSoulMemoryIds: input.recalledSoulMemoryIds } : {}),
    ...(input.imageBrief ? { imageBrief: input.imageBrief } : {}),
    ...(journey.draft.expectedClassicEncounterCodes
      ? { expectedClassicEncounterCodes: journey.draft.expectedClassicEncounterCodes }
      : {}),
  });
  const destination = journey.draft.movements.at(-1)?.destination ?? journey.currentRef;
  db.prepare(
    `UPDATE local_journeys SET reported_through_at=?, current_ref_json=?, draft_json=NULL,
       status=? WHERE id=?`,
  ).run(
    journey.draft.toAt,
    JSON.stringify(destination),
    journey.draft.finalize ? "pending-completion" : journey.status,
    journey.id,
  );
  return {
    pending: true,
    notice: "待旅行信箱确认",
    journeyId: journey.id,
    eventId: event.eventId,
    content,
    provisional: {
      expenseTotal: event.expenseTotal,
      returnExpenseEstimate: event.returnExpenseEstimate,
      final: event.finalize,
    },
  };
}

export function addOfflineDirective(db, input) {
  const journey = activeJourney(db);
  if (!journey) throw new Error("OFFLINE_JOURNEY_NOT_FOUND");
  if (journey.status === "returning" && input.directive?.type === "visit") {
    throw new Error("DIRECTIVE_NOT_ALLOWED_WHILE_RETURNING");
  }
  const directive = input.directive;
  if (!directive || !["visit", "spending", "preference", "return"].includes(directive.type) ||
      directive.type === "visit" && !directive.destination ||
      directive.type === "spending" && !["economize", "normal", "comfortable"].includes(directive.mode) ||
      directive.type === "preference" && (!String(directive.instruction ?? "").trim() ||
        String(directive.instruction).length > 160) ||
      directive.type === "return" && (!(directive.estimatedVirtualDays > 0) ||
        directive.estimatedVirtualDays > 28)) {
    throw new Error("INVALID_OFFLINE_DIRECTIVE");
  }
  if (directive.type === "visit") placeKey(directive.destination);
  const event = appendEvent(db, journey, {
    kind: "directive",
    eventId: uuid(input.eventId ?? randomUUID()),
    occurredAt: iso(input.occurredAt),
    journeyId: journey.id,
    directive,
  });
  if (directive.type === "return") {
    db.prepare("UPDATE local_journeys SET status='returning' WHERE id=?").run(journey.id);
  }
  return { pending: true, journeyId: journey.id, eventId: event.eventId };
}

export function offlineStatus(db) {
  const journey = activeJourney(db);
  const pending = Number(db.prepare(
    "SELECT count(*) AS count FROM offline_events WHERE status='pending'",
  ).get().count);
  const rejected = Number(db.prepare(
    "SELECT count(*) AS count FROM offline_events WHERE status IN ('rejected','local-only')",
  ).get().count);
  return {
    available: Boolean(db.prepare("SELECT 1 FROM permits WHERE status='available' LIMIT 1").get()),
    pendingCount: pending,
    rejectedCount: rejected,
    ...(journey
      ? {
          journey: {
            journeyId: journey.id,
            status: journey.status,
            reportedThroughAt: journey.reportedThroughAt,
            currentLocation: journey.currentRef,
            hasLockedDraft: Boolean(journey.draft),
          },
        }
      : {}),
  };
}

export async function syncOfflineEvents(db, operationId = randomUUID(), ifPending = false) {
  const permitRow = db.prepare(
    `SELECT permit_id FROM offline_events WHERE status='pending'
     ORDER BY occurred_at, sequence LIMIT 1`,
  ).get();
  if (!permitRow) {
    if (ifPending) return { synced: false, reason: "NO_PENDING_OFFLINE_EVENTS" };
    return refreshPermit(db, operationId);
  }
  const permit = parse(db.prepare("SELECT snapshot_json FROM permits WHERE id=?").get(permitRow.permit_id).snapshot_json);
  const rows = db.prepare(
    "SELECT payload_json FROM offline_events WHERE permit_id=? AND status='pending' ORDER BY sequence",
  ).all(permit.permitId);
  const events = rows.map((row) => parse(row.payload_json));
  const journey = db.prepare(
    "SELECT id FROM local_journeys WHERE permit_id=? ORDER BY started_at DESC LIMIT 1",
  ).get(permit.permitId);
  if (!journey) throw new Error("OFFLINE_JOURNEY_NOT_FOUND");
  const result = await request("/offline/sync", uuid(operationId), {
    schemaVersion: "offline-sync-v1",
    permit: permit.permit,
    localJourneyId: journey.id,
    events,
  });
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const eventId of result.acceptedEventIds ?? []) {
      db.prepare("UPDATE offline_events SET status='accepted' WHERE event_id=?").run(eventId);
    }
    if (result.rejection?.eventId) {
      db.prepare(
        "UPDATE offline_events SET status='rejected', rejection_code=? WHERE event_id=?",
      ).run(result.rejection.code, result.rejection.eventId);
      db.prepare(
        `UPDATE offline_events SET status='local-only', rejection_code='BLOCKED_BY_PREFIX'
         WHERE permit_id=? AND sequence>(SELECT sequence FROM offline_events WHERE event_id=?)
           AND status='pending'`,
      ).run(permit.permitId, result.rejection.eventId);
    }
    if ((result.acceptedCount ?? 0) > 0) {
      db.prepare("UPDATE permits SET status='consumed' WHERE id=?").run(permit.permitId);
      db.prepare(
        "UPDATE local_journeys SET canonical_journey_id=?, status=? WHERE id=?",
      ).run(
        result.canonicalJourneyId ?? null,
        result.completed ? "synced" : "travelling",
        journey.id,
      );
    }
    if (result.replacementPermit) storePermit(db, result.replacementPermit);
    db.exec("COMMIT");
  } catch (error) { db.exec("ROLLBACK"); throw error; }
  if ((result.acceptedCount ?? 0) > 0 && !result.replacementPermit) {
    try {
      await refreshPermit(db, randomUUID());
    } catch {
      // The accepted prefix remains authoritative; permit refresh can be retried later.
    }
  }
  return { synced: true, ...result };
}

async function readInput() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return parse(Buffer.concat(chunks).toString("utf8"));
}

async function main() {
  const command = process.argv[2] ?? "status";
  const input = await readInput();
  const db = await openOfflineDatabase();
  try {
    const output = command === "refresh" ? await refreshPermit(db, input.operationId)
      : command === "status" ? offlineStatus(db)
        : command === "start" ? startOfflineJourney(db, input)
          : command === "prepare" ? prepareOfflineProgress(db, input)
            : command === "lock" ? lockOfflineProgress(db, input)
              : command === "submit" ? submitOfflineProgress(db, input)
                : command === "directive" ? addOfflineDirective(db, input)
                  : command === "sync" ? await syncOfflineEvents(db, input.operationId, input.ifPending)
                    : (() => { throw new Error("USAGE: offline-travel.mjs refresh|status|start|prepare|lock|submit|directive|sync"); })();
    console.log(JSON.stringify(output));
  } finally {
    db.close();
  }
}

export async function runCli() { await cli(() => withStateLock("offline", main)); }
if (isMain(import.meta.url)) await runCli();
