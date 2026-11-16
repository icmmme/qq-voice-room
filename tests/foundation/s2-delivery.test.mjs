import test from "node:test";
import assert from "node:assert/strict";
import {
  S2_REJECTION_CODE,
  abnormalCauses,
  admissionDecision,
  normalInFlight,
  recoveryDecision,
  rejectionDedupe,
  settlementDecision
} from "../../tools/lib/s2-delivery.mjs";

function healthyInFlight() {
  return {
    attempt: {
      attemptCount: 1,
      state: "started_unsettled",
      dispatchHandlePresent: true,
      dispatchHandleOwned: true,
      transportFault: false,
      watchdogExpired: false,
      outcomeUnknown: false,
      outcome: "pending"
    },
    consumer: { leaseValid: true, identityValid: true },
    storage: { commitIndeterminate: false },
    runtime: { closingOrFaulted: false }
  };
}

test("S2-AC-01/S2-AC-14: normal in-flight admits a new @ without a second send", () => {
  const state = healthyInFlight();
  assert.equal(normalInFlight(state), true);
  assert.deepEqual(abnormalCauses(state), []);
  const decision = admissionDecision(state);
  assert.equal(decision.admitted, true);
  assert.equal(decision.createDurableAdmission, true);
  assert.equal(decision.startsPhysicalSend, false);
  assert.equal(decision.rejection, null);
});

test("S2-AC-03: transport fault rejects with a fixed technical code", () => {
  const state = healthyInFlight();
  state.attempt.transportFault = true;
  const decision = admissionDecision(state);
  assert.equal(decision.admitted, false);
  assert.equal(decision.createDurableAdmission, false);
  assert.equal(decision.callsModel, false);
  assert.equal(decision.createsTts, false);
  assert.equal(decision.rejection.code, S2_REJECTION_CODE);
  assert.equal(decision.rejection.causeCode, "physical_transport_fault");
});

test("S2-AC-04: expired watchdog rejects", () => {
  const state = healthyInFlight();
  state.attempt.watchdogExpired = true;
  assert.equal(admissionDecision(state).rejection.causeCode, "physical_watchdog_expired");
});

test("S2-AC-05: unresolved unknown rejects admission", () => {
  const state = healthyInFlight();
  state.attempt.outcomeUnknown = true;
  assert.equal(admissionDecision(state).rejection.causeCode, "outcome_unknown");
});

test("commit indeterminacy and invalid lease remain distinct blockers", () => {
  const storageState = healthyInFlight();
  storageState.storage.commitIndeterminate = true;
  assert.equal(admissionDecision(storageState).rejection.causeCode, "commit_indeterminate");
  const leaseState = healthyInFlight();
  leaseState.consumer.leaseValid = false;
  assert.equal(admissionDecision(leaseState).rejection.causeCode, "consumer_lease_invalid");
  const closingState = healthyInFlight();
  closingState.runtime.closingOrFaulted = true;
  assert.equal(admissionDecision(closingState).rejection.causeCode, "runtime_closing_or_faulted");
});

test("S2-AC-09: duplicate platform event emits at most one rejection fact", () => {
  const first = rejectionDedupe([], "event-hash");
  assert.equal(first.emit, true);
  const second = rejectionDedupe(first.keys, "event-hash");
  assert.equal(second.emit, false);
  assert.equal(second.keys.length, 1);
});

test("S2-AC-05 late ACK does not settle or clear UNKNOWN", () => {
  const state = healthyInFlight();
  state.attempt.outcomeUnknown = true;
  const decision = settlementDecision(state, "late_ack");
  assert.equal(decision.settled, false);
  assert.equal(decision.outcome, "unknown");
  assert.equal(decision.admissionResumes, false);
});

test("provable failure settles without replay or a second send", () => {
  const state = healthyInFlight();
  const decision = settlementDecision(state, "provable_failure");
  assert.equal(decision.settled, true);
  assert.equal(decision.outcome, "failure");
  assert.equal(decision.replay, false);
  assert.equal(decision.secondSend, false);
});

test("S2-AC-06: safe recovery resumes admission without replay", () => {
  const state = healthyInFlight();
  state.attempt.state = "settled";
  state.settlement = { safe: true };
  const decision = recoveryDecision(state);
  assert.equal(decision.safeRecovery, true);
  assert.equal(decision.admissionResumes, true);
  assert.equal(decision.replayRejectedEvent, false);
  assert.equal(decision.externalCalls, 0);
});

test("negative: normal in-flight is not treated as abnormal", () => {
  const decision = admissionDecision(healthyInFlight());
  assert.equal(decision.admitted, true);
  assert.equal(decision.rejection, null);
});

test("negative: UNKNOWN cannot be cleared by a late ACK", () => {
  const state = healthyInFlight();
  state.attempt.outcomeUnknown = true;
  const late = settlementDecision(state, "late_ack");
  const stillBlocked = admissionDecision(state);
  assert.equal(late.outcome, "unknown");
  assert.equal(stillBlocked.admitted, false);
});
