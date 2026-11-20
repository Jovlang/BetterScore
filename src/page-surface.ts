import type {PdfPage, PdfRenderTask, PdfViewport} from "./pdf-types";
import type {StrokePoint} from "./model";

export interface PageSurfacePointerHandlers {
  onPointerDown: (surface: PageSurface, event: PointerEvent) => void;
  onPointerMove: (surface: PageSurface, event: PointerEvent) => void;
  onPointerEnd: (surface: PageSurface, event: PointerEvent) => void;
}

export interface PageSurfaceGeometry {
  cssViewport: PdfViewport;
  renderViewport: PdfViewport;
  pixelRatio: number;
}

export class PageSurface {
  readonly element: HTMLElement;
  readonly overlay: HTMLCanvasElement;
  readonly annotationContext: CanvasRenderingContext2D;
  readonly cssWidth: number;
  readonly cssHeight: number;

  private readonly pdfCanvas: HTMLCanvasElement;
  private readonly pdfContext: CanvasRenderingContext2D;
  private renderTask: PdfRenderTask | null = null;
  private rendered = false;
  private destroyed = false;

  constructor(
    container: HTMLElement,
    readonly pageNumber: number,
    private readonly page: PdfPage,
    private readonly geometry: PageSurfaceGeometry,
    private readonly pointerHandlers: PageSurfacePointerHandlers
  ) {
    this.cssWidth = geometry.cssViewport.width;
    this.cssHeight = geometry.cssViewport.height;
    this.element = container.createDiv({cls: "betterscore-page"});
    this.element.style.width = `${this.cssWidth}px`;
    this.element.style.height = `${this.cssHeight}px`;
    this.element.dataset.page = String(pageNumber);

    this.pdfCanvas = this.element.createEl("canvas", {cls: "betterscore-pdf-canvas"});
    this.pdfCanvas.width = Math.ceil(geometry.renderViewport.width);
    this.pdfCanvas.height = Math.ceil(geometry.renderViewport.height);
    this.pdfCanvas.style.width = `${this.cssWidth}px`;
    this.pdfCanvas.style.height = `${this.cssHeight}px`;
    const pdfContext = this.pdfCanvas.getContext("2d");
    if (!pdfContext) throw new Error("PDF canvas is not available");
    this.pdfContext = pdfContext;

    this.overlay = this.element.createEl("canvas", {cls: "betterscore-ink-canvas"});
    this.overlay.width = Math.ceil(this.cssWidth * geometry.pixelRatio);
    this.overlay.height = Math.ceil(this.cssHeight * geometry.pixelRatio);
    this.overlay.style.width = `${this.cssWidth}px`;
    this.overlay.style.height = `${this.cssHeight}px`;
    const annotationContext = this.overlay.getContext("2d");
    if (!annotationContext) throw new Error("Annotation canvas is not available");
    annotationContext.scale(geometry.pixelRatio, geometry.pixelRatio);
    this.annotationContext = annotationContext;

    this.overlay.addEventListener("pointerdown", this.handlePointerDown);
    this.overlay.addEventListener("pointermove", this.handlePointerMove);
    this.overlay.addEventListener("pointerup", this.handlePointerEnd);
    this.overlay.addEventListener("pointercancel", this.handlePointerEnd);
  }

  async renderPdf(): Promise<void> {
    if (this.destroyed || this.rendered) return;
    if (this.renderTask) return this.renderTask.promise;
    const task = this.page.render({
      canvasContext: this.pdfContext,
      viewport: this.geometry.renderViewport
    });
    this.renderTask = task;
    try {
      await task.promise;
      if (!this.destroyed) this.rendered = true;
    } catch (error) {
      if (!this.destroyed) throw error;
    } finally {
      if (this.renderTask === task) this.renderTask = null;
    }
  }

  drawAnnotations(draw: (context: CanvasRenderingContext2D, width: number, height: number) => void): void {
    if (this.destroyed) return;
    this.annotationContext.clearRect(0, 0, this.cssWidth, this.cssHeight);
    draw(this.annotationContext, this.cssWidth, this.cssHeight);
  }

  pointFromEvent(event: PointerEvent): StrokePoint {
    const bounds = this.overlay.getBoundingClientRect();
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width),
      y: clamp((event.clientY - bounds.top) / bounds.height),
      pressure: event.pressure > 0 ? event.pressure : 0.5
    };
  }

  capturePointer(pointerId: number): void {
    this.overlay.setPointerCapture(pointerId);
  }

  hasPointerCapture(pointerId: number): boolean {
    return this.overlay.hasPointerCapture(pointerId);
  }

  releasePointer(pointerId: number): void {
    if (this.overlay.hasPointerCapture(pointerId)) {
      this.overlay.releasePointerCapture(pointerId);
    }
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.renderTask?.cancel?.();
    this.renderTask = null;
    this.overlay.removeEventListener("pointerdown", this.handlePointerDown);
    this.overlay.removeEventListener("pointermove", this.handlePointerMove);
    this.overlay.removeEventListener("pointerup", this.handlePointerEnd);
    this.overlay.removeEventListener("pointercancel", this.handlePointerEnd);
    // Setting bitmap dimensions to zero releases browser/GPU backing stores.
    this.pdfCanvas.width = 0;
    this.pdfCanvas.height = 0;
    this.overlay.width = 0;
    this.overlay.height = 0;
    this.page.cleanup?.();
    this.element.remove();
  }

  private readonly handlePointerDown = (event: PointerEvent): void => {
    this.pointerHandlers.onPointerDown(this, event);
  };

  private readonly handlePointerMove = (event: PointerEvent): void => {
    this.pointerHandlers.onPointerMove(this, event);
  };

  private readonly handlePointerEnd = (event: PointerEvent): void => {
    this.pointerHandlers.onPointerEnd(this, event);
  };
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value));
}
