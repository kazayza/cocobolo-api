// اختبارات مُحاكاة (stubbed) لسجلات البصمة الخام والحضور اليدوي اليومي —
// مرآة AttendanceService (GetBiometricLogsAsync / Upsert / Update / Delete /
// ApplyAttendanceEditValues). بلا أي قاعدة بيانات حية.
// التشغيل: node --test modules/attendance/attendance-manual-raw.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

const state = { store: null, mainQueryCount: 0, txLog: [] };
let nextAttendanceId;

function resetStore() {
  nextAttendanceId = 100;
  state.mainQueryCount = 0;
  state.txLog = [];
  state.store = {
    today: '2026-10-30',
    employees: [
      { EmployeeID: 1, BioEmployeeID: 501, FullName: 'أحمد محمد', Department: 'الإنتاج', Gender: 'ذكر' },
      { EmployeeID: 2, BioEmployeeID: 502, FullName: 'منى حسن', Department: 'المبيعات', Gender: 'أنثى' },
      { EmployeeID: 3, BioEmployeeID: null, FullName: 'خالد بلا بصمة', Department: 'الإنتاج', Gender: 'ذكر' },
      { EmployeeID: 4, BioEmployeeID: 503, FullName: 'عمر فاروق', Department: 'المخازن', Gender: 'ذكر' },
    ],
    biometricLogs: [
      { BiometricLogID: 1, BiometricCode: 501, LogDate: '2026-10-30', LogTime: '08:05:00' },
      { BiometricLogID: 2, BiometricCode: 501, LogDate: '2026-10-30', LogTime: '17:02:00' },
      { BiometricLogID: 3, BiometricCode: 502, LogDate: '2026-10-30', LogTime: '08:10:00' },
      { BiometricLogID: 4, BiometricCode: 999, LogDate: '2026-10-30', LogTime: '09:00:00' },
      { BiometricLogID: 5, BiometricCode: 501, LogDate: '2026-10-29', LogTime: '08:00:00' },
      { BiometricLogID: 6, BiometricCode: 503, LogDate: '2026-10-29', LogTime: '07:55:00' },
    ],
    attendance: [],
    shifts: [
      { EmployeeID: 4, StartTime: '09:00', EndTime: '18:00', EffectiveFrom: '2026-01-01', EffectiveTo: null },
    ],
    audit: [],
  };
}
resetStore();

function filteredRaw(p) {
  const s = state.store;
  let rows = [...s.biometricLogs];
  if (p.dateFrom) rows = rows.filter((r) => r.LogDate >= String(p.dateFrom).slice(0, 10));
  if (p.dateTo) rows = rows.filter((r) => r.LogDate <= String(p.dateTo).slice(0, 10));
  if (p.biometricCode != null) rows = rows.filter((r) => r.BiometricCode === p.biometricCode);
  const codes = Object.keys(p).filter((k) => /^code\d+$/.test(k)).map((k) => p[k]);
  if (codes.length) rows = rows.filter((r) => codes.includes(r.BiometricCode));
  return rows;
}

function attRowOut(a) {
  return {
    AttendanceID: a.AttendanceID, BiometricCode: a.BiometricCode, LogDate: a.LogDate,
    TimeIn: a.TimeIn, TimeOut: a.TimeOut, Status: a.Status, TotalHours: a.TotalHours,
    LateMinutes: a.LateMinutes, EarlyLeaveMinutes: a.EarlyLeaveMinutes, PenaltyHours: a.PenaltyHours,
  };
}

