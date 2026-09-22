'use client';
import { useEffect, useState } from 'react';
import { useAuthStore } from '@/store/authStore';
import Cookies from 'js-cookie';

export default function DebugPage() {
  const { user, isAuthenticated } = useAuthStore();
  const [cookies, setCookies] = useState<Record<string, string>>({});
  const [ls, setLs] = useState<string>('');

  useEffect(() => {
    setCookies(Cookies.get());
    setLs(localStorage.getItem('user-profile') || 'empty');
  }, []);

  return (
    <div className="p-8 font-mono text-sm text-foreground space-y-6">
      <h1 className="text-xl font-bold text-primary">Auth Debug</h1>

      <div className="space-y-1">
        <div className="text-muted-foreground uppercase tracking-widest text-xs">Zustand State</div>
        <div>isAuthenticated: <span className={isAuthenticated ? 'text-success' : 'text-destructive'}>{String(isAuthenticated)}</span></div>
        <div>user: <span className="text-warning">{user ? JSON.stringify(user, null, 2) : 'null'}</span></div>
      </div>

      <div className="space-y-1">
        <div className="text-muted-foreground uppercase tracking-widest text-xs">All JS-readable Cookies</div>
        {Object.keys(cookies).length === 0
          ? <div className="text-destructive">No cookies readable by JS</div>
          : Object.entries(cookies).map(([k, v]) => (
            <div key={k}><span className="text-primary">{k}</span>: <span className="text-warning">{v}</span></div>
          ))
        }
      </div>

      <div className="space-y-1">
        <div className="text-muted-foreground uppercase tracking-widest text-xs">localStorage[user-profile]</div>
        <pre className="text-warning text-xs whitespace-pre-wrap">{ls}</pre>
      </div>
    </div>
  );
}
