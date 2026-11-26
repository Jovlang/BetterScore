import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SETTINGS,
  getInkStyle,
  INK_PRESETS,
  inkWidthLabel,
  normalizeSettings
} from "../src/settings";

test("ink defaults preserve the original red pen and yellow marker", () => {
  const settings = normalizeSettings(null);
  assert.deepEqual(settings, DEFAULT_SETTINGS);
  assert.deepEqual(getInkStyle(settings, "pen"), {color: "#e53935", width: 0.0045});
  assert.deepEqual(getInkStyle(settings, "highlighter"), {color: "#ffd60a", width: 0.022});
  assert.equal(inkWidthLabel("pen", settings.penWidth), "Medium");
  assert.equal(inkWidthLabel("highlighter", settings.highlighterWidth), "Medium");
});

test("all pen and marker presets round-trip independently through persisted settings", () => {
  for (const tool of ["pen", "highlighter"] as const) {
    const other = tool === "pen" ? "highlighter" : "pen";
    for (const {color} of INK_PRESETS[tool].colors) {
      for (const {width, label} of INK_PRESETS[tool].widths) {
        const settings = normalizeSettings(JSON.parse(JSON.stringify({
          [tool + "Color"]: color,
          [tool + "Width"]: width
        })));
        assert.deepEqual(getInkStyle(settings, tool), {color, width});
        assert.deepEqual(getInkStyle(settings, other), getInkStyle(DEFAULT_SETTINGS, other));
        assert.equal(inkWidthLabel(tool, width), label);
      }
    }
  }
});

test("legacy marker widths survive and invalid ink preferences fall back", () => {
  const settings = normalizeSettings({
    highlighterWidth: 0.03,
    highlighterColor: "unknown",
    penColor: "unknown",
    penWidth: NaN
  });
  assert.deepEqual(getInkStyle(settings, "highlighter"), {color: "#ffd60a", width: 0.03});
  assert.equal(inkWidthLabel("highlighter", settings.highlighterWidth), "Custom");
  assert.deepEqual(getInkStyle(settings, "pen"), getInkStyle(DEFAULT_SETTINGS, "pen"));
  assert.equal(normalizeSettings({penWidth: -1}).penWidth, 0.0025);
  assert.equal(normalizeSettings({penWidth: 1}).penWidth, 0.012);
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
