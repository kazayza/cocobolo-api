// اختبارات مُحاكاة (stubbed) لاستثناءات الحضور — مرآة سلوك بلازور
// (AttendanceService.CreateExemptionAsync / Approve / Reject / Delete
// وصفحة ExemptionsPage): إنشاء بمعرف الموظف، تحققات التكرار والراحة
// والساعات، بوابة الحذف، والإشعارات. بلا أي قاعدة بيانات حية.
// التشغيل: node --test modules/attendance/attendance-exemptions.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');

// ── المخزن الوهمي ─────────────────────────────────────────────
const state = { store: null, notifications: [], attendanceApplied: 0, attendanceDeletes: 0 };
let nextExemptionId;

function resetStore() {
  nextExemptionId = 1000;
  state.notifications = [];
  state.attendanceApplied = 0;
  state.attendanceDeletes = 0;
  state.store = {
    employees: [
      { EmployeeID: 1, BioEmployeeID: 501, FullName: 'موظف أول' },
      { EmployeeID: 2, BioEmployeeID: null, FullName: 'موظف بلا بصمة' },
      { EmployeeID: 3, BioEmployeeID: 503, FullName: 'موظف ثالث' },
    ],
    ownByUser: { 77: 1 }, // UserID 77 مرتبط بالموظف 1
    shifts: { 1: { OffDay1: 5, OffDay2: 6 } }, // راحة الجمعة والسبت
    exemptions: [
      {
        ExemptionID: 900, BioEmployeeID: 501, EmployeeID: 1,
        ExemptionDate: '2026-11-02', ReasonCode: 'إذن', Description: null,
        IsFullDay: true, Hours: null, IsDeducted: true, Notes: null,
        CreatedBy: 'maker', Status: 'Approved', ApprovedBy: 'boss', CreatedDate: '2026-11-01',
      },
      {
        ExemptionID: 901, BioEmployeeID: 503, EmployeeID: 3,
        ExemptionDate: '2026-11-03', ReasonCode: 'مأمورية', Description: null,
        IsFullDay: true, Hours: null, IsDeducted: false, Notes: null,
        CreatedBy: 'requester', Status: 'Pending', ApprovedBy: null, CreatedDate: '2026-11-01',
      },
    ],
    managerUsernames: ['admin', 'hrboss'],
  };
}
resetStore();

const dateKey = (v) => (v instanceof Date ? v.toISOString().slice(0, 10) : String(v).slice(0, 10));

class FakeRequest {
  constructor() { this.p = {}; }
  input(name, _type, value) { this.p[name] = value; return this; }
  async query(rawText) {
    const text = rawText.replace(/\s+/g, ' ');
    const s = state.store;
    const p = this.p;

    if (text.includes('INSERT INTO DailyExemptions')) {
      const row = {
        ExemptionID: nextExemptionId++,
        BioEmployeeID: p.bioEmployeeId, EmployeeID: p.employeeId,
        ExemptionDate: p.exemptionDate, ReasonCode: p.reasonCode,
        Description: p.description, IsFullDay: p.isFullDay, Hours: p.hours,
        IsDeducted: p.isDeducted, Notes: p.notes, CreatedBy: p.createdBy,
        Status: p.status, ApprovedBy: p.approvedBy, CreatedDate: '2026-11-01',
      };
      s.exemptions.push(row);
      return { recordset: [{ ExemptionID: row.ExemptionID }] };
    }
    if (text.includes('SELECT TOP 1 ExemptionID') && text.includes('FROM DailyExemptions')) {
      const dup = s.exemptions.find((e) => e.BioEmployeeID === p.bioCode
        && dateKey(e.ExemptionDate) === dateKey(p.exemptionDate)
        && (e.Status == null || e.Status !== 'Rejected'));
      return { recordset: dup ? [{ ExemptionID: dup.ExemptionID }] : [] };
    }
    if (text.includes('SELECT TOP 1 OffDay1, OffDay2')) {
      const shift = s.shifts[p.employeeId];
      return { recordset: shift ? [shift] : [] };
    }
    if (text.includes('FROM Users u') && text.includes('JOIN Employees')) {
      const empId = s.ownByUser[p.userId];
      const emp = s.employees.find((e) => e.EmployeeID === empId);
      return { recordset: emp ? [emp] : [] };
    }
    if (text.includes('SELECT Username') && text.includes('FROM Users')) {
      return { recordset: s.managerUsernames.map((Username) => ({ Username })) };
    }
    if (text.includes('FROM Employees') && text.includes('WHERE BioEmployeeID = @bioCode')) {
      const emp = s.employees.find((e) => e.BioEmployeeID === p.bioCode);
      return { recordset: emp ? [emp] : [] };
    }
    if (text.includes('FROM Employees') && text.includes('WHERE EmployeeID = @employeeId')) {
      const emp = s.employees.find((e) => e.EmployeeID === p.employeeId);
      return { recordset: emp ? [emp] : [] };
    }
    if (text.includes('DECLARE @ShiftStart')) { // applyExemptionAttendance
      state.attendanceApplied++;
      return { recordset: [] };
    }
    if (text.includes('UPDATE DailyExemptions')) {
      const row = s.exemptions.find((e) => e.ExemptionID === p.id);
      if (row) {
        row.Status = p.status;
        row.ApprovedBy = p.approvedBy;
        if (p.rejectionReason) {
          row.Notes = row.Notes ? `${row.Notes} [سبب الرفض: ${p.rejectionReason}]` : `[سبب الرفض: ${p.rejectionReason}]`;
        }
      }
      return { recordset: [] };
    }
    if (text.includes('DELETE FROM Attendance')) {
      state.attendanceDeletes++;
      return { recordset: [] };
    }
    if (text.includes('DELETE FROM DailyExemptions')) {
      state.store.exemptions = s.exemptions.filter((e) => e.ExemptionID !== p.id);
      return { recordset: [] };
    }
    if (text.includes('FROM DailyExemptions x')) { // getAllExemptions
      state.lastListQuery = text;
      return {
        recordset: s.exemptions.map((e) => ({
          ...e,
          EmployeeName: s.employees.find((x) => x.EmployeeID === e.EmployeeID)?.FullName || '',
          Department: 'الإنتاج', Gender: 'ذكر',
        })),
      };
    }
    if (text.includes('FROM DailyExemptions') && text.includes('WHERE ExemptionID = @id')) {
      const row = s.exemptions.find((e) => e.ExemptionID === p.id);
      return { recordset: row ? [row] : [] };
    }
    throw new Error(`unstubbed query: ${text.slice(0, 160)}`);
  }
}

