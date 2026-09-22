import axios, { AxiosInstance } from 'axios';
import { useAuthStore } from '@/store/authStore';

const BASE_URL = typeof window !== 'undefined'
  ? (process.env.NEXT_PUBLIC_API_URL || 'https://masters.altavision.lk/api')
  : '/api';

const apiClient: AxiosInstance = axios.create({
  baseURL: BASE_URL,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
  withCredentials: true,
});

let isRefreshing = false;
let failedQueue: Array<{ resolve: (v: unknown) => void; reject: (e: unknown) => void }> = [];

const processQueue = (error: unknown) => {
  failedQueue.forEach(p => error ? p.reject(error) : p.resolve(null));
  failedQueue = [];
};

apiClient.interceptors.response.use(
  (res) => res,
  async (err) => {
    const original = err.config;
    if (
      err.response?.status === 401 &&
      !original._retry &&
      !original.url?.includes('web-login') &&
      !original.url?.includes('web-refresh')
    ) {
      if (isRefreshing) {
        return new Promise((resolve, reject) => {
          failedQueue.push({ resolve, reject });
        }).then(() => apiClient(original)).catch(e => Promise.reject(e));
      }
      original._retry = true;
      isRefreshing    = true;
      try {
        await axios.post(`${BASE_URL}/web-refresh`, {}, { withCredentials: true });
        processQueue(null);
        return apiClient(original);
      } catch (refreshErr) {
        processQueue(refreshErr);
        useAuthStore.getState().logout();
        if (typeof window !== 'undefined') window.location.href = '/login';
        return Promise.reject(refreshErr);
      } finally {
        isRefreshing = false;
      }
    }
    return Promise.reject(err);
  }
);

// ─── Auth ─────────────────────────────────────────────────────────────────────
export const authApi = {
  login:          (data: { email: string; password: string }) => apiClient.post('/web-login', data),
  logout:         () => apiClient.post('/web-logout'),
  refresh:        () => apiClient.post('/web-refresh'),
  changePassword: (data: { epf_number: string; old_password: string; new_password: string }) =>
    apiClient.post('/web-change-password', data),
  saveFcmToken:   (data: { fcm_token: string; epf_number: string }) => apiClient.post('/web-save-fcm-token', data),
};

// ─── Profile ──────────────────────────────────────────────────────────────────
export const profileApi = {
  // GET /web-get-profile-details?epf_number=xxx
  // Returns: { profile_data: { name, email, personal_phonenumber, office_phonenumber,
  //            emergency_phonenumber, epf_number, address, nic, date_of_birth } }
  getProfile: (epfNumber: string) =>
    apiClient.get('/web-profile', { params: { epf_number: epfNumber } }),

  // POST /web-update-profile — multipart/form-data for profile_image_blob support
  // Fields: epf_number, name, email, personal_phonenumber?, office_phonenumber?,
  //         emergency_phonenumber?, address?, profile_image? (file)
  // DO NOT set Content-Type manually for FormData — the browser must set it
  // automatically so it includes the correct multipart boundary string.
  // Setting it manually breaks file uploads (Laravel gets empty $request->file()).
  saveProfile: (data: FormData) =>
    apiClient.post('/web-update-profile', data),

  // GET /web-get-profile-picture?epf_number=xxx → blob or base64
  // _t timestamp busts browser/axios cache so we always get the latest image
  getProfilePicture: (epfNumber: string) =>
    apiClient.get('/web-get-profile-picture', {
      params:       { epf_number: epfNumber, _t: Date.now() },
      responseType: 'blob',
      headers:      { 'Cache-Control': 'no-cache', 'Pragma': 'no-cache' },
    }),

  getSupervisor:           (epfNumber: string) => apiClient.get('/web-get-supervisor', { params: { epf_number: epfNumber } }),
  getSupervisors:          (company: string, search?: string) => apiClient.get('/web-get-supervisors', { params: search ? { company, search } : { company } }),
  getSupervisorsForLeave:  (epfNumber: string, company: string) => apiClient.get('/web-get-supervisors-for-leave-apply', { params: { epf_number: epfNumber, company } }),
};

