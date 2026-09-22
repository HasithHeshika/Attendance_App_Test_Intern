// Ambient shim so the (externally-added) GridScan and Lanyard components'
// `import * as THREE from 'three'` type-check WITHOUT pulling in the full
// @types/three. The full three types activate @react-three/fiber v9's global
// JSX augmentation which, under React 19's `@types/react`, collapses unrelated
// components' intrinsic props to `never` (page-header, stat-card, empty-state,
// animate-ui/slot). Keeping three as `any` here neutralises that augmentation.
// Each member is declared `any` in both value and type space. Covers exactly the
// members GridScan + Lanyard use. The R3F JSX intrinsics live in r3f-jsx.d.ts.
declare module 'three' {
  export const BufferGeometry: any;      export type BufferGeometry = any;
  export const Color: any;               export type Color = any;
  export const MathUtils: any;
  export const Mesh: any;                export type Mesh = any;
  export const NoToneMapping: any;
  export const OrthographicCamera: any;  export type OrthographicCamera = any;
  export const PlaneGeometry: any;       export type PlaneGeometry = any;
  export const SRGBColorSpace: any;
  export const Scene: any;               export type Scene = any;
  export const ShaderMaterial: any;      export type ShaderMaterial = any;
  export const Vector2: any;             export type Vector2 = any;
  export const Vector3: any;             export type Vector3 = any;
  export const WebGLRenderer: any;       export type WebGLRenderer = any;
  // ── additionally used by the Lanyard component ──
  export const CatmullRomCurve3: any;    export type CatmullRomCurve3 = any;
  export const CanvasTexture: any;       export type CanvasTexture = any;
  export const Texture: any;             export type Texture = any;
  export const RepeatWrapping: any;
}
