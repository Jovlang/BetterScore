import {
  App,
  FileView,
  Menu,
  Modal,
  Notice,
  TFile,
  WorkspaceLeaf,
  loadPdfJs,
  setIcon
} from "obsidian";
import {AnnotationStore, PreparedAnnotationSave} from "./annotation-store";
import {drawPageAnnotations} from "./annotation-renderer";
import {precisionErase, strokeIntersectsEraser} from "./eraser";
import {shouldRecordSample, simplifyStrokePoints} from "./simplify";
import {SaveCoordinator} from "./save-coordinator";
import {NavigationChange, NavigationController} from "./navigation-controller";
import {pageNavigationAction, routePointerInput} from "./input-router";
import {PerformanceWakeLock} from "./performance-wake-lock";
import {FingerPan} from "./finger-pan";
import {PinchZoom} from "./pinch-zoom";
import {PageSurface} from "./page-surface";
import {PageSurfaceManager} from "./page-surface-manager";
import type {PageCacheOptions, PageSurfaceStats, ZoomAnchor} from "./page-surface-manager";
import {PdfExportController} from "./pdf-export-controller";
import type {PdfDocument} from "./pdf-types";
import {ThumbnailStrip} from "./thumbnail-strip";
import {createViewerState} from "./viewer-layout";
import type {SpreadOffset, ViewerState, ViewMode} from "./viewer-layout";
import {normalizeWheelDelta, zoomStepsForWheelDelta} from "./zoom-input";
import {
  AnnotationDocument,
  AnnotationTool,
  PageAnnotations,
  SourceFingerprintMismatchError,
  Stroke,
  StrokePoint,
  createAnnotationDocument
} from "./model";
import {createSourceIdentity} from "./source-identity";
import {
  EraserMode,
  INK_PRESETS,
  InkStyle,
  inkWidthLabel,
  nearlyEqual
} from "./settings";

export const VIEW_TYPE_BETTERSCORE = "betterscore-pdf";

type ActiveTool = AnnotationTool | "eraser" | "text";

interface ReadingPositionPersistence {
  restore: (fingerprint: string, fallback: ViewerState) => ViewerState;
  remember: (fingerprint: string, state: ViewerState) => void;
  flush: () => Promise<void>;
}

interface NavigationGesture {
  surface: PageSurface;
  pointerId: number;
  startX: number;
  startY: number;
  startedAt: number;
}

interface AnnotationGesture {
  surface: PageSurface;
  pointerId: number;
  stroke: Stroke | null;
}