const fakePool = { request: () => new FakeRequest() };
const fakeSql = {
  Int: 'Int', Date: 'Date', DateTime: 'DateTime', Bit: 'Bit', MAX: 'MAX',
  NVarChar: () => 'NVarChar', Decimal: () => 'Decimal',
};
const fakeDb = { sql: fakeSql, connectDB: async () => fakePool, getPool: () => fakePool };

const dbPath = require.resolve('../../core/database');
require.cache[dbPath] = { id: dbPath, filename: dbPath, loaded: true, exports: fakeDb };
const notifPath = require.resolve('../notifications/notifications.queries');
require.cache[notifPath] = {
  id: notifPath, filename: notifPath, loaded: true,
  exports: {
    createNotification: async (data) => { state.notifications.push(data); },
    createNotificationSmart: async () => {},
  },
};

const ctrl = require('./attendance.controller');

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(code) { this.statusCode = code; return this; },
    json(obj) { this.body = obj; return this; },
  };
}
const managerAuth = { userId: 1, username: 'boss', role: 'HrManager', employeeId: null, claims: new Set() };
// ملحوظة: دوال المتحكم توقّعها (req, res) — نمرر res عبر غلاف صغير
async function invoke(fn, req, auth = managerAuth) {
  const res = mockRes();
  await fn({ auth, body: {}, params: {}, query: {}, ...req }, res);
  return res;
}

test('إنشاء مدير بمعرف الموظف: يُعتمد فورًا، يُخزَّن EmployeeID والبصمة، ينعكس على الحضور، ويُخطر المديرون', async () => {
  resetStore();
  const res = await invoke(ctrl.createExemption, {
    body: { employeeId: 1, exemptionDate: '2026-11-04', reasonCode: 'مأمورية', isFullDay: true },
  });
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 'Approved');
  const row = state.store.exemptions.find((e) => e.ExemptionID === res.body.exemptionId);
  assert.equal(row.EmployeeID, 1);
  assert.equal(row.BioEmployeeID, 501);
  assert.equal(state.attendanceApplied, 1);
  assert.ok(state.notifications.some((n) => n.title.includes('اعتماد استثناء مباشرة')));
  assert.ok(state.notifications.every((n) => n.formName === 'frmDailyExemptions'));
});

