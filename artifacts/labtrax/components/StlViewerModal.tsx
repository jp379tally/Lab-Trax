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

interface StlViewerModalProps {
  visible: boolean;
  fileUrl: string;
  fileName: string;
  authToken?: string | null;
  onClose: () => void;
  onFallback: () => void;
}

type LoadState = "downloading" | "rendering" | "error";
type DisplayMode = "solid" | "wireframe" | "shaded";

const DISPLAY_MODES: DisplayMode[] = ["solid", "wireframe", "shaded"];

const MODE_LABELS: Record<DisplayMode, string> = {
  solid: "Solid",
  wireframe: "Wireframe",
  shaded: "Shaded",
};

const MODE_ICONS: Record<DisplayMode, keyof typeof Ionicons.glyphMap> = {
  solid: "cube-outline",
  wireframe: "grid-outline",
  shaded: "color-palette-outline",
};

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function buildViewerHtml(stlBase64: string): string {
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
<div id="overlay">Rendering…</div>
<div id="hint">Drag to rotate · Pinch to zoom</div>
<script src="https://cdn.jsdelivr.net/npm/three@0.128.0/build/three.min.js"></script>
<script>
(function(){
'use strict';

// ── Minimal STL parser (binary + ASCII) ──────────────────────────────────────
function parseSTL(buf){
  var dv=new DataView(buf);
  // Binary STL: 80-byte header + uint32 triangle count
  var triCount=dv.getUint32(80,true);
  var expectedLen=84+triCount*50;
  if(buf.byteLength===expectedLen&&triCount>0){
    return parseBinary(buf,triCount);
  }
  // Fallback: try ASCII
  var text=new TextDecoder().decode(buf);
  if(text.trimStart().startsWith('solid')){
    var geo=parseAscii(text);
    if(geo) return geo;
  }
  // Last resort: try binary anyway
  if(triCount>0) return parseBinary(buf,triCount);
  return null;
}

function parseBinary(buf,triCount){
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
    off+=2; // attribute byte count
  }
  return {vertices:verts,normals:norms};
}

function parseAscii(text){
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

// ── base64 → ArrayBuffer ─────────────────────────────────────────────────────
function b64toAB(b64){
  var bin=atob(b64),len=bin.length,buf=new ArrayBuffer(len),view=new Uint8Array(buf);
  for(var i=0;i<len;i++) view[i]=bin.charCodeAt(i);
  return buf;
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

// Lights
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
var STL_B64 = ${JSON.stringify(stlBase64)};
var buf=b64toAB(STL_B64);
var parsed=null;
try{ parsed=parseSTL(buf); }catch(e){}

if(!parsed){
  document.getElementById('overlay').textContent='Could not parse STL file.';
  if(window.ReactNativeWebView) window.ReactNativeWebView.postMessage(JSON.stringify({type:'error',message:'parse_failed'}));
} else {
  document.getElementById('overlay').style.display='none';

  var geo=new THREE.BufferGeometry();
  geo.setAttribute('position',new THREE.BufferAttribute(parsed.vertices,3));
  geo.setAttribute('normal',new THREE.BufferAttribute(parsed.normals,3));

  // ── Materials for each display mode ────────────────────────────────────────
  var solidMat=new THREE.MeshPhongMaterial({color:0xe2e8f0,specular:0x444444,shininess:40,side:THREE.DoubleSide});
  var wireframeMat=new THREE.MeshPhongMaterial({color:0xe2e8f0,specular:0x444444,shininess:40,side:THREE.DoubleSide,wireframe:true});
  var shadedMat=new THREE.MeshNormalMaterial({side:THREE.DoubleSide});

  var mesh=new THREE.Mesh(geo,solidMat);
  scene.add(mesh);

  // ── Display mode switcher (called from React Native via injectJavaScript) ──
  window.setDisplayMode=function(mode){
    if(mode==='solid'){
      mesh.material=solidMat;
    } else if(mode==='wireframe'){
      mesh.material=wireframeMat;
    } else if(mode==='shaded'){
      mesh.material=shadedMat;
    }
  };

  // Center and fit camera
  geo.computeBoundingBox();
  var box=geo.boundingBox;
  var center=new THREE.Vector3();
  box.getCenter(center);
  mesh.position.sub(center);

  var size=new THREE.Vector3();
  box.getSize(size);
  var maxDim=Math.max(size.x,size.y,size.z);
  var fov=camera.fov*(Math.PI/180);
  var dist=Math.abs(maxDim/Math.sin(fov/2))*0.6;
  camera.position.set(0,maxDim*0.3,dist);
  camera.near=dist*0.001;
  camera.far=dist*10;
  camera.lookAt(0,0,0);
  camera.updateProjectionMatrix();

  // ── Touch orbit controls ──────────────────────────────────────────────────
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

  // Fade out hint after 3s
  setTimeout(function(){
    var h=document.getElementById('hint');
    if(h) h.style.opacity='0';
  },3000);

  // Render loop
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

export default function StlViewerModal({
  visible,
  fileUrl,
  fileName,
  authToken,
  onClose,
  onFallback,
}: StlViewerModalProps) {
  const insets = useSafeAreaInsets();
  const [loadState, setLoadState] = useState<LoadState>("downloading");
  const [htmlSource, setHtmlSource] = useState<string | null>(null);
  const [errorMsg, setErrorMsg] = useState<string>("");
  const [displayMode, setDisplayMode] = useState<DisplayMode>("solid");
  const hasFallenBack = useRef(false);
  const webViewRef = useRef<WebView>(null);

  useEffect(() => {
    if (!visible) return;
    hasFallenBack.current = false;
    setLoadState("downloading");
    setHtmlSource(null);
    setErrorMsg("");
    setDisplayMode("solid");

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

        setHtmlSource(buildViewerHtml(base64));
        setLoadState("rendering");
      } catch (err: unknown) {
        if (cancelled) return;
        setLoadState("error");
        setErrorMsg("Could not load the STL file.");
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [visible, fileUrl, fileName, authToken]);

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

  function cycleDisplayMode() {
    const currentIndex = DISPLAY_MODES.indexOf(displayMode);
    const nextMode = DISPLAY_MODES[(currentIndex + 1) % DISPLAY_MODES.length]!;
    setDisplayMode(nextMode);
    webViewRef.current?.injectJavaScript(
      `(function(){ if(typeof window.setDisplayMode==='function') window.setDisplayMode(${JSON.stringify(nextMode)}); })(); true;`
    );
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
              <Text style={styles.errorText}>{errorMsg || "Could not load the STL file."}</Text>
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
              ref={webViewRef}
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

        {/* Bottom toolbar */}
        {loadState === "rendering" && (
          <View style={[styles.footer, { paddingBottom: insets.bottom + 4 }]}>
            {/* Display mode toggle */}
            <Pressable
              style={({ pressed }) => [styles.modeBtn, pressed && { opacity: 0.7 }]}
              onPress={cycleDisplayMode}
              accessibilityLabel={`Display mode: ${MODE_LABELS[displayMode]}. Tap to cycle.`}
            >
              <Ionicons name={MODE_ICONS[displayMode]} size={16} color="#e4e4e7" />
              <Text style={styles.modeBtnText}>{MODE_LABELS[displayMode]}</Text>
            </Pressable>

            {/* Divider */}
            <View style={styles.footerDivider} />

            {/* Share */}
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
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: 16,
    paddingTop: 10,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: "rgba(255,255,255,0.1)",
    gap: 0,
  },
  modeBtn: {
    flexDirection: "row",
    alignItems: "center",
    gap: 6,
    paddingVertical: 8,
    paddingHorizontal: 10,
    borderRadius: 8,
    backgroundColor: "rgba(255,255,255,0.08)",
  },
  modeBtnText: {
    color: "#e4e4e7",
    fontSize: 13,
    fontFamily: "Inter_500Medium",
  },
  footerDivider: {
    flex: 1,
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
