class Counter{constructor(m){this.i=0;this.max=m;}[Symbol.iterator](){return this;}next(){if(this.i<this.max){const v=this.i;this.i++;return{value:v,done:false};}return{value:0,done:true};}}
function* wrap(){yield 100;yield* new Counter(3);yield 200;}
let out="";for(const x of wrap())out=out+x+",";console.log(out);
