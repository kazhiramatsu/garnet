class AsyncSeq { private i:number; private n:number;
  constructor(n:number){this.i=0;this.n=n;}
  [Symbol.asyncIterator](): AsyncSeq { return this; }
  async next(): Promise<{value:number;done:boolean}> { if(this.i<this.n){const v=this.i;this.i=this.i+1;return{value:v,done:false};} return {value:0,done:true}; }
  async return(): Promise<{value:number;done:boolean}> { console.log("aclosed"); return {value:0,done:true}; } }
async function main(): Promise<void> {
  for await (const x of new AsyncSeq(10)) { console.log(x); if (x === 2) break; }
  console.log("end");
}

main();
