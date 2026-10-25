// Module hooks for the garnet scheme (loaded by garnet_scheme_loader.mjs).
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const libDir = join(root, "lib", "garnet");
const require = createRequire(import.meta.url);
let ts = null;

export async function resolve(specifier, context, next) {
  if (specifier.startsWith("garnet:")) {
    // the Node implementation of a module when it has one (<name>_node.ts), else the module itself
    const name = specifier.slice("garnet:".length);
    const node = join(libDir, name + "_node.ts");
    const file = existsSync(node) ? node : join(libDir, name + ".ts");
    return { url: pathToFileURL(file).href, format: "module", shortCircuit: true };
  }
  // a relative import between garnet's modules (`./json_core`): the .ts file beside the importer
  if ((specifier.startsWith("./") || specifier.startsWith("../")) && context.parentURL &&
      context.parentURL.startsWith(pathToFileURL(libDir).href) && !specifier.endsWith(".ts")) {
    return { url: new URL(specifier + ".ts", context.parentURL).href, format: "module", shortCircuit: true };
  }
  return next(specifier, context);
}

export async function load(url, context, next) {
  if (url.startsWith(pathToFileURL(libDir).href) && url.endsWith(".ts")) {
    if (!ts) ts = require(join(root, "exporter", "node_modules", "typescript"));
    const src = readFileSync(fileURLToPath(url), "utf8");
    const js = ts.transpileModule(src, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    return { format: "module", source: js, shortCircuit: true };
  }
  return next(url, context);
}
