export type ViewMode = "continuous" | "single" | "spread";
export type SpreadOffset = 0 | 1;

export interface ViewerState {
  viewMode: ViewMode;
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
  return spreadPages(state.currentPage, pageCount, state.spreadOffset);
}

export function spreadPages(
  page: number,
  pageCount: number,
  offset: SpreadOffset
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
