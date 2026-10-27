# vue's build-time flags as compile-time constants (the production browser build): garnet folds the
# identifiers (TSAOT_DEFINE, docs/real_projects.md) and transpile_tree.js substitutes them for Node, so
# both engines run the code the flags select. garnet-stubs/globals.ts sets the same values on the
# global object for any read the fold does not reach.
export TSAOT_DEFINE='__DEV__=false,__TEST__=false,__BROWSER__=true,__GLOBAL__=true,__ESM_BUNDLER__=false,__ESM_BROWSER__=false,__CJS__=false,__SSR__=false,__COMPAT__=false,__FEATURE_OPTIONS_API__=true,__FEATURE_PROD_DEVTOOLS__=false,__FEATURE_SUSPENSE__=true,__FEATURE_PROD_HYDRATION_MISMATCH_DETAILS__=false,__VERSION__="3.5.0"'
