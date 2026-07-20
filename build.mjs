// Bundle @forgeax/agent-host to node-runnable ESM JS (dist/).
//
// Why: forgeax-studio consumes this package as a self-contained npm tarball
// (no forgeax-os monorepo checkout). The cli spawns `@forgeax/agent-host/serve`
// as a sidecar subprocess via import.meta.resolve, so this package must ship a
// plain-node `.js` serve entry (no tsx loader).
//
// Strategy: inline any `@forgeax/*` workspace source; leave every other bare
// specifier external (declared in package.json `dependencies`, installed by the
// consumer). agent-host is a self-contained leaf (zero deps) so nothing is left
// external here beyond node: builtins.
import { build } from 'bun';
import { rmSync } from 'node:fs';

rmSync('./dist', { recursive: true, force: true });

/** Externalize every bare specifier except `@forgeax/*` (bundled from source). */
const externalizeNonForgeax = {
  name: 'externalize-non-forgeax',
  setup(b) {
    b.onResolve({ filter: /.*/ }, (a) => {
      const p = a.path;
      if (p.startsWith('.') || p.startsWith('/')) return; // relative → bundle
      if (p.startsWith('@forgeax/')) return; // workspace → bundle
      return { path: p, external: true }; // third-party + node: → external
    });
  },
};

const res = await build({
  entrypoints: ['./src/index.ts', './src/main.ts', './src/types.ts'],
  outdir: './dist',
  root: './src',
  target: 'node',
  format: 'esm',
  splitting: false,
  sourcemap: 'linked',
  plugins: [externalizeNonForgeax],
});

for (const l of res.logs) console.log(String(l));
if (!res.success) process.exit(1);
console.log('[build] @forgeax/agent-host → dist/ (%d files)', res.outputs.length);