// ─── Attendance ───────────────────────────────────────────────────────────────
export const attendanceApi = {
  getMyTodayAttendance: (epfNumber: string) =>
    apiClient.get('/web-get-my-today-attendance', { params: { epf_number: epfNumber } }),

  getAttendanceByDate: (epfNumber: string, date: string) =>
    apiClient.get('/web-get-attendance-by-date', { params: { epf_number: epfNumber, date } }),

  submitPastAttendance: (data: {
    epf_number: string;
    date: string;
    check_in_time: string;
    check_out_time: string;
    working_place: string;
    site_number?: string;
    is_outstation: boolean;
    outstation_name?: string;
    outstation_address?: string;
    request_from?: string[];
  }) => apiClient.post('/web-submit-past-attendance', data),

  // Backend expects: epf_number, check_in_time, request_from (array of epf_numbers)
  // request_from = supervisor epf numbers selected by technician
  // epf_number comes from the auth store — added in the page before calling
  checkIn: (data: {
    epf_number:   string;
    check_in_time: string;        // ISO datetime string e.g. "2026-05-15T08:30:00"
    request_from?: string[];      // supervisor epf_number array (technician only)
  }) => apiClient.post('/web-check-in', data),

  // Backend expects: epf_number, check_out_time, working_place,
  //                  site_number?, is_outstation?, outstation_name?, outstation_address?
  checkOut: (data: {
    epf_number:          string;
    check_out_time:      string;   // ISO datetime string
    working_place:       string;
    site_number?:        string;
    is_outstation?:      boolean;
    outstation_name?:    string;
    outstation_address?: string;   // note: backend uses outstation_address not outstation_location
  }) => apiClient.post('/web-check-out', data),

  getWorkingDays:         (epfNumber: string) => apiClient.get('/web-get-monthly-attendance-dates', { params: { epf_number: epfNumber } }),
  getMonthlyAttendanceDates: (epfNumber: string, month?: number, year?: number) =>
    apiClient.get('/web-get-monthly-attendance-dates', {
      params: {
        epf_number: epfNumber,
        ...(month !== undefined ? { month } : {}),
        ...(year  !== undefined ? { year  } : {}),
      },
    }),
  getCheckinApprovalList: (epfNumber: string, company: string) =>
    apiClient.get('/web-get-today-attendance-approval-list', { params: { epf_number: epfNumber, company } }),
    
  getPastAttendanceApprovalList: (epfNumber: string, company: string) =>
    apiClient.get('/web-get-past-attendance-approvals', { params: { epf_number: epfNumber, company } }),

  // Backend expects: epf_number + approved_list array
  // Each check-in item: { id, time, morning_allowance }
  // Each check-out item: { id, time, evening_allowance, working_place, site_no?, is_outstation_approved }
  approveCheckIn: (data: {
    epf_number:    string;
    approved_list: {
      id:                number;
      time:              string;
      morning_allowance: number;  // 0=none, 1=category1(before 6:45), 2=category2(6:45-7:00)
    }[];
  }) => apiClient.post('/web-approve-check-in', data),

  approveCheckOut: (data: {
    epf_number:    string;
    approved_list: {
      id:                    number;
      time:                  string;
      evening_allowance:     number;  // 0=none, 1=category1(after 6:30 PM)
      working_place:         string;
      site_no?:              string | null;
      is_outstation_approved: boolean;
    }[];
  }) => apiClient.post('/web-approve-check-out', data),

  approvePastAttendance: (data: {
    epf_number:    string;
    approved_list: {
      id:                     number;
      check_in_time:          string;
      check_out_time:         string;
      working_place:          string;
      site_no?:               string | null;
      is_outstation_approved: boolean;
      morning_allowance:      number;
      evening_allowance:      number;
    }[];
  }) => apiClient.post('/web-approve-past-attendance', data),

  // Inside attendanceApi object:
requestAttendanceEdit: (data: {
  attendance_id:               number;
  epf_number:                  string;
  reason:                      string;
  requested_check_in?:         string | null;
  requested_check_out?:        string | null;
  requested_working_place?:    string | null;
  requested_site_number?:      string | null;
  requested_is_outstation?:    boolean | null;
  requested_outstation_name?:  string | null;
  requested_outstation_address?: string | null;
}) => apiClient.post('/web-request-attendance-edit', data),

getAttendanceEditRequests: (epfNumber: string, company: string) =>
  apiClient.get('/web-get-attendance-edit-requests', {
    params: { epf_number: epfNumber, company }
  }),

considerAttendanceEditRequest: (data: {
  id:            number;
  epf_number:    string;
  action:        'approve' | 'reject';
  reject_reason?: string;
}) => apiClient.post('/web-consider-attendance-edit-request', data),

getMyEditRequests: (epfNumber: string) =>
  apiClient.get('/web-get-my-attendance-edit-requests', {
    params: { epf_number: epfNumber }
  }),
};