function executeQuery(rawText, p) {
  const text = rawText.replace(/\s+/g, ' ');
  const s = state.store;

  // تدقيق
  if (text.includes('Audit_Log') && text.includes('INSERT')) {
    s.audit.push({
      TableName: p.table, ActionType: p.action, PrimaryKeyValue: p.key,
      OldData: p.oldData, NewData: p.newData, LoginName: p.username,
      AppName: 'COCOBOLO Flutter', AccessUserName: p.username,
    });
    return { recordset: [] };
  }
  // نافذة الوردية OUTER APPLY
  if (text.includes('OUTER APPLY') && text.includes('EmployeeShifts')) {
    const emp = s.employees.find((e) => e.EmployeeID === p.employeeId);
    if (!emp) return { recordset: [] };
    const date = String(p.date).slice(0, 10);
    const candidates = s.shifts
      .filter((sh) => sh.EmployeeID === p.employeeId && sh.EffectiveFrom <= date && (sh.EffectiveTo == null || sh.EffectiveTo >= date))
      .sort((a, b) => (a.EffectiveFrom < b.EffectiveFrom ? 1 : -1));
    const shift = candidates[0];
    return { recordset: [{ StartTime: shift ? shift.StartTime.slice(0, 5) : null, EndTime: shift ? shift.EndTime.slice(0, 5) : null }] };
  }
  // بحث الموظفين للسجل الخام
  if (text.includes('BioEmployeeID IS NOT NULL')) {
    const needle = String(p.search || '').replace(/%/g, '');
    const rows = s.employees
      .filter((e) => e.BioEmployeeID != null && (e.FullName.includes(needle) || e.Department.includes(needle)))
      .map((e) => ({ BioEmployeeID: e.BioEmployeeID }));
    return { recordset: rows };
  }
  // عد اليوم
  if (text.includes('FROM BiometricLog') && text.includes('TodayCount')) {
    return { recordset: [{ TodayCount: s.biometricLogs.filter((r) => r.LogDate === s.today).length }] };
  }
  // عد الخام
  if (text.includes('FROM BiometricLog') && text.includes('COUNT(*) AS TotalCount')) {
    state.mainQueryCount++;
    return { recordset: [{ TotalCount: filteredRaw(p).length }] };
  }
  // بيانات الخام
  if (text.includes('FROM BiometricLog') && text.includes('LEFT JOIN Employees')) {
    state.mainQueryCount++;
    let rows = filteredRaw(p);
    rows.sort((a, b) => (a.LogDate === b.LogDate ? (a.LogTime < b.LogTime ? 1 : -1) : (a.LogDate < b.LogDate ? 1 : -1)));
    const m = text.match(/OFFSET (\d+) ROWS FETCH NEXT (\d+)/);
    const off = m ? Number(m[1]) : 0; const size = m ? Number(m[2]) : rows.length;
    rows = rows.slice(off, off + size);
    return {
      recordset: rows.map((r) => {
        const emp = s.employees.find((e) => e.BioEmployeeID === r.BiometricCode);
        return {
          BiometricLogID: r.BiometricLogID, BiometricCode: r.BiometricCode,
          LogDate: r.LogDate, LogTime: r.LogTime,
          EmployeeID: emp ? emp.EmployeeID : null,
          EmployeeName: emp ? emp.FullName : null,
          Department: emp ? emp.Department : null,
          Gender: emp ? emp.Gender : null,
        };
      }),
    };
  }
  // قائمة يوم يدوي
  if (text.includes('FROM Attendance a') && text.includes('LEFT JOIN Employees')) {
    const date = String(p.date).slice(0, 10);
    const rows = s.attendance.filter((a) => a.LogDate === date).map((a) => {
      const emp = s.employees.find((e) => e.BioEmployeeID === a.BiometricCode);
      return {
        ...attRowOut(a),
        EmployeeID: emp ? emp.EmployeeID : null,
        EmployeeName: emp ? emp.FullName : null,
        Department: emp ? emp.Department : null,
        Gender: emp ? emp.Gender : null,
      };
    });
    rows.sort((a, b) => String(a.EmployeeName || '').localeCompare(String(b.EmployeeName || '')));
    return { recordset: rows };
  }
  // سجل يدوي مفرد (موظف + تاريخ)
  if (text.includes('FROM Attendance a') && text.includes('JOIN Employees')) {
    const emp = s.employees.find((e) => e.EmployeeID === p.employeeId);
    if (!emp) return { recordset: [] };
    const date = String(p.date).slice(0, 10);
    const att = s.attendance.find((a) => a.BiometricCode === emp.BioEmployeeID && a.LogDate === date);
    return { recordset: att ? [attRowOut(att)] : [] };
  }
  // موظف بالمعرف (يدوي — مع القسم)
  if (text.includes('FROM Employees') && text.includes('Department') && text.includes('EmployeeID = @employeeId')) {
    const emp = s.employees.find((e) => e.EmployeeID === p.employeeId);
    return { recordset: emp ? [{ EmployeeID: emp.EmployeeID, FullName: emp.FullName, Department: emp.Department, BioEmployeeID: emp.BioEmployeeID }] : [] };
  }
  // موظف بكود البصمة
  if (text.includes('WHERE BioEmployeeID = @bioCode')) {
    const emp = s.employees.find((e) => e.BioEmployeeID === p.bioCode);
    return { recordset: emp ? [{ EmployeeID: emp.EmployeeID, BioEmployeeID: emp.BioEmployeeID, FullName: emp.FullName, Department: emp.Department }] : [] };
  }
  // حضور بالمعرف
  if (text.includes('FROM Attendance') && text.includes('AttendanceID = @id') && text.includes('SELECT')) {
    const att = s.attendance.find((a) => a.AttendanceID === p.id);
    return { recordset: att ? [attRowOut(att)] : [] };
  }
  // حضور قائم بكود + تاريخ (upsert)
  if (text.includes('FROM Attendance') && text.includes('BiometricCode = @biometricCode') && text.includes('SELECT')) {
    const date = String(p.logDate).slice(0, 10);
    const att = s.attendance.find((a) => a.BiometricCode === p.biometricCode && a.LogDate === date);
    return { recordset: att ? [attRowOut(att)] : [] };
  }
  // إدراج حضور
  if (text.includes('INSERT INTO Attendance')) {
    const row = {
      AttendanceID: nextAttendanceId++,
      BiometricCode: p.biometricCode, LogDate: String(p.logDate).slice(0, 10),
      TimeIn: p.timeIn ? String(p.timeIn).slice(0, 5) : null,
      TimeOut: p.timeOut ? String(p.timeOut).slice(0, 5) : null,
      Status: p.status, TotalHours: p.totalHours,
      LateMinutes: p.lateMinutes, EarlyLeaveMinutes: p.earlyLeaveMinutes, PenaltyHours: p.penaltyHours,
    };
    s.attendance.push(row);
    return { recordset: [{ AttendanceID: row.AttendanceID }] };
  }
  // تحديث حضور
  if (text.includes('UPDATE Attendance')) {
    const att = s.attendance.find((a) => a.AttendanceID === p.id);
    if (att) {
      att.TimeIn = p.timeIn ? String(p.timeIn).slice(0, 5) : null;
      att.TimeOut = p.timeOut ? String(p.timeOut).slice(0, 5) : null;
      att.Status = p.status; att.TotalHours = p.totalHours;
      att.LateMinutes = p.lateMinutes; att.EarlyLeaveMinutes = p.earlyLeaveMinutes; att.PenaltyHours = p.penaltyHours;
    }
    return { recordset: [] };
  }
  // حذف حضور
  if (text.includes('DELETE FROM Attendance')) {
    s.attendance = s.attendance.filter((a) => a.AttendanceID !== p.id);
    return { recordset: [] };
  }
  throw new Error(`unstubbed query: ${text.slice(0, 180)}`);
}

