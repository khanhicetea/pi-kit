import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "src/mcp.ts",
    outDir: "dist",
    emptyOutDir: false,
    minify: false,
    sourcemap: false,
    rollupOptions: {
      output: {
        entryFileNames: "mcp.js",
      },
    },
  },
  ssr: {
    noExternal: true,
  },
});
