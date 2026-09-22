import {
  collection, doc, getDocs, addDoc, updateDoc,
  query, where, Timestamp,
} from 'firebase/firestore';
import { db } from '@/lib/firebase';
import type { OutstationLocation } from '@/lib/types';

const COL = 'outstation_locations';

export async function getOutstationLocations(activeOnly = true): Promise<OutstationLocation[]> {
  const q = activeOnly
    ? query(collection(db, COL), where('is_active', '==', true))
    : query(collection(db, COL));
  const snap = await getDocs(q);
  return snap.docs.map(d => ({ id: d.id, ...d.data() } as OutstationLocation))
    .sort((a, b) => a.name.localeCompare(b.name));
}

export async function createOutstationLocation(data: { name: string; address: string }): Promise<string> {
  const ref = await addDoc(collection(db, COL), {
    ...data,
    is_active:  true,
    created_at: Timestamp.now(),
  });
  return ref.id;
}

export async function updateOutstationLocation(
  id: string, data: Partial<Pick<OutstationLocation, 'name' | 'address' | 'is_active'>>
): Promise<void> {
  await updateDoc(doc(db, COL, id), data as Record<string, unknown>);
}
