'use client';
import { Edit2, ToggleLeft, ToggleRight, Trash2, Lock, CornerDownRight, Crown, ShieldCheck } from 'lucide-react';
import { CAPABILITY_KEYS, CAPABILITY_LABELS, type Role } from '@/lib/permissions';

// Simple hierarchy table — an easier-to-scan alternative to the drag-and-drop flow chart
// (src/components/RoleFlow.tsx) for tenants that mainly want to read/manage the tree, not
// rewire it. Reparenting isn't supported here; switch to the graph view for that.
export interface RoleTableProps {
  roles: Role[];
  onEdit: (r: Role) => void;
  onToggle: (r: Role) => void;
  onDelete: (r: Role) => void;
}

type Row = { role: Role; depth: number };

// Depth-first walk of the forest, siblings ordered by sort_order — same ordering rule the
// flow chart's layout uses, so the two views agree on where each role "lives".
function flattenForest(roles: Role[]): Row[] {
  const byParent = new Map<string | null, Role[]>();
  for (const r of roles) {
    const key = r.parent_id ?? null;
    if (!byParent.has(key)) byParent.set(key, []);
    byParent.get(key)!.push(r);
  }
  for (const list of byParent.values()) list.sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const ids = new Set(roles.map(r => r.id));
  const rows: Row[] = [];
  const visited = new Set<string>();
  const walk = (parentId: string | null, depth: number) => {
    for (const r of byParent.get(parentId) ?? []) {
      if (visited.has(r.id)) continue; // cycle guard
      visited.add(r.id);
      rows.push({ role: r, depth });
      walk(r.id, depth + 1);
    }
  };
  // Roots: no parent_id, or parent points at a role that no longer exists.
  walk(null, 0);
  for (const r of roles) {
    if (!visited.has(r.id) && (!r.parent_id || !ids.has(r.parent_id))) {
      visited.add(r.id);
      rows.push({ role: r, depth: 0 });
      walk(r.id, 1);
    }
  }
  return rows;
}

export default function RoleTable({ roles, onEdit, onToggle, onDelete }: RoleTableProps) {
  const rows = flattenForest(roles);

  return (
    <>
      {/* Card list — below md. A 4-column table has no way to shrink on a phone: the
          Capabilities column alone can carry a dozen wrapped pills, and a <table>'s columns
          can't reflow the way a card's stacked content can — the table just forced every pill
          onto its own line and pushed the Role column off past the edge of the screen. */}
      <div className="space-y-2 md:hidden">
        {rows.map(({ role, depth }) => {
          const inactive = role.is_active === false;
          const badges = CAPABILITY_KEYS.filter(k => role[k]).map(k => CAPABILITY_LABELS[k].label);
          return (
            <div key={role.id} className={`rounded-xl border border-border p-3 space-y-2 ${inactive ? 'opacity-60' : ''}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex min-w-0 items-center gap-1.5" style={{ paddingLeft: depth * 16 }}>
                  {depth > 0 && <CornerDownRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                  <div className="w-6 h-6 rounded-lg bg-primary/15 flex items-center justify-center flex-shrink-0">
                    <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                  </div>
                  <span className="font-semibold text-foreground truncate">{role.name}</span>
                  {role.is_protected && <Lock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                  {depth === 0 && (
                    <span title="Top tier"><Crown className="w-3.5 h-3.5 text-primary flex-shrink-0" /></span>
                  )}
                </div>
                <span className={`flex-shrink-0 text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                  inactive ? 'bg-muted text-muted-foreground border-border' : 'bg-success/15 text-success border-success/30'}`}>
                  {inactive ? 'Inactive' : 'Active'}
                </span>
              </div>
              {badges.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  {badges.map(b => (
                    <span key={b} className="text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">
                      {b}
                    </span>
                  ))}
                </div>
              )}
              <div className="flex items-center justify-end gap-1 pt-1">
                <button onClick={() => onEdit(role)} aria-label={`Edit ${role.name}`} title="Edit"
                  className="w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-primary transition-colors">
                  <Edit2 className="w-3.5 h-3.5" />
                </button>
                <button onClick={() => onToggle(role)} aria-label={role.is_active ? `Deactivate ${role.name}` : `Activate ${role.name}`} title={role.is_active ? 'Deactivate' : 'Activate'}
                  className="w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                  {role.is_active ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                </button>
                <button onClick={() => onDelete(role)} disabled={role.is_protected} aria-label={`Delete ${role.name}`} title="Delete"
                  className="w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
          );
        })}
      </div>

      {/* Table — md and up, where a fixed 4-column layout actually has room to breathe. */}
      <div className="hidden overflow-x-auto rounded-2xl border border-border md:block">
        <table className="w-full text-sm">
          <thead>
            <tr className="bg-muted/40 text-left text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
              <th className="px-4 py-2.5">Role</th>
              <th className="px-4 py-2.5">Capabilities</th>
              <th className="px-4 py-2.5">Status</th>
              <th className="px-4 py-2.5 text-right">Actions</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-border">
            {rows.map(({ role, depth }) => {
              const inactive = role.is_active === false;
              const badges = CAPABILITY_KEYS.filter(k => role[k]).map(k => CAPABILITY_LABELS[k].label);
              return (
                <tr key={role.id} className={inactive ? 'opacity-60' : ''}>
                  <td className="px-4 py-2.5 align-top">
                    <div className="flex items-center gap-1.5" style={{ paddingLeft: depth * 20 }}>
                      {depth > 0 && <CornerDownRight className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                      <div className="w-6 h-6 rounded-lg bg-primary/15 flex items-center justify-center flex-shrink-0">
                        <ShieldCheck className="w-3.5 h-3.5 text-primary" />
                      </div>
                      <span className="font-semibold text-foreground truncate">{role.name}</span>
                      {role.is_protected && <Lock className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
                      {depth === 0 && (
                        <span title="Top tier"><Crown className="w-3.5 h-3.5 text-primary flex-shrink-0" /></span>
                      )}
                    </div>
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    {badges.length > 0 ? (
                      <div className="flex flex-wrap gap-1 max-w-md">
                        {badges.map(b => (
                          <span key={b} className="text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">
                            {b}
                          </span>
                        ))}
                      </div>
                    ) : (
                      <span className="text-muted-foreground/50">—</span>
                    )}
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full border ${
                      inactive ? 'bg-muted text-muted-foreground border-border' : 'bg-success/15 text-success border-success/30'}`}>
                      {inactive ? 'Inactive' : 'Active'}
                    </span>
                  </td>
                  <td className="px-4 py-2.5 align-top">
                    <div className="flex items-center justify-end gap-1">
                      <button onClick={() => onEdit(role)} aria-label={`Edit ${role.name}`} title="Edit"
                        className="w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-primary transition-colors">
                        <Edit2 className="w-3.5 h-3.5" />
                      </button>
                      <button onClick={() => onToggle(role)} aria-label={role.is_active ? `Deactivate ${role.name}` : `Activate ${role.name}`} title={role.is_active ? 'Deactivate' : 'Activate'}
                        className="w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
                        {role.is_active ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
                      </button>
                      <button onClick={() => onDelete(role)} disabled={role.is_protected} aria-label={`Delete ${role.name}`} title="Delete"
                        className="w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </>
  );
}
