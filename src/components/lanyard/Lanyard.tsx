/* eslint-disable react/no-unknown-property */
'use client';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, extend, useFrame, type ThreeElement, type ThreeEvent } from '@react-three/fiber';
import { useGLTF, useTexture, Environment, Lightformer } from '@react-three/drei';
import {
  BallCollider,
  CuboidCollider,
  Physics,
  RigidBody,
  useRopeJoint,
  useSphericalJoint,
  type RapierRigidBody,
  type RigidBodyProps
} from '@react-three/rapier';
import { MeshLineGeometry, MeshLineMaterial } from 'meshline';
import * as THREE from 'three';

import './Lanyard.css';
import { silenceThreeClockWarning } from '@/lib/silenceThreeClockWarning';

// Public-URL assets (do NOT import .glb/.png in Next — that yields StaticImageData,
// not a URL string, and splits across the Turbopack/webpack builds).
const CARD_GLB = '/lanyard/card.glb';
const LANYARD_PNG = '/lanyard/lanyard.png';

// Quiet @react-three/fiber's internal THREE.Clock deprecation warning (r184).
silenceThreeClockWarning();

extend({ MeshLineGeometry, MeshLineMaterial });

declare module '@react-three/fiber' {
  interface ThreeElements {
    meshLineGeometry: ThreeElement<typeof MeshLineGeometry>;
    meshLineMaterial: ThreeElement<typeof MeshLineMaterial>;
  }
}

const BLANK_PIXEL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

const FRONT_UV_RECT = { x: 0, y: 0, w: 0.5, h: 0.755 };
const BACK_UV_RECT = { x: 0.5, y: 0, w: 0.5, h: 0.757 };

interface LanyardProps {
  position?: [number, number, number];
  gravity?: [number, number, number];
  fov?: number;
  transparent?: boolean;
  frontImage?: string | null;
  backImage?: string | null;
  imageFit?: 'cover' | 'contain';
  lanyardImage?: string | null;
  lanyardWidth?: number;
  paused?: boolean;
  spin?: boolean;
  autoRotate?: boolean;
  onPointerMissed?: () => void;
}

