// field3d.js — 3D ballpark model (WebGL / Three.js). Fenway first.
//
// A recognizable-but-stylized 3D stadium viewed from behind home plate: the
// field, the outfield wall driven by the park's REAL dimensions (so Fenway's
// Green Monster towers in left, Pesky's pole is short in right), the stands,
// lights, and lighting. Not photoreal — a clean low-poly model we refine over
// time. Exposes window.Field3D.mount(container, opts) / .unmount(container).
//
// Loaded as a module so it can import three from a CDN. app.js (a plain
// script) calls window.Field3D.* — calls before this finishes loading are
// queued and flushed on ready.
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.161.0/build/three.module.js";

// 1 unit = 1 foot. Home plate at the origin; +Z toward center field, +X to
// the 1B/right-field side, +Y up.
const D2R = Math.PI / 180;
// Angle of each posted dimension off straight-away center (− = LF/3B side).
const PT_ANGLE = { LL: -45, L: -28, LC: -15, C: 0, RC: 15, R: 28, RL: 45 };
const PT_ORDER = ["LL", "L", "LC", "C", "RC", "R", "RL"];
// Wall heights (ft) per segment — Fenway: 37' Monster in left, short in right.
const FENWAY_WALL_H = { LL: 37, L: 37, LC: 25, C: 17, RC: 12, R: 8, RL: 5 };

function pos(distFt, angleDeg) {
    const a = angleDeg * D2R;
    return new THREE.Vector3(distFt * Math.sin(a), 0, distFt * Math.cos(a));
}

function wallPoints(park) {
    const pts = [];
    for (const k of PT_ORDER) {
        const d = park[k];
        if (d == null) continue;
        pts.push({ k, p: pos(d, PT_ANGLE[k]), h: (FENWAY_WALL_H[k] ?? 10) });
    }
    return pts;
}

