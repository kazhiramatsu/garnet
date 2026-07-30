import * as React from "./react_subset";
import { renderToString } from "./react_subset";
import {
  GetServerSidePropsContext,
  renderPageWithServerSideProps,
} from "./next_ssr";
import { PagesRouter } from "./pages_router";

function Badge(props: any): any {
  return <strong className="badge">{props.text}</strong>;
}

function _Note(props: any): any {
  return <em>{props.children}</em>;
}

function App(props: any): any {
  const extra = { title: "A&B" };
  const UI = { Badge };
  const items = [
    <li key="a">one</li>,
    <li key="b">{props.count}</li>,
  ];
  return (
    <>
      <main id="root" className={"tone-" + props.tone} data-count={props.count} {...extra}>
        <h1 aria-label="A&amp;B">Hello &amp; {props.name}&#33;</h1>
        {/* Property-access and underscore-prefixed component tags stay values,
            while lowercase and hyphenated tags become intrinsic strings. */}
        {props.show ? <UI.Badge text="<fast>" /> : null}
        <_Note>ready</_Note>
        <ul>{items}</ul>
        <button disabled onClick="ignored">Go</button>
      </main>
    </>
  );
}

export function run(): void {
  console.log(renderToString(<App name="<Garnet>" count={3} tone="red" show />));
  console.log(renderToString(<App name="hidden" count={0} tone="blue" show={false} />));
}

function ServerPage(props: any): any {
  return (
    <article data-url={props.url}>
      <h2>{props.greeting}, {props.name}</h2>
      <p>query={props.query}</p>
    </article>
  );
}

async function getServerSideProps(context: GetServerSidePropsContext): Promise<any> {
  const name = await Promise.resolve(context.params.name);
  return {
    props: {
      greeting: "Hello",
      name,
      query: context.query.q,
      url: context.resolvedUrl,
    }
  };
}

function getMissing(_context: GetServerSidePropsContext): any {
  return { notFound: true };
}

function getTemporaryRedirect(context: GetServerSidePropsContext): any {
  return { redirect: { destination: "/login?from=" + context.resolvedUrl } };
}

function getPermanentRedirect(_context: GetServerSidePropsContext): any {
  return { redirect: { destination: "/new", permanent: true } };
}

function getExplicitRedirect(_context: GetServerSidePropsContext): any {
  return { redirect: { destination: "/found", statusCode: 302 } };
}

function getInvalid(_context: GetServerSidePropsContext): any {
  return {};
}

export async function runServerSideProps(): Promise<void> {
  const context: GetServerSidePropsContext = {
    params: { name: "<SSR>" },
    query: { q: "a&b" },
    resolvedUrl: "/hello?q=a%26b",
  };
  const ok = await renderPageWithServerSideProps(ServerPage, getServerSideProps, context);
  console.log(ok.statusCode, ok.headers["content-type"], ok.body, ok.props!.name);

  const missing = await renderPageWithServerSideProps(ServerPage, getMissing, context);
  console.log(missing.statusCode, missing.body.length);

  const temporary = await renderPageWithServerSideProps(ServerPage, getTemporaryRedirect, context);
  const permanent = await renderPageWithServerSideProps(ServerPage, getPermanentRedirect, context);
  const explicit = await renderPageWithServerSideProps(ServerPage, getExplicitRedirect, context);
  console.log(temporary.statusCode, temporary.headers.location);
  console.log(permanent.statusCode, permanent.headers.location);
  console.log(explicit.statusCode, explicit.headers.location);

  try {
    await renderPageWithServerSideProps(ServerPage, getInvalid, context);
  } catch (error) {
    console.log(error instanceof TypeError);
  }
}

function HomePage(props: any): any {
  return <div className="home">home:{props.query.welcome}</div>;
}

function UserPage(props: any): any {
  return <div className="user">user:{props.id},tab:{props.tab}</div>;
}

function NewUserPage(_props: any): any {
  return <div>new-user</div>;
}

function DocsPage(props: any): any {
  return <div>docs:{props.slug}</div>;
}

function ProductPage(props: any): any {
  return <div>product:{props.id}</div>;
}

function RouterNotFound(props: any): any {
  return <h1>404:{props.pathname}</h1>;
}

function getUserPageProps(context: GetServerSidePropsContext): any {
  return { props: { id: context.params.id, tab: context.query.tab } };
}

async function getDocsPageProps(context: GetServerSidePropsContext): Promise<any> {
  return { props: { slug: await Promise.resolve(context.params.slug) } };
}

function getProductPageProps(context: GetServerSidePropsContext): any {
  if (context.params.id === "0") return { notFound: true };
  return { props: { id: context.params.id } };
}

function getOldPageProps(_context: GetServerSidePropsContext): any {
  return { redirect: { destination: "/new-home", permanent: true } };
}

export async function runPagesRouter(): Promise<void> {
  const router = new PagesRouter()
    // Dynamic is intentionally registered before static: static must still win.
    .register("/users/[id]", UserPage, getUserPageProps)
    .register("/users/new", NewUserPage)
    .register("/", HomePage)
    .register("/docs/[...slug]", DocsPage, getDocsPageProps)
    .register("/products/[id]", ProductPage, getProductPageProps)
    .register("/old", HomePage, getOldPageProps)
    .setNotFound(RouterNotFound);

  const home = await router.render("/?welcome=yes");
  const user = await router.render("/users/42?tab=posts");
  const staticUser = await router.render("/users/new");
  const docs = await router.render("/docs/guides/aot");
  const product = await router.render("/products/9");
  const missingProduct = await router.render("/products/0");
  const redirect = await router.render("/old");
  const missingRoute = await router.render("/missing/path");

  console.log(home.statusCode, home.body);
  console.log(user.statusCode, user.body);
  console.log(staticUser.statusCode, staticUser.body);
  console.log(docs.statusCode, docs.body);
  console.log(product.statusCode, product.body);
  console.log(missingProduct.statusCode, missingProduct.body.length);
  console.log(redirect.statusCode, redirect.headers.location);
  console.log(missingRoute.statusCode, missingRoute.body);
}
