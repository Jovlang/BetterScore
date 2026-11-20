import type {PdfDocument, PdfRenderTask} from "./pdf-types";

const THUMBNAIL_WIDTH = 104;
const THUMBNAIL_HEIGHT = 148;

export class ThumbnailStrip {
  private readonly buttons = new Map<number, HTMLButtonElement>();
  private readonly canvases = new Map<number, HTMLCanvasElement>();
  private readonly rendered = new Set<number>();
  private readonly queued = new Set<number>();
  private readonly queue: number[] = [];
  private observer: IntersectionObserver | null = null;
  private activeTask: PdfRenderTask | null = null;
  private activePage: number | null = null;
  private rendering = false;
  private currentPage = 1;
  private activated = false;
  private disposed = false;

  constructor(
    private readonly container: HTMLElement,
    private readonly pdf: PdfDocument,
    private readonly onSelect: (pageNumber: number) => void,
    private readonly onError?: (pageNumber: number, error: unknown) => void
  ) {
    this.initialize();
  }

  setCurrentPage(pageNumber: number, reveal = false): void {
    this.buttons.get(this.currentPage)?.removeClass("is-current");
    this.currentPage = Math.max(1, Math.min(this.pdf.numPages, pageNumber));
    const button = this.buttons.get(this.currentPage);
    button?.addClass("is-current");
    if (this.activated) this.requestRender(this.currentPage, true);
    if (reveal) button?.scrollIntoView({block: "nearest"});
  }

  activate(): void {
    this.activated = true;
    this.setCurrentPage(this.currentPage, true);
    if (!this.observer) {
      for (let pageNumber = 1; pageNumber <= this.pdf.numPages; pageNumber += 1) {
        this.requestRender(pageNumber);
      }
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.observer?.disconnect();
    this.observer = null;
    this.activeTask?.cancel?.();
    this.activeTask = null;
    this.queue.length = 0;
    this.queued.clear();
    for (const canvas of this.canvases.values()) {
      canvas.width = 0;
      canvas.height = 0;
    }
    this.buttons.clear();
    this.canvases.clear();
    this.rendered.clear();
    this.container.empty();
  }

  private initialize(): void {
    this.container.empty();
    if (typeof IntersectionObserver !== "undefined") {
      this.observer = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const pageNumber = Number((entry.target as HTMLElement).dataset.page);
            if (this.activated && Number.isInteger(pageNumber)) this.requestRender(pageNumber);
          }
        },
        {root: this.container, rootMargin: "200% 0px", threshold: 0}
      );
    }

    for (let pageNumber = 1; pageNumber <= this.pdf.numPages; pageNumber += 1) {
      const button = this.container.createEl("button", {
        cls: "betterscore-thumbnail",
        attr: {type: "button", "aria-label": `Go to page ${pageNumber}`}
      });
      button.dataset.page = String(pageNumber);
      const canvas = button.createEl("canvas", {cls: "betterscore-thumbnail-canvas"});
      canvas.width = 1;
      canvas.height = 1;
      button.createSpan({cls: "betterscore-thumbnail-label", text: String(pageNumber)});
      button.addEventListener("click", () => this.onSelect(pageNumber));
      this.buttons.set(pageNumber, button);
      this.canvases.set(pageNumber, canvas);
      this.observer?.observe(button);
    }
    this.setCurrentPage(1);
  }

  private requestRender(pageNumber: number, priority = false): void {
    if (this.disposed || this.rendered.has(pageNumber)) return;
    if (this.queued.has(pageNumber)) {
      if (priority) {
        const index = this.queue.indexOf(pageNumber);
        if (index > 0) {
          this.queue.splice(index, 1);
          this.queue.unshift(pageNumber);
        }
      }
      return;
    }
    this.queued.add(pageNumber);
    if (priority) this.queue.unshift(pageNumber);
    else this.queue.push(pageNumber);
    this.drain();
  }

  private drain(): void {
    if (this.disposed || this.rendering) return;
    const pageNumber = this.queue.shift();
    if (pageNumber === undefined) return;
    this.queued.delete(pageNumber);
    this.rendering = true;
    void this.render(pageNumber).finally(() => {
      this.rendering = false;
      this.activeTask = null;
      this.activePage = null;
      if (!this.disposed) window.requestAnimationFrame(() => this.drain());
    });
  }

  private async render(pageNumber: number): Promise<void> {
    try {
      const page = await this.pdf.getPage(pageNumber);
      if (this.disposed) return;
      const base = page.getViewport({scale: 1});
      const scale = calculateThumbnailScale(base.width, base.height);
      const viewport = page.getViewport({scale});
      const canvas = this.canvases.get(pageNumber);
      const context = canvas?.getContext("2d");
      if (!canvas || !context) return;
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      canvas.style.width = `${viewport.width}px`;
      canvas.style.height = `${viewport.height}px`;
      const task = page.render({canvasContext: context, viewport});
      this.activeTask = task;
      this.activePage = pageNumber;
      await task.promise;
      if (this.disposed || this.activePage !== pageNumber) return;
      this.rendered.add(pageNumber);
      this.buttons.get(pageNumber)?.addClass("is-rendered");
    } catch (error) {
      if (!this.disposed) this.onError?.(pageNumber, error);
    }
  }
}

export function calculateThumbnailScale(
  pageWidth: number,
  pageHeight: number,
  maxWidth = THUMBNAIL_WIDTH,
  maxHeight = THUMBNAIL_HEIGHT
): number {
  if (pageWidth <= 0 || pageHeight <= 0) return 1;
  return Math.min(maxWidth / pageWidth, maxHeight / pageHeight, 1);
}
