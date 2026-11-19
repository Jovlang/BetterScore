import {Plugin, TFile, WorkspaceLeaf} from "obsidian";
import {BetterScoreView, VIEW_TYPE_BETTERSCORE} from "./score-view";

export default class BetterScorePlugin extends Plugin {
  async onload(): Promise<void> {
    this.registerView(VIEW_TYPE_BETTERSCORE, (leaf) => new BetterScoreView(leaf));

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
