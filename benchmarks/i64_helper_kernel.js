function adjust(x){if(x<0)return 0;return x+1;}
function divisor(i){if(i<0)return 1;return (i%10)+1;}
function kernel(N){let s=0,i=0;while(i<N){s=(s+adjust(i%1000))%divisor(i);i=i+1;}return s;}
console.log(kernel(50000000));