class FakeRequest {
  constructor(_tx) { this.p = {}; }
  input(name, _type, value) { this.p[name] = value; return this; }
  async query(text) { return executeQuery(text, this.p); }
}
class FakeTransaction {
  constructor(_pool) { this.snapshot = null; }
  async begin() { this.snapshot = structuredClone(state.store); state.txLog.push('begin'); }
  async commit() { this.snapshot = null; state.txLog.push('commit'); }
  async rollback() { if (this.snapshot) state.store = this.snapshot; this.snapshot = null; state.txLog.push('rollback'); }
  request() { return new FakeRequest(this); }
}
const fakePool = { request: () => new FakeRequest(null) };
const fakeSql = {
  Int: 'Int', Date: 'Date', DateTime: 'DateTime', Bit: 'Bit', MAX: 'MAX',
  VarChar: () => 'VarChar', NVarChar: () => 'NVarChar', Decimal: () => 'Decimal',
  Transaction: FakeTransaction, Request: FakeRequest,
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };

const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const notifPath = require.resolve('../notifications/notifications.queries');
require.cache[notifPath] = {
  id: notifPath, filename: notifPath, loaded: true,
  exports: { createNotification: async () => {}, createNotificationSmart: async () => {} },
};

const q = require('./attendance.queries');
const ctrl = require('./attendance.controller');

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
const adminAuth = { userId: 1, username: 'admin', role: 'Admin', employeeId: null, claims: new Set() };
const salesAuth = { userId: 10, username: 'sales1', role: 'Sales', employeeId: null, claims: new Set() };
const salesManagerAuth = { userId: 11, username: 'sm', role: 'SalesManager', employeeId: null, claims: new Set() };
const claimViewAuth = { userId: 12, username: 'viewer', role: 'User', employeeId: null, claims: new Set(['frm_Attendance:View']) };
const claimEditAuth = { userId: 13, username: 'editor', role: 'User', employeeId: null, claims: new Set(['frm_Attendance:Edit']) };

