export const S2_REJECTION_CODE = "rejected_physical_gate";

export const S2_ABNORMAL_CAUSES = Object.freeze([
  "physical_transport_fault",
  "physical_watchdog_expired",
  "outcome_unknown",
  "commit_indeterminate",
  "consumer_lease_invalid",
  "runtime_closing_or_faulted"
]);

export function normalInFlight(state) {
  const attempt = state.attempt ?? {};
  const consumer = state.consumer ?? {};
  const storage = state.storage ?? {};
  const runtime = state.runtime ?? {};
  return (
    attempt.attemptCount === 1 &&
    attempt.state === "started_unsettled" &&
    attempt.dispatchHandlePresent === true &&
    attempt.dispatchHandleOwned === true &&
    consumer.leaseValid === true &&
    attempt.transportFault !== true &&
    attempt.outcomeUnknown !== true &&
    attempt.watchdogExpired !== true &&
    storage.commitIndeterminate !== true &&
    runtime.closingOrFaulted !== true
  );
}

export function abnormalCauses(state) {
  const attempt = state.attempt ?? {};
  const storage = state.storage ?? {};
  const consumer = state.consumer ?? {};
  const runtime = state.runtime ?? {};
  const causes = [];
  if (attempt.transportFault === true) causes.push("physical_transport_fault");
  if (attempt.watchdogExpired === true) causes.push("physical_watchdog_expired");
  if (attempt.outcomeUnknown === true) causes.push("outcome_unknown");
  if (storage.commitIndeterminate === true) causes.push("commit_indeterminate");
  if (consumer.leaseValid !== true) causes.push("consumer_lease_invalid");
  if (runtime.closingOrFaulted === true) causes.push("runtime_closing_or_faulted");
  return causes;
}

export function admissionDecision(state) {
  const causes = abnormalCauses(state);
  if (causes.length > 0) {
    return {
      admitted: false,
      createDurableAdmission: false,
      createRequestOrTurn: false,
      callsModel: false,
      createsTts: false,
      startsPhysicalSend: false,
      createsBacklog: false,
      rejection: {
        code: S2_REJECTION_CODE,
        stage: "admission",
        gateReason: "delivery_abnormal",
        causeCode: causes[0]
      }
    };
  }
  const pendingPhysical =
    state.attempt?.state === "started_unsettled" || state.attempt?.outcomeUnknown === true;
  return {
    admitted: true,
    createDurableAdmission: true,
    createRequestOrTurn: true,
    callsModel: true,
    createsTts: true,
    startsPhysicalSend: pendingPhysical ? false : true,
    createsBacklog: false,
    queuePosition: "next_accept_seq",
    rejection: null
  };
}

export function settlementDecision(state, event) {
  const unknown = state.attempt?.outcomeUnknown === true || state.attempt?.outcome === "unknown";
  if (event === "late_ack") {
    return {
      settled: false,
      outcome: "unknown",
      admissionResumes: false,
      replay: false,
      secondSend: false,
      observation: "append_only"
    };
  }
  if (unknown && event !== "approved_reconciliation") {
    return {
      settled: false,
      outcome: "unknown",
      admissionResumes: false,
      replay: false,
      secondSend: false,
      observation: "unknown_requires_reconciliation"
    };
  }
  if (event === "success" || event === "provable_failure" || event === "approved_reconciliation") {
    const resumes = abnormalCauses({ ...state, attempt: { ...state.attempt, outcomeUnknown: false } }).length === 0;
    return {
      settled: true,
      outcome: event === "success" ? "success" : event === "provable_failure" ? "failure" : "reconciled",
      admissionResumes: resumes,
      replay: false,
      secondSend: false,
      observation: "settled"
    };
  }
  return {
    settled: false,
    outcome: "pending",
    admissionResumes: false,
    replay: false,
    secondSend: false,
    observation: "no_settlement_event"
  };
}

export function recoveryDecision(state) {
  const causes = abnormalCauses(state);
  const safe =
    causes.length === 0 &&
    state.settlement?.safe === true &&
    state.consumer?.leaseValid === true &&
    state.consumer?.identityValid === true &&
    state.storage?.commitIndeterminate !== true &&
    state.runtime?.closingOrFaulted !== true;
  return {
    safeRecovery: safe,
    admissionResumes: safe,
    replayRejectedEvent: false,
    replayAcceptedWork: false,
    externalCalls: 0,
    blockingCauses: causes
  };
}

export function rejectionDedupe(existingKeys, eventKeyHash) {
  const keys = new Set(existingKeys ?? []);
  if (keys.has(eventKeyHash)) {
    return { emit: false, keys: [...keys] };
  }
  keys.add(eventKeyHash);
  return { emit: true, keys: [...keys] };
}
