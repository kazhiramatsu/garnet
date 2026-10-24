// @scriptc/threads for tsc-ts: garnet's published graphs (docs/published_graphs_design.md).
// `publish` is garnet:shared's deep freeze; a graph a shared worker (a parse thread) publishes
// reaches the main thread by reference, and the checkers, forked after the program is published,
// see it at the same addresses.
export { publish } from 'garnet:shared';
export const sharesPublishedGraphs = true;
