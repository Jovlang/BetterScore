export interface BetterScoreSettings {
  highlighterWidth: number;
}

export const DEFAULT_SETTINGS: BetterScoreSettings = {
  highlighterWidth: 0.022
};

export const HIGHLIGHTER_WIDTH_PRESETS = [
  {label: "Thin", width: 0.012},
  {label: "Medium", width: 0.022},
  {label: "Wide", width: 0.035},
  {label: "Extra wide", width: 0.05}
] as const;

export function normalizeSettings(value: unknown): BetterScoreSettings {
  if (!isRecord(value) || typeof value.highlighterWidth !== "number") {
    return {...DEFAULT_SETTINGS};
  }
  return {
    highlighterWidth: Math.max(0.008, Math.min(0.08, value.highlighterWidth))
  };
}

export function highlighterWidthLabel(width: number): string {
  return HIGHLIGHTER_WIDTH_PRESETS.find((preset) => nearlyEqual(preset.width, width))?.label
    ?? "Custom";
}

export function nearlyEqual(left: number, right: number): boolean {
  return Math.abs(left - right) < 0.0001;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
