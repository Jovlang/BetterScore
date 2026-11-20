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
import {precisionErase, strokeIntersectsEraser} from "./eraser";
import {shouldRecordSample, simplifyStrokePoints} from "./simplify";
import {SaveCoordinator} from "./save-coordinator";
import {PageSurface} from "./page-surface";
import {PageSurfaceManager} from "./page-surface-manager";
import type {PageSurfaceStats} from "./page-surface-manager";
import type {PdfDocument} from "./pdf-types";
import {
  AnnotationDocument,
  AnnotationTool,
  PageAnnotations,
  SourceFingerprintMismatchError,
  Stroke,
  StrokePoint,
  TextAnnotation,
  createAnnotationDocument
} from "./model";
import {createSourceIdentity} from "./source-identity";
import {
  HIGHLIGHTER_WIDTH_PRESETS,
  EraserMode,
  highlighterWidthLabel,
  nearlyEqual
} from "./settings";

export const VIEW_TYPE_BETTERSCORE = "betterscore-pdf";

type ActiveTool = AnnotationTool | "eraser" | "text";

export class BetterScoreView extends FileView {
  private readonly store = new AnnotationStore(this.app.vault);
  private pdf: PdfDocument | null = null;
  private annotations: AnnotationDocument = createAnnotationDocument({
    path: "",
    fingerprint: "",
    size: 0
  });
  private annotationsWritable = true;
  private annotationBlockReason = "";
  private surfaceManager: PageSurfaceManager | null = null;
  private tool: ActiveTool = "pen";
  private undoStack: AnnotationDocument[] = [];
  private redoStack: AnnotationDocument[] = [];
  private readonly saveCoordinator: SaveCoordinator<PreparedAnnotationSave>;
  private activeStroke: Stroke | null = null;
  private activePage: number | null = null;
  private currentPage = 1;
  private toolbar: HTMLElement | null = null;
  private scoreContainer: HTMLElement | null = null;
  private undoButton: HTMLButtonElement | null = null;
  private redoButton: HTMLButtonElement | null = null;
  private markerButton: HTMLButtonElement | null = null;
  private eraserButton: HTMLButtonElement | null = null;

