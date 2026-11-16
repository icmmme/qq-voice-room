export const FEATURE_MAP_SCHEMA = "m1-feature-map-v1";

export const REQUIRED_ACTIVE_FEATURE_IDS = Object.freeze([
  "VR2-001", "VR2-002", "VR2-003", "VR2-004", "VR2-005", "VR2-006",
  "VR2-007", "VR2-008", "VR2-009", "VR2-010", "VR2-011", "VR2-012",
  "VR2-013", "VR2-014", "VR2-015", "VR2-016", "VR2-018", "VR2-019",
  "VR2-022", "VR2-024", "VR2-025", "VR2-026", "VR2-028", "VR2-029",
  "VR2-030", "VR2-031", "VR2-032", "VR2-033", "VR2-034", "VR2-035",
  "VR2-036", "VR2-037", "VR2-038", "VR2-039", "VR2-040", "VR2-041",
  "VR2-042", "VR2-043", "VR2-044", "VR2-045", "VR2-046", "VR2-047",
  "VR2-048", "VR2-049", "VR2-050", "VR2-051", "VR2-052", "VR2-053",
  "VR2-054", "VR2-055", "VR2-056", "VR2-057", "VR2-058", "VR2-059",
  "VR2-060", "VR2-061"
]);

export const REQUIRED_HISTORICAL_FEATURE_IDS = Object.freeze([
  "VR2-017",
  "VR2-020",
  "VR2-021",
  "VR2-023",
  "VR2-027"
]);

export const REQUIRED_NEGATIVE_ONLY_FEATURE_IDS = Object.freeze(["VR2-021"]);
export const REQUIRED_PENDING_EXTENSION_ID = "VR-EXT-WEB-001";

export const REQUIRED_LEGACY_Q_WEB_SOURCES = Object.freeze([
  Object.freeze({
    path: "src/voice-room/websearch.ts",
    sha256: "9D5E3840F60203867B187FBC4315199E7222A1A673F39AC139A0E9E529F82548",
    byteLength: 21483
  }),
  Object.freeze({
    path: "src/web.ts",
    sha256: "78D4090E8AA843BD7D6000AC5D8F9B7B114137EDD7790D3EE18A7AFC94BD7D3C",
    byteLength: 21143
  }),
  Object.freeze({
    path: "src/web-task.ts",
    sha256: "3A74B39469F64935A27741BBBE0FF37CE10C97E92484FA87BD6C1C087B3C3052",
    byteLength: 19623
  })
]);

export const REQUIRED_NEGATIVE_CONTROLS = Object.freeze([
  "FM-ACTIVE-COUNT-NOT-56",
  "FM-WEB-IN-ACTIVE-SET",
  "FM-WEB-IMPLEMENTATION-OBLIGATION",
  "FM-WEB-DELETED",
  "FM-LEGACY-WEB-EVIDENCE",
  "FM-HISTORICAL-REVIVED",
  "FM-STALE-VERIFIED"
]);

