class MyRange{constructor(n){this.i=0;this.n=n;}[Symbol.iterator](){return this;}next(){if(this.i<this.n){const v=this.i;this.i++;return{value:v,done:false};}return{value:0,done:true};}}
let sum=0;for(const x of new MyRange(5))sum+=x;console.log(sum);
