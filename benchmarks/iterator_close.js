class MyRange{constructor(n){this.i=0;this.n=n;}[Symbol.iterator](){return this;}next(){if(this.i<this.n){const v=this.i;this.i++;return{value:v,done:false};}return{value:0,done:true};}return(){console.log("closed");return{value:0,done:true};}}
for(const x of new MyRange(10)){console.log(x);if(x===2)break;}
