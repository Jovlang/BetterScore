import {PageSurface, PageSurfacePointerHandlers} from "./page-surface";
import type {PdfDocument, PdfViewport} from "./pdf-types";
import {
  clampPage,
  createViewerState,
  pagesForLayout,
  pagesForRenderWindow
} from "./viewer-layout";
import type {ViewerState, ViewMode} from "./viewer-layout";
import type {PinchSession} from "./pinch-zoom";

const OBSERVER_ROOT_MARGIN = "200% 0px";
const MAX_CONCURRENT_RENDERS = 2;
const MAX_FULL_CACHE_PAGES = 24;
const MAX_FULL_CACHE_SOURCE_BYTES = 48 * 1024 * 1024;
const MAX_FULL_CACHE_CANVAS_BYTES = 192 * 1024 * 1024;
const MIN_ZOOM = 0.5;
const MAX_ZOOM = 3;
const MAX_CANVAS_DIMENSION = 4096;

export type PageCacheStrategy = "continuous" | "windowed" | "full" | "retained";

export interface PageCacheOptions {
  retainRenderedPages: boolean;
  maxCanvasBytes: number;
}

export interface RenderScales {
  cssScale: number;
  renderScale: number;
  pixelRatio: number;
}

export interface PageSurfaceStats {
  totalPages: number;
  currentPage: number;
  mountedSurfaces: number;
  activeCanvases: number;
  totalCanvasPixels: number;
  queuedRenders: number;
  activeRenders: number;
  cancelledRenders: number;
  cacheStrategy: PageCacheStrategy;
  desiredPages: number;
  cachedGeometries: number;
  estimatedSlots: number;
  estimatedCanvasBytes: number;
  canvasBudgetBytes: number | null;
  zoom: number;
}

export interface PageSurfaceManagerCallbacks extends PageSurfacePointerHandlers {
  drawAnnotations: (surface: PageSurface) => void;
  onCurrentPageChange?: (pageNumber: number) => void;
  onRenderError?: (pageNumber: number, error: unknown) => void;
}

interface QueuedRender {
  pageNumber: number;
  generation: number;
}

export interface ZoomAnchor {
  page: number;
  x: number;
  y: number;
  clientX: number;
  clientY: number;
}

