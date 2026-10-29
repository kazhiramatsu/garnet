# JSX, React subset, and Pages Router SSR

This document describes the intentionally small JSX and server-rendering stack
used to exercise Garnet's AOT path. It is a compatibility subset and not an
implementation of React or Next.js as a whole.

## 1. Scope

The stack has four layers:

1. the exporter accepts preserved JSX/TSX and lowers it directly;
2. AOT string construction removes avoidable intermediate work;
3. a TypeScript React subset provides `createElement`, `Fragment`, and
   `renderToString`;
4. a TypeScript Pages Router subset provides route matching and the old
   `getServerSideProps` request boundary.

The executable integration fixture is
`tests/bundler/react_subset/`. The same TypeScript sources run under Node after
classic JSX transformation and under the Garnet-generated native program.

## 2. JSX lowering

The exporter preserves JSX when creating the TypeScript program and lowers the
following syntax itself:

- intrinsic elements such as `<main>` and `<my-element>`;
- component identifiers, including underscore-prefixed identifiers;
- property-access components such as `<UI.Badge>`;
- fragments (`<>...</>`);
- string, boolean, and expression attributes;
- object spread in props;
- text, expression, nested-element, and fragment children;
- JSX comments and the normal JSX whitespace normalization rules;
- numeric character references and every named character reference
  TypeScript's own transform decodes (`exporter/jsx_entities.ts`, generated
  from its table by `scripts/gen_jsx_entities.py`; an unknown name stays as
  written, as TypeScript leaves it);
- namespaced names (`<svg:path xlink:href="#x">`: the tag and the attribute as
  one string) and spread children (`{...xs}`), since Session 358.

Both of TypeScript's transforms are lowered (section 8). The classic one, the
default, calls the factory: `React.createElement` through a namespace import
named `React` of a bundled module (a direct call when that module exports a
function), or the `jsxFactory` / `jsxFragmentFactory` options and the `@jsx` /
`@jsxFrag` pragmas; the automatic runtime (`jsx: react-jsx`, `jsxImportSource`,
the `@jsxImportSource` pragma) calls `jsx` / `jsxs` / `Fragment` of
`<source>/jsx-runtime`, the form hono's JSX uses. Intrinsic names follow
TypeScript's rule: a name whose first character is ASCII lowercase, or which
contains `-`, becomes a string tag; other names remain value expressions.

