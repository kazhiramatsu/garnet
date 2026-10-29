import { Hono } from "./src/hono.ts";
import { jsxRenderer, useRequestContext } from "./src/middleware/jsx-renderer/index.ts";
import { show, section } from "./garnet-survey-_lib.ts";
declare module "./src/context.ts" {
  interface ContextRenderer {
    (content: string | Promise<string>, props: { title: string }): Response | Promise<Response>;
  }
}
const app = new Hono();
app.use("*", jsxRenderer(({ children, title }) => (
  <html><head><title>{title}</title></head><body><main>{children}</main></body></html>
)));
const UrlBadge = () => { const c = useRequestContext(); return <b>{c.req.path}</b>; };
app.get("/page", (c) => c.render(<p>hello <UrlBadge /></p>, { title: "Page" }));
app.get("/nested/*", jsxRenderer(({ children, Layout }) => <Layout title="Nested"><section>{children}</section></Layout>));
app.get("/nested/inner", (c) => c.render(<i>inner</i>, { title: "unused" }));
app.get("/doc", jsxRenderer(({ children }) => <>{children}</>, { docType: true }), (c) => c.render(<div>doc</div>, { title: "x" }));
async function main(): Promise<void> {
  section("jsx-renderer");
  await show(app, "GET", "/page");
  await show(app, "GET", "/nested/inner");
  await show(app, "GET", "/doc");
}
main();
