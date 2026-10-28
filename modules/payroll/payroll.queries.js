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
  deletePayrollDetail
};