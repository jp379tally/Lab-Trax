// Run from workspace root: node artifacts/labtrax-desktop/scripts/build-tooth-atlas.cjs
// Writes /tmp/w/tooth-atlas-<role>.png; copy to desktop public/, mockup public/tooth-compare/, labtrax/assets/images/.
// LIMITATIONS: ~40px source teeth, 2x upscale; weighted nearest-seed partition (straight cuts, small neighbour slivers on lower front teeth);
// #2-#4 mirror #15-#13; 18 source lower teeth resampled to 16; role colors baked from neutral luminance.
const sharp=require('sharp');
const K=0.5778;
const up={1:[112,520],2:[122,466],3:[135,408],4:[145,355],5:[168,308],6:[193,268],7:[231,237],8:[280,222],9:[342,222],10:[396,236],11:[433,268],12:[459,307],13:[480,353],14:[494,407],15:[508,467],16:[515,521]};
const lowRef=[[116,594],[131,643],[146,690],[163,735],[188,778],[207,813],[239,840],[269,853],[300,855],[331,855],[362,850],[390,835],[417,812],[438,775],[466,740],[485,692],[498,645],[514,594]];
const seeds=[];for(const k in up)seeds.push(up[k].map(v=>v*K));lowRef.forEach(p=>seeds.push(p.map(v=>v*K)));
const src={};for(let i=1;i<=16;i++)src[i]={s:seeds[i-1],flip:false};
const lowIdx=j=>Math.round(j*17/15);
for(let j=0;j<16;j++)src[32-j]={s:seeds[16+lowIdx(j)],flip:false};
src[2]={s:seeds[14],flip:true};src[3]={s:seeds[13],flip:true};src[4]={s:seeds[12],flip:true};
const ROLES={unassigned:null,crown:[124,58,237],pontic:[192,38,122],veneer:[14,143,163],missing:[156,163,175]};
const R=26,C=104,S=2*R;
(async()=>{
const {data,info}=await sharp('attached_assets/image_1791902531434.png').ensureAlpha().raw().toBuffer({resolveWithObject:true});
const W=info.width,H=info.height,N=W*H;
const rgb=new Float32Array(N*3);for(let i=0;i<N;i++){rgb[i*3]=data[i*4];rgb[i*3+1]=data[i*4+1];rgb[i*3+2]=data[i*4+2];}
const lum=i=>(rgb[i*3]+rgb[i*3+1]+rgb[i*3+2])/3;
// 1. mask digits + purple near seeds, inpaint
let m=new Uint8Array(N);
for(const [sx,sy] of seeds){const cx=Math.round(sx),cy=Math.round(sy);
 for(let y=cy-30;y<=cy+30;y++)for(let x=cx-30;x<=cx+30;x++){if(x<0||y<0||x>=W||y>=H)continue;const i=y*W+x,l=lum(i);
  const pur=rgb[i*3]-rgb[i*3+1]>35&&rgb[i*3+2]-rgb[i*3+1]>15;
  const box=Math.abs(x-cx)<=11&&Math.abs(y-cy)<=9&&l<150;
  if(l<100||pur||box)m[i]=1;}}
for(let it=0;it<2;it++){const n=m.slice();for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++)if(m[y*W+x])for(const[a,b]of[[1,0],[-1,0],[0,1],[0,-1],[1,1],[-1,-1],[1,-1],[-1,1]])n[(y+b)*W+x+a]=1;m=n;}
const known=new Uint8Array(N);for(let i=0;i<N;i++)known[i]=m[i]?0:1;
for(let it=0;it<80;it++){const nk=known.slice();for(let y=1;y<H-1;y++)for(let x=1;x<W-1;x++){const i=y*W+x;if(known[i])continue;let n=0,r=0,g=0,b=0;for(const[a,c]of[[1,0],[-1,0],[0,1],[0,-1]]){const j=(y+c)*W+x+a;if(known[j]){n++;r+=rgb[j*3];g+=rgb[j*3+1];b+=rgb[j*3+2];}}if(n){rgb[i*3]=r/n;rgb[i*3+1]=g/n;rgb[i*3+2]=b/n;nk[i]=1;}}known.set(nk);}
// 2. background flood (from far-from-seed pixels)
const dist=new Float32Array(N);for(let i=0;i<N;i++)dist[i]=255-Math.min(rgb[i*3],rgb[i*3+1],rgb[i*3+2]);
const bg=new Uint8Array(N);const q=[];
const near=(x,y)=>seeds.some(([sx,sy])=>Math.hypot(x-sx,y-sy)<10);
for(let y=0;y<H;y+=1)for(let x=0;x<W;x+=1){if((x===0||y===0||x===W-1||y===H-1)){const i=y*W+x;if(dist[i]<22){bg[i]=1;q.push(i);}}}
// also seed bg inside the oval centre
{const i=(Math.round(300*K)*0+ (Math.round(380*K))*W+Math.round(313*K));if(dist[i]<22&&!bg[i]){bg[i]=1;q.push(i);}}
while(q.length){const i=q.pop(),x=i%W,y=(i/W)|0;for(const[a,b]of[[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+a,yy=y+b;if(xx<0||yy<0||xx>=W||yy>=H)continue;const j=yy*W+xx;if(!bg[j]&&dist[j]<22){bg[j]=1;q.push(j);}}}
// 3. weighted Voronoi: nearest seed by distance / tooth-size weight (boundaries land at contacts)
const wt=seeds.map((_,k)=>{if(k<16){const p=k+1;const q2=p<=8?p:17-p;return [1,1,1,.85,.85,.8,.7,.7][q2-1];}const j=k-16;const e=Math.min(j,17-j);return e<4?1:e<6?.85:.7;});
const L=new Int16Array(N).fill(-1);
for(let y=0;y<H;y++)for(let x=0;x<W;x++){let best=1e9,bk=-1;for(let k=0;k<seeds.length;k++){const d=Math.hypot(x-seeds[k][0],y-seeds[k][1])/wt[k];if(d<best){best=d;bk=k;}}if(best<=28)L[y*W+x]=bk;}
const used={};
const sprites={};
for(let id=1;id<=32;id++){
 const k=seeds.indexOf(src[id].s);const cx=Math.round(src[id].s[0]),cy=Math.round(src[id].s[1]);
 const a=new Float32Array(S*S),col=new Float32Array(S*S*3);
 let mask=new Uint8Array(S*S);
 for(let y=0;y<S;y++)for(let x=0;x<S;x++){const sx=cx-R+x,sy=cy-R+y;if(sx<0||sy<0||sx>=W||sy>=H)continue;const i=sy*W+sx;mask[y*S+x]=(L[i]===k&&!bg[i]&&!(rgb[i*3]-rgb[i*3+2]<16&&lum(i)>150))?1:0;col.set([rgb[i*3],rgb[i*3+1],rgb[i*3+2]],(y*S+x)*3);}
 // keep only component containing centre; fill pinholes; 1px smooth
 const comp=new Uint8Array(S*S);const st=[R*S+R];comp[R*S+R]=1;while(st.length){const i=st.pop(),x=i%S,y=(i/S)|0;for(const[u,v]of[[1,0],[-1,0],[0,1],[0,-1]]){const xx=x+u,yy=y+v;if(xx<0||yy<0||xx>=S||yy>=S)continue;const j=yy*S+xx;if(mask[j]&&!comp[j]){comp[j]=1;st.push(j);}}}
 for(let y=1;y<S-1;y++)for(let x=1;x<S-1;x++){const i=y*S+x;if(!comp[i]){let n=0;for(const[u,v]of[[1,0],[-1,0],[0,1],[0,-1]])n+=comp[(y+v)*S+x+u];if(n>=3)comp[i]=1;}}
 for(let y=0;y<S;y++)for(let x=0;x<S;x++){let s=0,c=0;for(let v=-1;v<=1;v++)for(let u=-1;u<=1;u++){const xx=x+u,yy=y+v;if(xx<0||yy<0||xx>=S||yy>=S)continue;s+=comp[yy*S+xx];c++;}a[y*S+x]=comp[y*S+x]?Math.min(1,s/c*1.25):Math.max(0,(s/c-0.45)*1.2)*0.0+ (s/c>0.5?0.4:0);}
 // erode edge colour bleed: pixels with a<1 take colour of interior neighbours (skip, edge is dark outline)
 const buf=Buffer.alloc(S*S*4);const flip=src[id].flip;
 for(let y=0;y<S;y++)for(let x=0;x<S;x++){const i=y*S+x,sx=flip?S-1-x:x,o=(y*S+sx)*4;buf[o]=col[i*3];buf[o+1]=col[i*3+1];buf[o+2]=col[i*3+2];buf[o+3]=Math.round(a[i]*255);}
 // upscale colour and alpha separately-friendly: use premultiplied via sharp on straight RGBA is fine at this size
 sprites[id]=await sharp(buf,{raw:{width:S,height:S,channels:4}}).resize(C,C,{kernel:'lanczos3'}).raw().toBuffer();
}
for(const role of Object.keys(ROLES)){
 const comps=[];
 for(let id=1;id<=32;id++){
  const b=Buffer.from(sprites[id]);
  // median luminance over opaque pixels
  const ls=[];for(let o=0;o<b.length;o+=4)if(b[o+3]>200)ls.push((b[o]*.3+b[o+1]*.59+b[o+2]*.11));ls.sort((x,y)=>x-y);const med=ls[ls.length>>1]||200;
  const base=ROLES[role];
  if(base)for(let o=0;o<b.length;o+=4){const l=b[o]*.3+b[o+1]*.59+b[o+2]*.11;let t=Math.pow(l/med,1.55);let r,g,bl;
   if(role==='missing'){const v=Math.min(255,base[0]*Math.min(t,1.0)+Math.max(0,t-1)*160);r=g=bl=v;r*=1;g*=1.02;bl*=1.06;}
   else{const f=Math.min(t,1.05);r=base[0]*f*1.1+25*f;g=base[1]*f*1.1+25*f;bl=base[2]*f*1.1+25*f;const h=Math.max(0,t-1.05)*1.6;r+=(255-r)*Math.min(h,.7);g+=(255-g)*Math.min(h,.7);bl+=(255-bl)*Math.min(h,.7);}
   b[o]=Math.max(0,Math.min(255,r));b[o+1]=Math.max(0,Math.min(255,g));b[o+2]=Math.max(0,Math.min(255,bl));}
  comps.push({input:await sharp(b,{raw:{width:C,height:C,channels:4}}).png().toBuffer(),left:((id-1)%8)*C,top:Math.floor((id-1)/8)*C});
 }
 await sharp({create:{width:8*C,height:4*C,channels:4,background:{r:0,g:0,b:0,alpha:0}}}).composite(comps).png({compressionLevel:9}).toFile(`/tmp/w/tooth-atlas-${role}.png`);
}
console.log('ok');
})();
