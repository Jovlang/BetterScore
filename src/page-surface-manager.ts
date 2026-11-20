import {PageSurface, PageSurfacePointerHandlers} from "./page-surface";
import type {PdfDocument, PdfViewport} from "./pdf-types";
import {clampPage, createViewerState, pagesForLayout} from "./viewer-layout";
import type {ViewerState, ViewMode} from "./viewer-layout";

const OBSERVER_ROOT_MARGIN = "200% 0px";
const MAX_CONCURRENT_RENDERS = 2;

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

export class PageSurfaceManager {
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly mounting = new Map<number, Promise<PageSurface>>();
  private readonly pageGeometry = new Map<number, PdfViewport>();
  private readonly slots = new Map<number, HTMLElement>();
  private readonly desiredPages = new Set<number>();
  private readonly queuedPages = new Set<number>();
  private readonly renderQueue: QueuedRender[] = [];
  private observer: IntersectionObserver | null = null;
  private activeRenders = 0;
  private cancelledRenders = 0;
  private currentPage = 1;
  private layoutState: ViewerState = createViewerState();
  private layoutGeneration = 0;
  private scrollFrame: number | null = null;
  private resizeFrame: number | null = null;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly pdf: PdfDocument,
    private readonly callbacks: PageSurfaceManagerCallbacks
  ) {
    window.addEventListener("resize", this.handleResize, {passive: true});
  }

  async initializeContinuous(): Promise<void> {
    await this.setLayout(createViewerState());
  }

  /** Rebuild only the layout; PDF geometry and the annotation model stay shared. */
  async setLayout(state: ViewerState): Promise<boolean> {
    if (this.disposed) return false;
    const generation = ++this.layoutGeneration;
    this.layoutState = {...state, currentPage: clampPage(state.currentPage, this.pdf.numPages)};
    this.currentPage = this.layoutState.currentPage;
    this.resetLayout();
    this.container.dataset.viewMode = state.viewMode;

    const pages = pagesForLayout(this.layoutState, this.pdf.numPages);
    for (const pageNumber of pages) {
      const baseViewport = await this.loadPageGeometry(pageNumber);
      if (!this.isCurrentGeneration(generation)) return false;
      this.createSlot(pageNumber, baseViewport, state.viewMode, pages);
    }

    if (!this.isCurrentGeneration(generation)) return false;
    if (state.viewMode === "continuous") {
      this.positionSlot(this.currentPage, "auto");
      this.installViewportObservers();
      this.requestRender(this.currentPage);
      if (!this.observer) {
        for (const pageNumber of pages) this.requestRender(pageNumber);
      }
    } else {
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
  }

  renderWindow(pageNumbers: Iterable<number>): void {
    const requested = new Set(pageNumbers);
    for (const pageNumber of this.desiredPages) {
      if (!requested.has(pageNumber)) {
        this.desiredPages.delete(pageNumber);
        this.evictPage(pageNumber);
      }
    }
    for (const pageNumber of requested) this.requestRender(pageNumber);
  }

  evictPage(pageNumber: number): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface) return;
    if (surface.destroy()) this.cancelledRenders += 1;
    this.surfaces.delete(pageNumber);
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
      cancelledRenders: this.cancelledRenders
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.layoutGeneration += 1;
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
    this.mounting.clear();
    this.slots.clear();
    this.container.empty();
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
    const baseViewport = this.pageGeometry.get(pageNumber) ?? page.getViewport({scale: 1});
    this.pageGeometry.set(pageNumber, baseViewport);
    const scales = this.scalesForPage(baseViewport, this.layoutState.viewMode);
    const slot = this.slots.get(pageNumber);
    if (!slot) {
      page.cleanup?.();
      throw new StaleLayoutError();
    }
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
    mode: ViewMode,
    layoutPages: number[]
  ): void {
    const scales = this.scalesForPage(baseViewport, mode);
    const slot = this.container.createDiv({cls: "betterscore-page betterscore-page-placeholder"});
    slot.dataset.page = String(pageNumber);
    slot.style.width = `${baseViewport.width * scales.cssScale}px`;
    slot.style.height = `${baseViewport.height * scales.cssScale}px`;
    if (mode === "spread") {
      const rightOnly = layoutPages.length === 1
        && this.layoutState.spreadOffset === 0
        && pageNumber === 1;
      slot.addClass(rightOnly || layoutPages[1] === pageNumber
        ? "betterscore-spread-right"
        : "betterscore-spread-left");
    }
    this.slots.set(pageNumber, slot);
  }

  private scalesForPage(baseViewport: PdfViewport, mode: ViewMode): RenderScales {
    const pixelRatio = this.pixelRatio();
    if (mode === "continuous") {
      return calculateRenderScales(baseViewport, this.availableContinuousWidth(), pixelRatio);
    }
    const columns = mode === "spread" ? 2 : 1;
    const padding = this.container.clientWidth <= 600 ? 16 : 32;
    const gap = this.container.clientWidth <= 600 ? 8 : 16;
    const totalWidth = Math.max(160, this.container.clientWidth - padding);
    const availableWidth = columns === 2 ? Math.max(80, (totalWidth - gap) / 2) : totalWidth;
    const availableHeight = Math.max(160, this.container.clientHeight - padding);
    return calculatePagedRenderScales(
      baseViewport,
      availableWidth,
      availableHeight,
      pixelRatio
    );
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
            this.evictPage(pageNumber);
          }
        }
        this.scheduleCurrentPageUpdate();
      },
      {root: this.container, rootMargin: OBSERVER_ROOT_MARGIN, threshold: 0}
    );
    for (const slot of this.slots.values()) this.observer.observe(slot);
  }

  private requestRender(pageNumber: number): void {
    if (this.disposed || !this.slots.has(pageNumber)) return;
    if (pageNumber < 1 || pageNumber > this.pdf.numPages) return;
    this.desiredPages.add(pageNumber);
    const surface = this.surfaces.get(pageNumber);
    if (surface?.isPdfRendered() || this.queuedPages.has(pageNumber)) return;
    this.queuedPages.add(pageNumber);
    this.renderQueue.push({pageNumber, generation: this.layoutGeneration});
    this.drainRenderQueue();
  }

  private drainRenderQueue(): void {
    while (!this.disposed && this.activeRenders < MAX_CONCURRENT_RENDERS) {
      const queued = this.renderQueue.shift();
      if (!queued) return;
      this.queuedPages.delete(queued.pageNumber);
      if (!this.desiredPages.has(queued.pageNumber)) continue;
      if (!this.isCurrentGeneration(queued.generation)) continue;
      this.activeRenders += 1;
      void this.renderRequestedPage(queued).finally(() => {
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
      if (!this.desiredPages.has(queued.pageNumber)) this.evictPage(queued.pageNumber);
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
  }

  private availableContinuousWidth(): number {
    return Math.max(320, this.container.clientWidth - 32);
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  private isCurrentGeneration(generation: number): boolean {
    return !this.disposed && generation === this.layoutGeneration;
  }

  private readonly handleScroll = (): void => {
    this.scheduleCurrentPageUpdate();
  };

  private readonly handleResize = (): void => {
    if (this.resizeFrame !== null || this.disposed) return;
    this.resizeFrame = window.requestAnimationFrame(() => {
      this.resizeFrame = null;
      void this.setLayout(this.layoutState);
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
