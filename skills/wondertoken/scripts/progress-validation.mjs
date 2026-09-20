// Read-only preflight. Never changes facts, prose, operation IDs, or game state.
import {progressFactsSchema, JOURNEY_ACTIVITY_CATEGORIES, JOURNEY_ACTIVITY_TAGS} from './progress-contract.generated.mjs';
const categories=new Set(JOURNEY_ACTIVITY_CATEGORIES);
const tags=new Set(JOURNEY_ACTIVITY_TAGS);
const imageMoments = new Set(["exploration", "turning-point", "homecoming", "encounter-group-photo"]);
const imageTimes = new Set(["morning", "afternoon", "sunset", "night"]);
const imageWeather = new Set(["clear", "cloudy", "light-rain", "snow"]);
const imageMood = new Set(["warm", "curious", "adventurous", "peaceful", "mysterious"]);
const imageShots = new Set(["wide", "medium", "close"]);
const imageAngles = new Set(["eye-level", "low-angle", "high-angle"]);
const imageCompositions = new Set(["rule-of-thirds", "centered", "leading-lines"]);
const MAX_LEGACY_PROGRESS_MOVEMENTS = 5;
export function validateProgressInput(name, input, rawContext = {}) {
  const context = rawContext.data ?? rawContext;
  const errors = [];
  const add = (path, message) => errors.push({ path, message });
  if (!input || typeof input !== "object" || Array.isArray(input)) return [{ path: "$", message: "Expected a JSON object" }];
  if (!["lock_journey_progress_facts", "submit_journey_progress"].includes(name)) return errors;
  const handle = context.progressHandle;
  if (handle && (input.queryId !== handle.queryId || input.revision !== handle.revision)) {
    add("queryId/revision", "Use the progressHandle from this context; do not mix windows");
  }
  if (name === "lock_journey_progress_facts") {
    for (const field of ["movements", "expenses", "activities"]) {
      if (input[field] !== undefined && !Array.isArray(input[field])) add(field, "Expected an array");
    }
    if (errors.length) return errors;
    if (context.phase === "locked") add("$", "Facts are already locked; submit prose using this context");
    const movements = input.movements ?? [];
    if (!Array.isArray(movements)) return [{ path: "movements", message: "Expected an array" }];
    const maxMovements = context.progressConstraints?.maximumMovements ?? MAX_LEGACY_PROGRESS_MOVEMENTS;
    if (movements.length > maxMovements) add("movements", `At most ${maxMovements} movements, including homecoming`);
    const window = context.window;
    const {operationId, queryId, revision, ...facts} = input;
    const structure=progressFactsSchema.safeParse(facts);
    if(!structure.success) {
      const pathOf=parts=>parts.map((part,i)=>typeof part==='number'?`[${part}]`:`${i?'.':''}${part}`).join('');
      for(const issue of structure.error.issues) {
        if(issue.code==='unrecognized_keys') for(const key of issue.keys) add(pathOf([...issue.path,key]),issue.message);
        else add(pathOf(issue.path),issue.message);
      }
      return errors;
    }
    let last = window?.fromVirtualDay ?? 0;
    for (const [i, movement] of movements.entries()) {
      if (movement?.destination?.placeRef || movement?.placeRef) add(`movements[${i}]`, "Online progress uses destination.placeId; placeRef is only valid in offline permits");
      if (!Number.isFinite(movement.departedVirtualDay) || !Number.isFinite(movement.arrivedVirtualDay) ||
          movement.departedVirtualDay < last || movement.arrivedVirtualDay < movement.departedVirtualDay ||
          window && movement.arrivedVirtualDay > window.toVirtualDay) {
        add(`movements[${i}]`, `Departure/arrival must be ordered within the window; previous arrival is ${last}`);
      }
      last = movement.arrivedVirtualDay;
    }
    if (context.routePolicy && window) {
      const policy = context.routePolicy;
      const days = { ...(policy.cityStayDays ?? {}) };
      const before = { ...days };
      let location = { ...context.currentLocation, ...policy.currentCity };
      let arrived = window.fromVirtualDay;
      const key = (place) => `${place.province}/${place.city}`;
      const addStay = (until) => {
        if (location.placeId === policy.homePlaceId) return;
        const city = key(location);
        days[city] = (days[city] ?? 0) + Math.max(0, until - arrived);
      };
      for (const movement of movements) {
        addStay(movement.departedVirtualDay);
        if (key(location) === key(movement.destination) && location.placeId !== policy.homePlaceId) {
          const city = key(location);
          days[city] = (days[city] ?? 0) + Math.max(0, movement.arrivedVirtualDay - movement.departedVirtualDay);
        }
        location = movement.destination;
        arrived = movement.arrivedVirtualDay;
      }
      addStay(window.toVirtualDay);
      const maximum = context.progressConstraints?.maximumCityStayDays ?? 10;
      for (const [city, duration] of Object.entries(days)) {
        if (duration > maximum + 1e-9 && duration > (before[city] ?? 0) + 1e-9) {
          add("movements", `${city}: cumulative stay ${duration} exceeds ${maximum} virtual days; leave sooner or choose another city`);
        }
      }
    }
    const places = new Set([context.currentLocation?.placeId, ...movements.map((m) => m.destination?.placeId)].filter(Boolean));
    const stays = [
      ...(window && context.currentLocation ? [{ placeId: context.currentLocation.placeId, from: window.fromVirtualDay,
        to: movements[0]?.departedVirtualDay ?? window.toVirtualDay }] : []),
      ...movements.map((m, i) => ({ placeId: m.destination?.placeId, from: m.arrivedVirtualDay,
        to: movements[i + 1]?.departedVirtualDay ?? window?.toVirtualDay })),
    ];
    let total = 0n;
    for (const [i, expense] of (input.expenses ?? []).entries()) {
      const path = `expenses[${i}]`;
      if (!/^\d+$/u.test(String(expense.amount))) add(`${path}.amount`, "Expected a nonnegative integer");
      else total += BigInt(expense.amount);
      if (!Number.isFinite(expense.fromVirtualDay) || !Number.isFinite(expense.toVirtualDay) ||
          expense.toVirtualDay < expense.fromVirtualDay || window &&
          (expense.fromVirtualDay < window.fromVirtualDay || expense.toVirtualDay > window.toVirtualDay)) {
        add(path, "Expense must fit inside the prepared window");
      }
      if (window && !places.has(expense.placeId)) add(`${path}.placeId`, "Use the current location or a movement destination");
      if (expense.placeRef) add(`${path}.placeRef`, "Online progress uses placeId; placeRef is only valid in offline permits");
      if (expense.category === "transport") {
        if (!expense.transportMode?.trim()) add(`${path}.transportMode`, "Transport mode is required; either endpoint may own the expense");
      } else if (window && !stays.some((stay) => stay.placeId === expense.placeId &&
          expense.fromVirtualDay >= stay.from && expense.toVirtualDay <= stay.to)) {
        add(path, `Non-transport expense must fit an actual stay: ${JSON.stringify(stays.filter((stay) => stay.placeId === expense.placeId))}`);
      }
    }
    if (String(input.expenseTotal) !== String(total)) add("expenseTotal", `Expected ${total}, the sum of all expenses`);
    for (const [i, activity] of (input.activities ?? []).entries()) {
      if (!categories.has(activity.category)) add(`activities[${i}].category`, "Unknown activity category");
      const selected = activity.tags ?? [];
      if (selected.length > 5 || new Set(selected).size !== selected.length || selected.some((tag) => !tags.has(tag))) {
        add(`activities[${i}].tags`, "Use at most five distinct activity-v1 tags");
      }
      if (!places.has(activity.placeId)) add(`activities[${i}].placeId`, "Use the current location or a movement destination");
      if (activity.placeRef) add(`activities[${i}].placeRef`, "Online progress uses placeId; placeRef is only valid in offline permits");
    }
    if ((input.finalize || window?.automaticHomecoming) && String(input.returnExpenseEstimate) !== "0") {
      add("returnExpenseEstimate", "A completed homecoming has zero remaining return cost");
    }
  } else {
    const content = typeof input.content === "string" ? input.content : "";
    const length = content.trim().length;
    const limits=context.submissionRequirements?.content??{minimumCharacters:450,maximumCharacters:550,minimumParagraphs:3,maximumParagraphs:4};
    if (length < limits.minimumCharacters || content.length > limits.maximumCharacters) add("content", `Expected ${limits.minimumCharacters}–${limits.maximumCharacters} characters; received ${content.length}`);
    const paragraphs = content.trim().split(/\r?\n\s*\r?\n/u).filter((paragraph) => paragraph.trim()).length;
    if (paragraphs < limits.minimumParagraphs || paragraphs > limits.maximumParagraphs) add("content", `Expected 3–4 nonempty paragraphs; received ${paragraphs}`);
    const facts = context.facts ?? context.lockedFacts;
    const requirements = context.submissionRequirements?.imageBrief;
    const brief = input.imageBrief;
    if ((requirements?.required || facts?.finalize) && !brief) add("imageBrief", "Final submission requires an image brief even when image generation is unavailable");
    if (brief && requirements) {
      if (!imageMoments.has(brief.sceneMoment)) add("imageBrief.sceneMoment", "Choose a supported scene moment");
      for (const field of ["action", "narrativeCue"]) if (typeof brief[field] !== "string" || !brief[field].trim()) add(`imageBrief.${field}`, "Required nonempty text");
      if (!imageTimes.has(brief.timeOfDay)) add("imageBrief.timeOfDay", "Choose morning, afternoon, sunset, or night");
      if (!imageWeather.has(brief.weather)) add("imageBrief.weather", "Choose clear, cloudy, light-rain, or snow");
      if (!imageMood.has(brief.mood)) add("imageBrief.mood", "Choose warm, curious, adventurous, peaceful, or mysterious");
      if (!brief.camera || typeof brief.camera !== "object") add("imageBrief.camera", "Camera shot, angle, and composition are required");
      else {
        if (!imageShots.has(brief.camera.shot)) add("imageBrief.camera.shot", "Choose wide, medium, or close");
        if (!imageAngles.has(brief.camera.angle)) add("imageBrief.camera.angle", "Choose eye-level, low-angle, or high-angle");
        if (!imageCompositions.has(brief.camera.composition)) add("imageBrief.camera.composition", "Choose rule-of-thirds, centered, or leading-lines");
      }
      if (requirements.required && requirements.sceneMoment && brief.sceneMoment !== requirements.sceneMoment) add("imageBrief.sceneMoment", `Expected ${requirements.sceneMoment}`);
      for (const name of requirements.actionMustInclude ?? []) {
        if (!brief.action?.includes(name)) add("imageBrief.action", `Must include ${name}`);
      }
      if (!requirements.focalLandmarks?.includes(brief.focalLandmark)) add("imageBrief.focalLandmark", `Choose from ${JSON.stringify(requirements.focalLandmarks)}`);
      if (brief.secondaryLandmark && !requirements.allowedLandmarks?.includes(brief.secondaryLandmark)) add("imageBrief.secondaryLandmark", "Landmark has not been locked");
    }
    for (const [i, movement] of (facts?.movements ?? []).entries()) {
      const encounter = movement.encounter;
      if (encounter && !content.includes(encounter.characterName)) add("content", `Include locked encounter ${encounter.characterName} from movements[${i}]`);
    }
  }
  return errors;
}
