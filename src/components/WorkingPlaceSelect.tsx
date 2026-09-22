'use client';
import { MapPin } from 'lucide-react';
import { useWorkingPlaces } from '@/store/workingPlacesStore';
import SearchableSelect from './SearchableSelect';

// Searchable working-place picker (combobox) sourced from the managed `working_places`
// collection — falls back to built-in defaults until an admin configures it.
export default function WorkingPlaceSelect({
  value, onChange, placeholder = 'Select working place', disabled, className,
}: {
  value: string;
  onChange: (name: string) => void;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
}) {
  const { options } = useWorkingPlaces();
  return (
    <SearchableSelect
      value={value}
      onChange={onChange}
      placeholder={placeholder}
      disabled={disabled}
      className={className}
      emptyLabel="No matching places"
      icon={<MapPin className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" />}
      options={options.map(o => ({
        value: o.name,
        label: o.name,
        badge: o.requires_site ? 'site #' : undefined,
        keywords: o.address,
      }))}
    />
  );
}
