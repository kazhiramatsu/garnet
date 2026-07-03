class MyRange { private i:number; private n:number;
  constructor(n:number){this.i=0;this.n=n;}
  [Symbol.iterator](): MyRange { return this; }
  next(): {value:number;done:boolean} { if(this.i<this.n){const v=this.i;this.i=this.i+1;return{value:v,done:false};} return {value:0,done:true}; }
  return(): {value:number;done:boolean} { console.log("closed"); return {value:0,done:true}; } }
function find(): number {
  for (const x of new MyRange(10)) { if (x === 3) return x; }   // return -> it.return()
  return -1;
}
function main(): void { console.log(find()); }

main();
