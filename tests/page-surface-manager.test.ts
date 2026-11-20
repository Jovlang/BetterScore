import assert from "node:assert/strict";
import test from "node:test";
import {calculateRenderScales} from "../src/page-surface-manager";

test("render scales fit a PDF page to the available width", () => {
  const scales = calculateRenderScales({width: 600, height: 900}, 300, 2);
  assert.deepEqual(scales, {cssScale: 0.5, renderScale: 1, pixelRatio: 2});
});

test("render scales cap extreme enlargement", () => {
  const scales = calculateRenderScales({width: 100, height: 200}, 1000, 2);
  assert.deepEqual(scales, {cssScale: 1.75, renderScale: 3.5, pixelRatio: 2});
});
