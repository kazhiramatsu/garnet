async function cleanup(){console.log("cleanup");}
async function f(){try{return 42;}finally{await cleanup();}}
async function main(){const r=await f();console.log(r);}
main();