export class PageSurfaceManager {
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly mounting = new Map<number, Promise<PageSurface>>();
  private readonly pageGeometry = new Map<number, PdfViewport>();
  private readonly slots = new Map<number, HTMLElement>();
  private readonly desiredPages = new Set<number>();
  private readonly queuedPages = new Set<number>();
  private readonly renderQueue: QueuedRender[] = [];
  private readonly inFlightPages = new Set<number>();
  private readonly surfaceAccess = new Map<number, number>();
  private observer: IntersectionObserver | null = null;
  private activeRenders = 0;
  private cancelledRenders = 0;
  private currentPage = 1;
  private zoom = 1;
  private estimatedPageGeometry: PdfViewport | null = null;
  private cacheStrategy: PageCacheStrategy = "continuous";
  private layoutState: ViewerState = createViewerState();
  private layoutGeneration = 0;
  private layoutRevision = 0;
  private scrollFrame: number | null = null;
  private readonly resizeObserver: ResizeObserver | null;
  private viewportSize = "";
  private resizeFrame: number | null = null;
  private accessSequence = 0;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly pdf: PdfDocument,
    private readonly callbacks: PageSurfaceManagerCallbacks,
    private readonly sourceSizeBytes = Number.POSITIVE_INFINITY,
    private cacheOptions: PageCacheOptions = {
      retainRenderedPages: false,
      maxCanvasBytes: 0
    }
  ) {
    this.viewportSize = this.viewportKey();
    this.resizeObserver = typeof ResizeObserver === "undefined" ? null
      : new ResizeObserver(this.handleResize);
    this.resizeObserver?.observe(container);
    window.addEventListener("resize", this.handleResize, {passive: true});
  }

  async initializeContinuous(): Promise<void> {
    await this.setLayout(createViewerState());
  }

  /** Rebuild only the layout; PDF geometry and the annotation model stay shared. */
  async setLayout(state: ViewerState, forceRebuild = false): Promise<boolean> {
    if (this.disposed) return false;
    const normalized = {...state, currentPage: clampPage(state.currentPage, this.pdf.numPages)};
    if (
      !forceRebuild
      && normalized.viewMode !== "continuous"
      && normalized.viewMode === this.layoutState.viewMode
    ) {
      return this.updatePagedLayout(normalized);
    }
    const generation = ++this.layoutGeneration;
    const revision = ++this.layoutRevision;
    this.layoutState = normalized;
    this.currentPage = this.layoutState.currentPage;
    this.resetLayout();
    this.container.dataset.viewMode = state.viewMode;
    this.updateZoomClass();

    const visiblePages = pagesForLayout(this.layoutState, this.pdf.numPages);
    const pages = this.renderWindowForState(this.layoutState);
    if (state.viewMode === "continuous") {
      // One real viewport is enough to establish a stable scroll height. Nearby
      // pages replace the estimate with their exact geometry when mounted.
      const referenceViewport = await this.loadPageGeometry(this.currentPage);
      if (!this.isCurrentLayout(generation, revision)) return false;
      this.estimatedPageGeometry = referenceViewport;
      for (const pageNumber of pages) {
        this.createSlot(
          pageNumber,
          this.pageGeometry.get(pageNumber) ?? referenceViewport,
          state.viewMode
        );
      }
    } else {
      for (const pageNumber of pages) {
        const baseViewport = await this.loadPageGeometry(pageNumber);
        if (!this.isCurrentLayout(generation, revision)) return false;
        this.createSlot(pageNumber, baseViewport, state.viewMode);
      }
    }

    if (!this.isCurrentLayout(generation, revision)) return false;
    if (state.viewMode === "continuous") {
      this.positionSlot(this.currentPage, "auto");
      this.installViewportObservers();
      this.requestRender(this.currentPage, true);
      if (!this.observer) {
        this.renderWindow(continuousRenderWindow(this.currentPage, this.pdf.numPages));
      }
    } else {
      this.applyPagedSlotVisibility(visiblePages);
      for (const pageNumber of visiblePages) this.requestRender(pageNumber, true);
      for (const pageNumber of pages) this.requestRender(pageNumber);
    }
    return true;
  }

  mountPage(pageNumber: number): Promise<PageSurface> {
    const existing = this.surfaces.get(pageNumber);
    if (existing) return Promise.resolve(existing);
    const pending = this.mounting.get(pageNumber);
    if (pending) return pending;
    const generation = this.layoutGeneration;
    const mounting = this.createSurface(pageNumber, generation);
    this.mounting.set(pageNumber, mounting);
    void mounting.finally(() => {
      if (this.mounting.get(pageNumber) === mounting) this.mounting.delete(pageNumber);
    }).catch(() => undefined);
    return mounting;
  }

  async renderPage(pageNumber: number): Promise<void> {
    const surface = await this.mountPage(pageNumber);
    await surface.renderPdf();
    this.touchSurface(pageNumber);
    this.enforceRetainedCanvasBudget();
  }

  renderWindow(pageNumbers: Iterable<number>): void {
    const requested = new Set(pageNumbers);
    for (const pageNumber of this.desiredPages) {
      if (!requested.has(pageNumber)) {
        this.desiredPages.delete(pageNumber);
        if (!this.cacheOptions.retainRenderedPages) this.evictPage(pageNumber);
      }
    }
    for (const pageNumber of requested) this.requestRender(pageNumber);
    this.enforceRetainedCanvasBudget();
  }

  evictPage(pageNumber: number): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface) return;
    if (surface.destroy()) this.cancelledRenders += 1;
    this.surfaces.delete(pageNumber);
    this.surfaceAccess.delete(pageNumber);
  }

  getSurface(pageNumber: number): PageSurface | undefined {
    return this.surfaces.get(pageNumber);
  }

  getMountedPageNumbers(): number[] {
    return [...this.surfaces.keys()].sort((left, right) => left - right);
  }

  getCachedPageGeometry(pageNumber: number): PdfViewport | undefined {
    return this.pageGeometry.get(pageNumber);
  }

  getCurrentPage(): number {
    return this.currentPage;
  }

  getZoom(): number {
    return this.zoom;
  }

  /** Preview with existing canvases; request sharp bitmaps only on release. */
  startPinch(
    point: {x: number; y: number},
    commit: (zoom: number, anchor: ZoomAnchor) => void
  ): PinchSession | null {
    const viewport = this.container.getBoundingClientRect();
    const visible: {slot: HTMLElement; x: number; y: number}[] = [];
    const paged = this.layoutState.viewMode === "continuous"
      ? null : new Set(pagesForLayout(this.layoutState, this.pdf.numPages));
    let anchor: ZoomAnchor | undefined;
    let nearest = Infinity;
    for (const [page, slot] of this.slots) {
      if (paged && !paged.has(page)) continue;
      const bounds = slot.getBoundingClientRect();
      if (!bounds.width || !bounds.height || bounds.bottom <= viewport.top ||
          bounds.top >= viewport.bottom || bounds.right <= viewport.left ||
          bounds.left >= viewport.right) continue;
      const x = point.x - bounds.left;
      const y = point.y - bounds.top;
      visible.push({slot, x, y});
      const withinX = Math.max(0, Math.min(x, bounds.width));
      const withinY = Math.max(0, Math.min(y, bounds.height));
      const distance = Math.hypot(x - withinX, y - withinY);
      if (distance < nearest) {
        nearest = distance;
        anchor = {
          page, x: withinX / bounds.width, y: withinY / bounds.height,
          clientX: bounds.left + withinX, clientY: bounds.top + withinY
        };
      }
    }
    if (!anchor) return null;
    const startZoom = this.zoom;
    const revision = this.layoutRevision;
    return {
      preview: (scale) => {
        const ratio = clampZoom(startZoom * scale) / startZoom;
        for (const {slot, x, y} of visible) {
          slot.style.transformOrigin = `${x}px ${y}px`;
          slot.style.transform = `scale(${ratio})`;
        }
      },
      finish: (scale) => {
        for (const {slot} of visible) {
          slot.style.transform = "";
          slot.style.transformOrigin = "";
        }
        if (scale !== null && revision === this.layoutRevision) {
          commit(clampZoom(startZoom * scale), anchor);
        }
      }
    };
  }

  async setZoom(zoom: number, anchor?: ZoomAnchor): Promise<number> {
    const normalized = clampZoom(zoom);
    if (this.disposed || normalized === this.zoom) return this.zoom;
    this.zoom = normalized;
    this.updateZoomClass();

    const mode = this.layoutState.viewMode;
    const visiblePages = mode === "continuous" ? null
      : new Set(pagesForLayout(this.layoutState, this.pdf.numPages));
    // Resize the existing layout synchronously so releasing a pinch never
    // paints an empty frame between the preview and the committed zoom.
    for (const [pageNumber, slot] of this.slots) {
      const geometry = this.pageGeometry.get(pageNumber) ?? this.estimatedPageGeometry;
      if (!geometry) continue;
      const scales = this.scalesForPage(geometry, mode);
      this.sizeSlot(slot, geometry, mode, scales, false);
      const surface = this.surfaces.get(pageNumber);
      if (!surface) continue;
      if (visiblePages ? !visiblePages.has(pageNumber) : !this.desiredPages.has(pageNumber)) {
        this.evictPage(pageNumber);
        continue;
      }
      surface.resize(scales.cssScale, scales.renderScale, scales.pixelRatio);
      this.callbacks.drawAnnotations(surface);
    }

    if (anchor) {
      const bounds = this.slots.get(anchor.page)?.getBoundingClientRect();
      if (bounds?.width && bounds.height) {
        this.container.scrollLeft += bounds.left + bounds.width * anchor.x - anchor.clientX;
        this.container.scrollTop += bounds.top + bounds.height * anchor.y - anchor.clientY;
      }
    } else if (mode === "continuous") {
      this.positionSlot(this.currentPage, "auto");
    } else {
      this.container.scrollTo({left: 0, top: 0, behavior: "auto"});
    }

    this.requestRender(anchor?.page ?? this.currentPage, true);
    if (visiblePages) {
      for (const pageNumber of visiblePages) this.requestRender(pageNumber, true);
      // A larger zoom may make a formerly full cache exceed its budget.
      await this.updatePagedLayout(this.layoutState);
    } else {
      for (const pageNumber of this.desiredPages) this.requestRender(pageNumber);
      this.scheduleCurrentPageUpdate();
    }
    return this.zoom;
  }

  async refreshLayout(): Promise<boolean> {
    return this.setLayout(this.layoutState, true);
  }

  async setCacheOptions(options: PageCacheOptions): Promise<void> {
    const wasRetaining = this.cacheOptions.retainRenderedPages;
    this.cacheOptions = options;
    if (!options.retainRenderedPages && wasRetaining) {
      await this.setLayout(this.layoutState, true);
      return;
    }
    this.enforceRetainedCanvasBudget();
    this.updateCacheStrategy();
  }

  scrollToPage(pageNumber: number, behavior: ScrollBehavior = "auto"): boolean {
    const slot = this.slots.get(pageNumber);
    if (!slot) return false;
    this.requestRender(pageNumber);
    if (pageNumber !== this.currentPage) {
      this.currentPage = pageNumber;
      this.layoutState = {...this.layoutState, currentPage: pageNumber};
      this.callbacks.onCurrentPageChange?.(pageNumber);
    }
    this.positionSlot(pageNumber, behavior);
    return true;
  }

  getStats(): PageSurfaceStats {
    let totalCanvasPixels = 0;
    for (const surface of this.surfaces.values()) {
      totalCanvasPixels += surface.getCanvasPixelArea();
    }
    return {
      totalPages: this.pdf.numPages,
      currentPage: this.currentPage,
      mountedSurfaces: this.surfaces.size,
      activeCanvases: this.surfaces.size * 2,
      totalCanvasPixels,
      queuedRenders: this.queuedPages.size,
      activeRenders: this.activeRenders,
      cancelledRenders: this.cancelledRenders,
      cacheStrategy: this.cacheStrategy,
      desiredPages: this.desiredPages.size,
      cachedGeometries: this.pageGeometry.size,
      estimatedSlots: [...this.slots.keys()].filter((pageNumber) => {
        return !this.pageGeometry.has(pageNumber);
      }).length,
      estimatedCanvasBytes: totalCanvasPixels * 4,
      canvasBudgetBytes: this.cacheOptions.retainRenderedPages
        ? this.cacheOptions.maxCanvasBytes
        : null,
      zoom: this.zoom
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.layoutGeneration += 1;
    this.layoutRevision += 1;
    this.resizeObserver?.disconnect();
    window.removeEventListener("resize", this.handleResize);
    if (this.resizeFrame !== null) window.cancelAnimationFrame(this.resizeFrame);
    this.resizeFrame = null;
    this.resetLayout();
    this.pageGeometry.clear();
  }

  private resetLayout(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.container.removeEventListener("scroll", this.handleScroll);
    if (this.scrollFrame !== null) window.cancelAnimationFrame(this.scrollFrame);
    this.scrollFrame = null;
    this.renderQueue.length = 0;
    this.queuedPages.clear();
    this.desiredPages.clear();
    for (const surface of this.surfaces.values()) {
      if (surface.destroy()) this.cancelledRenders += 1;
    }
    this.surfaces.clear();
    this.surfaceAccess.clear();
    this.mounting.clear();
    this.slots.clear();
    this.estimatedPageGeometry = null;
    this.container.empty();
  }

  private async updatePagedLayout(state: ViewerState): Promise<boolean> {
    const revision = ++this.layoutRevision;
    const generation = this.layoutGeneration;
    this.layoutState = state;
    this.currentPage = state.currentPage;
    const visiblePages = pagesForLayout(state, this.pdf.numPages);
    const renderWindow = this.renderWindowForState(state);
    const retained = new Set(renderWindow);

    for (const [pageNumber, slot] of this.slots) {
      if (retained.has(pageNumber)) continue;
      this.desiredPages.delete(pageNumber);
      if (this.cacheOptions.retainRenderedPages) {
        slot.addClass("betterscore-page-cached");
        continue;
      }
      this.evictPage(pageNumber);
      slot.remove();
      this.slots.delete(pageNumber);
    }
    this.applyPagedSlotVisibility(visiblePages);

    for (const pageNumber of renderWindow) {
      if (this.slots.has(pageNumber)) continue;
      const baseViewport = await this.loadPageGeometry(pageNumber);
      if (!this.isCurrentLayout(generation, revision)) return false;
      this.createSlot(pageNumber, baseViewport, state.viewMode);
    }

    if (!this.isCurrentLayout(generation, revision)) return false;
    this.applyPagedSlotVisibility(visiblePages);
    this.renderWindow(renderWindow);
    for (const pageNumber of visiblePages) this.requestRender(pageNumber, true);
    return true;
  }

  private async createSurface(pageNumber: number, generation: number): Promise<PageSurface> {
    if (this.disposed) throw new Error("PageSurfaceManager is disposed");
    if (pageNumber < 1 || pageNumber > this.pdf.numPages) {
      throw new RangeError(`PDF page ${pageNumber} is out of range`);
    }

    const page = await this.pdf.getPage(pageNumber);
    if (!this.isCurrentGeneration(generation)) {
      page.cleanup?.();
      throw new StaleLayoutError();
    }
    const baseViewport = page.getViewport({scale: 1});
    this.pageGeometry.set(pageNumber, baseViewport);
    const scales = this.scalesForPage(baseViewport, this.layoutState.viewMode);
    const slot = this.slots.get(pageNumber);
    if (!slot) {
      page.cleanup?.();
      throw new StaleLayoutError();
    }
    this.sizeSlot(slot, baseViewport, this.layoutState.viewMode);
    const surface = new PageSurface(
      slot,
      pageNumber,
      page,
      {
        cssViewport: page.getViewport({scale: scales.cssScale}),
        renderViewport: page.getViewport({scale: scales.renderScale}),
        pixelRatio: scales.pixelRatio
      },
      this.callbacks
    );
    if (!this.isCurrentGeneration(generation)) {
      surface.destroy();
      throw new StaleLayoutError();
    }
    this.surfaces.set(pageNumber, surface);
    this.touchSurface(pageNumber);
    this.callbacks.drawAnnotations(surface);
    return surface;
  }

  private async loadPageGeometry(pageNumber: number): Promise<PdfViewport> {
    const cached = this.pageGeometry.get(pageNumber);
    if (cached) return cached;
    const page = await this.pdf.getPage(pageNumber);
    const viewport = page.getViewport({scale: 1});
    if (!this.disposed) this.pageGeometry.set(pageNumber, viewport);
    page.cleanup?.();
    return viewport;
  }

  private createSlot(
    pageNumber: number,
    baseViewport: PdfViewport,
    mode: ViewMode
  ): void {
    const scales = this.scalesForPage(baseViewport, mode);
    const slot = this.container.createDiv({cls: "betterscore-page betterscore-page-placeholder"});
    slot.dataset.page = String(pageNumber);
    this.sizeSlot(slot, baseViewport, mode, scales, false);
    this.slots.set(pageNumber, slot);
  }

  private sizeSlot(
    slot: HTMLElement,
    baseViewport: PdfViewport,
    mode: ViewMode,
    scales = this.scalesForPage(baseViewport, mode),
    preserveScroll = true
  ): void {
    const oldBounds = preserveScroll ? slot.getBoundingClientRect() : null;
    const wasAboveViewport = oldBounds
      ? oldBounds.bottom <= this.container.getBoundingClientRect().top
      : false;
    const nextHeight = baseViewport.height * scales.cssScale;
    slot.style.width = `${baseViewport.width * scales.cssScale}px`;
    slot.style.height = `${nextHeight}px`;
    if (wasAboveViewport && oldBounds && oldBounds.height > 0) {
      this.container.scrollTop += nextHeight - oldBounds.height;
    }
  }

  private applyPagedSlotVisibility(visiblePages: number[]): void {
    const visible = new Set(visiblePages);
    for (const [pageNumber, slot] of this.slots) {
      slot.toggleClass("betterscore-page-cached", !visible.has(pageNumber));
      slot.removeClass("betterscore-spread-left", "betterscore-spread-right");
    }
    if (this.layoutState.viewMode === "spread") {
      for (const pageNumber of visiblePages) {
        const slot = this.slots.get(pageNumber);
        if (!slot) continue;
        const rightOnly = visiblePages.length === 1
          && this.layoutState.spreadOffset === 0
          && pageNumber === 1;
        slot.addClass(rightOnly || visiblePages[1] === pageNumber
          ? "betterscore-spread-right"
          : "betterscore-spread-left");
      }
    }
    const orderedSlots = Array.from(this.container.children).filter((element) =>
      visible.has(Number((element as HTMLElement).dataset.page))
    );
    if (visiblePages.every((pageNumber, index) => this.slots.get(pageNumber) === orderedSlots[index])) return;
    for (const pageNumber of visiblePages) {
      const slot = this.slots.get(pageNumber);
      if (slot) this.container.appendChild(slot);
    }
  }

  private scalesForPage(baseViewport: PdfViewport, mode: ViewMode): RenderScales {
    const pixelRatio = this.pixelRatio();
    if (mode === "continuous") {
      return capRenderScales(
        baseViewport,
        applyZoom(
          calculateRenderScales(baseViewport, this.availableContinuousWidth(), pixelRatio),
          this.zoom
        )
      );
    }
    const columns = mode === "spread" ? 2 : 1;
    const padding = this.container.classList.contains("betterscore-performance-pages")
      ? 0 : this.container.clientWidth <= 600 ? 16 : 32;
    const gap = this.container.clientWidth <= 600 ? 8 : 16;
    const totalWidth = Math.max(160, this.container.clientWidth - padding);
    const availableWidth = columns === 2 ? Math.max(80, (totalWidth - gap) / 2) : totalWidth;
    const availableHeight = Math.max(160, this.container.clientHeight - padding);
    return capRenderScales(
      baseViewport,
      applyZoom(
        calculatePagedRenderScales(
          baseViewport,
          availableWidth,
          availableHeight,
          pixelRatio
        ),
        this.zoom
      )
    );
  }

  private updateZoomClass(): void {
    this.container.toggleClass("is-zoomed", this.zoom > 1);
    this.container.dataset.zoom = String(this.zoom);
  }

  private renderWindowForState(state: ViewerState): number[] {
    if (state.viewMode === "continuous") {
      this.updateCacheStrategy();
      return pagesForRenderWindow(state, this.pdf.numPages);
    }
    const estimatedCanvasBytes = this.estimatePagedCanvasBytes(state.viewMode);
    const fullCache = shouldFullyCachePagedDocument({
      pageCount: this.pdf.numPages,
      sourceSizeBytes: this.sourceSizeBytes,
      estimatedCanvasBytes
    });
    this.cacheStrategy = fullCache
      ? "full"
      : (this.cacheOptions.retainRenderedPages ? "retained" : "windowed");
    return fullCache
      ? Array.from({length: this.pdf.numPages}, (_, index) => index + 1)
      : pagesForRenderWindow(state, this.pdf.numPages);
  }

  private estimatePagedCanvasBytes(mode: ViewMode): number {
    if (this.pageGeometry.size === 0) return Number.POSITIVE_INFINITY;
    let largestKnownPage = 0;
    for (const viewport of this.pageGeometry.values()) {
      const scales = this.scalesForPage(viewport, mode);
      const pixelWidth = Math.ceil(viewport.width * scales.renderScale);
      const pixelHeight = Math.ceil(viewport.height * scales.renderScale);
      // Each mounted page owns a PDF canvas and an equally sized ink canvas.
      largestKnownPage = Math.max(largestKnownPage, pixelWidth * pixelHeight * 2 * 4);
    }
    // Use the largest known page rather than the mean so mixed-size scores do
    // not become more aggressive as their geometry cache fills.
    return largestKnownPage * this.pdf.numPages;
  }

  private installViewportObservers(): void {
    this.container.addEventListener("scroll", this.handleScroll, {passive: true});
    if (typeof IntersectionObserver === "undefined") return;
    this.observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const pageNumber = Number((entry.target as HTMLElement).dataset.page);
          if (!Number.isInteger(pageNumber)) continue;
          if (entry.isIntersecting) {
            this.requestRender(pageNumber);
          } else {
            this.desiredPages.delete(pageNumber);
            if (this.cacheOptions.retainRenderedPages) this.enforceRetainedCanvasBudget();
            else this.evictPage(pageNumber);
          }
        }
        this.scheduleCurrentPageUpdate();
      },
      {root: this.container, rootMargin: OBSERVER_ROOT_MARGIN, threshold: 0}
    );
    for (const slot of this.slots.values()) this.observer.observe(slot);
  }

  private requestRender(pageNumber: number, priority = false): void {
    if (this.disposed || !this.slots.has(pageNumber)) return;
    if (pageNumber < 1 || pageNumber > this.pdf.numPages) return;
    this.desiredPages.add(pageNumber);
    const surface = this.surfaces.get(pageNumber);
    if (surface?.isPdfRendered()) {
      this.touchSurface(pageNumber);
      return;
    }
    if (this.queuedPages.has(pageNumber)) {
      if (priority) {
        const index = this.renderQueue.findIndex((queued) => queued.pageNumber === pageNumber);
        if (index > 0) {
          const [queued] = this.renderQueue.splice(index, 1);
          if (queued) this.renderQueue.unshift(queued);
        }
      }
      return;
    }
    this.queuedPages.add(pageNumber);
    const queued = {pageNumber, generation: this.layoutGeneration};
    if (priority) this.renderQueue.unshift(queued);
    else this.renderQueue.push(queued);
    this.drainRenderQueue();
  }

  private drainRenderQueue(): void {
    while (!this.disposed && this.activeRenders < MAX_CONCURRENT_RENDERS) {
      // Never let repeated requests for one page occupy both render slots.
      const index = this.renderQueue.findIndex(({pageNumber}) => !this.inFlightPages.has(pageNumber));
      if (index === -1) return;
      const [queued] = this.renderQueue.splice(index, 1);
      if (!queued) return;
      this.queuedPages.delete(queued.pageNumber);
      if (!this.desiredPages.has(queued.pageNumber)) continue;
      if (!this.isCurrentGeneration(queued.generation)) continue;
      if (this.surfaces.get(queued.pageNumber)?.isPdfRendered()) continue;
      this.activeRenders += 1;
      this.inFlightPages.add(queued.pageNumber);
      void this.renderRequestedPage(queued).finally(() => {
        this.inFlightPages.delete(queued.pageNumber);
        this.activeRenders -= 1;
        this.drainRenderQueue();
      });
    }
  }

  private async renderRequestedPage(queued: QueuedRender): Promise<void> {
    try {
      const surface = await this.mountPage(queued.pageNumber);
      if (!this.isCurrentGeneration(queued.generation)) return;
      if (!this.desiredPages.has(queued.pageNumber)) {
        this.evictPage(queued.pageNumber);
        return;
      }
      await surface.renderPdf();
      this.touchSurface(queued.pageNumber);
      if (!this.desiredPages.has(queued.pageNumber) && !this.cacheOptions.retainRenderedPages) {
        this.evictPage(queued.pageNumber);
      }
      this.enforceRetainedCanvasBudget();
    } catch (error) {
      if (!this.disposed && !(error instanceof StaleLayoutError)) {
        this.callbacks.onRenderError?.(queued.pageNumber, error);
      }
    }
  }

  private positionSlot(pageNumber: number, behavior: ScrollBehavior): void {
    const slot = this.slots.get(pageNumber);
    if (!slot) return;
    const containerBounds = this.container.getBoundingClientRect();
    const slotBounds = slot.getBoundingClientRect();
    this.container.scrollTo({
      top: this.container.scrollTop + slotBounds.top - containerBounds.top,
      behavior
    });
  }

  private scheduleCurrentPageUpdate(): void {
    if (this.scrollFrame !== null || this.disposed) return;
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.updateCurrentPage();
    });
  }

  private updateCurrentPage(): void {
    if (this.layoutState.viewMode !== "continuous" || this.slots.size === 0) return;
    const containerBounds = this.container.getBoundingClientRect();
    const viewportCenter = containerBounds.top + containerBounds.height / 2;
    let nearestPage = this.currentPage;
    let nearestDistance = Number.POSITIVE_INFINITY;
    for (const [pageNumber, slot] of this.slots) {
      const bounds = slot.getBoundingClientRect();
      const distance = Math.abs(bounds.top + bounds.height / 2 - viewportCenter);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = pageNumber;
      }
    }
    if (nearestPage === this.currentPage) return;
    this.currentPage = nearestPage;
    this.layoutState = {...this.layoutState, currentPage: nearestPage};
    this.callbacks.onCurrentPageChange?.(nearestPage);
    if (!this.observer) {
      this.renderWindow(continuousRenderWindow(nearestPage, this.pdf.numPages));
    }
  }

  private touchSurface(pageNumber: number): void {
    this.surfaceAccess.set(pageNumber, ++this.accessSequence);
  }

  private enforceRetainedCanvasBudget(): void {
    if (!this.cacheOptions.retainRenderedPages) return;
    const candidates = [...this.surfaces.entries()].map(([pageNumber, surface]) => ({
      pageNumber,
      bytes: surface.getCanvasPixelArea() * 4,
      lastAccess: this.surfaceAccess.get(pageNumber) ?? 0,
      protected: this.desiredPages.has(pageNumber)
    }));
    for (const pageNumber of retainedPagesToEvict(
      candidates,
      this.cacheOptions.maxCanvasBytes
    )) {
      this.evictPage(pageNumber);
    }
  }

  private updateCacheStrategy(): void {
    if (this.layoutState.viewMode !== "continuous" && this.cacheStrategy === "full") return;
    if (this.cacheOptions.retainRenderedPages) this.cacheStrategy = "retained";
    else if (this.layoutState.viewMode === "continuous") this.cacheStrategy = "continuous";
    else this.cacheStrategy = "windowed";
  }

  private availableContinuousWidth(): number {
    const padding = this.container.classList.contains("betterscore-performance-pages") ? 0 : 32;
    return Math.max(160, this.container.clientWidth - padding);
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.layoutGeneration;
  }

  private isCurrentLayout(generation: number, revision: number): boolean {
    return this.isCurrentGeneration(generation) && revision === this.layoutRevision;
  }

  private readonly handleScroll = (): void => {
    this.scheduleCurrentPageUpdate();
  };

  /** Keep the point on the active page nearest the center of the old viewport. */
  captureViewportAnchor(): ZoomAnchor | undefined {
    const slot = this.slots.get(this.currentPage)?.getBoundingClientRect();
    const viewport = this.container.getBoundingClientRect();
    if (!slot?.width || !slot.height || !viewport.width || !viewport.height) return;
    const x = Math.min(1, Math.max(0, (viewport.left + viewport.width / 2 - slot.left) / slot.width));
    const y = Math.min(1, Math.max(0, (viewport.top + viewport.height / 2 - slot.top) / slot.height));
    return {page: this.currentPage, x, y, clientX: 0, clientY: 0};
  }

  private viewportKey(): string {
    return [this.container.clientWidth, this.container.clientHeight, this.pixelRatio(),
      this.container.classList.contains("betterscore-performance-pages")].join(":");
  }

  resizeViewport(anchor = this.captureViewportAnchor()): void {
    if (this.disposed || !this.container.clientWidth || !this.container.clientHeight) return;
    const key = this.viewportKey();
    if (key === this.viewportSize) return;
    this.viewportSize = key;
    const mode = this.layoutState.viewMode;
    for (const [page, slot] of this.slots) {
      const geometry = this.pageGeometry.get(page) ?? this.estimatedPageGeometry;
      if (!geometry) continue;
      const scales = this.scalesForPage(geometry, mode);
      this.sizeSlot(slot, geometry, mode, scales, false);
      const surface = this.surfaces.get(page);
      if (surface?.resize(scales.cssScale, scales.renderScale, scales.pixelRatio)) {
        this.callbacks.drawAnnotations(surface);
      }
    }
    if (anchor && (mode === "continuous" || this.zoom > 1)) {
      const viewport = this.container.getBoundingClientRect();
      const slot = this.slots.get(anchor.page)?.getBoundingClientRect();
      if (slot?.width && slot.height) {
        this.container.scrollLeft += slot.left + slot.width * anchor.x - viewport.left - viewport.width / 2;
        this.container.scrollTop += slot.top + slot.height * anchor.y - viewport.top - viewport.height / 2;
      }
    }
    if (mode === "continuous") {
      this.requestRender(this.currentPage, true);
      for (const page of this.desiredPages) this.requestRender(page);
      this.enforceRetainedCanvasBudget();
      this.scheduleCurrentPageUpdate();
    } else if (this.slots.size) {
      // Re-evaluate the bounded prefetch window without resetting the layout.
      void this.updatePagedLayout(this.layoutState).catch((error: unknown) => {
        this.callbacks.onRenderError?.(this.currentPage, error);
      });
    }
  }

  private readonly handleResize = (): void => {
    if (this.resizeFrame !== null || this.disposed) return;
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      this.resizeViewport();
    });
  };
}

