import assert from "node:assert/strict";
import test from "node:test";
import {NavigationController} from "../src/navigation-controller";
import {
  MAX_READING_POSITIONS,
  rememberReadingPosition,
  restoreReadingPosition
} from "../src/reading-position";
import {normalizeSettings} from "../src/settings";
import {createViewerState} from "../src/viewer-layout";

test("reading position survives a plugin-data round trip independently for each score", () => {
  const fallback = {...createViewerState(), spreadOffset: 1 as const};
  let positions = normalizeSettings(null).readingPositions;
  positions = rememberReadingPosition(positions, "score-a", {
    ...fallback, currentPage: 28, viewMode: "spread"
  });
  positions = rememberReadingPosition(positions, "score-b", {
    ...fallback, currentPage: 7, viewMode: "single"
  });
  const reloaded = normalizeSettings(JSON.parse(JSON.stringify({readingPositions: positions})));
  const restored = restoreReadingPosition(reloaded.readingPositions, "score-a", fallback);
  assert.deepEqual(restored, {...fallback, currentPage: 28, viewMode: "spread"});
  assert.deepEqual(restoreReadingPosition(reloaded.readingPositions, "score-b", fallback), {
    ...fallback, currentPage: 7, viewMode: "single"
  });
  assert.deepEqual(restoreReadingPosition(reloaded.readingPositions, "unseen", fallback), fallback);
  assert.equal(new NavigationController(20, () => {}, restored).getState().currentPage, 20);
});

test("rejects bad stored positions and caps the number of recent PDFs", () => {
  const state = createViewerState();
  const valid = {fingerprint: "score-a", page: 2, viewMode: "continuous"};
  const {readingPositions} = normalizeSettings({
    readingPositions: [null, {...valid, page: 0}, {...valid, viewMode: "unknown"}, valid, {
      ...valid, page: 3
    }]
  });
  assert.deepEqual(readingPositions, [valid]);
  let positions = readingPositions;
  for (let i = 0; i < MAX_READING_POSITIONS; i++) {
    positions = rememberReadingPosition(positions, `score-${i}`, state);
  }
  assert.equal(positions.length, MAX_READING_POSITIONS);
  assert.equal(positions.some((entry) => entry.fingerprint === "score-a"), false);
  assert.equal(rememberReadingPosition(positions, "score-0", state), positions);
});
