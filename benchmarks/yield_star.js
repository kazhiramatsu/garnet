function* a(){yield 1;yield 2;}
function* b(){yield 0;yield* a();yield 3;}
function* c(){yield* b();yield 4;}
function main(){let out="";for(const x of c())out=out+x+",";console.log(out);}
main();