export class BetterScoreView extends FileView {
  private readonly store = new AnnotationStore(this.app.vault);
  private readonly pdfExporter = new PdfExportController(this.app);
  private pdf: PdfDocument | null = null;
  private annotations: AnnotationDocument = createAnnotationDocument({
    path: "",
    fingerprint: "",
    size: 0
  });
  private annotationsWritable = true;
  private annotationBlockReason = "";
  private surfaceManager: PageSurfaceManager | null = null;
  private navigationController: NavigationController | null = null;
  private readingFingerprint: string | null = null;
  private renderedViewMode: ViewMode | null = null;
  private navigationGesture: NavigationGesture | null = null;
  private tool: ActiveTool = "pen";
  private undoStack: AnnotationDocument[] = [];
  private redoStack: AnnotationDocument[] = [];
  private readonly saveCoordinator: SaveCoordinator<PreparedAnnotationSave>;
  private annotationGesture: AnnotationGesture | null = null;
  private fingerPan: FingerPan | null = null;
  private pinchZoom: PinchZoom | null = null;
  private performanceMode = false;
  private pendingPerformanceToggle = false;
  private performanceFrame: number | null = null;
  private performanceButton: HTMLButtonElement | null = null;
  private exitPerformanceButton: HTMLButtonElement | null = null;
  private readonly wakeLock = new PerformanceWakeLock(async () =>
    this.contentEl.ownerDocument.defaultView?.navigator.wakeLock?.request("screen")
  );
  private toolbar: HTMLElement | null = null;
  private viewerBody: HTMLElement | null = null;
  private thumbnailPane: HTMLElement | null = null;
  private scoreContainer: HTMLElement | null = null;
  private thumbnailStrip: ThumbnailStrip | null = null;
  private thumbnailsOpen = false;
  private undoButton: HTMLButtonElement | null = null;
  private redoButton: HTMLButtonElement | null = null;
  private inkStyleButton: HTMLButtonElement | null = null;
  private eraserButton: HTMLButtonElement | null = null;
  private fingerDrawingButton: HTMLButtonElement | null = null;
  private thumbnailButton: HTMLButtonElement | null = null;
  private zoomResetButton: HTMLButtonElement | null = null;
  private exportButton: HTMLButtonElement | null = null;
  private spreadModeButton: HTMLButtonElement | null = null;
  private wheelZoomDelta = 0;
  private wheelZoomTimer: number | null = null;
  private readonly viewModeButtons = new Map<ViewMode, HTMLButtonElement>();

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getInkStyle: (tool: AnnotationTool) => InkStyle,
    private readonly setInkStyle: (tool: AnnotationTool, change: Partial<InkStyle>) => Promise<void>,
    private readonly getEraserMode: () => EraserMode,
    private readonly setEraserMode: (mode: EraserMode) => Promise<void>,
    private readonly getFingerDrawingEnabled: () => boolean,
    private readonly setFingerDrawingEnabled: (enabled: boolean) => Promise<void>,
    private readonly getPageCacheOptions: () => PageCacheOptions,
    private readonly readingPositions: ReadingPositionPersistence
  ) {
    super(leaf);
    this.navigation = true;
    this.saveCoordinator = new SaveCoordinator(
      (prepared) => this.store.save(prepared),
      500,
      (error) => this.reportSaveError(error)
    );
    this.registerDomEvent(document, "keydown", (event) => this.handleKeyboardShortcut(event));
    this.registerDomEvent(
      this.contentEl,
      "wheel",
      (event) => this.handleZoomWheel(event),
      {passive: false}
    );
    const doc = this.contentEl.ownerDocument;
    this.registerDomEvent(doc, "visibilitychange", () => {
      if (doc.visibilityState === "hidden") void this.flushSave();
      this.updatePerformanceWakeLock();
    });
    for (const event of ["pointerup", "pointercancel", "lostpointercapture"] as const) {
      this.registerDomEvent(doc, event, () => this.schedulePerformanceToggle(), {capture: true});
    }
    this.registerEvent(this.app.workspace.on("active-leaf-change", (activeLeaf) => {
      if (activeLeaf && activeLeaf !== leaf) this.exitPerformanceMode();
    }));
  }

  getViewType(): string {
    return VIEW_TYPE_BETTERSCORE;
  }

  getDisplayText(): string {
    return this.file?.basename ?? "BetterScore";
  }

  getIcon(): string {
    return "music-2";
  }

  getRenderStats(): PageSurfaceStats | null {
    return this.surfaceManager?.getStats() ?? null;
  }

  getViewerState(): ViewerState | null {
    return this.navigationController?.getState() ?? null;
  }

  goToPage(pageNumber: number): void {
    this.navigationController?.goToPage(pageNumber);
  }

  navigateNext(): void {
    this.navigationController?.next();
  }

  navigatePrevious(): void {
    this.navigationController?.previous();
  }

  setViewMode(mode: ViewMode): void {
    this.navigationController?.setViewMode(mode);
  }

  setSpreadOffset(offset: SpreadOffset): void {
    this.navigationController?.setSpreadOffset(offset);
  }

  async setPageCacheOptions(options: PageCacheOptions): Promise<void> {
    await this.surfaceManager?.setCacheOptions(options);
  }

  toggleFingerDrawing(): void {
    void this.setFingerDrawingEnabled(!this.getFingerDrawingEnabled()).then(() => {
      this.updateFingerDrawingButton();
    });
  }

  toggleThumbnails(): void {
    this.thumbnailsOpen = !this.thumbnailsOpen;
    this.thumbnailPane?.toggleClass("is-open", this.thumbnailsOpen);
    this.thumbnailButton?.toggleClass("is-active", this.thumbnailsOpen);
    if (this.thumbnailsOpen) this.thumbnailStrip?.activate();
    const manager = this.surfaceManager;
    window.requestAnimationFrame(() => {
      if (manager === this.surfaceManager) void manager?.refreshLayout();
    });
  }

  canTogglePerformanceMode(): boolean {
    return this.performanceMode || (this.readingFingerprint !== null && this.surfaceManager !== null);
  }

  togglePerformanceMode(): void {
    if (!this.canTogglePerformanceMode()) return;
    this.pendingPerformanceToggle = !this.pendingPerformanceToggle;
    this.applyPendingPerformanceToggle();
  }

  exitPerformanceMode(restoreLayout = true): void {
    this.pendingPerformanceToggle = false;
    if (this.performanceFrame !== null) window.cancelAnimationFrame(this.performanceFrame);
    this.performanceFrame = null;
    this.setPerformanceMode(false, restoreLayout);
  }

  private schedulePerformanceToggle(): void {
    if (!this.pendingPerformanceToggle || this.performanceFrame !== null) return;
    this.performanceFrame = window.requestAnimationFrame(() => {
      this.performanceFrame = null;
      this.applyPendingPerformanceToggle();
    });
  }

  private applyPendingPerformanceToggle(): void {
    if (!this.pendingPerformanceToggle || this.annotationGesture || this.pinchZoom?.isActive ||
        this.navigationGesture) return;
    this.pendingPerformanceToggle = false;
    this.setPerformanceMode(!this.performanceMode);
  }

  private updatePerformanceWakeLock(): void {
    this.wakeLock.setWanted(this.performanceMode &&
      this.contentEl.ownerDocument.visibilityState === "visible");
  }

  private setPerformanceMode(enabled: boolean, restoreLayout = true): void {
    if (this.performanceMode === enabled) return;
    const manager = this.surfaceManager;
    const anchor = restoreLayout ? manager?.captureViewportAnchor() : undefined;
    this.fingerPan?.reset();
    this.clearWheelZoom();
    this.performanceMode = enabled;
    this.contentEl.toggleClass("betterscore-performance", enabled);
    this.scoreContainer?.toggleClass("betterscore-performance-pages", enabled);
    if (this.exitPerformanceButton) this.exitPerformanceButton.hidden = !enabled;
    this.updatePerformanceWakeLock();
    if (restoreLayout) {
      manager?.resizeViewport(anchor);
      const button = enabled ? this.exitPerformanceButton : this.performanceButton;
      if (enabled || this.app.workspace.getActiveViewOfType(BetterScoreView) === this) {
        button?.focus({preventScroll: true});
      }
    }
  }

  zoomIn(): void {
    this.changeZoom(0.25);
  }

  zoomOut(): void {
    this.changeZoom(-0.25);
  }

  resetZoom(): void {
    this.setZoom(1);
  }

  exportFlattenedPdf(): void {
    void this.exportFlattenedPdfNow();
  }

  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.openScore(file);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    this.exitPerformanceMode(false);
    this.finishAnnotation();
    this.readingFingerprint = null;
    await Promise.all([this.flushSave(), this.readingPositions.flush()]);
    await this.destroyPdf();
    await super.onUnloadFile(file);
  }

  async onClose(): Promise<void> {
    this.exitPerformanceMode(false);
    this.finishAnnotation();
    this.readingFingerprint = null;
    await Promise.all([this.disposeSaveCoordinator(), this.readingPositions.flush()]);
    await this.destroyPdf();
  }

  private async openScore(file: TFile): Promise<void> {
    this.clearWheelZoom();
    this.undoStack = [];
    this.redoStack = [];
    this.navigationController = null;
    this.readingFingerprint = null;
    this.renderedViewMode = null;
    this.navigationGesture = null;
    this.thumbnailsOpen = false;
    this.annotationsWritable = true;
    this.annotationBlockReason = "";
    this.contentEl.empty();
    this.contentEl.addClass("betterscore-view");
    this.renderToolbar();
    this.exitPerformanceButton = this.contentEl.createEl("button", {
      cls: "betterscore-performance-exit",
      attr: {type: "button", "aria-label": "Exit fullscreen", title: "Exit fullscreen"}
    });
    this.exitPerformanceButton.hidden = true;
    setIcon(this.exitPerformanceButton, "minimize");
    this.exitPerformanceButton.addEventListener("click", () => this.togglePerformanceMode());
    this.viewerBody = this.contentEl.createDiv({cls: "betterscore-viewer-body"});
    this.thumbnailPane = this.viewerBody.createDiv({cls: "betterscore-thumbnail-pane"});
    this.scoreContainer = this.viewerBody.createDiv({cls: "betterscore-pages"});
    this.fingerPan = new FingerPan(this.scoreContainer, () => this.canFingerPan(), () => !this.annotationGesture);
    this.pinchZoom = new PinchZoom(this.scoreContainer, (point) => {
      if (this.getFingerDrawingEnabled() || this.annotationGesture) return null;
      const session = this.surfaceManager?.startPinch(point, (zoom, anchor) => this.setZoom(zoom, anchor));
      if (!session) return null;
      this.clearWheelZoom();
      this.fingerPan?.reset();
      const navigation = this.navigationGesture;
      this.navigationGesture = null;
      navigation?.surface.releasePointer(navigation.pointerId);
      return session;
    });
    this.scoreContainer.createDiv({cls: "betterscore-loading", text: "Loading score…"});

    try {
      const pdfjs = await loadPdfJs();
      const data = await this.app.vault.readBinary(file);
      const source = await createSourceIdentity(file.path, data);
      try {
        this.annotations = await this.store.load(file, source);
      } catch (error) {
        this.annotations = createAnnotationDocument(source);
        this.annotationsWritable = false;
        this.annotationBlockReason = error instanceof SourceFingerprintMismatchError
          ? "This PDF does not match the annotation sidecar. Existing annotations were preserved."
          : `The annotation sidecar could not be read. Existing data was preserved: ${messageOf(error)}`;
        new Notice(`BetterScore: ${this.annotationBlockReason}`);
      }
      this.pdf = (await pdfjs.getDocument({data}).promise) as PdfDocument;
      this.navigationController = new NavigationController(
        this.pdf.numPages,
        (change) => this.handleNavigationChange(change),
        this.readingPositions.restore(source.fingerprint, {
          ...createViewerState(), spreadOffset: this.annotations.settings.spreadOffset
        })
      );
      this.updateViewModeButtons();
      this.scoreContainer.empty();
      this.surfaceManager = new PageSurfaceManager(this.scoreContainer, this.pdf, {
        onPointerDown: (surface, event) => this.handlePointerDown(surface, event),
        onPointerMove: (surface, event) => this.handlePointerMove(surface, event),
        onPointerEnd: (surface, event) => this.handlePointerEnd(surface, event),
        onSurfaceDestroy: (surface) => {
          if (this.annotationGesture?.surface === surface) this.finishAnnotation();
          if (this.navigationGesture?.surface === surface) this.navigationGesture = null;
        },
        drawAnnotations: (surface) => this.drawSurface(surface),
        onCurrentPageChange: (pageNumber) => {
          this.navigationController?.syncViewportPage(pageNumber);
        },
        onRenderError: (pageNumber, error) => {
          new Notice(`BetterScore could not render page ${pageNumber}: ${messageOf(error)}`);
        }
      }, source.size, this.getPageCacheOptions());
      this.thumbnailStrip = new ThumbnailStrip(
        this.thumbnailPane,
        this.pdf,
        (pageNumber) => this.navigationController?.goToPage(pageNumber),
        (pageNumber, error) => {
          console.warn(`BetterScore thumbnail ${pageNumber} failed`, error);
        }
      );
      const initialState = this.navigationController.getState();
      this.thumbnailStrip.setCurrentPage(initialState.currentPage, this.thumbnailsOpen);
      if (await this.surfaceManager.setLayout(initialState)) {
        this.renderedViewMode = initialState.viewMode;
        this.readingFingerprint = source.fingerprint;
      }
    } catch (error) {
      this.thumbnailStrip?.dispose();
      this.thumbnailStrip = null;
      this.surfaceManager?.dispose();
      this.surfaceManager = null;
      this.scoreContainer.empty();
      this.scoreContainer.createDiv({
        cls: "betterscore-error",
        text: `Could not open this PDF: ${messageOf(error)}`
      });
    }
  }

  private renderToolbar(): void {
    this.toolbar = this.contentEl.createDiv({cls: "betterscore-toolbar"});
    this.performanceButton = this.addActionButton("maximize", "Enter fullscreen", "",
      () => this.togglePerformanceMode());
    this.viewModeButtons.clear();
    this.addViewModeButton("rows-3", "Continuous", "continuous");
    this.addViewModeButton("rectangle-horizontal", "Single page", "single");
    this.spreadModeButton = this.addViewModeButton("book-open", "Two-page spread", "spread");
    this.spreadModeButton?.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showSpreadOffsetMenu(event);
    });
    this.addActionButton("chevron-left", "Previous", "←", () => this.navigatePrevious());
    this.addActionButton("chevron-right", "Next", "→", () => this.navigateNext());
    this.thumbnailButton = this.addActionButton("panel-left", "Thumbnails", "", () => {
      this.toggleThumbnails();
    });
    this.thumbnailButton?.addClass("betterscore-thumbnail-toggle");
    this.addActionButton("zoom-out", "Zoom out", "Ctrl/⌘ -", () => this.zoomOut());
    this.zoomResetButton = this.addActionButton("scan", "Reset zoom", "Ctrl/⌘ 0", () => {
      this.resetZoom();
    });
    this.addActionButton("zoom-in", "Zoom in", "Ctrl/⌘ +", () => this.zoomIn());
    this.toolbar.createDiv({cls: "betterscore-toolbar-divider"});
    this.addToolButton("pencil", "Pen", "pen");
    this.addToolButton("highlighter", "Marker", "highlighter");
    this.inkStyleButton = this.toolbar.createEl("button", {
      cls: "clickable-icon betterscore-ink-style",
      attr: {type: "button", "aria-haspopup": "menu"}
    });
    setIcon(this.inkStyleButton, "palette");
    const inkStyleButton = this.inkStyleButton;
    inkStyleButton.addEventListener("click", () => {
      if (this.tool !== "pen" && this.tool !== "highlighter") return;
      const rect = inkStyleButton.getBoundingClientRect();
      this.createInkStyleMenu(this.tool).showAtPosition(
        {x: rect.left, y: rect.bottom},
        inkStyleButton.ownerDocument
      );
    });
    this.addToolButton("type", "Text", "text");
    this.eraserButton = this.addToolButton("eraser", "Eraser", "eraser");
    this.updateEraserButton();
    this.eraserButton?.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showEraserModeMenu(event);
    });
    this.fingerDrawingButton = this.toolbar.createEl("button", {
      cls: "clickable-icon betterscore-finger-drawing",
      attr: {"aria-label": "Draw with finger", title: "Draw with finger"}
    });
    setIcon(this.fingerDrawingButton, "hand");
    this.fingerDrawingButton.addEventListener("click", () => this.toggleFingerDrawing());
    this.toolbar.createDiv({cls: "betterscore-toolbar-divider"});
    this.undoButton = this.addActionButton("undo-2", "Undo", "Ctrl/⌘ Z", () => this.undo());
    this.redoButton = this.addActionButton(
      "redo-2",
      "Redo",
      "Ctrl/⌘ Shift Z",
      () => this.redo()
    );
    this.exportButton = this.addActionButton("download", "Export flattened PDF", "", () => {
      this.exportFlattenedPdf();
    });
    this.updateToolButtons();
    this.updateHistoryButtons();
    this.updateViewModeButtons();
    this.updateFingerDrawingButton();
    this.updateZoomButton();
  }

  private updateFingerDrawingButton(): void {
    const enabled = this.getFingerDrawingEnabled();
    this.fingerDrawingButton?.toggleClass("is-active", enabled);
    if (enabled) {
      this.fingerPan?.reset();
      this.pinchZoom?.reset();
    }
    const state = enabled ? "on" : "off";
    this.fingerDrawingButton?.setAttribute(
      "aria-label",
      `Draw with finger: ${state}. Tap to turn ${enabled ? "off" : "on"}.`
    );
    this.fingerDrawingButton?.setAttribute(
      "title",
      enabled
        ? "Finger drawing: on · Finger scrolling, pinch zoom, and page turns are disabled"
        : "Finger drawing: off · Tap to draw with a finger"
    );
  }

  private changeZoom(delta: number): void {
    const current = this.surfaceManager?.getZoom() ?? 1;
    this.setZoom(current + delta);
  }

  private canFingerPan(): boolean {
    return !this.getFingerDrawingEnabled() && (
      this.navigationController?.getState().viewMode === "continuous"
      || (this.surfaceManager?.getZoom() ?? 1) > 1
    );
  }

  private setZoom(zoom: number, anchor?: ZoomAnchor): void {
    const manager = this.surfaceManager;
    if (!manager) return;
    if (!anchor) {
      this.fingerPan?.reset();
      this.pinchZoom?.reset();
    }
    void manager.setZoom(zoom, anchor).then(() => {
      if (manager === this.surfaceManager) this.updateZoomButton();
    }).catch((error: unknown) => {
      new Notice(`BetterScore could not zoom: ${messageOf(error)}`);
    });
  }

  private updateZoomButton(): void {
    const percent = Math.round((this.surfaceManager?.getZoom() ?? 1) * 100);
    this.zoomResetButton?.setAttribute("aria-label", `Reset zoom. Current zoom: ${percent}%`);
    this.zoomResetButton?.setAttribute("title", `Zoom: ${percent}% · Reset`);
  }

  private async exportFlattenedPdfNow(): Promise<void> {
    if (!this.file || this.pdfExporter.isExporting()) return;
    if (this.exportButton) this.exportButton.disabled = true;
    const sourceFile = this.file;
    try {
      await this.flushSave();
      await this.pdfExporter.export(sourceFile, structuredClone(this.annotations));
    } finally {
      if (this.exportButton) this.exportButton.disabled = false;
    }
  }

  private addViewModeButton(
    icon: string,
    label: string,
    mode: ViewMode
  ): HTMLButtonElement | null {
    const button = this.toolbar?.createEl("button", {
      cls: "clickable-icon betterscore-view-mode",
      attr: {"aria-label": label, "data-view-mode": mode, title: label}
    });
    if (!button) return null;
    setIcon(button, icon);
    button.addEventListener("click", () => this.setViewMode(mode));
    this.viewModeButtons.set(mode, button);
    return button;
  }

  private showSpreadOffsetMenu(event: MouseEvent): void {
    const current = this.navigationController?.getState().spreadOffset
      ?? this.annotations.settings.spreadOffset;
    const menu = new Menu();
    const choices: Array<{offset: SpreadOffset; label: string}> = [
      {offset: 0, label: "Page 1 alone on the right"},
      {offset: 1, label: "Pair pages 1 and 2"}
    ];
    for (const choice of choices) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setChecked(current === choice.offset)
          .onClick(() => this.setSpreadOffset(choice.offset));
      });
    }
    menu.showAtMouseEvent(event);
  }

  private updateViewModeButtons(): void {
    const state = this.navigationController?.getState() ?? createViewerState();
    for (const [mode, button] of this.viewModeButtons) {
      button.toggleClass("is-active", mode === state.viewMode);
    }
    if (this.spreadModeButton) {
      const pairing = state.spreadOffset === 0 ? "page 1 alone" : "pages 1–2 paired";
      this.spreadModeButton.setAttribute(
        "aria-label",
        `Two-page spread · ${pairing}. Right-click to change pairing.`
      );
      this.spreadModeButton.setAttribute(
        "title",
        `Spread pairing: ${pairing} · Right-click to change`
      );
    }
  }

  private addToolButton(
    icon: string,
    label: string,
    tool: ActiveTool
  ): HTMLButtonElement | null {
    const button = this.toolbar?.createEl("button", {
      cls: "clickable-icon betterscore-tool",
      attr: {"aria-label": label, "data-tool": tool, title: label}
    });
    if (!button) return null;
    setIcon(button, icon);
    if (tool === "pen" || tool === "highlighter") {
      button.createSpan({cls: "betterscore-ink-swatch", attr: {"aria-hidden": "true"}});
      button.addEventListener("contextmenu", (event) => {
        event.preventDefault();
        this.createInkStyleMenu(tool).showAtMouseEvent(event);
      });
    }
    button.addEventListener("click", () => {
      this.tool = tool;
      this.updateToolButtons();
    });
    return button;
  }

  private createInkStyleMenu(tool: AnnotationTool): Menu {
    const style = this.getInkStyle(tool);
    const presets = INK_PRESETS[tool];
    const menu = new Menu();
    for (const preset of presets.colors) {
      menu.addItem((item) => item
        .setTitle(`${presets.label} color: ${preset.label}`)
        .setChecked(style.color === preset.color)
        .onClick(() => this.setInkStyle(tool, {color: preset.color})));
    }
    menu.addSeparator();
    for (const preset of presets.widths) {
      menu.addItem((item) => item
        .setTitle(`${presets.label} width: ${preset.label}`)
        .setChecked(nearlyEqual(style.width, preset.width))
        .onClick(() => this.setInkStyle(tool, {width: preset.width})));
    }
    return menu;
  }

  refreshInkStyleButtons(): void {
    for (const tool of ["pen", "highlighter"] as const) {
      const button = this.toolbar?.querySelector<HTMLButtonElement>(`[data-tool="${tool}"]`);
      if (!button) continue;
      const {color, width} = this.getInkStyle(tool);
      const presets = INK_PRESETS[tool];
      const colorLabel = presets.colors.find((preset) => preset.color === color)?.label;
      const label = `${presets.label} · ${colorLabel ?? color} · ${inkWidthLabel(tool, width)}`;
      button.style.setProperty("--betterscore-ink-color", color);
      button.setAttribute("aria-label", label);
      button.title = `${label} · Right-click for color and width`;
    }
    if (this.inkStyleButton) {
      const inkTool = this.tool === "pen" || this.tool === "highlighter" ? this.tool : null;
      const label = inkTool
        ? `${INK_PRESETS[inkTool].label} color and width`
        : "Select Pen or Marker to change color and width";
      this.inkStyleButton.disabled = inkTool === null;
      this.inkStyleButton.setAttribute("aria-label", label);
      this.inkStyleButton.title = label;
    }
  }

  private showEraserModeMenu(event: MouseEvent): void {
    const current = this.getEraserMode();
    const menu = new Menu();
    const choices: Array<{mode: EraserMode; label: string}> = [
      {mode: "stroke", label: "Stroke eraser"},
      {mode: "precision", label: "Precision eraser"}
    ];
    for (const choice of choices) {
      menu.addItem((item) => {
        item
          .setTitle(choice.label)
          .setChecked(current === choice.mode)
          .onClick(async () => {
            await this.setEraserMode(choice.mode);
            this.updateEraserButton();
          });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private updateEraserButton(): void {
    if (!this.eraserButton) return;
    const label = this.getEraserMode() === "precision" ? "Precision" : "Stroke";
    this.eraserButton.setAttribute(
      "aria-label",
      `Eraser · ${label}. Right-click to change mode.`
    );
    this.eraserButton.setAttribute("title", `Eraser mode: ${label} · Right-click to change`);
  }

  private addActionButton(
    icon: string,
    label: string,
    shortcut: string,
    action: () => void
  ): HTMLButtonElement | null {
    const description = shortcut ? `${label} (${shortcut})` : label;
    const button = this.toolbar?.createEl("button", {
      cls: "clickable-icon betterscore-history-action",
      attr: {"aria-label": description, title: description}
    });
    if (!button) return null;
    setIcon(button, icon);
    button.addEventListener("click", action);
    return button;
  }

  private updateToolButtons(): void {
    this.toolbar?.querySelectorAll<HTMLElement>("[data-tool]").forEach((button) => {
      const active = button.dataset.tool === this.tool;
      button.toggleClass("is-active", active);
      button.setAttribute("aria-pressed", String(active));
    });
    this.refreshInkStyleButtons();
  }

  private handlePointerDown(surface: PageSurface, event: PointerEvent): void {
    if (event.pointerType === "touch" && this.canFingerPan()) return;
    const {pageNumber} = surface;
    const viewMode = this.navigationController?.getState().viewMode ?? "continuous";
    const intent = routePointerInput(
      event.pointerType,
      viewMode,
      this.getFingerDrawingEnabled()
    );
    if (intent === "scroll") return;
    if (intent === "page-navigation") {
      if (this.navigationGesture) return;
      event.preventDefault();
      surface.capturePointer(event.pointerId);
      this.navigationGesture = {
        surface,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        startedAt: performance.now()
      };
      return;
    }
    if (this.annotationGesture || (event.button !== 0 && event.pointerType === "mouse")) return;
    if (!this.annotationsWritable) {
      new Notice(`BetterScore: ${this.annotationBlockReason}`);
      return;
    }
    event.preventDefault();

    const point = surface.pointFromEvent(event);
    if (this.tool === "text") {
      this.openTextInput(pageNumber, point);
      return;
    }

    surface.capturePointer(event.pointerId);
    const gesture: AnnotationGesture = {surface, pointerId: event.pointerId, stroke: null};
    this.annotationGesture = gesture;
    this.pushUndoState();
    if (this.tool === "eraser") {
      this.eraseAt(pageNumber, point);
      return;
    }

    gesture.stroke = {
      id: crypto.randomUUID(),
      tool: this.tool,
      ...this.getInkStyle(this.tool),
      opacity: this.tool === "highlighter" ? 0.2 : 0.92,
      points: [point]
    };
    this.page(pageNumber).strokes.push(gesture.stroke);
    this.drawPage(pageNumber);
  }

  private handlePointerMove(surface: PageSurface, event: PointerEvent): void {
    if (this.navigationGesture?.pointerId === event.pointerId && this.navigationGesture.surface === surface) {
      event.preventDefault();
      return;
    }
    // Touch contacts can be implicitly captured, even when routed away from ink.
    const gesture = this.annotationGesture;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.surface !== surface) return;
    const point = surface.pointFromEvent(event);
    if (!gesture.stroke) {
      this.eraseAt(surface.pageNumber, point);
    } else {
      const previous = gesture.stroke.points[gesture.stroke.points.length - 1];
      if (!previous || shouldRecordSample(previous, point)) {
        gesture.stroke.points.push(point);
        this.drawPage(surface.pageNumber);
      }
    }
  }

  private handlePointerEnd(surface: PageSurface, event: PointerEvent): void {
    if (this.navigationGesture?.pointerId === event.pointerId && this.navigationGesture.surface === surface) {
      const gesture = this.navigationGesture;
      this.navigationGesture = null;
      surface.releasePointer(event.pointerId);
      if (event.type === "pointerup") this.finishNavigationGesture(surface, gesture, event);
      return;
    }
    const gesture = this.annotationGesture;
    if (!gesture || gesture.pointerId !== event.pointerId || gesture.surface !== surface) return;
    if (gesture.stroke && event.type === "pointerup") {
      const finalPoint = surface.pointFromEvent(event);
      const previous = gesture.stroke.points[gesture.stroke.points.length - 1];
      if (!previous || shouldRecordSample(previous, finalPoint)) gesture.stroke.points.push(finalPoint);
    }
    this.finishAnnotation();
  }

  private finishAnnotation(): void {
    const gesture = this.annotationGesture;
    if (!gesture) return;
    this.annotationGesture = null;
    gesture.surface.releasePointer(gesture.pointerId);
    if (!gesture.stroke) return;
    gesture.stroke.points = simplifyStrokePoints(gesture.stroke.points, gesture.stroke.tool);
    this.drawPage(gesture.surface.pageNumber);
    this.scheduleSave();
  }

  private finishNavigationGesture(
    surface: PageSurface,
    gesture: NavigationGesture,
    event: PointerEvent
  ): void {
    const endX = event.clientX;
    const endY = event.clientY;
    const bounds = surface.overlay.getBoundingClientRect();
    const action = pageNavigationAction({
      startX: gesture.startX,
      startY: gesture.startY,
      endX,
      endY,
      surfaceLeft: bounds.left,
      surfaceWidth: bounds.width,
      durationMs: performance.now() - gesture.startedAt
    });
    if (action === "next") this.navigationController?.next();
    else if (action === "previous") this.navigationController?.previous();
  }

  private eraseAt(pageNumber: number, point: StrokePoint): void {
    const page = this.page(pageNumber);
    const precision = this.getEraserMode() === "precision";
    const radius = precision ? 0.012 : 0.025;
    const precisionResult = precision ? precisionErase(page.strokes, point, radius) : null;
    const remainingStrokes = precisionResult?.strokes ?? page.strokes.filter(
      (stroke) => !strokeIntersectsEraser(stroke, point, radius)
    );
    const remainingTexts = page.texts.filter(
      (text) => Math.hypot(text.x - point.x, text.y - point.y) >= 0.045
    );
    const textChanged = remainingTexts.length !== page.texts.length;
    const strokeChanged = precisionResult?.changed
      ?? remainingStrokes.length !== page.strokes.length;
    if (!strokeChanged && !textChanged) return;
    page.strokes = remainingStrokes;
    page.texts = remainingTexts;
    this.drawPage(pageNumber);
    this.scheduleSave();
  }

  private drawPage(pageNumber: number): void {
    const surface = this.surfaceManager?.getSurface(pageNumber);
    if (!surface) return;
    this.drawSurface(surface);
  }

  private drawSurface(surface: PageSurface): void {
    const annotations = this.annotations.pages[String(surface.pageNumber)]
      ?? {strokes: [], texts: []};
    surface.drawAnnotations((context, width, height) => {
      drawPageAnnotations(context, annotations, width, height);
    });
  }

  private page(pageNumber: number): PageAnnotations {
    const key = String(pageNumber);
    return (this.annotations.pages[key] ??= {strokes: [], texts: []});
  }

  private openTextInput(pageNumber: number, point: StrokePoint): void {
    new TextAnnotationModal(this.app, (value) => {
      const text = value.trim();
      if (!text) return;
      this.pushUndoState();
      this.page(pageNumber).texts.push({
        id: crypto.randomUUID(),
        x: point.x,
        y: point.y,
        text,
        color: "#e53935",
        fontSize: 0.025
      });
      this.drawPage(pageNumber);
      this.scheduleSave();
    }).open();
  }

  private pushUndoState(): void {
    this.undoStack.push(structuredClone(this.annotations));
    if (this.undoStack.length > 50) this.undoStack.shift();
    this.redoStack = [];
    this.updateHistoryButtons();
  }

  private undo(): void {
    const previous = this.undoStack.pop();
    if (!previous) return;
    this.redoStack.push(structuredClone(this.annotations));
    previous.settings = this.annotations.settings;
    this.annotations = previous;
    this.redrawAll();
    this.scheduleSave();
    this.updateHistoryButtons();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.annotations));
    next.settings = this.annotations.settings;
    this.annotations = next;
    this.redrawAll();
    this.scheduleSave();
    this.updateHistoryButtons();
  }

  private updateHistoryButtons(): void {
    if (this.undoButton) this.undoButton.disabled = this.undoStack.length === 0;
    if (this.redoButton) this.redoButton.disabled = this.redoStack.length === 0;
  }

  private handleKeyboardShortcut(event: KeyboardEvent): void {
    if (this.handleHistoryShortcut(event)) return;
    if (this.app.workspace.getActiveViewOfType(BetterScoreView) !== this) return;
    if (isTextInput(event.target)) return;
    if (event.key === "Escape" && this.performanceMode && !event.defaultPrevented &&
        !this.contentEl.ownerDocument.querySelector(".modal-container, .menu")) {
      event.preventDefault();
      if (!this.pendingPerformanceToggle) this.togglePerformanceMode();
      return;
    }
    if (this.handleZoomShortcut(event)) return;
    if (event.metaKey || event.ctrlKey || event.altKey) return;

    if (event.key === "ArrowRight" || event.key === "PageDown") {
      event.preventDefault();
      this.navigationController?.next();
    } else if (event.key === "ArrowLeft" || event.key === "PageUp") {
      event.preventDefault();
      this.navigationController?.previous();
    } else if (event.key === "Home") {
      event.preventDefault();
      this.navigationController?.goToPage(1);
    } else if (event.key === "End") {
      event.preventDefault();
      const pageCount = this.pdf?.numPages ?? 1;
      this.navigationController?.goToPage(pageCount);
    }
  }

  private handleZoomShortcut(event: KeyboardEvent): boolean {
    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier || event.altKey) return false;
    if (event.key === "+" || event.key === "=") {
      event.preventDefault();
      this.zoomIn();
      return true;
    }
    if (event.key === "-") {
      event.preventDefault();
      this.zoomOut();
      return true;
    }
    if (event.key === "0") {
      event.preventDefault();
      this.resetZoom();
      return true;
    }
    return false;
  }

  private handleZoomWheel(event: WheelEvent): void {
    const target = event.target;
    if (
      !event.ctrlKey
      || !this.surfaceManager
      || !this.scoreContainer
      || !(target instanceof Node)
      || !this.scoreContainer.contains(target)
    ) {
      return;
    }
    const delta = normalizeWheelDelta(
      event.deltaY,
      event.deltaMode,
      this.scoreContainer.clientHeight
    );
    if (delta === 0) return;
    event.preventDefault();
    event.stopPropagation();
    this.wheelZoomDelta += delta;
    if (this.wheelZoomTimer !== null) window.clearTimeout(this.wheelZoomTimer);
    this.wheelZoomTimer = window.setTimeout(() => this.flushWheelZoom(), 60);
  }

  private flushWheelZoom(): void {
    const steps = zoomStepsForWheelDelta(this.wheelZoomDelta);
    this.wheelZoomDelta = 0;
    this.wheelZoomTimer = null;
    if (steps !== 0) this.changeZoom(steps * 0.25);
  }

  private clearWheelZoom(): void {
    if (this.wheelZoomTimer !== null) window.clearTimeout(this.wheelZoomTimer);
    this.wheelZoomTimer = null;
    this.wheelZoomDelta = 0;
  }

  private handleHistoryShortcut(event: KeyboardEvent): boolean {
    if (this.app.workspace.getActiveViewOfType(BetterScoreView) !== this) return false;
    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier || event.altKey) return false;

    const key = event.key.toLowerCase();
    const wantsUndo = key === "z" && !event.shiftKey;
    const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
    if (wantsUndo && this.undoStack.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.undo();
      return true;
    } else if (wantsRedo && this.redoStack.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.redo();
      return true;
    }
    return false;
  }

  private handleNavigationChange(change: NavigationChange): void {
    if (this.readingFingerprint) this.readingPositions.remember(this.readingFingerprint, change.state);
    this.updateViewModeButtons();
    this.thumbnailStrip?.setCurrentPage(change.state.currentPage, this.thumbnailsOpen);
    if (this.annotations.settings.spreadOffset !== change.state.spreadOffset) {
      this.annotations.settings.spreadOffset = change.state.spreadOffset;
      this.scheduleSave();
    }
    if (change.cause === "viewport") return;
    this.pinchZoom?.reset();
    if (change.state.viewMode === "continuous" && this.renderedViewMode === "continuous") {
      this.fingerPan?.reset();
      this.surfaceManager?.scrollToPage(change.state.currentPage, "auto");
      return;
    }
    void this.applyViewerLayout(change.state);
  }

  private async applyViewerLayout(state: ViewerState): Promise<void> {
    const manager = this.surfaceManager;
    if (!manager) return;
    this.fingerPan?.reset();
    this.finishAnnotation();
    const applied = await manager.setLayout(state);
    if (!applied || manager !== this.surfaceManager) return;
    const current = this.navigationController?.getState();
    if (
      current?.viewMode === state.viewMode
      && current.currentPage === state.currentPage
      && current.spreadOffset === state.spreadOffset
    ) {
      this.renderedViewMode = state.viewMode;
    }
  }

  private redrawAll(): void {
    for (const pageNumber of this.surfaceManager?.getMountedPageNumbers() ?? []) {
      this.drawPage(pageNumber);
    }
  }

  private scheduleSave(): void {
    if (!this.file || !this.annotationsWritable) return;
    this.saveCoordinator.schedule(this.store.prepare(this.file, this.annotations));
  }

  private async flushSave(): Promise<void> {
    try {
      await this.saveCoordinator.flush();
    } catch (error) {
      this.reportSaveError(error);
    }
  }

  private async disposeSaveCoordinator(): Promise<void> {
    try {
      await this.saveCoordinator.dispose();
    } catch (error) {
      this.reportSaveError(error);
    }
  }

  private reportSaveError(error: unknown): void {
    new Notice(`BetterScore could not save: ${messageOf(error)}`);
  }

  private async destroyPdf(): Promise<void> {
    this.clearWheelZoom();
    this.pinchZoom?.dispose();
    this.pinchZoom = null;
    this.fingerPan?.dispose();
    this.fingerPan = null;
    this.thumbnailStrip?.dispose();
    this.thumbnailStrip = null;
    this.surfaceManager?.dispose();
    this.surfaceManager = null;
    this.renderedViewMode = null;
    this.navigationGesture = null;
    if (!this.pdf) return;
    await this.pdf.destroy();
    this.pdf = null;
    this.navigationController = null;
  }
}

class TextAnnotationModal extends Modal {
  constructor(
    app: App,
    private readonly onSubmit: (text: string) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.addClass("betterscore-text-modal");
    this.contentEl.createEl("h3", {text: "Add text"});
    const input = this.contentEl.createEl("textarea", {
      attr: {
        rows: "4",
        placeholder: "Rehearsal note…",
        "aria-label": "Annotation text"
      }
    });
    const actions = this.contentEl.createDiv({cls: "betterscore-text-actions"});
    const cancel = actions.createEl("button", {text: "Cancel"});
    const add = actions.createEl("button", {cls: "mod-cta", text: "Add text"});

    const submit = (): void => {
      if (!input.value.trim()) return;
      this.onSubmit(input.value);
      this.close();
    };
    cancel.addEventListener("click", () => this.close());
    add.addEventListener("click", submit);
    input.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        submit();
      }
    });
    window.setTimeout(() => input.focus(), 0);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

function isTextInput(target: EventTarget | null): boolean {
  return target instanceof HTMLInputElement
    || target instanceof HTMLTextAreaElement
    || target instanceof HTMLSelectElement
    || (target instanceof HTMLElement && target.isContentEditable);
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
