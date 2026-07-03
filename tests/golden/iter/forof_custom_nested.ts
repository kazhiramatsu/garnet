class Seq { private i:number; private n:number;
  constructor(n:number){this.i=0;this.n=n;}
  [Symbol.iterator](): Seq { return this; }
  next(): {value:number;done:boolean} { if(this.i<this.n){const v=this.i;this.i=this.i+1;return{value:v,done:false};} return {value:0,done:true}; } }
function main(): void { let s=0; for (const i of new Seq(3)) for (const j of new Seq(3)) s=s+i*10+j; console.log(s); }

main();
