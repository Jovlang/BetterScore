import {
  SpreadOffset,
  ViewerState,
  ViewMode,
  clampPage,
  createViewerState,
  nextSpreadAnchor,
  previousSpreadAnchor
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
    this.goToPage(nextSpreadAnchor(
      this.state.currentPage,
      this.state.spreadOffset,
      this.pageCount
    ));
  }

  previousSpread(): void {
    this.goToPage(previousSpreadAnchor(
      this.state.currentPage,
      this.state.spreadOffset,
      this.pageCount
    ));
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
