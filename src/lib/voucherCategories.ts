// Grouping a voucher's bills by their suspense category, with a subtotal for each.
//
// A voucher is a rolling set of approved bills across any category, and its only figure is one
// grand total — which answers "how much" but never "on what". Finance reconciles these against
// expense heads, so the breakdown is the part they actually need.
//
// Pure and Firestore-free so the arithmetic is unit-tested (src/lib/__tests__/voucherCategories
// .test.ts); VoucherReport just renders what this returns.
import type { SuspenseSubmission } from './types';

/** Where a bill with no category lands. Not a category — a bucket, and it always sorts last. */
export const UNCATEGORISED = 'Uncategorised';

/** The category a bill counts under. Legacy bills predate the category/subcategory split and
 *  carry only `expense_type`, the derived "Category · Subcategory · Type" label — its first
 *  segment is the category, so those still group with their modern siblings instead of all
 *  falling into one "Uncategorised" heap. */
export function voucherCategoryOf(s: Pick<SuspenseSubmission, 'category' | 'expense_type'>): string {
  const c = (s.category ?? '').trim();
  if (c) return c;
  const legacy = (s.expense_type ?? '').split('·')[0].trim();
  return legacy || UNCATEGORISED;
}

export interface VoucherCategoryGroup {
  category: string;
  bills:    SuspenseSubmission[];
  /** Sum of the bills' full amounts — the same figure the voucher totals, so the groups add up
   *  to it exactly. NOT the own-share: a voucher reimburses the whole bill. */
  total:    number;
  vat:      number;
  count:    number;
}

const round2 = (n: number) => Math.round((Number(n) || 0) * 100) / 100;

/** One group per category, biggest spend first — the order answers "what did this voucher
 *  mostly go on" at a glance. Ties break alphabetically so the list is stable between renders,
 *  and the uncategorised bucket is pinned last however large it is. Bills keep the order they
 *  arrived in within a group. */
export function groupBillsByCategory(bills: SuspenseSubmission[]): VoucherCategoryGroup[] {
  const byCategory = new Map<string, VoucherCategoryGroup>();
  for (const s of bills) {
    if (!s) continue;
    const category = voucherCategoryOf(s);
    let g = byCategory.get(category);
    if (!g) { g = { category, bills: [], total: 0, vat: 0, count: 0 }; byCategory.set(category, g); }
    g.bills.push(s);
    g.total = round2(g.total + (Number(s.amount) || 0));
    g.vat   = round2(g.vat + (Number(s.vat_amount) || 0));
    g.count += 1;
  }
  return [...byCategory.values()].sort((a, b) => {
    const aLast = a.category === UNCATEGORISED, bLast = b.category === UNCATEGORISED;
    if (aLast !== bLast) return aLast ? 1 : -1;
    return (b.total - a.total) || a.category.localeCompare(b.category);
  });
}
