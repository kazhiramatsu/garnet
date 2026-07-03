function f(x: number): string {
  try {
    if (x < 0) throw "neg";
    return "ok";        // return through finally
  } catch (e) {
    return "caught";    // return through finally
  } finally {
    console.log("always");
  }
}
function main(): void { console.log(f(5)); console.log(f(-1)); }

main();
