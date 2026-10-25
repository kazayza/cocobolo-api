const { sql, connectDB } = require('../../core/database');

const OFF_MARKER = '[OFFPAYROLL]';

async function getStats(filter = {}) {
  const pool = await connectDB();
  const req = pool.request();
  let where = `WHERE p.Notes LIKE '%${OFF_MARKER}%'`;
  if (filter.month) { req.input('month', sql.NVarChar(7), filter.month); where += ` AND p.PayrollMonth = @month`; }
  const rs = await req.query(`
    SELECT 
      ISNULL(SUM(p.NetSalary),0) AS TotalAmount,
      SUM(CASE WHEN p.PaymentStatus='قيد المراجعة' THEN 1 ELSE 0 END) AS ReviewCount,
      SUM(CASE WHEN p.PaymentStatus='معتمد' THEN 1 ELSE 0 END) AS ApprovedCount,
      SUM(CASE WHEN p.PaymentStatus='مدفوع' THEN 1 ELSE 0 END) AS PaidCount,
      SUM(CASE WHEN p.PaymentStatus='مرفوض' THEN 1 ELSE 0 END) AS RejectedCount,
      SUM(CASE WHEN p.PaymentStatus='ملغي' THEN 1 ELSE 0 END) AS CancelledCount
    FROM Payroll p ${where}
  `);
  return rs.recordset[0] || {};
}

async function getList(filter = {}) {
  const pool = await connectDB();
  const req = pool.request();
  let where = `WHERE p.Notes LIKE '%${OFF_MARKER}%'`;
  if (filter.search) { req.input('search', sql.NVarChar(100), `%${filter.search}%`); where += ` AND (e.FullName LIKE @search OR e.Department LIKE @search)`; }
  if (filter.status) { req.input('status', sql.NVarChar(20), filter.status); where += ` AND p.PaymentStatus = @status`; }
  if (filter.month) { req.input('month', sql.NVarChar(7), filter.month); where += ` AND p.PayrollMonth = @month`; }
  const page = Math.max(parseInt(filter.page)||1,1);
  const pageSize = Math.min(Math.max(parseInt(filter.pageSize)||15,1),100);
  const offset = (page-1)*pageSize;
  const rs = await req.query(`
    SELECT p.PayrollID, p.EmployeeID, p.PayrollMonth, p.BasicSalary, p.NetSalary, p.PaymentStatus, p.Notes, p.CreatedAt,
           e.FullName AS EmployeeName, e.Department, e.JobTitle
    FROM Payroll p
    INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
    ${where}
    ORDER BY p.CreatedAt DESC
    OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `);
  const cntReq = pool.request();
  if (filter.search) cntReq.input('search', sql.NVarChar(100), `%${filter.search}%`);
  if (filter.status) cntReq.input('status', sql.NVarChar(20), filter.status);
  if (filter.month) cntReq.input('month', sql.NVarChar(7), filter.month);
  const cnt = await cntReq.query(`SELECT COUNT(*) AS Total FROM Payroll p INNER JOIN Employees e ON p.EmployeeID=e.EmployeeID ${where}`);
  return { items: rs.recordset, totalCount: cnt.recordset[0]?.Total || rs.recordset.length };
}

async function create(data, username) {
  const pool = await connectDB();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const notes = `${OFF_MARKER} ${data.paymentType || 'BonusSeparate'} - ${data.description || ''} | بواسطة ${username}`;
    const rs = await tx.request()
      .input('empId', sql.Int, data.employeeId)
      .input('month', sql.NVarChar(7), data.paymentMonth || data.effectiveMonth)
      .input('amount', sql.Decimal(18,2), data.amount)
      .input('notes', sql.NVarChar(500), notes)
      .input('user', sql.NVarChar(50), username)
      .query(`
        INSERT INTO Payroll (EmployeeID, PayrollMonth, BasicSalary, NetSalary, PaymentStatus, Notes, CreatedBy, CreatedAt)
        OUTPUT INSERTED.PayrollID
        VALUES (@empId, @month, @amount, @amount, N'قيد المراجعة', @notes, @user, GETDATE())
      `);
    const payrollId = rs.recordset[0].PayrollID;
    await tx.request().input('id', sql.Int, payrollId).input('user', sql.NVarChar(50), username).query(`
      INSERT INTO Audit_Log (TableName, ActionType, PrimaryKeyValue, NewData, ActionDate, LoginName, AppName)
      VALUES (N'Payroll', N'Insert', CAST(@id AS NVARCHAR(20)), N'OffPayrollCreated', GETDATE(), @user, N'COCOBOLO Flutter')
    `).catch(()=>{});
    await tx.commit();
    return { payrollId, month: data.paymentMonth };
  } catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}

async function updateStatus(payrollId, status, username) {
  const pool = await connectDB();
  await pool.request().input('id', sql.Int, payrollId).input('status', sql.NVarChar(20), status).input('user', sql.NVarChar(50), username)
    .query(`UPDATE Payroll SET PaymentStatus=@status, LastUpdatedBy=@user, LastUpdatedAt=GETDATE() WHERE PayrollID=@id`);
}

module.exports = { getStats, getList, create, updateStatus };
