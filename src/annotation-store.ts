import {TFile, Vault} from "obsidian";
import {
  AnnotationDocument,
  SourceIdentity,
  createAnnotationDocument,
  parseAnnotationDocument,
  rewriteAnnotationSourcePath,
  serializeAnnotationDocument,
  sidecarPath
} from "./model";

export interface PreparedAnnotationSave {
  pdf: TFile;
  serialized: string;
}

export type SidecarRenameResult = "moved" | "missing" | "conflict";

export class AnnotationStore {
  constructor(private readonly vault: Vault) {}

  async load(pdf: TFile, source: SourceIdentity): Promise<AnnotationDocument> {
    const path = sidecarPath(pdf.path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) return createAnnotationDocument(source);
    const raw = await this.vault.read(existing);
    const document = parseAnnotationDocument(raw, source);
    const canonical = serializeAnnotationDocument(document, document.updatedAt);
    if (canonical !== raw) await this.vault.modify(existing, canonical);
    return document;
  }

  prepare(pdf: TFile, document: AnnotationDocument): PreparedAnnotationSave {
    document.source.path = pdf.path;
    return {pdf, serialized: serializeAnnotationDocument(document)};
  }

  async save(prepared: PreparedAnnotationSave): Promise<void> {
    const path = sidecarPath(prepared.pdf.path);
    const existing = this.vault.getAbstractFileByPath(path);
    const serialized = rewriteAnnotationSourcePath(prepared.serialized, prepared.pdf.path);
    if (existing instanceof TFile) {
      await this.vault.modify(existing, serialized);
    } else {
      await this.vault.create(path, serialized);
    }
  }

  async handlePdfRename(pdf: TFile, oldPdfPath: string): Promise<SidecarRenameResult> {
    const oldPath = sidecarPath(oldPdfPath);
    const newPath = sidecarPath(pdf.path);
    if (oldPath === newPath) return "missing";
    const sidecar = this.vault.getAbstractFileByPath(oldPath);
    if (!(sidecar instanceof TFile)) return "missing";
    const destination = this.vault.getAbstractFileByPath(newPath);
    if (destination && destination !== sidecar) return "conflict";

    await this.vault.rename(sidecar, newPath);
    const updated = rewriteAnnotationSourcePath(await this.vault.read(sidecar), pdf.path);
    await this.vault.modify(sidecar, updated);
    return "moved";
  }
}
