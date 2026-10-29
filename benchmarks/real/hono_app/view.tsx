// The JSX part of the hono application benchmark (docs/real_projects.md "hono_app"): hono's own JSX
// runtime (src/jsx, the tsconfig's jsxImportSource, the automatic transform of
// docs/jsx_react_ssr_design.md) renders a page through a layout component with children, a list
// with keys, attributes of each kind, a fragment, a conditional and escaped text; the driver serves
// it with c.html. Copied into the clone as garnet-view.tsx beside garnet-driver.ts.
import type { Child } from "./src/jsx/base.ts";

const Layout = (props: { title: string; children?: Child }) => (
  <html>
    <head><title>{props.title}</title></head>
    <body class="app">{props.children}</body>
  </html>
);

export function renderPage(id: string, items: string[], q: string | null) {
  return (
    <Layout title={`Item ${id}`}>
      <h1 data-id={id}>Item {id}</h1>
      <ul>{items.map((it, i) => <li key={i} class={i % 2 ? "odd" : "even"}>{it}</li>)}</ul>
      <>{q !== null ? <p>query: {q}</p> : <p>no &lt;query&gt; &amp; "quotes"</p>}</>
      <form method="post" action="/form">
        <input type="text" name="n" value={id} disabled={items.length === 0} />
        <button>go</button>
      </form>
    </Layout>
  );
}