async function invoke(fn, req, auth = adminAuth) {
  const res = mockRes();
  await fn({ auth, body: {}, params: {}, query: {}, ...req }, res);
  return res;
}
const att = () => state.store.attendance;
const auditParsed = (i) => {
  const a = state.store.audit[i];
  return { ...a, Old: a.OldData ? JSON.parse(a.OldData) : null, New: a.NewData ? JSON.parse(a.NewData) : null };
};

// ── الخام ────────────────────────────────────────────────────
test('raw: ordering LogDate/Time DESC, pagination and totalCount', async () => {
  resetStore();
  const page1 = await q.getRawBiometricLogs({ pageNumber: 1, pageSize: 2 });
  assert.equal(page1.totalCount, 6);
  assert.deepEqual(page1.items.map((i) => i.BiometricLogID), [2, 4]);
  const page2 = await q.getRawBiometricLogs({ pageNumber: 2, pageSize: 2 });
  assert.deepEqual(page2.items.map((i) => i.BiometricLogID), [3, 1]);
  const all = await q.getRawBiometricLogs({});
  assert.equal(all.items.length, 6);
  assert.equal(all.items[0].LogDate, '2026-10-30');
  assert.equal(all.items[0].LogTime, '17:02:00');
});

test('raw: code filter and date range filter', async () => {
  resetStore();
  const byCode = await q.getRawBiometricLogs({ biometricCode: 501 });
  assert.equal(byCode.totalCount, 3);
  assert.ok(byCode.items.every((i) => i.BiometricCode === 501));
  const byDate = await q.getRawBiometricLogs({ dateFrom: '2026-10-29', dateTo: '2026-10-29' });
  assert.equal(byDate.totalCount, 2);
});

test('raw: name search resolves to codes; department search resolves to codes', async () => {
  resetStore();
  const byName = await q.getRawBiometricLogs({ searchText: 'أحمد' });
  assert.equal(byName.totalCount, 3);
  assert.ok(byName.items.every((i) => i.BiometricCode === 501));
  const byDept = await q.getRawBiometricLogs({ searchText: 'المبيعات' });
  assert.equal(byDept.totalCount, 1);
  assert.equal(byDept.items[0].BiometricCode, 502);
});

test('raw: search matching nobody → totalCount 0 and NO main query executed', async () => {
  resetStore();
  state.mainQueryCount = 0;
  const res = await q.getRawBiometricLogs({ searchText: 'لا يوجد أحد بهذا الاسم' });
  assert.equal(res.totalCount, 0);
  assert.deepEqual(res.items, []);
  assert.equal(state.mainQueryCount, 0);
});

test('raw: unmatched punch surfaces with null EmployeeName/Department', async () => {
  resetStore();
  const res = await q.getRawBiometricLogs({});
  const unmatched = res.items.find((i) => i.BiometricLogID === 4);
  assert.ok(unmatched);
  assert.equal(unmatched.EmployeeName, null);
  assert.equal(unmatched.EmployeeID, null);
  assert.equal(unmatched.Department, null);
});

