const { sql, connectDB } = require('../../core/database');
// منطق أيام العمل وقيمة اليوم هو منطق محرك الرواتب نفسه — لا نسخة
// موازية هنا (payroll.queries.getWorkingDays: مرآة GetWorkingDaysAsync
// في بلازور: أيام الشهر − راحة وردية الموظف (افتراض الجمعة والسبت)
// − عطلات Calendar؛ وقيمة اليوم = CurrentSalaryBase ÷ أيام العمل).
const { getWorkingDays, round2 } = require('../payroll/payroll.queries');

// ══════════════════════════════════════════════════════════════
// نظام الجزاءات — المرحلة ١. الجدول EmployeePenalties وعمود
// Employees.DirectManagerID يُنشآن بملف penalties-schema.sql
// (يُشغَّل على قاعدة البيانات قبل نشر هذه الوحدة).
// الأسماء الفيزيائية موثقة من خريطة Blazor EF
// (Models/db24804Context.cs): Employees.EmployeeID و
// Employees.CurrentSalaryBase بلا إعادة تسمية، وUsers.employeeID
// بحرف e صغير (HasColumnName)، وPayroll.PayrollMonth (Char 7)،
// وبقية أعمدة EmployeePenalties بأسماء ملف المخطط حرفيًا.
// ══════════════════════════════════════════════════════════════

function penaltyError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function isValidMonth(value) {
  return typeof value === 'string' && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

// الشهر الحالي بتوقيت القاهرة (نطاق عمل الشركة)
function currentMonth() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo', year: 'numeric', month: '2-digit',
  }).formatToParts(new Date());
  const year = parts.find((p) => p.type === 'year')?.value;
  const month = parts.find((p) => p.type === 'month')?.value;
  return `${year}-${month}`;
}

function nextMonth(month) {
  const year = Number(month.slice(0, 4));
  const mon = Number(month.slice(5, 7));
  return mon === 12 ? `${year + 1}-01` : `${year}-${String(mon + 1).padStart(2, '0')}`;
}

