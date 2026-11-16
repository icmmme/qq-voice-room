export const CONSUMER_CODES = Object.freeze({
  ownerThreadDead: "consumer_owner_thread_dead",
  ownerThreadUnverifiable: "consumer_owner_thread_unverifiable",
  claimInvalid: "consumer_claim_invalid",
  claimReuseRejected: "consumer_claim_reuse_rejected",
  leaseInvalid: "consumer_lease_invalid",
  handoffUnproven: "consumer_handoff_unproven",
  oldUnknownUnresolved: "consumer_old_unknown_unresolved",
  runtimeClosing: "consumer_runtime_closing"
});

function ownerCodes(state) {
  const codes = [];
  const thread = state.ownerThread?.state;
  if (thread === "terminated") codes.push(CONSUMER_CODES.ownerThreadDead);
  if (thread === "unverifiable" || (thread !== "alive" && thread !== "terminated")) {
    codes.push(CONSUMER_CODES.ownerThreadUnverifiable);
  }
  const claim = state.claim ?? {};
  if (claim.reused === true) codes.push(CONSUMER_CODES.claimReuseRejected);
  if (claim.valid !== true || claim.epochCurrent !== true) {
    codes.push(CONSUMER_CODES.claimInvalid);
  }
  if (state.lease?.valid !== true) codes.push(CONSUMER_CODES.leaseInvalid);
  if (state.runtime?.closing === true) codes.push(CONSUMER_CODES.runtimeClosing);
  return codes;
}

export function evaluateConsumer(state) {
  const codes = ownerCodes(state);
  const processState = state.process ?? {};
  if (
    processState.dataDirKind === "empty_new" ||
    (processState.waitAbandoned === true && processState.handoff !== "approved")
  ) {
    if (processState.handoff !== "approved") codes.push(CONSUMER_CODES.handoffUnproven);
  }
  if (processState.oldUnknown === true && processState.oldUnknownReconciled !== true) {
    codes.push(CONSUMER_CODES.oldUnknownUnresolved);
  }
  if (state.delivery?.outcome === "unknown") {
    codes.push(CONSUMER_CODES.oldUnknownUnresolved);
  }
  const blocked = codes.length > 0;
  const attempt = state.delivery?.attemptState ?? "none";
  return {
    blocked,
    codes: [...new Set(codes)],
    allowIngress: !blocked,
    allowDbWrite: !blocked,
    allowNewSend: !blocked,
    claimReusable:
      state.ownerThread?.state === "alive" &&
      state.claim?.valid === true &&
      state.claim?.epochCurrent === true &&
      state.claim?.reused !== true &&
      state.lease?.valid === true,
    preserveStartedAttempt: attempt !== "none",
    replayStartedAttempt: false
  };
}

export function takeoverDecision(input) {
  const codes = [];
  if (input.dataDirKind === "empty_new") codes.push(CONSUMER_CODES.handoffUnproven);
  if (input.waitAbandoned === true && input.handoff !== "approved") {
    codes.push(CONSUMER_CODES.handoffUnproven);
  }
  if (input.oldLedgerKnown !== true) codes.push(CONSUMER_CODES.handoffUnproven);
  if (input.oldUnknown === true && input.approvedReconciliation !== true) {
    codes.push(CONSUMER_CODES.oldUnknownUnresolved);
  }
  const blocked = codes.length > 0;
  return {
    allowed: !blocked,
    codes: [...new Set(codes)],
    allowAuthoritativeIngress: !blocked,
    allowDbWrite: !blocked,
    allowSend: !blocked,
    replayOldAttempts: false,
    externalCalls: 0
  };
}

export function applyLateAck(state) {
  const next = structuredClone(state);
  next.observations = [
    ...(next.observations ?? []),
    { kind: "late_ack", clearsUnknown: false }
  ];
  if (next.delivery?.outcome === "unknown") {
    next.delivery.outcome = "unknown";
    next.delivery.blocked = true;
  }
  return next;
}
