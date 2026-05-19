import React, { useState, useEffect, useRef } from "react";
import {
  Modal,
  View,
  Text,
  Pressable,
  ActivityIndicator,
  StyleSheet,
  StatusBar,
} from "react-native";
import { WebView, type WebViewMessageEvent } from "react-native-webview";
import * as FileSystem from "expo-file-system";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { Ionicons } from "@expo/vector-icons";

export type ScanFormat = "stl" | "obj" | "ply";

interface ScanViewerModalProps {
  visible: boolean;
  fileUrl: string;
  fileName: string;
  format: ScanFormat;
  authToken?: string | null;
  onClose: () => void;
  onFallback: () => void;
}

type LoadState = "downloading" | "rendering" | "error";

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function buildViewerHtml(fileBase64: string, format: ScanFormat): string {
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
<div id="hint">Drag to rotate \u00b7 Pinch to zoom</div>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
<script>
(function(){
'use strict';

// ── Helpers ──────────────────────────────────────────────────────────────────
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
  var lines=text.split(/\r?\n/);
  var nx=0,ny=0,nz=0;
  for(var i=0;i<lines.length;i++){
    var line=lines[i].trim();
    if(line.startsWith('facet normal')){
      var parts=line.split(/\s+/);
      nx=parseFloat(parts[2]); ny=parseFloat(parts[3]); nz=parseFloat(parts[4]);
    } else if(line.startsWith('vertex')){
      var p=line.split(/\s+/);
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
  var lines=text.split(/\r?\n/);
  var positions=[];
  var vertArr=[];

  for(var i=0;i<lines.length;i++){
    var line=lines[i].trim();
    if(line.length===0||line.charAt(0)==='#') continue;

    if(line.startsWith('v ')&&!line.startsWith('vt ')&&!line.startsWith('vn ')){
      var parts=line.split(/\s+/);
      positions.push(parseFloat(parts[1]),parseFloat(parts[2]),parseFloat(parts[3]));
    } else if(line.startsWith('f ')){
      var tokens=line.split(/\s+/).slice(1);
      var idxs=[];
      for(var t=0;t<tokens.length;t++){
        var raw=parseInt(tokens[t].split('/')[0],10);
        // OBJ indices are 1-based; negative = relative
        idxs.push(raw>0? raw-1 : positions.length/3+raw);
      }
      // Fan-triangulate the polygon
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

// ── PLY parser (ASCII + binary little-endian / big-endian) ───────────────────
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

// Read unsigned integer of 1, 2, or 4 bytes (for face list count field)
function readUintBySize(dv,offset,size){
  switch(size){
    case 1: return dv.getUint8(offset);
    case 2: return dv.getUint16(offset,true);
    case 4: return dv.getUint32(offset,true);
    default: return dv.getUint8(offset);
  }
}

// Read signed integer of 1, 2, or 4 bytes (for face vertex index field)
function readIntBySize(dv,offset,size,le){
  switch(size){
    case 1: return dv.getInt8(offset);
    case 2: return dv.getInt16(offset,le);
    case 4: return dv.getInt32(offset,le);
    default: return dv.getInt32(offset,le);
  }
}

function parsePLY(buf){
  // Locate "end_header" marker to find where binary/ascii data begins
  var bytes=new Uint8Array(buf);
  var endMagic=[101,110,100,95,104,101,97,100,101,114]; // "end_header"
  var headerEnd=-1;
  for(var i=0;i<bytes.length-10;i++){
    var match=true;
    for(var k=0;k<10;k++){ if(bytes[i+k]!==endMagic[k]){match=false;break;} }
    if(match){
      headerEnd=i;
      while(headerEnd<bytes.length&&bytes[headerEnd]!==10) headerEnd++;
      headerEnd++; // past the newline character
      break;
    }
  }
  if(headerEnd<0) return null;

  // Decode the header-only portion to parse metadata
  var headerText=new TextDecoder().decode(buf.slice(0,headerEnd));
  var headerLines=headerText.split(/\r?\n/);

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
      vertexCount=parseInt(hl.split(/\s+/)[2],10);
      inVertex=true; inFace=false;
    } else if(hl.startsWith('element face')){
      faceCount=parseInt(hl.split(/\s+/)[2],10);
      inVertex=false; inFace=true;
    } else if(hl.startsWith('element ')){
      inVertex=false; inFace=false;
    } else if(hl.startsWith('property list')&&inFace){
      // e.g. "property list uchar int vertex_indices"
      var pp=hl.split(/\s+/);
      faceListCountType=pp[2]||'uchar';
      faceListIndexType=pp[3]||'int';
    } else if(hl.startsWith('property')&&inVertex){
      var pp=hl.split(/\s+/);
      vertexProps.push({type:pp[1],name:pp[2]});
    }
  }

  if(vertexCount===0) return null;

  var xIdx=vertexProps.findIndex(function(p){return p.name==='x';});
  var yIdx=vertexProps.findIndex(function(p){return p.name==='y';});
  var zIdx=vertexProps.findIndex(function(p){return p.name==='z';});
  if(xIdx<0||yIdx<0||zIdx<0) return null;

  if(format==='ascii'){
    // For ASCII PLY, decode the FULL file so we can read data lines after end_header
    var fullText=new TextDecoder().decode(buf);
    return parsePLYAscii(fullText,vertexCount,faceCount,xIdx,yIdx,zIdx);
  } else {
    var le=format==='binary_le';
    return parsePLYBinary(buf,headerEnd,vertexCount,faceCount,vertexProps,xIdx,yIdx,zIdx,le,faceListCountType,faceListIndexType);
  }
}

function parsePLYAscii(fullText,vertexCount,faceCount,xIdx,yIdx,zIdx){
  var lines=fullText.split(/\r?\n/);

  // Find the end_header line index so we know where data starts
  var dataStart=0;
  for(var i=0;i<lines.length;i++){
    if(lines[i].trim()==='end_header'){dataStart=i+1;break;}
  }

  // Read vertex positions
  var positions=[];
  for(var i=0;i<vertexCount;i++){
    var lineIdx=dataStart+i;
    if(lineIdx>=lines.length) break;
    var parts=lines[lineIdx].trim().split(/\s+/);
    positions.push(parseFloat(parts[xIdx]),parseFloat(parts[yIdx]),parseFloat(parts[zIdx]));
  }

  // Read face indices (if any)
  var vertArr=[];
  var faceStart=dataStart+vertexCount;
  for(var i=0;i<faceCount;i++){
    var lineIdx=faceStart+i;
    if(lineIdx>=lines.length) break;
    var line=lines[lineIdx].trim();
    if(line.length===0) continue;
    var parts=line.split(/\s+/);
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
    }
  }

  if(vertArr.length===0){
    // Point-cloud PLY: no face list, render vertices directly
    var verts=new Float32Array(positions);
    return {vertices:verts,normals:computeFlatNormals(verts)};
  }
  var verts=new Float32Array(vertArr);
  return {vertices:verts,normals:computeFlatNormals(verts)};
}

function parsePLYBinary(buf,dataOffset,vertexCount,faceCount,vertexProps,xIdx,yIdx,zIdx,le,faceListCountType,faceListIndexType){
  var dv=new DataView(buf);

  // Compute per-vertex byte stride and property offsets
  var vertexStride=0;
  var propOffsets=[];
  for(var i=0;i<vertexProps.length;i++){
    propOffsets.push(vertexStride);
    vertexStride+=propByteSize(vertexProps[i].type);
  }

  var positions=[];
  var off=dataOffset;
  for(var i=0;i<vertexCount;i++){
    positions.push(
      readPropVal(dv,off+propOffsets[xIdx],vertexProps[xIdx].type,le),
      readPropVal(dv,off+propOffsets[yIdx],vertexProps[yIdx].type,le),
      readPropVal(dv,off+propOffsets[zIdx],vertexProps[zIdx].type,le)
    );
    off+=vertexStride;
  }

  var countSize=propByteSize(faceListCountType);
  var indexSize=propByteSize(faceListIndexType);

  var vertArr=[];
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
      }
    }
  }

  if(vertArr.length===0){
    // Point-cloud PLY: no face list
    var verts=new Float32Array(positions);
    return {vertices:verts,normals:computeFlatNormals(verts)};
  }
  var verts=new Float32Array(vertArr);
  return {vertices:verts,normals:computeFlatNormals(verts)};
}

// ── Three.js scene setup ──────────────────────────────────────────────────────
var renderer=new THREE.WebGLRenderer({antialias:true,alpha:false});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.setSize(window.innerWidth,window.innerHeight);
renderer.shadowMap.enabled=true;
document.body.appendChild(renderer.domElement);

var scene=new THREE.Scene();
scene.background=new THREE.Color(0x18181b);

var camera=new THREE.PerspectiveCamera(45,window.innerWidth/window.innerHeight,0.01,10000);

var ambient=new THREE.AmbientLight(0xffffff,0.5);
scene.add(ambient);
var dir1=new THREE.DirectionalLight(0xffffff,0.8);
dir1.position.set(1,2,3);
scene.add(dir1);
var dir2=new THREE.DirectionalLight(0x88aaff,0.4);
dir2.position.set(-2,-1,-1);
scene.add(dir2);

window.addEventListener('resize',function(){
  camera.aspect=window.innerWidth/window.innerHeight;
  camera.updateProjectionMatrix();
  renderer.setSize(window.innerWidth,window.innerHeight);
});

// ── Load & display model ──────────────────────────────────────────────────────
var FILE_B64=${JSON.stringify(fileBase64)};
var FILE_FORMAT=${JSON.stringify(format)};
var buf=b64toAB(FILE_B64);
var parsed=null;
try{
  if(FILE_FORMAT==='stl') parsed=parseSTL(buf);
  else if(FILE_FORMAT==='obj') parsed=parseOBJ(buf);
  else if(FILE_FORMAT==='ply') parsed=parsePLY(buf);
}catch(e){}

if(!parsed){
  document.getElementById('overlay').textContent='Could not parse scan file.';
  if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'parse_failed'}));
} else {
  document.getElementById('overlay').style.display='none';

  var geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(parsed.vertices,3));
  geo.setAttribute('normal',new THREE.BufferAttribute(parsed.normals,3));

  var mat=new THREE.MeshPhongMaterial({color:0xe2e8f0,specular:0x444444,shininess:40,side:THREE.DoubleSide});
  var mesh=new THREE.Mesh(geo,mat);
  scene.add(mesh);

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
  camera.position.set(0,maxDim*0.3,dist);
  camera.near=dist*0.001;
  camera.far=dist*10;
  camera.lookAt(0,0,0);
  camera.updateProjectionMatrix();

  var spherical={theta:0,phi:Math.PI/3,radius:dist};
  var touch={startX:0,startY:0,lastTheta:0,lastPhi:Math.PI/3,pinchStart:0,pinchRadius:0};
  var isDragging=false;

  function updateCamera(){
    var x=spherical.radius*Math.sin(spherical.phi)*Math.sin(spherical.theta);
    var y=spherical.radius*Math.cos(spherical.phi);
    var z=spherical.radius*Math.sin(spherical.phi)*Math.cos(spherical.theta);
    camera.position.set(x,y,z);
    camera.lookAt(0,0,0);
  }
  updateCamera();

  var canvas=renderer.domElement;

  canvas.addEventListener('touchstart',function(e){
    e.preventDefault();
    if(e.touches.length===1){
      isDragging=true;
      touch.startX=e.touches[0].clientX;
      touch.startY=e.touches[0].clientY;
      touch.lastTheta=spherical.theta;
      touch.lastPhi=spherical.phi;
    } else if(e.touches.length===2){
      isDragging=false;
      var dx=e.touches[0].clientX-e.touches[1].clientX;
      var dy=e.touches[0].clientY-e.touches[1].clientY;
      touch.pinchStart=Math.sqrt(dx*dx+dy*dy);
      touch.pinchRadius=spherical.radius;
    }
  },{passive:false});

  canvas.addEventListener('touchmove',function(e){
    e.preventDefault();
    if(e.touches.length===1&&isDragging){
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

  canvas.addEventListener('touchend',function(){ isDragging=false; },{passive:false});

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

export default function ScanViewerModal({
  visible,
  fileUrl,
  fileName,
  format,
  authToken,
  onClose,
  onFallback,
}: ScanViewerModalProps) {
  const insets = useSafeAreaInsets();
  const [loadState, setLoadState] = useState<LoadState>("downloading");
  const [htmlSource, setHtmlSource] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const hasFallenBack = useRef(false);

  useEffect(() => {
    if (!visible) return;
    hasFallenBack.current = false;
    setLoadState("downloading");
    setHtmlSource(null);
    setErrorMsg("");

    let cancelled = false;
    (async () => {
      try {
        const cacheDir = FileSystem.Paths.cache.uri;
        const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_");
        const localUri = cacheDir.endsWith("/")
          ? cacheDir + safeName
          : cacheDir + "/" + safeName;

        const headers: Record<string, string> = {};
        if (authToken) headers["Authorization"] = `Bearer ${authToken}`;

        const downloadRes = await FileSystem.downloadAsync(fileUrl, localUri, { headers });

        if (cancelled) return;

        if (downloadRes.status !== 200) {
          setLoadState("error");
          setErrorMsg("Download failed (status " + downloadRes.status + ").");
          return;
        }

        const fileRef = new FileSystem.File(downloadRes.uri);
        const arrayBuffer = await fileRef.arrayBuffer();
        const base64 = arrayBufferToBase64(arrayBuffer);

        if (cancelled) return;

        setHtmlSource(buildViewerHtml(base64, format));
        setLoadState("rendering");
      } catch {
        if (cancelled) return;
        setLoadState("error");
        setErrorMsg("Could not load the scan file.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, fileUrl, fileName, format, authToken]);

  function handleMessage(e: WebViewMessageEvent) {
    try {
      const msg = JSON.parse(e.nativeEvent.data) as { type: string };
      if (msg.type === "error" && !hasFallenBack.current) {
        hasFallenBack.current = true;
        onClose();
        onFallback();
      }
    } catch {
    }
  }

  function handleFallback() {
    if (!hasFallenBack.current) {
      hasFallenBack.current = true;
      onClose();
      onFallback();
    }
  }

  return (
    <Modal
      visible={visible}
      animationType="slide"
      presentationStyle="fullScreen"
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <StatusBar barStyle="light-content" backgroundColor="#18181b" />
      <View style={[styles.container, { paddingTop: insets.top }]}>
        {/* Header */}
        <View style={styles.header}>
          <Text style={styles.title} numberOfLines={1}>
            {fileName}
          </Text>
          <Pressable
            onPress={onClose}
            style={({ pressed }) => [styles.closeBtn, pressed && styles.closeBtnPressed]}
            hitSlop={12}
          >
            <Ionicons name="close" size={22} color="#f4f4f5" />
          </Pressable>
        </View>

        {/* Content */}
        <View style={styles.webviewContainer}>
          {loadState === "downloading" && (
            <View style={styles.center}>
              <ActivityIndicator size="large" color="#a1a1aa" />
              <Text style={styles.statusText}>Downloading…</Text>
            </View>
          )}

          {loadState === "error" && (
            <View style={styles.center}>
              <Ionicons name="alert-circle-outline" size={48} color="#f87171" />
              <Text style={styles.errorText}>{errorMsg || "Could not load the scan file."}</Text>
              <Pressable
                style={({ pressed }) => [styles.fallbackBtn, pressed && { opacity: 0.7 }]}
                onPress={handleFallback}
              >
                <Ionicons name="share-outline" size={16} color="#fff" />
                <Text style={styles.fallbackBtnText}>Open with another app</Text>
              </Pressable>
            </View>
          )}

          {loadState === "rendering" && htmlSource != null && (
            <WebView
              style={styles.webview}
              source={{ html: htmlSource }}
              originWhitelist={["*"]}
              javaScriptEnabled
              scrollEnabled={false}
              onMessage={handleMessage}
              onError={() => {
                setLoadState("error");
                setErrorMsg("The viewer failed to load.");
              }}
              onHttpError={() => {
                setLoadState("error");
                setErrorMsg("The viewer failed to load.");
              }}
              allowsInlineMediaPlayback
              mediaPlaybackRequiresUserAction={false}
              bounces={false}
              overScrollMode="never"
            />
          )}
        </View>

        {/* Bottom action */}
        {loadState === "rendering" && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 4 }]}>
            <Pressable
              style={({ pressed }) => [styles.shareBtn, pressed && { opacity: 0.7 }]}
              onPress={handleFallback}
            >
              <Ionicons name="share-outline" size={16} color="#a1a1aa" />
              <Text style={styles.shareBtnText}>Open with another app</Text>
            </Pressable>
          </View>
        )}
      </View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: "#18181b",
  },
  header: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingVertical: 12,
    gap: 8,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: "rgba(255,255,255,0.1)",
  },
  title: {
    flex: 1,
    color: "#f4f4f5",
    fontSize: 15,
    fontFamily: "Inter_600SemiBold",
  },
  closeBtn: {
    width: 34,
    height: 34,
    borderRadius: 17,
    backgroundColor: "rgba(255,255,255,0.08)",
    alignItems: "center",
    justifyContent: "center",
  },
  closeBtnPressed: {
    backgroundColor: "rgba(255,255,255,0.15)",
  },
  webviewContainer: {
    flex: 1,
  },
  webview: {
    flex: 1,
    backgroundColor: "#18181b",
  },
  center: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    paddingHorizontal: 32,
  },
  statusText: {
    color: "#a1a1aa",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
  },
  errorText: {
    color: "#f87171",
    fontSize: 14,
    fontFamily: "Inter_400Regular",
    textAlign: "center",
  },
  fallbackBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    backgroundColor: "#3f3f46",
    paddingHorizontal: 16,
    paddingVertical: 10,
    borderRadius: 8,
    marginTop: 4,
  },
  fallbackBtnText: {
    color: "#fff",
    fontSize: 14,
    fontFamily: "Inter_500Medium",
  },
  footer: {
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.1)",
    alignItems: "center",
  },
  shareBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
  },
  shareBtnText: {
    color: "#a1a1aa",
    fontSize: 13,
    fontFamily: "Inter_400Regular",
  },
});