// الموظف المستهدف بالجزاء مع مديره المباشر وراتبه الأساسي الحالي
async function getTargetEmployee(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT EmployeeID, FullName, CurrentSalaryBase, DirectManagerID
      FROM Employees
      WHERE EmployeeID = @employeeId
    `);
  return result.recordset[0] || null;
}

// حساب قيمة اليوم والمبلغ المحسوب لجزاء في شهر معين — بنفس تعريف
// المحرك: قيمة اليوم = الأساسي ÷ أيام العمل الفعلية، والتقريب
// منزلتان على الناتج النهائي فقط (كما في خصم الغياب).
async function computeDayValue(employee, month) {
  const pool = await connectDB();
  const workingDays = await getWorkingDays(pool, employee.EmployeeID, month);
  const basic = Number(employee.CurrentSalaryBase || 0);
  const dayRate = workingDays > 0 ? basic / workingDays : 0;
  return { workingDays, dayRate, dayValue: round2(dayRate) };
}

async function computePenaltyAmount(employee, { type, daysCount, fixedAmount }, month) {
  if (type === 'Amount') {
    return { workingDays: null, dayValue: null, computedAmount: round2(fixedAmount) };
  }
  const { workingDays, dayRate, dayValue } = await computeDayValue(employee, month);
  return { workingDays, dayValue, computedAmount: round2(dayRate * Number(daysCount)) };
}

// قاعدة التجاوز: ما دام راتب الشهر المستهدف محفوظًا أصلًا (أي صف
// Payroll للموظف في ذلك الشهر) يتقدم الشهر المستهدف شهرًا واحدًا
// في كل مرة حتى أول شهر بلا راتب محفوظ.
async function rollOverTargetMonth(employeeId, requestedMonth) {
  const pool = await connectDB();
  let month = requestedMonth;
  for (let guard = 0; guard < 120; guard++) {
    const result = await pool.request()
      .input('employeeId', sql.Int, employeeId)
      .input('month', sql.Char(7), month)
      .query(`
        SELECT TOP 1 PayrollID FROM Payroll
        WHERE EmployeeID = @employeeId AND PayrollMonth = @month
      `);
    if (!result.recordset[0]) {
      return { month, rolledFrom: month !== requestedMonth ? requestedMonth : null };
    }
    month = nextMonth(month);
  }
  throw penaltyError('تعذر إيجاد شهر مفتوح لتطبيق الجزاء', 409);
}

async function insertPenalty(data) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, data.employeeId)
    .input('penaltyType', sql.NVarChar(10), data.type)
    .input('daysCount', sql.Decimal(9, 2), data.type === 'Days' ? Number(data.daysCount) : null)
    .input('fixedAmount', sql.Decimal(18, 2), data.type === 'Amount' ? Number(data.fixedAmount) : null)
    .input('computedAmount', sql.Decimal(18, 2), data.computedAmount)
    .input('targetMonth', sql.NVarChar(7), data.targetMonth)
    .input('reason', sql.NVarChar(500), data.reason)
    .input('status', sql.NVarChar(12), data.status)
    .input('createdBy', sql.Int, data.createdBy)
    .input('approvedBy', sql.Int, data.approvedBy)
    .input('approvedAt', sql.DateTime2, data.approvedAt)
    .query(`
      INSERT INTO EmployeePenalties (
        EmployeeID, PenaltyType, DaysCount, FixedAmount, ComputedAmount,
        TargetMonth, Reason, Status, CreatedBy, ApprovedBy, CreatedAt, ApprovedAt
      )
      OUTPUT INSERTED.Id, INSERTED.EmployeeID, INSERTED.PenaltyType,
             INSERTED.DaysCount, INSERTED.FixedAmount, INSERTED.ComputedAmount,
             INSERTED.TargetMonth, INSERTED.Reason, INSERTED.Status,
             INSERTED.CreatedBy, INSERTED.ApprovedBy, INSERTED.CreatedAt,
             INSERTED.ApprovedAt, INSERTED.AppliedPayrollID
      VALUES (
        @employeeId, @penaltyType, @daysCount, @fixedAmount, @computedAmount,
        @targetMonth, @reason, @status, @createdBy, @approvedBy, SYSDATETIME(), @approvedAt
      )
    `);
  return result.recordset[0];
}

const PENALTY_SELECT = `
  SELECT p.Id, p.EmployeeID, p.PenaltyType, p.DaysCount, p.FixedAmount,
         p.ComputedAmount, p.TargetMonth, p.Reason, p.Status,
         p.CreatedBy, p.ApprovedBy, p.CreatedAt, p.ApprovedAt,
         p.AppliedPayrollID,
         e.FullName AS EmployeeName, e.DirectManagerID
  FROM EmployeePenalties p
  INNER JOIN Employees e ON e.EmployeeID = p.EmployeeID
`;

async function getPenaltyById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`${PENALTY_SELECT} WHERE p.Id = @id`);
  return result.recordset[0] || null;
}

// قائمة بمرشحات ونطاق رؤية محسوب في المتحكم:
// seeAll  → كل الصفوف (بالمرشحات فقط).
// غير ذلك → صفوف الموظف نفسه + صفوف مرؤوسيه (DirectManagerID = رقمه)
//           + الصفوف التي أنشأها؛ وغير المرتبط بموظف: ما أنشأه فقط.
async function listPenalties({ seeAll, myEmployeeId, userId, employeeId, status, month }) {
  const pool = await connectDB();
  const request = pool.request();
  let where = 'WHERE 1=1';
  if (!seeAll) {
    request.input('userId', sql.Int, userId);
    if (myEmployeeId != null) {
      request.input('myEmp', sql.Int, myEmployeeId);
      where += ` AND (p.EmployeeID = @myEmp OR p.CreatedBy = @userId
                      OR p.EmployeeID IN (SELECT EmployeeID FROM Employees WHERE DirectManagerID = @myEmp))`;
    } else {
      where += ` AND p.CreatedBy = @userId`;
    }
  }
  if (employeeId != null) {
    request.input('employeeId', sql.Int, employeeId);
    where += ` AND p.EmployeeID = @employeeId`;
  }
  if (status) {
    request.input('status', sql.NVarChar(12), status);
    where += ` AND p.Status = @status`;
  }
  if (month) {
    request.input('month', sql.NVarChar(7), month);
    where += ` AND p.TargetMonth = @month`;
  }
  const result = await request.query(`${PENALTY_SELECT} ${where} ORDER BY p.CreatedAt DESC, p.Id DESC`);
  return result.recordset;
}

// طابور الاعتماد: جزاءات معلقة يكون المستدعي صاحب توقيع مباشر على
// موظفها — بحكم المطالبة (كل المعلقة) أو بحكم كونه مديرهم المباشر
// (معلقة مرؤوسيه فقط) — مع استبعاد ما أنشأه بنفسه (لا يعتمده أصلًا).
async function listPendingForSigner({ hasClaim, myEmployeeId, userId }) {
  if (!hasClaim && myEmployeeId == null) return [];
  const pool = await connectDB();
  const request = pool.request()
    .input('userId', sql.Int, userId);
  let where = `WHERE p.Status = 'Pending' AND p.CreatedBy <> @userId`;
  if (!hasClaim) {
    request.input('myEmp', sql.Int, myEmployeeId);
    where += ` AND p.EmployeeID IN (SELECT EmployeeID FROM Employees WHERE DirectManagerID = @myEmp)`;
  }
  const result = await request.query(`${PENALTY_SELECT} ${where} ORDER BY p.CreatedAt ASC, p.Id ASC`);
  return result.recordset;
}

async function listPenaltiesByEmployee(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`${PENALTY_SELECT} WHERE p.EmployeeID = @employeeId ORDER BY p.CreatedAt DESC, p.Id DESC`);
  return result.recordset;
}

// الاعتماد بحارس ذرّي على نمط أذونات القصر: التحديث مشروط بأن الصف
// ما زال معلقًا، وعدد الصفوف المتأثرة هو الحاكم (0 ⇒ سبقه غيره ⇒ 409).
async function approvePenaltyAtomic({ id, computedAmount, targetMonth, approvedBy }) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .input('computedAmount', sql.Decimal(18, 2), computedAmount)
    .input('targetMonth', sql.NVarChar(7), targetMonth)
    .input('approvedBy', sql.Int, approvedBy)
    .query(`
      UPDATE EmployeePenalties
      SET Status = 'Approved', ComputedAmount = @computedAmount,
          TargetMonth = @targetMonth, ApprovedBy = @approvedBy,
          ApprovedAt = SYSDATETIME()
      WHERE Id = @id AND Status = 'Pending';
      SELECT @@ROWCOUNT AS Affected;
    `);
  return result.recordset[0]?.Affected || 0;
}

async function rejectPenaltyAtomic(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE EmployeePenalties
      SET Status = 'Rejected'
      WHERE Id = @id AND Status = 'Pending';
      SELECT @@ROWCOUNT AS Affected;
    `);
  return result.recordset[0]?.Affected || 0;
}