test('raw: todayCount counts today (Egypt date in store)', async () => {
  resetStore();
  assert.equal(await q.countTodayRawLogs(), 4);
});

test('raw controller: shape with todayCount, employeeCount from page, totalPages', async () => {
  resetStore();
  const res = await invoke(ctrl.getRawLogs, { query: { pageNumber: '1', pageSize: '2' } });
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const d = res.body.data;
  assert.equal(d.totalCount, 6);
  assert.equal(d.pageNumber, 1);
  assert.equal(d.pageSize, 2);
  assert.equal(d.totalPages, 3);
  assert.equal(d.todayCount, 4);
  assert.equal(d.employeeCount, 2); // 501 و 999 في الصفحة الأولى
  assert.equal(d.items.length, 2);
});

// ── البوابات ─────────────────────────────────────────────────
test('gates: plain Sales → 403 on raw and on manual write', async () => {
  resetStore();
  assert.equal((await invoke(ctrl.getRawLogs, { query: {} }, salesAuth)).statusCode, 403);
  const create = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  }, salesAuth);
  assert.equal(create.statusCode, 403);
  assert.equal(att().length, 0);
});

test('gates: SalesManager → raw 200 but manual 403 (Blazor excludes it)', async () => {
  resetStore();
  assert.equal((await invoke(ctrl.getRawLogs, { query: {} }, salesManagerAuth)).statusCode, 200);
  const create = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  }, salesManagerAuth);
  assert.equal(create.statusCode, 403);
});

test('gates: claim frm_Attendance:View holder → raw 200; claim Edit holder → manual 200', async () => {
  resetStore();
  assert.equal((await invoke(ctrl.getRawLogs, { query: {} }, claimViewAuth)).statusCode, 200);
  const create = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  }, claimEditAuth);
  assert.equal(create.statusCode, 200);
  assert.equal(create.body.success, true);
});

// ── اليدوي: الإنشاء والحساب ─────────────────────────────────
test('manual create on-time: late 0, hours 9, status حاضر, create message', async () => {
  resetStore();
  const res = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'إدخال يدوي' },
  });
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'تم إنشاء سجل الحضور اليدوي بنجاح.');
  const r = res.body.data.record;
  assert.equal(r.LateMinutes, 0);
  assert.equal(r.TotalHours, 9);
  assert.equal(r.Status, 'حاضر');
  assert.equal(r.EarlyLeaveMinutes, 0);
  assert.equal(att().length, 1);
});

test('manual create late: Late minutes and status flipped to متأخر even when حاضر sent', async () => {
  resetStore();
  const res = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '09:30', timeOut: '17:00', status: 'حاضر', editReason: 'تأخر مواصلات' },
  });
  const r = res.body.data.record;
  assert.equal(r.LateMinutes, 90);
  assert.equal(r.Status, 'متأخر');
  assert.equal(r.TotalHours, 7.5);
});

test('manual create with employee shift 09-18: late computed from shift, not defaults', async () => {
  resetStore();
  const res = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 4, logDate: '2026-11-02', timeIn: '09:30', timeOut: '18:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(res.body.data.record.LateMinutes, 30);
  assert.equal(res.body.data.record.EarlyLeaveMinutes, 0);
});

test('manual create absent: null times/TotalHours and zeros despite sent times', async () => {
  resetStore();
  const res = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'غائب', editReason: 'غياب' },
  });
  const r = res.body.data.record;
  assert.equal(r.TimeIn, null);
  assert.equal(r.TimeOut, null);
  assert.equal(r.TotalHours, null);
  assert.equal(r.LateMinutes, 0);
  assert.equal(r.EarlyLeaveMinutes, 0);
  assert.equal(r.PenaltyHours, 0);
  assert.equal(r.Status, 'غائب');
});

test('manual create overnight out<in: +24h hours', async () => {
  resetStore();
  const res = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '22:00', timeOut: '06:00', status: 'حاضر', editReason: 'وردية ليلية' },
  });
  assert.equal(res.body.data.record.TotalHours, 8);
});

