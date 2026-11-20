import {
  SpreadOffset,
  ViewerState,
  ViewMode,
  clampPage,
  createViewerState,
  spreadPages
} from "./viewer-layout";

export type NavigationCause = "command" | "viewport" | "mode";

export interface NavigationChange {
  state: ViewerState;
  cause: NavigationCause;
}

export class NavigationController {
  private state: ViewerState;

  constructor(
    private readonly pageCount: number,
    private readonly onChange: (change: NavigationChange) => void,
    initialState: ViewerState = createViewerState()
  ) {
    this.state = {
      ...initialState,
      currentPage: clampPage(initialState.currentPage, pageCount)
    };
  }

  getState(): ViewerState {
    return {...this.state};
  }

  goToPage(page: number, cause: NavigationCause = "command"): void {
    const currentPage = clampPage(page, this.pageCount);
    if (currentPage === this.state.currentPage) return;
    this.update({...this.state, currentPage}, cause);
  }

  syncViewportPage(page: number): void {
    this.goToPage(page, "viewport");
  }

  setViewMode(viewMode: ViewMode): void {
    if (viewMode === this.state.viewMode) return;
    this.update({...this.state, viewMode}, "mode");
  }

  setSpreadOffset(spreadOffset: SpreadOffset): void {
    if (spreadOffset === this.state.spreadOffset) return;
    this.update({...this.state, spreadOffset}, "mode");
  }

  nextPage(): void {
    this.goToPage(this.state.currentPage + 1);
  }

  previousPage(): void {
    this.goToPage(this.state.currentPage - 1);
  }

  nextSpread(): void {
    const pages = spreadPages(
      this.state.currentPage,
      this.pageCount,
      this.state.spreadOffset
    );
    this.goToPage((pages.at(-1) ?? this.state.currentPage) + 1);
  }

  previousSpread(): void {
    const pages = spreadPages(
      this.state.currentPage,
      this.pageCount,
      this.state.spreadOffset
    );
    const previous = spreadPages(
      Math.max(1, (pages[0] ?? this.state.currentPage) - 1),
      this.pageCount,
      this.state.spreadOffset
    );
    this.goToPage(previous[0] ?? 1);
  }

  next(): void {
    if (this.state.viewMode === "spread") this.nextSpread();
    else this.nextPage();
  }

  previous(): void {
    if (this.state.viewMode === "spread") this.previousSpread();
    else this.previousPage();
  }

  private update(state: ViewerState, cause: NavigationCause): void {
    this.state = state;
    this.onChange({state: this.getState(), cause});
  }
}
