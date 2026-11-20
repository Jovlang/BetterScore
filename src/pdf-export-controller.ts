import {App, Modal, Notice, Platform, TFile} from "obsidian";
import {createFlattenedPdf, flattenedPdfPath, requiresLargeExportWarning} from "./pdf-export";
import type {AnnotationDocument} from "./model";

export class PdfExportController {
  private exporting = false;

  constructor(private readonly app: App) {}

  isExporting(): boolean {
    return this.exporting;
  }

  async export(file: TFile, annotations: AnnotationDocument): Promise<string | null> {
    if (this.exporting) return null;
    this.exporting = true;
    let notice: Notice | null = null;
    try {
      if (
        requiresLargeExportWarning(file.stat.size, Platform.isMobile)
        && !(await confirmLargeExport(this.app, file.stat.size))
      ) {
        return null;
      }
      notice = new Notice("BetterScore: Exporting annotated PDF…", 0);
      const source = await this.app.vault.readBinary(file);
      const bytes = await createFlattenedPdf(source, annotations);
      const outputPath = this.availableOutputPath(file.path);
      await this.app.vault.createBinary(outputPath, Uint8Array.from(bytes).buffer);
      new Notice(`BetterScore exported ${outputPath}`, 8000);
      return outputPath;
    } catch (error) {
      new Notice(`BetterScore export failed: ${messageOf(error)}`, 10000);
      return null;
    } finally {
      notice?.hide();
      this.exporting = false;
    }
  }

  private availableOutputPath(sourcePath: string): string {
    let copy = 1;
    let outputPath = flattenedPdfPath(sourcePath, copy);
    while (this.app.vault.getAbstractFileByPath(outputPath)) {
      copy += 1;
      outputPath = flattenedPdfPath(sourcePath, copy);
    }
    return outputPath;
  }
}

class LargeExportModal extends Modal {
  private accepted = false;

  constructor(
    app: App,
    private readonly sourceBytes: number,
    private readonly resolve: (accepted: boolean) => void
  ) {
    super(app);
  }

  onOpen(): void {
    this.contentEl.createEl("h3", {text: "Large PDF export"});
    const size = Math.round(this.sourceBytes / (1024 * 1024));
    this.contentEl.createEl("p", {
      text: `${size} MiB must be held in memory along with decoded PDF data and the complete output. This may close Obsidian on a memory-constrained device.`
    });
    const actions = this.contentEl.createDiv({cls: "betterscore-export-warning-actions"});
    const cancel = actions.createEl("button", {text: "Cancel"});
    const proceed = actions.createEl("button", {
      cls: "mod-warning",
      text: "Export anyway"
    });
    cancel.addEventListener("click", () => this.close());
    proceed.addEventListener("click", () => {
      this.accepted = true;
      this.close();
    });
  }

  onClose(): void {
    this.contentEl.empty();
    this.resolve(this.accepted);
  }
}

function confirmLargeExport(app: App, sourceBytes: number): Promise<boolean> {
  return new Promise((resolve) => {
    new LargeExportModal(app, sourceBytes, resolve).open();
  });
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
