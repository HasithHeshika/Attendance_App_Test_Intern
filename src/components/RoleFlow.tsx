'use client';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import ReactFlow, {
  Background, Controls, MiniMap, Handle, Position, Panel, ReactFlowProvider,
  useNodesState, useEdgesState, useReactFlow, MarkerType, ConnectionLineType,
  type Node, type Edge, type NodeProps, type Connection,
} from 'reactflow';
import 'reactflow/dist/style.css';
import { ShieldCheck, Edit2, ToggleLeft, ToggleRight, Trash2, Lock, CornerDownRight, Crown } from 'lucide-react';
import toast from 'react-hot-toast';
import { CAPABILITY_KEYS, CAPABILITY_LABELS, descendantRoleIdsOf, roleCategory, categoryLabel, type Role } from '@/lib/permissions';
import { tenant } from '@/lib/firebase';

// Southern Lanka (carecode.org) only — the category (Technician/Executive/Top Management) chip
// is hidden on each node for this tenant, matching the category picker being hidden on the
// Roles page form (src/app/(pages)/roles/page.tsx).
const isSouthernlanka = tenant.id === 'southernlanka';

// ─── Theme ───────────────────────────────────────────────────────────────────
// The app toggles `.light` / `.dark` on <html>; watch it so the canvas chrome
// (dots, minimap) matches. Edges/controls/handles are themed via globals.css.
function useIsLight() {
  const [light, setLight] = useState(false);
  useEffect(() => {
    const el = document.documentElement;
    const read = () => setLight(el.classList.contains('light'));
    read();
    const obs = new MutationObserver(read);
    obs.observe(el, { attributes: true, attributeFilter: ['class'] });
    return () => obs.disconnect();
  }, []);
  return light;
}

// ─── Layout ──────────────────────────────────────────────────────────────────
// Roles form a forest (several "top level" roots). Lay each tree out top-down with a
// tidy-tree pass: leaves take sequential x slots, a parent is centred over its children.
const NODE_W = 330;
const X_GAP  = 40;
const ROW_H  = 220;   // vertical distance between tiers (node height + breathing room)

function layoutForest(roles: Role[]): Record<string, { x: number; y: number }> {
  const pos: Record<string, { x: number; y: number }> = {};
  const byId = new Map(roles.map(r => [r.id, r]));
  const sorted = [...roles].sort((a, b) => (a.sort_order ?? 0) - (b.sort_order ?? 0));
  const childrenOf = (id: string | null) => sorted.filter(r => (r.parent_id ?? null) === id);
  // A role with no parent — or whose parent is missing — is a root.
  const isRoot = (r: Role) => !r.parent_id || !byId.has(r.parent_id);
  const roots = sorted.filter(isRoot);

  const slot = NODE_W + X_GAP;
  let nextLeafX = 0;
  const visited = new Set<string>();
  const place = (node: Role, depth: number): number => {
    if (visited.has(node.id)) return pos[node.id]?.x ?? 0; // cycle guard
    visited.add(node.id);
    const kids = childrenOf(node.id).filter(k => k.id !== node.id);
    let x: number;
    if (kids.length === 0) {
      x = nextLeafX * slot;
      nextLeafX += 1;
    } else {
      const xs = kids.map(k => place(k, depth + 1));
      x = (xs[0] + xs[xs.length - 1]) / 2;
    }
    pos[node.id] = { x, y: depth * ROW_H };
    return x;
  };
  // Roots that actually approve someone get the tidy-tree pass. Roots with no children are laid
  // out separately, BELOW the trees, wrapped into a grid: before any hierarchy has been
  // configured every role is a childless root, and putting them all on one row made the canvas
  // thousands of pixels wide, so fitView bottomed out at minZoom and every node was unreadable.
  // A childless root is still top tier — its own Crown badge says so — this only stops that tier
  // running off the screen.
  const hasKids   = (r: Role) => childrenOf(r.id).some(k => k.id !== r.id);
  const treeRoots = roots.filter(hasKids);
  const loneRoots = roots.filter(r => !hasKids(r));

  treeRoots.forEach(r => place(r, 0));

  const lowestY = () => Object.values(pos).reduce((max, p) => Math.max(max, p.y), -ROW_H);
  const grid = (list: Role[], cols: number, baseY: number) => {
    list.forEach((r, i) => {
      visited.add(r.id);
      pos[r.id] = { x: (i % cols) * slot, y: baseY + Math.floor(i / cols) * ROW_H };
    });
  };

  if (loneRoots.length) {
    // Keep the block roughly as wide as the trees above it, within readable bounds.
    const cols = Math.min(loneRoots.length, Math.max(4, Math.min(6, nextLeafX || 4)));
    grid(loneRoots, cols, treeRoots.length ? lowestY() + ROW_H : 0);
  }

  // Any node skipped by a broken parent link still needs a position.
  const skipped = sorted.filter(r => !pos[r.id]);
  if (skipped.length) grid(skipped, 4, lowestY() + ROW_H);
  return pos;
}