export default function Lanyard({
  position = [0, 0, 30],
  gravity = [0, -40, 0],
  fov = 20,
  transparent = true,
  frontImage = null,
  backImage = null,
  imageFit = 'cover',
  lanyardImage = null,
  lanyardWidth = 1,
  paused = false,
  spin = false,
  autoRotate = false,
  onPointerMissed
}: LanyardProps) {
  const [isMobile, setIsMobile] = useState<boolean>(() => typeof window !== 'undefined' && window.innerWidth < 768);

  useEffect(() => {
    const handleResize = (): void => setIsMobile(window.innerWidth < 768);
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  return (
    <div className="lanyard-wrapper">
      <Canvas
        camera={{ position, fov }}
        dpr={[1, isMobile ? 2 : 2.5]}
        gl={{ alpha: transparent }}
        onCreated={({ gl }) => {
          gl.setClearColor(new THREE.Color(0x000000), transparent ? 0 : 1);
          // Handle WebGL context loss (tab switch, GPU reset, mobile background) —
          // without this the canvas silently goes black and Three.js starts throwing
          // errors that bypass the error boundary.
          const canvas = gl.domElement;
          const onLost = (e: Event) => { e.preventDefault(); };
          canvas.addEventListener('webglcontextlost', onLost);
          // Return cleanup (r3f calls onCreated once; the canvas lives as long as the component).
        }}
        onPointerMissed={onPointerMissed}
      >
        <ambientLight intensity={Math.PI} />
        <Physics paused={paused} gravity={gravity} timeStep={isMobile ? 1 / 30 : 1 / 60}>
          <Band
            isMobile={isMobile}
            paused={paused}
            spin={spin}
            autoRotate={autoRotate}
            frontImage={frontImage}
            backImage={backImage}
            imageFit={imageFit}
            lanyardImage={lanyardImage}
            lanyardWidth={lanyardWidth}
          />
        </Physics>
        <Environment blur={0.75}>
          <Lightformer intensity={2} color="white" position={[0, -1, 5]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
          <Lightformer intensity={3} color="white" position={[-1, -1, 1]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
          <Lightformer intensity={3} color="white" position={[1, 1, 1]} rotation={[0, 0, Math.PI / 3]} scale={[100, 0.1, 1]} />
          <Lightformer intensity={10} color="white" position={[-10, 0, 14]} rotation={[0, Math.PI / 2, Math.PI / 3]} scale={[100, 10, 1]} />
        </Environment>
      </Canvas>
    </div>
  );
}

interface BandProps {
  maxSpeed?: number;
  minSpeed?: number;
  isMobile?: boolean;
  frontImage?: string | null;
  backImage?: string | null;
  imageFit?: 'cover' | 'contain';
  lanyardImage?: string | null;
  lanyardWidth?: number;
  paused?: boolean;
  spin?: boolean;
  autoRotate?: boolean;
}

type LanyardRigidBody = RapierRigidBody & {
  lerped?: THREE.Vector3;
};

function Band({
  maxSpeed = 50,
  minSpeed = 0,
  isMobile = false,
  frontImage = null,
  backImage = null,
  imageFit = 'cover',
  lanyardImage = null,
  lanyardWidth = 1,
  paused = false,
  spin = false,
  autoRotate = false
}: BandProps) {
  const band = useRef<any>(null!);
  const fixed = useRef<RapierRigidBody>(null!);
  const j1 = useRef<LanyardRigidBody>(null!);
  const j2 = useRef<LanyardRigidBody>(null!);
  const j3 = useRef<RapierRigidBody>(null!);
  const card = useRef<RapierRigidBody>(null!);
  const spun = useRef(false);

  const vec = new THREE.Vector3();
  const ang = new THREE.Vector3();
  const rot = new THREE.Vector3();
  const dir = new THREE.Vector3();

  const segmentProps: RigidBodyProps = {
    type: 'dynamic',
    canSleep: true,
    colliders: false,
    angularDamping: 4,
    linearDamping: 4
  };

  const getLerped = (body: LanyardRigidBody): THREE.Vector3 => {
    if (!body.lerped) {
      body.lerped = new THREE.Vector3().copy(body.translation());
    }
    return body.lerped;
  };

  const { nodes, materials } = useGLTF(CARD_GLB) as any;
  const texture = useTexture(lanyardImage || LANYARD_PNG);
  const frontTex = useTexture(frontImage || BLANK_PIXEL);
  const backTex = useTexture(backImage || BLANK_PIXEL);

  const cardMap = useMemo(() => {
    const baseMap = materials.base.map as THREE.Texture;
    if (!frontImage && !backImage) return baseMap;

    const baseImg = baseMap.image as any;
    // Guard: GLB texture may not have decoded yet (image is null on first render).
    if (!baseImg || !baseImg.width || !baseImg.height) return baseMap;

    // Supersample the composite so the card's printed content (rendered into UV sub-rects of
    // this map) stays sharp now that the card is magnified on screen.
    const longEdge = Math.max(baseImg.width, baseImg.height) || 1024;
    const SS = Math.max(1, Math.ceil(2048 / longEdge));
    const W = baseImg.width * SS;
    const H = baseImg.height * SS;
    // Guard: degenerate canvas size would throw in drawImage.
    if (W <= 0 || H <= 0) return baseMap;

    let canvas: HTMLCanvasElement;
    let ctx: CanvasRenderingContext2D | null;
    try {
      canvas = document.createElement('canvas');
      canvas.width = W;
      canvas.height = H;
      ctx = canvas.getContext('2d');
    } catch {
      return baseMap;
    }
    if (!ctx) return baseMap;

    try {
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(baseImg, 0, 0, W, H);
    } catch {
      // baseImg not yet drawable (cross-origin, not loaded) — use plain base texture.
      return baseMap;
    }

    const drawFitted = (img: any, rect: typeof FRONT_UV_RECT) => {
      if (!img || !img.width || !img.height) return;
      const rx = rect.x * W;
      const ry = rect.y * H;
      const rw = rect.w * W;
      const rh = rect.h * H;
      const pick = imageFit === 'contain' ? Math.min : Math.max;
      const scale = pick(rw / img.width, rh / img.height);
      const dw = img.width * scale;
      const dh = img.height * scale;
      if (dw <= 0 || dh <= 0) return;
      const dx = rx + (rw - dw) / 2;
      const dy = ry + (rh - dh) / 2;
      try {
        ctx!.save();
        ctx!.beginPath();
        ctx!.rect(rx, ry, rw, rh);
        ctx!.clip();
        ctx!.drawImage(img, dx, dy, dw, dh);
        ctx!.restore();
      } catch { /* img not drawable yet — skip silently */ }
    };

    if (frontImage && frontTex.image) drawFitted(frontTex.image, FRONT_UV_RECT);
    if (backImage && backTex.image) drawFitted(backTex.image, BACK_UV_RECT);

    const composite = new THREE.CanvasTexture(canvas);
    composite.colorSpace = THREE.SRGBColorSpace;
    composite.flipY = baseMap.flipY;
    composite.anisotropy = 16;
    composite.needsUpdate = true;
    return composite;
  }, [frontImage, backImage, imageFit, frontTex, backTex, materials.base.map]);

  const [curve] = useState(
    () => new THREE.CatmullRomCurve3([new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3(), new THREE.Vector3()])
  );
  const [dragged, drag] = useState<false | THREE.Vector3>(false);
  const [hovered, hover] = useState(false);

  useRopeJoint(fixed, j1, [[0, 0, 0], [0, 0, 0], 1]);
  useRopeJoint(j1, j2, [[0, 0, 0], [0, 0, 0], 1]);
  useRopeJoint(j2, j3, [[0, 0, 0], [0, 0, 0], 1]);
  useSphericalJoint(j3, card, [[0, 0, 0], [0, 1.45, 0]]);

  useEffect(() => {
    if (hovered) {
      document.body.style.cursor = dragged ? 'grabbing' : 'grab';
      return () => {
        document.body.style.cursor = 'auto';
      };
    }
  }, [hovered, dragged]);

  useFrame((state, delta) => {
    // Clamp delta: when the main thread stalls (route change / asset load on login),
    // delta can spike to hundreds of ms, making the lerp alpha below ≫ 1 and the band
    // curve overshoot into NaN ("crash while dropping"). Cap it to a sane frame time.
    delta = Math.min(delta, 1 / 30);
    // One-shot ~360° spin the moment the physics first becomes active (reveal drop).
    if (!paused && spin && !spun.current && card.current) {
      card.current.setAngvel({ x: 0, y: 36, z: 0 }, true);
      spun.current = true;
    }
    if (dragged && typeof dragged !== 'boolean') {
      vec.set(state.pointer.x, state.pointer.y, 0.5).unproject(state.camera);
      dir.copy(vec).sub(state.camera.position).normalize();
      vec.add(dir.multiplyScalar(state.camera.position.length()));
      [card, j1, j2, j3, fixed].forEach(ref => ref.current?.wakeUp());
      card.current?.setNextKinematicTranslation({
        x: vec.x - dragged.x,
        y: vec.y - dragged.y,
        z: vec.z - dragged.z
      });
    }
    if (fixed.current && j1.current && j2.current && j3.current && card.current && band.current) {
      // NaN guard: if the solver ever produces a non-finite card position (rare, under
      // heavy load), recover it to spawn instead of crashing the band geometry.
      const cp = card.current.translation();
      if (!Number.isFinite(cp.x) || !Number.isFinite(cp.y) || !Number.isFinite(cp.z)) {
        card.current.setTranslation({ x: 2, y: 4, z: 0 }, true);
        card.current.setLinvel({ x: 0, y: 0, z: 0 }, true);
        card.current.setAngvel({ x: 0, y: 0, z: 0 }, true);
        return;
      }
      [j1, j2].forEach(ref => {
        const lerped = getLerped(ref.current);
        const clampedDistance = Math.max(0.1, Math.min(1, lerped.distanceTo(ref.current.translation())));
        // Clamp the interpolation alpha to ≤1 so a spiked delta can never overshoot.
        const alpha = Math.min(1, delta * (minSpeed + clampedDistance * (maxSpeed - minSpeed)));
        lerped.lerp(ref.current.translation(), alpha);
      });
      curve.points[0].copy(j3.current.translation());
      curve.points[1].copy(getLerped(j2.current));
      curve.points[2].copy(getLerped(j1.current));
      curve.points[3].copy(fixed.current.translation());
      band.current.geometry.setPoints(curve.getPoints(isMobile ? 16 : 32));
      ang.copy(card.current.angvel());
      rot.copy(card.current.rotation());
      // autoRotate (manual inspect mode): hold a gentle steady yaw so the card keeps turning and
      // the BACK becomes visible. Otherwise self-centre the yaw so it settles facing front.
      // Either way clamp so the spin can't run away and destabilise the joints.
      const yA = (autoRotate && !dragged)
        ? 0.9
        : Math.max(-50, Math.min(50, ang.y - rot.y * 0.25));
      card.current.setAngvel({ x: ang.x, y: yA, z: ang.z }, true);
    }
  });

  curve.curveType = 'chordal';
  texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
  // Keep the strap (often viewed at a steep angle) sharp rather than smeared.
  texture.anisotropy = 16;
  texture.needsUpdate = true;

  return (
    <>
      <group position={[0, 4, 0]}>
        <RigidBody ref={fixed} {...segmentProps} type="fixed" />
        <RigidBody position={[0.5, 0, 0]} ref={j1} {...segmentProps} type="dynamic">
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[1, 0, 0]} ref={j2} {...segmentProps} type="dynamic">
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[1.5, 0, 0]} ref={j3} {...segmentProps} type="dynamic">
          <BallCollider args={[0.1]} />
        </RigidBody>
        <RigidBody position={[2, 0, 0]} ref={card} {...segmentProps} type={dragged ? 'kinematicPosition' : 'dynamic'}>
          <CuboidCollider args={[0.8, 1.125, 0.01]} />
          <group
            scale={2.25}
            position={[0, -1.2, -0.05]}
            onPointerOver={() => hover(true)}
            onPointerOut={() => hover(false)}
            onPointerUp={(e: ThreeEvent<PointerEvent>) => {
              (e.target as Element).releasePointerCapture(e.pointerId);
              drag(false);
            }}
            onPointerDown={(e: ThreeEvent<PointerEvent>) => {
              (e.target as Element).setPointerCapture(e.pointerId);
              drag(new THREE.Vector3().copy((e as any).point).sub(vec.copy(card.current.translation())));
            }}
          >
            <mesh geometry={nodes.card.geometry}>
              <meshPhysicalMaterial
                map={cardMap}
                map-anisotropy={16}
                clearcoat={isMobile ? 0 : 1}
                clearcoatRoughness={0.15}
                roughness={0.9}
                metalness={0.8}
              />
            </mesh>
            <mesh geometry={nodes.clip.geometry} material={materials.metal} material-roughness={0.3} />
            <mesh geometry={nodes.clamp.geometry} material={materials.metal} />
          </group>
        </RigidBody>
      </group>
      <mesh ref={band}>
        <meshLineGeometry />
        <meshLineMaterial
          color="white"
          depthTest={false}
          resolution={isMobile ? [1000, 2000] : [1000, 1000]}
          useMap
          map={texture}
          repeat={[-1, 1]}
          lineWidth={lanyardWidth}
        />
      </mesh>
    </>
  );
}

useGLTF.preload(CARD_GLB);
