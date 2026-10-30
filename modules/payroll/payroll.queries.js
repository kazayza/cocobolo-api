const { sql, connectDB } = require('../../core/database');

// جلب كل المرتبات — مطابق 100% لـ PayrollService.GetPayrollsAsync في البلازور
// يستثني دفعات خارج الراتب ([OFFPAYROLL]) ويستخدم نفس الفلتر: PayrollMonth / MonthFrom-To / BranchId عبر Employee
async function getPayrollByMonth(payrollMonth, extra = {}) {
  const pool = await connectDB();
  const request = pool.request();
  let where = `WHERE (p.Notes IS NULL OR p.Notes NOT LIKE '%[OFFPAYROLL]%')`;
  if (payrollMonth && String(payrollMonth).trim() !== '' && payrollMonth !== 'all') {
    request.input('payrollMonth', sql.Char(7), String(payrollMonth).trim());
    where += ` AND p.PayrollMonth = @payrollMonth`;
  }
  if (extra.branchId) {
    request.input('branchId', sql.Int, parseInt(extra.branchId, 10));
    where += ` AND e.BranchID = @branchId`;
  }
  if (extra.paymentStatus) {
    request.input('paymentStatus', sql.NVarChar(30), extra.paymentStatus);
    where += ` AND p.PaymentStatus = @paymentStatus`;
  }
  if (extra.searchText) {
    request.input('searchText', sql.NVarChar(100), `%${extra.searchText}%`);
    where += ` AND (e.FullName LIKE @searchText OR e.Department LIKE @searchText OR e.JobTitle LIKE @searchText)`;
  }
  const result = await request.query(`
      SELECT 
        p.PayrollID, p.PayrollRunID, p.EmployeeID, p.PayrollMonth,
        p.BasicSalary, ISNULL(p.BonusInPayroll,0) AS BonusInPayroll,
        ISNULL(p.AbsenceDeduction,0) AS AbsenceDeduction, ISNULL(p.LateDeduction,0) AS LateDeduction,
        ISNULL(p.LoanDeduction,0) AS LoanDeduction, ISNULL(p.PenaltyDeduction,0) AS PenaltyDeduction,
        p.BasicSalary + ISNULL(p.BonusInPayroll,0) AS GrossSalary,
        ISNULL(p.AbsenceDeduction,0)+ISNULL(p.LateDeduction,0)+ISNULL(p.LoanDeduction,0)+ISNULL(p.PenaltyDeduction,0) AS TotalDeductions,
        p.NetSalary,
        p.PaymentStatus, p.PaymentDate, p.Notes,
        p.WorkingDaysInMonth, p.PresentDays, p.AbsenceDays, p.LateMinutesTotal,
        e.FullName AS EmployeeName, e.Department, e.JobTitle, e.BranchID,
        b.BranchNameAr AS BranchName
      FROM Payroll p
      INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
      LEFT JOIN Branches b ON e.BranchID = b.BranchID
      ${where}
      ORDER BY p.PayrollMonth DESC, e.FullName
    `);
  return result.recordset;
}

// جلب قائمة الشهور المتاحة — مطابقة لـ PayrollService.GetMonthSummariesAsync (تستثني OffPayroll)
async function getPayrollMonths() {
  const pool = await connectDB();
  const result = await pool.request().query(`
      SELECT PayrollMonth, COUNT(*) AS PayrollCount, ISNULL(SUM(NetSalary),0) AS TotalNet
      FROM Payroll
      WHERE PayrollMonth IS NOT NULL AND (Notes IS NULL OR Notes NOT LIKE '%[OFFPAYROLL]%')
      GROUP BY PayrollMonth
      ORDER BY PayrollMonth DESC
    `);
  return result.recordset;
}

// إحصائيات الرواتب — مطابقة لـ PayrollService.GetStatsAsync (تستثني OffPayroll)
async function getPayrollStats(month) {
  const pool = await connectDB();
  const request = pool.request();
  let where = `WHERE (Notes IS NULL OR Notes NOT LIKE '%[OFFPAYROLL]%')`;
  if (month && month !== 'all') {
    request.input('month', sql.Char(7), month);
    where += ` AND PayrollMonth = @month`;
  }
  const result = await request.query(`
      SELECT 
        COUNT(*) AS TotalCount,
        ISNULL(SUM(NetSalary),0) AS TotalNetThisMonth,
        SUM(CASE WHEN PaymentStatus=N'قيد المراجعة' THEN 1 ELSE 0 END) AS ReviewCount,
        SUM(CASE WHEN PaymentStatus=N'معتمد' THEN 1 ELSE 0 END) AS ApprovedCount,
        SUM(CASE WHEN PaymentStatus=N'مدفوع' THEN 1 ELSE 0 END) AS PaidCount,
        SUM(CASE WHEN PaymentStatus NOT IN (N'مدفوع',N'ملغي') THEN 1 ELSE 0 END) AS PendingCount
      FROM Payroll ${where}
    `);
  // إضافات منفصلة من OffPayroll
  const offReq = pool.request();
  if (month && month !== 'all') offReq.input('month2', sql.Char(7), month);
  const off = await offReq.query(`SELECT ISNULL(SUM(NetSalary),0) AS TotalSeparateBonuses FROM Payroll WHERE Notes LIKE '%[OFFPAYROLL]%' ${month && month !== 'all' ? `AND PayrollMonth=@month2` : ''}`);
  const stats = result.recordset[0] || {};
  stats.TotalSeparateBonuses = off.recordset[0]?.TotalSeparateBonuses || 0;
  return stats;
}