test('manual create: audit Insert with Source ManualDailyEntry + EditReason, in transaction', async () => {
  resetStore();
  await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب الإدخال' },
  });
  assert.equal(state.store.audit.length, 1);
  const a = auditParsed(0);
  assert.equal(a.TableName, 'Attendance');
  assert.equal(a.ActionType, 'Insert');
  assert.equal(a.Old, null);
  assert.equal(a.New.Source, 'ManualDailyEntry');
  assert.equal(a.New.EditReason, 'سبب الإدخال');
  assert.equal(a.AppName, 'COCOBOLO Flutter');
  assert.ok(state.txLog.includes('commit'));
});

test('manual second POST same employee+date updates SAME row (audit Update, no duplicate)', async () => {
  resetStore();
  const first = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'أول' },
  });
  const second = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:15', timeOut: '17:00', status: 'حاضر', editReason: 'تصحيح' },
  });
  assert.equal(att().length, 1);
  assert.equal(second.body.data.attendanceId, first.body.data.attendanceId);
  assert.equal(second.body.message, 'تم تحديث سجل الحضور اليدوي بنجاح.');
  assert.equal(state.store.audit.length, 2);
  assert.equal(auditParsed(1).ActionType, 'Update');
  assert.equal(auditParsed(1).Old.TimeIn, '08:00');
  assert.equal(att()[0].TimeIn, '08:15');
});

test('manual create by biometricCode directly works; unknown code → 400 linked-employee message', async () => {
  resetStore();
  const ok = await invoke(ctrl.createManualDaily, {
    body: { biometricCode: 502, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(ok.body.success, true);
  const bad = await invoke(ctrl.createManualDaily, {
    body: { biometricCode: 777, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.body.message, 'الموظف المرتبط بكود البصمة غير موجود.');
  const missing = await invoke(ctrl.createManualDaily, {
    body: { logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(missing.statusCode, 400);
  assert.equal(missing.body.message, 'كود البصمة مطلوب.');
});

test('manual create: employee without bio code → 400 monthly-manual message and zero writes', async () => {
  resetStore();
  const res = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 3, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.body.message, 'الموظف لا يملك كود بصمة، استخدم الحضور اليدوي الشهري للمعفيين');
  assert.equal(att().length, 0);
  assert.equal(state.store.audit.length, 0);
});

test('manual create: unknown employeeId → 404; missing reason → 400; bad date → 400', async () => {
  resetStore();
  const nf = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 999, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.body.message, 'الموظف غير موجود.');
  const noReason = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر' },
  });
  assert.equal(noReason.statusCode, 400);
  assert.equal(att().length, 0);
  const badDate = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '02/11/2026', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(badDate.statusCode, 400);
});

// ── اليدوي: التعديل والحذف والبحث ───────────────────────────
test('PUT by id recomputes + audit Update without Source; message verbatim', async () => {
  resetStore();
  const created = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'أول' },
  });
  const id = created.body.data.attendanceId;
  const res = await invoke(ctrl.updateManualDaily, {
    params: { id: String(id) },
    body: { timeIn: '09:00', timeOut: '16:00', status: 'حاضر', editReason: 'تصحيح وقت' },
  });
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'تم تعديل سجل الحضور بنجاح.');
  const r = res.body.data.record;
  assert.equal(r.LateMinutes, 60);
  assert.equal(r.EarlyLeaveMinutes, 60);
  assert.equal(r.Status, 'متأخر');
  assert.equal(r.TotalHours, 7);
  // BiometricCode / LogDate لا يتغيران بالتعديل
  assert.equal(r.BiometricCode, 501);
  assert.equal(r.LogDate, '2026-11-02');
  const upd = auditParsed(state.store.audit.length - 1);
  assert.equal(upd.ActionType, 'Update');
  assert.equal(upd.New.EditReason, 'تصحيح وقت');
  assert.ok(!('Source' in upd.New));
});

