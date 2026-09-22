/**
 * convert-sql.mjs
 *
 * Converts the av_master MySQL dump to a Firestore-compatible JSON snapshot.
 * Run with: node scripts/convert-sql.mjs av_master.sql
 * Output:   firestore-seed.json
 *
 * The output JSON is structured as:
 * {
 *   "users": { [epf_number]: { ...AppUser } },
 *   "companies": { [id]: { ...Company } },
 *   "attendances": { [epf_date]: { ...AttendanceRecord } },
 *   "attendance_edit_requests": { [id]: { ...EditRequest } },
 *   "leaves": { [id]: { ...Leave } },
 *   "leave_types": { [id]: { ...LeaveType } },
 *   "outstation_locations": {},   // empty — admin fills this post-migration
 *   "leave_balances": {},         // computed from leaves if needed
 * }
 *
 * Timestamps are stored as ISO 8601 strings — the seeder converts them to
 * Firestore Timestamps on upload.
 */

import fs from 'fs';
import path from 'path';

// Flags may appear in any position; the first non-flag arg is the SQL file.
//   --data-only / --keep-users  → emit leaves + attendance only (users, companies and
//                                 leave_types are left empty so an import OVERRIDES leaves
//                                 and attendance without touching existing users/Auth).
const argv     = process.argv.slice(2);
const flags    = new Set(argv.filter(a => a.startsWith('--')));
const sqlFile  = argv.find(a => !a.startsWith('--'));
const dataOnly = flags.has('--data-only') || flags.has('--keep-users');
if (!sqlFile) {
  console.error('Usage: node scripts/convert-sql.mjs <path-to-sql-file> [--data-only]');
  process.exit(1);
}

const sql = fs.readFileSync(sqlFile, 'utf-8');

