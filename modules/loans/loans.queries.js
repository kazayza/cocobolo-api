const { sql, connectDB } = require('../../core/database');

async function getStats(){
  // مطابق 100% لـ EmployeeLoanService.GetStatsAsync في البلازور
  const pool = await connectDB();
  const currentMonth = new Date().toISOString().slice(0,7); // yyyy-MM
  const active = await pool.request().query(`SELECT RemainingAmount FROM EmployeeLoans WHERE Status='Active'`);
  const thisMonth = await pool.request().input('m', sql.NVarChar(7), currentMonth).query(`SELECT ISNULL(SUM(Amount),0) AS V FROM LoanInstallments WHERE DeductionMonth=@m AND Status='Pending'`);
  const completed = await pool.request().query(`SELECT COUNT(*) AS C FROM EmployeeLoans WHERE Status='Completed' AND MONTH(LastUpdatedAt)=MONTH(GETDATE()) AND YEAR(LastUpdatedAt)=YEAR(GETDATE())`);
  const totalLoan = await pool.request().query(`SELECT ISNULL(SUM(LoanAmount),0) AS V FROM EmployeeLoans WHERE Status='Active'`);
  const pendingInst = await pool.request().query(`SELECT COUNT(*) AS C FROM LoanInstallments WHERE Status='Pending'`);
  const totalCount = active.recordset.length;
  const totalRemaining = active.recordset.reduce((s,r)=>s+Number(r.RemainingAmount||0),0);
  const totalAmt = Number(totalLoan.recordset[0].V||0);
  return {
    ActiveLoansCount: totalCount,
    TotalLoanAmount: totalAmt,
    TotalRemainingAmount: totalRemaining,
    ThisMonthDeductions: Number(thisMonth.recordset[0].V||0),
    CompletedThisMonth: completed.recordset[0].C,
    AverageLoanAmount: totalCount? Math.round(totalAmt/totalCount*100)/100 : 0,
    PendingInstallmentsCount: pendingInst.recordset[0].C
  };
}
async function getLoans(filter={}){
  // مطابق لـ EmployeeLoanService.GetLoansAsync — مع دعم search على FullName/Department/JobTitle + فلتر Branch عبر Employee
  const pool = await connectDB();
  const req = pool.request();
  let where="WHERE l.Status IS NOT NULL";
  if(filter.status && filter.status!=='all'){ req.input('status', sql.NVarChar(20), filter.status); where+=` AND l.Status=@status`; }
  if(filter.search){ req.input('search', sql.NVarChar(100), `%${filter.search}%`); where+=` AND (e.FullName LIKE @search OR e.Department LIKE @search OR e.JobTitle LIKE @search)`; }
  if(filter.month){ req.input('month', sql.NVarChar(7), filter.month); where+=` AND l.StartDeductionMonth=@month`; }
  if(filter.branchId){ req.input('branchId', sql.Int, parseInt(filter.branchId,10)); where+=` AND e.BranchID=@branchId`; }
  const page=Math.max(parseInt(filter.page)||1,1); const ps=Math.min(Math.max(parseInt(filter.pageSize)||15,1),100); const off=(page-1)*ps;
  const rs = await req.query(`
    SELECT l.LoanId, l.EmployeeId, l.LoanAmount, l.TotalInstallments, l.MonthlyInstallment, l.RemainingAmount, l.PaidInstallments, l.StartDeductionMonth, l.Status, l.LoanDate, l.Notes,
           e.FullName AS EmployeeName, e.Department, e.JobTitle, e.BranchID,
           CASE WHEN e.EmploymentStatus='Resigned' THEN 'Resigned' ELSE 'Active' END AS EmployeeStatus,
           b.BranchNameAr AS BranchName
    FROM EmployeeLoans l 
    INNER JOIN Employees e ON l.EmployeeId=e.EmployeeID
    LEFT JOIN Branches b ON e.BranchID=b.BranchID
    ${where} ORDER BY l.CreatedAt DESC OFFSET ${off} ROWS FETCH NEXT ${ps} ROWS ONLY
  `);
  const cntReq = pool.request();
  if(filter.status && filter.status!=='all') cntReq.input('status2', sql.NVarChar(20), filter.status);
  if(filter.search) cntReq.input('search2', sql.NVarChar(100), `%${filter.search}%`);
  if(filter.month) cntReq.input('month2', sql.NVarChar(7), filter.month);
  if(filter.branchId) cntReq.input('branchId2', sql.Int, parseInt(filter.branchId,10));
  let where2 = where.replace(/@status/g,'@status2').replace(/@search/g,'@search2').replace(/@month/g,'@month2').replace(/@branchId/g,'@branchId2');
  const cnt = await cntReq.query(`SELECT COUNT(*) AS Total FROM EmployeeLoans l INNER JOIN Employees e ON l.EmployeeID=e.EmployeeID LEFT JOIN Branches b ON e.BranchID=b.BranchID ${where2}`);
  return { items: rs.recordset, totalCount: cnt.recordset[0]?.Total||0 };
}

async function createWithInstallments(data, username){
  // إنشاء السلفة + توليد LoanInstallments لكل شهر (مطابق للبلازور)
  const pool = await connectDB();
  const tx = new sql.Transaction(pool); await tx.begin();
  try{
    const rs = await tx.request()
      .input('empId', sql.Int, data.employeeId)
      .input('amount', sql.Decimal(18,2), data.amount)
      .input('total', sql.Int, data.totalInstallments||1)
      .input('monthly', sql.Decimal(18,2), data.monthlyInstallment || (Number(data.amount)/(data.totalInstallments||1)))
      .input('remaining', sql.Decimal(18,2), data.amount)
      .input('month', sql.NVarChar(7), data.startMonth)
      .input('notes', sql.NVarChar(500), data.notes||null)
      .input('user', sql.NVarChar(50), username)
      .query(`INSERT INTO EmployeeLoans (EmployeeID, LoanAmount, TotalInstallments, MonthlyInstallment, RemainingAmount, PaidInstallments, LoanDate, StartDeductionMonth, Status, Notes, CreatedBy, CreatedAt) OUTPUT INSERTED.LoanId VALUES (@empId, @amount, @total, @monthly, @remaining, 0, GETDATE(), @month, 'Active', @notes, @user, GETDATE())`);
    const loanId=rs.recordset[0].LoanId;
    // توليد الأقساط
    const start = new Date(data.startMonth + '-01');
    for(let i=0;i<(data.totalInstallments||1);i++){
      const d = new Date(start); d.setMonth(d.getMonth()+i);
      const m = d.toISOString().slice(0,7);
      await tx.request().input('loanId', sql.Int, loanId).input('empId2', sql.Int, data.employeeId).input('num', sql.Int, i+1).input('m2', sql.NVarChar(7), m).input('amt', sql.Decimal(18,2), Number(data.monthlyInstallment || (Number(data.amount)/(data.totalInstallments||1)))).query(`INSERT INTO LoanInstallments (LoanId, EmployeeId, InstallmentNumber, DeductionMonth, Amount, Status, CreatedAt) VALUES (@loanId, @empId2, @num, @m2, @amt, 'Pending', GETDATE())`);
    }
    await tx.commit(); return { loanId };
  }catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}
async function create(data, username){
  return createWithInstallments(data, username);
}
module.exports={ getStats, getLoans, create, createWithInstallments };