test('PUT unknown id → 404 verbatim; PUT missing reason → 400', async () => {
  resetStore();
  const nf = await invoke(ctrl.updateManualDaily, {
    params: { id: '4242' },
    body: { timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'سبب' },
  });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.body.message, 'سجل الحضور غير موجود.');
  const noReason = await invoke(ctrl.updateManualDaily, {
    params: { id: '1' },
    body: { timeIn: '08:00', timeOut: '17:00', status: 'حاضر' },
  });
  assert.equal(noReason.statusCode, 400);
});

test('DELETE removes + audit Delete (OldData only); unknown id → 404', async () => {
  resetStore();
  const created = await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'أول' },
  });
  const id = created.body.data.attendanceId;
  const res = await invoke(ctrl.deleteManualDaily, { params: { id: String(id) } });
  assert.equal(res.body.success, true);
  assert.equal(res.body.message, 'تم حذف سجل الحضور بنجاح.');
  assert.equal(att().length, 0);
  const del = auditParsed(state.store.audit.length - 1);
  assert.equal(del.ActionType, 'Delete');
  assert.ok(del.Old && del.Old.Status === 'حاضر');
  assert.equal(del.New, null);
  const nf = await invoke(ctrl.deleteManualDaily, { params: { id: '4242' } });
  assert.equal(nf.statusCode, 404);
  assert.equal(nf.body.message, 'سجل الحضور غير موجود.');
});

test('record lookup: returns record + shift defaults 08:00/17:00 when no shift; employee shape', async () => {
  resetStore();
  await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'أول' },
  });
  const res = await invoke(ctrl.getManualRecord, { query: { employeeId: '1', date: '2026-11-02' } });
  assert.equal(res.body.success, true);
  const d = res.body.data;
  assert.equal(d.employee.EmployeeID, 1);
  assert.equal(d.employee.FullName, 'أحمد محمد');
  assert.equal(d.employee.Department, 'الإنتاج');
  assert.equal(d.employee.BiometricCode, 501);
  assert.ok(d.record);
  assert.equal(d.record.TimeIn, '08:00');
  assert.equal(d.shift.StartTime, '08:00');
  assert.equal(d.shift.EndTime, '17:00');
  const empty = await invoke(ctrl.getManualRecord, { query: { employeeId: '1', date: '2026-11-03' } });
  assert.equal(empty.body.data.record, null);
  const nf = await invoke(ctrl.getManualRecord, { query: { employeeId: '999', date: '2026-11-02' } });
  assert.equal(nf.statusCode, 404);
});

test('day list returns the created record(s) for the date', async () => {
  resetStore();
  await invoke(ctrl.createManualDaily, {
    body: { employeeId: 1, logDate: '2026-11-02', timeIn: '08:00', timeOut: '17:00', status: 'حاضر', editReason: 'أول' },
  });
  await invoke(ctrl.createManualDaily, {
    body: { employeeId: 2, logDate: '2026-11-02', timeIn: '08:05', timeOut: '17:00', status: 'حاضر', editReason: 'أول' },
  });
  const res = await invoke(ctrl.getManualDay, { query: { date: '2026-11-02' } });
  assert.equal(res.body.success, true);
  assert.equal(res.body.data.length, 2);
  assert.ok(res.body.data.some((r) => r.EmployeeName === 'أحمد محمد'));
  assert.ok(res.body.data.some((r) => r.EmployeeID === 2 && r.Gender === 'أنثى'));
});

test('computeManualValues pure: early leave, default status, leave status keeps status', () => {
  resetStore();
  const early = q.computeManualValues({ timeIn: '08:00', timeOut: '15:30', status: 'حاضر', shiftStart: '08:00', shiftEnd: '17:00' });
  assert.equal(early.earlyLeaveMinutes, 90);
  assert.equal(early.totalHours, 7.5);
  const def = q.computeManualValues({ timeIn: '08:00', timeOut: '17:00' });
  assert.equal(def.status, 'حاضر');
  const leave = q.computeManualValues({ timeIn: '08:00', timeOut: '17:00', status: 'إجازة' });
  assert.equal(leave.timeIn, null);
  assert.equal(leave.status, 'إجازة');
});