// ─── Generic SQL INSERT parser ─────────────────────────────────────────────────
function parseInserts(sql, tableName) {
  const rows = [];
  // Match INSERT INTO `tableName` (...cols...) VALUES (...), (...);
  const insertPattern = new RegExp(
    `INSERT INTO \`${tableName}\`[\\s\\S]*?\\(([^)]+)\\) VALUES([\\s\\S]*?);`,
    'g'
  );

  let match;
  while ((match = insertPattern.exec(sql)) !== null) {
    const cols = match[1]
      .split(',')
      .map(c => c.trim().replace(/`/g, '').replace(/\s+/g, ''));

    const valueBlock = match[2];
    // Split on ),( boundaries — but values can contain parens, so we need a
    // proper tokenizer
    const entries = tokenizeValueBlock(valueBlock);

    for (const entry of entries) {
      const values = parseValueList(entry);
      if (values.length !== cols.length) continue;
      const row = {};
      cols.forEach((col, i) => { row[col] = values[i]; });
      rows.push(row);
    }
  }
  return rows;
}

/**
 * Split a VALUES block like:
 *   (1,'foo','bar'),(2,'baz','qux')
 * into individual value strings.
 */
function tokenizeValueBlock(block) {
  const result = [];
  let depth = 0;
  let start = -1;

  for (let i = 0; i < block.length; i++) {
    const ch = block[i];
    if (ch === '(' && depth === 0) { depth++; start = i + 1; }
    else if (ch === '(') { depth++; }
    else if (ch === ')' && depth === 1) {
      depth--;
      if (start !== -1) result.push(block.slice(start, i));
      start = -1;
    } else if (ch === ')') { depth--; }
    else if (ch === "'" && depth > 0) {
      // skip past the string literal
      i++;
      while (i < block.length) {
        if (block[i] === '\\') { i += 2; continue; }
        if (block[i] === "'") break;
        i++;
      }
    }
  }
  return result;
}

/**
 * Parse a single value list like: 1,'foo',NULL,'bar\'s'
 * Returns an array of JS values (string, number, null, boolean).
 */
function parseValueList(entry) {
  const values = [];
  let i = 0;
  while (i < entry.length) {
    // skip whitespace and commas between values
    while (i < entry.length && (entry[i] === ',' || entry[i] === ' ')) i++;
    if (i >= entry.length) break;

    if (entry[i] === "'") {
      // string literal
      let str = '';
      i++; // skip opening quote
      while (i < entry.length) {
        if (entry[i] === '\\' && i + 1 < entry.length) {
          const next = entry[i + 1];
          if (next === "'") { str += "'"; i += 2; }
          else if (next === 'n') { str += '\n'; i += 2; }
          else if (next === 'r') { str += '\r'; i += 2; }
          else if (next === '\\') { str += '\\'; i += 2; }
          else { str += entry[i]; i++; }
        } else if (entry[i] === "'") {
          i++; // skip closing quote
          break;
        } else {
          str += entry[i++];
        }
      }
      values.push(str);
    } else if (entry.slice(i, i + 4).toUpperCase() === 'NULL') {
      values.push(null);
      i += 4;
    } else {
      // number or unquoted token
      let tok = '';
      while (i < entry.length && entry[i] !== ',') tok += entry[i++];
      const n = Number(tok.trim());
      values.push(isNaN(n) ? tok.trim() : n);
    }
  }
  return values;
}

// ─── Map MySQL usertype_id → Firebase role ─────────────────────────────────────
function mapRole(usertypeId, companyId) {
  const id = String(usertypeId);
  if (id === '4') return 'Admin';
  if (id === '1') return 'Top Management';
  if (id === '2') return 'Executive';
  if (id === '3') return 'Technician';
  return 'Technician';
}

// ─── Employee type + "trainne" spelling fix ───────────────────────────────────
// The old dump stores types lowercase ('permanent','contract','trainee') and the word
// "trainne" is misspelled in some designations. The app expects the capitalised union
// 'Permanent' | 'Contract' | 'Trainee' | 'Intern'.
function normaliseEmployeeType(raw, designation) {
  const t     = String(raw || '').toLowerCase().replace(/trainne/g, 'trainee').trim();
  const desig = String(designation || '').toLowerCase();
  if (t === 'intern'   || /\bintern\b/.test(desig))            return 'Intern';
  if (t === 'trainee'  || /trainne|trainee/.test(desig))       return 'Trainee';
  if (t === 'contract')                                        return 'Contract';
  if (t === 'permanent')                                       return 'Permanent';
  return 'Permanent';
}

// Replace the misspelled "trainne" anywhere in free text (e.g. designation
// "Technician Trainne" → "Technician Trainee").
function fixTrainne(s) {
  return String(s || '').replace(/trainne/gi, 'Trainee');
}

// Firestore doc ids can't contain "/" (it's a path separator → "even number of
// segments" error). EPF numbers like "EMPAVP/0001" are stored with "/" encoded as
// "%2F", matching userService.epfDocId in the app so migrated docs line up with how
// the app reads/writes them. The raw EPF is still kept in the epf_number FIELD.
function epfDocId(epf) {
  return String(epf).includes('/') ? String(epf).replace(/\//g, '%2F') : String(epf);
}

// Normalise an email: lowercase + trim, and repair a bare common-provider domain that
// is missing its ".com" (e.g. "x@gmail" → "x@gmail.com"). Firebase Auth rejects malformed
// emails, so this rescues otherwise-unusable logins from typos in the old data.
function fixEmail(raw) {
  const e = String(raw || '').trim().toLowerCase();
  if (!e) return '';
  return e.replace(/@(gmail|googlemail|yahoo|hotmail|outlook|icloud)$/, '@$1.com');
}

// ─── Split a name string into first/last ──────────────────────────────────────
function splitName(fullName) {
  if (!fullName) return { first_name: '', last_name: '' };
  const parts = fullName.trim().split(/\s+/);
  if (parts.length === 1) return { first_name: parts[0], last_name: '' };
  // First token = last name (Sri Lankan convention: surname first), rest = given
  // But the data uses "Given Surname" format in most entries — we'll keep simple split
  const last = parts.pop() || '';
  const first = parts.join(' ');
  return { first_name: first, last_name: last };
}

function buildNameTokens(first, last) {
  const f = (first || '').toLowerCase().trim();
  const l = (last || '').toLowerCase().trim();
  const full = `${f} ${l}`.trim();
  const tokens = new Set();
  if (f) tokens.add(f);
  if (l) tokens.add(l);
  if (full) tokens.add(full);
  for (let i = 2; i <= f.length; i++) tokens.add(f.slice(0, i));
  for (let i = 2; i <= l.length; i++) tokens.add(l.slice(0, i));
  for (let i = 2; i <= full.length; i++) tokens.add(full.slice(0, i));
  return Array.from(tokens).filter(t => t.length >= 2);
}

// ─── Normalise working_place strings from old system ──────────────────────────
function normaliseWorkingPlace(wp) {
  if (!wp) return null;
  const w = wp.toLowerCase().trim();
  if (w.includes('colombo')) return 'Colombo';
  if (w.includes('matara')) return 'Matara';
  if (w.includes('work from home') || w === 'wfh') return 'Work From Home';
  if (w === 'after - sales' || w === 'after-sales' || w.includes('after')) return 'After-Sales';
  if (w.includes('site - visit') || w.includes('site-visit') || w === 'site visit') return 'Site-Visit';
  if (w.includes('site')) return 'Site';
  return 'Colombo'; // fallback
}

// ─── ISO timestamp helper ──────────────────────────────────────────────────────
function toISO(mysqlTs) {
  if (!mysqlTs || mysqlTs === 'NULL') return null;
  // MySQL: "2026-05-14 10:11:08" → ISO
  return new Date(mysqlTs.replace(' ', 'T') + '+00:00').toISOString();
}

function toDateStr(d) {
  if (!d || d === 'NULL') return null;
  return d; // already YYYY-MM-DD
}

// ─── Parse tables ─────────────────────────────────────────────────────────────
console.log('Parsing SQL...');

const rawUsers       = parseInserts(sql, 'users');
const rawCompanies   = parseInserts(sql, 'companies');
const rawAttendances = parseInserts(sql, 'attendances');
const rawEditReqs    = parseInserts(sql, 'attendance_edit_requests');
const rawLeaves      = parseInserts(sql, 'leaves');
const rawLeaveTypes  = parseInserts(sql, 'leavetypes');
const rawReqFroms    = parseInserts(sql, 'attendance_request_froms');

console.log(`Found: ${rawUsers.length} users, ${rawCompanies.length} companies, ${rawAttendances.length} attendances, ${rawEditReqs.length} edit requests, ${rawLeaves.length} leaves, ${rawLeaveTypes.length} leave types`);

// ─── Build companies ──────────────────────────────────────────────────────────
const companies = {};
for (const c of rawCompanies) {
  const id = String(c.company_id);
  companies[id] = {
    id,
    name:            c.name || '',
    supervisor_epfs: [],
    created_at:      null,
  };
}

// ─── Build users ──────────────────────────────────────────────────────────────
const users = {};
for (const u of rawUsers) {
  const epf   = String(u.epf_number);
  const role  = mapRole(u.usertype_id, u.company_id);
  const { first_name, last_name } = splitName(u.name);
  const display_name = u.name || '';

  // Map company_id to string
  const company_id = String(u.company_id || '1');
  const company    = companies[company_id];

  users[epf] = {
    uid:              '',                    // Firebase Auth UID — filled after Auth account creation
    epf_number:       epf,
    // Lowercased (+ bare-domain repair) so the Firestore email matches what Firebase Auth
    // returns on Google/Microsoft sign-in (those always hand back a lowercase address) —
    // otherwise getUserByEmail() can't find the user and SSO sign-in is rejected.
    email:            fixEmail(u.email),
    first_name,
    last_name,
    display_name,
    name_tokens:      buildNameTokens(first_name, last_name),
    role,
    designation:      fixTrainne(u.designation),
    department:       '',
    company_id,
    company_name:     company?.name || '',
    employee_type:    normaliseEmployeeType(u.employee_type, u.designation),
    supervisor_epf:   u.supervisor || null,
    phone_personal:   u.personal_phonenumber || '',
    phone_office:     u.office_phonenumber || '',
    phone_emergency:  u.emergency_phonenumber || '',
    address:          u.address || '',
    nic:              u.nic || '',
    date_of_birth:    toDateStr(u.date_of_birth),
    date_of_join:     toDateStr(u.date_of_append),
    date_of_resign:   toDateStr(u.date_of_resign),
    insurance:        u.insurance === 1,
    blood_type:       u.blood_type || '',
    b_card_status:    u.b_card_status === 1,
    avatar_url:       null,
    fcm_token:        null,
    is_active:        !u.date_of_resign,
    created_at:       toISO(u.created_at),
    updated_at:       toISO(u.updated_at),
    // migration note — password hashes not transferred (users must reset password)
    _needs_auth:      true,
    _original_password_hash: null, // bcrypt — cannot transfer to Firebase Auth
  };

  // Add supervisors to company
  if ((role === 'Executive' || role === 'Top Management' || role === 'Admin') && company) {
    if (!companies[company_id].supervisor_epfs.includes(epf)) {
      companies[company_id].supervisor_epfs.push(epf);
    }
  }
}

// Also pull from company_supervisors junction table
const rawCompSups = parseInserts(sql, 'company_supervisors');
for (const cs of rawCompSups) {
  const cid = String(cs.company_id);
  const epf = String(cs.epf_number);
  if (companies[cid] && !companies[cid].supervisor_epfs.includes(epf)) {
    companies[cid].supervisor_epfs.push(epf);
  }
}

// ─── Build attendance records ──────────────────────────────────────────────────
// Build a lookup: attendance_id → request_from EPFs
const reqFromMap = {};
for (const rf of rawReqFroms) {
  const attId = String(rf.attendance_id);
  if (!reqFromMap[attId]) reqFromMap[attId] = [];
  if (!reqFromMap[attId].includes(rf.requested_epf_number)) {
    reqFromMap[attId].push(String(rf.requested_epf_number));
  }
}

const attendances = {};
for (const a of rawAttendances) {
  const epf  = String(a.epf_number);
  const date = String(a.date);
  const docId = `${epfDocId(epf)}_${date}`;   // "/" in EPF → "%2F" (Firestore-safe id)
  const attId = String(a.attendance_id);

  const wp = normaliseWorkingPlace(a.working_place);

  // Determine approval statuses from old data
  const hasCheckIn     = !!a.check_in;
  const hasCheckOut    = !!a.check_out;
  const checkInAppr    = hasCheckIn && !!a.check_in_approved_by;
  const checkOutAppr   = hasCheckOut && !!a.check_out_approved_by;

  // Get company_id from user
  const userRecord = users[epf];
  const company_id = userRecord?.company_id || '1';

  attendances[docId] = {
    id:                     docId,
    epf_number:             epf,
    company_id,
    date,
    check_in:               toISO(a.check_in),
    check_out:              toISO(a.check_out),
    working_place:          hasCheckOut ? wp : null,
    site_number:            a.site_number ? String(a.site_number) : null,
    is_outstation:          a.is_outstation === 1 || a.is_outstation === '1',
    outstation_location_id: null,           // not in old system — admin can map
    outstation_name:        a.outstation_name || null,
    outstation_address:     a.outstation_address || null,
    is_outstation_approved: a.is_outstation_approved === 1,
    morning_allowance:      a.morning_allowence !== null ? Number(a.morning_allowence) : 0,
    evening_allowance:      a.evening_allowence !== null ? Number(a.evening_allowence) : 0,
    check_in_approved_by:   a.check_in_approved_by || null,
    check_out_approved_by:  a.check_out_approved_by || null,
    check_in_status:        hasCheckIn ? (checkInAppr ? 'approved' : 'pending') : 'pending',
    check_out_status:       hasCheckOut ? (checkOutAppr ? 'approved' : 'pending') : 'pending',
    request_from:           reqFromMap[attId] || [],
    is_past_submission:     false,
    past_approved_by:       null,
    reject_reason:          null,
    created_at:             toISO(a.created_at),
    updated_at:             toISO(a.updated_at),
    // Keep original attendance_id for cross-referencing edit requests
    _legacy_id:             Number(a.attendance_id),
  };
}

// ─── Build attendance edit requests ───────────────────────────────────────────
// We need to map legacy attendance_id → new docId
const legacyAttIdMap = {};
for (const [docId, att] of Object.entries(attendances)) {
  if (att._legacy_id) legacyAttIdMap[att._legacy_id] = docId;
}

const attendanceEditRequests = {};
for (const r of rawEditReqs) {
  const id       = String(r.id);
  const attDocId = legacyAttIdMap[r.attendance_id] || String(r.attendance_id);
  const epf      = String(r.epf_number);
  const user     = users[epf];

  attendanceEditRequests[id] = {
    id,
    attendance_id:                     attDocId,
    epf_number:                        epf,
    employee_name:                     user?.display_name || epf,
    reason:                            r.reason || '',
    requested_check_in:                r.requested_check_in ? toISO(r.requested_check_in) : null,
    requested_check_out:               r.requested_check_out ? toISO(r.requested_check_out) : null,
    requested_working_place:           normaliseWorkingPlace(r.requested_working_place),
    requested_site_number:             r.requested_site_number || null,
    requested_is_outstation:           r.requested_is_outstation !== null ? Boolean(r.requested_is_outstation) : null,
    requested_outstation_location_id:  null,
    requested_outstation_name:         r.requested_outstation_name || null,
    status:                            r.status === 'approved' ? 'approved' : r.status === 'rejected' ? 'rejected' : 'pending',
    considered_by:                     r.considered_by || null,
    considered_at:                     r.considered_at ? toISO(r.considered_at) : null,
    reject_reason:                     r.reject_reason || null,
    created_at:                        toISO(r.created_at),
  };
}

// ─── Build leave types ────────────────────────────────────────────────────────
const leaveTypes = {};
for (const lt of rawLeaveTypes) {
  const id     = String(lt.leavetype_id);
  const exe    = Number(lt.number_of_leaves_for_exe)    || 0; // executives / management
  const nonexe = Number(lt.number_of_leaves_for_nonexe) || 0; // technicians (non-executive)
  leaveTypes[id] = {
    id,
    name:          lt.leavetype_name || '',
    annual_quota:  Math.max(exe, nonexe),
    // Per-role quotas (the modern resolver) + legacy two-bucket fallback the app still reads.
    quotas:        { 'Top Management': exe, 'Executive': exe, 'Admin': exe, 'Technician': nonexe },
    quota_tech:    nonexe,
    quota_nontech: exe,
    is_paid:       true,
    is_active:     true,
  };
}

// ─── Build leaves ─────────────────────────────────────────────────────────────
const leaves = {};
for (const l of rawLeaves) {
  const id     = String(l.leave_id);
  const epf    = String(l.epf_number);
  const user   = users[epf];
  const ltId   = String(l.leavetype_id);
  const lt     = leaveTypes[ltId];

  // Map old status: 'accept' → 'approved', 'reject' → 'rejected', else 'pending'
  let status = 'pending';
  if (l.status === 'accept' || l.status === 'approved') status = 'approved';
  else if (l.status === 'reject' || l.status === 'rejected') status = 'rejected';
  const decided = status !== 'pending';

  leaves[id] = {
    id,
    epf_number:       epf,
    employee_name:    user?.display_name || epf,
    company_id:       user?.company_id || '1',
    from_date:        toDateStr(l.from_date),
    to_date:          toDateStr(l.to_date),
    leave_type_id:    ltId,
    leave_type_name:  lt?.name || ltId,
    is_half_day:      l.is_half_day === 1 || l.is_half_day === '1',
    half_day_period:  l.half_day_period || null,
    reason:           l.reason || '',
    supervisor_epf:   l.requested_from || l.consider_by || '',
    status,
    considered_by:    decided ? (l.consider_by || null) : null,
    // Old leaves have no separate "considered_at" column — once decided, the row's
    // updated_at is the decision time.
    considered_at:    decided ? toISO(l.updated_at) : null,
    reject_reason:    null,
    is_paid:          l.paid === 'paid',
    created_at:       toISO(l.created_at),
    updated_at:       toISO(l.updated_at),
  };
}

// ─── Build outstation locations ───────────────────────────────────────────────
// Collect unique outstation names from attendance records for reference
const outstationNames = new Set();
for (const att of Object.values(attendances)) {
  if (att.outstation_name) outstationNames.add(att.outstation_name.trim());
}

const outstationLocations = {};
// Leave empty — admin creates canonical locations. We output the unique names
// as a reference list so admin knows what to create.

// ─── Summary stats ────────────────────────────────────────────────────────────
console.log('\n── Migration Summary ─────────────────────────────');
console.log(`Users:              ${Object.keys(users).length}`);
console.log(`Companies:          ${Object.keys(companies).length}`);
console.log(`Attendance records: ${Object.keys(attendances).length}`);
console.log(`Edit requests:      ${Object.keys(attendanceEditRequests).length}`);
console.log(`Leaves:             ${Object.keys(leaves).length}`);
console.log(`Leave types:        ${Object.keys(leaveTypes).length}`);
console.log(`\nUnique outstation names found (${outstationNames.size}):`);
[...outstationNames].sort().forEach(n => console.log(`  - ${n}`));
console.log('\nNOTE: Users need Firebase Auth accounts created separately.');
console.log('      The _needs_auth flag marks users that need Auth setup.');
console.log('      Use Admin > Users in the web app to create them, or');
console.log('      use the Firebase Console / Admin SDK bulk import.');
console.log('──────────────────────────────────────────────────\n');

// ─── Write output ─────────────────────────────────────────────────────────────
// Re-key users by Firestore-safe doc id (EPF "/" → "%2F"). Internal lookups above use
// the raw EPF (`users[epf]`), so we only encode keys at the very end. The epf_number
// FIELD inside each record stays raw.
const usersOut = {};
for (const [epf, u] of Object.entries(users)) usersOut[epfDocId(epf)] = u;

const output = {
  _meta: {
    generated_at:   new Date().toISOString(),
    source:         path.basename(sqlFile),
    version:        '1.1',
    mode:           dataOnly ? 'data-only (leaves + attendance; users untouched)' : 'full',
    total_users:    dataOnly ? 0 : Object.keys(users).length,
    total_att:      Object.keys(attendances).length,
    total_leaves:   Object.keys(leaves).length,
    unique_outstations: [...outstationNames].sort(),
    notes: [
      'Users have _needs_auth:true — Firebase Auth accounts must be created',
      'All passwords are NULL — users must use Firebase Password Reset',
      'outstation_location_id is null — admin must create canonical locations',
      'Timestamps are ISO 8601 strings — seeder converts to Firestore Timestamps',
    ],
  },
  // In --data-only mode these three are emitted EMPTY: the importer still accepts the file
  // (it requires the keys to exist) but writes nothing for them, so existing users/companies/
  // leave-types in the new database are left intact while leaves + attendance are overridden.
  companies:                 dataOnly ? {} : companies,
  users:                     dataOnly ? {} : usersOut,
  leave_types:               dataOnly ? {} : leaveTypes,
  attendances,
  attendance_edit_requests:  attendanceEditRequests,
  leaves,
  outstation_locations:      outstationLocations,
};

const outFile = path.join(path.dirname(sqlFile), 'firestore-seed.json');
fs.writeFileSync(outFile, JSON.stringify(output, null, 2));
console.log(`Output written to: ${outFile}`);
console.log(`File size: ${(fs.statSync(outFile).size / 1024 / 1024).toFixed(2)} MB`);
