'use client';
// Shared "pick employees" widget — Single / Multiple / By Department / By Designation /
// All. Used by both the Monthly Run "Load Employees" dialog and the Payroll Employees
// "Bulk Add" dialog. Takes a pre-filtered candidate list (each caller decides eligibility
// itself — e.g. "already has a payroll profile" vs "doesn't have one yet") and reports the
// currently-selected subset back via onSelectionChange.

import { useEffect, useMemo, useState } from 'react';
import { Search } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Checkbox } from '@/components/ui/checkbox';
import { Tabs, TabsList, TabsTrigger, TabsContent } from '@/components/ui/tabs';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import type { AppUser } from '@/lib/types';

export type EmployeeSelectMode = 'single' | 'multiple' | 'department' | 'designation' | 'all';

export function EmployeeSelectorTabs({
  candidates, onSelectionChange, allLabel,
}: {
  candidates: AppUser[];
  onSelectionChange: (selected: AppUser[]) => void;
  /** Text shown on the "All" tab, e.g. "Creates a default profile for all 12 employee(s)." */
  allLabel?: (count: number) => string;
}) {
  const [mode, setMode] = useState<EmployeeSelectMode>('single');
  const [search, setSearch] = useState('');
  const [singleEpf, setSingleEpf] = useState('');
  const [multiEpfs, setMultiEpfs] = useState<Set<string>>(new Set());
  const [department, setDepartment] = useState('');
  const [designation, setDesignation] = useState('');

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return candidates;
    return candidates.filter(u => [u.display_name, u.first_name, u.last_name, u.epf_number, u.employee_number]
      .filter(Boolean).join(' ').toLowerCase().includes(q));
  }, [candidates, search]);

  const departments = useMemo(() => Array.from(new Set(candidates.map(u => u.department).filter(Boolean))).sort(), [candidates]);
  const designations = useMemo(() => Array.from(new Set(candidates.map(u => u.designation).filter(Boolean))).sort(), [candidates]);

  const toggleMulti = (epf: string, checked: boolean) => {
    setMultiEpfs(prev => {
      const next = new Set(prev);
      if (checked) next.add(epf); else next.delete(epf);
      return next;
    });
  };

  const targetList = useMemo<AppUser[]>(() => {
    if (mode === 'single') return candidates.filter(u => u.epf_number === singleEpf);
    if (mode === 'multiple') return candidates.filter(u => multiEpfs.has(u.epf_number));
    if (mode === 'department') return candidates.filter(u => u.department === department);
    if (mode === 'designation') return candidates.filter(u => u.designation === designation);
    return candidates; // 'all'
  }, [mode, candidates, singleEpf, multiEpfs, department, designation]);

  useEffect(() => { onSelectionChange(targetList); }, [targetList, onSelectionChange]);

  return (
    <Tabs value={mode} onValueChange={v => setMode(v as EmployeeSelectMode)}>
      <TabsList className="flex-wrap h-auto">
        <TabsTrigger value="single">Single</TabsTrigger>
        <TabsTrigger value="multiple">Multiple</TabsTrigger>
        <TabsTrigger value="department">By Department</TabsTrigger>
        <TabsTrigger value="designation">By Designation</TabsTrigger>
        <TabsTrigger value="all">All</TabsTrigger>
      </TabsList>

      <TabsContent value="single" className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="max-h-56 overflow-y-auto space-y-1">
          {filtered.map(u => (
            <button key={u.epf_number} type="button" onClick={() => setSingleEpf(u.epf_number)}
              className={`w-full text-left px-3 py-2 rounded-lg text-sm transition-colors ${singleEpf === u.epf_number ? 'bg-primary/10 text-primary' : 'hover:bg-muted/60 text-foreground'}`}>
              {u.display_name} <span className="text-muted-foreground text-xs">· {u.epf_number}{u.designation ? ` · ${u.designation}` : ''}</span>
            </button>
          ))}
          {filtered.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No employees found.</p>}
        </div>
      </TabsContent>

      <TabsContent value="multiple" className="space-y-2">
        <div className="relative">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
          <Input className="pl-9" placeholder="Search employee…" value={search} onChange={e => setSearch(e.target.value)} />
        </div>
        <div className="max-h-56 overflow-y-auto space-y-1">
          {filtered.map(u => (
            <label key={u.epf_number} className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm hover:bg-muted/60 cursor-pointer">
              <Checkbox checked={multiEpfs.has(u.epf_number)} onCheckedChange={v => toggleMulti(u.epf_number, v === true)} />
              <span>{u.display_name} <span className="text-muted-foreground text-xs">· {u.epf_number}</span></span>
            </label>
          ))}
          {filtered.length === 0 && <p className="text-xs text-muted-foreground text-center py-4">No employees found.</p>}
        </div>
        {multiEpfs.size > 0 && <p className="text-xs text-muted-foreground">{multiEpfs.size} selected</p>}
      </TabsContent>

      <TabsContent value="department" className="space-y-2">
        <Select value={department} onValueChange={setDepartment}>
          <SelectTrigger><SelectValue placeholder="Select department" /></SelectTrigger>
          <SelectContent>{departments.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
        </Select>
        {department && <p className="text-xs text-muted-foreground">{candidates.filter(u => u.department === department).length} employee(s) in {department}.</p>}
        {departments.length === 0 && <p className="text-xs text-muted-foreground">No department data on these employees.</p>}
      </TabsContent>

      <TabsContent value="designation" className="space-y-2">
        <Select value={designation} onValueChange={setDesignation}>
          <SelectTrigger><SelectValue placeholder="Select designation" /></SelectTrigger>
          <SelectContent>{designations.map(d => <SelectItem key={d} value={d}>{d}</SelectItem>)}</SelectContent>
        </Select>
        {designation && <p className="text-xs text-muted-foreground">{candidates.filter(u => u.designation === designation).length} employee(s) as {designation}.</p>}
        {designations.length === 0 && <p className="text-xs text-muted-foreground">No designation data on these employees.</p>}
      </TabsContent>

      <TabsContent value="all">
        <p className="text-sm text-muted-foreground">{allLabel ? allLabel(candidates.length) : `${candidates.length} employee(s) selected.`}</p>
      </TabsContent>
    </Tabs>
  );
}