class StaleLayoutError extends Error {
  constructor() {
    super("BetterScore layout changed during page rendering");
    this.name = "StaleLayoutError";
  }
}

export function calculateRenderScales(
  baseViewport: PdfViewport,
  availableWidth: number,
  pixelRatio: number
): RenderScales {
  const cssScale = Math.min(availableWidth / baseViewport.width, 1.75);
  return {
    cssScale,
    renderScale: cssScale * pixelRatio,
    pixelRatio
  };
}

export function calculatePagedRenderScales(
  baseViewport: PdfViewport,
  availableWidth: number,
  availableHeight: number,
  pixelRatio: number
): RenderScales {
  const cssScale = Math.min(
    availableWidth / baseViewport.width,
    availableHeight / baseViewport.height,
    1.75
  );
  return {
    cssScale,
    renderScale: cssScale * pixelRatio,
    pixelRatio
  };
}

export interface FullCacheEstimate {
  pageCount: number;
  sourceSizeBytes: number;
  estimatedCanvasBytes: number;
}

export function shouldFullyCachePagedDocument(estimate: FullCacheEstimate): boolean {
  return estimate.pageCount > 0
    && estimate.pageCount <= MAX_FULL_CACHE_PAGES
    && estimate.sourceSizeBytes <= MAX_FULL_CACHE_SOURCE_BYTES
    && estimate.estimatedCanvasBytes <= MAX_FULL_CACHE_CANVAS_BYTES;
}

