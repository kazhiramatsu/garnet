export type ReactNode = any;

export interface VNode {
  type: any;
  props: any;
}

declare global {
  namespace JSX {
    interface Element {}
    interface IntrinsicElements {
      [name: string]: any;
    }
  }
}

export function Fragment(props: any): any {
  return props.children;
}

export function createElement(type: any, props: any, ...children: any[]): VNode {
  const p = props === null ? {} : props;
  if (children.length === 1) p.children = children[0];
  else if (children.length > 1) p.children = children;
  return { type, props: p };
}

function escapeHtml(value: any): string {
  return String(value)
    .split("&").join("&amp;")
    .split("<").join("&lt;")
    .split(">").join("&gt;")
    .split("\"").join("&quot;");
}

function renderChildren(value: any): string {
  if (!Array.isArray(value)) return renderNode(value);
  const parts: string[] = [];
  for (let i = 0; i < value.length; i++) parts.push(renderNode(value[i]));
  return parts.join("");
}

function renderAttributes(props: any): string {
  const keys = Object.keys(props);
  const parts: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const sourceName = keys[i];
    if (sourceName === "children" || sourceName === "key" || sourceName === "ref") continue;
    if (sourceName.startsWith("on")) continue;
    const value = props[sourceName];
    if (value === false || value === null || value === undefined) continue;
    const name = sourceName === "className" ? "class" : sourceName;
    if (value === true) parts.push(` ${name}`);
    else parts.push(` ${name}="${escapeHtml(value)}"`);
  }
  return parts.join("");
}

function renderNode(node: any): string {
  if (node === null || node === undefined || node === false || node === true) return "";
  if (Array.isArray(node)) return renderChildren(node);
  if (typeof node === "string" || typeof node === "number") return escapeHtml(node);
  if (typeof node.type === "function") return renderNode(node.type(node.props));
  const tag = String(node.type);
  const attrs = renderAttributes(node.props);
  const body = renderChildren(node.props.children);
  return `<${tag}${attrs}>${body}</${tag}>`;
}

export function renderToString(node: ReactNode): string {
  return renderNode(node);
}
