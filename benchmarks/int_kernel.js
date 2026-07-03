function kernel(N){ let sum=0,i=0; while(i<N){ sum=(sum+(i%1000)*((N-i)%1000))%1000007; i=i+1; } return sum; }
console.log(kernel(100000000));
