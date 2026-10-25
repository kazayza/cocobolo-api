const { sql, connectDB } = require('../../core/database');

async function getStats(){
  const pool = await connectDB();
  const rs = await pool.request().query(`
    SELECT 
      COUNT(*) AS ActiveLoansCount,
      ISNULL(SUM(CASE WHEN Status='Active' THEN LoanAmount ELSE 0 END),0) AS TotalLoanAmount,
      ISNULL(SUM(RemainingAmount),0) AS TotalRemainingAmount,
      ISNULL(SUM(MonthlyInstallment),0) AS ThisMonthDeductions,
      SUM(CASE WHEN Status='Completed' AND LoanDate >= DATEADD(month, -1, GETDATE()) THEN 1 ELSE 0 END) AS CompletedThisMonth,
      ISNULL(AVG(LoanAmount),0) AS AverageLoanAmount,
      (SELECT COUNT(*) FROM LoanInstallments WHERE Status='Pending') AS PendingInstallmentsCount
    FROM EmployeeLoans WHERE Status='Active'
  `);
  return rs.recordset[0]||{};
}
async function getLoans(filter={}){
  const pool = await connectDB();
  const req = pool.request();
  let where="WHERE l.Status IS NOT NULL";
  if(filter.status){ req.input('status', sql.NVarChar(20), filter.status); where+=` AND l.Status=@status`; }
  if(filter.search){ req.input('search', sql.NVarChar(100), `%${filter.search}%`); where+=` AND (e.FullName LIKE @search OR e.Department LIKE @search)`; }
  if(filter.month){ req.input('month', sql.NVarChar(7), filter.month); where+=` AND l.StartDeductionMonth=@month`; }
  const page=Math.max(parseInt(filter.page)||1,1), ps=Math.min(Math.max(parseInt(filter.pageSize)||15,1),100), off=(page-1)*ps;
  const rs = await req.query(`
    SELECT l.LoanId, l.EmployeeId, l.LoanAmount, l.TotalInstallments, l.MonthlyInstallment, l.RemainingAmount, l.PaidInstallments, l.StartDeductionMonth, l.Status, l.LoanDate, l.Notes,
           e.FullName AS EmployeeName, e.Department, e.JobTitle,
           CASE WHEN e.Status='Resigned' THEN 'Resigned' ELSE 'Active' END AS EmployeeStatus
    FROM EmployeeLoans l INNER JOIN Employees e ON l.EmployeeId=e.EmployeeID
    ${where} ORDER BY l.CreatedAt DESC OFFSET ${off} ROWS FETCH NEXT ${ps} ROWS ONLY
  `);
  const cnt = await pool.request().query(`SELECT COUNT(*) AS Total FROM EmployeeLoans l INNER JOIN Employees e ON l.EmployeeID=e.EmployeeID ${where}`);
  return { items: rs.recordset, totalCount: cnt.recordset[0]?.Total||0 };
}
async function create(data, username){
  const pool = await connectDB();
  const tx = new sql.Transaction(pool); await tx.begin();
  try{
    const rs = await tx.request()
      .input('empId', sql.Int, data.employeeId)
      .input('amount', sql.Decimal(18,2), data.amount)
      .input('total', sql.Int, data.totalInstallments||1)
      .input('monthly', sql.Decimal(18,2), data.monthlyInstallment || (data.amount/(data.totalInstallments||1)))
      .input('remaining', sql.Decimal(18,2), data.amount)
      .input('month', sql.NVarChar(7), data.startMonth)
      .input('notes', sql.NVarChar(500), data.notes||null)
      .input('user', sql.NVarChar(50), username)
      .query(`INSERT INTO EmployeeLoans (EmployeeId, LoanAmount, TotalInstallments, MonthlyInstallment, RemainingAmount, PaidInstallments, LoanDate, StartDeductionMonth, Status, Notes, CreatedBy, CreatedAt) OUTPUT INSERTED.LoanId VALUES (@empId, @amount, @total, @monthly, @remaining, 0, GETDATE(), @month, 'Active', @notes, @user, GETDATE())`);
    const loanId=rs.recordset[0].LoanId;
    await tx.commit(); return { loanId };
  }catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}
module.exports={ getStats, getLoans, create };