// جلب مرتبات موظف معين
async function getPayrollByEmployee(employeeId) {
  const parsed = Number(employeeId);
  if (!Number.isInteger(parsed) || parsed <= 0) return [];
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, parsed)
    .query(`
      SELECT 
        p.PayrollID, p.PayrollMonth, p.BasicSalary,
        p.Allowances, p.Deductions, p.NetSalary,
        p.PaymentStatus, p.PaymentDate, p.Notes
      FROM Payroll p
      WHERE p.EmployeeID = @employeeId
      ORDER BY p.PayrollMonth DESC
    `);
  return result.recordset;
}

// جلب مرتب بالـ ID — مع تحقق رقمي (يمنع EPARAM)
async function getPayrollById(id) {
  const parsed = Number(id);
  if (!Number.isInteger(parsed) || parsed <= 0) return null;
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, parsed)
    .query(`
      SELECT 
        p.*, e.FullName AS EmployeeName, e.Department
      FROM Payroll p
      INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
      WHERE p.PayrollID = @id
    `);
  return result.recordset[0] || null;
}

// جلب تفاصيل المرتب
async function getPayrollDetails(payrollId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('payrollId', sql.Int, payrollId)
    .query(`
      SELECT PayrollDetailID, DetailType, DetailDescription, Amount
      FROM PayrollDetails
      WHERE PayrollID = @payrollId
      ORDER BY DetailType
    `);
  return result.recordset;
}

// إنشاء مرتب جديد
async function createPayroll(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, data.employeeId)
    .input('payrollMonth', sql.Char(7), data.payrollMonth)
    .input('basicSalary', sql.Decimal(18, 2), data.basicSalary)
    .input('allowances', sql.Decimal(18, 2), data.allowances || 0)
    .input('deductions', sql.Decimal(18, 2), data.deductions || 0)
    .input('paymentStatus', sql.NVarChar(20), data.paymentStatus || 'غير مدفوع')
    .input('notes', sql.NVarChar(255), data.notes || null)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO Payroll (
        EmployeeID, PayrollMonth, BasicSalary, Allowances,
        Deductions, PaymentStatus, Notes, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.PayrollID
      VALUES (
        @employeeId, @payrollMonth, @basicSalary, @allowances,
        @deductions, @paymentStatus, @notes, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].PayrollID;
}

// تعديل مرتب
async function updatePayroll(id, data) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('basicSalary', sql.Decimal(18, 2), data.basicSalary)
    .input('allowances', sql.Decimal(18, 2), data.allowances || 0)
    .input('deductions', sql.Decimal(18, 2), data.deductions || 0)
    .input('notes', sql.NVarChar(255), data.notes || null)
    .query(`
      UPDATE Payroll SET
        BasicSalary = @basicSalary, Allowances = @allowances,
        Deductions = @deductions, Notes = @notes
      WHERE PayrollID = @id
    `);
  return true;
}

// تحديث حالة الدفع
async function updatePaymentStatus(id, status, paymentDate) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .input('status', sql.NVarChar(20), status)
    .input('paymentDate', sql.DateTime, paymentDate || new Date())
    .query(`
      UPDATE Payroll SET
        PaymentStatus = @status, PaymentDate = @paymentDate
      WHERE PayrollID = @id
    `);
  return true;
}

// إضافة تفاصيل للمرتب
async function addPayrollDetail(payrollId, data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('payrollId', sql.Int, payrollId)
    .input('detailType', sql.NVarChar(50), data.detailType)
    .input('detailDescription', sql.NVarChar(255), data.detailDescription || null)
    .input('amount', sql.Decimal(18, 2), data.amount)
    .input('createdBy', sql.NVarChar(50), data.createdBy)
    .query(`
      INSERT INTO PayrollDetails (
        PayrollID, DetailType, DetailDescription, Amount, CreatedBy, CreatedAt
      )
      OUTPUT INSERTED.PayrollDetailID
      VALUES (
        @payrollId, @detailType, @detailDescription, @amount, @createdBy, GETDATE()
      )
    `);
  return result.recordset[0].PayrollDetailID;
}

// حذف تفصيل من المرتب
async function deletePayrollDetail(detailId) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, detailId)
    .query('DELETE FROM PayrollDetails WHERE PayrollDetailID = @id');
  return true;
}

// ══════════════════════════════════════════════════════════════
// حراس تجميد المسارات القديمة (مرحلة صفر الموارد): حالة المرتب
// الحالية، وحالة مرتب التفصيل الأب، وفحص تكرار (موظف، شهر).
// ══════════════════════════════════════════════════════════════
async function getLegacyPayrollStatus(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query('SELECT PaymentStatus FROM Payroll WHERE PayrollID = @id');
  return result.recordset[0]?.PaymentStatus ?? null;
}

async function getDetailParentStatus(detailId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, detailId)
    .query(`
      SELECT p.PaymentStatus
      FROM PayrollDetails d
      JOIN Payroll p ON d.PayrollID = p.PayrollID
      WHERE d.PayrollDetailID = @id
    `);
  return result.recordset[0]?.PaymentStatus ?? null;
}

async function findActivePayrollForMonth(employeeId, payrollMonth) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .input('payrollMonth', sql.Char(7), payrollMonth)
    .query(`
      SELECT TOP 1 PayrollID FROM Payroll
      WHERE EmployeeID = @employeeId AND PayrollMonth = @payrollMonth
        AND PaymentStatus <> N'ملغي'
    `);
  return result.recordset[0]?.PayrollID ?? null;
}

