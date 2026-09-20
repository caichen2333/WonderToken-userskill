// Source text is audit evidence supplied by the caller, never a permission token.
export const PROGRESS_PROTOCOL = "progress-session-v1";

export function progressIntent(source) {
  if (!source || !["user-progress", "authorized-automation"].includes(source.kind) ||
      typeof source.text !== "string" || !source.text.trim() || source.text.length > 1000 ||
      Object.keys(source).some((key) => !["kind", "text", "messageRef"].includes(key)) ||
      (source.messageRef !== undefined && (typeof source.messageRef !== "string" || !source.messageRef.trim() || source.messageRef.length > 240))) {
    throw new Error("INVALID_PROGRESS_SOURCE");
  }
  // Explicit restrictions take priority over progress words and old grants.
  const readOnly = /只(?:看|查|查询)(?:当前|目前|现在)?(?:的)?(?:状态|位置)|(?:不|不要)(?:生成|结算|扣币|推进)|暂停|停止旅行|read[ -]?only|(?:do not|don't) (?:generate|settle|advance)/iu.test(source.text);
  return readOnly ? "read-only" : "progress";
}

export function progressReview(context, action) {
  const data = context?.data ?? context;
  const session = data?.session;
  if (!session || session.version !== PROGRESS_PROTOCOL) throw new Error("PROGRESS_SESSION_REQUIRED");
  if (!["lock", "submit", "complete-homecoming"].includes(action) || session.next !== action) {
    throw new Error("PROGRESS_SESSION_STAGE_MISMATCH");
  }
  const effects = {
    lock: { freezesFacts: true, chargesVirtualCoins: false, completesJourney: false },
    submit: { freezesFacts: false, chargesVirtualCoins: true, completesJourney: session.outcome === "homecoming" },
    "complete-homecoming": { evolvesPrivateSoul: true, generatesArchivedPetMemoryImage: true, chargesVirtualCoins: false },
  };
  return {
    protocol: session.version, source: session.source ?? null,
    sourceEvidence: "caller-supplied-user-message; verify against conversation",
    journeyId: session.journeyId, window: data.window ?? null, action,
    scope: session.scope, effects: effects[action],
    realPayment: false, publishesTrace: false, startsAnotherJourney: false,
    businessConfirmationRequired: false,
    hostPermission: "separate; use normal sandbox permissions first; never bypass a denial",
  };
}
