import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      strategies: "injectManifest",
      srcDir: "src/pwa",
      filename: "service-worker.ts",
      registerType: "autoUpdate",
      injectRegister: false,
      devOptions: { enabled: true, type: "module" },
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Minions Orchestrator",
        short_name: "Minions",
        description: "Multi-agent coding orchestrator",
        theme_color: "#0b0d12",
        background_color: "#0b0d12",
        display: "standalone",
        start_url: "/",
        icons: [
          { src: "/icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any maskable" }
        ]
      },
      injectManifest: {
        globPatterns: ["**/*.{js,css,html,svg,png,webmanifest}"],
        injectionPoint: "self.__WB_MANIFEST",
      }
    })
  ],
  server: {
    port: 5173,
    host: true
  },
  build: {
    target: "es2022",
    sourcemap: true
  }
});
