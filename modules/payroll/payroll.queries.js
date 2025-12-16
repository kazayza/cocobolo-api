const { sql, connectDB } = require('../../core/database');

// جلب كل المرتبات لشهر معين
async function getPayrollByMonth(payrollMonth) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('payrollMonth', sql.Char(7), payrollMonth)
    .query(`
      SELECT 
        p.PayrollID, p.EmployeeID, p.PayrollMonth,
        p.BasicSalary, p.Allowances, p.Deductions, p.NetSalary,
        p.PaymentStatus, p.PaymentDate, p.Notes,
        p.CreatedBy, p.CreatedAt,
        e.FullName AS EmployeeName, e.Department, e.JobTitle
      FROM Payroll p
      INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
      WHERE p.PayrollMonth = @payrollMonth
      ORDER BY e.FullName
    `);
  return result.recordset;
}

// جلب مرتبات موظف معين
async function getPayrollByEmployee(employeeId) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('employeeId', sql.Int, employeeId)
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

// جلب مرتب بالـ ID
async function getPayrollById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
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
  getPayrollByEmployee,
  getPayrollById,
  getPayrollDetails,
  createPayroll,
  updatePayroll,
  updatePaymentStatus,
  addPayrollDetail,
  deletePayrollDetail
};