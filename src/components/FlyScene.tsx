import { useEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { fetchAsset } from '../lib/atlas';

type Model = { binary: string; pivots: Record<string, [number, number, number]>; parts: { group: string; material: string; positionByteOffset: number; positionCount: number; indexByteOffset: number; indexCount: number }[] };

/** Motor drive for the wings, all normalized 0-1 except `tilt`. */
export type WingDrive = {
  /** Power-muscle (DLMn/DVMn) firing -> stroke amplitude. */
  power: number;
  /** Steering-muscle asymmetry -> differential wing tilt, -1..1. */
  tilt: number;
};

// The model ships only three pivots -- body and the two FRONT LEGS -- so the
// wings arrive welded into the static body group. They do separate cleanly:
// the membrane is its own part, and the brown part splits into wing veins at
// y ~ +0.01 and leg segments at y ~ -0.12, with nothing in between. Triangles
// above this line are wing, below it are body.
const WING_Y = -0.01;
// Hinge taken from where the membrane meets the thorax: |x| ~ 0.046, and the
// mid-depth of its z extent.
const HINGE: [number, number, number] = [0.046, 0.0095, -0.047];

/**
 * An anatomical body view, driven by the wing motor neurons.
 *
 * The stroke amplitude is real output -- the same DLMn/DVMn and steering-muscle
 * spikes that generate the percussion voices. The flap RATE is not: a fly beats
 * its wings at ~200 Hz, which no display can show, so the visible rate is a
 * legible stand-in and only the amplitude and tilt carry signal. This is a
 * kinematic mapping, not physics; the real flybody model needs MuJoCo for that.
 */
export function FlyScene({ wing }: { wing?: WingDrive }) {
  const drive = useRef<WingDrive>({ power: 0, tilt: 0 });
  useEffect(() => { if (wing) drive.current = wing; }, [wing]);
  const host = useRef<HTMLDivElement>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    const element = host.current!;
    const controller = new AbortController();
    let disposed = false;
    const scene = new THREE.Scene(), modelRoot = new THREE.Group();
    scene.add(modelRoot);
    const camera = new THREE.PerspectiveCamera(35, 1, .001, 100);
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true });
    renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    renderer.outputColorSpace = THREE.SRGBColorSpace;
    element.append(renderer.domElement);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enablePan = false; controls.enableZoom = false;
    scene.add(new THREE.HemisphereLight(0xffedda, 0x18202a, 3));
    const light = new THREE.DirectionalLight(0xffdfb2, 4); light.position.set(2, 3, 4); scene.add(light);
    const materials: Record<string, THREE.Material> = {};
    const colors: Record<string, number> = { body: 0x9e6834, black: 0x15110e, red: 0xad331f, ocelli: 0xe6b351, 'bristle-brown': 0x281c10, lower: 0xbb8949, brown: 0x52351f };
    for (const [key,color] of Object.entries(colors)) materials[key] = new THREE.MeshStandardMaterial({color,roughness:.65});
    materials.membrane = new THREE.MeshStandardMaterial({color:0xaabbcc,transparent:true,opacity:.36,side:THREE.DoubleSide,depthWrite:false});
    let radius = .3;
    let corners: THREE.Vector3[] = [];
    const wings: { left?: THREE.Group; right?: THREE.Group } = {};
    const resize = () => {
      const { width, height } = element.getBoundingClientRect();
      renderer.setSize(Math.max(1,width),Math.max(1,height),false);
      camera.aspect = width / Math.max(1,height);
      const fov = Math.min(camera.fov*Math.PI/180,2*Math.atan(Math.tan(camera.fov*Math.PI/360)*camera.aspect));
      camera.position.set(1,.65,1.5).normalize().multiplyScalar(radius/Math.sin(fov/2)*1.1);
      camera.lookAt(0,0,0); camera.updateProjectionMatrix(); controls.update(); draw();
    };
    const draw = () => {
      if (corners.length) {
        camera.zoom = 1; camera.updateProjectionMatrix(); camera.updateMatrixWorld();
        const projected = corners.map(point => point.clone().project(camera));
        const extent = Math.max(...projected.flatMap(point => [Math.abs(point.x), Math.abs(point.y)]));
        camera.zoom = 1 / (extent * 1.12); camera.updateProjectionMatrix();
      }
      renderer.render(scene,camera);
    };
    controls.addEventListener('change',draw);
    void (async () => {
      const get = (path:string) => fetchAsset(`data/flybody/${path}`, controller.signal);
      const meta = await (await get('model.json')).json() as Model;
      const buffer = await (await get(meta.binary)).arrayBuffer();
      if(disposed) return;
      const hinged = (sign: number) => {
        const group = new THREE.Group();
        group.position.set(sign * HINGE[0], HINGE[1], HINGE[2]);
        modelRoot.add(group);
        return group;
      };
      wings.left = hinged(1); wings.right = hinged(-1);

      const build = (positions: Float32Array, index: Uint32Array, material: string,
                     parent: THREE.Object3D, offset: THREE.Vector3) => {
        if (!index.length) return;
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
        geometry.setIndex(new THREE.BufferAttribute(index, 1));
        geometry.computeVertexNormals();
        const mesh = new THREE.Mesh(geometry, materials[material] ?? materials.body);
        mesh.position.copy(offset);
        parent.add(mesh);
      };

      for(const part of meta.parts) {
        const positions = new Float32Array(buffer.slice(part.positionByteOffset,part.positionByteOffset+part.positionCount*12));
        const index = new Uint32Array(buffer.slice(part.indexByteOffset,part.indexByteOffset+part.indexCount*4));
        const pivot = new THREE.Vector3().fromArray(meta.pivots[part.group]);
        const splittable = part.group === 'body' && (part.material === 'membrane' || part.material === 'brown');
        if (!splittable) { build(positions, index, part.material, modelRoot, pivot); continue; }

        // Sort triangles into body / left wing / right wing by centroid.
        const buckets: number[][] = [[], [], []];
        for (let t = 0; t < index.length; t += 3) {
          let y = 0, x = 0;
          for (let k = 0; k < 3; k++) { x += positions[index[t+k]*3]; y += positions[index[t+k]*3+1]; }
          buckets[y / 3 <= WING_Y ? 0 : (x / 3 >= 0 ? 1 : 2)].push(index[t], index[t+1], index[t+2]);
        }
        build(positions, new Uint32Array(buckets[0]), part.material, modelRoot, pivot);
        build(positions, new Uint32Array(buckets[1]), part.material, wings.left!,
              pivot.clone().sub(new THREE.Vector3(HINGE[0], HINGE[1], HINGE[2])));
        build(positions, new Uint32Array(buckets[2]), part.material, wings.right!,
              pivot.clone().sub(new THREE.Vector3(-HINGE[0], HINGE[1], HINGE[2])));
      }
      const bounds = new THREE.Box3().setFromObject(modelRoot);
      modelRoot.position.sub(bounds.getCenter(new THREE.Vector3()));
      radius = bounds.getBoundingSphere(new THREE.Sphere()).radius;
      const half = bounds.getSize(new THREE.Vector3()).multiplyScalar(.5);
      corners = [-1,1].flatMap(x => [-1,1].flatMap(y => [-1,1].map(z => new THREE.Vector3(x*half.x,y*half.y,z*half.z))));
      resize();
    })().catch(e => {if(!disposed) setError(String(e));});
    const onLost = (event: Event) => event.preventDefault();
    const onRestored = () => resize();
    renderer.domElement.addEventListener('webglcontextlost', onLost);
    renderer.domElement.addEventListener('webglcontextrestored', onRestored);

    const observer = new ResizeObserver(resize); observer.observe(element); resize();

    // Visible stand-in rate for the wingbeat; the real 200 Hz cannot be shown.
    const STROKE_HZ = 9;
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let raf = 0, smoothPower = 0, smoothTilt = 0;
    const animate = (now: number) => {
      raf = requestAnimationFrame(animate);
      if (document.hidden || !wings.left || !wings.right) return;
      const target = reducedMotion.matches ? 0 : drive.current.power;
      smoothPower += (target - smoothPower) * .08;
      smoothTilt += (drive.current.tilt - smoothTilt) * .06;
      // Rest pose is folded back; stroke opens the wing about the hinge.
      const stroke = Math.sin(now / 1000 * STROKE_HZ * Math.PI * 2) * smoothPower * .55;
      wings.left.rotation.z = -stroke - smoothTilt * .18;
      wings.right.rotation.z = stroke - smoothTilt * .18;
      wings.left.rotation.y = smoothPower * .12;
      wings.right.rotation.y = -smoothPower * .12;
      draw();
    };
    raf = requestAnimationFrame(animate);
    return () => {cancelAnimationFrame(raf);disposed=true;controller.abort();observer.disconnect();
      renderer.domElement.removeEventListener('webglcontextlost', onLost);
      renderer.domElement.removeEventListener('webglcontextrestored', onRestored);controls.dispose();modelRoot.traverse(object=>{if(object instanceof THREE.Mesh)object.geometry.dispose();});Object.values(materials).forEach(m=>m.dispose());renderer.dispose();renderer.domElement.remove();};
  },[]);
  return <div ref={host} className="three-viewport" aria-label="Flybody anatomical surface, drag to rotate">{error&&<p role="alert">{error}</p>}</div>;
}
