import assert from "node:assert/strict";
import test from "node:test";
import {
  calculatePagedRenderScales,
  calculateRenderScales,
  capRenderScales,
  clampZoom,
  continuousRenderWindow,
  retainedPagesToEvict,
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

test("zoom is rounded and clamped to safe renderer bounds", () => {
  assert.equal(clampZoom(1.234), 1.23);
  assert.equal(clampZoom(0.1), 0.5);
  assert.equal(clampZoom(5), 3);
  assert.equal(clampZoom(Number.NaN), 1);
});

test("large zoom keeps CSS size but bounds both canvas backing stores", () => {
  const scales = capRenderScales(
    {width: 1000, height: 2000},
    {cssScale: 3, renderScale: 6, pixelRatio: 2}
  );
  assert.equal(scales.cssScale, 3);
  assert.ok(scales.pixelRatio < 1);
  assert.equal(scales.renderScale * 2000, 4096);
});

test("continuous render fallback stays bounded around the active page", () => {
  assert.deepEqual(continuousRenderWindow(50, 300), [48, 49, 50, 51, 52]);
  assert.deepEqual(continuousRenderWindow(1, 300), [1, 2, 3]);
  assert.deepEqual(continuousRenderWindow(300, 300), [298, 299, 300]);
});

test("retained cache evicts oldest offscreen pages before protected pages", () => {
  const mib = 1024 * 1024;
  const candidates = [
    {pageNumber: 1, bytes: 100 * mib, lastAccess: 1, protected: false},
    {pageNumber: 2, bytes: 100 * mib, lastAccess: 2, protected: false},
    {pageNumber: 3, bytes: 100 * mib, lastAccess: 3, protected: true},
    {pageNumber: 4, bytes: 100 * mib, lastAccess: 4, protected: false}
  ];
  assert.deepEqual(retainedPagesToEvict(candidates, 250 * mib), [1, 2]);
  assert.deepEqual(retainedPagesToEvict(candidates, 400 * mib), []);
});
