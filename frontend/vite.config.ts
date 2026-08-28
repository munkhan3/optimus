import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    // The API is served from the same origin in production; in dev we proxy so
    // the bearer token and relative fetch paths behave identically either way.
    proxy: {
      "/api": { target: "http://localhost:8077", changeOrigin: true },
    },
  },
});
