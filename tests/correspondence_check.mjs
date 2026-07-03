// Correspondence check: every analyzed SiteId must map to exactly one source
// span and one metadata entry (totality), and every *real* (non-synthetic)
// allocation must map to a unique source location (injectivity). Synthetic cell
// sites are reported separately — they exist only under the capture-boxing ABI.
//
// Usage: node correspondence_check.mjs [report.json] [program.json] [sites.json]

import fs from "fs";
const [rep = "cl_report.json", prog = "cl_program.json", sites = "cl_sites.json"] = process.argv.slice(2);
const R = JSON.parse(fs.readFileSync(rep, "utf8"));
const M = JSON.parse(fs.readFileSync(prog, "utf8")).siteMeta || [];
const S = JSON.parse(fs.readFileSync(sites, "utf8"));

const rs = new Set(R.sites.map((x) => x.site));
const ms = new Set(M.map((x) => x.site));
const ss = new Set(S.map((x) => x.site));
const eq = (a, b) => a.size === b.size && [...a].every((x) => b.has(x));

const total = eq(rs, ms) && eq(rs, ss);
const realSpans = S.filter((x) => !x.synthetic).map((x) => `${x.line}:${x.col}-${x.endLine}:${x.endCol}`);
const injective = realSpans.length === new Set(realSpans).size;

console.log(`sites: result=${rs.size} meta=${ms.size} spans=${ss.size}`);
console.log(`totality (same site set everywhere): ${total ? "PASS" : "FAIL"}`);
console.log(`real allocations: ${realSpans.length}, distinct source spans: ${new Set(realSpans).size}`);
console.log(`injectivity (one real site <-> one source span): ${injective ? "PASS" : "FAIL"}`);
console.log(`synthetic cell sites (valid only under capture-boxing ABI): ${S.filter((x) => x.synthetic).length}`);

const ok = total && injective;
console.log(ok ? "\nCORRESPONDENCE: OK" : "\nCORRESPONDENCE: FAIL");
process.exit(ok ? 0 : 1);
