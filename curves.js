/* Shared bounded Hermite interpolation; no spline overshoot between points. */
(function(root){
 "use strict";
 const channels=["master","red","green","blue"];
 function identity(){return {master:[[0,0],[1,1]],red:[[0,0],[1,1]],green:[[0,0],[1,1]],blue:[[0,0],[1,1]]};}
 function points(input){
  const p=(Array.isArray(input)?input:[[0,0],[1,1]]).filter(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite)).map(p=>p.map(v=>Math.max(0,Math.min(1,v)))).sort((a,b)=>a[0]-b[0]);
  const out=p.filter((v,i)=>!i||v[0]>p[i-1][0]+1e-6);
  if(out.length<2)return [[0,0],[1,1]];
  if(out[0][0]>0)out.unshift([0,out[0][1]]);
  if(out[out.length-1][0]<1)out.push([1,out[out.length-1][1]]);
  return out;
 }
 function table(input){
  const p=points(input),n=p.length,d=[],h=[],m=[];
  for(let i=0;i<n-1;i++){h[i]=p[i+1][0]-p[i][0];d[i]=(p[i+1][1]-p[i][1])/h[i];}
  m[0]=d[0];m[n-1]=d[n-2];
  for(let i=1;i<n-1;i++){const a=2*h[i]+h[i-1],b=h[i]+2*h[i-1];m[i]=d[i-1]*d[i]<=0?0:(a+b)/(a/d[i-1]+b/d[i]);}
  const out=new Float64Array(4097);let j=0;
  for(let i=0;i<out.length;i++){
   const x=i/4096;while(j<n-2&&x>p[j+1][0])j++;
   const t=(x-p[j][0])/h[j],t2=t*t,t3=t2*t;
   const v=(2*t3-3*t2+1)*p[j][1]+(t3-2*t2+t)*h[j]*m[j]+(-2*t3+3*t2)*p[j+1][1]+(t3-t2)*h[j]*m[j+1];
   out[i]=Math.max(Math.min(p[j][1],p[j+1][1]),Math.min(Math.max(p[j][1],p[j+1][1]),v));
  }return out;
 }
 function sample(t,x){const pos=Math.max(0,Math.min(1,x))*4096,i=Math.floor(pos),f=pos-i;return t[i]*(1-f)+t[Math.min(i+1,4096)]*f;}
 function changed(curves){return channels.some(c=>points(curves?.[c]).some(p=>Math.abs(p[0]-p[1])>1e-9));}
 function apply(source,curves){
  if(!changed(curves))return source;
  const tables=channels.map(c=>table(curves?.[c])),out=new source.constructor(source),scale=source instanceof Uint16Array?65535:255;
  for(let i=0;i<out.length;i+=4)for(let c=0;c<3;c++)out[i+c]=Math.round(sample(tables[c+1],sample(tables[0],source[i+c]/scale))*scale);
  return out;
 }
 root.FilmCurves={identity,points,table,sample,changed,apply};
})(globalThis);
