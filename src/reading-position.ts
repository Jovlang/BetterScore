import type {ViewerState, ViewMode} from "./viewer-layout";

export interface ReadingPosition {
  fingerprint: string;
  page: number;
  viewMode: ViewMode;
}

export const MAX_READING_POSITIONS = 500;

export function normalizeReadingPositions(value: unknown): ReadingPosition[] {
  if (!Array.isArray(value)) return [];
  const positions: ReadingPosition[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    if (!candidate || typeof candidate !== "object") continue;
    const {fingerprint, page, viewMode} = candidate as Partial<ReadingPosition>;
    if (typeof fingerprint !== "string" || !fingerprint || seen.has(fingerprint)) continue;
    if (typeof page !== "number" || !Number.isSafeInteger(page) || page < 1) continue;
    if (viewMode !== "continuous" && viewMode !== "single" && viewMode !== "spread") continue;
    seen.add(fingerprint);
    positions.push({fingerprint, page, viewMode});
    if (positions.length === MAX_READING_POSITIONS) break;
  }
  return positions;
}

export function rememberReadingPosition(
  positions: ReadingPosition[],
  fingerprint: string,
  state: ViewerState
): ReadingPosition[] {
  const previous = positions.find((position) => position.fingerprint === fingerprint);
  if (previous?.page === state.currentPage && previous.viewMode === state.viewMode) return positions;
  return [
    {fingerprint, page: state.currentPage, viewMode: state.viewMode},
    ...positions.filter((position) => position.fingerprint !== fingerprint)
  ].slice(0, MAX_READING_POSITIONS);
}

export function restoreReadingPosition(
  positions: readonly ReadingPosition[],
  fingerprint: string,
  fallback: ViewerState
): ViewerState {
  const position = positions.find((entry) => entry.fingerprint === fingerprint);
  return position ? {...fallback, currentPage: position.page, viewMode: position.viewMode} : fallback;
}
