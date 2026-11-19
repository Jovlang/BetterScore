import {TFile, Vault} from "obsidian";
import {
  AnnotationDocument,
  createAnnotationDocument,
  parseAnnotationDocument,
  serializeAnnotationDocument,
  sidecarPath
} from "./model";

export class AnnotationStore {
  constructor(private readonly vault: Vault) {}

  async load(pdf: TFile): Promise<AnnotationDocument> {
    const path = sidecarPath(pdf.path);
    const existing = this.vault.getAbstractFileByPath(path);
    if (!(existing instanceof TFile)) return createAnnotationDocument(pdf.path);
    return parseAnnotationDocument(await this.vault.read(existing), pdf.path);
  }

  async save(pdf: TFile, document: AnnotationDocument): Promise<void> {
    const path = sidecarPath(pdf.path);
    const existing = this.vault.getAbstractFileByPath(path);
    const serialized = serializeAnnotationDocument(document);
    if (existing instanceof TFile) {
      await this.vault.modify(existing, serialized);
    } else {
      await this.vault.create(path, serialized);
    }
  }
}
