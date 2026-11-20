import {PDFDocument} from "pdf-lib";
import {drawPageAnnotations} from "./annotation-renderer";
import type {AnnotationDocument, PageAnnotations} from "./model";

const EXPORT_SCALE = 2;
const MAX_OVERLAY_DIMENSION = 4096;
const MOBILE_EXPORT_WARNING_BYTES = 64 * 1024 * 1024;
const DESKTOP_EXPORT_WARNING_BYTES = 192 * 1024 * 1024;

export async function createFlattenedPdf(
  source: ArrayBuffer,
  annotations: AnnotationDocument
): Promise<Uint8Array> {
  const document = await PDFDocument.load(new Uint8Array(source));
  const pages = document.getPages();

  for (const [pageKey, pageAnnotations] of Object.entries(annotations.pages)) {
    if (!hasAnnotations(pageAnnotations)) continue;
    const pageIndex = Number(pageKey) - 1;
    const page = pages[pageIndex];
    if (!page || !Number.isInteger(pageIndex) || pageIndex < 0) continue;
    const cropBox = page.getCropBox();
    const {width, height} = cropBox;
    const angle = normalizeRotation(page.getRotation().angle);
    const displayWidth = angle === 90 || angle === 270 ? height : width;
    const displayHeight = angle === 90 || angle === 270 ? width : height;
    const scale = Math.min(
      EXPORT_SCALE,
      MAX_OVERLAY_DIMENSION / Math.max(displayWidth, displayHeight)
    );
    const displayCanvas = createCanvas(displayWidth, displayHeight, scale);
    const displayContext = displayCanvas.getContext("2d");
    if (!displayContext) throw new Error("Could not create annotation export canvas");
    drawPageAnnotations(
      displayContext,
      pageAnnotations,
      displayCanvas.width,
      displayCanvas.height
    );
    const overlayCanvas = rotateOverlayToPage(displayCanvas, angle);
    const pngBuffer = await canvasToBlob(overlayCanvas).then((blob) => blob.arrayBuffer());
    const pngBytes = new Uint8Array(pngBuffer as ArrayBuffer);
    const image = await document.embedPng(pngBytes);
    page.drawImage(image, {x: cropBox.x, y: cropBox.y, width, height});
    displayCanvas.width = 0;
    displayCanvas.height = 0;
    if (overlayCanvas !== displayCanvas) {
      overlayCanvas.width = 0;
      overlayCanvas.height = 0;
    }
  }
  return document.save();
}

export function flattenedPdfPath(sourcePath: string, copy = 1): string {
  const suffix = copy <= 1 ? ".annotated.pdf" : `.annotated ${copy}.pdf`;
  return /\.pdf$/i.test(sourcePath)
    ? sourcePath.replace(/\.pdf$/i, suffix)
    : `${sourcePath}${suffix}`;
}

export function requiresLargeExportWarning(sourceBytes: number, isMobile: boolean): boolean {
  const threshold = isMobile ? MOBILE_EXPORT_WARNING_BYTES : DESKTOP_EXPORT_WARNING_BYTES;
  return sourceBytes >= threshold;
}

function hasAnnotations(page: PageAnnotations): boolean {
  return page.strokes.length > 0 || page.texts.length > 0;
}

function createCanvas(width: number, height: number, scale: number): HTMLCanvasElement {
  const canvas = document.createElement("canvas");
  canvas.width = Math.max(1, Math.ceil(width * scale));
  canvas.height = Math.max(1, Math.ceil(height * scale));
  return canvas;
}

function rotateOverlayToPage(canvas: HTMLCanvasElement, angle: number): HTMLCanvasElement {
  if (angle === 0) return canvas;
  const quarterTurn = angle === 90 || angle === 270;
  const rotated = document.createElement("canvas");
  rotated.width = quarterTurn ? canvas.height : canvas.width;
  rotated.height = quarterTurn ? canvas.width : canvas.height;
  const context = rotated.getContext("2d");
  if (!context) throw new Error("Could not rotate annotation export canvas");
  if (angle === 90) {
    context.translate(0, rotated.height);
    context.rotate(-Math.PI / 2);
  } else if (angle === 180) {
    context.translate(rotated.width, rotated.height);
    context.rotate(Math.PI);
  } else if (angle === 270) {
    context.translate(rotated.width, 0);
    context.rotate(Math.PI / 2);
  }
  context.drawImage(canvas, 0, 0);
  return rotated;
}

function normalizeRotation(angle: number): number {
  return ((angle % 360) + 360) % 360;
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("Could not encode annotation overlay"));
    }, "image/png");
  });
}
