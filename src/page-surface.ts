import type {PdfPage, PdfRenderTask, PdfViewport} from "./pdf-types";
import type {StrokePoint} from "./model";

export interface PageSurfacePointerHandlers {
  onPointerDown: (surface: PageSurface, event: PointerEvent) => void;
  onPointerMove: (surface: PageSurface, event: PointerEvent) => void;
  onPointerEnd: (surface: PageSurface, event: PointerEvent) => void;
  onSurfaceDestroy?: (surface: PageSurface) => void;
}

export interface PageSurfaceGeometry {
  cssViewport: PdfViewport;
  renderViewport: PdfViewport;
  pixelRatio: number;
}

export class PageSurface {
  readonly overlay: HTMLCanvasElement;
  readonly annotationContext: CanvasRenderingContext2D;
  private pdfCanvas: HTMLCanvasElement;
  private pendingCanvas: HTMLCanvasElement | null = null;
  private renderPromise: Promise<void> | null = null;
  private renderTask: PdfRenderTask | null = null;
  private rendered = false;
  private destroyed = false;

  constructor(
    readonly element: HTMLElement,
    readonly pageNumber: number,
    private readonly page: PdfPage,
    private geometry: PageSurfaceGeometry,
    private readonly pointerHandlers: PageSurfacePointerHandlers
  ) {
    this.element.empty();
    this.element.addClass("is-mounted");
    this.element.style.width = `${this.cssWidth}px`;
    this.element.style.height = `${this.cssHeight}px`;
    this.element.dataset.page = String(pageNumber);

    this.pdfCanvas = this.element.createEl("canvas", {cls: "betterscore-pdf-canvas"});
    this.pdfCanvas.width = 0;
    this.pdfCanvas.height = 0;

    this.overlay = this.element.createEl("canvas", {cls: "betterscore-ink-canvas"});
    const annotationContext = this.overlay.getContext("2d");
    if (!annotationContext) throw new Error("Annotation canvas is not available");
    this.annotationContext = annotationContext;
    this.sizeCanvases();

    this.overlay.addEventListener("pointerdown", this.handlePointerDown);
    this.overlay.addEventListener("pointermove", this.handlePointerMove);
    this.overlay.addEventListener("pointerup", this.handlePointerEnd);
    this.overlay.addEventListener("pointercancel", this.handlePointerEnd);
    this.overlay.addEventListener("lostpointercapture", this.handlePointerEnd);
  }

  get cssWidth(): number { return this.geometry.cssViewport.width; }
  get cssHeight(): number { return this.geometry.cssViewport.height; }

  resize(cssScale: number, renderScale: number, pixelRatio: number): void {
    this.geometry = {
      cssViewport: this.page.getViewport({scale: cssScale}),
      renderViewport: this.page.getViewport({scale: renderScale}),
      pixelRatio
    };
    this.rendered = false;
    this.renderTask?.cancel?.();
    this.sizeCanvases();
  }

  private sizeCanvases(): void {
    const {pixelRatio} = this.geometry;
    for (const canvas of [this.pdfCanvas, this.overlay]) {
      canvas.style.width = `${this.cssWidth}px`;
      canvas.style.height = `${this.cssHeight}px`;
    }
    this.overlay.width = Math.ceil(this.cssWidth * pixelRatio);
    this.overlay.height = Math.ceil(this.cssHeight * pixelRatio);
    this.annotationContext.scale(pixelRatio, pixelRatio);
  }

  async renderPdf(): Promise<void> {
    if (this.destroyed || this.rendered) return;
    if (!this.renderPromise) {
      this.renderPromise = this.renderLatestPdf().finally(() => {
        this.renderPromise = null;
      });
    }
    await this.renderPromise;
  }

  private async renderLatestPdf(): Promise<void> {
    while (!this.destroyed && !this.rendered) {
      const geometry = this.geometry;
      // Keep the last good bitmap in the DOM until the sharp replacement is ready.
      const canvas = this.element.ownerDocument.createElement("canvas");
      canvas.className = "betterscore-pdf-canvas";
      canvas.width = Math.ceil(geometry.renderViewport.width);
      canvas.height = Math.ceil(geometry.renderViewport.height);
      canvas.style.width = `${geometry.cssViewport.width}px`;
      canvas.style.height = `${geometry.cssViewport.height}px`;
      this.pendingCanvas = canvas;
      try {
        const context = canvas.getContext("2d");
        if (!context) throw new Error("PDF canvas is not available");
        const task = this.page.render({canvasContext: context, viewport: geometry.renderViewport});
        this.renderTask = task;
        await task.promise;
        if (!this.destroyed && this.geometry === geometry) {
          const previous = this.pdfCanvas;
          previous.replaceWith(canvas);
          previous.width = previous.height = 0;
          this.pdfCanvas = canvas;
          this.rendered = true;
        }
      } catch (error) {
        if (!this.destroyed && this.geometry === geometry) throw error;
      } finally {
        if (this.pdfCanvas !== canvas) canvas.width = canvas.height = 0;
        this.pendingCanvas = null;
        this.renderTask = null;
      }
    }
  }

  isPdfRendered(): boolean {
    return this.rendered;
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

  releasePointer(pointerId: number): void {
    if (this.overlay.hasPointerCapture(pointerId)) {
      this.overlay.releasePointerCapture(pointerId);
    }
  }

  destroy(): boolean {
    if (this.destroyed) return false;
    this.destroyed = true;
    this.pointerHandlers.onSurfaceDestroy?.(this);
    const activeTask = this.renderTask;
    activeTask?.cancel?.();
    this.renderTask = null;
    this.overlay.removeEventListener("pointerdown", this.handlePointerDown);
    this.overlay.removeEventListener("pointermove", this.handlePointerMove);
    this.overlay.removeEventListener("pointerup", this.handlePointerEnd);
    this.overlay.removeEventListener("pointercancel", this.handlePointerEnd);
    this.overlay.removeEventListener("lostpointercapture", this.handlePointerEnd);
    // Setting bitmap dimensions to zero releases browser/GPU backing stores.
    this.pdfCanvas.width = 0;
    this.pdfCanvas.height = 0;
    this.overlay.width = 0;
    this.overlay.height = 0;
    this.pdfCanvas.remove();
    this.overlay.remove();
    this.element.removeClass("is-mounted");
    if (activeTask) {
      void activeTask.promise.catch(() => undefined).finally(() => this.page.cleanup?.());
    } else {
      this.page.cleanup?.();
    }
    return activeTask !== null;
  }

  getCanvasPixelArea(): number {
    return this.pdfCanvas.width * this.pdfCanvas.height
      + this.overlay.width * this.overlay.height
      + (this.pendingCanvas ? this.pendingCanvas.width * this.pendingCanvas.height : 0);
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
