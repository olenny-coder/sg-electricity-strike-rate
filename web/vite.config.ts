import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// The client is served by the Fastify API process in production, so the build
// goes to web/dist and the dev server proxies /api to the same port.
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    port: 5273,
    proxy: {
      "/api": {
        target: "http://127.0.0.1:8791",
        changeOrigin: true,
      },
    },
  },
});