  constructor(
    leaf: WorkspaceLeaf,
    private readonly getHighlighterWidth: () => number,
    private readonly setHighlighterWidth: (width: number) => Promise<void>,
    private readonly getEraserMode: () => EraserMode,
    private readonly setEraserMode: (mode: EraserMode) => Promise<void>
  ) {
    super(leaf);
    this.navigation = true;
    this.saveCoordinator = new SaveCoordinator(
      (prepared) => this.store.save(prepared),
      500,
      (error) => this.reportSaveError(error)
    );
    this.registerDomEvent(document, "keydown", (event) => this.handleHistoryShortcut(event));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flushSave();
    });
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

  async onLoadFile(file: TFile): Promise<void> {
    await super.onLoadFile(file);
    await this.openScore(file);
  }

  async onUnloadFile(file: TFile): Promise<void> {
    await this.flushSave();
    await this.destroyPdf();
    await super.onUnloadFile(file);
  }

  async onClose(): Promise<void> {
    await this.disposeSaveCoordinator();
    await this.destroyPdf();
  }

  private async openScore(file: TFile): Promise<void> {
    this.undoStack = [];
    this.redoStack = [];
    this.currentPage = 1;
    this.annotationsWritable = true;
    this.annotationBlockReason = "";
    this.contentEl.empty();
    this.contentEl.addClass("betterscore-view");
    this.renderToolbar();
    this.scoreContainer = this.contentEl.createDiv({cls: "betterscore-pages"});
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
      this.scoreContainer.empty();
      this.surfaceManager = new PageSurfaceManager(this.scoreContainer, this.pdf, {
        onPointerDown: (surface, event) => this.handlePointerDown(surface, event),
        onPointerMove: (surface, event) => this.handlePointerMove(surface, event),
        onPointerEnd: (surface, event) => this.handlePointerEnd(surface, event),
        drawAnnotations: (surface) => this.drawSurface(surface),
        onCurrentPageChange: (pageNumber) => {
          this.currentPage = pageNumber;
        },
        onRenderError: (pageNumber, error) => {
          new Notice(`BetterScore could not render page ${pageNumber}: ${messageOf(error)}`);
        }
      });
      await this.surfaceManager.initializeContinuous();
    } catch (error) {
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
    this.addToolButton("pencil", "Pen", "pen");
    this.markerButton = this.addToolButton("highlighter", "Yellow marker", "highlighter");
    this.updateMarkerButton();
    this.markerButton?.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showMarkerWidthMenu(event);
    });
    this.addToolButton("type", "Text", "text");
    this.eraserButton = this.addToolButton("eraser", "Eraser", "eraser");
    this.updateEraserButton();
    this.eraserButton?.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      this.showEraserModeMenu(event);
    });
    this.toolbar.createDiv({cls: "betterscore-toolbar-divider"});
    this.undoButton = this.addActionButton("undo-2", "Undo", "Ctrl/⌘ Z", () => this.undo());
    this.redoButton = this.addActionButton(
      "redo-2",
      "Redo",
      "Ctrl/⌘ Shift Z",
      () => this.redo()
    );
    this.updateToolButtons();
    this.updateHistoryButtons();
  }

  private addToolButton(
    icon: string,
    label: string,
    tool: ActiveTool
  ): HTMLButtonElement | null {
    const button = this.toolbar?.createEl("button", {
      cls: "clickable-icon betterscore-tool",
      attr: {"aria-label": label, "data-tool": tool}
    });
    if (!button) return null;
    setIcon(button, icon);
    if (tool === "highlighter") {
      button.createSpan({cls: "betterscore-marker-swatch"});
    }
    button.createSpan({cls: "betterscore-button-label", text: label});
    button.addEventListener("click", () => {
      this.tool = tool;
      this.updateToolButtons();
    });
    return button;
  }

  private showMarkerWidthMenu(event: MouseEvent): void {
    const current = this.getHighlighterWidth();
    const menu = new Menu();
    for (const preset of HIGHLIGHTER_WIDTH_PRESETS) {
      menu.addItem((item) => {
        item
          .setTitle(preset.label)
          .setChecked(nearlyEqual(current, preset.width))
          .onClick(async () => {
            await this.setHighlighterWidth(preset.width);
            this.updateMarkerButton();
          });
      });
    }
    menu.showAtMouseEvent(event);
  }

  private updateMarkerButton(): void {
    if (!this.markerButton) return;
    const width = this.getHighlighterWidth();
    const label = highlighterWidthLabel(width);
    this.markerButton.setAttribute(
      "aria-label",
      `Yellow marker · ${label}. Right-click to set width.`
    );
    this.markerButton.setAttribute("title", `Marker width: ${label} · Right-click to change`);
    const text = this.markerButton.querySelector<HTMLElement>(".betterscore-button-label");
    if (text) text.textContent = `Yellow marker · ${label}`;
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
    const text = this.eraserButton.querySelector<HTMLElement>(".betterscore-button-label");
    if (text) text.textContent = `Eraser · ${label}`;
  }

  private addActionButton(
    icon: string,
    label: string,
    shortcut: string,
    action: () => void
  ): HTMLButtonElement | null {
    const button = this.toolbar?.createEl("button", {
      cls: "clickable-icon betterscore-history-action",
      attr: {"aria-label": `${label} (${shortcut})`, title: `${label} (${shortcut})`}
    });
    if (!button) return null;
    setIcon(button, icon);
    button.createSpan({cls: "betterscore-button-label", text: label});
    button.addEventListener("click", action);
    return button;
  }

  private updateToolButtons(): void {
    this.toolbar?.querySelectorAll<HTMLElement>("[data-tool]").forEach((button) => {
      button.toggleClass("is-active", button.dataset.tool === this.tool);
    });
  }

  private handlePointerDown(surface: PageSurface, event: PointerEvent): void {
    const {pageNumber} = surface;
    // A finger navigates the score; Pencil/stylus and mouse create annotations.
    if (event.pointerType === "touch" && this.tool !== "text") return;
    if (event.button !== 0 && event.pointerType === "mouse") return;
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
    if (this.tool === "eraser") {
      this.pushUndoState();
      this.activePage = pageNumber;
      this.eraseAt(pageNumber, point);
      return;
    }

    this.pushUndoState();
    this.activePage = pageNumber;
    this.activeStroke = {
      id: crypto.randomUUID(),
      tool: this.tool,
      color: this.tool === "highlighter" ? "#ffd60a" : "#e53935",
      opacity: this.tool === "highlighter" ? 0.2 : 0.92,
      width: this.tool === "highlighter" ? this.getHighlighterWidth() : 0.0045,
      points: [point]
    };
    this.page(pageNumber).strokes.push(this.activeStroke);
    this.drawPage(pageNumber);
  }

  private handlePointerMove(surface: PageSurface, event: PointerEvent): void {
    if (!surface.hasPointerCapture(event.pointerId)) return;
    const point = surface.pointFromEvent(event);
    if (this.tool === "eraser") {
      this.eraseAt(surface.pageNumber, point);
    } else if (this.activeStroke && this.activePage === surface.pageNumber) {
      const previous = this.activeStroke.points[this.activeStroke.points.length - 1];
      if (!previous || shouldRecordSample(previous, point)) {
        this.activeStroke.points.push(point);
        this.drawPage(surface.pageNumber);
      }
    }
  }

  private handlePointerEnd(surface: PageSurface, event: PointerEvent): void {
    surface.releasePointer(event.pointerId);
    if (this.activeStroke) {
      if (event.type === "pointerup") {
        const finalPoint = surface.pointFromEvent(event);
        const previous = this.activeStroke.points[this.activeStroke.points.length - 1];
        if (!previous || shouldRecordSample(previous, finalPoint)) {
          this.activeStroke.points.push(finalPoint);
        }
      }
      this.activeStroke.points = simplifyStrokePoints(
        this.activeStroke.points,
        this.activeStroke.tool
      );
      this.drawPage(surface.pageNumber);
      this.scheduleSave();
    }
    this.activeStroke = null;
    this.activePage = null;
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
    this.activePage = pageNumber;
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
      for (const stroke of annotations.strokes) {
        drawStroke(context, stroke, width, height);
      }
      for (const text of annotations.texts) {
        drawTextAnnotation(context, text, width, height);
      }
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
    this.annotations = previous;
    this.redrawAll();
    this.scheduleSave();
    this.updateHistoryButtons();
  }

  private redo(): void {
    const next = this.redoStack.pop();
    if (!next) return;
    this.undoStack.push(structuredClone(this.annotations));
    this.annotations = next;
    this.redrawAll();
    this.scheduleSave();
    this.updateHistoryButtons();
  }

  private updateHistoryButtons(): void {
    if (this.undoButton) this.undoButton.disabled = this.undoStack.length === 0;
    if (this.redoButton) this.redoButton.disabled = this.redoStack.length === 0;
  }

  private handleHistoryShortcut(event: KeyboardEvent): void {
    if (this.app.workspace.getActiveViewOfType(BetterScoreView) !== this) return;
    const modifier = event.metaKey || event.ctrlKey;
    if (!modifier || event.altKey) return;

    const key = event.key.toLowerCase();
    const wantsUndo = key === "z" && !event.shiftKey;
    const wantsRedo = (key === "z" && event.shiftKey) || (key === "y" && !event.shiftKey);
    if (wantsUndo && this.undoStack.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.undo();
    } else if (wantsRedo && this.redoStack.length > 0) {
      event.preventDefault();
      event.stopPropagation();
      this.redo();
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
    this.surfaceManager?.dispose();
    this.surfaceManager = null;
    if (!this.pdf) return;
    await this.pdf.destroy();
    this.pdf = null;
  }
}

