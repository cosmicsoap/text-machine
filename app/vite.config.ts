import { defineConfig } from "vite";

// Réglages recommandés par Tauri : port fixe, et pas d'effacement de la
// console pour garder visibles les messages de Rust.
export default defineConfig({
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ["**/src-tauri/**"] },
  },
});
