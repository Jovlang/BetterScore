import {PageSurface, PageSurfacePointerHandlers} from "./page-surface";
import type {PdfDocument, PdfViewport} from "./pdf-types";

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

export class PageSurfaceManager {
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly mounting = new Map<number, Promise<PageSurface>>();
  private readonly pageGeometry = new Map<number, PdfViewport>();
  private readonly slots = new Map<number, HTMLElement>();
  private readonly desiredPages = new Set<number>();
  private readonly queuedPages = new Set<number>();
  private readonly renderQueue: number[] = [];
  private observer: IntersectionObserver | null = null;
  private activeRenders = 0;
  private cancelledRenders = 0;
  private currentPage = 1;
  private scrollFrame: number | null = null;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly pdf: PdfDocument,
    private readonly callbacks: PageSurfaceManagerCallbacks
  ) {}

  async initializeContinuous(): Promise<void> {
    this.container.empty();
    this.installViewportObservers();
    const availableWidth = this.availableWidth();
    const pixelRatio = this.pixelRatio();

    for (let pageNumber = 1; pageNumber <= this.pdf.numPages; pageNumber += 1) {
      if (this.disposed) return;
      const baseViewport = await this.loadPageGeometry(pageNumber);
      const scales = calculateRenderScales(baseViewport, availableWidth, pixelRatio);
      const slot = this.container.createDiv({cls: "betterscore-page betterscore-page-placeholder"});
      slot.dataset.page = String(pageNumber);
      slot.style.width = `${baseViewport.width * scales.cssScale}px`;
      slot.style.height = `${baseViewport.height * scales.cssScale}px`;
      this.slots.set(pageNumber, slot);
      this.observer?.observe(slot);

      if (pageNumber === 1) {
        this.callbacks.onCurrentPageChange?.(1);
      }
    }
    // Obsidian's supported webviews provide IntersectionObserver. Retain a
    // functional eager fallback for unusual or future runtimes that do not.
    if (!this.observer) {
      for (let pageNumber = 1; pageNumber <= this.pdf.numPages; pageNumber += 1) {
        this.requestRender(pageNumber);
      }
    }
    this.scheduleCurrentPageUpdate();
  }

  mountPage(pageNumber: number): Promise<PageSurface> {
    const existing = this.surfaces.get(pageNumber);
    if (existing) return Promise.resolve(existing);
    const pending = this.mounting.get(pageNumber);
    if (pending) return pending;
    const mounting = this.createSurface(pageNumber);
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
      this.callbacks.onCurrentPageChange?.(pageNumber);
    }
    const containerBounds = this.container.getBoundingClientRect();
    const slotBounds = slot.getBoundingClientRect();
    this.container.scrollTo({
      top: this.container.scrollTop + slotBounds.top - containerBounds.top,
      behavior
    });
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
    this.pageGeometry.clear();
    this.slots.clear();
  }

  private async createSurface(pageNumber: number): Promise<PageSurface> {
    if (this.disposed) throw new Error("PageSurfaceManager is disposed");
    if (pageNumber < 1 || pageNumber > this.pdf.numPages) {
      throw new RangeError(`PDF page ${pageNumber} is out of range`);
    }

    const page = await this.pdf.getPage(pageNumber);
    if (this.disposed) {
      page.cleanup?.();
      throw new Error("PageSurfaceManager was disposed while mounting a page");
    }
    const baseViewport = this.pageGeometry.get(pageNumber) ?? page.getViewport({scale: 1});
    this.pageGeometry.set(pageNumber, baseViewport);
    const scales = calculateRenderScales(baseViewport, this.availableWidth(), this.pixelRatio());
    const slot = this.slots.get(pageNumber) ?? this.createFallbackSlot(pageNumber, baseViewport, scales);
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
    this.surfaces.set(pageNumber, surface);
    this.callbacks.drawAnnotations(surface);
    return surface;
  }

  private async loadPageGeometry(pageNumber: number): Promise<PdfViewport> {
    const cached = this.pageGeometry.get(pageNumber);
    if (cached) return cached;
    const page = await this.pdf.getPage(pageNumber);
    const viewport = page.getViewport({scale: 1});
    this.pageGeometry.set(pageNumber, viewport);
    page.cleanup?.();
    return viewport;
  }

  private createFallbackSlot(
    pageNumber: number,
    baseViewport: PdfViewport,
    scales: RenderScales
  ): HTMLElement {
    const slot = this.container.createDiv({cls: "betterscore-page betterscore-page-placeholder"});
    slot.dataset.page = String(pageNumber);
    slot.style.width = `${baseViewport.width * scales.cssScale}px`;
    slot.style.height = `${baseViewport.height * scales.cssScale}px`;
    this.slots.set(pageNumber, slot);
    return slot;
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
  }

  private requestRender(pageNumber: number): void {
    if (this.disposed || pageNumber < 1 || pageNumber > this.pdf.numPages) return;
    this.desiredPages.add(pageNumber);
    const surface = this.surfaces.get(pageNumber);
    if (surface?.isPdfRendered() || this.queuedPages.has(pageNumber)) return;
    this.queuedPages.add(pageNumber);
    this.renderQueue.push(pageNumber);
    this.drainRenderQueue();
  }

  private drainRenderQueue(): void {
    while (!this.disposed && this.activeRenders < MAX_CONCURRENT_RENDERS) {
      const pageNumber = this.renderQueue.shift();
      if (pageNumber === undefined) return;
      this.queuedPages.delete(pageNumber);
      if (!this.desiredPages.has(pageNumber)) continue;
      this.activeRenders += 1;
      void this.renderRequestedPage(pageNumber).finally(() => {
        this.activeRenders -= 1;
        this.drainRenderQueue();
      });
    }
  }

  private async renderRequestedPage(pageNumber: number): Promise<void> {
    try {
      const surface = await this.mountPage(pageNumber);
      if (!this.desiredPages.has(pageNumber)) {
        this.evictPage(pageNumber);
        return;
      }
      await surface.renderPdf();
      if (!this.desiredPages.has(pageNumber)) this.evictPage(pageNumber);
    } catch (error) {
      if (!this.disposed) this.callbacks.onRenderError?.(pageNumber, error);
    }
  }

  private scheduleCurrentPageUpdate(): void {
    if (this.scrollFrame !== null || this.disposed) return;
    this.scrollFrame = window.requestAnimationFrame(() => {
      this.scrollFrame = null;
      this.updateCurrentPage();
    });
  }

  private updateCurrentPage(): void {
    if (this.slots.size === 0) return;
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
    this.callbacks.onCurrentPageChange?.(nearestPage);
  }

  private availableWidth(): number {
    return Math.max(320, this.container.clientWidth - 32);
  }

  private pixelRatio(): number {
    return Math.min(window.devicePixelRatio || 1, 2);
  }

  private readonly handleScroll = (): void => {
    this.scheduleCurrentPageUpdate();
  };
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
