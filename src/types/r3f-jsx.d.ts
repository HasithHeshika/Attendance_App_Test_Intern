// JSX intrinsics for the @react-three/fiber elements the Lanyard component uses.
// Declared as `any` (per the React Bits TS notes) so we get the elements WITHOUT
// activating R3F v9's full three-derived global augmentation, which conflicts
// with React 19's JSX and breaks unrelated components (see three.d.ts).
import 'react';

declare module 'react' {
  namespace JSX {
    interface IntrinsicElements {
      group: any;
      mesh: any;
      ambientLight: any;
      meshPhysicalMaterial: any;
      meshLineGeometry: any;
      meshLineMaterial: any;
    }
  }
}

declare global {
  namespace JSX {
    interface IntrinsicElements {
      group: any;
      mesh: any;
      ambientLight: any;
      meshPhysicalMaterial: any;
      meshLineGeometry: any;
      meshLineMaterial: any;
    }
  }
}
