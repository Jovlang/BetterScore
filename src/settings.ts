import type {AnnotationTool} from "./model";
import {normalizeReadingPositions} from "./reading-position";
import type {ReadingPosition} from "./reading-position";

export type EraserMode = "stroke" | "precision";

export interface InkStyle {
  color: string;
  width: number;
}

export interface BetterScoreSettings {
  penColor: string;
  penWidth: number;
  highlighterColor: string;
  highlighterWidth: number;
  eraserMode: EraserMode;
  fingerDrawingEnabled: boolean;
  highMemoryDesktopCache: boolean;
  desktopCacheBudgetMb: number;
  readingPositions: ReadingPosition[];
}

export const DEFAULT_SETTINGS: BetterScoreSettings = {
  penColor: "#e53935",
  penWidth: 0.0045,
  highlighterColor: "#ffd60a",
  highlighterWidth: 0.022,
  eraserMode: "stroke",
  fingerDrawingEnabled: false,
  highMemoryDesktopCache: false,
  desktopCacheBudgetMb: 1024,
  readingPositions: []
};

export const DESKTOP_CACHE_BUDGETS_MB = [256, 512, 1024, 2048] as const;

const PEN_WIDTH_PRESETS = [
  {label: "Thin", width: 0.0025},
  {label: "Medium", width: 0.0045},
  {label: "Wide", width: 0.0075},
  {label: "Extra wide", width: 0.012}
] as const;

const HIGHLIGHTER_WIDTH_PRESETS = [
  {label: "Thin", width: 0.012},
  {label: "Medium", width: 0.022},
  {label: "Wide", width: 0.035},
  {label: "Extra wide", width: 0.05}
] as const;

export const INK_PRESETS = {
  pen: {
    label: "Pen",
    widths: PEN_WIDTH_PRESETS,
    colors: [
      {label: "Red", color: DEFAULT_SETTINGS.penColor},
      {label: "Black", color: "#171717"},
      {label: "Blue", color: "#1565c0"},
      {label: "Green", color: "#1b7837"},
      {label: "Purple", color: "#7b1fa2"}
    ]
  },
  highlighter: {
    label: "Marker",
    widths: HIGHLIGHTER_WIDTH_PRESETS,
    colors: [
      {label: "Yellow", color: DEFAULT_SETTINGS.highlighterColor},
      {label: "Orange", color: "#ff9100"},
      {label: "Pink", color: "#ff4081"},
      {label: "Green", color: "#00c853"},
      {label: "Blue", color: "#00b0ff"}
    ]
  }
} as const;

export function getInkStyle(settings: BetterScoreSettings, tool: AnnotationTool): InkStyle {
  return tool === "pen"
    ? {color: settings.penColor, width: settings.penWidth}
    : {color: settings.highlighterColor, width: settings.highlighterWidth};
}

export function normalizeSettings(value: unknown): BetterScoreSettings {
  if (!isRecord(value)) return {...DEFAULT_SETTINGS, readingPositions: []};
  return {
    penColor: normalizeInkColor(value.penColor, "pen", DEFAULT_SETTINGS.penColor),
    penWidth: normalizeInkWidth(value.penWidth, DEFAULT_SETTINGS.penWidth, 0.0025, 0.012),
    highlighterColor: normalizeInkColor(value.highlighterColor, "highlighter", DEFAULT_SETTINGS.highlighterColor),
    highlighterWidth: normalizeInkWidth(value.highlighterWidth, DEFAULT_SETTINGS.highlighterWidth, 0.008, 0.08),
    eraserMode: value.eraserMode === "precision" ? "precision" : "stroke",
    fingerDrawingEnabled: value.fingerDrawingEnabled === true,
    highMemoryDesktopCache: value.highMemoryDesktopCache === true,
    desktopCacheBudgetMb: normalizeDesktopCacheBudget(value.desktopCacheBudgetMb),
    readingPositions: normalizeReadingPositions(value.readingPositions)
  };
}

function normalizeDesktopCacheBudget(value: unknown): number {
  if (typeof value !== "number") return DEFAULT_SETTINGS.desktopCacheBudgetMb;
  return DESKTOP_CACHE_BUDGETS_MB.find((budget) => budget === value)
    ?? DEFAULT_SETTINGS.desktopCacheBudgetMb;
}

function normalizeInkColor(value: unknown, tool: AnnotationTool, fallback: string): string {
  return INK_PRESETS[tool].colors.find((preset) => preset.color === value)?.color ?? fallback;
}

function normalizeInkWidth(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value)
    ? Math.max(min, Math.min(max, value))
    : fallback;
}

export function inkWidthLabel(tool: AnnotationTool, width: number): string {
  return INK_PRESETS[tool].widths.find((preset) => nearlyEqual(preset.width, width))?.label
    ?? "Custom";
}

export function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.0001;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