A factory that is not in scope, a fragment under a `jsxFactory` without a
fragment factory (TypeScript's TS17016), a runtime module that does not export
what the transform calls, and a `key` after a spread attribute under the
automatic runtime are rejected loudly. Nothing is emitted with different
semantics.

## 3. AOT-specific work

### 3.1 Direct factory calls

For a bundled React namespace import, the exporter resolves the exported
`createElement` function at build time. JSX sites therefore emit direct calls
to the AOT function id instead of performing a namespace property lookup and
an indirect call at runtime. Captured module cells are still passed when the
resolved function needs them.

JSX props begin as statically shaped objects. Ordinary attributes use static
field stores, while `{...value}` is lowered through `ObjectCopyProps` in source
order so later attributes retain JavaScript overwrite semantics.

### 3.2 Template strings

A template expression is planned as one ordered concat operation:

- primitive constant substitutions are folded into adjacent static chunks;
- every dynamic substitution is coerced to string immediately after it is
  evaluated, preserving observable evaluation and `ToString` order;
- a multi-part result emits one `string.concatMany` builtin call;
- a completely static result becomes one static string literal;
- a one-part result is returned without a concat call.

This primarily benefits JSX and SSR code that builds markup, attributes, and
route-dependent strings.

### 3.3 Runtime string costs

`ts_add`, `ts_str_concat_many`, and `ts_array_join` derive ASCII/UTF-16 flags
from their inputs instead of rescanning the newly copied result. Content hashes
are now lazy: flat strings retain a cached hash once Map, Set, or another
hash-consuming operation asks for it. The common concat/join case uses a
16-entry stack buffer and falls back to a heap buffer only for larger part
counts.

The runtime subsequently added a hidden extendable flat buffer with immutable
prefix views and an immediate representation for ASCII strings up to five code
units. A controlled `gc_strings` comparison using the same generated C reduced
the lazy-hash baseline from 31 ms and 536.5 MB allocated to 12 ms and 18.0 MB.
Storage remains contiguous; ropes were not added because the post-change
profile no longer justifies their reader and GC complexity. See
`string_builder_short_design.md`.

## 4. TypeScript React subset

`tests/bundler/react_subset/react_subset.ts` implements:

- `createElement(type, props, ...children)`;
- `Fragment`;
- function components;
- intrinsic elements;
- nested arrays and fragments;
- escaped text and attribute values;
- `className` to `class` mapping;
- boolean attributes;
- omission of `children`, `key`, `ref`, and `on*` attributes;
- `renderToString`.

`null`, `undefined`, and boolean children render as empty content. String and
number children are HTML-escaped. Function components are invoked directly and
their result is rendered recursively.

The subset has no hooks, reconciliation, state, context, effects, portals,
client hydration, DOM renderer, event system, streaming, Suspense, or React
Server Components. Its purpose is deterministic server rendering and
end-to-end coverage of Garnet's TSX/AOT path.

## 5. `getServerSideProps`

`tests/bundler/react_subset/next_ssr.ts` provides the old Pages Router boundary:

```ts
renderPageWithServerSideProps(Page, getServerSideProps, context)
```

The loader runs once before rendering and may return synchronously or through a
Promise. The supported results are:

| result | response |
|---|---|
| `{ props }` | status 200, HTML content type, rendered page body |
| `{ notFound: true }` | status 404, empty body |
| `{ redirect: { destination } }` | status 307 by default |
| `{ redirect: { destination, permanent: true } }` | status 308 |
| `{ redirect: { destination, statusCode } }` | explicit status code |

The context carries `params`, `query`, `resolvedUrl`, and optional `req` and
`res` values. Malformed results and redirects throw a `TypeError`.

This is a rendering boundary, not a Node HTTP server. Garnet does not synthesize
Next.js request/response objects, cookies, preview/draft mode, locale fields, or
Next-specific serialization checks.

## 6. Pages Router subset

`tests/bundler/react_subset/pages_router.ts` provides a registration-based
router:

```ts
const router = new PagesRouter()
  .register("/users/[id]", UserPage, getUserPageProps)
  .register("/users/new", NewUserPage)
  .register("/docs/[...slug]", DocsPage, getDocsPageProps)
  .setNotFound(NotFoundPage);

const response = await router.render("/users/42?tab=posts", req, res);
```

Supported route forms are:

- `/` and other static routes;
- one-segment parameters such as `[id]`;
- terminal, non-empty catch-all parameters such as `[...slug]`;
- query extraction;
- a custom 404 page;
- pages with or without `getServerSideProps`.

Static segments score above dynamic segments, so `/users/new` wins over
`/users/[id]` regardless of registration order. A matched page without a loader
receives `params`, `query`, and `resolvedUrl` as props. A page with a loader
uses the `getServerSideProps` result handling described above.

The router does not perform filesystem discovery. It also omits optional
catch-all routes, percent decoding, repeated-query arrays, trailing-slash/base
path/locale policy, API routes, middleware, rewrites, redirects configured
outside a page, layouts, `_app`, `_document`, error pages, data routes, and
client-side navigation. Query assignment currently keeps the last repeated
key.

## 7. Verification

The implementation is covered by:

- `tests/string_concat_aot_gate.sh`, which inspects constant folding and the
  single-concat plan;
- `tests/jsx_aot_gate.sh`, which inspects direct factory calls, static prop
  shapes, and concat plans;
- `tests/conformance/exhaustive/strings/template_concat_aot.ts`, including
  observable coercion order and lazy-hash Map identity;
- the typed and untyped `react_subset` bundler fixture, including JSX, SSR,
  redirects, 404s, static/dynamic/catch-all routing, and route precedence.

The final validation passed typed and untyped conformance (349/349 each),
bundler tests (40/40), runtime and analyzer unit tests, O2 and ASan GC stress,
frozen-emitter parity with no unexpected differences, self-conformance with no
unexpected differences, all 101 benchmark budgets, and the fast CI gate.

## 8. The automatic runtime and the factory options (Session 358)

hono's JSX (`hono/jsx`, `jsxImportSource: hono/jsx` in a project, the
`/** @jsxImportSource */` pragma in a file) is the automatic runtime of
TypeScript 4.1: no `React` in scope, the elements call `jsx` and `jsxs` of
`<source>/jsx-runtime`, fragments are `Fragment` of it. The exporter lowers
the preserved JSX nodes to exactly what TypeScript's transform emits, so the
V8 oracle (the transform, then Node) and garnet agree by construction.

