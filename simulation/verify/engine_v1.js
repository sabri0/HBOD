// ---- HBOD engine (JavaScript port of hbd_agent.py, S2). Kept identical. ----
const T={ACWR_LOW:0.80,ACWR_HIGH:1.30,MONO_HIGH:2.0,WZ_DROP:-1.0,WZ_GOOD:0.0,SPIKE:1.5,SLEEP_DEBT:4.5,CONF_HIGH:14,CONF_MOD:7};
const OSTRC={
 q1:{'full participation without health problems':0,'full participation but with health problems':8,'reduced participation':17,'could not participate':25},
 q2:{'no reduction':0,'to a minor extent':8,'to a moderate extent':17,'to a major extent':25},
 q3:{'no effect':0,'to a minor extent':8,'to a moderate extent':17,'to a major extent':25},
 q4:{'no symptoms or pain':0,'mild':8,'moderate':17,'severe':25}};
const pstdev=a=>{if(a.length<1)return 0;const m=a.reduce((x,y)=>x+y,0)/a.length;return Math.sqrt(a.reduce((s,x)=>s+(x-m)*(x-m),0)/a.length);};
const mean=a=>a.reduce((x,y)=>x+y,0)/a.length;
const num=x=>{const v=parseFloat(String(x).replace(',','.'));return isNaN(v)?null:v;};
function parseCSV(text){
 const lines=text.replace(/\r/g,'').split('\n').filter(l=>l.length);
 const H=splitLine(lines[0]);const out=[];
 for(let i=1;i<lines.length;i++){const c=splitLine(lines[i]);const o={};H.forEach((h,j)=>o[h.trim()]=c[j]!==undefined?c[j]:'');out.push(o);}
 return out;
}
function splitLine(l){const r=[];let cur='',q=false;for(const ch of l){if(ch==='"'){q=!q;}else if(ch===','&&!q){r.push(cur);cur='';}else cur+=ch;}r.push(cur);return r;}
function dkey(ts){const s=String(ts).trim();const m=s.match(/(\d{4})-(\d{2})-(\d{2})/);if(!m)return null;return m[1]+'-'+m[2]+'-'+m[3];}
function addDays(key,n){const [y,mo,d]=key.split('-').map(Number);const dt=new Date(Date.UTC(y,mo-1,d));dt.setUTCDate(dt.getUTCDate()+n);return dt.toISOString().slice(0,10);}
function build(rows){
 const P={};
 for(const r of rows){
  const p=(r['Player']||'').trim();const k=dkey(r['Timestamp']);if(!p||!k)continue;
  P[p]=P[p]||{};P[p][k]=P[p][k]||{load:0,well:null,ostrc:null};
  const dur=num(r['Session duration (min)']),rpe=num(r['Session intensity (CR-10)']);
  if(dur!==null&&rpe!==null&&dur>0&&rpe>0)P[p][k].load+=dur*rpe;
  const f=num(r['Fatigue']),s=num(r['Stress']),so=num(r['Muscle soreness']),sl=num(r['Sleep']);
  if([f,s,so,sl].every(v=>v!==null))P[p][k].well=[f|0,s|0,so|0,sl|0];
  const q=['OSTRC Q1','OSTRC Q2','OSTRC Q3','OSTRC Q4'].map(c=>(r[c]||'').trim().toLowerCase());
  if(q.every(v=>v)&&q[0] in OSTRC.q1)P[p][k].ostrc=q;
 }
 return P;
}
function compute(series,t){
 if(!series[t])return null;
 const load=k=>series[k]?series[k].load:0;
 const wsum=(a,b)=>{let s=0;for(let i=a;i<=b;i++)s+=load(addDays(t,i));return s;};
 const weekly=wsum(-6,0),acute=weekly/7,chronic=wsum(-34,-7)/28;
 const acwr=chronic>0?acute/chronic:null;
 const aw=[];for(let i=-6;i<=0;i++)aw.push(load(addDays(t,i)));
 const sd=pstdev(aw),monotony=sd>0?acute/sd:null,strain=monotony!==null?weekly*monotony:null;
 const prior=[];for(let i=-7;i<0;i++){const k=addDays(t,i);if(series[k])prior.push(series[k].load);}
 const pm=prior.length?mean(prior):0,spike=pm>0?load(t)/pm:null;
 const wl={},sl={};for(const k in series){if(series[k].well){const[f,s,so,slp]=series[k].well;wl[k]=mean([8-f,8-s,8-so,8-slp]);sl[k]=slp;}}
 const wtoday=wl[t]!==undefined?wl[t]:null;
 const base=[];for(let i=-28;i<0;i++){const k=addDays(t,i);if(wl[k]!==undefined)base.push(wl[k]);}
 let wz=null;if(wtoday!==null&&base.length>=3){const bsd=pstdev(base);if(bsd>0)wz=(wtoday-mean(base))/bsd;}
 const hooper=series[t].well?series[t].well.reduce((a,b)=>a+b,0):null;
 const sweek=[];for(let i=-6;i<=0;i++){const k=addDays(t,i);if(sl[k]!==undefined)sweek.push(sl[k]);}
 const sleepWeek=sweek.length?mean(sweek):null,sleepDebt=sleepWeek!==null&&sleepWeek>=T.SLEEP_DEBT;
 const weeklyPrev=wsum(-13,-7),wramp=weeklyPrev>0?(weekly-weeklyPrev)/weeklyPrev*100:null;
 const tsb=wsum(-27,0)/28-acute;
 let ea=null,ec=null;const aa=2/8,ac=2/29;for(let i=-41;i<=0;i++){const v=load(addDays(t,i));ea=ea===null?v:aa*v+(1-aa)*ea;ec=ec===null?v:ac*v+(1-ac)*ec;}
 const eacwr=ec&&ec>0?ea/ec:null;
 let s=60;if(wz!==null)s+=12*Math.max(-2,Math.min(2,wz));if(acwr!==null&&acwr>1.3)s-=18*(acwr-1.3);if(acwr!==null&&acwr<0.8)s-=10*(0.8-acwr);if(monotony!==null&&monotony>=2)s-=8;
 const readiness=Math.max(0,Math.min(100,Math.round(s)));
 let logged=0;for(let i=-27;i<=0;i++){if(series[addDays(t,i)])logged++;}
 const conf=logged>=T.CONF_HIGH?'High':(logged>=T.CONF_MOD?'Moderate':'Low');
 let decision='MAINTAIN';
 if((acwr!==null&&acwr>T.ACWR_HIGH)||(wz!==null&&wz<=T.WZ_DROP)||(monotony!==null&&monotony>=T.MONO_HIGH)||(spike!==null&&spike>=T.SPIKE))decision='DECREASE';
 else if(acwr!==null&&acwr<T.ACWR_LOW&&wz!==null&&wz>=T.WZ_GOOD)decision='INCREASE';
 let action='',oslo=null;const q=series[t].ostrc;
 if(q){const s1=OSTRC.q1[q[0]],s2=OSTRC.q2[q[1]],s3=OSTRC.q3[q[2]],s4=OSTRC.q4[q[3]];oslo=s1+s2+s3+s4;
  if(Math.max(s1,s2,s3)>=25){decision='DECREASE';action='STOP';}
  else if(Math.max(s1,s2,s3)>=17){decision='DECREASE';action='REFER';}
  else{decision=decision==='INCREASE'?'MAINTAIN':decision;action='HOLD';}}
 const r2=(v,n=2)=>v===null?'':Number(v.toFixed(n));
 return {decision,action,acwr:r2(acwr),ewma:r2(eacwr),ramp:r2(wramp,1),tsb:r2(tsb,1),monotony:r2(monotony),strain:r2(strain,1),
   weekly:Math.round(weekly),wellness:r2(wtoday),wz:r2(wz),hooper,sleep:series[t].well?series[t].well[3]:'',sleep7:r2(sleepWeek),
   sleepDebt:sleepDebt?'Yes':'No',readiness,oslo:oslo===null?'':oslo,conf};
}
