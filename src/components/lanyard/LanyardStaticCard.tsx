'use client';
import { motion, useReducedMotion } from 'framer-motion';
import { useIdCardTextures } from './idCardCanvas';
import { useCardUser } from './useCardUser';

export default function LanyardStaticCard({ className = '' }: { className?: string }) {
  const cardUser = useCardUser();
  const { frontUrl, ready } = useIdCardTextures(cardUser);
  const reduce = useReducedMotion();
  if (!ready || !frontUrl) return null;
  return (
    <div className={`flex items-center justify-center ${className}`}>
      <motion.img
        src={frontUrl}
        alt=""
        draggable={false}
        onClick={(e) => e.stopPropagation()}
        initial={{ y: reduce ? 0 : -24, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.5, ease: [0.22, 1, 0.36, 1] }}
        className="w-[270px] max-w-[80vw] rounded-2xl shadow-2xl ring-1 ring-black/10"
      />
    </div>
  );
}
