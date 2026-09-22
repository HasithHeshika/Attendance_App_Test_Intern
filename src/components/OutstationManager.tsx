'use client';
import { useState, useEffect } from 'react';
import { MapPin, Plus, Edit2, Save, ToggleLeft, ToggleRight } from 'lucide-react';
import toast from 'react-hot-toast';
import { getOutstationLocations, createOutstationLocation, updateOutstationLocation } from '@/services/outstationService';
import type { OutstationLocation } from '@/lib/types';
import { useT } from '@/store/appStore';
import { Button } from '@/components/ui/button';
import { Card } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { Label } from '@/components/ui/label';
import { EmptyState } from '@/components/ui/empty-state';
import { ListSkeleton } from '@/components/ui/Skeleton';
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog';

// Outstation-location CRUD, embedded as a section of the Working Places page.
export default function OutstationManager() {
  const t = useT();
  const [locations, setLocations] = useState<OutstationLocation[]>([]);
  const [loading,   setLoading]   = useState(true);
  const [showForm,  setShowForm]  = useState(false);
  const [editId,    setEditId]    = useState<string | null>(null);
  const [name,      setName]      = useState('');
  const [address,   setAddress]   = useState('');
  const [saving,    setSaving]    = useState(false);

  const load = async () => {
    setLoading(true);
    try { setLocations(await getOutstationLocations(false)); }
    catch (e) { console.error(e); }
    finally    { setLoading(false); }
  };
  useEffect(() => { load(); }, []);

  const openCreate = () => { setName(''); setAddress(''); setEditId(null); setShowForm(true); };
  const openEdit   = (l: OutstationLocation) => { setName(l.name); setAddress(l.address); setEditId(l.id); setShowForm(true); };

  const handleSave = async () => {
    if (!name.trim()) { toast.error(t.nameRequired); return; }
    setSaving(true);
    try {
      if (editId) {
        await updateOutstationLocation(editId, { name: name.trim(), address: address.trim() });
        toast.success(t.locationUpdated);
      } else {
        await createOutstationLocation({ name: name.trim(), address: address.trim() });
        toast.success(t.locationCreated);
      }
      setShowForm(false);
      await load();
    } catch { toast.error(t.failedToSave); }
    finally  { setSaving(false); }
  };

  const toggleActive = async (l: OutstationLocation) => {
    try {
      await updateOutstationLocation(l.id, { is_active: !l.is_active });
      toast.success(l.is_active ? t.locationDeactivated : t.locationActivated);
      await load();
    } catch { toast.error(t.failedGeneric); }
  };

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div>
          <h2 className="text-lg font-semibold tracking-tight text-foreground">{t.outstationLocations}</h2>
          <p className="text-muted-foreground text-xs mt-0.5">{t.canonicalOutstationDesc}</p>
        </div>
        <Button variant="success" size="sm" onClick={openCreate}>
          <Plus className="w-4 h-4" />{t.addLocation}
        </Button>
      </div>

      {loading ? (
        <ListSkeleton rows={4} />
      ) : (
        <div className="space-y-2">
          {locations.map(loc => (
            <Card key={loc.id} className={`p-4 flex items-center gap-4 ${!loc.is_active ? 'opacity-50' : ''}`}>
              <div className="w-9 h-9 rounded-lg bg-success/10 flex items-center justify-center flex-shrink-0">
                <MapPin className="w-4 h-4 text-success" />
              </div>
              <div className="flex-1 min-w-0">
                <div className="text-sm font-semibold text-foreground">{loc.name}</div>
                {loc.address && <div className="text-xs text-muted-foreground mt-0.5 truncate">{loc.address}</div>}
              </div>
              <div className="flex items-center gap-2 flex-shrink-0">
                <Badge variant={loc.is_active ? 'success' : 'muted'}>
                  {loc.is_active ? t.statusActive : t.inactiveWord}
                </Badge>
                <Button variant="ghost" size="icon-sm" onClick={() => openEdit(loc)} aria-label={t.editLocationAria}>
                  <Edit2 className="w-3.5 h-3.5" />
                </Button>
                <Button variant="ghost" size="icon-sm" onClick={() => toggleActive(loc)} aria-label={loc.is_active ? t.deactivateLocationAria : t.activateLocationAria}>
                  {loc.is_active ? <ToggleRight className="w-4 h-4" /> : <ToggleLeft className="w-4 h-4" />}
                </Button>
              </div>
            </Card>
          ))}
          {locations.length === 0 && (
            <Card>
              <EmptyState icon={MapPin} title={t.noOutstationLocations} />
            </Card>
          )}
        </div>
      )}

      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{editId ? t.editLocation : t.newOutstationLocation}</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="outstation-name" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">
                {t.locationName} <span className="text-destructive">*</span>
              </Label>
              <Input id="outstation-name" type="text" value={name} onChange={e => setName(e.target.value)}
                placeholder={t.egOutstationName} />
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="outstation-address" className="text-xs font-semibold text-muted-foreground uppercase tracking-wider">{t.addressLabel}</Label>
              <Textarea id="outstation-address" value={address} onChange={e => setAddress(e.target.value)}
                rows={2} placeholder={t.fullAddressOptional} className="resize-none" />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" className="flex-1" onClick={() => setShowForm(false)}>{t.cancel}</Button>
            <Button className="flex-1" onClick={handleSave} disabled={saving}>
              <Save className="w-4 h-4" />{saving ? t.saving : t.save}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