async function cancelPenaltyAtomic(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      UPDATE EmployeePenalties
      SET Status = 'Cancelled'
      WHERE Id = @id AND Status IN ('Pending', 'Approved');
      SELECT @@ROWCOUNT AS Affected;
    `);
  return result.recordset[0]?.Affected || 0;
}

// مستلمو إشعار «جزاء معلق»: أصحاب التوقيع المباشر (بالصورة القابلة
// للتخزين في نظام الصلاحيات القائم: صف Permissions الذي يحمل
// FormName='frm_EmployeePenaltiesDirectSign' مع CanView=1) + كل
// مستخدمي دور Admin — بأسماء مستخدمين فردية كما يفعل المجدول.
async function getPendingNotificationUsernames() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT DISTINCT u.Username
    FROM Users u
    WHERE ISNULL(u.IsActive, 1) = 1
      AND (
        u.Role = 'Admin'
        OR EXISTS (
          SELECT 1
          FROM UserPermissions up
          INNER JOIN Permissions p ON p.PermissionID = up.PermissionID
          WHERE up.UserID = u.UserID
            AND p.FormName = 'frm_EmployeePenaltiesDirectSign'
            AND up.CanView = 1
        )
      )
  `);
  return result.recordset.map((r) => r.Username).filter(Boolean);
}

async function getUsernameByUserId(userId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .query(`SELECT TOP 1 Username FROM Users WHERE UserID = @userId`);
  return result.recordset[0]?.Username || null;
}

async function getUsernameByEmployeeId(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT TOP 1 Username FROM Users
      WHERE employeeID = @employeeId AND ISNULL(IsActive, 1) = 1
    `);
  return result.recordset[0]?.Username || null;
}

module.exports = {
  penaltyError,
  isValidMonth,
  currentMonth,
  nextMonth,
  getTargetEmployee,
  computeDayValue,
  computePenaltyAmount,
  rollOverTargetMonth,
  insertPenalty,
  getPenaltyById,
  listPenalties,
  listPendingForSigner,
  listPenaltiesByEmployee,
  approvePenaltyAtomic,
  rejectPenaltyAtomic,
  cancelPenaltyAtomic,
  getPendingNotificationUsernames,
  getUsernameByUserId,
  getUsernameByEmployeeId,
};