export function clampZoom(zoom: number): number {
  if (!Number.isFinite(zoom)) return 1;
  return Math.round(Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, zoom)) * 100) / 100;
}

export function capRenderScales(
  baseViewport: PdfViewport,
  scales: RenderScales,
  maxDimension = MAX_CANVAS_DIMENSION
): RenderScales {
  const largestCssDimension = Math.max(baseViewport.width, baseViewport.height) * scales.cssScale;
  if (largestCssDimension <= 0) return scales;
  const pixelRatio = Math.min(scales.pixelRatio, maxDimension / largestCssDimension);
  return {
    cssScale: scales.cssScale,
    renderScale: scales.cssScale * pixelRatio,
    pixelRatio
  };
}

export function continuousRenderWindow(
  currentPage: number,
  pageCount: number,
  radius = 2
): number[] {
  const current = clampPage(currentPage, pageCount);
  const first = Math.max(1, current - Math.max(0, radius));
  const last = Math.min(pageCount, current + Math.max(0, radius));
  return Array.from({length: Math.max(0, last - first + 1)}, (_, index) => first + index);
}

export interface RetainedPageCandidate {
  pageNumber: number;
  bytes: number;
  lastAccess: number;
  protected: boolean;
}

export function retainedPagesToEvict(
  candidates: RetainedPageCandidate[],
  maxBytes: number
): number[] {
  let totalBytes = candidates.reduce((sum, candidate) => sum + candidate.bytes, 0);
  if (totalBytes <= maxBytes) return [];
  const evicted: number[] = [];
  const available = candidates
    .filter((candidate) => !candidate.protected)
    .sort((left, right) => left.lastAccess - right.lastAccess);
  for (const candidate of available) {
    if (totalBytes <= maxBytes) break;
    totalBytes -= candidate.bytes;
    evicted.push(candidate.pageNumber);
  }
  return evicted;
}

function applyZoom(scales: RenderScales, zoom: number): RenderScales {
  return {
    cssScale: scales.cssScale * zoom,
    renderScale: scales.renderScale * zoom,
    pixelRatio: scales.pixelRatio
  };
}
