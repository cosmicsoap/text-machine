// Mise à jour automatique.
//
// Au lancement, l'application regarde discrètement sur GitHub (page
// « Releases ») s'il existe une version plus récente. Si oui, elle propose de
// l'installer : téléchargement, vérification de la signature, installation,
// puis redémarrage. Hors ligne, ou si GitHub ne répond pas, rien ne s'affiche.
//
// Le menu « Fichier > Rechercher des mises à jour… » fait la même chose à la
// demande, et dit aussi quand l'application est déjà à jour.

import { ask, message } from "@tauri-apps/plugin-dialog";
import { relaunch } from "@tauri-apps/plugin-process";
import { check } from "@tauri-apps/plugin-updater";

const TITLE = "Mise à jour de Text Machine";
let running = false;

export async function checkForUpdates(options: {
  /** Vrai quand l'utilisateur l'a demandé depuis le menu. */
  manual: boolean;
  /** Enregistre le document avant le redémarrage. */
  save: () => Promise<void>;
  /** Affiche l'avancement (barre d'état). */
  status: (text: string) => void;
}) {
  // Pas de mise à jour hors de l'application (navigateur, tests).
  if (!("__TAURI_INTERNALS__" in window) || running) return;
  running = true;
  try {
    const update = await check();
    if (!update) {
      if (options.manual) await message("Text Machine est à jour.", { title: TITLE });
      return;
    }
    const install = await ask(
      `Une nouvelle version de Text Machine est disponible (${update.version}).\n\n` +
        "L'installer maintenant ? Votre document sera enregistré et l'application redémarrera.",
      { title: TITLE, okLabel: "Installer", cancelLabel: "Plus tard" },
    );
    if (!install) return;

    await options.save();
    let total = 0;
    let received = 0;
    await update.downloadAndInstall((event) => {
      if (event.event === "Started") total = event.data.contentLength ?? 0;
      else if (event.event === "Progress") {
        received += event.data.chunkLength;
        const percent = total ? ` ${Math.round((received / total) * 100)} %` : "";
        options.status(`Téléchargement de la mise à jour…${percent}`);
      } else options.status("Installation de la mise à jour…");
    });
    await relaunch();
  } catch (e) {
    // Au lancement, une erreur (pas de connexion…) ne doit pas déranger.
    if (options.manual) {
      await message(`Impossible de vérifier les mises à jour.\n\n${e}`, { title: TITLE, kind: "error" });
    } else console.warn("Mise à jour :", e);
  } finally {
    running = false;
  }
}
