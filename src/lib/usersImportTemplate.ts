'use client';
// Bulk Import Users (southernlanka/carecode.org only — see /users/bulk-add). Column list is
// shared between the downloadable template built here and the upload parser in
// usersImportParse.ts, so the two never drift apart — `key` is what the parser matches a
// sheet's header row against and stores the raw cell text under.

export type UsersImportFieldKey =
  | 'full_name'
  | 'name_with_initials'
  | 'role_text'
  | 'department_text'
  | 'nic'
  | 'epf_number'
  | 'employee_number'
  | 'email'
  | 'date_of_join'
  | 'gender'
  | 'date_of_birth'
  | 'address'
  | 'phone_personal'
  | 'guardian_contact'
  | 'company_text';

export interface UsersImportColumn {
  key: UsersImportFieldKey;
  header: string;
  example: string;
}

export const USERS_IMPORT_COLUMNS: UsersImportColumn[] = [
  { key: 'full_name', header: 'Full Name', example: 'John Deo' },
  {
    key: 'name_with_initials',
    header: 'Name with Initials',
    example: 'J. Deo',
  },
  { key: 'role_text', header: 'Designation(Role)', example: 'Nurse' },
  {
    key: 'department_text',
    header: 'Department(Category)',
    example: 'Nursing Officer',
  },
  { key: 'nic', header: 'ID Number', example: '200012345678' },
  { key: 'epf_number', header: 'EPF Number', example: 'SLH/E123' },
  { key: 'employee_number', header: 'Employee No', example: 'SLH/E123' },
  { key: 'email', header: 'Email', example: 'johndeo@gmail.com' },
  { key: 'date_of_join', header: 'Date Of Join', example: '2026-01-15' },
  { key: 'gender', header: 'Gender', example: 'Male' },
  { key: 'date_of_birth', header: 'Date of Birth', example: '2000-05-20' },
  { key: 'address', header: 'Address', example: '123, Main Street, Galle' },
  { key: 'phone_personal', header: 'Contact Number', example: '0771234567' },
  {
    key: 'guardian_contact',
    header: 'Guardian Contact Number',
    example: '07771234568',
  },
  {
    key: 'company_text',
    header: 'Branch(Company)',
    example: 'Southern Lanka Hospitals (Main)',
  },
];

export async function downloadUsersImportTemplate(): Promise<void> {
  const { utils, writeFile } = await import('xlsx');
  const wb = utils.book_new();

  const headerRow = USERS_IMPORT_COLUMNS.map((c) => c.header);
  const exampleRow = USERS_IMPORT_COLUMNS.map((c) => c.example);
  const sheet = utils.aoa_to_sheet([headerRow, exampleRow]);
  sheet['!cols'] = USERS_IMPORT_COLUMNS.map((c) => ({
    wch: Math.max(c.header.length, c.example.length) + 2,
  }));
  utils.book_append_sheet(wb, sheet, 'Users');

  writeFile(wb, 'users_import_template.xlsx');
}