// ══════════════════════════════════════════════════════════════
// محرك دورة الرواتب — مرآة PayrollService.cs:
// CalculateOneAsync:295 / CalculateMonthAsync / SaveOnlyAsync:395 /
// GetRunsAsync:1203 / ApprovePayrollAsync:1045 / RejectPayrollAsync:1077 /
// PayOneAsync:733 / GetAttendanceAsync:1660 / GetWorkingDaysAsync:1984 /
// UpdatePayrollRunStatusAsync:1748 / DeductLoanInstallments:1869.
// حدود صادقة: الجزاءات والمكافآت اليدوية لا تُخترع هنا — في بلازور
// تُحرَّر يدويًا في شاشة المعالجة قبل الحفظ، وتبقى متاحة عبر تفاصيل
// المرتب القائمة. NetSalary عمود محسوب — لا يُدرج أبدًا.
// ══════════════════════════════════════════════════════════════

const PAYROLL_STATUS = {
  PendingReview: 'قيد المراجعة',
  Approved: 'معتمد',
  Rejected: 'مرفوض',
  Unpaid: 'غير مدفوع',
  Paid: 'مدفوع',
  Cancelled: 'ملغي',
};
const OFFPAYROLL_MARKER = '[OFFPAYROLL]';

function payrollError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function normRole(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

// حارس المراجع الأضيق في بلازور (IsPayrollReviewerRole:1779):
// Admin أو AccountManager فقط — يُفرض داخل الاعتماد/الرفض/الصرف.
function isPayrollReviewer(auth) {
  const role = normRole(auth?.role);
  return role === 'admin' || role === 'accountmanager';
}

function assertPayrollReviewer(auth) {
  if (!isPayrollReviewer(auth)) {
    throw payrollError('ليس لديك صلاحية اعتماد/صرف الرواتب', 403);
  }
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function appendNoteLine(notes, line) {
  if (!line) return notes || '';
  return notes ? `${notes}\n${line}` : line;
}

function monthBounds(month) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(month || ''));
  if (!m) throw payrollError('صيغة الشهر غير صحيحة (YYYY-MM)');
  const year = Number(m[1]);
  const mon = Number(m[2]);
  const start = `${month}-01`;
  const next = mon === 12 ? `${year + 1}-01-01` : `${year}-${String(mon + 1).padStart(2, '0')}-01`;
  return { year, mon, start, next, daysInMonth: new Date(Date.UTC(year, mon, 0)).getUTCDate() };
}

// الوردية السارية للموظف عند بداية الشهر (أحدث EffectiveFrom)
async function getEmployeeShift(pool, employeeId, monthStartStr) {
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .input('monthStart', sql.Date, monthStartStr)
    .query(`
      SELECT TOP 1 BiometricCode, OffDay1, OffDay2
      FROM EmployeeShifts
      WHERE EmployeeID = @employeeId
        AND EffectiveFrom <= @monthStart
        AND (EffectiveTo IS NULL OR EffectiveTo >= @monthStart)
      ORDER BY EffectiveFrom DESC
    `);
  return result.recordset[0] || null;
}

function shiftOffDays(shift) {
  const days = [];
  if (shift?.OffDay1 != null) days.push(Number(shift.OffDay1));
  if (shift?.OffDay2 != null) days.push(Number(shift.OffDay2));
  return days;
}

// GetWorkingDaysAsync:1984 — أيام راحة الوردية أو الجمعة/السبت افتراضيًا،
// منقوصًا منها عطلات جدول Calendar.
async function getWorkingDays(pool, employeeId, month) {
  const { year, mon, start, next, daysInMonth } = monthBounds(month);
  const shift = await getEmployeeShift(pool, employeeId, start);
  let offDays = shiftOffDays(shift);
  if (offDays.length === 0) offDays = [5, 6]; // Friday, Saturday (.NET DayOfWeek)

  const holidaysRes = await pool.request()
    .input('start', sql.Date, start)
    .input('next', sql.Date, next)
    .query(`
      SELECT CalendarDate FROM Calendar
      WHERE IsHoliday = 1 AND CalendarDate >= @start AND CalendarDate < @next
    `);
  const holidaySet = new Set(holidaysRes.recordset.map((r) => {
    const d = r.CalendarDate instanceof Date ? r.CalendarDate : new Date(r.CalendarDate);
    return `${d.getUTCFullYear()}-${d.getUTCMonth()}-${d.getUTCDate()}`;
  }));

  let count = 0;
  for (let day = 1; day <= daysInMonth; day++) {
    const d = new Date(Date.UTC(year, mon - 1, day));
    if (offDays.includes(d.getUTCDay())) continue;
    if (holidaySet.has(`${year}-${mon - 1}-${day}`)) continue;
    count++;
  }
  return count;
}

// GetAttendanceAsync:1660 — الحضور اليدوي أولًا للمعفيين (سجل
// AttendanceManual)، ثم البصمة مع استبعاد أيام راحة الوردية.
async function getAttendance(pool, employeeId, month) {
  const { start, next } = monthBounds(month);

  const manualRes = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .input('month', sql.NVarChar(10), month)
    .query(`
      SELECT TOP 1 PresentDays, LateMinutes FROM AttendanceManual
      WHERE EmployeeID = @employeeId AND AttendanceMonth = @month
    `);
  const manual = manualRes.recordset[0];
  if (manual) {
    const manualWorkDays = await getWorkingDays(pool, employeeId, month);
    return { workDays: manualWorkDays, presentDays: manual.PresentDays || 0, lateMinutes: manual.LateMinutes || 0, isManual: true };
  }

  const shift = await getEmployeeShift(pool, employeeId, start);
  const workDays = await getWorkingDays(pool, employeeId, month);

  let bioCode = shift?.BiometricCode ?? null;
  if (bioCode == null) {
    const empRes = await pool.request()
      .input('employeeId', sql.Int, employeeId)
      .query(`SELECT BioEmployeeID FROM Employees WHERE EmployeeID = @employeeId`);
    bioCode = empRes.recordset[0]?.BioEmployeeID ?? null;
  }
  if (bioCode == null) {
    return { workDays, presentDays: 0, lateMinutes: 0, isManual: false };
  }

  const attRes = await pool.request()
    .input('bioCode', sql.Int, bioCode)
    .input('start', sql.Date, start)
    .input('next', sql.Date, next)
    .query(`
      SELECT LogDate, LateMinutes FROM Attendance
      WHERE BiometricCode = @bioCode AND LogDate >= @start AND LogDate < @next
        AND TimeIn IS NOT NULL
    `);
  const offDays = shiftOffDays(shift);
  const valid = offDays.length === 0
    ? attRes.recordset
    : attRes.recordset.filter((r) => {
        const d = r.LogDate instanceof Date ? r.LogDate : new Date(r.LogDate);
        return !offDays.includes(d.getUTCDay());
      });

  return {
    workDays,
    presentDays: valid.length,
    lateMinutes: valid.reduce((s, r) => s + (r.LateMinutes || 0), 0),
    isManual: false,
  };
}

