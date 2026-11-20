export interface PdfViewport {
  width: number;
  height: number;
}

export interface PdfRenderTask {
  promise: Promise<void>;
  cancel?: () => void;
}

export interface PdfPage {
  getViewport(options: {scale: number}): PdfViewport;
  render(options: {
    canvasContext: CanvasRenderingContext2D;
    viewport: PdfViewport;
  }): PdfRenderTask;
  cleanup?: () => void;
}

export interface PdfDocument {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPage>;
  destroy(): Promise<void>;
}
