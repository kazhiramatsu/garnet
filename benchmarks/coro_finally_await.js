async function bad(){throw "oops";}
async function cleanup(){return 7;}
async function inner(){try{const r=await bad();console.log("unreachable "+r);}finally{const c=await cleanup();console.log("cleanup ran: "+c);}}
async function main(){try{await inner();}catch(e){console.log("outer caught: "+e);}console.log("done");}
main();