// ─── Leaves ───────────────────────────────────────────────────────────────────
export const leaveApi = {
  checkIsTodayLeave:  (epfNumber: string) =>
    apiClient.get('/web-check_is_today_leave', { params: { epf_number: epfNumber } }),
  // Backend validation: epf_number, from_date, to_date, leave_type (name string), request_from (epf_number)
  // reason is NOT required
  applyLeave: (data: {
    epf_number:    string;
    from_date:     string;
    to_date:       string;
    leave_type:    string;   // the leave type NAME (e.g. "Casual Leaves"), not an ID
    request_from:  string;   // supervisor's epf_number
    reason?:       string;   // optional
  }) => apiClient.post('/web-apply-leave', data),
  removeLeave:        (id: number)  => apiClient.delete(`/web-remove-leave/${id}`),
  updateLeave: (data: {
    leave_id:     number;
    epf_number:   string;
    from_date:    string;
    to_date:      string;
    leave_type:   string;   // leave type NAME string
    request_from: string;   // supervisor's epf_number
    reason?:      string;
  }) => apiClient.put('/web-update-leave', data),
  getLeaveTypes:      () => apiClient.get('/web-get-leave-types'),
  getNumberOfLeaves:  () => apiClient.get('/web-get-number-of-leaves'),
  getLeaveSummary:    (epfNumber: string) => apiClient.get('/web-leave-summery', { params: { epf_number: epfNumber } }),
  // epf_number is always required.
  // month and year are optional — omit them for the current month (backend default).
  // Pass them when navigating to a different month in the calendar.
  getThisMonthLeaves: (epfNumber: string, month?: number, year?: number) =>
    apiClient.get('/web-get-this-month-leaves', {
      params: {
        epf_number: epfNumber,
        // Only include month/year if navigating away from current month
        ...(month !== undefined && year !== undefined && { month, year }),
      },
    }),
  // state = 'Upcoming' → from_date >= today, omit or any other → from_date < today
  getMyLeaves: (epfNumber: string, state?: 'Upcoming' | 'Past') =>
    apiClient.get('/web-my-leaves', {
      params: { epf_number: epfNumber, ...(state && { state }) },
    }),
  getLeaveRequests:   (epfNumber: string) => apiClient.get('/web-get-leave-requests', { params: { epf_number: epfNumber } }),
  // Backend validation: consider_by (epf_number), leave_id, action ('accept'|'reject')
  considerLeave: (data: { consider_by: string; leave_id: number; action: string }) =>
    apiClient.post('/web-consider-leave-request', data),
  getTodayLeaveList:  (company: string, date?: string) => apiClient.get('/web-today-leave-list', { params: date ? { company, date } : { company } }),
  getTodayAbsentees:  (company: string, epf_number: string) => apiClient.get('/web-get-today-absentees', { params: { company, epf_number } }),
};

export default apiClient;
