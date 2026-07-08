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
function readUintBySize(dv,offset,size,le){
  switch(size){
    case 1: return dv.getUint8(offset);
    case 2: return dv.getUint16(offset,le);
    case 4: return dv.getUint32(offset,le);
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
  // facePropList tracks ALL face element properties in declaration order so the
  // binary reader can skip extra scalar / list properties correctly. Without
  // this, per-face attributes (quality, face-color, etc.) shift the byte offset
  // for every subsequent face, turning tooth geometry into garbage indices.
  var facePropList=[];
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
      facePropList.push({k:'list',ct:pp[2]||'uchar',vt:pp[3]||'int',n:pp[4]||'vertex_indices'});
    } else if(hl.startsWith('property list')&&inVertex){
      // skip vertex list props (e.g. texture coords)
    } else if(hl.startsWith('property')&&inFace){
      var pp=hl.split(/\\s+/);
      facePropList.push({k:'scalar',t:pp[1]||'uchar',n:pp[2]||''});
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
  // Pre-computed smooth normals (nx/ny/nz) — present in most iTero color PLY
  // files. Using them produces accurate lighting on curved tooth surfaces.
  var nxIdx=vertexProps.findIndex(function(p){return p.name==='nx';});
  var nyIdx=vertexProps.findIndex(function(p){return p.name==='ny';});
  var nzIdx=vertexProps.findIndex(function(p){return p.name==='nz';});
  function findColorProp(names){
    for(var n=0;n<names.length;n++){
      for(var p=0;p<vertexProps.length;p++){
        if(vertexProps[p].name===names[n]) return p;
      }
    }
    return -1;
  }
  // iTero color scans store per-vertex color as red/green/blue (sometimes with
  // alpha). Accept the common aliases too.
  var color={
    r:findColorProp(['red','r','diffuse_red','ambient_red']),
    g:findColorProp(['green','g','diffuse_green','ambient_green']),
    b:findColorProp(['blue','b','diffuse_blue','ambient_blue'])
  };
  var hasSeparateColor=color.r>=0&&color.g>=0&&color.b>=0;
  // Packed single-property color (MeshLab-style "rgb"/"rgba" stored in one
  // 4-byte value: 0xRRGGBB in the low 24 bits).
  var packedIdx=-1;
  if(!hasSeparateColor){
    packedIdx=vertexProps.findIndex(function(p){return p.name==='rgb'||p.name==='rgba';});
  }
  // Per-face color scalars (red/green/blue on the face element) — used only
  // when there is no per-vertex color.
  function findFaceColorProp(names){
    for(var n=0;n<names.length;n++){
      for(var p=0;p<facePropList.length;p++){
        if(facePropList[p].k==='scalar'&&facePropList[p].n===names[n]) return p;
      }
    }
    return -1;
  }
  var faceColor={
    r:findFaceColorProp(['red','r','diffuse_red']),
    g:findFaceColorProp(['green','g','diffuse_green']),
    b:findFaceColorProp(['blue','b','diffuse_blue'])
  };
  var hasFaceColor=!hasSeparateColor&&packedIdx<0&&faceColor.r>=0&&faceColor.g>=0&&faceColor.b>=0;
  // Detect color-like properties the parser is about to ignore. Rendering gray
  // when the file plainly declares color data should be loud, not silent.
  function colorLike(n){
    return n==='red'||n==='green'||n==='blue'||n==='r'||n==='g'||n==='b'||
      n==='rgb'||n==='rgba'||n==='alpha'||
      n.indexOf('color')>=0||n.indexOf('colour')>=0||
      n.indexOf('_red')>=0||n.indexOf('_green')>=0||n.indexOf('_blue')>=0;
  }
  var colorWarning=null;
  if(!hasSeparateColor&&packedIdx<0&&!hasFaceColor){
    var unusedColorProps=[];
    for(var p=0;p<vertexProps.length;p++){
      if(colorLike(vertexProps[p].name)) unusedColorProps.push('vertex '+vertexProps[p].name);
    }
    for(var p=0;p<facePropList.length;p++){
      if(facePropList[p].k==='scalar'&&colorLike(facePropList[p].n)) unusedColorProps.push('face '+facePropList[p].n);
    }
    if(unusedColorProps.length>0){
      colorWarning='PLY declares color-like properties the viewer did not use: '+unusedColorProps.join(', ')+'. The model may render without its original colors.';
    }
  }
  var copt={
    color:color,
    hasColor:hasSeparateColor,
    packedIdx:packedIdx,
    faceColor:faceColor,
    hasFaceColor:hasFaceColor,
    warning:colorWarning
  };
  // Ensure at least one entry so the binary reader doesn't skip all faces when
  // the header declares a face element without an explicit property line.
  if(facePropList.length===0&&faceCount>0){
    facePropList.push({k:'list',ct:faceListCountType,vt:faceListIndexType,n:'vertex_indices'});
  }
  if(format==='ascii'){
    var fullText=new TextDecoder().decode(buf);
    return parsePLYAscii(fullText,vertexCount,faceCount,xIdx,yIdx,zIdx,vertexProps,copt,nxIdx,nyIdx,nzIdx,facePropList);
  } else {
    var le=format==='binary_le';
    return parsePLYBinary(buf,headerEnd,vertexCount,faceCount,vertexProps,xIdx,yIdx,zIdx,le,facePropList,copt,nxIdx,nyIdx,nzIdx);
  }
}
// Decode a packed 0xRRGGBB value into normalized [r,g,b].
function decodePackedColor(v){
  v=v>>>0;
  return [((v>>16)&255)/255,((v>>8)&255)/255,(v&255)/255];
}
function parsePLYAscii(fullText,vertexCount,faceCount,xIdx,yIdx,zIdx,vertexProps,copt,nxIdx,nyIdx,nzIdx,facePropList){
  var lines=fullText.split(/\\r?\\n/);
  var dataStart=0;
  for(var i=0;i<lines.length;i++){
    if(lines[i].trim()==='end_header'){dataStart=i+1;break;}
  }
  var color=copt.color;
  var hasColor=copt.hasColor;
  var hasPacked=copt.packedIdx>=0;
  var hasVColor=hasColor||hasPacked;
  var hasFaceColor=copt.hasFaceColor;
  var rType=hasColor?vertexProps[color.r].type:null;
  var gType=hasColor?vertexProps[color.g].type:null;
  var bType=hasColor?vertexProps[color.b].type:null;
  var hasVNorm=nxIdx>=0&&nyIdx>=0&&nzIdx>=0;
  var positions=[];
  var colors=hasVColor?[]:null;
  var vnorms=hasVNorm?[]:null;
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
    } else if(hasPacked){
      var packed=decodePackedColor(parseFloat(parts[copt.packedIdx]));
      colors.push(packed[0],packed[1],packed[2]);
    }
    if(hasVNorm){
      vnorms.push(parseFloat(parts[nxIdx]),parseFloat(parts[nyIdx]),parseFloat(parts[nzIdx]));
    }
  }
  var vertArr=[];
  var colArr=(hasVColor||hasFaceColor)?[]:null;
  var normArr=hasVNorm?[]:null;
  var pc=positions.length;
  var faceStart=dataStart+vertexCount;
  for(var i=0;i<faceCount;i++){
    var lineIdx=faceStart+i;
    if(lineIdx>=lines.length) break;
    var line=lines[lineIdx].trim();
    if(line.length===0) continue;
    var parts=line.split(/\\s+/);
    // Walk the face properties in declaration order so extra scalars (e.g.
    // per-face color) after the index list are read from the right columns.
    var pptr=0;
    var idxs=null;
    var fr=0,fg=0,fb=0;
    for(var fp=0;fp<facePropList.length&&pptr<parts.length;fp++){
      var fpp=facePropList[fp];
      if(fpp.k==='list'){
        var count=parseInt(parts[pptr],10); pptr++;
        if(isNaN(count)||count<0) count=0;
        if(fpp.n==='vertex_indices'||fpp.n==='vertex_index'){
          idxs=[];
          for(var k=0;k<count&&pptr<parts.length;k++){ idxs.push(parseInt(parts[pptr],10)); pptr++; }
        } else {
          pptr+=count;
        }
      } else {
        var sval=parseFloat(parts[pptr]); pptr++;
        if(hasFaceColor){
          if(fp===copt.faceColor.r) fr=normColorChannel(sval,fpp.t);
          else if(fp===copt.faceColor.g) fg=normColorChannel(sval,fpp.t);
          else if(fp===copt.faceColor.b) fb=normColorChannel(sval,fpp.t);
        }
      }
    }
    if(!idxs||idxs.length<3) continue;
    for(var j=1;j<idxs.length-1;j++){
      var i0=idxs[0],i1=idxs[j],i2=idxs[j+1];
      if(i0<0||i1<0||i2<0||i0*3+2>=pc||i1*3+2>=pc||i2*3+2>=pc) continue;
      vertArr.push(
        positions[i0*3],positions[i0*3+1],positions[i0*3+2],
        positions[i1*3],positions[i1*3+1],positions[i1*3+2],
        positions[i2*3],positions[i2*3+1],positions[i2*3+2]
      );
      if(hasVColor){
        colArr.push(
          colors[i0*3],colors[i0*3+1],colors[i0*3+2],
          colors[i1*3],colors[i1*3+1],colors[i1*3+2],
          colors[i2*3],colors[i2*3+1],colors[i2*3+2]
        );
      } else if(hasFaceColor){
        colArr.push(fr,fg,fb,fr,fg,fb,fr,fg,fb);
      }
      if(hasVNorm){
        normArr.push(
          vnorms[i0*3],vnorms[i0*3+1],vnorms[i0*3+2],
          vnorms[i1*3],vnorms[i1*3+1],vnorms[i1*3+2],
          vnorms[i2*3],vnorms[i2*3+1],vnorms[i2*3+2]
        );
      }
    }
  }
  if(vertArr.length===0){
    var verts=new Float32Array(positions);
    var norms=hasVNorm?new Float32Array(vnorms):computeFlatNormals(verts);
    var res={vertices:verts,normals:norms};
    if(hasVColor) res.colors=new Float32Array(colors);
    if(copt.warning) res.colorWarning=copt.warning;
    return res;
  }
  var verts=new Float32Array(vertArr);
  var norms=hasVNorm?new Float32Array(normArr):computeFlatNormals(verts);
  var res={vertices:verts,normals:norms};
  if(colArr&&colArr.length===vertArr.length) res.colors=new Float32Array(colArr);
  if(copt.warning) res.colorWarning=copt.warning;
  return res;
}
// parsePLYBinary: facePropList replaces the old flat faceListCountType/faceListIndexType
// pair. Every property in the face element is iterated in declaration order so
// that extra scalar attributes (quality, face-color, etc.) advance the byte
// offset correctly and don't corrupt subsequent face reads.
function parsePLYBinary(buf,dataOffset,vertexCount,faceCount,vertexProps,xIdx,yIdx,zIdx,le,facePropList,copt,nxIdx,nyIdx,nzIdx){
  var dv=new DataView(buf);
  var vertexStride=0;
  var propOffsets=[];
  for(var i=0;i<vertexProps.length;i++){
    propOffsets.push(vertexStride);
    vertexStride+=propByteSize(vertexProps[i].type);
  }
  var color=copt.color;
  var hasColor=copt.hasColor;
  var hasPacked=copt.packedIdx>=0;
  var hasVColor=hasColor||hasPacked;
  var hasFaceColor=copt.hasFaceColor;
  var hasVNorm=nxIdx>=0&&nyIdx>=0&&nzIdx>=0;
  var positions=[];
  var colors=hasVColor?[]:null;
  var vnorms=hasVNorm?[]:null;
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
    } else if(hasPacked){
      // Packed color is bit-level data: read the raw 4 bytes as uint32 even
      // when the header declares the property as float (MeshLab quirk).
      var pOff=off+propOffsets[copt.packedIdx];
      var pSize=propByteSize(vertexProps[copt.packedIdx].type);
      var rawPacked=pSize===4?dv.getUint32(pOff,le):readUintBySize(dv,pOff,pSize,le);
      var packed=decodePackedColor(rawPacked);
      colors.push(packed[0],packed[1],packed[2]);
    }
    if(hasVNorm){
      vnorms.push(
        readPropVal(dv,off+propOffsets[nxIdx],vertexProps[nxIdx].type,le),
        readPropVal(dv,off+propOffsets[nyIdx],vertexProps[nyIdx].type,le),
        readPropVal(dv,off+propOffsets[nzIdx],vertexProps[nzIdx].type,le)
      );
    }
    off+=vertexStride;
  }
  var vertArr=[];
  var colArr=(hasVColor||hasFaceColor)?[]:null;
  var normArr=hasVNorm?[]:null;
  var pc=positions.length;
  if(faceCount>0){
    for(var i=0;i<faceCount;i++){
      // Iterate ALL face properties in declaration order to keep the byte
      // offset correct even when extra attributes follow the index list.
      var faceidxs=null;
      var fr=0,fg=0,fb=0;
      for(var fp=0;fp<facePropList.length;fp++){
        var fpp=facePropList[fp];
        if(fpp.k==='list'){
          var cnt=readUintBySize(dv,off,propByteSize(fpp.ct),le); off+=propByteSize(fpp.ct);
          if(fpp.n==='vertex_indices'||fpp.n==='vertex_index'){
            faceidxs=[];
            for(var k=0;k<cnt;k++){
              faceidxs.push(readIntBySize(dv,off,propByteSize(fpp.vt),le)); off+=propByteSize(fpp.vt);
            }
          } else {
            off+=cnt*propByteSize(fpp.vt);
          }
        } else {
          if(hasFaceColor&&(fp===copt.faceColor.r||fp===copt.faceColor.g||fp===copt.faceColor.b)){
            var sval=normColorChannel(readPropVal(dv,off,fpp.t,le),fpp.t);
            if(fp===copt.faceColor.r) fr=sval;
            else if(fp===copt.faceColor.g) fg=sval;
            else fb=sval;
          }
          off+=propByteSize(fpp.t);
        }
      }
      if(!faceidxs||faceidxs.length<3) continue;
      for(var j=1;j<faceidxs.length-1;j++){
        var i0=faceidxs[0],i1=faceidxs[j],i2=faceidxs[j+1];
        if(i0<0||i1<0||i2<0||i0*3+2>=pc||i1*3+2>=pc||i2*3+2>=pc) continue;
        vertArr.push(
          positions[i0*3],positions[i0*3+1],positions[i0*3+2],
          positions[i1*3],positions[i1*3+1],positions[i1*3+2],
          positions[i2*3],positions[i2*3+1],positions[i2*3+2]
        );
        if(hasVColor){
          colArr.push(
            colors[i0*3],colors[i0*3+1],colors[i0*3+2],
            colors[i1*3],colors[i1*3+1],colors[i1*3+2],
            colors[i2*3],colors[i2*3+1],colors[i2*3+2]
          );
        } else if(hasFaceColor){
          colArr.push(fr,fg,fb,fr,fg,fb,fr,fg,fb);
        }
        if(hasVNorm){
          normArr.push(
            vnorms[i0*3],vnorms[i0*3+1],vnorms[i0*3+2],
            vnorms[i1*3],vnorms[i1*3+1],vnorms[i1*3+2],
            vnorms[i2*3],vnorms[i2*3+1],vnorms[i2*3+2]
          );
        }
      }
    }
  }
  if(vertArr.length===0){
    var verts=new Float32Array(positions);
    var norms=hasVNorm?new Float32Array(vnorms):computeFlatNormals(verts);
    var res={vertices:verts,normals:norms};
    if(hasVColor) res.colors=new Float32Array(colors);
    if(copt.warning) res.colorWarning=copt.warning;
    return res;
  }
  var verts=new Float32Array(vertArr);
  var norms=hasVNorm?new Float32Array(normArr):computeFlatNormals(verts);
  var res={vertices:verts,normals:norms};
  if(colArr&&colArr.length===vertArr.length) res.colors=new Float32Array(colArr);
  if(copt.warning) res.colorWarning=copt.warning;
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
  if(parsed.colorWarning){
    try{ console.warn('[scan-viewer] '+parsed.colorWarning); }catch(_){}
    postMsg({type:'warning',message:parsed.colorWarning});
  }
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

  // Loosened polar clamp: near-full vertical range without hitting the poles
  // (which would flip the camera because the up vector is fixed at +Y).
  var PHI_MIN=0.02, PHI_MAX=Math.PI-0.02;
  var INIT_THETA=0, INIT_PHI=Math.PI/3, INIT_RADIUS=dist;
  var spherical={theta:INIT_THETA,phi:INIT_PHI,radius:INIT_RADIUS};
  // Orbit target: pan moves it, targeted zoom pulls it toward the focal point,
  // reset view tweens it back to the model center (origin — the mesh is
  // recentered on load).
  var target=new THREE.Vector3(0,0,0);
  var INIT_TARGET=new THREE.Vector3(0,0,0);
  var tween=null;

  function updateCamera(){
    camera.position.set(
      target.x+spherical.radius*Math.sin(spherical.phi)*Math.sin(spherical.theta),
      target.y+spherical.radius*Math.cos(spherical.phi),
      target.z+spherical.radius*Math.sin(spherical.phi)*Math.cos(spherical.theta)
    );
    camera.lookAt(target);
  }
  updateCamera();

  // ── Targeted zoom ─────────────────────────────────────────────────────────
  // Zoom moves the camera toward/away from the 3D point under the pointer
  // (raycast into the mesh; view-plane point through the orbit target on a
  // miss) instead of always drifting toward the model center.
  var raycaster=new THREE.Raycaster();
  var lastFocal={x:0,y:0,t:0,point:null};
  function focalAt(clientX,clientY){
    var now=Date.now();
    // Continuous wheel at the same pointer position reuses the last hit so a
    // zoom gesture keeps a stable focal point (and skips per-tick raycasts on
    // large meshes).
    if(lastFocal.point&&Math.abs(clientX-lastFocal.x)<3&&Math.abs(clientY-lastFocal.y)<3&&now-lastFocal.t<400){
      lastFocal.t=now;
      return lastFocal.point;
    }
    var ndc=new THREE.Vector2(
      (clientX/window.innerWidth)*2-1,
      -(clientY/window.innerHeight)*2+1
    );
    raycaster.setFromCamera(ndc,camera);
    var pt=null;
    var hits=raycaster.intersectObject(mesh,false);
    if(hits.length>0){
      pt=hits[0].point.clone();
    } else {
      // Fallback: point under the cursor on the view plane through the target.
      var fwd=new THREE.Vector3();
      camera.getWorldDirection(fwd);
      var plane=new THREE.Plane().setFromNormalAndCoplanarPoint(fwd,target);
      var planePt=new THREE.Vector3();
      pt=raycaster.ray.intersectPlane(plane,planePt)?planePt:target.clone();
    }
    lastFocal={x:clientX,y:clientY,t:now,point:pt};
    return pt;
  }
  function zoomToward(focal,factor){
    var newRadius=Math.max(maxDim*0.1,Math.min(maxDim*10,spherical.radius*factor));
    var applied=newRadius/spherical.radius;
    spherical.radius=newRadius;
    // Pull the orbit target toward the focal point in proportion to the zoom
    // so the focal point stays (approximately) fixed under the pointer.
    target.lerp(focal,1-applied);
    updateCamera();
  }

  window.resetView=function(){
    var startTheta=spherical.theta;
    var startPhi=spherical.phi;
    var startRadius=spherical.radius;
    var startTarget=target.clone();
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
      target.copy(startTarget).lerp(INIT_TARGET,e);
      updateCamera();
      if(t<1) requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  };

  var canvas=renderer.domElement;

  // ── Touch controls (1-finger orbit, 2-finger pinch toward midpoint) ──────
  var touch={startX:0,startY:0,lastTheta:0,lastPhi:Math.PI/3,pinchDist:0,pinchFocal:null};
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
      touch.pinchDist=Math.sqrt(dx*dx+dy*dy);
      // Compute the focal point once per gesture (raycasts on big scans are
      // too slow to run on every touchmove) at the pinch midpoint.
      var midX=(e.touches[0].clientX+e.touches[1].clientX)/2;
      var midY=(e.touches[0].clientY+e.touches[1].clientY)/2;
      touch.pinchFocal=focalAt(midX,midY).clone();
    }
  },{passive:false});
  canvas.addEventListener('touchmove',function(e){
    e.preventDefault();
    if(e.touches.length===1&&touchDragging){
      var dx=e.touches[0].clientX-touch.startX;
      var dy=e.touches[0].clientY-touch.startY;
      spherical.theta=touch.lastTheta-dx*0.01;
      spherical.phi=Math.max(PHI_MIN,Math.min(PHI_MAX,touch.lastPhi-dy*0.01));
      updateCamera();
    } else if(e.touches.length===2&&touch.pinchDist>0){
      var dx2=e.touches[0].clientX-e.touches[1].clientX;
      var dy2=e.touches[0].clientY-e.touches[1].clientY;
      var pinchNow=Math.sqrt(dx2*dx2+dy2*dy2);
      if(pinchNow>0){
        zoomToward(touch.pinchFocal||target,touch.pinchDist/pinchNow);
        touch.pinchDist=pinchNow;
      }
    }
  },{passive:false});
  canvas.addEventListener('touchend',function(e){
    touchDragging=false;
    if(e.touches.length<2) touch.pinchFocal=null;
  },{passive:false});

  // ── Mouse controls (LMB orbit, RMB/Shift+LMB pan, wheel zoom to cursor) ──
  var mouseState={dragging:false,panning:false,startX:0,startY:0,lastTheta:0,lastPhi:0,panStartTarget:null,panRight:null,panUp:null};
  canvas.addEventListener('mousedown',function(e){
    e.preventDefault();
    tween=null;
    mouseState.startX=e.clientX;
    mouseState.startY=e.clientY;
    if(e.button===2||e.shiftKey){
      mouseState.panning=true;
      mouseState.panStartTarget=target.clone();
      // Capture the camera's right/up axes at drag start so the pan plane is
      // stable for the whole gesture.
      mouseState.panRight=new THREE.Vector3().setFromMatrixColumn(camera.matrix,0);
      mouseState.panUp=new THREE.Vector3().setFromMatrixColumn(camera.matrix,1);
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
      spherical.phi=Math.max(PHI_MIN,Math.min(PHI_MAX,mouseState.lastPhi-dy*0.01));
      updateCamera();
    } else if(mouseState.panning&&mouseState.panStartTarget){
      var dx=e.clientX-mouseState.startX;
      var dy=e.clientY-mouseState.startY;
      var panScale=spherical.radius*0.002;
      target.copy(mouseState.panStartTarget)
        .addScaledVector(mouseState.panRight,-dx*panScale)
        .addScaledVector(mouseState.panUp,dy*panScale);
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
    tween=null;
    zoomToward(focalAt(e.clientX,e.clientY),e.deltaY>0?1.1:0.9);
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
if(parsed.colorWarning){
  try{ console.warn('[scan-viewer] '+parsed.colorWarning); }catch(_){}
  postMsg({type:'warning',message:parsed.colorWarning});
}

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
