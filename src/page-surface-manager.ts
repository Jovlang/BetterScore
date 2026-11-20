import {PageSurface, PageSurfacePointerHandlers} from "./page-surface";
import type {PdfDocument, PdfViewport} from "./pdf-types";

export interface RenderScales {
  cssScale: number;
  renderScale: number;
  pixelRatio: number;
}

export interface PageSurfaceManagerCallbacks extends PageSurfacePointerHandlers {
  drawAnnotations: (surface: PageSurface) => void;
}

export class PageSurfaceManager {
  private readonly surfaces = new Map<number, PageSurface>();
  private readonly mounting = new Map<number, Promise<PageSurface>>();
  private readonly pageGeometry = new Map<number, PdfViewport>();
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly pdf: PdfDocument,
    private readonly callbacks: PageSurfaceManagerCallbacks
  ) {}

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
    const baseViewport = page.getViewport({scale: 1});
    this.pageGeometry.set(pageNumber, baseViewport);
    const availableWidth = Math.max(320, this.container.clientWidth - 32);
    const scales = calculateRenderScales(
      baseViewport,
      availableWidth,
      Math.min(window.devicePixelRatio || 1, 2)
    );
    const geometry = {
      cssViewport: page.getViewport({scale: scales.cssScale}),
      renderViewport: page.getViewport({scale: scales.renderScale}),
      pixelRatio: scales.pixelRatio
    };
    const surface = new PageSurface(
      this.container,
      pageNumber,
      page,
      geometry,
      this.callbacks
    );
    this.surfaces.set(pageNumber, surface);
    this.callbacks.drawAnnotations(surface);
    return surface;
  }

  async renderPage(pageNumber: number): Promise<void> {
    const surface = await this.mountPage(pageNumber);
    await surface.renderPdf();
  }

  async renderAll(): Promise<void> {
    for (let pageNumber = 1; pageNumber <= this.pdf.numPages; pageNumber += 1) {
      await this.renderPage(pageNumber);
    }
  }

  evictPage(pageNumber: number): void {
    const surface = this.surfaces.get(pageNumber);
    if (!surface) return;
    surface.destroy();
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

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const surface of this.surfaces.values()) surface.destroy();
    this.surfaces.clear();
    this.mounting.clear();
    this.pageGeometry.clear();
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
