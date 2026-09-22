'use client';
import { Component, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onReset: () => void;   // called automatically — no UI shown to the user
  // The parent increments this key to force a remount after a crash.
  // We track it so getDerivedStateFromProps can reset crashed → false.
  resetKey?: number;
}
interface State { crashed: boolean; lastResetKey: number | undefined }

// Silent error boundary around LanyardCard. On any WebGL / Three.js / Rapier
// crash it immediately calls onReset (which increments cardKey in the overlay,
// force-remounting the whole canvas tree). The user sees nothing — the card
// just silently restarts.
export default class LanyardErrorBoundary extends Component<Props, State> {
  constructor(props: Props) {
    super(props);
    this.state = { crashed: false, lastResetKey: props.resetKey };
  }

  static getDerivedStateFromError(): Partial<State> {
    return { crashed: true };
  }

  // Reset crashed state when the parent remounts us with a new resetKey.
  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (props.resetKey !== state.lastResetKey) {
      return { crashed: false, lastResetKey: props.resetKey };
    }
    return null;
  }

  componentDidCatch(err: Error) {
    console.warn('[Lanyard] canvas crashed — silently remounting:', err?.message ?? err);
    // Defer so React finishes the current commit before we trigger a re-render.
    setTimeout(() => this.props.onReset(), 0);
  }

  render() {
    // While crashed + waiting for the timeout to fire, render nothing (blank canvas).
    if (this.state.crashed) return null;
    return this.props.children;
  }
}