// ─── Node action handlers (via context, so they stay current without rebuilding the
// graph — the page re-creates these callbacks on every render) ─────────────────
type RoleHandlers = {
  onEdit: (r: Role) => void;
  onToggle: (r: Role) => void;
  onDelete: (r: Role) => void;
};
const HandlersCtx = createContext<RoleHandlers>({ onEdit: () => {}, onToggle: () => {}, onDelete: () => {} });

// ─── Custom node ─────────────────────────────────────────────────────────────
type RoleNodeData = { role: Role; parentName: string | null; category: ReturnType<typeof roleCategory> };

// Colours for the category chip on each node.
const CATEGORY_CHIP: Record<string, string> = {
  technician:     'bg-success/15 text-success border-success/30',
  executive:      'bg-primary/15 text-primary border-primary/30',
  top_management: 'bg-brand/15 text-brand border-brand/30',
};

function RoleFlowNode({ data }: NodeProps<RoleNodeData>) {
  const { role, parentName, category } = data;
  const { onEdit, onToggle, onDelete } = useContext(HandlersCtx);
  const badges = CAPABILITY_KEYS.filter(k => role[k]).map(k => CAPABILITY_LABELS[k].label);
  const inactive = role.is_active === false;
  // A colour bar that tells the role's category apart at a glance.
  const accent = role.is_system_admin ? 'bg-destructive'
    : !role.is_employee ? 'bg-brand'
    : role.can_approve ? 'bg-primary'
    : 'bg-success';

  return (
    <div
      className={`relative w-[330px] rounded-2xl px-3.5 py-3 border-2 transition-colors
        bg-card text-card-foreground
        shadow-[0_6px_20px_rgba(2,6,23,0.16)] dark:shadow-[0_10px_30px_rgba(0,0,0,0.5)]
        ${inactive ? 'opacity-60' : ''}
        ${role.is_system_admin
          ? 'border-destructive/60'
          : 'border-border hover:border-primary/70'}`}
    >
      {/* Incoming edge from the approver tier (parent) */}
      <Handle type="target" position={Position.Top} title="Approver connects here" />
      {/* Category accent */}
      <div className={`absolute left-0 top-3 bottom-3 w-1 rounded-full ${accent}`} />

      <div className="pl-2">
        <div className="flex items-start gap-2">
          <div className="w-8 h-8 rounded-xl bg-primary/15 flex items-center justify-center flex-shrink-0">
            <ShieldCheck className="w-4 h-4 text-primary" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5 flex-wrap">
              <span className="text-base font-bold text-foreground truncate">{role.name}</span>
              {role.is_protected && <Lock className="w-3.5 h-3.5 text-muted-foreground" />}
              {!isSouthernlanka && (
                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded-full border ${CATEGORY_CHIP[category]}`}>
                  {categoryLabel(category)}
                </span>
              )}
              {!role.is_employee && (
                <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-full bg-brand/15 text-brand border border-brand/30">
                  Non-emp
                </span>
              )}
            </div>
            {/* Explicit parent (who approves this role) */}
            {parentName ? (
              <span className="mt-0.5 inline-flex items-center gap-1 text-xs text-muted-foreground">
                <CornerDownRight className="w-3.5 h-3.5 text-primary flex-shrink-0" />
                approved by <span className="font-semibold text-foreground">{parentName}</span>
              </span>
            ) : (
              <span className="mt-0.5 inline-flex items-center gap-1 text-xs font-semibold text-primary">
                <Crown className="w-3.5 h-3.5" /> Top tier
              </span>
            )}
          </div>
          {/* Actions — `nodrag` so clicking them doesn't start a node drag */}
          <div className="flex items-center gap-1 flex-shrink-0">
            <button onClick={() => onEdit(role)}
              className="nodrag w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-primary transition-colors">
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            <button onClick={() => onToggle(role)}
              className="nodrag w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-foreground transition-colors">
              {role.is_active ? <ToggleRight className="w-3.5 h-3.5" /> : <ToggleLeft className="w-3.5 h-3.5" />}
            </button>
            <button onClick={() => onDelete(role)} disabled={role.is_protected}
              className="nodrag w-7 h-7 rounded-md bg-muted hover:bg-accent flex items-center justify-center text-muted-foreground hover:text-destructive transition-colors disabled:opacity-30">
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {badges.length > 0 && (
          <div className="flex flex-wrap gap-1 mt-2">
            {badges.map(b => (
              <span key={b} className="text-[11px] font-semibold px-2 py-0.5 rounded-full border bg-muted text-muted-foreground border-border">
                {b}
              </span>
            ))}
          </div>
        )}
      </div>

      {/* Outgoing edge down to the roles this one approves (children) */}
      <Handle type="source" position={Position.Bottom} title="Drag to a role's top dot to approve it" />
    </div>
  );
}

// Stable reference — defining inside the component would remount every node each render.
const nodeTypes = { role: RoleFlowNode };

// ─── Graph ───────────────────────────────────────────────────────────────────
export interface RoleFlowProps extends RoleHandlers {
  roles: Role[];
  // childId now reports to parentId (null = make it a top-level role)
  onReparent: (childId: string, parentId: string | null) => void;
}

function Flow({ roles, onEdit, onToggle, onDelete, onReparent }: RoleFlowProps) {
  const isLight = useIsLight();
  const { fitView } = useReactFlow();
  const wrapRef = useRef<HTMLDivElement>(null);

  // Re-centre the diagram whenever the canvas changes size (window resize, sidebar
  // toggle, etc.). Also corrects the first paint once the container settles.
  useEffect(() => {
    const el = wrapRef.current;
    if (!el) return;
    let raf = 0;
    const refit = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => fitView({ padding: 0.18, duration: 250 }));
    };
    const ro = new ResizeObserver(refit);
    ro.observe(el);
    return () => { ro.disconnect(); cancelAnimationFrame(raf); };
  }, [fitView]);

  // Layout + edges depend ONLY on the role data, so the graph isn't rebuilt (and pan/zoom
  // isn't lost) when the page re-renders for unrelated reasons (e.g. typing in the modal).
  const built = useMemo(() => {
    const pos = layoutForest(roles);
    const nameById = new Map(roles.map(r => [r.id, r.name]));
    const nodes: Node<RoleNodeData>[] = roles.map(r => ({
      id: r.id,
      type: 'role',
      position: pos[r.id] ?? { x: 0, y: 0 },
      data: {
        role: r,
        parentName: r.parent_id ? (nameById.get(r.parent_id) ?? null) : null,
        category: roleCategory(r.name, roles),
      },
    }));
    const edges: Edge[] = roles
      .filter(r => r.parent_id && roles.some(x => x.id === r.parent_id))
      .map(r => ({
        id: `${r.parent_id}->${r.id}`,
        source: r.parent_id as string,
        target: r.id,
        type: 'smoothstep',
        animated: true,                 // moving dashes make the approver link obvious
        markerEnd: { type: MarkerType.ArrowClosed, color: '#0ea5e9', width: 18, height: 18 },
      }));
    return { nodes, edges };
  }, [roles]);

  const [nodes, setNodes, onNodesChange] = useNodesState(built.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(built.edges);

  // Re-sync (and re-tidy) whenever the role registry or its hierarchy changes.
  useEffect(() => { setNodes(built.nodes); setEdges(built.edges); }, [built, setNodes, setEdges]);

  const handlers = useMemo<RoleHandlers>(() => ({ onEdit, onToggle, onDelete }), [onEdit, onToggle, onDelete]);

  // Dragging a connection from a parent's bottom handle to a child's top handle
  // re-parents that child (sets who approves it).
  const onConnect = useCallback((c: Connection) => {
    const parentId = c.source;
    const childId  = c.target;
    if (!parentId || !childId || parentId === childId) return;
    if (descendantRoleIdsOf(childId, roles).has(parentId)) {
      toast.error('That would create a loop — pick a higher tier');
      return;
    }
    onReparent(childId, parentId);
  }, [roles, onReparent]);

  // Selecting an edge and pressing Delete detaches the child to the top level.
  const onEdgesDelete = useCallback((removed: Edge[]) => {
    removed.forEach(e => onReparent(e.target, null));
  }, [onReparent]);

  const miniNodeColor = useCallback((n: Node) => {
    const r = (n.data as RoleNodeData)?.role;
    if (!r) return '#64748b';
    return r.is_system_admin ? '#f43f5e' : !r.is_employee ? '#a78bfa' : r.can_approve ? '#0ea5e9' : '#10b981';
  }, []);

  return (
    <div ref={wrapRef} className="h-[72vh] rounded-2xl overflow-hidden glass">
      <HandlersCtx.Provider value={handlers}>
        <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onConnect={onConnect}
        onEdgesDelete={onEdgesDelete}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.18 }}
        minZoom={0.2}
        maxZoom={1.6}
        defaultEdgeOptions={{ type: 'smoothstep' }}
        connectionLineType={ConnectionLineType.SmoothStep}
      >
        <Panel position="top-right">
          <div className="glass rounded-xl px-3 py-2 text-[10px] text-muted-foreground space-y-1.5">
            <div className="flex items-center gap-3 flex-wrap">
              <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-destructive" /> System admin</span>
              <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-brand" /> Non-employee</span>
              <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-primary" /> Approver</span>
              <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-success" /> Employee</span>
            </div>
            <div className="flex items-center gap-3 flex-wrap text-muted-foreground">
              <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-primary ring-2 ring-border" /> top dot = approver in</span>
              <span className="inline-flex items-center gap-1"><i className="w-2 h-2 rounded-full bg-success ring-2 ring-border" /> bottom dot = approves out</span>
            </div>
          </div>
        </Panel>
        <Background color={isLight ? '#cbd5e1' : '#334155'} gap={22} size={1} />
        <Controls showInteractive={false} />
        <MiniMap
          pannable zoomable
          maskColor={isLight ? 'rgba(15,23,42,0.08)' : 'rgba(2,6,23,0.55)'}
          nodeColor={miniNodeColor}
          nodeStrokeWidth={0}
        />
        </ReactFlow>
      </HandlersCtx.Provider>
    </div>
  );
}

export default function RoleFlow(props: RoleFlowProps) {
  return (
    <ReactFlowProvider>
      <Flow {...props} />
    </ReactFlowProvider>
  );
}
