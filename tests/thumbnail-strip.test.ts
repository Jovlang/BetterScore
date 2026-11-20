import assert from "node:assert/strict";
import test from "node:test";
import {calculateThumbnailScale} from "../src/thumbnail-strip";

test("thumbnail scale fits both width and height without enlarging", () => {
  assert.equal(calculateThumbnailScale(600, 900, 100, 120), 2 / 15);
  assert.equal(calculateThumbnailScale(50, 50, 100, 120), 1);
});