test('إنشاء لموظف بلا كود بصمة يُرفض برسالة بلازور وبلا أي كتابة', async () => {
  resetStore();
  const before = state.store.exemptions.length;
  const res = await invoke(ctrl.createExemption, {
    body: { employeeId: 2, exemptionDate: '2026-11-04', reasonCode: 'إذن' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /ليس لديه كود بصمة/);
  assert.equal(state.store.exemptions.length, before);
});

test('تكرار نفس اليوم (غير مرفوض) يُرفض', async () => {
  resetStore();
  const res = await invoke(ctrl.createExemption, {
    body: { employeeId: 1, exemptionDate: '2026-11-02', reasonCode: 'إذن' },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /مسجل بالفعل/);
});

test('يوم راحة أسبوعية (جمعة للموظف 1) يُرفض', async () => {
  resetStore();
  const res = await invoke(ctrl.createExemption, {
    body: { employeeId: 1, exemptionDate: '2026-11-06', reasonCode: 'إذن' }, // جمعة
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /راحة أسبوعية/);
});

test('استثناء جزئي بلا ساعات يُرفض', async () => {
  resetStore();
  const res = await invoke(ctrl.createExemption, {
    body: { employeeId: 1, exemptionDate: '2026-11-04', reasonCode: 'إذن', isFullDay: false },
  });
  assert.equal(res.statusCode, 400);
  assert.match(res.body.message, /عدد الساعات/);
});

test('غير المدير ينشئ لنفسه فقط ولو استهدف غيره — يولد Pending ويُخطر المديرون', async () => {
  resetStore();
  const selfAuth = { userId: 77, username: 'emp1', role: 'Sales', employeeId: 1, claims: new Set() };
  const res = await invoke(ctrl.createExemption, {
    body: { employeeId: 3, exemptionDate: '2026-11-04', reasonCode: 'إذن', isFullDay: false, hours: 2 },
  }, selfAuth);
  assert.equal(res.body.success, true);
  assert.equal(res.body.status, 'Pending');
  const row = state.store.exemptions.find((e) => e.ExemptionID === res.body.exemptionId);
  assert.equal(row.EmployeeID, 1); // فُرض عليه موظفه هو لا المستهدف
  assert.ok(state.notifications.some((n) => n.title.includes('قيد الاعتماد')));
});

test('غير مرتبط بموظف لا يستطيع الإنشاء', async () => {
  resetStore();
  const orphanAuth = { userId: 999, username: 'orphan', role: 'Sales', employeeId: null, claims: new Set() };
  const res = await invoke(ctrl.createExemption, {
    body: { exemptionDate: '2026-11-04', reasonCode: 'إذن' },
  }, orphanAuth);
  assert.equal(res.statusCode, 400);
});

test('اعتماد معلق: يحدّث الحالة وينعكس على الحضور ويُخطر المنشئ', async () => {
  resetStore();
  const res = await invoke(ctrl.approveExemption, { params: { id: '901' } });
  assert.equal(res.body.success, true);
  assert.equal(state.store.exemptions.find((e) => e.ExemptionID === 901).Status, 'Approved');
  assert.equal(state.attendanceApplied, 1);
  const decision = state.notifications.find((n) => n.recipientUser === 'requester');
  assert.ok(decision && decision.title.includes('تم اعتماد الاستثناء'));
});

test('اعتماد من غير مدير إعفاءات: 403', async () => {
  resetStore();
  const salesAuth = { userId: 9, username: 's', role: 'Sales', employeeId: null, claims: new Set() };
  const res = await invoke(ctrl.approveExemption, { params: { id: '901' } }, salesAuth);
  assert.equal(res.statusCode, 403);
});

test('حذف: بوابة بلازور — المدير العام ومدير الحسابات خارجها، HR والأدمن وحامل المطالبة داخلها', async () => {
  resetStore();
  const gm = { userId: 2, username: 'gm', role: 'GeneralManager', employeeId: null, claims: new Set() };
  assert.equal((await invoke(ctrl.removeExemption, { params: { id: '901' } }, gm)).statusCode, 403);
  const am = { userId: 3, username: 'am', role: 'AccountManager', employeeId: null, claims: new Set() };
  assert.equal((await invoke(ctrl.removeExemption, { params: { id: '901' } }, am)).statusCode, 403);
  const claimHolder = { userId: 4, username: 'c', role: 'Sales', employeeId: null, claims: new Set(['frmDailyExemptions:Delete']) };
  assert.equal((await invoke(ctrl.removeExemption, { params: { id: '901' } }, claimHolder)).body.success, true);
});

test('حذف استثناء معتمد يزيل سجل الحضور المرتبط أولًا', async () => {
  resetStore();
  const res = await invoke(ctrl.removeExemption, { params: { id: '900' } });
  assert.equal(res.body.success, true);
  assert.equal(state.attendanceDeletes, 1);
  assert.equal(state.store.exemptions.some((e) => e.ExemptionID === 900), false);
});

test('قائمة بمرشح حالة Pending: الاستعلام يحمل دلالات بلازور للصفوف القديمة', async () => {
  resetStore();
  const res = await invoke(ctrl.getExemptionsList, { query: { status: 'Pending' } });
  assert.ok(Array.isArray(res.body));
  assert.match(state.lastListQuery, /Status = N'Pending' OR \(\(x\.Status IS NULL/);
});
