import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePagedRenderScales,
  calculateRenderScales,
  shouldFullyCachePagedDocument
} from "../src/page-surface-manager";

test("render scales fit a PDF page to the available width", () => {
  const scales = calculateRenderScales({width: 600, height: 900}, 300, 2);
  assert.deepEqual(scales, {cssScale: 0.5, renderScale: 1, pixelRatio: 2});
});

test("render scales cap extreme enlargement", () => {
  const scales = calculateRenderScales({width: 100, height: 200}, 1000, 2);
  assert.deepEqual(scales, {cssScale: 1.75, renderScale: 3.5, pixelRatio: 2});
});

test("paged render scales fit both width and height", () => {
  assert.deepEqual(
    calculatePagedRenderScales({width: 600, height: 900}, 500, 600, 2),
    {cssScale: 2 / 3, renderScale: 4 / 3, pixelRatio: 2}
  );
});

test("full paged caching requires a small source and a safe canvas budget", () => {
  const safe = {
    pageCount: 8,
    sourceSizeBytes: 8 * 1024 * 1024,
    estimatedCanvasBytes: 96 * 1024 * 1024
  };
  assert.equal(shouldFullyCachePagedDocument(safe), true);
  assert.equal(shouldFullyCachePagedDocument({...safe, pageCount: 25}), false);
  assert.equal(shouldFullyCachePagedDocument({...safe, sourceSizeBytes: 49 * 1024 * 1024}), false);
  assert.equal(shouldFullyCachePagedDocument({
    ...safe,
    estimatedCanvasBytes: 193 * 1024 * 1024
  }), false);
});
