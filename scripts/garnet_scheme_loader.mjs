// The V8 oracle's view of garnet's modules (docs/published_graphs_design.md):
// `node --import scripts/garnet_scheme_loader.mjs program.mjs` resolves
// `garnet:<name>` to lib/garnet/<name>.ts and transpiles it on the fly.
import { register } from "node:module";
register(new URL("./garnet_scheme_hooks.mjs", import.meta.url));