function add(errors, code, detail) {
  errors.push({ code, detail });
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function unique(values) {
  return new Set(values).size === values.length;
}

export function validateFeatureMap(map) {
  const errors = [];
  if (!map || typeof map !== "object" || Array.isArray(map)) {
    return { ok: false, errors: [{ code: "FM-INVALID-DOCUMENT", detail: "map must be an object" }] };
  }

  if (map.schemaVersion !== FEATURE_MAP_SCHEMA) {
    add(errors, "FM-SCHEMA", `expected ${FEATURE_MAP_SCHEMA}`);
  }
  if (map.status !== "FROZEN_M1_AUTHORITY") {
    add(errors, "FM-STATUS", "status must be FROZEN_M1_AUTHORITY");
  }

  const active = asArray(map.activeFeatureIds);
  const historical = asArray(map.historicalFeatureIds);
  const negativeOnly = asArray(map.negativeOnlyFeatureIds);
  const pending = asArray(map.pendingExtensions);

  if (map.sourceIdCount !== 61) add(errors, "FM-SOURCE-ID-COUNT", "sourceIdCount must be 61");
  if (map.frozenActiveCapabilityCount !== 56) {
    add(errors, "FM-FROZEN-COUNT", "frozenActiveCapabilityCount must be 56");
  }
  if (map.historicalExclusionCount !== 5) {
    add(errors, "FM-HISTORICAL-COUNT", "historicalExclusionCount must be 5");
  }
  if (map.pendingExtensionCount !== 1) {
    add(errors, "FM-PENDING-COUNT", "pendingExtensionCount must be 1");
  }

  if (active.length !== 56) {
    add(errors, "FM-ACTIVE-COUNT-NOT-56", `activeFeatureIds length is ${active.length}`);
  }
  if (!unique(active)) add(errors, "FM-ACTIVE-DUPLICATE", "activeFeatureIds contains duplicates");
  if (!unique(historical)) add(errors, "FM-HISTORICAL-DUPLICATE", "historicalFeatureIds contains duplicates");

  if (JSON.stringify(active) !== JSON.stringify(REQUIRED_ACTIVE_FEATURE_IDS)) {
    add(errors, "FM-ACTIVE-SET-MISMATCH", "activeFeatureIds differs from the frozen 56-item set");
  }
  if (JSON.stringify(historical) !== JSON.stringify(REQUIRED_HISTORICAL_FEATURE_IDS)) {
    add(errors, "FM-HISTORICAL-SET-MISMATCH", "historicalFeatureIds differs from the frozen 5-item set");
  }
  if (!unique([...active, ...historical])) {
    add(errors, "FM-PARTITION-OVERLAP", "active and historical sets overlap");
  }
  if (active.length + historical.length !== 61) {
    add(errors, "FM-PARTITION-SIZE", "active plus historical must equal 61");
  }

  for (const id of historical) {
    if (active.includes(id)) add(errors, "FM-HISTORICAL-REVIVED", `${id} is historical but active`);
  }
  if (JSON.stringify(negativeOnly) !== JSON.stringify(REQUIRED_NEGATIVE_ONLY_FEATURE_IDS)) {
    add(errors, "FM-NEGATIVE-ONLY", "negativeOnlyFeatureIds must be exactly VR2-021");
  }
  if (!REQUIRED_NEGATIVE_ONLY_FEATURE_IDS.every((id) => historical.includes(id))) {
    add(errors, "FM-NEGATIVE-ONLY-NOT-HISTORICAL", "negative-only IDs must be historical");
  }

  if (pending.length !== 1) {
    add(errors, "FM-WEB-DELETED", "exactly one pending extension is required");
  }
  const web = pending.find((item) => item && item.id === REQUIRED_PENDING_EXTENSION_ID);
  if (!web) {
    add(errors, "FM-WEB-DELETED", "VR-EXT-WEB-001 is absent from pendingExtensions");
  } else {
    if (web.requirementStatus !== "PRODUCT_SPEC_PENDING") {
      add(errors, "FM-WEB-STATUS", "VR-EXT-WEB-001 must remain PRODUCT_SPEC_PENDING");
    }
    if (web.activityScope !== false) {
      add(errors, "FM-WEB-ACTIVITY-SCOPE", "VR-EXT-WEB-001 activityScope must be false");
    }
    if (web.implementationObligation !== false) {
      add(errors, "FM-WEB-IMPLEMENTATION-OBLIGATION", "VR-EXT-WEB-001 implementationObligation must be false");
    }
    if (web.cutoverRequired !== true) {
      add(errors, "FM-WEB-DELETED", "VR-EXT-WEB-001 cutoverRequired must be true");
    }
    if (web.targetEntrySymbol !== null) {
      add(errors, "FM-LEGACY-WEB-EVIDENCE", "pending Web extension must not name a target entry symbol");
    }
    if (web.verifiedThisTask === true) {
      add(errors, "FM-STALE-VERIFIED", "pending Web extension cannot be verified in M1");
    }
  }
  for (const id of active) {
    if (id === REQUIRED_PENDING_EXTENSION_ID) add(errors, "FM-WEB-IN-ACTIVE-SET", "pending Web ID is active");
  }

  const gate = map.cutoverGate ?? {};
  if (gate.requiredFrozenCapabilitySetRef !== "activeFeatureIds") {
    add(errors, "FM-CUTOVER-REF", "cutover gate must reference activeFeatureIds");
  }
  if (gate.allowCoreOnly !== false) add(errors, "FM-CUTOVER-CORE-ONLY", "allowCoreOnly must be false");
  if (gate.requireEveryCapabilityAccepted !== true) {
    add(errors, "FM-CUTOVER-REQUIRE-ALL", "requireEveryCapabilityAccepted must be true");
  }
  if (gate.effectiveRequirementCountAfterSpecFreeze !== 57) {
    add(errors, "FM-CUTOVER-COUNT", "effective requirement count must be 57");
  }
  if (!asArray(gate.pendingCutoverRequirementIds).includes(REQUIRED_PENDING_EXTENSION_ID)) {
    add(errors, "FM-CUTOVER-PENDING", "cutover gate must include VR-EXT-WEB-001");
  }

  const legacy = asArray(map.legacyQWebSources);
  if (legacy.length !== 3) {
    add(errors, "FM-LEGACY-COUNT", "exactly three legacy Q Web sources are required");
  }
  for (const required of REQUIRED_LEGACY_Q_WEB_SOURCES) {
    const found = legacy.find((item) => item && item.path === required.path);
    if (!found) {
      add(errors, "FM-LEGACY-MISSING", `${required.path} is missing`);
      continue;
    }
    if (found.sha256 !== required.sha256 || found.byteLength !== required.byteLength) {
      add(errors, "FM-LEGACY-HASH", `${required.path} identity differs from the frozen input`);
    }
    if (found.classification !== "INHERITED_LEGACY_ASSET_NOT_TARGET_WEB_EXTENSION") {
      add(errors, "FM-LEGACY-CLASS", `${required.path} must be classified as inherited legacy`);
    }
    if (found.evidenceAllowedForVR_EXT_WEB_001 !== false) {
      add(errors, "FM-LEGACY-WEB-EVIDENCE", `${required.path} cannot support Web acceptance`);
    }
    if (found.m1Action !== "READ_ONLY_NO_DELETE_NO_REWRITE") {
      add(errors, "FM-LEGACY-ACTION", `${required.path} must remain read-only in M1`);
    }
  }

  if (map.verifiedThisTask === true) {
    add(errors, "FM-STALE-VERIFIED", "feature map cannot carry a task-verification claim");
  }
  const declaredControls = asArray(map.negativeControls);
  for (const code of REQUIRED_NEGATIVE_CONTROLS) {
    if (!declaredControls.includes(code)) {
      add(errors, "FM-NEGATIVE-CONTROL-MISSING", `${code} is not declared`);
    }
  }

  return { ok: errors.length === 0, errors };
}

export function cloneFeatureMap(map) {
  return JSON.parse(JSON.stringify(map));
}