function buildScene(park) {
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0x0b1220);
    scene.fog = new THREE.Fog(0x0b1220, 600, 1400);

    // ---- lighting (dusk ballpark) ----
    scene.add(new THREE.HemisphereLight(0x9fb6d6, 0x202a1c, 0.85));
    const sun = new THREE.DirectionalLight(0xfff2d6, 1.05);
    sun.position.set(-220, 380, 120);
    sun.castShadow = true;
    sun.shadow.mapSize.set(2048, 2048);
    Object.assign(sun.shadow.camera, { left: -500, right: 500, top: 500, bottom: -500, near: 1, far: 1400 });
    scene.add(sun);

    const grassMat = new THREE.MeshStandardMaterial({ color: 0x3f7a30, roughness: 0.95 });
    const grassDark = new THREE.MeshStandardMaterial({ color: 0x356a28, roughness: 0.95 });
    const dirtMat = new THREE.MeshStandardMaterial({ color: 0xa9763f, roughness: 1 });
    const concreteMat = new THREE.MeshStandardMaterial({ color: 0x2a3140, roughness: 1 });

    // ---- big base ground ----
    const ground = new THREE.Mesh(new THREE.CircleGeometry(900, 64), concreteMat);
    ground.rotation.x = -Math.PI / 2; ground.position.y = -0.5; ground.receiveShadow = true;
    scene.add(ground);

    // ---- fair-territory grass (fan from home to the wall) ----
    const pts = wallPoints(park);
    const fairShape = new THREE.Shape();
    fairShape.moveTo(0, 0);
    for (const { p } of pts) fairShape.lineTo(p.x, p.z);
    fairShape.lineTo(0, 0);
    const grass = new THREE.Mesh(new THREE.ShapeGeometry(fairShape), grassMat);
    grass.rotation.x = -Math.PI / 2; grass.position.y = 0; grass.receiveShadow = true;
    scene.add(grass);
    // mowing stripe: a slightly darker inner fan
    const inner = new THREE.Shape();
    inner.moveTo(0, 0);
    for (const { p } of pts) inner.lineTo(p.x * 0.62, p.z * 0.62);
    inner.lineTo(0, 0);
    const stripe = new THREE.Mesh(new THREE.ShapeGeometry(inner), grassDark);
    stripe.rotation.x = -Math.PI / 2; stripe.position.y = 0.05; stripe.receiveShadow = true;
    scene.add(stripe);

    // ---- foul territory (two triangles outside the lines) + infield dirt ----
    const dirtFan = new THREE.Shape();
    dirtFan.moveTo(0, 0);
    dirtFan.lineTo(95 * Math.sin(-45 * D2R), 95 * Math.cos(-45 * D2R));
    dirtFan.absarc(0, 95, 95, -135 * D2R, -45 * D2R, false);
    dirtFan.lineTo(0, 0);
    const infield = new THREE.Mesh(new THREE.ShapeGeometry(dirtFan), dirtMat);
    infield.rotation.x = -Math.PI / 2; infield.position.y = 0.08;
    scene.add(infield);

    // ---- bases + mound ----
    const baseMat = new THREE.MeshStandardMaterial({ color: 0xf4f4f4, roughness: 0.7 });
    const bases = [[0, 0], [63.6, 63.6], [0, 127.3], [-63.6, 63.6]];
    for (const [x, z] of bases) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(4, 0.6, 4), baseMat);
        b.position.set(x, 0.3, z); b.castShadow = true; scene.add(b);
    }
    const mound = new THREE.Mesh(new THREE.CylinderGeometry(9, 11, 1.4, 24), dirtMat);
    mound.position.set(0, 0.6, 60.5); mound.castShadow = true; scene.add(mound);

    // ---- foul lines ----
    const lineMat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    for (const ang of [-45, 45]) {
        const end = pos(park[ang < 0 ? "LL" : "RL"] || 320, ang);
        const len = end.length();
        const line = new THREE.Mesh(new THREE.BoxGeometry(1, 0.1, len), lineMat);
        line.position.set(end.x / 2, 0.12, end.z / 2);
        line.rotation.y = -ang * D2R;
        scene.add(line);
    }

    // ---- outfield wall (panels between dimension points) ----
    const monsterMat = new THREE.MeshStandardMaterial({ color: 0x1f6b3a, roughness: 0.9 });
    const wallMat = new THREE.MeshStandardMaterial({ color: 0x14502b, roughness: 0.9 });
    for (let i = 0; i < pts.length - 1; i++) {
        const a = pts[i], b = pts[i + 1];
        const mid = a.p.clone().add(b.p).multiplyScalar(0.5);
        const len = a.p.distanceTo(b.p) + 2;
        const h = (a.h + b.h) / 2;
        const isMonster = a.k === "LL" || a.k === "L";
        const panel = new THREE.Mesh(new THREE.BoxGeometry(len, h, 2.5),
            isMonster ? monsterMat : wallMat);
        panel.position.set(mid.x, h / 2, mid.z);
        panel.rotation.y = Math.atan2(b.p.x - a.p.x, b.p.z - a.p.z) + Math.PI / 2;
        panel.castShadow = true; panel.receiveShadow = true;
        scene.add(panel);
    }
    // Green Monster scoreboard (dark panel low on the left wall)
    const lf = pts.find((q) => q.k === "L") || pts[1];
    if (lf) {
        const sb = new THREE.Mesh(new THREE.BoxGeometry(70, 12, 0.6),
            new THREE.MeshStandardMaterial({ color: 0x0a140c, roughness: 1 }));
        sb.position.set(lf.p.x, 9, lf.p.z - 1.6);
        sb.rotation.y = Math.atan2(-lf.p.x, -lf.p.z);
        scene.add(sb);
    }

    // ---- grandstand: a sloped seating ring behind the wall ----
    const seatMat = new THREE.MeshStandardMaterial({ color: 0x20407a, roughness: 1 });
    const standGeo = new THREE.RingGeometry(1, 1, 1); // placeholder unused
    standGeo.dispose();
    const ring = new THREE.Mesh(
        new THREE.CylinderGeometry(560, 470, 130, 64, 1, true, -2.1, 4.2),
        new THREE.MeshStandardMaterial({ color: 0x223152, roughness: 1, side: THREE.DoubleSide }));
    ring.position.set(0, 55, 210); ring.castShadow = true; ring.receiveShadow = true;
    scene.add(ring);
    void seatMat;

    // ---- light towers ----
    const towerMat = new THREE.MeshStandardMaterial({ color: 0x3a4252 });
    const lampMat = new THREE.MeshStandardMaterial({ color: 0xfff4cf, emissive: 0xffe9a8, emissiveIntensity: 0.9 });
    for (const ang of [-38, -14, 14, 38]) {
        const base = pos(560, ang);
        const pole = new THREE.Mesh(new THREE.CylinderGeometry(2.5, 3.5, 150, 8), towerMat);
        pole.position.set(base.x, 75, base.z); pole.castShadow = true; scene.add(pole);
        const bank = new THREE.Mesh(new THREE.BoxGeometry(40, 14, 6), lampMat);
        bank.position.set(base.x, 150, base.z); scene.add(bank);
        const pl = new THREE.PointLight(0xfff2d0, 0.5, 900); pl.position.set(base.x, 150, base.z); scene.add(pl);
    }

    return scene;
}

function mountOne(container, opts) {
    const park = opts?.park;
    if (!park || !container) return;
    if (container._field3d) return;            // already mounted

    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    container.appendChild(renderer.domElement);
    Object.assign(renderer.domElement.style, { width: "100%", height: "100%", display: "block" });

    const scene = buildScene(park);
    const camera = new THREE.PerspectiveCamera(46, 1, 1, 3000);
    // Behind home plate, elevated, looking out toward center field.
    camera.position.set(0, 78, -118);
    camera.lookAt(0, 10, 230);

    let raf = 0;
    const resize = () => {
        const w = container.clientWidth || 600, h = container.clientHeight || 600;
        renderer.setSize(w, h, false);
        camera.aspect = w / h; camera.updateProjectionMatrix();
    };
    const loop = () => { renderer.render(scene, camera); raf = requestAnimationFrame(loop); };
    const ro = new ResizeObserver(resize);
    ro.observe(container);
    resize(); loop();

    container._field3d = { renderer, scene, ro, stop: () => cancelAnimationFrame(raf) };
}

function unmountOne(container) {
    const h = container && container._field3d;
    if (!h) return;
    h.stop(); h.ro.disconnect();
    h.scene.traverse((o) => { o.geometry?.dispose?.(); o.material?.dispose?.(); });
    h.renderer.dispose();
    h.renderer.domElement.remove();
    delete container._field3d;
}

// Public surface (+ flush any queued calls made before this module loaded).
const api = { mount: mountOne, unmount: unmountOne, ready: true };
const queued = window.Field3D && window.Field3D._q;
window.Field3D = api;
if (Array.isArray(queued)) for (const [fn, args] of queued) api[fn]?.(...args);
