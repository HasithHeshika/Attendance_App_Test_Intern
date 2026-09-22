'use client';
import Combobox from '@/components/Combobox';

export interface SelectOption {
  value: string;
  label: string;
  sublabel?: string;
}

interface Props {
  value: string;
  onChange: (value: string) => void;
  options: SelectOption[];
  placeholder?: string;
  /** Legacy no-op — kept for call-site compatibility. The underlying Combobox is always
   *  type-to-filter (you type straight into the field; there is no separate search bar). */
  searchable?: boolean;
  disabled?: boolean;
  allowCustom?: boolean;   // let the typed text stand as a custom value
}

// Thin compatibility shim over <Combobox> so every existing <Select> call site gets the one
// unified dropdown: a combobox whose field IS the search input, portalled so it's never
// clipped by a scrolling/overflow parent. Same public API as before (value / onChange /
// options[{value,label,sublabel}] / placeholder / disabled / allowCustom); `searchable` is
// ignored now that filtering is always on.
export default function Select({
  value, onChange, options, placeholder = 'Select…', disabled = false, allowCustom = false,
}: Props) {
  return (
    <Combobox
      value={value}
      onChange={onChange}
      options={options}
      placeholder={placeholder}
      disabled={disabled}
      allowCustom={allowCustom}
    />
  );
}
