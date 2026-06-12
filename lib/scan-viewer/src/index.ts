export type ScanFormat = "stl" | "obj" | "ply";

export type ScanDisplayMode = "solid" | "wireframe" | "shaded";

export const SCAN_DISPLAY_MODES: ScanDisplayMode[] = [
  "solid",
  "wireframe",
  "shaded",
];

export function arrayBufferToBase64(
  source: ArrayBuffer | ArrayBufferView,
): string {
  const bytes =
    source instanceof Uint8Array
      ? source
      : ArrayBuffer.isView(source)
        ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
        : new Uint8Array(source);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode.apply(
      null,
      bytes.subarray(i, i + chunk) as unknown as number[],
    );
  }
  // btoa is available in browser, Electron renderer, and React Native (via JSC/Hermes shim).
  const g = globalThis as unknown as { btoa: (s: string) => string };
  return g.btoa(binary);
}

// ── Shared in-page helpers + STL/OBJ/PLY parsers ──────────────────────────────
// Inlined into the viewer and thumbnail HTML docs so they have no external
// runtime dependency aside from three.js (loaded from CDN). Exposed as a single
// constant so the viewer and thumbnail builders stay in sync.
export const PARSERS_AND_HELPERS_JS = `
function postMsg(o){
  var payload=JSON.stringify(o);
  try{ if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(payload); }catch(_){}
  try{ if(window.parent&&window.parent!==window) window.parent.postMessage(payload,'*'); }catch(_){}
}
function postError(msg){ postMsg({type:'error',message:msg||'parse_failed'}); }

function b64toAB(b64){
  var bin=atob(b64),len=bin.length,buf=new ArrayBuffer(len),view=new Uint8Array(buf);
  for(var i=0;i<len;i++) view[i]=bin.charCodeAt(i);
  return buf;
}

function computeFlatNormals(verts){
  var norms=new Float32Array(verts.length);
  for(var i=0;i<verts.length;i+=9){
    var ax=verts[i],ay=verts[i+1],az=verts[i+2];
    var bx=verts[i+3],by=verts[i+4],bz=verts[i+5];
    var cx=verts[i+6],cy=verts[i+7],cz=verts[i+8];
    var ux=bx-ax,uy=by-ay,uz=bz-az;
    var vx=cx-ax,vy=cy-ay,vz=cz-az;
    var nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx;
    var len=Math.sqrt(nx*nx+ny*ny+nz*nz)||1;
    nx/=len; ny/=len; nz/=len;
    for(var v=0;v<3;v++){
      norms[i+v*3]=nx; norms[i+v*3+1]=ny; norms[i+v*3+2]=nz;
    }
  }
  return norms;
}

// ── STL parser (binary + ASCII) ───────────────────────────────────────────────
function parseSTL(buf){
  var dv=new DataView(buf);
  var triCount=dv.getUint32(80,true);
  var expectedLen=84+triCount*50;
  if(buf.byteLength===expectedLen&&triCount>0) return parseSTLBinary(buf,triCount);
  var text=new TextDecoder().decode(buf);
  if(text.trimStart().startsWith('solid')){
    var geo=parseSTLAscii(text);
    if(geo) return geo;
  }
  if(triCount>0) return parseSTLBinary(buf,triCount);
  return null;
}
function parseSTLBinary(buf,triCount){
  var verts=new Float32Array(triCount*9);
  var norms=new Float32Array(triCount*9);
  var dv=new DataView(buf);
  var off=84;
  for(var i=0;i<triCount;i++){
    var nx=dv.getFloat32(off,true),ny=dv.getFloat32(off+4,true),nz=dv.getFloat32(off+8,true);
    off+=12;
    for(var v=0;v<3;v++){
      var base=i*9+v*3;
      verts[base]=dv.getFloat32(off,true);
      verts[base+1]=dv.getFloat32(off+4,true);
      verts[base+2]=dv.getFloat32(off+8,true);
      norms[base]=nx; norms[base+1]=ny; norms[base+2]=nz;
      off+=12;
    }
    off+=2;
  }
  return {vertices:verts,normals:norms};
}
function parseSTLAscii(text){
  var vertArr=[],normArr=[];
  var lines=text.split(/\\r?\\n/);
  var nx=0,ny=0,nz=0;
  for(var i=0;i<lines.length;i++){
    var line=lines[i].trim();
    if(line.startsWith('facet normal')){
      var parts=line.split(/\\s+/);
      nx=parseFloat(parts[2]); ny=parseFloat(parts[3]); nz=parseFloat(parts[4]);
    } else if(line.startsWith('vertex')){
      var p=line.split(/\\s+/);
      vertArr.push(parseFloat(p[1]),parseFloat(p[2]),parseFloat(p[3]));
      normArr.push(nx,ny,nz);
    }
  }
  if(vertArr.length===0) return null;
  return {vertices:new Float32Array(vertArr),normals:new Float32Array(normArr)};
}

// ── OBJ parser (geometry only) ────────────────────────────────────────────────
function parseOBJ(buf){
  var text=new TextDecoder().decode(buf);
  var lines=text.split(/\\r?\\n/);
  var positions=[];
  var vertArr=[];
  for(var i=0;i<lines.length;i++){
    var line=lines[i].trim();
    if(line.length===0||line.charAt(0)==='#') continue;
    if(line.startsWith('v ')&&!line.startsWith('vt ')&&!line.startsWith('vn ')){
      var parts=line.split(/\\s+/);
      positions.push(parseFloat(parts[1]),parseFloat(parts[2]),parseFloat(parts[3]));
    } else if(line.startsWith('f ')){
      var tokens=line.split(/\\s+/).slice(1);
      var idxs=[];
      for(var t=0;t<tokens.length;t++){
        var raw=parseInt(tokens[t].split('/')[0],10);
        idxs.push(raw>0? raw-1 : positions.length/3+raw);
      }
      for(var j=1;j<idxs.length-1;j++){
        var i0=idxs[0],i1=idxs[j],i2=idxs[j+1];
        vertArr.push(
          positions[i0*3],positions[i0*3+1],positions[i0*3+2],
          positions[i1*3],positions[i1*3+1],positions[i1*3+2],
          positions[i2*3],positions[i2*3+1],positions[i2*3+2]
        );
      }
    }
  }
  if(vertArr.length===0) return null;
  var verts=new Float32Array(vertArr);
  return {vertices:verts,normals:computeFlatNormals(verts)};
}

// ── PLY parser ────────────────────────────────────────────────────────────────
function propByteSize(type){
  switch(type){
    case 'char': case 'uchar': case 'int8': case 'uint8': return 1;
    case 'short': case 'ushort': case 'int16': case 'uint16': return 2;
    case 'int': case 'uint': case 'int32': case 'uint32': case 'float': case 'float32': return 4;
    case 'double': case 'float64': return 8;
    default: return 4;
  }
}
function readPropVal(dv,offset,type,le){
  switch(type){
    case 'float': case 'float32': return dv.getFloat32(offset,le);
    case 'double': case 'float64': return dv.getFloat64(offset,le);
    case 'int': case 'int32': return dv.getInt32(offset,le);
    case 'uint': case 'uint32': return dv.getUint32(offset,le);
    case 'short': case 'int16': return dv.getInt16(offset,le);
    case 'ushort': case 'uint16': return dv.getUint16(offset,le);
    case 'char': case 'int8': return dv.getInt8(offset);
    case 'uchar': case 'uint8': return dv.getUint8(offset);
    default: return dv.getFloat32(offset,le);
  }
}
function readUintBySize(dv,offset,size){
  switch(size){
    case 1: return dv.getUint8(offset);
    case 2: return dv.getUint16(offset,true);
    case 4: return dv.getUint32(offset,true);
    default: return dv.getUint8(offset);
  }
}
function readIntBySize(dv,offset,size,le){
  switch(size){
    case 1: return dv.getInt8(offset);
    case 2: return dv.getInt16(offset,le);
    case 4: return dv.getInt32(offset,le);
    default: return dv.getInt32(offset,le);
  }
}
// Normalize a raw color channel to 0–1. Float/double channels are assumed to
// already be 0–1; integer channels (PLY color is almost always uchar 0–255)
// are divided by 255.
function normColorChannel(val,type){
  if(type==='float'||type==='float32'||type==='double'||type==='float64') return val;
  return val/255;
}
function parsePLY(buf){
  var bytes=new Uint8Array(buf);
  var endMagic=[101,110,100,95,104,101,97,100,101,114];
  var headerEnd=-1;
  for(var i=0;i<bytes.length-10;i++){
    var match=true;
    for(var k=0;k<10;k++){ if(bytes[i+k]!==endMagic[k]){match=false;break;} }
    if(match){
      headerEnd=i;
      while(headerEnd<bytes.length&&bytes[headerEnd]!==10) headerEnd++;
      headerEnd++;
      break;
    }
  }
  if(headerEnd<0) return null;
  var headerText=new TextDecoder().decode(buf.slice(0,headerEnd));
  var headerLines=headerText.split(/\\r?\\n/);
  var format='ascii';
  var vertexCount=0,faceCount=0;
  var vertexProps=[];
  var faceListCountType='uchar';
  var faceListIndexType='int';
  var inVertex=false,inFace=false;
  for(var i=0;i<headerLines.length;i++){
    var hl=headerLines[i].trim();
    if(hl.startsWith('format')){
      if(hl.indexOf('binary_little_endian')>=0) format='binary_le';
      else if(hl.indexOf('binary_big_endian')>=0) format='binary_be';
    } else if(hl.startsWith('element vertex')){
      vertexCount=parseInt(hl.split(/\\s+/)[2],10);
      inVertex=true; inFace=false;
    } else if(hl.startsWith('element face')){
      faceCount=parseInt(hl.split(/\\s+/)[2],10);
      inVertex=false; inFace=true;
    } else if(hl.startsWith('element ')){
      inVertex=false; inFace=false;
    } else if(hl.startsWith('property list')&&inFace){
      var pp=hl.split(/\\s+/);
      faceListCountType=pp[2]||'uchar';
      faceListIndexType=pp[3]||'int';
    } else if(hl.startsWith('property')&&inVertex){
      var pp=hl.split(/\\s+/);
      vertexProps.push({type:pp[1],name:pp[2]});
    }
  }
  if(vertexCount===0) return null;
  var xIdx=vertexProps.findIndex(function(p){return p.name==='x';});
  var yIdx=vertexProps.findIndex(function(p){return p.name==='y';});
  var zIdx=vertexProps.findIndex(function(p){return p.name==='z';});
  if(xIdx<0||yIdx<0||zIdx<0) return null;
  function findColorProp(names){
    for(var n=0;n<names.length;n++){
      for(var p=0;p<vertexProps.length;p++){
        if(vertexProps[p].name===names[n]) return p;
      }
    }
    return -1;
  }
  // iTero color scans store per-vertex color as red/green/blue (sometimes with
  // alpha). Accept the common aliases too. Alpha is detected for completeness
  // but not used by the renderer (gums/teeth are opaque).
  var color={
    r:findColorProp(['red','r','diffuse_red']),
    g:findColorProp(['green','g','diffuse_green']),
    b:findColorProp(['blue','b','diffuse_blue'])
  };
  if(format==='ascii'){
    var fullText=new TextDecoder().decode(buf);
    return parsePLYAscii(fullText,vertexCount,faceCount,xIdx,yIdx,zIdx,vertexProps,color);
  } else {
    var le=format==='binary_le';
    return parsePLYBinary(buf,headerEnd,vertexCount,faceCount,vertexProps,xIdx,yIdx,zIdx,le,faceListCountType,faceListIndexType,color);
  }
}
function parsePLYAscii(fullText,vertexCount,faceCount,xIdx,yIdx,zIdx,vertexProps,color){
  var lines=fullText.split(/\\r?\\n/);
  var dataStart=0;
  for(var i=0;i<lines.length;i++){
    if(lines[i].trim()==='end_header'){dataStart=i+1;break;}
  }
  var hasColor=color&&color.r>=0&&color.g>=0&&color.b>=0;
  var rType=hasColor?vertexProps[color.r].type:null;
  var gType=hasColor?vertexProps[color.g].type:null;
  var bType=hasColor?vertexProps[color.b].type:null;
  var positions=[];
  var colors=hasColor?[]:null;
  for(var i=0;i<vertexCount;i++){
    var lineIdx=dataStart+i;
    if(lineIdx>=lines.length) break;
    var parts=lines[lineIdx].trim().split(/\\s+/);
    positions.push(parseFloat(parts[xIdx]),parseFloat(parts[yIdx]),parseFloat(parts[zIdx]));
    if(hasColor){
      colors.push(
        normColorChannel(parseFloat(parts[color.r]),rType),
        normColorChannel(parseFloat(parts[color.g]),gType),
        normColorChannel(parseFloat(parts[color.b]),bType)
      );
    }
  }
  var vertArr=[];
  var colArr=hasColor?[]:null;
  var faceStart=dataStart+vertexCount;
  for(var i=0;i<faceCount;i++){
    var lineIdx=faceStart+i;
    if(lineIdx>=lines.length) break;
    var line=lines[lineIdx].trim();
    if(line.length===0) continue;
    var parts=line.split(/\\s+/);
    var count=parseInt(parts[0],10);
    if(isNaN(count)||count<3) continue;
    var idxs=[];
    for(var k=1;k<=count&&k<parts.length;k++) idxs.push(parseInt(parts[k],10));
    for(var j=1;j<idxs.length-1;j++){
      var i0=idxs[0],i1=idxs[j],i2=idxs[j+1];
      vertArr.push(
        positions[i0*3],positions[i0*3+1],positions[i0*3+2],
        positions[i1*3],positions[i1*3+1],positions[i1*3+2],
        positions[i2*3],positions[i2*3+1],positions[i2*3+2]
      );
      if(hasColor){
        colArr.push(
          colors[i0*3],colors[i0*3+1],colors[i0*3+2],
          colors[i1*3],colors[i1*3+1],colors[i1*3+2],
          colors[i2*3],colors[i2*3+1],colors[i2*3+2]
        );
      }
    }
  }
  if(vertArr.length===0){
    var verts=new Float32Array(positions);
    var res={vertices:verts,normals:computeFlatNormals(verts)};
    if(hasColor) res.colors=new Float32Array(colors);
    return res;
  }
  var verts=new Float32Array(vertArr);
  var res={vertices:verts,normals:computeFlatNormals(verts)};
  if(hasColor) res.colors=new Float32Array(colArr);
  return res;
}
function parsePLYBinary(buf,dataOffset,vertexCount,faceCount,vertexProps,xIdx,yIdx,zIdx,le,faceListCountType,faceListIndexType,color){
  var dv=new DataView(buf);
  var vertexStride=0;
  var propOffsets=[];
  for(var i=0;i<vertexProps.length;i++){
    propOffsets.push(vertexStride);
    vertexStride+=propByteSize(vertexProps[i].type);
  }
  var hasColor=color&&color.r>=0&&color.g>=0&&color.b>=0;
  var positions=[];
  var colors=hasColor?[]:null;
  var off=dataOffset;
  for(var i=0;i<vertexCount;i++){
    positions.push(
      readPropVal(dv,off+propOffsets[xIdx],vertexProps[xIdx].type,le),
      readPropVal(dv,off+propOffsets[yIdx],vertexProps[yIdx].type,le),
      readPropVal(dv,off+propOffsets[zIdx],vertexProps[zIdx].type,le)
    );
    if(hasColor){
      colors.push(
        normColorChannel(readPropVal(dv,off+propOffsets[color.r],vertexProps[color.r].type,le),vertexProps[color.r].type),
        normColorChannel(readPropVal(dv,off+propOffsets[color.g],vertexProps[color.g].type,le),vertexProps[color.g].type),
        normColorChannel(readPropVal(dv,off+propOffsets[color.b],vertexProps[color.b].type,le),vertexProps[color.b].type)
      );
    }
    off+=vertexStride;
  }
  var countSize=propByteSize(faceListCountType);
  var indexSize=propByteSize(faceListIndexType);
  var vertArr=[];
  var colArr=hasColor?[]:null;
  if(faceCount>0){
    for(var i=0;i<faceCount;i++){
      var count=readUintBySize(dv,off,countSize); off+=countSize;
      var idxs=[];
      for(var k=0;k<count;k++){
        idxs.push(readIntBySize(dv,off,indexSize,le)); off+=indexSize;
      }
      for(var j=1;j<idxs.length-1;j++){
        var i0=idxs[0],i1=idxs[j],i2=idxs[j+1];
        vertArr.push(
          positions[i0*3],positions[i0*3+1],positions[i0*3+2],
          positions[i1*3],positions[i1*3+1],positions[i1*3+2],
          positions[i2*3],positions[i2*3+1],positions[i2*3+2]
        );
        if(hasColor){
          colArr.push(
            colors[i0*3],colors[i0*3+1],colors[i0*3+2],
            colors[i1*3],colors[i1*3+1],colors[i1*3+2],
            colors[i2*3],colors[i2*3+1],colors[i2*3+2]
          );
        }
      }
    }
  }
  if(vertArr.length===0){
    var verts=new Float32Array(positions);
    var res={vertices:verts,normals:computeFlatNormals(verts)};
    if(hasColor) res.colors=new Float32Array(colors);
    return res;
  }
  var verts=new Float32Array(vertArr);
  var res={vertices:verts,normals:computeFlatNormals(verts)};
  if(hasColor) res.colors=new Float32Array(colArr);
  return res;
}

function parseScanBuffer(buf,format){
  if(format==='stl') return parseSTL(buf);
  if(format==='obj') return parseOBJ(buf);
  if(format==='ply') return parsePLY(buf);
  return null;
}
`;

