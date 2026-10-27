// vue's build-time flags (packages/global.d.ts of the clone): ambient declarations, read from the global
// object at run time; garnet-stubs/globals.ts sets them before any vue module runs.
declare var __DEV__: boolean
declare var __TEST__: boolean
declare var __BROWSER__: boolean
declare var __GLOBAL__: boolean
declare var __ESM_BUNDLER__: boolean
declare var __ESM_BROWSER__: boolean
declare var __CJS__: boolean
declare var __SSR__: boolean
declare var __VERSION__: string
declare var __COMPAT__: boolean
declare var __FEATURE_OPTIONS_API__: boolean
declare var __FEATURE_PROD_DEVTOOLS__: boolean
declare var __FEATURE_SUSPENSE__: boolean
declare var __FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__: boolean
