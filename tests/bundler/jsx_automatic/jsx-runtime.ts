// The automatic JSX runtime of this fixture (`/** @jsxImportSource . */` in view.tsx names this directory,
// so the elements call `jsx` / `jsxs` of ./jsx-runtime and fragments use its `Fragment`): the calls
// are kept as records and rendered, so the shape TypeScript's transform gives each element (which
// function, the props and their order, the children property, the key) is what the test compares.
export interface Node { fn: string; type: unknown; props: Record<string, unknown>; key: unknown }
export const Fragment = "FRAGMENT";
export function jsx(type: unknown, props: Record<string, unknown>, key?: unknown): Node {
  return { fn: "jsx", type, props, key };
}
export function jsxs(type: unknown, props: Record<string, unknown>, key?: unknown): Node {
  return { fn: "jsxs", type, props, key };
}
export function render(n: unknown): string {
  if (n === null || n === undefined || typeof n === "boolean") return `<${String(n)}>`;
  if (Array.isArray(n)) return "[" + n.map(render).join(",") + "]";
  if (typeof n === "object") {
    const node = n as Node;
    if (typeof node.fn === "string" && "type" in node) {
      const type = typeof node.type === "function" ? "component" : String(node.type);
      const props = Object.keys(node.props).map((k) => `${k}=${render(node.props[k])}`).join(" ");
      return `${node.fn}(${type}${props ? " " + props : ""})${node.key === undefined ? "" : `#${String(node.key)}`}`;
    }
    const o = n as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => `${k}:${render(o[k])}`).join(",") + "}";
  }
  return JSON.stringify(n);
}
export namespace JSX {
  export type Element = Node;
  export interface IntrinsicElements { [name: string]: Record<string, unknown>; }
  export interface ElementChildrenAttribute { children: unknown; }
}