// CalculateOneAsync:295 — الأساسي من CurrentSalaryBase؛ سعر اليوم
// وسعر الدقيقة؛ خصم غياب وتأخير؛ أقساط السلف Pending للشهر.
async function calculateOne(pool, employeeId, month) {
  const empRes = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`SELECT EmployeeID, FullName, Department, CurrentSalaryBase FROM Employees WHERE EmployeeID = @employeeId`);
  const emp = empRes.recordset[0];
  if (!emp) throw payrollError(`الموظف ${employeeId} غير موجود`, 404);

  const basic = Number(emp.CurrentSalaryBase || 0);
  const att = await getAttendance(pool, employeeId, month);
  const workDays = att.workDays > 0 ? att.workDays : await getWorkingDays(pool, employeeId, month);
  const dayRate = workDays > 0 ? basic / workDays : 0;
  const minRate = workDays > 0 ? basic / workDays / 8 / 60 : 0;
  const absDays = Math.max(0, workDays - att.presentDays);
  const absDed = round2(dayRate * absDays);
  const lateDed = round2(minRate * att.lateMinutes);

  const loanRes = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .input('month', sql.NVarChar(10), month)
    .query(`
      SELECT li.InstallmentId, li.InstallmentNumber, li.Amount, l.TotalInstallments
      FROM LoanInstallments li
      INNER JOIN EmployeeLoans l ON li.LoanId = l.LoanId
      WHERE li.EmployeeId = @employeeId AND li.DeductionMonth = @month AND li.Status = 'Pending'
      ORDER BY li.InstallmentNumber
    `);
  const loanItems = loanRes.recordset.map((r) => ({
    DetailID: r.InstallmentId,
    DetailType: 'LoanDeduction',
    Description: `قسط سلفة #${r.InstallmentNumber}/${r.TotalInstallments}`,
    Amount: Number(r.Amount || 0),
    IsDeduction: true,
    PaymentType: 'InPayroll',
  }));
  const loanDeduction = round2(loanItems.reduce((s, i) => s + i.Amount, 0));

  const existingRes = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .input('month', sql.NVarChar(10), month)
    .input('marker', sql.NVarChar(20), OFFPAYROLL_MARKER)
    .query(`
      SELECT TOP 1 PayrollID, PaymentStatus FROM Payroll
      WHERE EmployeeID = @employeeId AND PayrollMonth = @month
        AND (Notes IS NULL OR Notes NOT LIKE '%' + @marker + '%')
    `);
  const existing = existingRes.recordset[0] || null;

  const totalDeductions = round2(absDed + lateDed + loanDeduction);
  return {
    EmployeeID: employeeId,
    EmployeeName: emp.FullName,
    Department: emp.Department,
    BasicSalary: basic,
    WorkingDaysInMonth: workDays,
    PresentDays: att.presentDays,
    AbsenceDays: absDays,
    LateMinutesTotal: att.lateMinutes,
    IsManualAttendance: att.isManual,
    AbsenceDeduction: absDed,
    LateDeduction: lateDed,
    LoanDeduction: loanDeduction,
    LoanItems: loanItems,
    PenaltyDeduction: 0,
    GrossSalary: basic,
    TotalDeductions: totalDeductions,
    NetSalary: round2(basic - totalDeductions),
    HasExistingPayroll: existing != null,
    ExistingPayrollID: existing?.PayrollID ?? null,
    Warning: existing ? `راتب مسجل (${existing.PaymentStatus})` : null,
  };
}

async function calculateMonth(month) {
  const pool = await connectDB();
  const idsRes = await pool.request().query(`
    SELECT EmployeeID FROM Employees
    WHERE Status = N'نشط' OR Status = 'Active'
    ORDER BY Department, FullName
  `);
  const results = [];
  for (const row of idsRes.recordset) {
    try {
      results.push(await calculateOne(pool, row.EmployeeID, month));
    } catch (err) {
      results.push({ EmployeeID: row.EmployeeID, Warning: `خطأ في الحساب: ${err.message}` });
    }
  }
  return results;
}

