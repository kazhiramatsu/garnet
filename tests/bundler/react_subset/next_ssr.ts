import { createElement, renderToString } from "./react_subset";

export interface GetServerSidePropsContext {
  params: any;
  query: any;
  resolvedUrl: string;
  req?: any;
  res?: any;
}

export interface Redirect {
  destination: string;
  permanent?: boolean;
  statusCode?: number;
}

export type GetServerSidePropsResult<Props> =
  | { props: Props }
  | { notFound: true }
  | { redirect: Redirect };

export type GetServerSideProps<Props> = (
  context: GetServerSidePropsContext
) => GetServerSidePropsResult<Props> | Promise<GetServerSidePropsResult<Props>>;

export interface ServerSideResponse<Props> {
  statusCode: number;
  headers: any;
  body: string;
  props?: Props;
}

// A small, old-style Next.js SSR boundary. The loader runs exactly once per
// request before the page component. Both synchronous and Promise-returning
// loaders are accepted because await adopts non-Promise values.
export async function renderPageWithServerSideProps<Props>(
  Page: (props: Props) => any,
  getServerSideProps: GetServerSideProps<Props>,
  context: GetServerSidePropsContext
): Promise<ServerSideResponse<Props>> {
  const result: any = await getServerSideProps(context);
  if (result === null || typeof result !== "object") {
    throw new TypeError("getServerSideProps must return an object");
  }
  if (result.notFound === true) {
    return { statusCode: 404, headers: {}, body: "" };
  }
  if (result.redirect !== undefined) {
    const redirect = result.redirect;
    if (redirect === null || typeof redirect.destination !== "string") {
      throw new TypeError("getServerSideProps redirect requires a destination");
    }
    const statusCode = redirect.statusCode !== undefined
      ? redirect.statusCode
      : (redirect.permanent === true ? 308 : 307);
    return {
      statusCode,
      headers: { location: redirect.destination },
      body: "",
    };
  }
  if (!("props" in result)) {
    throw new TypeError("getServerSideProps must return props, notFound, or redirect");
  }
  const props: Props = result.props;
  const body = renderToString(createElement(Page, props));
  return {
    statusCode: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
    body,
    props,
  };
}
