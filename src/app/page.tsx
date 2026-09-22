'use client';
import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuthStore } from '@/store/authStore';

export default function Home() {
  const router = useRouter();
  
  // Grab both the authentication status AND the hydration safety flag
  const { isAuthenticated, _hasHydrated } = useAuthStore();

  useEffect(() => {
    // 🛡️ CRITICAL FOR iOS: Do absolutely nothing until Zustand finishes hydrating
    if (!_hasHydrated) return;

    // Once we are completely sure the state is accurate, redirect the user
    if (isAuthenticated) {
      router.replace('/dashboard');
    } else {
      router.replace('/login');
    }
  }, [_hasHydrated, isAuthenticated, router]);

  // Return a clean null or a simple splash spinner so the screen doesn't flicker
  return null;
}