import { createElement, renderToString } from "./react_subset";
import {
  GetServerSideProps,
  GetServerSidePropsContext,
  ServerSideResponse,
  renderPageWithServerSideProps,
} from "./next_ssr";

interface PageRoute {
  pattern: string;
  Page: (props: any) => any;
  getServerSideProps?: GetServerSideProps<any>;
}

interface RouteMatch {
  params: any;
  score: number;
}

interface ParsedUrl {
  pathname: string;
  query: any;
}

function pathSegments(pathname: string): string[] {
  const raw = pathname.split("/");
  const out: string[] = [];
  for (let i = 0; i < raw.length; i++) {
    if (raw[i].length > 0) out.push(raw[i]);
  }
  return out;
}

function parseUrl(url: string): ParsedUrl {
  const question = url.indexOf("?");
  const pathname = question < 0 ? url : url.slice(0, question);
  const query: any = {};
  if (question >= 0) {
    const search = url.slice(question + 1);
    const pairs = search.length === 0 ? [] : search.split("&");
    for (let i = 0; i < pairs.length; i++) {
      const equal = pairs[i].indexOf("=");
      const key = equal < 0 ? pairs[i] : pairs[i].slice(0, equal);
      const value = equal < 0 ? "" : pairs[i].slice(equal + 1);
      query[key] = value;
    }
  }
  return { pathname: pathname.length === 0 ? "/" : pathname, query };
}

function matchRoute(pattern: string, pathname: string): RouteMatch | null {
  const route = pathSegments(pattern);
  const path = pathSegments(pathname);
  const params: any = {};
  let score = 0;
  let pi = 0;
  for (let ri = 0; ri < route.length; ri++) {
    const segment = route[ri];
    if (segment.startsWith("[...") && segment.endsWith("]")) {
      if (ri !== route.length - 1 || pi >= path.length) return null;
      const name = segment.slice(4, segment.length - 1);
      let rest = path[pi++];
      while (pi < path.length) rest += "/" + path[pi++];
      params[name] = rest;
      score += 1;
      return { params, score };
    }
    if (pi >= path.length) return null;
    if (segment.startsWith("[") && segment.endsWith("]")) {
      params[segment.slice(1, segment.length - 1)] = path[pi];
      score += 2;
    } else {
      if (segment !== path[pi]) return null;
      score += 3;
    }
    pi++;
  }
  return pi === path.length ? { params, score } : null;
}

// A compact Pages Router: routes are registered as page modules, static routes
// outrank dynamic routes independently of registration order, and every matched
// page receives the old getServerSideProps request context.
export class PagesRouter {
  private routes: PageRoute[] = [];
  private NotFoundPage: ((props: any) => any) | null = null;

  register(
    pattern: string,
    Page: (props: any) => any,
    getServerSideProps?: GetServerSideProps<any>
  ): PagesRouter {
    this.routes.push({ pattern, Page, getServerSideProps });
    return this;
  }

  setNotFound(Page: (props: any) => any): PagesRouter {
    this.NotFoundPage = Page;
    return this;
  }

  async render(url: string, req?: any, res?: any): Promise<ServerSideResponse<any>> {
    const parsed = parseUrl(url);
    let selected: PageRoute | null = null;
    let selectedMatch: RouteMatch | null = null;
    for (let i = 0; i < this.routes.length; i++) {
      const candidate = matchRoute(this.routes[i].pattern, parsed.pathname);
      if (candidate !== null &&
          (selectedMatch === null || candidate.score > selectedMatch.score)) {
        selected = this.routes[i];
        selectedMatch = candidate;
      }
    }
    if (selected === null || selectedMatch === null) {
      const body = this.NotFoundPage === null
        ? ""
        : renderToString(createElement(this.NotFoundPage, {
            url,
            pathname: parsed.pathname,
          }));
      return { statusCode: 404, headers: {}, body };
    }
    const context: GetServerSidePropsContext = {
      params: selectedMatch.params,
      query: parsed.query,
      resolvedUrl: url,
      req,
      res,
    };
    if (selected.getServerSideProps !== undefined) {
      return await renderPageWithServerSideProps(
        selected.Page,
        selected.getServerSideProps,
        context
      );
    }
    const props = {
      params: context.params,
      query: context.query,
      resolvedUrl: context.resolvedUrl,
    };
    return {
      statusCode: 200,
      headers: { "content-type": "text/html; charset=utf-8" },
      body: renderToString(createElement(selected.Page, props)),
      props,
    };
  }
}
