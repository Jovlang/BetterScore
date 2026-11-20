export type ViewMode = "continuous" | "single" | "spread";
export type SpreadOffset = 0 | 1;

export interface ViewerState {
  viewMode: ViewMode;
  /** The conceptually active PDF page, never the first page of a layout. */
  currentPage: number;
  spreadOffset: SpreadOffset;
}

export function createViewerState(): ViewerState {
  return {viewMode: "continuous", currentPage: 1, spreadOffset: 0};
}

export function clampPage(page: number, pageCount: number): number {
  if (pageCount < 1) return 1;
  return Math.max(1, Math.min(pageCount, Math.round(page)));
}

export function pagesForLayout(state: ViewerState, pageCount: number): number[] {
  if (state.viewMode === "continuous") {
    return Array.from({length: Math.max(0, pageCount)}, (_, index) => index + 1);
  }
  if (state.viewMode === "single") {
    return [clampPage(state.currentPage, pageCount)];
  }
  return spreadForPage(state.currentPage, state.spreadOffset, pageCount);
}

/** Visible pages first, then the next and previous paged layouts for prefetch. */
export function pagesForRenderWindow(state: ViewerState, pageCount: number): number[] {
  const visible = pagesForLayout(state, pageCount);
  if (state.viewMode === "continuous") return visible;
  if (state.viewMode === "single") {
    return uniquePages([
      ...visible,
      clampPage(state.currentPage + 1, pageCount),
      clampPage(state.currentPage - 1, pageCount)
    ]);
  }
  const next = nextSpreadAnchor(state.currentPage, state.spreadOffset, pageCount);
  const previous = previousSpreadAnchor(state.currentPage, state.spreadOffset, pageCount);
  return uniquePages([
    ...visible,
    ...spreadForPage(next, state.spreadOffset, pageCount),
    ...spreadForPage(previous, state.spreadOffset, pageCount)
  ]);
}

export function spreadForPage(
  page: number,
  offset: SpreadOffset,
  pageCount: number
): number[] {
  const current = clampPage(page, pageCount);
  if (offset === 0 && current === 1) return [1];
  const left = offset === 0
    ? (current % 2 === 0 ? current : current - 1)
    : (current % 2 === 1 ? current : current - 1);
  const pages = [Math.max(1, left)];
  if (left + 1 <= pageCount) pages.push(left + 1);
  return pages;
}

export function nextSpreadAnchor(
  page: number,
  offset: SpreadOffset,
  pageCount: number
): number {
  const spread = spreadForPage(page, offset, pageCount);
  return clampPage((spread.at(-1) ?? page) + 1, pageCount);
}

export function previousSpreadAnchor(
  page: number,
  offset: SpreadOffset,
  pageCount: number
): number {
  const spread = spreadForPage(page, offset, pageCount);
  const pageBeforeSpread = Math.max(1, (spread[0] ?? page) - 1);
  return spreadForPage(pageBeforeSpread, offset, pageCount)[0] ?? 1;
}

function uniquePages(pages: number[]): number[] {
  return [...new Set(pages)];
}
