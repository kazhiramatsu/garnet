function main(): void {
  console.log(typeof x);
  var x = 5;
  console.log(x);
  if (typeof y === "undefined") { console.log("y undefined before decl"); }
  var y = 10;
  console.log(y);
}
main();
