function main(){
  const m=new Map();m.set("a",1);m.set("b",2);m.set("a",10);
  console.log(m.size);console.log(m.get("a"));console.log(m.get("b"));console.log(m.has("c")?1:0);
  console.log(m.delete("b")?1:0);console.log(m.size);console.log([...m.keys()].join(","));
  let total=0;m.set("x",5);m.set("y",7);m.forEach((v,k)=>{total=total+v;});console.log(total);
  const nm=new Map();nm.set(1,100);nm.set(2,200);console.log(nm.get(1)+nm.get(2));
  const s=new Set();s.add(1);s.add(2);s.add(2);s.add(3);console.log(s.size);console.log(s.has(2)?1:0);
  s.delete(2);console.log(s.has(2)?1:0);console.log([...s.values()].join("-"));
  let sum=0;s.forEach(v=>{sum=sum+v;});console.log(sum);
} main();
