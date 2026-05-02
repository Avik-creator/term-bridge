import { build } from "esbuild";

build({
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "node",
  target: "node20",
  outfile: "dist/index.js",
  banner: {},
  external: ["node-pty", "node-datachannel"],
  minify: false,
}).catch(() => process.exit(1));