function drawStroke(
  context: CanvasRenderingContext2D,
  stroke: Stroke,
  width: number,
  height: number
): void {
  if (stroke.points.length === 0) return;
  context.save();
  context.strokeStyle = stroke.color;
  context.fillStyle = stroke.color;
  context.globalAlpha = stroke.opacity;
  context.globalCompositeOperation = "source-over";
  context.lineCap = "round";
  context.lineJoin = "round";

  const first = stroke.points[0];
  if (!first) return;
  if (stroke.points.length === 1) {
    context.beginPath();
    context.arc(first.x * width, first.y * height, stroke.width * width * 0.5, 0, Math.PI * 2);
    context.fill();
  } else if (stroke.tool === "highlighter") {
    // Paint the whole gesture once. Painting each mouse segment separately
    // makes translucent round caps overlap and produces an unexpectedly dark line.
    context.lineWidth = stroke.width * width;
    context.beginPath();
    context.moveTo(first.x * width, first.y * height);
    for (const point of stroke.points.slice(1)) {
      context.lineTo(point.x * width, point.y * height);
    }
    context.stroke();
  } else {
    for (let index = 1; index < stroke.points.length; index += 1) {
      const previous = stroke.points[index - 1];
      const point = stroke.points[index];
      if (!previous || !point) continue;
      const pressure = (previous.pressure + point.pressure) / 2;
      context.lineWidth = stroke.width * width * (0.65 + pressure * 0.7);
      context.beginPath();
      context.moveTo(previous.x * width, previous.y * height);
      context.lineTo(point.x * width, point.y * height);
      context.stroke();
    }
  }
  context.restore();
}

function drawTextAnnotation(
  context: CanvasRenderingContext2D,
  annotation: TextAnnotation,
  width: number,
  height: number
): void {
  const fontSize = annotation.fontSize * width;
  context.save();
  context.fillStyle = annotation.color;
  context.globalAlpha = 0.95;
  context.font = `600 ${fontSize}px sans-serif`;
  context.textBaseline = "top";
  annotation.text.split("\n").forEach((line, index) => {
    context.fillText(
      line,
      annotation.x * width,
      annotation.y * height + index * fontSize * 1.2
    );
  });
  context.restore();
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

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