// SaveOnlyAsync:395 — حفظ جماعي كتشغيل PendingReview، مع تخطي
// المسجل سابقًا وصفر الأساسي، وتفاصيل غياب/تأخير/سلف — معاملة واحدة.
async function saveRun(month, username) {
  const calculations = await calculateMonth(month);
  const selected = calculations.filter((c) => !c.HasExistingPayroll && !c.Warning?.startsWith('خطأ'));
  if (selected.length === 0) throw payrollError('لم يتم اختيار أي موظف');

  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const runRes = await new sql.Request(transaction)
      .input('month', sql.Char(7), month)
      .input('notes', sql.NVarChar(500), `تم إنشاء كشف الرواتب وإرساله للمراجعة بواسطة ${username}`)
      .input('createdBy', sql.NVarChar(50), username)
      .query(`
        INSERT INTO PayrollRuns (PayrollMonth, Status, Notes, CreatedBy, CreatedAt)
        OUTPUT INSERTED.RunID
        VALUES (@month, 'PendingReview', @notes, @createdBy, GETDATE())
      `);
    const runId = runRes.recordset[0].RunID;

    let sumGross = 0;
    let sumDed = 0;
    let sumNet = 0;
    let count = 0;

    for (const calc of selected) {
      if (!calc.BasicSalary) continue; // صفر الأساسي يُتخطى كما في بلازور
      const netVal = round2(calc.BasicSalary - calc.TotalDeductions);

      const payrollRes = await new sql.Request(transaction)
        .input('employeeId', sql.Int, calc.EmployeeID)
        .input('month', sql.Char(7), month)
        .input('basicSalary', sql.Decimal(18, 2), calc.BasicSalary)
        .input('bonusInPayroll', sql.Decimal(18, 2), 0)
        .input('allowances', sql.Decimal(18, 2), 0)
        .input('deductions', sql.Decimal(18, 2), calc.TotalDeductions)
        .input('absenceDeduction', sql.Decimal(18, 2), calc.AbsenceDeduction)
        .input('lateDeduction', sql.Decimal(18, 2), calc.LateDeduction)
        .input('loanDeduction', sql.Decimal(18, 2), calc.LoanDeduction)
        .input('penaltyDeduction', sql.Decimal(18, 2), 0)
        .input('workingDays', sql.Int, calc.WorkingDaysInMonth)
        .input('presentDays', sql.Int, calc.PresentDays)
        .input('absenceDays', sql.Int, calc.AbsenceDays)
        .input('lateMinutes', sql.Int, calc.LateMinutesTotal)
        .input('isManual', sql.Bit, calc.IsManualAttendance)
        .input('status', sql.NVarChar(20), PAYROLL_STATUS.PendingReview)
        .input('runId', sql.Int, runId)
        .input('createdBy', sql.NVarChar(50), username)
        .query(`
          INSERT INTO Payroll (
            EmployeeID, PayrollMonth, BasicSalary, BonusInPayroll,
            Allowances, Deductions, AbsenceDeduction, LateDeduction,
            LoanDeduction, PenaltyDeduction, WorkingDaysInMonth,
            PresentDays, AbsenceDays, LateMinutesTotal, IsManualAttendance,
            PaymentStatus, PayrollRunID, CreatedBy, CreatedAt
          )
          OUTPUT INSERTED.PayrollID
          VALUES (
            @employeeId, @month, @basicSalary, @bonusInPayroll,
            @allowances, @deductions, @absenceDeduction, @lateDeduction,
            @loanDeduction, @penaltyDeduction, @workingDays,
            @presentDays, @absenceDays, @lateMinutes, @isManual,
            @status, @runId, @createdBy, GETDATE()
          )
        `);
      const payrollId = payrollRes.recordset[0].PayrollID;

      const details = [];
      if (calc.AbsenceDeduction > 0) {
        details.push({ type: 'AbsenceDeduction', description: `خصم غياب ${calc.AbsenceDays} يوم`, amount: calc.AbsenceDeduction });
      }
      if (calc.LateDeduction > 0) {
        details.push({ type: 'LateDeduction', description: `خصم تأخير ${calc.LateMinutesTotal} دقيقة`, amount: calc.LateDeduction });
      }
      for (const item of calc.LoanItems) {
        if (item.Amount > 0) details.push({ type: 'LoanDeduction', description: item.Description, amount: item.Amount });
      }
      for (const d of details) {
        await new sql.Request(transaction)
          .input('payrollId', sql.Int, payrollId)
          .input('detailType', sql.NVarChar(50), d.type)
          .input('description', sql.NVarChar(255), d.description)
          .input('amount', sql.Decimal(18, 2), d.amount)
          .input('createdBy', sql.NVarChar(50), username)
          .query(`
            INSERT INTO PayrollDetails (PayrollID, DetailType, DetailDescription, Amount, IsDeduction, PaymentType, CreatedBy, CreatedAt)
            VALUES (@payrollId, @detailType, @description, @amount, 1, 'InPayroll', @createdBy, GETDATE())
          `);
      }

      sumGross += calc.BasicSalary;
      sumDed += calc.TotalDeductions;
      sumNet += netVal;
      count++;
    }

    if (count === 0) throw payrollError('لم يتم إنشاء أي رواتب صالحة للحفظ');

    await new sql.Request(transaction)
      .input('runId', sql.Int, runId)
      .input('totalEmployees', sql.Int, count)
      .input('totalGross', sql.Decimal(18, 2), round2(sumGross))
      .input('totalDeductions', sql.Decimal(18, 2), round2(sumDed))
      .input('totalNet', sql.Decimal(18, 2), round2(sumNet))
      .query(`
        UPDATE PayrollRuns
        SET Status = 'PendingReview', TotalEmployees = @totalEmployees,
            TotalGross = @totalGross, TotalDeductions = @totalDeductions, TotalNet = @totalNet
        WHERE RunID = @runId
      `);

    await transaction.commit();
    return { runId, count, totalGross: round2(sumGross), totalDeductions: round2(sumDed), totalNet: round2(sumNet) };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// GetRunsAsync:1203 — تستثني تشغيلات خارج الراتب
async function getRuns(month = null) {
  const pool = await connectDB();
  const request = pool.request();
  let query = `
    SELECT RunID, PayrollMonth, Status, TotalEmployees, TotalGross,
           TotalDeductions, TotalNet, CashBoxID, ProcessedBy, ProcessedAt,
           CreatedBy, CreatedAt
    FROM PayrollRuns
    WHERE (Notes IS NULL OR Notes NOT LIKE '%[OFFPAYROLL]%')
  `;
  if (month) {
    request.input('month', sql.Char(7), month);
    query += ` AND PayrollMonth = @month`;
  }
  query += ` ORDER BY CreatedAt DESC`;
  const result = await request.query(query);
  return result.recordset.map((r) => ({
    RunID: r.RunID,
    PayrollMonth: r.PayrollMonth,
    Status: r.Status,
    TotalEmployees: r.TotalEmployees || 0,
    TotalGross: Number(r.TotalGross || 0),
    TotalDeductions: Number(r.TotalDeductions || 0),
    TotalNet: Number(r.TotalNet || 0),
    CashBoxID: r.CashBoxID,
    ProcessedBy: r.ProcessedBy,
    ProcessedAt: r.ProcessedAt,
    CreatedBy: r.CreatedBy,
    CreatedAt: r.CreatedAt,
  }));
}

// رصيد خزينة — مرآة GetCashBalanceAsync: الرصيد الافتتاحي + قبض − صرف
async function getCashBalance(makeRequest, cashBoxId) {
  const boxRes = await makeRequest()
    .input('cashBoxId', sql.Int, cashBoxId)
    .query(`SELECT OpeningBalance FROM CashBoxes WHERE CashBoxID = @cashBoxId`);
  const box = boxRes.recordset[0];
  if (!box) return null;
  const sumsRes = await makeRequest()
    .input('cashBoxId', sql.Int, cashBoxId)
    .query(`
      SELECT
        ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END), 0) AS Inflow,
        ISNULL(SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END), 0) AS Outflow
      FROM CashboxTransactions
      WHERE CashBoxID = @cashBoxId
    `);
  const sums = sumsRes.recordset[0] || {};
  return Number(box.OpeningBalance || 0) + Number(sums.Inflow || 0) - Number(sums.Outflow || 0);
}

// UpdatePayrollRunStatusAsync:1748 — حالة التشغيل من حالات رواتبه
async function updateRunStatus(makeRequest, payrollRunId) {
  if (!payrollRunId) return;
  const statusesRes = await makeRequest()
    .input('runId', sql.Int, payrollRunId)
    .query(`SELECT PaymentStatus FROM Payroll WHERE PayrollRunID = @runId`);
  const statuses = statusesRes.recordset.map((r) => r.PaymentStatus).filter(Boolean);
  if (statuses.length === 0) return;

  const S = PAYROLL_STATUS;
  let status;
  if (statuses.every((s) => s === S.Cancelled)) status = 'Cancelled';
  else if (statuses.every((s) => s === S.Paid || s === S.Cancelled)) status = 'Completed';
  else if (statuses.some((s) => s === S.Rejected)) status = 'Rejected';
  else if (statuses.some((s) => s === S.PendingReview)) status = 'PendingReview';
  else if (statuses.every((s) => s === S.Approved || s === S.Paid || s === S.Unpaid || s === S.Cancelled)) status = 'Approved';
  else status = 'Draft';

  await makeRequest()
    .input('runId', sql.Int, payrollRunId)
    .input('status', sql.NVarChar(30), status)
    .query(`UPDATE PayrollRuns SET Status = @status WHERE RunID = @runId`);
}

async function loadPayrollRow(makeRequest, payrollId) {
  const res = await makeRequest()
    .input('id', sql.Int, payrollId)
    .query(`
      SELECT p.*, e.FullName AS EmployeeName
      FROM Payroll p
      INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
      WHERE p.PayrollID = @id
    `);
  return res.recordset[0] || null;
}

// اعتماد مرتب/دفعة — مرآة ApprovePayrollAsync:1045 (يعمل لخارج الراتب
// أيضًا لأن السجل نفسه صف Payroll موسوم [OFFPAYROLL]).
async function approvePayroll(payrollId, auth) {
  assertPayrollReviewer(auth);
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const makeRequest = () => new sql.Request(transaction);
    const payroll = await loadPayrollRow(makeRequest, payrollId);
    if (!payroll) throw payrollError('الراتب غير موجود', 404);
    if (payroll.PaymentStatus === PAYROLL_STATUS.Paid) throw payrollError('لا يمكن اعتماد راتب مدفوع');
    if (payroll.PaymentStatus === PAYROLL_STATUS.Cancelled) throw payrollError('لا يمكن اعتماد راتب ملغي');
    if (payroll.PaymentStatus === PAYROLL_STATUS.Approved) throw payrollError('الراتب معتمد بالفعل');

    await makeRequest()
      .input('id', sql.Int, payrollId)
      .input('status', sql.NVarChar(20), PAYROLL_STATUS.Approved)
      .input('notes', sql.NVarChar(sql.MAX), appendNoteLine(payroll.Notes, `[اعتماد: ${auth.username} - ${nowStamp()}]`))
      .query(`UPDATE Payroll SET PaymentStatus = @status, Notes = @notes WHERE PayrollID = @id`);

    await updateRunStatus(makeRequest, payroll.PayrollRunID);
    await transaction.commit();
    return { payrollId, status: PAYROLL_STATUS.Approved };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// رفض مرتب/دفعة — مرآة RejectPayrollAsync:1077
async function rejectPayroll(payrollId, auth, reason = null) {
  assertPayrollReviewer(auth);
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const makeRequest = () => new sql.Request(transaction);
    const payroll = await loadPayrollRow(makeRequest, payrollId);
    if (!payroll) throw payrollError('الراتب غير موجود', 404);
    if (payroll.PaymentStatus === PAYROLL_STATUS.Paid) throw payrollError('لا يمكن رفض راتب مدفوع');
    if (payroll.PaymentStatus === PAYROLL_STATUS.Cancelled) throw payrollError('لا يمكن رفض راتب ملغي');

    await makeRequest()
      .input('id', sql.Int, payrollId)
      .input('status', sql.NVarChar(20), PAYROLL_STATUS.Rejected)
      .input('notes', sql.NVarChar(sql.MAX), appendNoteLine(payroll.Notes, `[رفض: ${auth.username} - ${nowStamp()}] ${reason || ''}`.trim()))
      .query(`UPDATE Payroll SET PaymentStatus = @status, Notes = @notes WHERE PayrollID = @id`);

    await updateRunStatus(makeRequest, payroll.PayrollRunID);
    await transaction.commit();
    return { payrollId, status: PAYROLL_STATUS.Rejected };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// خصم أقساط السلف عند الصرف — مرآة DeductLoanInstallments:1869:
// FIFO بأولوية مطابقة المبلغ أولًا ثم أول سطر متاح.
async function deductLoanInstallments(makeRequest, payroll, username) {
  const detailsRes = await makeRequest()
    .input('payrollId', sql.Int, payroll.PayrollID)
    .query(`
      SELECT PayrollDetailID, Amount FROM PayrollDetails
      WHERE PayrollID = @payrollId AND DetailType = 'LoanDeduction'
      ORDER BY PayrollDetailID
    `);
  const loanDetails = detailsRes.recordset;
  if (loanDetails.length === 0) return;

  const instRes = await makeRequest()
    .input('employeeId', sql.Int, payroll.EmployeeID)
    .input('month', sql.NVarChar(10), payroll.PayrollMonth)
    .query(`
      SELECT InstallmentId, LoanId, InstallmentNumber, Amount, Notes
      FROM LoanInstallments
      WHERE EmployeeId = @employeeId AND DeductionMonth = @month AND Status = 'Pending'
      ORDER BY InstallmentNumber
    `);
  const installments = instRes.recordset;
  if (installments.length === 0) return;

  const usedDetailIds = new Set();
  for (const inst of installments) {
    const matched = loanDetails.find((d) => !usedDetailIds.has(d.PayrollDetailID) && Number(d.Amount) === Number(inst.Amount))
      || loanDetails.find((d) => !usedDetailIds.has(d.PayrollDetailID));
    if (!matched) continue;
    usedDetailIds.add(matched.PayrollDetailID);

    let notes = inst.Notes || null;
    if (Number(matched.Amount) !== Number(inst.Amount)) {
      notes = appendNoteLine(notes, `تنبيه: سطر الخصم في الراتب بمبلغ ${Number(matched.Amount).toFixed(2)} يختلف عن مبلغ القسط ${Number(inst.Amount).toFixed(2)} — راجع حساب السلفة`);
    }
    notes = appendNoteLine(notes, `تم خصم القسط مع صرف راتب شهر ${payroll.PayrollMonth} بواسطة ${username}`);

    await makeRequest()
      .input('installmentId', sql.Int, inst.InstallmentId)
      .input('payrollId', sql.Int, payroll.PayrollID)
      .input('payrollDetailId', sql.Int, matched.PayrollDetailID)
      .input('notes', sql.NVarChar(sql.MAX), notes)
      .query(`
        UPDATE LoanInstallments
        SET Status = 'Deducted', PayrollId = @payrollId, PayrollDetailId = @payrollDetailId,
            DeductionDate = GETDATE(), Notes = @notes
        WHERE InstallmentId = @installmentId
      `);

    await makeRequest()
      .input('loanId', sql.Int, inst.LoanId)
      .input('amount', sql.Decimal(18, 2), inst.Amount)
      .query(`
        UPDATE EmployeeLoans
        SET PaidInstallments = PaidInstallments + 1,
            RemainingAmount = RemainingAmount - @amount,
            LastUpdatedAt = GETDATE()
        WHERE LoanId = @loanId;
        UPDATE EmployeeLoans
        SET Status = 'Completed', RemainingAmount = 0
        WHERE LoanId = @loanId AND (RemainingAmount <= 0 OR PaidInstallments >= TotalInstallments);
      `);
  }
}

// صرف مرتب/دفعة — مرآة PayOneAsync:733: معتمد (أو غير مدفوع) وغير
// مدفوع من قبل فقط؛ حارس رصيد يشمل المبالغ المنفصلة؛ حركة «صرف»
// Payroll للصافي + حركة لكل بند منفصل؛ خصم أقساط السلف؛ حالة
// التشغيل — كل ذلك في معاملة واحدة.
async function payPayroll(payrollId, cashBoxId, auth) {
  assertPayrollReviewer(auth);
  if (!cashBoxId) throw payrollError('اختيار الخزينة مطلوب');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  await transaction.begin();
  try {
    const makeRequest = () => new sql.Request(transaction);
    const payroll = await loadPayrollRow(makeRequest, payrollId);
    if (!payroll) throw payrollError('الراتب غير موجود', 404);
    if (payroll.PaymentStatus === PAYROLL_STATUS.Paid) throw payrollError('الراتب تم صرفه بالفعل');
    if (payroll.PaymentStatus === PAYROLL_STATUS.Cancelled) throw payrollError('لا يمكن صرف راتب ملغي');
    if (payroll.PaymentStatus !== PAYROLL_STATUS.Approved && payroll.PaymentStatus !== PAYROLL_STATUS.Unpaid) {
      throw payrollError('لا يمكن صرف الراتب قبل الاعتماد');
    }

    const isOffPayroll = String(payroll.Notes || '').toUpperCase().includes(OFFPAYROLL_MARKER);
    const recordLabel = isOffPayroll ? 'الدفعة خارج الراتب' : 'الراتب';
    // NetSalary عمود محسوب؛ غيابه احتياطيًا يعني الأساسي (سلوك بلازور نفسه)
    const netAmount = Number(payroll.NetSalary ?? payroll.BasicSalary ?? 0);

    const separateRes = await makeRequest()
      .input('payrollId', sql.Int, payrollId)
      .query(`
        SELECT PayrollDetailID, DetailType, DetailDescription, Amount
        FROM PayrollDetails
        WHERE PayrollID = @payrollId AND PaymentType = 'Separate' AND CashboxTransactionID IS NULL
      `);
    const separateDetails = separateRes.recordset;
    const totalSeparate = round2(separateDetails.reduce((s, d) => s + Number(d.Amount || 0), 0));
    const totalPayout = round2(netAmount + totalSeparate);

    const balance = await getCashBalance(makeRequest, cashBoxId);
    if (balance == null) throw payrollError('الخزينة غير موجودة', 404);
    if (balance < totalPayout) {
      throw payrollError(`رصيد الخزينة (${balance.toFixed(2)} جـ) أقل من إجمالي المطلوب للصرف (${totalPayout.toFixed(2)} جـ)`);
    }

    if (netAmount > 0) {
      const txRes = await makeRequest()
        .input('cashBoxId', sql.Int, cashBoxId)
        .input('amount', sql.Decimal(18, 2), netAmount)
        .input('referenceId', sql.Int, payrollId)
        .input('notes', sql.NVarChar(500), `${recordLabel} ${payroll.EmployeeName} - ${payroll.PayrollMonth}`)
        .input('createdBy', sql.NVarChar(50), auth.username)
        .query(`
          INSERT INTO CashboxTransactions (
            CashBoxID, TransactionType, ReferenceType, ReferenceID,
            Amount, TransactionDate, Notes, CreatedBy, CreatedAt
          )
          OUTPUT INSERTED.CashboxTransactionID
          VALUES (@cashBoxId, N'صرف', 'Payroll', @referenceId, @amount, GETDATE(), @notes, @createdBy, GETDATE())
        `);
      const salaryTxId = txRes.recordset[0].CashboxTransactionID;
      await makeRequest()
        .input('id', sql.Int, payrollId)
        .input('txId', sql.Int, salaryTxId)
        .query(`UPDATE Payroll SET CashboxTransactionID = @txId WHERE PayrollID = @id`);
    }

    for (const detail of separateDetails) {
      const sepRes = await makeRequest()
        .input('cashBoxId', sql.Int, cashBoxId)
        .input('amount', sql.Decimal(18, 2), detail.Amount)
        .input('referenceType', sql.NVarChar(50), detail.DetailType)
        .input('referenceId', sql.Int, payrollId)
        .input('notes', sql.NVarChar(500), `${detail.DetailDescription || detail.DetailType} - ${payroll.EmployeeName} - ${payroll.PayrollMonth}`)
        .input('createdBy', sql.NVarChar(50), auth.username)
        .query(`
          INSERT INTO CashboxTransactions (
            CashBoxID, TransactionType, ReferenceType, ReferenceID,
            Amount, TransactionDate, Notes, CreatedBy, CreatedAt
          )
          OUTPUT INSERTED.CashboxTransactionID
          VALUES (@cashBoxId, N'صرف', @referenceType, @referenceId, @amount, GETDATE(), @notes, @createdBy, GETDATE())
        `);
      await makeRequest()
        .input('detailId', sql.Int, detail.PayrollDetailID)
        .input('txId', sql.Int, sepRes.recordset[0].CashboxTransactionID)
        .query(`UPDATE PayrollDetails SET CashboxTransactionID = @txId WHERE PayrollDetailID = @detailId`);
    }

    await deductLoanInstallments(makeRequest, payroll, auth.username);

    await makeRequest()
      .input('id', sql.Int, payrollId)
      .input('status', sql.NVarChar(20), PAYROLL_STATUS.Paid)
      .input('notes', sql.NVarChar(sql.MAX), appendNoteLine(payroll.Notes, `[صرف: ${auth.username} - ${nowStamp()} | خزينة #${cashBoxId}]`))
      .query(`
        UPDATE Payroll
        SET PaymentStatus = @status, PaymentDate = GETDATE(), Notes = @notes
        WHERE PayrollID = @id
      `);

    await updateRunStatus(makeRequest, payroll.PayrollRunID);
    await transaction.commit();
    return { payrollId, netAmount, totalSeparate, totalPayout, status: PAYROLL_STATUS.Paid };
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// تصدير الدوال
module.exports = {
  getPayrollByMonth,
  getPayrollMonths,
  getPayrollStats,
  getPayrollByEmployee,
  getPayrollById,
  getPayrollDetails,
  createPayroll,
  updatePayroll,
  updatePaymentStatus,
  addPayrollDetail,
  deletePayrollDetail,
  getLegacyPayrollStatus,
  getDetailParentStatus,
  findActivePayrollForMonth,
  // محرك الدورة (البند 34) — يُعاد استخدامه لدفعات خارج الراتب (البند 19)
  PAYROLL_STATUS,
  calculateOne,
  calculateMonth,
  saveRun,
  getRuns,
  approvePayroll,
  rejectPayroll,
  payPayroll,
  isPayrollReviewer
};