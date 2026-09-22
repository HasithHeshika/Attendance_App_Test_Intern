'use client';
import { useEffect } from 'react';
import Lanyard from './Lanyard';
import { useIdCardTextures } from './idCardCanvas';
import { useCardUser } from './useCardUser';

export default function LanyardCard({
  position = [0, 0, 20],
  gravity = [0, -40, 0],
  paused = false,
  spin = false,
  autoRotate = false,
  onReady,
  onPointerMissed,
}: {
  position?: [number, number, number];
  gravity?: [number, number, number];
  paused?: boolean;
  spin?: boolean;
  autoRotate?: boolean;
  onReady?: () => void;
  onPointerMissed?: () => void;
}) {
  const cardUser = useCardUser();
  const { frontUrl, backUrl, bandUrl, ready } = useIdCardTextures(cardUser);
  // Tell the overlay the card (textures + canvas) is ready, so the login reveal can
  // unpause the physics only once everything's initialised behind the preloader.
  useEffect(() => { if (ready && frontUrl) onReady?.(); }, [ready, frontUrl, onReady]);
  if (!ready || !frontUrl) return null;
  return (
    <Lanyard
      position={position}
      gravity={gravity}
      paused={paused}
      spin={spin}
      autoRotate={autoRotate}
      frontImage={frontUrl}
      backImage={backUrl}
      imageFit="cover"
      lanyardImage={bandUrl}
      lanyardWidth={1}
      onPointerMissed={onPointerMissed}
    />
  );
}
