# Graph Report - Attendance-Web-App  (2026-09-06)

## Corpus Check
- 596 files · ~1,006,039 words
- Verdict: corpus is large enough that graph structure adds value.

## Summary
- 5116 nodes · 13959 edges · 258 communities (207 shown, 51 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 97 edges (avg confidence: 0.84)
- Token cost: 0 input · 0 output

## Graph Freshness
- Built from commit: `1aeb1bea`
- Run `git rev-parse HEAD` and compare to check if the graph is stale.
- Run `graphify update .` after code changes (no API cost).

## Community Hubs (Navigation)
- Company & Leave Admin Pages
- Payslips & Database Admin
- Fingerprint Terminal Device API
- Schedule & Departments
- Attendance Month Views
- Approval Routing Rules
- Suspense Account Module
- Backup & Orphan Auth Routes
- Payroll Dossier & Rates
- Button Component System
- Schedule Pattern Cron
- Day Metrics & Dossier
- Task Board
- Maintenance Banner & Control
- Suspense Expense Bills
- Payroll Runs & PDF Export
- Package Dependencies
- Platform Tenant Admin
- Registration & Login Resolve
- Payroll Reports
- Holiday Calendar Options
- Settings Backup Route
- Leave Requests UI
- Suspense Split & Balances
- Tenant Registry & Root Layout
- Departments & Bulk User Add
- Working Place Selection
- Excel Report Editing
- Admin Overview Dashboard
- Approvals Page
- Auto Checkout Cron
- App Shell & Navigation
- Community 32
- Community 33
- Community 34
- Community 35
- Community 36
- Community 37
- Community 38
- Community 39
- Community 40
- Community 41
- Community 42
- Community 43
- Community 44
- Community 45
- Community 46
- Community 47
- Community 48
- Community 49
- Community 50
- Community 51
- Community 52
- Community 53
- Community 54
- Community 55
- Community 56
- Community 57
- Community 58
- Community 59
- Community 60
- Community 61
- Community 62
- Community 63
- Community 64
- Community 65
- Community 66
- Community 67
- Community 68
- Community 69
- Community 70
- Community 71
- Community 72
- Community 73
- Community 74
- Community 75
- Community 76
- Community 77
- Community 78
- Community 79
- Community 80
- Community 81
- Community 82
- Community 83
- Community 84
- Community 85
- Community 86
- Community 87
- Community 88
- Community 89
- Community 90
- Community 91
- Community 92
- Community 93
- Community 94
- Community 95
- Community 96
- Community 97
- Community 98
- Community 99
- Community 100
- Community 101
- Community 102
- Community 103
- Community 104
- Community 105
- Community 106
- Community 107
- Community 108
- Community 109
- Community 110
- Community 111
- Community 112
- Community 113
- Community 114
- Community 115
- Community 116
- Community 117
- Community 118
- Community 119
- Community 120
- Community 121
- Community 122
- Community 123
- Community 124
- Community 125
- Community 126
- Community 127
- Community 128
- Community 129
- Community 130
- Community 131
- Community 132
- Community 133
- Community 134
- Community 135
- Community 136
- Community 137
- Community 138
- Community 139
- Community 140
- Community 141
- Community 142
- Community 143
- Community 144
- Community 145
- Community 146
- Community 147
- Community 148
- Community 149
- Community 150
- Community 151
- Community 152
- Community 153
- Community 154
- Community 155
- Community 156
- Community 157
- Community 158
- Community 159
- Community 160
- Community 161
- Community 162
- Community 163
- Community 164
- Community 165
- Community 166
- Community 167
- Community 168
- Community 169
- Community 170
- Community 171
- Community 172
- Community 173
- Community 175
- Community 176
- Community 177
- Community 178
- Community 180
- Community 181
- Community 182
- Community 183
- Community 185
- Community 186
- Community 187
- Community 188
- Community 189
- Community 190
- Community 191
- Community 192
- Community 197
- Community 198
- Community 199
- Community 200
- Community 201
- Community 202
- tenantRegistry.ts
- GreetingsPanel.tsx
- PWAInstallBanner.tsx
- shiftService.ts
- dayMetrics.ts
- VoucherReport
- sheet.tsx
- LeaveBalanceViz.tsx
- leaveStatus.tsx
- MyDeductions.tsx
- checkedInAtShiftPlaceOn
- Donut.tsx
- Lanyard.tsx
- axios
- tenantRegistry.ts
- shiftService.ts
- @dnd-kit/utilities
- payrollEmployeeService.ts
- chrono-node
- js-cookie
- motion
- next-themes
- exceljs
- @radix-ui/react-checkbox
- @radix-ui/react-dialog
- face-api.js
- @fingerprintjs/fingerprintjs
- react-day-picker
- react-hot-toast
- firebase-admin
- @react-three/fiber
- CalendarLegend.tsx
- framer-motion
- route.ts
- PeoplePanel.tsx
- @radix-ui/react-popover
- SWATCH_R
- @dnd-kit/core
- @react-three/drei
- face-api.js
- @simplewebauthn/browser
- @simplewebauthn/server
- @fingerprintjs/fingerprintjs
- three
- meshline
- zustand
- react-day-picker
- react-hot-toast
- @react-three/fiber
- serwist
- tailwind-merge
- three
- firebase/messaging

## God Nodes (most connected - your core abstractions)
1. `useT()` - 224 edges
2. `cn()` - 179 edges
3. `suspense/page.tsx` - 178 edges
4. `tasks/page.tsx` - 116 edges
5. `working-places/page.tsx` - 113 edges
6. `lib/firebase.ts` - 107 edges
7. `schedule/page.tsx` - 105 edges
8. `users/page.tsx` - 103 edges
9. `ui/button.tsx` - 98 edges
10. `useAuthStore` - 95 edges

## Surprising Connections (you probably didn't know these)
- `"Working Days" = Days With an Attendance Record` --semantically_similar_to--> `work_patterns Model (designed, not built)`  [INFERRED] [semantically similar]
  WORKING_STATUS_API.md → CLAUDE.md
- `README Firestore Notes and Backups` --semantically_similar_to--> `Firestore Rules Are Default-Deny`  [INFERRED] [semantically similar]
  README.md → CLAUDE.md
- `Exception Review Workflow and Open-Session Monitor` --semantically_similar_to--> `attendance_reviews Queue (flagged/in_review/resolved)`  [INFERRED] [semantically similar]
  docs/southern-lanka-capability-summary.html → FINGERPRINT_ATTENDANCE_API.md
- `Fingerprint and Mobile Capture in One Record` --semantically_similar_to--> `Scans Write Into the Same attendances sessions[]`  [INFERRED] [semantically similar]
  docs/southern-lanka-capability-summary.html → FINGERPRINT_ATTENDANCE_API.md
- `Overnight Shift Handling (end <= start crosses midnight)` --semantically_similar_to--> `Shift-Worker Yesterday Look-Back on Check-Out`  [INFERRED] [semantically similar]
  docs/southern-lanka-capability-summary.html → FINGERPRINT_ATTENDANCE_API.md

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **Fingerprint Punch Ingestion Pipeline** — fingerprint_attendance_api_attendance, fingerprint_attendance_api_idempotency_lock, fingerprint_attendance_api_debounce, fingerprint_attendance_api_action_reconciliation, fingerprint_attendance_api_sessions_shared_record, fingerprint_attendance_api_attendance_reviews, fingerprint_attendance_api_segments_recalc [EXTRACTED 1.00]
- **Per-Request Tenant Resolution Pipeline** — claude_md_tenants_pure_module, claude_md_tenant_registry_loader, claude_md_window_tenant_injection, claude_md_tenants_snapshot, readme_admindbfor, readme_tenant_resolution_flow [EXTRACTED 1.00]
- **The Three Levels of Admin** — claude_md_system_admin, claude_md_super_admin, claude_md_platform_admin, claude_md_verifyplatformcaller, readme_platform_config [EXTRACTED 1.00]

## Communities (258 total, 51 thin omitted)

### Community 0 - "Company & Leave Admin Pages"
Cohesion: 0.08
Nodes (57): departments/page.tsx, empty, payroll-settings/page.tsx, TYPE_TABS, empty, FormState, users/bulk-add/page.tsx, FieldKey (+49 more)

### Community 1 - "Payslips & Database Admin"
Cohesion: 0.07
Nodes (54): my-schedule/page.tsx, platform/page.tsx, AdminsTab(), Api, AuditRow, fmt(), HistoryTab(), PlatformAdminRow (+46 more)

### Community 2 - "Fingerprint Terminal Device API"
Cohesion: 0.12
Nodes (33): fingerprint-access/route.ts, bearerTokenFrom(), dynamic, GET(), runtime, [deviceId]/route.ts, dynamic, PATCH() (+25 more)

### Community 3 - "Schedule & Departments"
Cohesion: 0.18
Nodes (19): getHolidayTypesForRange(), invalidateScheduleAssignmentsCache(), createSchedulePattern(), deleteSchedulePattern(), formatDate(), getSchedulePatternsForDepartment(), getSchedulePatternsForDepartments(), getSchedulePatternsForEmployee() (+11 more)

### Community 4 - "Attendance Month Views"
Cohesion: 0.12
Nodes (26): ActivityFeed(), categoryApproverLabel(), Chip(), DayBlock(), dayLabel(), ICON_DISC, KIND_CHIPS, RowDetails() (+18 more)

### Community 5 - "Approval Routing Rules"
Cohesion: 0.05
Nodes (50): AnyApi, appendLocation(), ApprovalsCtx, attDocId(), autoOutstationByPlace(), buildAttPayload(), buildCheckinResult(), buildMyLeavesList() (+42 more)

### Community 6 - "Suspense Account Module"
Cohesion: 0.05
Nodes (89): CloseAccountDialog(), PendingCloseCard(), PendingSubmissionCard(), RequestDialog(), SuspensePage(), MONTHS, MyDeductions(), errMsg() (+81 more)

### Community 7 - "Backup & Orphan Auth Routes"
Cohesion: 0.10
Nodes (26): notifications/route.ts, dynamic, identityCache, POST(), runtime, proxy/route.ts, dynamic, POST() (+18 more)

### Community 8 - "Payroll Dossier & Rates"
Cohesion: 0.11
Nodes (41): backup/route.ts, dynamic, encode(), maxDuration, POST(), runtime, orphan-auth/route.ts, findOrphans() (+33 more)

### Community 9 - "Button Component System"
Cohesion: 0.05
Nodes (55): components/buttons/button.tsx, Button(), ButtonProps, buttonVariants, buttonVariants, IconButton(), IconButtonProps, components/buttons/ripple.tsx (+47 more)

### Community 10 - "Schedule Pattern Cron"
Cohesion: 0.10
Nodes (25): hasPremium(), HOLIDAY_WORK_KINDS, HolidayWorkKind, holidayWorkMultiplier(), HolidayWorkOptions, HolidayWorkPolicy, localDateKey(), PayrollHolidayRates (+17 more)

### Community 11 - "Day Metrics & Dossier"
Cohesion: 0.12
Nodes (35): onedrive-backup/route.ts, dynamic, maxDuration, POST(), runtime, config/route.ts, GET(), POST() (+27 more)

### Community 12 - "Task Board"
Cohesion: 0.07
Nodes (56): tasks/page.tsx, BOARD_COLUMN_DOT, BoardCard(), emptyAssignForm, emptyForm, fmtLong(), fmtMonth(), fmtRow() (+48 more)

### Community 13 - "Maintenance Banner & Control"
Cohesion: 0.08
Nodes (60): MaintenanceBanner(), Props, EXTEND_CHIPS, KINDS, MaintenanceControlPopup(), MODES, Props, MaintenanceDetailsPopup() (+52 more)

### Community 14 - "Suspense Expense Bills"
Cohesion: 0.06
Nodes (57): AllocateCreditDialog(), categoryApproverList(), PendingCategoryRequestCard(), PendingRequestCard(), PendingSupervisorRequestCard(), RequestStatusRow(), LimitMeter(), AccountBadge() (+49 more)

### Community 15 - "Payroll Runs & PDF Export"
Cohesion: 0.08
Nodes (41): callPayrollRoute(), LoadEmployeesDialog(), PayrollRunsContent(), statusBadge(), useActor(), OTRequestModal(), todayStr(), emptyMonthlyEntry() (+33 more)

### Community 16 - "Package Dependencies"
Cohesion: 0.04
Nodes (55): axios, chrono-node, clsx, firebase, firebase-admin, framer-motion, js-cookie, lucide-react (+47 more)

### Community 17 - "Platform Tenant Admin"
Cohesion: 0.07
Nodes (62): companies/page.tsx, CompaniesAdminContent(), isValidLogoUrl(), my-payslips/page.tsx, MyPayslipsContent(), MyPayslipsPage(), periodLabel(), OtRequestsPage() (+54 more)

### Community 18 - "Registration & Login Resolve"
Cohesion: 0.11
Nodes (28): FormState, mergeChamaryLink(), WorkingPlacesAdminPage(), WorkingPlaceSelect(), geocodePlace(), isShortPlusCode(), splitPlusCode(), noop (+20 more)

### Community 19 - "Payroll Reports"
Cohesion: 0.06
Nodes (46): RFC-4180, leave-types/page.tsx, empty, my-team/page.tsx, outstation/page.tsx, roles/page.tsx, emptyForm, FormState (+38 more)

### Community 20 - "Holiday Calendar Options"
Cohesion: 0.09
Nodes (52): PUT(), validate(), Ctx, Filter, newId(), SpecialDayDialog(), SpecialDayDialogProps, Step (+44 more)

### Community 21 - "Settings Backup Route"
Cohesion: 0.12
Nodes (28): formatSnapshotMoment(), SettingsBackupSettings(), ALWAYS_REDACTED_FIELDS, buildSettingsSnapshot(), canDeleteSnapshot(), describeSnapshot(), isSecretCollection(), matchesDocPattern() (+20 more)

### Community 22 - "Leave Requests UI"
Cohesion: 0.10
Nodes (29): BLANK_FORM, cardInitial(), fmtRange(), formatDateTime(), getDatesInRange(), HalfPeriod, Leave, LeaveBalance (+21 more)

### Community 23 - "Suspense Split & Balances"
Cohesion: 0.18
Nodes (16): chamaryForSubcategory(), dateStrToTimestamp(), ExpenseEditForm(), expenseLabel(), lastPickKey(), NewExpenseForm(), readLastPick(), resolveCategory() (+8 more)

### Community 24 - "Tenant Registry & Root Layout"
Cohesion: 0.07
Nodes (53): brand-sw-config/route.ts, dynamic, GET(), app/layout.tsx, dynamic, fontMono, fontSans, metadata (+45 more)

### Community 25 - "Departments & Bulk User Add"
Cohesion: 0.13
Nodes (27): groupByEpf(), ReportsContent(), schedule/page.tsx, HOLIDAY_LABELS, MONTH_ABBRS, monthDates(), SchedulePage(), shiftDurationHours() (+19 more)

### Community 26 - "Working Place Selection"
Cohesion: 0.16
Nodes (24): LatLng, OutstationBadge(), fmtTime(), ReleasePicksDialog(), durationLabel(), localDateTimeString(), parseDateInput(), timeRange() (+16 more)

### Community 27 - "Excel Report Editing"
Cohesion: 0.08
Nodes (48): reports/page.tsx, Category, MONTHS, ReportPreview, Combobox(), MenuPos, Opt, Props (+40 more)

### Community 28 - "Admin Overview Dashboard"
Cohesion: 0.12
Nodes (16): buildHolidayOptions(), holidayCalendarOf(), HolidayOption, parseScope(), sameKey(), scopeId(), SignerListDialog(), parseScope() (+8 more)

### Community 29 - "Approvals Page"
Cohesion: 0.05
Nodes (33): digitsOnly(), LeaveTypesAdminContent(), rangeError(), AttendanceData, DossierBlockId, DossierCtx, FoodData, IdentityData (+25 more)

### Community 30 - "Auto Checkout Cron"
Cohesion: 0.26
Nodes (10): OpenAccountDialog(), errMsg(), UserSuspenseCard(), addLedgerEntry(), adjustSuspenseAccount(), createSuspenseAccount(), getUserAccounts(), SuspenseState (+2 more)

### Community 31 - "App Shell & Navigation"
Cohesion: 0.11
Nodes (25): (pages)/layout.tsx, AppShell(), isEmployeeOnlyPath(), NOTE: rendered via `{SidebarContent()}` (a plain call), NOT `<SidebarContent…, readCollapsedGroups(), roleTone(), writeCollapsedGroups(), BOTTOM_NAV_MAX (+17 more)

### Community 32 - "Community 32"
Cohesion: 0.25
Nodes (10): RFC-5322, COUNTRY_CODES, CustomPhoneInput(), NSN_LEN, phoneFieldError(), ProfileData, ProfilePage(), splitPhone() (+2 more)

### Community 33 - "Community 33"
Cohesion: 0.07
Nodes (42): restore/route.ts, decode(), dynamic, Item, maxDuration, POST(), runtime, admin/sync-superadmins/route.ts (+34 more)

### Community 34 - "Community 34"
Cohesion: 0.13
Nodes (39): audit/route.ts, bearer(), dynamic, GET(), notFound(), POST(), runtime, tenants/route.ts (+31 more)

### Community 35 - "Community 35"
Cohesion: 0.13
Nodes (19): errMsg(), ImportBalancesDialog(), accountKey(), BALANCE_ALIASES, BalanceDraftRow, buildBalanceDraftRows(), COMPANY_ALIASES, downloadBalanceTemplate() (+11 more)

### Community 36 - "Community 36"
Cohesion: 0.05
Nodes (28): argv, attendanceEditRequests, attendances, companies, flags, leaves, leaveTypes, legacyAttIdMap (+20 more)

### Community 37 - "Community 37"
Cohesion: 0.07
Nodes (28): AttendanceViewContent(), CellStatus, clockLabel(), DayBlockDetail, DayCell, DayTimes, HOLIDAY_LABELS, METHOD_ICON (+20 more)

### Community 38 - "Community 38"
Cohesion: 0.14
Nodes (25): APPROVED_BY_SENTINEL, AttendanceEventResult, calcEveningAllowance(), calcMorningAllowance(), colomboDateStr(), colomboMinutesOfDay(), DeclaredAction, DeviceDoc (+17 more)

### Community 39 - "Community 39"
Cohesion: 0.09
Nodes (36): draft/route.ts, Body, dynamic, OCCASION_KINDS, POST(), runtime, delete/route.ts, dynamic (+28 more)

### Community 40 - "Community 40"
Cohesion: 0.10
Nodes (27): getNotifPrefs(), getSetting(), SettingsPage(), LocationGate(), LocationOffBanner(), Coords, LocationStatus, decodePlusCode() (+19 more)

### Community 41 - "Community 41"
Cohesion: 0.06
Nodes (36): AttendanceReviewStatus, AttendanceDevice, AttendanceEditRequest, AttendanceReview, AttendanceReviewResolution, AttendanceSegment, AttendanceStatus, FaceEnrollment (+28 more)

### Community 42 - "Community 42"
Cohesion: 0.18
Nodes (20): useAssignedTaskActions(), AssignedTaskComment, AssignedTaskEventKind, AssignedTaskFlag, AssignedTaskPerson, addAssignedTaskNote(), addAssigneeToTask(), clearAssignedTaskFlag() (+12 more)

### Community 43 - "Community 43"
Cohesion: 0.22
Nodes (12): amountByName(), buildPayslipData(), count(), findLine(), money(), MONTHS, MONTHS_SHORT, NAMED_ALLOWANCES (+4 more)

### Community 44 - "Community 44"
Cohesion: 0.09
Nodes (50): ApproverLedger(), buildActivityItems(), HolderOverview(), DayHeatGrid(), FILL, WEEKDAYS, belongsToCompany(), DayGroup (+42 more)

### Community 45 - "Community 45"
Cohesion: 0.27
Nodes (9): backlogStartFor(), pastSubmissionNeedsApproval(), PlaceKeys, placeKeysOf(), sessionAtPlace(), shiftRouteVisibility(), PLACES, RANNA (+1 more)

### Community 46 - "Community 46"
Cohesion: 0.20
Nodes (20): POST(), POST(), POST(), POST(), POST(), POST(), ChallengeKind, credentialById() (+12 more)

### Community 47 - "Community 47"
Cohesion: 0.08
Nodes (38): SelectedCell, computeShortfallForDay(), ConstituentShift, DayShortfall, formatMinutes(), localMinutesSinceMidnight(), mergeShiftBlocks(), ShiftBlock (+30 more)

### Community 48 - "Community 48"
Cohesion: 0.06
Nodes (35): EASE, NotFound(), AddStatusColumn(), AssigneePicker(), BoardColumn(), ChamaryMealsPicker(), ApprovalsBulkBar(), ApprovalsKeyboardHint() (+27 more)

### Community 49 - "Community 49"
Cohesion: 0.17
Nodes (15): FIREWORK_COLORS, FIREWORK_SIZE, FIREWORK_SPEED, GreetingStage(), initials(), PARTICLE_SIZE, PARTICLE_SPEED, ShownGreeting (+7 more)

### Community 50 - "Community 50"
Cohesion: 0.14
Nodes (22): ChamaryChangeRequests(), ChamaryGroup, dayLabel(), errMsg(), frozenReason(), IndicativeCost(), loadIndicativeRate(), MealGroup (+14 more)

### Community 51 - "Community 51"
Cohesion: 0.09
Nodes (31): allowedAudiencesFor(), AuthorCtx, canAuthor(), cleanLines(), GREETING_AUDIENCES, GREETING_VARIANTS_MAX, GreetingWordings, normalizeMessages() (+23 more)

### Community 52 - "Community 52"
Cohesion: 0.09
Nodes (35): AllowanceCalcs, ApprovableBase, approvableForSession(), ApprovableLive, ApprovablePast, ApprovableSession, ApprovalPayloads, buildApprovableMap() (+27 more)

### Community 53 - "Community 53"
Cohesion: 0.13
Nodes (23): MonthSummary(), MonthSummaryLabels, SelectedDayCard(), SelectedDayLabels, dayKey(), dayMark, DayMarkKind, DEFAULT_EXPECTATION (+15 more)

### Community 54 - "Community 54"
Cohesion: 0.24
Nodes (14): PasskeysCard(), shortDate(), cachedVisitorId(), getVisitorId(), localDeviceLabel(), deletePasskey(), enrolPasskey(), listPasskeys() (+6 more)

### Community 55 - "Community 55"
Cohesion: 0.67
Nodes (3): DayProgress(), EASE, parseTs()

### Community 56 - "Community 56"
Cohesion: 0.13
Nodes (29): canonical(), configFromRows(), nextRid(), Row, rowError(), Rows, rowsFromConfig(), Section (+21 more)

### Community 57 - "Community 57"
Cohesion: 0.15
Nodes (26): greetings/test/route.ts, dynamic, POST(), runtime, authorized(), GET(), POST(), Body (+18 more)

### Community 58 - "Community 58"
Cohesion: 0.19
Nodes (18): GlobalError(), AuthProvider(), firestoreToUser(), cacheAvatar(), getCachedAvatar(), isForeignOAuthPhoto(), isOAuthPhotoHost(), KEY() (+10 more)

### Community 59 - "Community 59"
Cohesion: 0.10
Nodes (31): ConfirmModal(), SearchableSelect(), SearchOption, CategoryCard(), CreditApproversPopover(), SubcategoryTable(), TypePoolPopover(), BlockHeader() (+23 more)

### Community 60 - "Community 60"
Cohesion: 0.11
Nodes (36): read-bill/route.ts, POST(), runtime, AI_USAGE_COLLECTION, AiBudget, aiCostUsd(), AiPricing, budgetOf() (+28 more)

### Community 61 - "Community 61"
Cohesion: 0.10
Nodes (42): ChamaryPage(), MonthError, errMsg(), FoodPage(), pad2(), MultiplierBadge(), Props, useMultiplierWord() (+34 more)

### Community 62 - "Community 62"
Cohesion: 0.12
Nodes (25): AttendanceReviewReason, AttendanceReviewSource, autoCloseGapHours(), colomboWallClockMs(), computeShiftSegments(), deriveReviewReason(), DUP_PUNCH_DEBOUNCE_SECONDS, HOURS() (+17 more)

### Community 63 - "Community 63"
Cohesion: 0.13
Nodes (21): csvCell(), downloadCsv(), editDistance(), isDateHeader(), normalizePlaceName(), parseCsv(), ShiftsAdminContent(), toCsv() (+13 more)

### Community 64 - "Community 64"
Cohesion: 0.13
Nodes (19): AdminDashboardContent(), buildMonthMapDays(), clockOf(), Company, fix(), Headcount, MapDay, MapKind (+11 more)

### Community 65 - "Community 65"
Cohesion: 0.29
Nodes (14): jspdf, jspdf-autotable, jspdf, jspdf-autotable, baseFilename(), csvCell(), exportRegisterCsv(), exportRegisterPdf() (+6 more)

### Community 66 - "Community 66"
Cohesion: 0.14
Nodes (21): HolidayPolicySection(), KIND_LABELS, Named, todayKey(), WEEKDAYS, WorkPatternSettings(), MONDAY, SATURDAY (+13 more)

### Community 67 - "Community 67"
Cohesion: 0.10
Nodes (32): DaySess, fmtHoursShort(), fmtTime(), HolidayByDate, HolidayInfo, LeaveLite, localStrOf(), MONTHS (+24 more)

### Community 68 - "Community 68"
Cohesion: 0.15
Nodes (23): Draft, GreetingAudience, GreetingMessage, OccasionKind, CachedDayMessages, cacheSpecialDayMessages(), getSpecialDayCachedMessages(), invalidateSpecialDayCache() (+15 more)

### Community 69 - "Community 69"
Cohesion: 0.08
Nodes (24): Serialised Runs and Rebase Before Push, Bot Commit Loop Guard, Version Bump on Merge / Push Workflow, Approval Routing Rules (approvalRouting.ts), No Overtime Pay in Attendance UI, Verification Commands (tsc, node:test, next build --webpack), Role-Tree Approval Hierarchy, Contiguous Duty Merging and Split-Day Separation (+16 more)

### Community 70 - "Community 70"
Cohesion: 0.12
Nodes (27): ChamaryClosures(), Props, breakdownText(), mealInitial(), prettyDate(), prettyDateShort(), toDate(), Props (+19 more)

### Community 71 - "Community 71"
Cohesion: 0.14
Nodes (26): generate/route.ts, calculatePayrollForEmployee(), calculateProgressiveTax(), PayrollCalculationInput, warn(), OtRateMode, PayrollCalculationResult, PayrollCalculationWarning (+18 more)

### Community 72 - "Community 72"
Cohesion: 0.14
Nodes (18): EditRequestListRow(), calcDistanceKm(), changed(), EditRequestData, EditRequestDetail(), EditRequestRow(), formatDistance(), groupOf() (+10 more)

### Community 73 - "Community 73"
Cohesion: 0.05
Nodes (65): xlsx, PayrollReportsContent(), boundedLevenshtein(), fuzzyScore(), subsequenceScore(), BankExportData, BankExportRow, baseFilename() (+57 more)

### Community 74 - "Community 74"
Cohesion: 0.22
Nodes (23): admins/route.ts, bearer(), DELETE(), dynamic, GET(), notFound(), POST(), runtime (+15 more)

### Community 75 - "Community 75"
Cohesion: 0.10
Nodes (43): register/route.ts, buildNameTokens(), epfDocId(), notifyPendingRegistration(), POST(), runtime, splitFullName(), resolve-login/route.ts (+35 more)

### Community 76 - "Community 76"
Cohesion: 0.09
Nodes (23): functions/package.json, dependencies, firebase-admin, firebase-functions, description, devDependencies, @types/node, typescript (+15 more)

### Community 77 - "Community 77"
Cohesion: 0.17
Nodes (8): colsFor(), Extra, floatCache, mealCache, ModuleKey, OverviewCore, OverviewKpiBand(), taskCache

### Community 78 - "Community 78"
Cohesion: 0.17
Nodes (19): LoansTab(), PayrollLoansContent(), currentPeriod(), SalaryAdvancesContent(), PayrollAuditAction, PayrollAuditLogEntry, validatePayrollLoan(), validatePayrollSalaryAdvance() (+11 more)

### Community 79 - "Community 79"
Cohesion: 0.15
Nodes (21): DatabaseManagementContent(), fmtBytes(), fmtDate(), batchWrite(), clearAllData(), clearCollection(), clearCollections(), clearLiveDataKeepUsers() (+13 more)

### Community 80 - "Community 80"
Cohesion: 0.25
Nodes (6): BadgeContext, EMPTY, NavBadgeCounts, NavBadgesState, useNavBadges(), useNavBadgesStore

### Community 81 - "Community 81"
Cohesion: 0.36
Nodes (8): fmt(), ScheduledNotifications(), STATUS_LABEL, STATUS_STYLE, cancelScheduledNotification(), listScheduledNotifications(), ScheduledNotification, ScheduledStatus

### Community 82 - "Community 82"
Cohesion: 0.15
Nodes (20): ImportDayOffsDialog(), ALIAS_TO_SINGLE, buildDayOffDraftRows(), DATE_HEADER_ALIASES, DAY_OFF_TEMPLATE_HEADERS, DayOffDraftRow, DayOffTemplateEmployee, downloadDayOffTemplate() (+12 more)

### Community 83 - "Community 83"
Cohesion: 0.15
Nodes (21): ImportShiftsDialog(), ALIAS_TO_SINGLE, buildRosterDraftRows(), classifyDateHeader(), DateCol, downloadShiftRosterTemplate(), MissingRosterHeadersError, normalizeEpf() (+13 more)

### Community 84 - "Community 84"
Cohesion: 0.07
Nodes (39): database/page.tsx, TARGET_DOMAIN, ChamaryPeopleTable(), DaySubtotals(), LedgerLineRow(), Alert, AlertDescription, AlertTitle (+31 more)

### Community 85 - "Community 85"
Cohesion: 0.11
Nodes (25): groupLabel(), levelPill(), NotificationCenter(), receivedAt(), renderGreeting(), renderNotif(), senderNames(), T (+17 more)

### Community 86 - "Community 86"
Cohesion: 0.05
Nodes (58): BackLabels, CardUser, clamp(), decorativeMatrix(), drawBackFace(), drawBandTexture(), drawContain(), drawCover() (+50 more)

### Community 87 - "Community 87"
Cohesion: 0.15
Nodes (20): fmtDate(), monthFromNow(), MyPayrollRequests(), RequestDialog(), Props, PayrollRequest, PayrollRequestKind, Actor (+12 more)

### Community 88 - "Community 88"
Cohesion: 0.10
Nodes (19): aliases, components, hooks, lib, ui, utils, iconLibrary, registries (+11 more)

### Community 89 - "Community 89"
Cohesion: 0.11
Nodes (29): buildClusters(), buildPoints(), clockOf(), Cluster, clusterIcon(), countPoints(), DayVisit, DEFAULT_KINDS (+21 more)

### Community 90 - "Community 90"
Cohesion: 0.22
Nodes (20): DepartmentsAdminContent(), SouthernlankaShiftsContent(), timeRange(), shiftDepartmentIds(), shiftDepartmentNames(), cascadeDepartmentRename(), createDepartment(), deleteDepartment() (+12 more)

### Community 91 - "Community 91"
Cohesion: 0.16
Nodes (20): working-status/route.ts, buildSnapshot(), checkAuth(), colomboToday(), DayOut, dynamic, fetchRecentRecords(), fetchUsers() (+12 more)

### Community 92 - "Community 92"
Cohesion: 0.20
Nodes (20): childrenOf(), RolesAdminContent(), PlatformPage(), isSuperAdminUser(), traineeDefaults(), cascadeRoleRename(), createRole(), deleteRole() (+12 more)

### Community 93 - "Community 93"
Cohesion: 0.33
Nodes (8): cron/sync-superadmins/route.ts, authorized(), dynamic, GET(), POST(), runtime, requireSharedSecret(), secretEquals()

### Community 94 - "Community 94"
Cohesion: 0.18
Nodes (19): isActiveSuperAdminUser(), Blocker, conflictReason(), epfDocId(), findBlocker(), homeDbOf(), isActiveSuperAdmin(), isMirrorDoc() (+11 more)

### Community 95 - "Community 95"
Cohesion: 0.11
Nodes (17): firebase/app, firebase/auth, args, batchWrite(), CLEAR, COLLECTIONS, convertTimestamps(), db (+9 more)

### Community 96 - "Community 96"
Cohesion: 0.14
Nodes (17): applyTimeToDate(), ApprovalData, ApprovalRecord, ApprovalsPage(), ApproveResult, AttendanceEditRequest, EditState, LeafletMiniMap (+9 more)

### Community 97 - "Community 97"
Cohesion: 0.20
Nodes (14): addMonths(), BalanceCard(), BalanceSummary, dayDate(), EmployeeLeaveHistoryDialog(), fetchEmployeeLeaveHistory(), fetchRemainingBalance(), fmtDays() (+6 more)

### Community 98 - "Community 98"
Cohesion: 0.16
Nodes (17): Accent, ACCENT_TONE, ConnLike, getConnection(), isSlowConnection(), NetworkStatus(), showCard(), AppToaster() (+9 more)

### Community 99 - "Community 99"
Cohesion: 0.11
Nodes (20): byName(), canApproveTechnicians(), canPickTechnicians(), CapabilitySubject, childRoleNamesOf(), descendantRoleIdsOf(), descendantRoleNamesOf(), ELEVATED_CAPABILITY_KEYS (+12 more)

### Community 100 - "Community 100"
Cohesion: 0.12
Nodes (28): cache, DanglingCheckout, localMs(), useDanglingCheckout(), SpecialLeave, AttendanceShortfallSummary, getAttendanceShortfallSummaries(), summaryDocId() (+20 more)

### Community 101 - "Community 101"
Cohesion: 0.19
Nodes (18): attendanceApi, checkTimeBasedDirect(), getAttendanceState(), getCurrentPosition(), getPrefs(), getReminderReg(), heartbeat(), locationActive() (+10 more)

### Community 102 - "Community 102"
Cohesion: 0.13
Nodes (15): compilerOptions, allowJs, esModuleInterop, incremental, isolatedModules, jsx, module, moduleResolution (+7 more)

### Community 103 - "Community 103"
Cohesion: 0.11
Nodes (18): functions/tsconfig.json, compilerOptions, esModuleInterop, lib, module, moduleResolution, noImplicitReturns, noUnusedLocals (+10 more)

### Community 104 - "Community 104"
Cohesion: 0.16
Nodes (16): argv, CUTOFF_MS, DRY_RUN, fixEmail(), flags, fmt(), INCLUDE_INACTIVE, initAdmin() (+8 more)

### Community 105 - "Community 105"
Cohesion: 0.25
Nodes (16): addMonthKey(), CalendarCell, DayRange, daysCovered(), densityStep(), groupByDay(), isYmd(), monthBounds() (+8 more)

### Community 106 - "Community 106"
Cohesion: 0.22
Nodes (15): birthdayNotify, colomboToday(), DEFAULT_TENANT_DB_IDS, dispatchDue(), dispatchScheduledNotifications, epfDocId(), isBirthdayToday(), MAINTENANCE_KIND_TITLES (+7 more)

### Community 107 - "Community 107"
Cohesion: 0.18
Nodes (19): ChamaryMealTimesPicker(), servedMeals(), CloseKitchenDialog(), spanDays(), appMinutes(), chamaryMeals(), clampMinute(), currentMealSlot() (+11 more)

### Community 108 - "Community 108"
Cohesion: 0.38
Nodes (5): fmt(), LeaveBalanceViz, LeaveBalanceVizBase(), EASE, UsageMeter()

### Community 109 - "Community 109"
Cohesion: 0.18
Nodes (15): argv, cmdList(), cmdSeed(), cmdSnapshot(), commands, __dir, env, fromEnv() (+7 more)

### Community 110 - "Community 110"
Cohesion: 0.14
Nodes (28): schedule-pattern-extend/route.ts, authorized(), colomboDateStr(), dynamic, extendDayOffPattern(), extendShiftPattern(), GET(), holidayTypesForRange() (+20 more)

### Community 111 - "Community 111"
Cohesion: 0.12
Nodes (26): createFirework(), createParticle(), FireworksBackground(), FireworksBackgroundProps, FireworkType, getColor(), getValueByRange(), ParticleType (+18 more)

### Community 112 - "Community 112"
Cohesion: 0.19
Nodes (20): ComponentsTab(), RatesTab(), draftPayrollSettings(), PayrollTaxSlab, payrollSettingFieldError(), validatePayrollComponent(), validatePayrollSettings(), validateTaxSlabs() (+12 more)

### Community 113 - "Community 113"
Cohesion: 0.20
Nodes (14): argv, BACKUP_DIR, decode(), __dir, doBackup(), doRestore(), encode(), env (+6 more)

### Community 114 - "Community 114"
Cohesion: 0.15
Nodes (17): leaflet, leaflet, AttendanceMiniMap(), dotSvg(), FIT, fmtDistance(), geofenceVerdict(), MapPlace (+9 more)

### Community 115 - "Community 115"
Cohesion: 0.16
Nodes (22): cachedSplit(), ChamarySplit, GET(), monthCost(), previousMonth(), splitCache, splitFor(), ChamaryCostBlock() (+14 more)

### Community 116 - "Community 116"
Cohesion: 0.09
Nodes (29): Occasion, ANNIVERSARY_LINES, ANNIVERSARY_LINES_SI, ANNIVERSARY_LINES_TA, BIRTHDAY_LINES, BIRTHDAY_LINES_SI, BIRTHDAY_LINES_TA, FIRST_YEAR_LINES (+21 more)

### Community 117 - "Community 117"
Cohesion: 0.21
Nodes (14): APPROVAL_NOTIF_TYPES, APPROVAL_SET, dayStart(), filterByTab(), GROUP_ORDER, groupByRecency(), NotifCategory, NotifLike (+6 more)

### Community 118 - "Community 118"
Cohesion: 0.07
Nodes (28): src/components/attendance/workDayModel.ts, src/lib/aiUsageBudget.ts, src/lib/approvalQueueCache.ts, src/lib/approvalRouting.ts, src/lib/billNumbering.ts, src/lib/chamaryClosures.ts, src/lib/chamaryMonth.ts, src/lib/foodAllowance.ts (+20 more)

### Community 119 - "Community 119"
Cohesion: 0.13
Nodes (15): southernlanka/manifest.json, background_color, categories, description, display, icons, name, orientation (+7 more)

### Community 120 - "Community 120"
Cohesion: 0.13
Nodes (15): public/manifest.json, background_color, categories, description, display, icons, name, orientation (+7 more)

### Community 121 - "Community 121"
Cohesion: 0.19
Nodes (14): argv, DRY_RUN, epfDocId(), fixEmail(), flags, initAdmin(), kv, main() (+6 more)

### Community 122 - "Community 122"
Cohesion: 0.16
Nodes (10): argv, createUploadSession(), __dir, env, initAdmin(), itemPath(), normalizePrivateKey(), ROOT (+2 more)

### Community 123 - "Community 123"
Cohesion: 0.11
Nodes (18): ComposeNotification(), Missing, PUSHABLE_NOTIF_TYPE_SET, PUSHABLE_NOTIF_TYPES, AppNotifAudience, AppNotification, AppNotifType, ComposeAudience (+10 more)

### Community 124 - "Community 124"
Cohesion: 0.25
Nodes (14): CloudStoragePanel(), expiryInfo(), CloudProvider, CloudConfigView, getActiveProvider(), getCloudConfig(), idToken(), saveCloudConfig() (+6 more)

### Community 125 - "Community 125"
Cohesion: 0.35
Nodes (8): BILL_GAP_FROZEN_ABOVE, BILL_GAP_UNREADABLE_IN_RUN, BillBackfillMove, BillRunEntry, nextCounterSeq(), planBillBackfillMove(), readBillSlot(), planned()

### Community 126 - "Community 126"
Cohesion: 0.16
Nodes (21): auto-checkout/route.ts, authorized(), checkInMillis(), colomboDateStr(), dynamic, GET(), POST(), run() (+13 more)

### Community 127 - "Community 127"
Cohesion: 0.13
Nodes (14): BufferGeometry, CanvasTexture, CatmullRomCurve3, Color, Mesh, OrthographicCamera, PlaneGeometry, Scene (+6 more)

### Community 128 - "Community 128"
Cohesion: 0.15
Nodes (13): dir, entries, header, icoSizes, images, inner, input, load() (+5 more)

### Community 129 - "Community 129"
Cohesion: 0.37
Nodes (13): encodeToon(), fmtKey(), fmtScalar(), isObj(), isScalar(), PAD(), quoteString(), tableKeys() (+5 more)

### Community 130 - "Community 130"
Cohesion: 0.36
Nodes (9): centroid(), dist2(), GridScan(), GridScanProps, median(), medianPush(), smoothDampFloat(), smoothDampVec2() (+1 more)

### Community 131 - "Community 131"
Cohesion: 0.23
Nodes (8): BadgeVariant, labelIn(), matchesQuery(), scrollParentOf(), SettingsSection, SuperAdminSyncSettings(), SystemSettingsPage(), useScrollSpy()

### Community 132 - "Community 132"
Cohesion: 0.18
Nodes (11): COLLECTIONS, __dir, elapsed, env, ROOT, seed, seedPath, startTime (+3 more)

### Community 133 - "Community 133"
Cohesion: 0.22
Nodes (9): bookingState, MEAL_ACCENT, MealAccent, mealsPresent(), sortMeals(), MealChip(), MyMealCalendar(), Props (+1 more)

### Community 134 - "Community 134"
Cohesion: 0.17
Nodes (13): authorized(), epfDocId(), GET(), POST(), run(), tokensOf(), epfDocId(), legacyType() (+5 more)

### Community 135 - "Community 135"
Cohesion: 0.10
Nodes (23): DashboardPage(), DashSnapshot, LeaveCheck, LeaveSummary, localDateStr(), normalizeLeaveSummary(), TodayAttendance, applyTheme() (+15 more)

### Community 136 - "Community 136"
Cohesion: 0.18
Nodes (17): BulkAddContent(), emptyBulkDefaults(), StepDefaults(), PayrollEmployeesContent(), useActor(), emptyPayrollEmployee(), PayrollEmployeeComponentLine, validatePayrollEmployee() (+9 more)

### Community 137 - "Community 137"
Cohesion: 0.12
Nodes (28): elapsedSince(), fmtClock(), fmtDay(), fmtDuration(), fmtStamp(), statusTone, afterMenuCloses(), AssignedTaskActionCluster() (+20 more)

### Community 138 - "Community 138"
Cohesion: 0.20
Nodes (12): Exception Review Workflow and Open-Session Monitor, Fingerprint and Mobile Capture in One Record, Raw Punches Are Never Rewritten, Terminal Integration Safeguards, Server-Side Action Reconciliation, POST /api/fingerprint/attendance, attendance_reviews Queue (flagged/in_review/resolved), Fingerprint Sessions Are Auto-Approved (+4 more)

### Community 139 - "Community 139"
Cohesion: 0.10
Nodes (19): name, private, scripts, build, db:backup, db:indexes, db:login, db:restore (+11 more)

### Community 140 - "Community 140"
Cohesion: 0.22
Nodes (14): tesseract.js, ExpenseFields(), isFuelCategory(), BillData, extractBillData(), parseBillAmount(), parseBillDate(), parseIsVat() (+6 more)

### Community 141 - "Community 141"
Cohesion: 0.08
Nodes (29): install/page.tsx, BeforeInstallPromptEvent, Browser, getBrowser(), getPlatform(), InstallPage(), isStandalone(), Platform (+21 more)

### Community 142 - "Community 142"
Cohesion: 0.18
Nodes (13): daysSince(), errText(), PassedRequest, PassedRequestsDialog(), RowResult, Checkbox, EmptyState(), EmptyStateProps (+5 more)

### Community 143 - "Community 143"
Cohesion: 0.22
Nodes (8): AutoServeInput, autoServeKey(), AutoServePlan, AutoServeTarget, mealClosed(), planAutoServe(), ChamaryMealOffday, LunchRequest

### Community 144 - "Community 144"
Cohesion: 0.27
Nodes (11): accessibleShifts(), canUserAccessShift(), HOD_ELIGIBLE_ROLE, isEffectiveHod(), isRecurringDayOffEligible(), ShiftEligibility, shiftIsGlobal(), shiftIsRestricted() (+3 more)

### Community 145 - "Community 145"
Cohesion: 0.15
Nodes (22): ActivityFeedProps, AccountPending, CompanyBalanceCard(), NO_PENDING, TotalBalanceCard(), cmp(), monthBounds(), MonthCursor (+14 more)

### Community 147 - "Community 147"
Cohesion: 0.20
Nodes (11): MODULE_ROUTES Route-to-Flag Map, Platform Admin (platform_admins registry), firestore.rules Deploy Targets ((default) and test only), Tenancy Model (one deployment, many domains), TenantFeatures Flags, src/lib/tenants.ts Purity Constraint, verifyPlatformCaller Server-Side Check, Register Scope and Exclusions (+3 more)

### Community 148 - "Community 148"
Cohesion: 0.10
Nodes (21): autoprefixer, devDependencies, autoprefixer, postcss, @serwist/next, tailwindcss, @types/js-cookie, @types/node (+13 more)

### Community 149 - "Community 149"
Cohesion: 0.47
Nodes (10): cacheGet(), cacheSet(), checkLocationBased(), checkTimeBased(), geofenceList(), getFired(), haversine(), markFired() (+2 more)

### Community 150 - "Community 150"
Cohesion: 0.33
Nodes (5): ApprovalsTriageBar(), toneActive, toneIcon, toneRing, TriageTile

### Community 151 - "Community 151"
Cohesion: 0.07
Nodes (30): RoleFlow, ChamaryCategoriesPicker(), CATEGORY_CHIP, Flow(), HandlersCtx, layoutForest(), nodeTypes, RoleFlowNode() (+22 more)

### Community 152 - "Community 152"
Cohesion: 0.27
Nodes (10): Bulk Roster Import with Review Step, Holiday Classification Stamped at Assignment, Module 01 - Tenant and Multi-Company Hierarchy, Module 02 - Users and Role-Based Access, Module 03 - HOD Scope and Reporting Lines, Module 04 - Shift Definition and Scheduling Engine, Module 05 - Attendance and Real-Time Roster Engine, Recurring Weekly Roster Patterns (+2 more)

### Community 153 - "Community 153"
Cohesion: 0.29
Nodes (10): Overnight Shift Handling (end <= start crosses midnight), Shift-Worker Yesterday Look-Back on Check-Out, Working-Status Route README, WORKFORCE_API_KEY Shared-Secret Auth, Working-Status API (planning-app feed), is_working Semantics (open session, overnight aware), Working-Status Operational Notes (PII, no-store, polling budget), Working-Status Snapshot Schema (+2 more)

### Community 154 - "Community 154"
Cohesion: 0.13
Nodes (14): node, compilerOptions, baseUrl, esModuleInterop, module, moduleResolution, outDir, paths (+6 more)

### Community 155 - "Community 155"
Cohesion: 0.27
Nodes (9): CredentialResponse, GoogleId, IdConfig, isValidClientId(), loadGsi(), logMoment(), Params, useGoogleOneTap() (+1 more)

### Community 156 - "Community 156"
Cohesion: 0.25
Nodes (6): apiClient, attendanceApi, authApi, failedQueue, leaveApi, profileApi

### Community 157 - "Community 157"
Cohesion: 0.17
Nodes (17): DEV_CANON_ORDER, DEV_EMP_TYPES, DevRole, devRoleRank(), LoginPage(), resolveIdentifierEmail(), availableMethod(), forgetLastSignIn() (+9 more)

### Community 158 - "Community 158"
Cohesion: 0.24
Nodes (8): LEAVE_APPLY_CUTOFF_HOURS, LEAVE_APPLY_SHIFT_CUTOFF_MSG, LEAVE_DELETION_CUTOFF_HOURS, LEAVE_DELETION_SHIFT_CUTOFF_MSG, nextCoveredShiftStart(), shiftCutoffViolation(), ShiftLike, shiftStartDateTime()

### Community 159 - "Community 159"
Cohesion: 0.25
Nodes (8): AuthProvider onAuthStateChanged Gate, Firestore Rules Are Default-Deny, Deploy App Before firestore.rules, Recalculation on Retrospective Roster Change, Fingerprint Firestore Collection Layout, attendance_segments and recalc_queue, README Firestore Notes and Backups, NEXT_PUBLIC_FIREBASE_* Keys Are Not Secrets

### Community 160 - "Community 160"
Cohesion: 0.32
Nodes (7): COLS, elapsed, seed, t0, toFSValue(), uploadCol(), writeDoc()

### Community 161 - "Community 161"
Cohesion: 0.33
Nodes (7): tenantRegistry: awaitTenants vs tenantsSync, tenants.snapshot.json Cold-Start Failsafe, window.__TENANT__ Injection Ordering, Domain-Resolved Data Isolation, adminDbFor(req) in API Routes, Snapshot Is a Failsafe, Not a Source of Truth, Server-Side Tenant Resolution Flow

### Community 162 - "Community 162"
Cohesion: 0.29
Nodes (7): Per-Employee Attendance Method Policy, Fingerprint Attendance API (HF-X05), FINGERPRINT_APP_FIREBASE_BE_FUNCTION_CONTRACT_V1, Device Auth: Shared Secret + Registered Device, Admin Device Provisioning Endpoints, FPA-xxx Error Code Table, External Integration Surfaces

### Community 163 - "Community 163"
Cohesion: 0.29
Nodes (4): db, flagged, name(), users

### Community 164 - "Community 164"
Cohesion: 0.43
Nodes (6): HOURS, maskDigits(), MINUTES, parseDigits(), Props, TimePicker()

### Community 165 - "Community 165"
Cohesion: 0.24
Nodes (12): PersonDossierProps, cache, useOverviewDay(), buildMonthRegister(), computeStats(), DayPerson, DayStats, normalizeSessions() (+4 more)

### Community 166 - "Community 166"
Cohesion: 0.47
Nodes (6): RFC-1918, img/route.ts, assertSafeTarget(), GET(), isBlockedAddress(), runtime

### Community 167 - "Community 167"
Cohesion: 0.47
Nodes (5): OutstationManager(), OutstationLocation, createOutstationLocation(), getOutstationLocations(), updateOutstationLocation()

### Community 168 - "Community 168"
Cohesion: 0.50
Nodes (5): CLAIMED_CAPABILITIES / claims() Lockstep, Super Admin (isSuperAdminUser), System Admin (is_system_admin), Granular 38-Switch Capability Model, Cross-Tenant Administrator Mirroring

### Community 169 - "Community 169"
Cohesion: 0.40
Nodes (5): Hardcoded Calendar Hours (Mon-Fri 8h / Sat 4h / Sun rest), work_patterns Model (designed, not built), Attendance Web App Working Notes, Attendance Web App README, Application Stack (Next.js 16 / React 19 / Firebase)

### Community 170 - "Community 170"
Cohesion: 0.40
Nodes (4): next, nextConfig, withSerwist, next

### Community 171 - "Community 171"
Cohesion: 0.38
Nodes (4): formatNotificationText(), getActions(), _recentPushIds, render()

### Community 172 - "Community 172"
Cohesion: 0.50
Nodes (4): POST/GET /api/fingerprint/enrollments, Face-Template Backup Extension (SFace), POST /api/fingerprint/sync-users, userId = epf_number Identity Mapping

### Community 175 - "Community 175"
Cohesion: 0.14
Nodes (18): OtRequestsContent(), statusVariant(), tsDate(), ApprovalListRow(), ApprovalListRowRecord, ApprovalsBacklogCard(), ApprovalsMasterDetail(), ApprovalsMasterDetailProps (+10 more)

### Community 177 - "Community 177"
Cohesion: 0.50
Nodes (3): IntrinsicElements, JSX, react

### Community 203 - "tenantRegistry.ts"
Cohesion: 0.09
Nodes (30): debug/page.tsx, DebugPage(), app/page.tsx, Home(), api-playground/page.tsx, ApiPlaygroundPage(), FilledReq, fillPreset() (+22 more)

### Community 204 - "GreetingsPanel.tsx"
Cohesion: 0.27
Nodes (8): draftOf(), GreetingsPanel(), GROUP_KEYS, leadWordingOf(), Mode, MODE_DEPTH, moveWithinGroup(), OCCASIONS

### Community 205 - "PWAInstallBanner.tsx"
Cohesion: 0.17
Nodes (15): bulk/route.ts, dynamic, POST(), runtime, attendance/route.ts, dynamic, POST(), runtime (+7 more)

### Community 206 - "shiftService.ts"
Cohesion: 0.29
Nodes (6): BackdropOccasion, CONFETTI, confettiOpacity(), GreetingBackdrop(), SPARKS, WASH

### Community 207 - "dayMetrics.ts"
Cohesion: 0.07
Nodes (21): AttendanceBlock(), BlockStatus, CheckpointItem, currentYearNum, DossierTabId, FoodBlock(), formatTimestampTime(), initialsOf() (+13 more)

### Community 208 - "VoucherReport"
Cohesion: 0.29
Nodes (14): bearer(), Body, context(), Ctx, decorate(), GET(), OCCASION_KINDS, personOf() (+6 more)

### Community 216 - "Lanyard.tsx"
Cohesion: 0.19
Nodes (9): AttendanceData, AttendancePage(), firebaseErrorCode(), LeaveCheckResult, monthLabel(), shiftRunsOvernight(), todayString(), toLocalTime24h() (+1 more)

### Community 217 - "axios"
Cohesion: 0.19
Nodes (12): Props, MealChangeDialog(), MealChangeKind, MealChangeRequest, approveMealChange(), bookingDocId(), changeId(), createMealChangeRequest() (+4 more)

### Community 218 - "tenantRegistry.ts"
Cohesion: 0.07
Nodes (35): ot-requests/page.tsx, suspense/page.tsx, ApprovalsPanel(), BillKind, companiesOf(), EMPLOYEE_TYPES, groupByCategory(), groupByUser() (+27 more)

### Community 219 - "shiftService.ts"
Cohesion: 0.31
Nodes (9): reset-password/route.ts, epfDocId(), POST(), update-email/route.ts, epfDocId(), POST(), createAuthUser(), firebaseConfig (+1 more)

### Community 221 - "payrollEmployeeService.ts"
Cohesion: 0.21
Nodes (11): buildApprovalQueue(), PickListRow(), PickListRowRecord, dayHours(), DayIssue, dayIssues(), toMinutes(), getRecordIssues() (+3 more)

### Community 224 - "js-cookie"
Cohesion: 0.29
Nodes (9): formatDayMonth(), formatLongDate(), SpecialDaysBlock(), TestGreeting(), errorOf(), getGreetingSettings(), idToken(), saveGreetingSettings() (+1 more)

### Community 228 - "@radix-ui/react-checkbox"
Cohesion: 0.28
Nodes (17): attendance-source/route.ts, POST(), my-payslips/route.ts, POST(), finalize/route.ts, POST(), POST(), reopen/route.ts (+9 more)

### Community 229 - "@radix-ui/react-dialog"
Cohesion: 0.17
Nodes (16): AssignFormState, FormState, escapeRegExp(), FILLER_WORDS, parseQuickAdd(), QuickAddResult, stripWholeWord(), toYmd() (+8 more)

### Community 230 - "face-api.js"
Cohesion: 0.16
Nodes (21): MySchedulePage(), parseDateInput(), ScheduleDayContent(), timeRange(), ScheduleAssignment, createAppNotification(), bulkCreateScheduleAssignments(), BulkScheduleAssignmentInput (+13 more)

### Community 231 - "@fingerprintjs/fingerprintjs"
Cohesion: 0.26
Nodes (12): Cat, CAT_META, Chip, distLabel(), fmtDist(), Gps, Pick, pushRecent() (+4 more)

### Community 232 - "react-day-picker"
Cohesion: 0.17
Nodes (11): functions, .next/dev/types/**/*.ts, next-env.d.ts, .next/types/**/*.ts, node_modules, src/app/sw.ts, .test-out, **/*.ts (+3 more)

### Community 234 - "firebase-admin"
Cohesion: 0.23
Nodes (10): DaySummary, HolidayStaffInfo, HolidayTooltipChip(), HolidayTooltipChipProps, DayCardTooltipContent(), DaySummaryData, getInitials(), OverviewMonthModal() (+2 more)

### Community 235 - "@react-three/fiber"
Cohesion: 0.33
Nodes (7): ApprovalsDetailHeader(), IssueBadges(), IssueBanner(), useIssueLabel(), worstSeverity(), CallButton(), canPlaceCall()

### Community 236 - "CalendarLegend.tsx"
Cohesion: 0.29
Nodes (7): CalendarLegend(), CalendarLegendLabels, ringScaleFor(), EDIT_RING_COLORS, EditRingSwatch(), Gauge(), RingSwatch()

### Community 237 - "framer-motion"
Cohesion: 0.29
Nodes (9): createShiftAssignment(), deleteShiftAssignment(), getShiftAssignments(), getShiftAssignmentsForEpf(), invalidateShiftAssignmentsCache(), isShiftActiveOn(), _shiftCache, _shiftInflight (+1 more)

### Community 238 - "route.ts"
Cohesion: 0.36
Nodes (7): authorized(), GET(), KIND_TITLES, notifyAllUsers(), POST(), run(), tokensOf()

### Community 239 - "PeoplePanel.tsx"
Cohesion: 0.25
Nodes (5): DayTab, PeoplePanel(), SortKey, STATUS_ORDER, IssueChips()

### Community 240 - "@radix-ui/react-popover"
Cohesion: 0.33
Nodes (6): dom, dom.iterable, ES2022, esnext, lib, lib

## Knowledge Gaps
- **1288 isolated node(s):** `MonthError`, `MapUpdate`, `MapSession`, `MapPerson`, `MapDay` (+1283 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **51 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `useT()` connect `Community 48` to `Company & Leave Admin Pages`, `Payslips & Database Admin`, `Community 131`, `Community 133`, `Community 135`, `Community 136`, `Community 137`, `Task Board`, `Community 141`, `Community 142`, `Platform Tenant Admin`, `Registration & Login Resolve`, `Payroll Reports`, `Holiday Calendar Options`, `Leave Requests UI`, `Departments & Bulk User Add`, `Working Place Selection`, `Excel Report Editing`, `Admin Overview Dashboard`, `Approvals Page`, `Community 157`, `App Shell & Navigation`, `Community 32`, `Community 37`, `Community 167`, `Community 40`, `Community 42`, `Community 175`, `Community 49`, `Community 50`, `Community 54`, `Community 59`, `Community 61`, `Community 63`, `Community 64`, `Community 67`, `Community 70`, `Community 73`, `Community 75`, `GreetingsPanel.tsx`, `Community 77`, `Community 78`, `Community 79`, `dayMetrics.ts`, `Community 84`, `Community 85`, `Community 86`, `Community 87`, `Lanyard.tsx`, `axios`, `Community 90`, `Community 92`, `Community 96`, `Community 97`, `Community 98`, `js-cookie`, `@fingerprintjs/fingerprintjs`, `firebase-admin`, `Community 107`, `@react-three/fiber`, `Community 108`, `PeoplePanel.tsx`, `Community 111`, `Community 115`, `Community 123`?**
  _High betweenness centrality (0.132) - this node is a cross-community bridge._
- **Why does `lib/firebase.ts` connect `tenantRegistry.ts` to `Company & Leave Admin Pages`, `Payslips & Database Admin`, `Schedule & Departments`, `Community 136`, `Task Board`, `Maintenance Banner & Control`, `Community 142`, `Payroll Runs & PDF Export`, `Platform Tenant Admin`, `Registration & Login Resolve`, `Payroll Reports`, `Settings Backup Route`, `Community 151`, `Tenant Registry & Root Layout`, `Departments & Bulk User Add`, `Working Place Selection`, `Community 155`, `Excel Report Editing`, `Auto Checkout Cron`, `App Shell & Navigation`, `Community 165`, `Community 167`, `Community 41`, `Community 42`, `Community 58`, `Community 63`, `Community 65`, `Community 67`, `Community 68`, `tenantRegistry.ts`, `Community 75`, `Community 78`, `Community 79`, `Community 81`, `Community 84`, `Community 87`, `Community 90`, `Community 92`, `js-cookie`, `Community 100`, `face-api.js`, `framer-motion`, `Community 112`, `Community 123`, `Community 124`?**
  _High betweenness centrality (0.063) - this node is a cross-community bridge._
- **Why does `cn()` connect `Community 84` to `Company & Leave Admin Pages`, `Payslips & Database Admin`, `Attendance Month Views`, `Suspense Account Module`, `Community 135`, `Button Component System`, `Maintenance Banner & Control`, `Suspense Expense Bills`, `Community 142`, `Community 145`, `Platform Tenant Admin`, `Payroll Reports`, `Community 150`, `Excel Report Editing`, `Admin Overview Dashboard`, `App Shell & Navigation`, `Community 44`, `Community 50`, `Community 59`, `tenantRegistry.ts`, `js-cookie`, `@react-three/fiber`, `Community 107`, `Community 111`?**
  _High betweenness centrality (0.044) - this node is a cross-community bridge._
- **What connects `MonthError`, `MapUpdate`, `MapSession` to the rest of the system?**
  _1288 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Company & Leave Admin Pages` be split into smaller, more focused modules?**
  _Cohesion score 0.07800608828006088 - nodes in this community are weakly interconnected._
- **Should `Payslips & Database Admin` be split into smaller, more focused modules?**
  _Cohesion score 0.0735930735930736 - nodes in this community are weakly interconnected._
- **Should `Fingerprint Terminal Device API` be split into smaller, more focused modules?**
  _Cohesion score 0.12121212121212122 - nodes in this community are weakly interconnected._