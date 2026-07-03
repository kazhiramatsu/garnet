function* g() { try {
    yield 1;
    yield 2;
    return;
}
finally {
    console.log("gen-finally");
} }
function main() { for (const x of g())
    console.log(x); }
main();
