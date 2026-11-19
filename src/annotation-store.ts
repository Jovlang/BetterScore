import {TFile, Vault} from "obsidian";
import {
  AnnotationDocument,
  createAnnotationDocument,
  parseAnnotationDocument,
  serializeAnnotationDocument,
  sidecarPath
} from "./model";

export interface PreparedAnnotationSave {
  pdf: TFile;
  serialized: string;
}

export class AnnotationStore {
  constructor(private readonly vault: Vault) {}

  async load(pdf: TFile): Promise<AnnotationDocument> {
    const path = sidecarPath(pdf.path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) return createAnnotationDocument(pdf.path);
    return parseAnnotationDocument(await this.vault.read(existing), pdf.path);
  }

  prepare(pdf: TFile, document: AnnotationDocument): PreparedAnnotationSave {
    return {pdf, serialized: serializeAnnotationDocument(document)};
  }

  async save(prepared: PreparedAnnotationSave): Promise<void> {
    const path = sidecarPath(prepared.pdf.path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) {
      await this.vault.modify(existing, prepared.serialized);
    } else {
      await this.vault.create(path, prepared.serialized);
    }
  }
}
