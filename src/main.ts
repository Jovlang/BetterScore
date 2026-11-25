import {
  App,
  Notice,
  Platform,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  WorkspaceLeaf
} from "obsidian";
import {AnnotationStore} from "./annotation-store";
import {BetterScoreView, VIEW_TYPE_BETTERSCORE} from "./score-view";
import {ScoreSwitcherModal} from "./score-switcher";
import {
  BetterScoreSettings,
  DESKTOP_CACHE_BUDGETS_MB,
  EraserMode,
  normalizeSettings
} from "./settings";
import type {PageCacheOptions} from "./page-surface-manager";
import {rememberReadingPosition, restoreReadingPosition} from "./reading-position";
import {SaveCoordinator} from "./save-coordinator";
import type {ViewerState, ViewMode} from "./viewer-layout";

export default class BetterScorePlugin extends Plugin {
  private pluginSettings: BetterScoreSettings = normalizeSettings(null);
  private readonly dataSaves = new SaveCoordinator(
    () => this.saveData(this.pluginSettings),
    600,
    (error) => this.reportDataSaveError(error)
  );

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
        (enabled) => this.setFingerDrawingEnabled(enabled),
        () => this.pageCacheOptions(),
        {
          restore: (fingerprint, fallback) =>
            restoreReadingPosition(this.pluginSettings.readingPositions, fingerprint, fallback),
          remember: (fingerprint, state) => this.rememberPosition(fingerprint, state),
          flush: () => this.flushPluginData()
        }
      )
    );
    this.addSettingTab(new BetterScoreSettingTab(this.app, this));
    this.registerDomEvent(document, "visibilitychange", () => {
      if (document.visibilityState === "hidden") void this.flushPluginData();
    });

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
            + `${stats.totalCanvasPixels.toLocaleString()} px `
            + `(~${Math.round(stats.estimatedCanvasBytes / (1024 * 1024))} MiB`
            + `${stats.canvasBudgetBytes === null
              ? ""
              : ` / ${Math.round(stats.canvasBudgetBytes / (1024 * 1024))} MiB budget`}) · `
            + `${Math.round(stats.zoom * 100)}% zoom · `
            + `${stats.queuedRenders} queued · ${stats.activeRenders} rendering · `
            + `${stats.cancelledRenders} cancelled · ${stats.cacheStrategy} cache `
            + `(${stats.desiredPages} pages) · ${stats.cachedGeometries} geometries · `
            + `${stats.estimatedSlots} estimated placeholders`,
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
    this.addCommand({
      id: "toggle-thumbnails",
      name: "Toggle thumbnails",
      checkCallback: (checking) => this.withActiveScore(checking, (view) => view.toggleThumbnails())
    });
    this.addCommand({
      id: "zoom-in",
      name: "Zoom in",
      checkCallback: (checking) => this.withActiveScore(checking, (view) => view.zoomIn())
    });
    this.addCommand({
      id: "zoom-out",
      name: "Zoom out",
      checkCallback: (checking) => this.withActiveScore(checking, (view) => view.zoomOut())
    });
    this.addCommand({
      id: "reset-zoom",
      name: "Reset zoom",
      checkCallback: (checking) => this.withActiveScore(checking, (view) => view.resetZoom())
    });
    this.addCommand({
      id: "export-flattened-pdf",
      name: "Export flattened annotated PDF",
      checkCallback: (checking) => this.withActiveScore(
        checking,
        (view) => view.exportFlattenedPdf()
      )
    });
    this.addCommand({
      id: "toggle-high-memory-desktop-cache",
      name: "Toggle high-memory desktop cache",
      checkCallback: (checking) => {
        if (Platform.isMobile) return false;
        if (checking) return true;
        const enabled = !this.pluginSettings.highMemoryDesktopCache;
        void this.setHighMemoryDesktopCache(enabled).then(() => {
          new Notice(`BetterScore high-memory desktop cache: ${enabled ? "on" : "off"}`);
        });
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
    await this.persistSettings();
  }

  private rememberPosition(fingerprint: string, state: ViewerState): void {
    const previous = this.pluginSettings.readingPositions;
    const readingPositions = rememberReadingPosition(previous, fingerprint, state);
    if (readingPositions === previous) return;
    this.pluginSettings = {...this.pluginSettings, readingPositions};
    this.dataSaves.schedule();
  }

  private async persistSettings(): Promise<void> {
    this.dataSaves.schedule();
    await this.flushPluginData();
  }

  private async flushPluginData(): Promise<void> {
    try {
      await this.dataSaves.flush();
    } catch (error) {
      this.reportDataSaveError(error);
    }
  }

  private reportDataSaveError(error: unknown): void {
    new Notice(`BetterScore could not save plugin data: ${messageOf(error)}`);
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
    await this.persistSettings();
  }

  private async setFingerDrawingEnabled(enabled: boolean): Promise<void> {
    this.pluginSettings = normalizeSettings({...this.pluginSettings, fingerDrawingEnabled: enabled});
    await this.persistSettings();
  }

  getSettings(): BetterScoreSettings {
    return this.pluginSettings;
  }

  async setHighMemoryDesktopCache(enabled: boolean): Promise<void> {
    this.pluginSettings = normalizeSettings({
      ...this.pluginSettings,
      highMemoryDesktopCache: enabled
    });
    await this.persistSettings();
    await this.refreshOpenScoreCacheOptions();
  }

  async setDesktopCacheBudgetMb(budget: number): Promise<void> {
    this.pluginSettings = normalizeSettings({
      ...this.pluginSettings,
      desktopCacheBudgetMb: budget
    });
    await this.persistSettings();
    await this.refreshOpenScoreCacheOptions();
  }

  private pageCacheOptions(): PageCacheOptions {
    return {
      retainRenderedPages: !Platform.isMobile && this.pluginSettings.highMemoryDesktopCache,
      maxCanvasBytes: this.pluginSettings.desktopCacheBudgetMb * 1024 * 1024
    };
  }

  private async refreshOpenScoreCacheOptions(): Promise<void> {
    const options = this.pageCacheOptions();
    await Promise.all(this.app.workspace.getLeavesOfType(VIEW_TYPE_BETTERSCORE).map((leaf) => {
      return leaf.view instanceof BetterScoreView
        ? leaf.view.setPageCacheOptions(options)
        : Promise.resolve();
    }));
  }

  private withActiveScore(checking: boolean, action: (view: BetterScoreView) => void): boolean {
    const view = this.app.workspace.getActiveViewOfType(BetterScoreView);
    if (!view) return false;
    if (!checking) action(view);
    return true;
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

class BetterScoreSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: BetterScorePlugin) {
    super(app, plugin);
  }

  display(): void {
    this.containerEl.empty();
    const settings = this.plugin.getSettings();
    new Setting(this.containerEl)
      .setName("High-memory desktop cache")
      .setDesc(
        "Keep rendered score pages in RAM across navigation and background tabs. Recommended only on desktops with ample memory; mobile always uses bounded eviction."
      )
      .addToggle((toggle) => {
        toggle
          .setValue(settings.highMemoryDesktopCache)
          .setDisabled(Platform.isMobile)
          .onChange((enabled) => this.plugin.setHighMemoryDesktopCache(enabled));
      });
    new Setting(this.containerEl)
      .setName("Canvas cache budget per open score tab")
      .setDesc("Maximum estimated canvas memory retained by each open BetterScore tab.")
      .addDropdown((dropdown) => {
        for (const budget of DESKTOP_CACHE_BUDGETS_MB) {
          dropdown.addOption(String(budget), budget >= 1024 ? `${budget / 1024} GiB` : `${budget} MiB`);
        }
        dropdown
          .setValue(String(settings.desktopCacheBudgetMb))
          .setDisabled(Platform.isMobile)
          .onChange((value) => this.plugin.setDesktopCacheBudgetMb(Number(value)));
      });
  }
}

function isPdf(file: unknown): file is TFile {
  return file instanceof TFile && file.extension.toLowerCase() === "pdf";
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
