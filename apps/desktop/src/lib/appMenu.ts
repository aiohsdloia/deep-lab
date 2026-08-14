import { Menu, MenuItem, type Submenu } from "@tauri-apps/api/menu";
import { exportSettings, importSettings, isTauri } from "./tauri";
import { toast } from "./toast";
import i18n from "@/i18n";

let installed = false;

/** Add File → Export Settings / Import Settings to the native menu bar. Only
 *  meaningful in the main window — detached screen windows keep the stock menu
 *  (each holds a single screen and has no settings of its own to move). */
export async function installAppMenu(): Promise<void> {
  if (!isTauri || installed) return;
  installed = true;
  try {
    const menu = await Menu.default();
    const items = await menu.items();
    let file: Submenu | undefined;
    for (const item of items) {
      if (item.kind === "Submenu" && (await item.text()) === "File") {
        file = item as Submenu;
        break;
      }
    }
    if (!file) return;
    await file.append([
      await MenuItem.new({
        id: "settings-export",
        text: "Export Settings…",
        action: () => void runExport(),
      }),
      await MenuItem.new({
        id: "settings-import",
        text: "Import Settings…",
        action: () => void runImport(),
      }),
    ]);
    await menu.setAsAppMenu();
  } catch {
    /* a menu failure must never break app startup */
  }
}

async function runExport(): Promise<void> {
  try {
    const path = await exportSettings();
    if (path) toast.success(i18n.t("menu.exported", { ns: "settings" }));
  } catch {
    toast.error(i18n.t("menu.exportFailed", { ns: "settings" }));
  }
}

async function runImport(): Promise<void> {
  try {
    const summary = await importSettings();
    if (summary === "cancelled") return;
    toast.success(i18n.t("menu.imported", { ns: "settings", summary }));
  } catch {
    toast.error(i18n.t("menu.importFailed", { ns: "settings" }));
  }
}
