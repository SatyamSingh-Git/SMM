// Production build for the API + worker.
// Bundles src/prod.ts + the @smm/* workspace packages into a single ESM file.
// All other npm packages stay external (loaded from node_modules at runtime)
// so Prisma's native bindings, @fastify/static, etc. still work normally.

import { build } from "esbuild";

await build({
  entryPoints: ["src/prod.ts"],
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node20",
  outfile: "dist/prod.mjs",
  sourcemap: false,
  legalComments: "none",
  // Provide a require() shim so the bundle can load CJS-only npm deps cleanly.
  banner: {
    js:
      "import { createRequire as __mkRequire } from 'node:module';" +
      "const require = __mkRequire(import.meta.url);",
  },
  plugins: [
    {
      // Custom externalize logic: bundle workspace packages (@smm/*) inline,
      // but treat every other npm package as external. Relative imports are
      // bundled as usual.
      name: "smm-externalize-non-workspace",
      setup(b) {
        b.onResolve({ filter: /^[^./]/ }, (args) => {
          if (args.path.startsWith("@smm/")) return null;
          if (args.path.startsWith("node:")) return { path: args.path, external: true };
          return { path: args.path, external: true };
        });
      },
    },
  ],
});

console.log("✓ bundled apps/api/dist/prod.mjs");
