import {App, FuzzyMatch, FuzzySuggestModal, TFile} from "obsidian";
import {isPdfPath} from "./file-types";

export class ScoreSwitcherModal extends FuzzySuggestModal<TFile> {
  constructor(
    app: App,
    private readonly openScore: (file: TFile) => void
  ) {
    super(app);
    this.setPlaceholder("Search PDF scores…");
    this.setInstructions([
      {command: "↑↓", purpose: "navigate"},
      {command: "↵", purpose: "open in BetterScore"},
      {command: "esc", purpose: "close"}
    ]);
  }

  getItems(): TFile[] {
    return this.app.vault.getFiles()
      .filter((file) => isPdfPath(file.path))
      .sort((left, right) => left.path.localeCompare(right.path));
  }

  getItemText(file: TFile): string {
    return file.path;
  }

  renderSuggestion(match: FuzzyMatch<TFile>, element: HTMLElement): void {
    const file = match.item;
    element.addClass("betterscore-score-suggestion");
    element.createDiv({
      cls: "betterscore-score-suggestion-title",
      text: file.basename
    });
    element.createDiv({
      cls: "betterscore-score-suggestion-path",
      text: file.parent?.path || "Vault root"
    });
  }

  onChooseItem(file: TFile): void {
    this.openScore(file);
  }
}
