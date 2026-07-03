class AsyncSeq{constructor(n){this.i=0;this.n=n;}[Symbol.asyncIterator](){return this;}async next(){if(this.i<this.n){const v=this.i;this.i++;return{value:v,done:false};}return{value:0,done:true};}}
async function main(){let sum=0;for await(const x of new AsyncSeq(5))sum+=x;console.log(sum);}
main();
