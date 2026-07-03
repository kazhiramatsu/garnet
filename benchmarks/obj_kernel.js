class Vec{ constructor(x,y){this.x=x;this.y=y;} dot(){return this.x*this.x+this.y*this.y;} }
function kernel(N){ let sum=0,i=0; while(i<N){ const v=new Vec(i%100,(i+1)%100); sum=(sum+v.dot())%1000007; i=i+1; } return sum; }
console.log(kernel(50000000));
