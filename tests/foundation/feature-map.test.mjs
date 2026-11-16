import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  cloneFeatureMap,
  validateFeatureMap
} from "../../tools/lib/feature-map.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

async function loadMap() {
  return JSON.parse(await readFile(path.join(root, "docs", "architecture", "feature-map.json"), "utf8"));
}

function codes(map) {
  return validateFeatureMap(map).errors.map((error) => error.code);
}

test("frozen feature map is valid and partitions 61 IDs", async () => {
  const map = await loadMap();
  const result = validateFeatureMap(map);
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(map.sourceIdCount, 61);
  assert.equal(map.activeFeatureIds.length, 56);
  assert.equal(map.historicalFeatureIds.length, 5);
  assert.equal(new Set([...map.activeFeatureIds, ...map.historicalFeatureIds]).size, 61);
  assert.deepEqual(map.negativeOnlyFeatureIds, ["VR2-021"]);
});

test("Web extension remains pending and cannot be counted as frozen", async () => {
  const map = await loadMap();
  const web = map.pendingExtensions[0];
  assert.equal(web.id, "VR-EXT-WEB-001");
  assert.equal(web.requirementStatus, "PRODUCT_SPEC_PENDING");
  assert.equal(web.activityScope, false);
  assert.equal(web.implementationObligation, false);
  assert.equal(web.cutoverRequired, true);
  assert.equal(map.activeFeatureIds.includes("VR-EXT-WEB-001"), false);
  assert.equal(map.cutoverGate.effectiveRequirementCountAfterSpecFreeze, 57);
});

test("negative: active count other than 56 fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.activeFeatureIds.push("VR2-017");
  assert.ok(codes(map).includes("FM-ACTIVE-COUNT-NOT-56"));
});

test("negative: Web extension inside active IDs fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.activeFeatureIds.push("VR-EXT-WEB-001");
  assert.ok(codes(map).includes("FM-WEB-IN-ACTIVE-SET"));
});

test("negative: Web implementation obligation fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.pendingExtensions[0].implementationObligation = true;
  assert.ok(codes(map).includes("FM-WEB-IMPLEMENTATION-OBLIGATION"));
});

test("negative: deleted pending Web extension fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.pendingExtensions = [];
  assert.ok(codes(map).includes("FM-WEB-DELETED"));
});

test("negative: historical feature revived as active fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.activeFeatureIds[0] = "VR2-017";
  const found = codes(map);
  assert.ok(found.includes("FM-HISTORICAL-REVIVED"));
  assert.ok(found.includes("FM-ACTIVE-SET-MISMATCH"));
});

test("negative: legacy Q Web source used as evidence fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.legacyQWebSources[0].evidenceAllowedForVR_EXT_WEB_001 = true;
  map.pendingExtensions[0].targetEntrySymbol = "src/voice-room/websearch.ts";
  const found = codes(map);
  assert.ok(found.includes("FM-LEGACY-WEB-EVIDENCE"));
});

test("negative: task verification claim on the frozen map fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.verifiedThisTask = true;
  assert.ok(codes(map).includes("FM-STALE-VERIFIED"));
});

test("negative: missing negative-control declaration fails", async () => {
  const map = cloneFeatureMap(await loadMap());
  map.negativeControls = map.negativeControls.filter((code) => code !== "FM-STALE-VERIFIED");
  assert.ok(codes(map).includes("FM-NEGATIVE-CONTROL-MISSING"));
});
