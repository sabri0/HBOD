const fs=require('fs');eval(fs.readFileSync('engine_v1.js','utf8')+';globalThis.build=build;globalThis.compute=compute;globalThis.parseCSV=parseCSV;globalThis.addDays=addDays;');
const P=build(parseCSV(fs.readFileSync('parity.csv','utf8')));
const out=[];
for(const p in P){const i=+p.slice(1);for(const k in P[p]){const t=Math.round((Date.parse(k)-Date.parse('2025-07-01'))/864e5);const r=compute(P[p],k);out.push([i,t,r.decision==='DECREASE'?1:0]);}}
fs.writeFileSync('js_dec.json',JSON.stringify(out));console.log(out.length);
