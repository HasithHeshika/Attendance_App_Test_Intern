// `@react-three/fiber` v9 creates its render-loop clock with `new THREE.Clock()`
// (see node_modules/@react-three/fiber/.../events-*.js). three r184 deprecated
// THREE.Clock in favour of THREE.Timer, so fiber's internal use logs a one-time
// deprecation warning we cannot fix at the source without bumping fiber (which
// drives the tuned Lanyard physics). Silence *only* that exact message; every
// other console.warn passes through untouched. Idempotent + client-only.
let installed = false;

export function silenceThreeClockWarning(): void {
  if (installed || typeof window === 'undefined') return;
  installed = true;
  const original = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const first = args[0];
    if (typeof first === 'string' && first.includes('THREE.Clock: This module has been deprecated')) {
      return; // known, harmless @react-three/fiber internal deprecation
    }
    original(...args);
  };
}
