async function* g() { try {
    yield 1;
    yield 2;
}
finally {
    console.log("ag-cleanup");
} }
async function main() { let o = ""; for await (const x of g())
    o = o + x; console.log(o); }
main();