**The program.** Under `jsx: react-jsx` TypeScript adds a synthetic import of
`<source>/jsx-runtime` to every JSX file (resolved, type-checked against the
runtime's exported `JSX` namespace, part of the program), and a `.tsx` file
with a JSX tag is a module. The exporter keeps a project's `react-jsx` (or
`react-jsxdev`: the production runtime is built either way, there are no
source positions to pass) instead of forcing `preserve`, and a program whose
files ask for the automatic runtime by pragma (`@jsxImportSource`,
`@jsxRuntime automatic`) is re-created under `react-jsx`
(`programWithJsxRuntime`; a classic program stays under `preserve`, where a
file-local `declare namespace JSX` still works). The runtime module is the
file's synthetic import resolved (`jsxRuntimeModuleOf`), and `moduleDeps`
adds it to every file with a JSX element so the module order evaluates it
first. `jsxImportSource` is a module specifier resolved from each JSX file, as
TypeScript resolves it (`./src/jsx` names the directory next to the file; the
hono_app driver's tsconfig does this).

**The lowering** (`jsxSiteCallees`, `lowerJsxElement`, `lowerJsxFragment`,
`lowerJsxProps`, `lowerJsxChildren`):

- `<a x="1">c</a>` is `jsx("a", { x: "1", children: "c" })`; with several
  children, or one spread child, `jsxs("a", { x: "1", children: [..] })`
  (TypeScript's `isStaticChildren`); without children the props carry no
  `children`; a fragment is `jsx(Fragment, {..})`. Whitespace-only text and
  empty `{}` are not children (`getSemanticJsxChildren`).
- The props object: the attributes in order (`{...p}` copies), `key` left out,
  then `children` last; the key is the third argument, so it is evaluated after
  the props and the children, as the transform's call does; a `key` after a
  spread (`<A {...p} key="k">`) is where TypeScript calls `createElement` of
  the import source instead, not modelled, a loud reject.
- The runtime functions resolve once per site to the bundled function behind
  the export (an alias chain unwrapped: hono's `export { jsxDEV as jsx }`), a
  direct call when it does not use `this`, else the binding's value; `Fragment`
  is the binding's value (hono's is an arrow). The free-variable scan treats a
  JSX site as the call and the reads it stands for (`noteRef`), so the cells
  the runtime's functions thread are supplied although the source never names
  them: hono's `Fragment` read inside a conditional was undefined before this.
- The classic transform generalized: `jsxFactory` / `@jsx` (`h`, `ns.h`:
  a name in scope resolved at the site, so a parameter shadows the module's
  `h`, or a namespace import's member) and `jsxFragmentFactory` / `@jsxFrag`;
  `React.createElement` / `React.Fragment` stay the defaults. An element
  without attributes passes `null` props, as TypeScript emits (the React
  subset's `createElement` sees `null` where it saw `{}`: the plan gate's
  prop-site count counts the elements with attributes).
- Namespaced names are one string, a spread child is an `ArrayPushAll` into
  the children array (automatic) or a spread argument of the factory call
  (classic, a `CallSpread`), the entity table is TypeScript's.

**A typed call on a lie.** hono's `resolveCallback` does
`(str as string).toString()` on a JSX node: the exporter lowers a `.toString()`
/ `.valueOf()` on a `string`-typed receiver to the string builtin, which threw
"requires a string receiver". The builtin (`ts_str_tostring_typed`,
`ts_str_valueof_typed`) now takes a receiver that is an object through its own
method, the dynamic call V8 makes (a String wrapper's, a JSX node's, a plain
object's `Object.prototype` one); null and undefined keep the TypeError.
`String.prototype.toString.call(obj)` keeps its strict builtin.

**The oracle.** `scripts/lib/mf.sh` and the exporter's `--transpile-batch`
transpile a `.tsx` under its own name and pick the transform the file asks for
(the automatic runtime with `@jsxImportSource` / `@jsxRuntime automatic`, the
classic one otherwise); `benchmarks/real/transpile_tree.js` takes the
project's options. `./garnet` accepts a `.tsx` entry.

**Verified.** `tests/bundler/jsx_automatic` (a runtime that records the calls:
jsx against jsxs, the children forms, the key and its evaluation order,
fragments, spreads, namespaced names, the entities, the whitespace rules, a
reassigned child), `tests/bundler/jsx_classic_pragma` (`@jsx h` / `@jsxFrag`,
a namespace member factory, a parameter shadowing the factory, `null` props,
spread children), the React subset (unchanged), `strings/typed_tostring_object`,
and `benchmarks/real/hono_app`'s page rendered by hono's own runtime through
`c.html` (output identical to Node's).
