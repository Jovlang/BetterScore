import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  highlighterWidthLabel,
  normalizeSettings
} from "../src/settings";

test("marker width settings have a stable default", () => {
  assert.deepEqual(normalizeSettings(null), DEFAULT_SETTINGS);
  assert.equal(highlighterWidthLabel(DEFAULT_SETTINGS.highlighterWidth), "Medium");
});

test("eraser mode persists and rejects unknown values", () => {
  assert.equal(normalizeSettings({highlighterWidth: 0.022, eraserMode: "precision"}).eraserMode, "precision");
  assert.equal(normalizeSettings({highlighterWidth: 0.022, eraserMode: "unknown"}).eraserMode, "stroke");
});

test("marker widths are persisted within safe bounds", () => {
  assert.equal(normalizeSettings({highlighterWidth: 0.035}).highlighterWidth, 0.035);
  assert.equal(normalizeSettings({highlighterWidth: 1}).highlighterWidth, 0.08);
  assert.equal(normalizeSettings({highlighterWidth: 0}).highlighterWidth, 0.008);
});

test("finger drawing is opt-in and persists", () => {
  assert.equal(normalizeSettings({}).fingerDrawingEnabled, false);
  assert.equal(normalizeSettings({fingerDrawingEnabled: true}).fingerDrawingEnabled, true);
  assert.equal(normalizeSettings({fingerDrawingEnabled: "yes"}).fingerDrawingEnabled, false);
});

test("high-memory desktop cache is opt-in with a bounded budget", () => {
  assert.equal(normalizeSettings({}).highMemoryDesktopCache, false);
  assert.equal(normalizeSettings({highMemoryDesktopCache: true}).highMemoryDesktopCache, true);
  assert.equal(normalizeSettings({desktopCacheBudgetMb: 2048}).desktopCacheBudgetMb, 2048);
  assert.equal(normalizeSettings({desktopCacheBudgetMb: 4096}).desktopCacheBudgetMb, 1024);
});
