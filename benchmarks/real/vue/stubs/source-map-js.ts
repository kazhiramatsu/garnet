// A stand-in for source-map-js: vue's codegen builds a source map only outside the browser configuration.
export class SourceMapGenerator {
  constructor(_options?: Record<string, unknown>) {
    throw new Error("garnet vue benchmark: source-map-js is not available");
  }
}
