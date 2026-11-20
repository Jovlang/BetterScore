import assert from "node:assert/strict";
import test from "node:test";
import {isPdfPath} from "../src/file-types";

test("score switcher includes PDFs case-insensitively", () => {
  assert.equal(isPdfPath("Scores/Requiem.pdf"), true);
  assert.equal(isPdfPath("Scores/Requiem.PDF"), true);
});

test("score switcher excludes sidecars and unrelated files", () => {
  assert.equal(isPdfPath("Scores/Requiem.betterscore.json"), false);
  assert.equal(isPdfPath("Scores/Requiem.md"), false);
  assert.equal(isPdfPath("Scores/pdf-notes.txt"), false);
});
