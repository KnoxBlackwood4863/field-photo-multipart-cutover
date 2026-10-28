import assert from "node:assert/strict";
import test from "node:test";
import { uploadDecision } from "../src/photo_upload_workflow.js";

test("an on-site technician can upload and receives the review follow-up", () => {
  assert.deepEqual(uploadDecision("on_site"), {
    accepted: true,
    followUp: "technician-review",
  });
});

test("a completed work order does not accept another field photo", () => {
  const decision = uploadDecision("completed");
  assert.equal(decision.accepted, false);
});
