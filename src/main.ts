import {Notice, Plugin, TFile, WorkspaceLeaf} from "obsidian";
import {AnnotationStore} from "./annotation-store";
import {BetterScoreView, VIEW_TYPE_BETTERSCORE} from "./score-view";
import {BetterScoreSettings, EraserMode, normalizeSettings} from "./settings";

export default class BetterScorePlugin extends Plugin {
  private pluginSettings: BetterScoreSettings = normalizeSettings(null);

  async onload(): Promise<void> {
    this.pluginSettings = normalizeSettings(await this.loadData());
    const annotationStore = new AnnotationStore(this.app.vault);
    this.registerView(
      VIEW_TYPE_BETTERSCORE,
      (leaf) => new BetterScoreView(
        leaf,
        () => this.pluginSettings.highlighterWidth,
        (width) => this.setHighlighterWidth(width),
        () => this.pluginSettings.eraserMode,
        (mode) => this.setEraserMode(mode)
      )
    );

    this.addCommand({
      id: "open-active-pdf",
      name: "Open active PDF in BetterScore",
      checkCallback: (checking) => {
        const file = this.app.workspace.getActiveFile();
        if (!isPdf(file)) return false;
        if (!checking) void this.openScore(file);
        return true;
      }
    });

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file, _source, leaf) => {
        if (!isPdf(file)) return;
        menu.addItem((item) => {
          item
            .setTitle("Open in BetterScore")
            .setIcon("music-2")
            .onClick(() => this.openScore(file, leaf));
        });
      })
    );

    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (!isPdf(file)) return;
        void annotationStore.handlePdfRename(file, oldPath).then((result) => {
          if (result === "conflict") {
            new Notice(
              `BetterScore did not move the annotations because ${file.basename}.betterscore.json already exists.`
            );
          }
        }).catch((error: unknown) => {
          new Notice(`BetterScore could not move the annotation sidecar: ${messageOf(error)}`);
        });
      })
    );
  }

  private async setHighlighterWidth(width: number): Promise<void> {
    this.pluginSettings = normalizeSettings({
      ...this.pluginSettings,
      highlighterWidth: width
    });
    await this.saveData(this.pluginSettings);
  }

  private async setEraserMode(mode: EraserMode): Promise<void> {
    this.pluginSettings = normalizeSettings({...this.pluginSettings, eraserMode: mode});
    await this.saveData(this.pluginSettings);
  }

  private async openScore(file: TFile, leaf?: WorkspaceLeaf): Promise<void> {
    const target = leaf ?? this.app.workspace.getLeaf(false);
    await target.setViewState({
      type: VIEW_TYPE_BETTERSCORE,
      state: {file: file.path},
      active: true
    });
    await this.app.workspace.revealLeaf(target);
  }
}

function isPdf(file: unknown): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
