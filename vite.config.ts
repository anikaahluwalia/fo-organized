import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  root: "web",
  plugins: [react()],
  build: { outDir: "dist", emptyOutDir: true },
  server: {
    port: 5173,
    strictPort: true,
    // Keep the browser's Host and Origin so the API's origin checks still apply in development.
    proxy: { "/api": { target: "http://localhost:8787", changeOrigin: false } },
  },
});
