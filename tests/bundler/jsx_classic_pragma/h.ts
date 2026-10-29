// The classic JSX factory of this fixture, named by the `@jsx` / `@jsxFrag` pragmas (as the jsxFactory /
// jsxFragmentFactory options would): `h(type, props, ...children)` with `null` props when the element
// has no attributes, the children as the arguments (a spread child spreads into them), the fragment
// factory as the type of a fragment.
export interface Node { type: unknown; props: Record<string, unknown> | null; children: unknown[] }
export function h(type: unknown, props: Record<string, unknown> | null, ...children: unknown[]): Node {
  return { type, props, children };
}
export const Frag = "FRAG";
export const lib = { h, Frag };
export function render(n: unknown): string {
  if (n === null || n === undefined || typeof n === "boolean") return `<${String(n)}>`;
  if (Array.isArray(n)) return "[" + n.map(render).join(",") + "]";
  if (typeof n === "object") {
    const node = n as Node;
    if ("children" in node && "type" in node) {
      const type = typeof node.type === "function" ? "component" : String(node.type);
      const props = node.props === null ? "null" : "{" + Object.keys(node.props).map((k) => `${k}=${render(node.props![k])}`).join(" ") + "}";
      return `h(${type} ${props}${node.children.map((c) => " " + render(c)).join("")})`;
    }
    const o = n as Record<string, unknown>;
    return "{" + Object.keys(o).map((k) => `${k}:${render(o[k])}`).join(",") + "}";
  }
  return JSON.stringify(n);
}
declare global {
  namespace JSX {
    interface IntrinsicElements { [name: string]: Record<string, unknown>; }
  }
}
