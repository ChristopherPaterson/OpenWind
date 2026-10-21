import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Development: the API on :8000 (uvicorn) and the data directory on :8099 (python -m http.server -d data),
// standing in for Caddy, which serves /runs and /basemap from the data directory in production.
const api = "http://127.0.0.1:8000";
const files = "http://127.0.0.1:8099";
export default defineConfig({
  plugins: [react()],
  server: { proxy: { "/v1": api, "/runs": files, "/basemap": files } },
  build: {
    // MapLibre and React change far less often than the app, so they get their own long-cached chunk:
    // a deploy then only re-downloads the app's own code.
    chunkSizeWarningLimit: 1300, // the vendor chunk is MapLibre (about 1 MB) and React; 350 kB gzipped
    rolldownOptions: {
      output: {
        codeSplitting: { groups: [{ name: "vendor", test: /node_modules[\\/](maplibre-gl|react|react-dom|scheduler|d3-)/ }] },
      },
    },
  },
});
