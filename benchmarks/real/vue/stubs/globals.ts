// The values of vue's build-time flags (garnet-stubs/globals.d.ts): the production browser build of the
// compiler and of reactivity, the configuration vue ships as `vue.global.prod.js`. The driver imports
// this module first, so the assignments run before any vue module's top level reads a flag.
const g = globalThis as unknown as Record<string, boolean | string>;
g.__DEV__ = false;
g.__TEST__ = false;
g.__BROWSER__ = true;
g.__GLOBAL__ = true;
g.__ESM_BUNDLER__ = false;
g.__ESM_BROWSER__ = false;
g.__CJS__ = false;
g.__SSR__ = false;
g.__VERSION__ = "3.5.0";
g.__COMPAT__ = false;
g.__FEATURE_OPTIONS_API__ = true;
g.__FEATURE_PROD_DEVTOOLS__ = false;
g.__FEATURE_SUSPENSE__ = true;
g.__FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__ = false;
export {};