/**
 * Build a self-contained HTML document that renders an STL/OBJ/PLY model
 * with three.js. The page exposes two globals that hosts can call:
 *   window.setDisplayMode("solid" | "wireframe" | "shaded")
 *   window.resetView()
 *
 * Touch (1-finger drag = orbit, pinch = zoom) and mouse (drag = orbit,
 * wheel = zoom) controls both work, so the same HTML drives the mobile
 * React Native WebView and the desktop Electron renderer iframe.
 *
 * On parse failure the page posts {type:'error',message:'parse_failed'}
 * to both window.ReactNativeWebView and window.parent (for desktop iframes).
 */
export function buildViewerHtml(
  fileBase64: string,
  format: ScanFormat,
): string {
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#18181b;overflow:hidden}
canvas{display:block;width:100%!important;height:100%!important;touch-action:none}
#overlay{position:fixed;inset:0;display:flex;align-items:center;justify-content:center;color:#a1a1aa;font-family:-apple-system,sans-serif;font-size:15px;pointer-events:none}
#hint{position:fixed;bottom:16px;left:0;right:0;text-align:center;color:rgba(161,161,170,0.7);font-family:-apple-system,sans-serif;font-size:12px;pointer-events:none;transition:opacity 1s}
</style>
</head>
<body>
<div id="overlay">Rendering\u2026</div>
<div id="hint">Drag to rotate \u00b7 Scroll / pinch to zoom</div>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
<script>
(function(){
'use strict';
${PARSERS_AND_HELPERS_JS}

// ── Three.js scene setup ──────────────────────────────────────────────────────
var renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth,window.innerHeight);
document.body.appendChild(renderer.domElement);

var scene=new THREE.Scene();
scene.background=new THREE.Color(0x18181b);

var camera=new THREE.PerspectiveCamera(45,window.innerWidth/window.innerHeight,0.01,10000);

scene.add(new THREE.AmbientLight(0xffffff,0.5));
var dir1=new THREE.DirectionalLight(0xffffff,0.8); dir1.position.set(1,2,3); scene.add(dir1);
var dir2=new THREE.DirectionalLight(0x88aaff,0.4); dir2.position.set(-2,-1,-1); scene.add(dir2);

window.addEventListener('resize',function(){
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
});

var FILE_B64=${JSON.stringify(fileBase64)};
var FILE_FORMAT=${JSON.stringify(format)};
var buf=b64toAB(FILE_B64);
var parsed=null;
try{ parsed=parseScanBuffer(buf,FILE_FORMAT); }catch(e){}

if(!parsed){
  document.getElementById('overlay').textContent='Could not parse scan file.';
  postError('parse_failed');
} else {
  document.getElementById('overlay').style.display='none';

  var geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(parsed.vertices,3));
  geo.setAttribute('normal',new THREE.BufferAttribute(parsed.normals,3));
  var hasColor=!!parsed.colors;
  if(hasColor) geo.setAttribute('color',new THREE.BufferAttribute(parsed.colors,3));

  // When the scan carries per-vertex color (iTero color PLY), paint with the
  // vertex colors on a white base so the colors aren't tinted; otherwise keep
  // the neutral gray material used for STL/OBJ/color-less PLY.
  var solidMat=hasColor
    ? new THREE.MeshPhongMaterial({vertexColors:true,color:0xffffff,specular:0x111111,shininess:20,side:THREE.DoubleSide})
    : new THREE.MeshPhongMaterial({color:0xe2e8f0,specular:0x444444,shininess:40,side:THREE.DoubleSide});
  var wireframeMat=hasColor
    ? new THREE.MeshPhongMaterial({vertexColors:true,color:0xffffff,specular:0x111111,shininess:20,side:THREE.DoubleSide,wireframe:true})
    : new THREE.MeshPhongMaterial({color:0xe2e8f0,specular:0x444444,shininess:40,side:THREE.DoubleSide,wireframe:true});
  var shadedMat=new THREE.MeshNormalMaterial({side:THREE.DoubleSide});

  var mesh=new THREE.Mesh(geo,solidMat);
  scene.add(mesh);

  window.setDisplayMode=function(mode){
    if(mode==='solid') mesh.material=solidMat;
    else if(mode==='wireframe') mesh.material=wireframeMat;
    else if(mode==='shaded') mesh.material=shadedMat;
  };

  geo.computeBoundingBox();
  var box=geo.boundingBox;
  var center=new THREE.Vector3();
  box.getCenter(center);
  mesh.position.sub(center);

  var size=new THREE.Vector3();
  box.getSize(size);
  var maxDim=Math.max(size.x,size.y,size.z)||1;
  var fov=camera.fov*(Math.PI/180);
  var dist=Math.abs(maxDim/Math.sin(fov/2))*0.6;
  camera.near=dist*0.001;
  camera.far=dist*10;
  camera.updateProjectionMatrix();

  var INIT_THETA=0, INIT_PHI=Math.PI/3, INIT_RADIUS=dist;
  var spherical={theta:INIT_THETA,phi:INIT_PHI,radius:INIT_RADIUS};
  var pan={x:0,y:0};
  var INIT_PAN={x:0,y:0};
  var tween=null;

  function updateCamera(){
    var x=spherical.radius*Math.sin(spherical.phi)*Math.sin(spherical.theta);
    var y=spherical.radius*Math.cos(spherical.phi);
    var z=spherical.radius*Math.sin(spherical.phi)*Math.cos(spherical.theta);
    // Apply pan in camera-local axes
    var target=new THREE.Vector3(0,0,0);
    var camPos=new THREE.Vector3(x,y,z);
    var forward=target.clone().sub(camPos).normalize();
    var right=new THREE.Vector3().crossVectors(forward,new THREE.Vector3(0,1,0)).normalize();
    var up=new THREE.Vector3().crossVectors(right,forward).normalize();
    var offset=right.multiplyScalar(pan.x).add(up.multiplyScalar(pan.y));
    camera.position.copy(camPos.add(offset));
    camera.lookAt(target.add(offset));
  }
  updateCamera();

  window.resetView=function(){
    var startTheta=spherical.theta;
    var startPhi=spherical.phi;
    var startRadius=spherical.radius;
    var startPanX=pan.x, startPanY=pan.y;
    var dTheta=INIT_THETA-startTheta;
    while(dTheta>Math.PI) dTheta-=2*Math.PI;
    while(dTheta<-Math.PI) dTheta+=2*Math.PI;
    var startTime=null;
    var DURATION=380;
    function ease(t){return t<0.5?2*t*t:(1-Math.pow(-2*t+2,2)/2);}
    tween={active:true};
    var thisTween=tween;
    function step(ts){
      if(!thisTween.active) return;
      if(startTime===null) startTime=ts;
      var elapsed=ts-startTime;
      var t=Math.min(elapsed/DURATION,1);
      var e=ease(t);
      spherical.theta=startTheta+dTheta*e;
      spherical.phi=startPhi+(INIT_PHI-startPhi)*e;
      spherical.radius=startRadius+(INIT_RADIUS-startRadius)*e;
      pan.x=startPanX+(INIT_PAN.x-startPanX)*e;
      pan.y=startPanY+(INIT_PAN.y-startPanY)*e;
      updateCamera();
      if(t<1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  };

  var canvas=renderer.domElement;

  // ── Touch controls (1-finger orbit, 2-finger pinch) ──────────────────────
  var touch={startX:0,startY:0,lastTheta:0,lastPhi:Math.PI/3,pinchStart:0,pinchRadius:0};
  var touchDragging=false;
  canvas.addEventListener('touchstart',function(e){
    e.preventDefault();
    tween=null;
    if(e.touches.length===1){
      touchDragging=true;
      touch.startX=e.touches[0].clientX;
      touch.startY=e.touches[0].clientY;
      touch.lastTheta=spherical.theta;
      touch.lastPhi=spherical.phi;
    } else if(e.touches.length===2){
      touchDragging=false;
      var dx=e.touches[0].clientX-e.touches[1].clientX;
      var dy=e.touches[0].clientY-e.touches[1].clientY;
      touch.pinchStart=Math.sqrt(dx*dx+dy*dy);
      touch.pinchRadius=spherical.radius;
    }
  },{passive:false});
  canvas.addEventListener('touchmove',function(e){
    e.preventDefault();
    if(e.touches.length===1&&touchDragging){
      var dx=e.touches[0].clientX-touch.startX;
      var dy=e.touches[0].clientY-touch.startY;
      spherical.theta=touch.lastTheta-dx*0.01;
      spherical.phi=Math.max(0.05,Math.min(Math.PI-0.05,touch.lastPhi-dy*0.01));
      updateCamera();
    } else if(e.touches.length===2){
      var dx2=e.touches[0].clientX-e.touches[1].clientX;
      var dy2=e.touches[0].clientY-e.touches[1].clientY;
      var pinchNow=Math.sqrt(dx2*dx2+dy2*dy2);
      var scale=touch.pinchStart/pinchNow;
      spherical.radius=Math.max(maxDim*0.1,Math.min(maxDim*10,touch.pinchRadius*scale));
      updateCamera();
    }
  },{passive:false});
  canvas.addEventListener('touchend',function(){ touchDragging=false; },{passive:false});

  // ── Mouse controls (LMB orbit, RMB/Shift+LMB pan, wheel zoom) ────────────
  var mouseState={dragging:false,panning:false,startX:0,startY:0,lastTheta:0,lastPhi:0,lastPanX:0,lastPanY:0};
  canvas.addEventListener('mousedown',function(e){
    e.preventDefault();
    tween=null;
    mouseState.startX=e.clientX;
    mouseState.startY=e.clientY;
    if(e.button===2||e.shiftKey){
      mouseState.panning=true;
      mouseState.lastPanX=pan.x;
      mouseState.lastPanY=pan.y;
    } else {
      mouseState.dragging=true;
      mouseState.lastTheta=spherical.theta;
      mouseState.lastPhi=spherical.phi;
    }
  });
  window.addEventListener('mousemove',function(e){
    if(mouseState.dragging){
      var dx=e.clientX-mouseState.startX;
      var dy=e.clientY-mouseState.startY;
      spherical.theta=mouseState.lastTheta-dx*0.01;
      spherical.phi=Math.max(0.05,Math.min(Math.PI-0.05,mouseState.lastPhi-dy*0.01));
      updateCamera();
    } else if(mouseState.panning){
      var dx=e.clientX-mouseState.startX;
      var dy=e.clientY-mouseState.startY;
      var panScale=spherical.radius*0.002;
      pan.x=mouseState.lastPanX-dx*panScale;
      pan.y=mouseState.lastPanY+dy*panScale;
      updateCamera();
    }
  });
  window.addEventListener('mouseup',function(){
    mouseState.dragging=false;
    mouseState.panning=false;
  });
  canvas.addEventListener('contextmenu',function(e){ e.preventDefault(); });
  canvas.addEventListener('wheel',function(e){
    e.preventDefault();
    var delta=e.deltaY;
    var factor=delta>0?1.1:0.9;
    spherical.radius=Math.max(maxDim*0.1,Math.min(maxDim*10,spherical.radius*factor));
    updateCamera();
  },{passive:false});

  // ── Host message bridge (parent iframe → setDisplayMode / resetView) ─────
  window.addEventListener('message',function(e){
    var d=e.data;
    if(!d||typeof d!=='object') return;
    if(d.type==='setDisplayMode'&&typeof d.mode==='string') window.setDisplayMode(d.mode);
    else if(d.type==='resetView') window.resetView();
  });

  setTimeout(function(){
    var h=document.getElementById('hint');
    if(h) h.style.opacity='0';
  },3000);

  (function animate(){
    requestAnimationFrame(animate);
    renderer.render(scene,camera);
  })();
}

})();
</script>
</body>
</html>`;
}

export interface ThumbnailOptions {
  /** Output pixel size (square). Default 192. */
  size?: number;
  /** Background color hex (e.g. "#f8fafc"). Default transparent. */
  background?: string;
}

/**
 * Build a self-contained HTML document that parses an STL/OBJ/PLY model,
 * renders a single frame at a fixed size, and posts the resulting PNG data
 * URL back to the host:
 *
 *   { type: "thumb", dataUrl: "data:image/png;base64,..." }
 *
 * On parse or render failure the page posts
 *   { type: "error", message: "parse_failed" }
 *
 * Works in both browser iframes (`window.parent.postMessage`) and React
 * Native WebViews (`window.ReactNativeWebView.postMessage`).
 */
export function buildThumbnailHtml(
  fileBase64: string,
  format: ScanFormat,
  opts: ThumbnailOptions = {},
): string {
  const size = Math.max(32, Math.min(1024, Math.floor(opts.size ?? 192)));
  const bg = opts.background ?? null;
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, user-scalable=no">
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:transparent;overflow:hidden}
canvas{display:block}
</style>
</head>
<body>
<canvas id="c" width="${size}" height="${size}"></canvas>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
<script>
(function(){
'use strict';
${PARSERS_AND_HELPERS_JS}

var SIZE=${size};
var BG=${bg === null ? "null" : JSON.stringify(bg)};
var FILE_B64=${JSON.stringify(fileBase64)};
var FILE_FORMAT=${JSON.stringify(format)};

var parsed=null;
try{
  var buf=b64toAB(FILE_B64);
  parsed=parseScanBuffer(buf,FILE_FORMAT);
}catch(e){}

if(!parsed){ postError('parse_failed'); return; }

try {
  var canvas=document.getElementById('c');
  var renderer=new THREE.WebGLRenderer({canvas:canvas,antialias:true,alpha:BG===null,preserveDrawingBuffer:true});
  renderer.setPixelRatio(1);
  renderer.setSize(SIZE,SIZE,false);

  var scene=new THREE.Scene();
  if(BG!==null) scene.background=new THREE.Color(BG);

  scene.add(new THREE.AmbientLight(0xffffff,0.55));
  var d1=new THREE.DirectionalLight(0xffffff,0.85); d1.position.set(1,2,3); scene.add(d1);
  var d2=new THREE.DirectionalLight(0x88aaff,0.4); d2.position.set(-2,-1,-1); scene.add(d2);

  var geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(parsed.vertices,3));
  geo.setAttribute('normal',new THREE.BufferAttribute(parsed.normals,3));
  var hasColor=!!parsed.colors;
  if(hasColor) geo.setAttribute('color',new THREE.BufferAttribute(parsed.colors,3));
  geo.computeBoundingBox();
  var box=geo.boundingBox;
  var center=new THREE.Vector3(); box.getCenter(center);
  var size3=new THREE.Vector3(); box.getSize(size3);
  var maxDim=Math.max(size3.x,size3.y,size3.z)||1;

  var mat=hasColor
    ? new THREE.MeshPhongMaterial({vertexColors:true,color:0xffffff,specular:0x111111,shininess:20,side:THREE.DoubleSide})
    : new THREE.MeshPhongMaterial({color:0xe2e8f0,specular:0x444444,shininess:40,side:THREE.DoubleSide});
  var mesh=new THREE.Mesh(geo,mat);
  mesh.position.sub(center);
  scene.add(mesh);

  var camera=new THREE.PerspectiveCamera(35,1,maxDim*0.01,maxDim*100);
  var fov=camera.fov*(Math.PI/180);
  var dist=Math.abs(maxDim/Math.sin(fov/2))*0.55;
  // Slight 3/4 angle so jaws read clearly
  var theta=Math.PI*0.18, phi=Math.PI*0.38;
  camera.position.set(
    dist*Math.sin(phi)*Math.sin(theta),
    dist*Math.cos(phi),
    dist*Math.sin(phi)*Math.cos(theta)
  );
  camera.lookAt(0,0,0);

  renderer.render(scene,camera);

  var dataUrl=canvas.toDataURL('image/png');
  postMsg({type:'thumb',dataUrl:dataUrl});

  // Free GPU memory promptly — host already has the PNG.
  try { geo.dispose(); mat.dispose(); renderer.dispose(); } catch(_){}
} catch(e) {
  postError('render_failed');
}

})();
</script>
</body>
</html>`;
}
