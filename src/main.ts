import {Notice, Plugin, TFile, WorkspaceLeaf} from "obsidian";
import {AnnotationStore} from "./annotation-store";
import {BetterScoreView, VIEW_TYPE_BETTERSCORE} from "./score-view";
import {ScoreSwitcherModal} from "./score-switcher";
import {BetterScoreSettings, EraserMode, normalizeSettings} from "./settings";
import type {ViewMode} from "./viewer-layout";

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
        (mode) => this.setEraserMode(mode),
        () => this.pluginSettings.fingerDrawingEnabled,
        (enabled) => this.setFingerDrawingEnabled(enabled)
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

    this.addCommand({
      id: "open-score-switcher",
      name: "Open score switcher",
      callback: () => this.openScoreSwitcher()
    });
    this.addCommand({
      id: "show-render-statistics",
      name: "Show render statistics",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BetterScoreView);
        const stats = view?.getRenderStats();
        if (!stats) return false;
        if (!checking) {
          new Notice(
            `BetterScore page ${stats.currentPage}/${stats.totalPages} · `
            + `${stats.mountedSurfaces} surfaces · ${stats.activeCanvases} canvases · `
            + `${stats.totalCanvasPixels.toLocaleString()} px · `
            + `${stats.queuedRenders} queued · ${stats.activeRenders} rendering · `
            + `${stats.cancelledRenders} cancelled · ${stats.cacheStrategy} cache `
            + `(${stats.desiredPages} pages)`,
            8000
          );
        }
        return true;
      }
    });
    this.addCommand({
      id: "next-page",
      name: "Next page",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BetterScoreView);
        if (!view?.getViewerState()) return false;
        if (!checking) view.navigateNext();
        return true;
      }
    });
    this.addCommand({
      id: "previous-page",
      name: "Previous page",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BetterScoreView);
        if (!view?.getViewerState()) return false;
        if (!checking) view.navigatePrevious();
        return true;
      }
    });
    const viewModes: Array<{mode: ViewMode; label: string}> = [
      {mode: "continuous", label: "Continuous view"},
      {mode: "single", label: "Single-page view"},
      {mode: "spread", label: "Two-page spread view"}
    ];
    for (const choice of viewModes) {
      this.addCommand({
        id: `view-${choice.mode}`,
        name: choice.label,
        checkCallback: (checking) => {
          const view = this.app.workspace.getActiveViewOfType(BetterScoreView);
          if (!view?.getViewerState()) return false;
          if (!checking) view.setViewMode(choice.mode);
          return true;
        }
      });
    }
    this.addCommand({
      id: "toggle-spread-pairing",
      name: "Toggle spread page pairing",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BetterScoreView);
        if (!view) return false;
        const state = view.getViewerState();
        if (!state) return false;
        if (!checking) view.setSpreadOffset(state.spreadOffset === 0 ? 1 : 0);
        return true;
      }
    });
    this.addCommand({
      id: "toggle-finger-drawing",
      name: "Toggle finger drawing",
      checkCallback: (checking) => {
        const view = this.app.workspace.getActiveViewOfType(BetterScoreView);
        if (!view) return false;
        if (!checking) view.toggleFingerDrawing();
        return true;
      }
    });
    this.addRibbonIcon("music-2", "Open BetterScore score switcher", () => {
      this.openScoreSwitcher();
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

  private openScoreSwitcher(): void {
    const hasPdfs = this.app.vault.getFiles().some((file) => isPdf(file));
    if (!hasPdfs) {
      new Notice("BetterScore: No PDF files found in this vault.");
      return;
    }
    new ScoreSwitcherModal(this.app, (file) => {
      void this.openScore(file);
    }).open();
  }

  private async setEraserMode(mode: EraserMode): Promise<void> {
    this.pluginSettings = normalizeSettings({...this.pluginSettings, eraserMode: mode});
    await this.saveData(this.pluginSettings);
  }

  private async setFingerDrawingEnabled(enabled: boolean): Promise<void> {
    this.pluginSettings = normalizeSettings({...this.pluginSettings, fingerDrawingEnabled: enabled});
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
