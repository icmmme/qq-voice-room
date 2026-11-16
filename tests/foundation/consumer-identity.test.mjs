import test from "node:test";
import assert from "node:assert/strict";
import {
  CONSUMER_CODES,
  applyLateAck,
  evaluateConsumer,
  takeoverDecision
} from "../../tools/lib/consumer-identity.mjs";

function baseState() {
  return {
    ownerThread: { state: "alive" },
    claim: { valid: true, epochCurrent: true, reused: false, nonce: "n1", generation: 1 },
    lease: { valid: true },
    process: {
      hostAlive: true,
      dataDirKind: "original",
      waitAbandoned: false,
      handoff: "approved",
      oldLedgerKnown: true,
      oldUnknown: false,
      oldUnknownReconciled: false
    },
    runtime: { closing: false },
    delivery: { attemptState: "none", outcome: "pending" }
  };
}

test("CI-L-01: alive owner and valid claim may admit", () => {
  const result = evaluateConsumer(baseState());
  assert.equal(result.blocked, false);
  assert.equal(result.allowIngress, true);
  assert.equal(result.allowDbWrite, true);
  assert.equal(result.allowNewSend, true);
  assert.equal(result.claimReusable, true);
});

test("CI-L-02: terminated owner blocks ingress, writes and sends before admission", () => {
  const state = baseState();
  state.ownerThread.state = "terminated";
  const result = evaluateConsumer(state);
  assert.equal(result.blocked, true);
  assert.ok(result.codes.includes(CONSUMER_CODES.ownerThreadDead));
  assert.equal(result.allowIngress, false);
  assert.equal(result.allowDbWrite, false);
  assert.equal(result.allowNewSend, false);
});

test("CI-L-03: unverifiable owner is fail-closed", () => {
  const state = baseState();
  state.ownerThread.state = "unverifiable";
  const result = evaluateConsumer(state);
  assert.ok(result.codes.includes(CONSUMER_CODES.ownerThreadUnverifiable));
  assert.equal(result.allowNewSend, false);
});

test("CI-L-04: death between periodic and pre-send check prevents the send and claim reuse", () => {
  const before = evaluateConsumer(baseState());
  assert.equal(before.allowNewSend, true);
  const state = baseState();
  state.ownerThread.state = "terminated";
  const after = evaluateConsumer(state);
  assert.equal(after.allowNewSend, false);
  assert.equal(after.claimReusable, false);
});

test("CI-L-05: owner death preserves a started attempt and never replays it", () => {
  const state = baseState();
  state.ownerThread.state = "terminated";
  state.delivery = { attemptState: "started_unsettled", outcome: "pending" };
  const result = evaluateConsumer(state);
  assert.equal(result.preserveStartedAttempt, true);
  assert.equal(result.replayStartedAttempt, false);
  assert.equal(result.allowNewSend, false);
});

test("CI-L-06: WAIT_ABANDONED with empty dataDir is handoff-unproven", () => {
  const result = takeoverDecision({
    waitAbandoned: true,
    dataDirKind: "empty_new",
    handoff: "none",
    oldLedgerKnown: false,
    oldUnknown: true,
    approvedReconciliation: false
  });
  assert.equal(result.allowed, false);
  assert.ok(result.codes.includes(CONSUMER_CODES.handoffUnproven));
  assert.equal(result.allowAuthoritativeIngress, false);
  assert.equal(result.externalCalls, 0);
});

test("CI-L-07: approved handoff and known ledger may proceed without replay", () => {
  const result = takeoverDecision({
    waitAbandoned: true,
    dataDirKind: "original",
    handoff: "approved",
    oldLedgerKnown: true,
    oldUnknown: false,
    approvedReconciliation: false
  });
  assert.equal(result.allowed, true);
  assert.equal(result.replayOldAttempts, false);
  assert.equal(result.externalCalls, 0);
});

test("CI-L-08: dead claim nonce/generation reuse is rejected", () => {
  const state = baseState();
  state.claim.reused = true;
  const result = evaluateConsumer(state);
  assert.ok(result.codes.includes(CONSUMER_CODES.claimReuseRejected));
  assert.equal(result.claimReusable, false);
});

test("negative: owner death cannot permit a second send", () => {
  const state = baseState();
  state.ownerThread.state = "terminated";
  state.delivery = { attemptState: "started_unsettled", outcome: "pending" };
  const result = evaluateConsumer(state);
  assert.notEqual(result.allowNewSend, true);
});

test("negative: empty dataDir cannot clear an old unknown", () => {
  const result = takeoverDecision({
    waitAbandoned: false,
    dataDirKind: "empty_new",
    handoff: "approved",
    oldLedgerKnown: true,
    oldUnknown: false,
    approvedReconciliation: false
  });
  assert.equal(result.allowed, false);
  assert.ok(result.codes.includes(CONSUMER_CODES.handoffUnproven));
});

test("negative: late ACK does not clear UNKNOWN", () => {
  const state = baseState();
  state.delivery = { attemptState: "started_unsettled", outcome: "unknown" };
  const next = applyLateAck(state);
  assert.equal(next.delivery.outcome, "unknown");
  assert.equal(next.delivery.blocked, true);
  assert.equal(next.observations.at(-1).clearsUnknown, false);
  assert.equal(evaluateConsumer(next).blocked, true);
});
