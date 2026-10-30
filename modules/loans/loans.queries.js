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
           CASE WHEN e.Status = N'مستقيل' THEN 'Resigned' ELSE 'Active' END AS EmployeeStatus,
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
  const cnt = await cntReq.query(`SELECT COUNT(*) AS Total FROM EmployeeLoans l INNER JOIN Employees e ON l.EmployeeId=e.EmployeeID LEFT JOIN Branches b ON e.BranchID=b.BranchID ${where2}`);
  return { items: rs.recordset, totalCount: cnt.recordset[0]?.Total||0 };
}

function loanError(message, statusCode = 400){
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function round2(n){
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

// رصيد خزينة: الرصيد الافتتاحي + قبض − صرف (نفس تعريف بلازور)
async function getCashBoxBalance(makeRequest, cashBoxId){
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
      FROM CashboxTransactions WHERE CashBoxID = @cashBoxId
    `);
  const sums = sumsRes.recordset[0] || {};
  return Number(box.OpeningBalance || 0) + Number(sums.Inflow || 0) - Number(sums.Outflow || 0);
}

// إنشاء سلفة + أقساطها — مرآة EmployeeLoanService.SaveLoanAsync:238:
// شهر البداية لا يكون في الماضي؛ القسط = round(المبلغ/العدد, 2) والأخير
// يأخذ الباقي (:323-330). الخزينة إلزامية (قرار المالك د٤ — تطابق بلازور
// SaveLoanAsync الذي يرفض غياب CashBoxId بـ «يرجى اختيار الخزينة»):
// حارس الرصيد وحركة صرف 'Loan' وربط CashboxTransactionId تتم دائمًا
// في المعاملة نفسها، ولا إنشاء بلا حركة خزينة.
async function createWithInstallments(data, username){
  const employeeId = parseInt(data.employeeId, 10);
  const amount = Number(data.amount);
  const totalInstallments = parseInt(data.totalInstallments, 10) || 0;
  const startMonth = String(data.startMonth || '').trim();
  const cashBoxId = data.cashBoxId ? parseInt(data.cashBoxId, 10) : null;

  if (!employeeId) throw loanError('يرجى اختيار الموظف');
  if (!(amount > 0)) throw loanError('قيمة السلفة يجب أن تكون أكبر من صفر');
  if (!(totalInstallments > 0)) throw loanError('عدد الأقساط يجب أن يكون أكبر من صفر');
  if (!/^\d{4}-\d{2}$/.test(startMonth)) throw loanError('يرجى تحديد شهر بداية الخصم');
  const currentMonth = new Date().toISOString().slice(0, 7);
  if (startMonth < currentMonth) throw loanError('شهر بداية الخصم لا يمكن أن يكون في الماضي');
  if (!cashBoxId) throw loanError('يرجى اختيار الخزينة');

  const monthlyInstallment = round2(amount / totalInstallments);

  const pool = await connectDB();
  const tx = new sql.Transaction(pool); await tx.begin();
  try{
    const empRes = await new sql.Request(tx)
      .input('empId', sql.Int, employeeId)
      .query(`SELECT EmployeeID, FullName FROM Employees WHERE EmployeeID = @empId`);
    const employee = empRes.recordset[0];
    if (!employee) throw loanError('الموظف غير موجود');

    const balance = await getCashBoxBalance(() => new sql.Request(tx), cashBoxId);
    if (balance == null) throw loanError('الخزينة غير موجودة');
    if (balance < amount) throw loanError(`رصيد الخزينة (${balance.toFixed(2)} جـ) أقل من قيمة السلفة (${amount.toFixed(2)} جـ)`);

    const rs = await new sql.Request(tx)
      .input('empId', sql.Int, employeeId)
      .input('amount', sql.Decimal(18,2), amount)
      .input('total', sql.Int, totalInstallments)
      .input('monthly', sql.Decimal(18,2), monthlyInstallment)
      .input('remaining', sql.Decimal(18,2), amount)
      .input('month', sql.NVarChar(7), startMonth)
      .input('cashBoxId', sql.Int, cashBoxId)
      .input('notes', sql.NVarChar(500), data.notes || data.purpose || null)
      .input('user', sql.NVarChar(50), username)
      .query(`INSERT INTO EmployeeLoans (EmployeeId, LoanAmount, TotalInstallments, MonthlyInstallment, RemainingAmount, PaidInstallments, LoanDate, StartDeductionMonth, Status, CashBoxId, Notes, CreatedBy, CreatedAt) OUTPUT INSERTED.LoanId VALUES (@empId, @amount, @total, @monthly, @remaining, 0, GETDATE(), @month, 'Active', @cashBoxId, @notes, @user, GETDATE())`);
    const loanId = rs.recordset[0].LoanId;

    // توليد الأقساط: القسط الشهري المقرب، والأخير يأخذ الباقي بالضبط
    let cumulative = 0;
    for (let i = 0; i < totalInstallments; i++){
      const d = new Date(`${startMonth}-01T00:00:00Z`);
      d.setUTCMonth(d.getUTCMonth() + i);
      const m = d.toISOString().slice(0, 7);
      const amt = i === totalInstallments - 1 ? round2(amount - cumulative) : monthlyInstallment;
      cumulative = round2(cumulative + amt);
      await new sql.Request(tx)
        .input('loanId', sql.Int, loanId)
        .input('empId', sql.Int, employeeId)
        .input('num', sql.Int, i + 1)
        .input('m', sql.NVarChar(7), m)
        .input('amt', sql.Decimal(18,2), amt)
        .input('user', sql.NVarChar(50), username)
        .query(`INSERT INTO LoanInstallments (LoanId, EmployeeId, InstallmentNumber, DeductionMonth, Amount, Status, CreatedBy, CreatedAt) VALUES (@loanId, @empId, @num, @m, @amt, 'Pending', @user, GETDATE())`);
    }

    const txRes = await new sql.Request(tx)
      .input('cashBoxId', sql.Int, cashBoxId)
      .input('amount', sql.Decimal(18,2), amount)
      .input('referenceId', sql.Int, loanId)
      .input('notes', sql.NVarChar(500), `سلفة للموظف ${employee.FullName} - ${totalInstallments} قسط`)
      .input('user', sql.NVarChar(50), username)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, TransactionType, ReferenceType, ReferenceID,
          Amount, TransactionDate, Notes, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.CashboxTransactionID
        VALUES (@cashBoxId, N'صرف', 'Loan', @referenceId, @amount, GETDATE(), @notes, @user, GETDATE())
      `);
    await new sql.Request(tx)
      .input('loanId', sql.Int, loanId)
      .input('txId', sql.Int, txRes.recordset[0].CashboxTransactionID)
      .query(`UPDATE EmployeeLoans SET CashboxTransactionId = @txId WHERE LoanId = @loanId`);

    await tx.commit();
    return { loanId, monthlyInstallment };
  }catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}
async function create(data, username){
  return createWithInstallments(data, username);
}

// أقساط شهر (كل الموظفين، Pending فقط) — GetMonthInstallmentsAsync:420
async function getMonthInstallments(month){
  const pool = await connectDB();
  const rs = await pool.request()
    .input('month', sql.NVarChar(7), month)
    .query(`
      SELECT i.InstallmentId, i.LoanId, i.EmployeeId,
             e.FullName AS EmployeeName, e.Department,
             i.InstallmentNumber, i.DeductionMonth, i.DeductionMonth AS MonthDisplay,
             i.Amount, i.Status
      FROM LoanInstallments i
      INNER JOIN Employees e ON i.EmployeeId = e.EmployeeID
      WHERE i.DeductionMonth = @month AND i.Status = 'Pending'
      ORDER BY e.FullName
    `);
  return rs.recordset;
}

// كشف موظف — GetEmployeeStatementAsync:643
async function getEmployeeStatement(employeeId){
  const pool = await connectDB();
  const empRes = await pool.request()
    .input('empId', sql.Int, employeeId)
    .query(`SELECT EmployeeID, FullName, Department, JobTitle FROM Employees WHERE EmployeeID = @empId`);
  const employee = empRes.recordset[0];
  if (!employee) return null;

  const loansRes = await pool.request()
    .input('empId', sql.Int, employeeId)
    .query(`
      SELECT l.LoanId, l.EmployeeId, l.LoanAmount, l.TotalInstallments, l.MonthlyInstallment,
             l.RemainingAmount, (l.LoanAmount - l.RemainingAmount) AS PaidAmount,
             l.PaidInstallments, l.StartDeductionMonth, l.Status, l.LoanDate, l.Notes
      FROM EmployeeLoans l
      WHERE l.EmployeeId = @empId
      ORDER BY l.LoanDate DESC
    `);
  const loans = loansRes.recordset;

  const instRes = await pool.request()
    .input('empId', sql.Int, employeeId)
    .query(`
      SELECT i.InstallmentId, i.LoanId, i.EmployeeId,
             i.InstallmentNumber, i.DeductionMonth, i.Amount, i.Status,
             i.DeductionDate, i.Notes,
             (SELECT TOP 1 p.PayrollMonth FROM Payroll p WHERE p.PayrollID = i.PayrollId) AS PayrollMonth
      FROM LoanInstallments i
      WHERE i.EmployeeId = @empId
      ORDER BY i.DeductionMonth DESC, i.InstallmentNumber
    `);
  const installments = instRes.recordset;

  const currentMonth = new Date().toISOString().slice(0, 7);
  const sum = (rows, pick) => round2(rows.reduce((s, r) => s + Number(pick(r) || 0), 0));
  return {
    EmployeeId: employee.EmployeeID,
    EmployeeID: employee.EmployeeID,
    EmployeeName: employee.FullName,
    Department: employee.Department,
    JobTitle: employee.JobTitle,
    ActiveLoansCount: loans.filter((l) => l.Status === 'Active').length,
    TotalLoanAmount: sum(loans, (l) => l.LoanAmount),
    TotalPaidAmount: sum(loans, (l) => l.PaidAmount),
    TotalRemainingAmount: sum(loans, (l) => l.RemainingAmount),
    CurrentMonthDue: sum(installments.filter((i) => i.DeductionMonth === currentMonth && i.Status === 'Pending'), (i) => i.Amount),
    PendingInstallmentsCount: installments.filter((i) => i.Status === 'Pending').length,
    Loans: loans,
    Installments: installments,
  };
}

// ============================================================
// حرّاس نقل الأقساط — مرآة ValidateTargetMonthAsync /
// GetUnpaidPayrollBlockAsync في بلازور (12-H9/12-H11/د).
// حالات دفع الراتب نصوص عربية حرفية (PayrollPaymentStatuses):
// مدفوع / قيد المراجعة / معتمد / غير مدفوع / مرفوض / ملغي.
// الأعمدة الفيزيائية: Payroll.EmployeeID و Payroll.PayrollID.
// استثناء [OFFPAYROLL] بـ CHARINDEX لا LIKE (الأقواس أحرف Wildcard في LIKE).
// ============================================================
const PAYROLL_STATUS = {
  Paid: 'مدفوع',
  PendingReview: 'قيد المراجعة',
  Approved: 'معتمد',
  Unpaid: 'غير مدفوع',
  Rejected: 'مرفوض',
  Cancelled: 'ملغي',
};

function isValidMonthFormat(m){
  return /^\d{4}-\d{2}$/.test(String(m || '').trim());
}

function addMonths(monthStr, n){
  const [y, m] = String(monthStr).split('-').map(Number);
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

function appendNote(notes, line){
  return !notes ? line : `${notes}\n${line}`;
}

// يرجع { message, statusCode } عند المنع، و null عند السماح.
// فشل حالة الراتب (مصروف/محسوب) = 409؛ نفس الشهر/قبل البداية = 400.
async function validateTargetMonth(makeRequest, employeeId, targetMonth, currentInstMonth, loanStartMonth){
  if (targetMonth === currentInstMonth) {
    return { message: 'الشهر المختار هو نفس شهر القسط الحالي', statusCode: 400 };
  }
  if (targetMonth < loanStartMonth) {
    return { message: `لا يمكن نقل القسط لشهر قبل بداية خصم السلفة (${loanStartMonth})`, statusCode: 400 };
  }
  const rs = await makeRequest()
    .input('empId', sql.Int, employeeId)
    .input('targetMonth', sql.NVarChar(7), targetMonth)
    .query(`
      SELECT PaymentStatus FROM Payroll
      WHERE EmployeeID = @empId AND PayrollMonth = @targetMonth
        AND (Notes IS NULL OR CHARINDEX(N'[OFFPAYROLL]', Notes) = 0)
        AND PaymentStatus NOT IN (N'ملغي', N'مرفوض')
    `);
  const statuses = rs.recordset.map((r) => r.PaymentStatus);
  if (statuses.includes(PAYROLL_STATUS.Paid)) {
    return { message: `راتب شهر ${targetMonth} تم صرفه بالفعل — القسط لن يُخصم أبدًا لو انتقل إليه`, statusCode: 409 };
  }
  if (statuses.some((s) => s === PAYROLL_STATUS.PendingReview || s === PAYROLL_STATUS.Approved || s === PAYROLL_STATUS.Unpaid)) {
    return { message: `راتب شهر ${targetMonth} محسوب وغير مصروف — ارفض الراتب أو أعد حسابه أولًا ثم انقل القسط`, statusCode: 409 };
  }
  return null;
}

// يرجع رسالة المنع (409) أو null: قسط داخل راتب محسوب غير مصروف وبه خصم سلفة.
async function getUnpaidPayrollBlock(makeRequest, employeeId, month){
  const rs = await makeRequest()
    .input('empId', sql.Int, employeeId)
    .input('month', sql.NVarChar(7), month)
    .query(`
      SELECT TOP 1 PayrollID FROM Payroll
      WHERE EmployeeID = @empId AND PayrollMonth = @month
        AND ISNULL(LoanDeduction, 0) > 0
        AND PaymentStatus IN (N'قيد المراجعة', N'معتمد', N'غير مدفوع')
    `);
  return rs.recordset.length
    ? `هذا القسط داخل راتب شهر ${month} المحسوب وغير المصروف بعد — ارفض الراتب أو أعد حسابه أولًا، وإلا سيُخصم المبلغ من الموظف دون أن يُسجل على السلفة`
    : null;
}

async function fetchInstallmentWithLoan(makeRequest, installmentId){
  const rs = await makeRequest()
    .input('instId', sql.Int, installmentId)
    .query(`
      SELECT i.InstallmentId, i.LoanId, i.EmployeeId, i.InstallmentNumber,
             i.DeductionMonth, i.Amount, i.Status, i.Notes,
             l.Status AS LoanStatus, l.StartDeductionMonth
      FROM LoanInstallments i
      INNER JOIN EmployeeLoans l ON i.LoanId = l.LoanId
      WHERE i.InstallmentId = @instId
    `);
  return rs.recordset[0] || null;
}

async function fetchLastInstallment(makeRequest, loanId){
  const rs = await makeRequest()
    .input('loanId', sql.Int, loanId)
    .query(`
      SELECT TOP 1 InstallmentId, InstallmentNumber, DeductionMonth
      FROM LoanInstallments
      WHERE LoanId = @loanId
      ORDER BY InstallmentNumber DESC
    `);
  return rs.recordset[0] || null;
}

async function insertInstallment(makeRequest, { loanId, employeeId, number, month, amount, notes, username }){
  await makeRequest()
    .input('loanId', sql.Int, loanId)
    .input('empId', sql.Int, employeeId)
    .input('num', sql.Int, number)
    .input('month', sql.NVarChar(7), month)
    .input('amt', sql.Decimal(18,2), amount)
    .input('notes', sql.NVarChar(500), notes ?? null)
    .input('user', sql.NVarChar(50), username)
    .query(`
      INSERT INTO LoanInstallments (LoanId, EmployeeId, InstallmentNumber, DeductionMonth, Amount, Status, Notes, CreatedBy, CreatedAt)
      VALUES (@loanId, @empId, @num, @month, @amt, 'Pending', @notes, @user, GETDATE())
    `);
}

async function incrementLoanInstallments(makeRequest, loanId){
  await makeRequest()
    .input('loanId', sql.Int, loanId)
    .query(`UPDATE EmployeeLoans SET TotalInstallments = TotalInstallments + 1, LastUpdatedAt = GETDATE() WHERE LoanId = @loanId`);
}

// تفاصيل سلفة مع الأقساط — GetLoanDetailAsync:158.
// PaidAmount محسوب كما في الكشف: LoanAmount − RemainingAmount.
async function getLoanDetail(loanId){
  const pool = await connectDB();
  const loanRes = await pool.request()
    .input('loanId', sql.Int, loanId)
    .query(`
      SELECT l.LoanId, l.EmployeeId,
             e.FullName AS EmployeeName, e.Department, e.JobTitle,
             l.LoanAmount, l.MonthlyInstallment, l.TotalInstallments, l.PaidInstallments,
             (l.LoanAmount - l.RemainingAmount) AS PaidAmount, l.RemainingAmount,
             l.LoanDate, l.StartDeductionMonth, l.Status,
             l.CashBoxId, cb.CashBoxName,
             l.Notes, l.ApprovedBy, l.CreatedBy, l.CreatedAt
      FROM EmployeeLoans l
      INNER JOIN Employees e ON l.EmployeeId = e.EmployeeID
      LEFT JOIN CashBoxes cb ON l.CashBoxId = cb.CashBoxID
      WHERE l.LoanId = @loanId
    `);
  const loan = loanRes.recordset[0];
  if (!loan) return null;

  const instRes = await pool.request()
    .input('loanId', sql.Int, loanId)
    .query(`
      SELECT i.InstallmentId, i.LoanId, i.EmployeeId, i.InstallmentNumber,
             i.DeductionMonth, i.Amount, i.Status, i.DeductionDate, i.Notes,
             p.PayrollMonth
      FROM LoanInstallments i
      LEFT JOIN Payroll p ON i.PayrollId = p.PayrollID
      WHERE i.LoanId = @loanId
      ORDER BY i.InstallmentNumber
    `);
  return { Loan: loan, Installments: instRes.recordset };
}

// تأجيل قسط — SkipInstallmentAsync:502. الشهر الافتراضي: بعد شهر آخر قسط
// في جدول السلفة. القديم يصبح Skipped وملاحظاته تُستبدل بالسبب، ويُنشأ
// قسط Pending جديد برقم (الأخير + 1) وبنفس المبلغ، وTotalInstallments += 1.
async function skipInstallment(installmentId, opts = {}, username){
  const pool = await connectDB();
  const tx = new sql.Transaction(pool); await tx.begin();
  try{
    const mk = () => new sql.Request(tx);
    const inst = await fetchInstallmentWithLoan(mk, installmentId);
    if (!inst) throw loanError('القسط غير موجود', 404);
    if (inst.Status !== 'Pending') throw loanError('لا يمكن تأجيل هذا القسط — الأقساط المعلقة فقط هي التي يمكن تأجيلها', 409);

    const last = await fetchLastInstallment(mk, inst.LoanId);
    const target = opts.targetMonth != null ? String(opts.targetMonth).trim() : '';
    let newMonth;
    if (target) {
      if (!isValidMonthFormat(target)) throw loanError('صيغة الشهر غير صحيحة — مثال: 2026-08', 400);
      newMonth = target;
    } else {
      newMonth = addMonths(last.DeductionMonth, 1);
    }

    const targetBlock = await validateTargetMonth(mk, inst.EmployeeId, newMonth, inst.DeductionMonth, inst.StartDeductionMonth);
    if (targetBlock) throw loanError(targetBlock.message, targetBlock.statusCode);
    const unpaidBlock = await getUnpaidPayrollBlock(mk, inst.EmployeeId, inst.DeductionMonth);
    if (unpaidBlock) throw loanError(unpaidBlock, 409);

    await mk()
      .input('instId', sql.Int, installmentId)
      .input('reason', sql.NVarChar(500), opts.reason ?? null)
      .query(`UPDATE LoanInstallments SET Status = 'Skipped', Notes = @reason WHERE InstallmentId = @instId`);
    await insertInstallment(mk, {
      loanId: inst.LoanId, employeeId: inst.EmployeeId,
      number: last.InstallmentNumber + 1, month: newMonth,
      amount: Number(inst.Amount), notes: null, username,
    });
    await incrementLoanInstallments(mk, inst.LoanId);

    await tx.commit();
    return { installmentId, newMonth, message: `تم تأجيل القسط إلى شهر ${newMonth}` };
  }catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}

// تجزئة قسط — SplitInstallmentAsync:568. الشهر الافتراضي: شهر القسط نفسه + 1
// (يختلف عن التأجيل). الجزء المُبقى يبقى على القسط الحالي، والمُرحّل قسط
// Pending جديد بمجموع محفوظ تمامًا (round2 للجزأين).
async function splitInstallment(installmentId, opts = {}, username){
  const pool = await connectDB();
  const tx = new sql.Transaction(pool); await tx.begin();
  try{
    const mk = () => new sql.Request(tx);
    const inst = await fetchInstallmentWithLoan(mk, installmentId);
    if (!inst) throw loanError('القسط غير موجود', 404);
    if (inst.Status !== 'Pending') throw loanError('يمكن تعديل أو تجزئة القسط فقط وهو في حالة لم يُخصم بعد', 409);

    const keepRaw = Number(opts.amountToKeep);
    if (!(keepRaw > 0)) throw loanError('قيمة الخصم في هذا الشهر يجب أن تكون أكبر من صفر', 400);
    if (keepRaw >= Number(inst.Amount)) throw loanError('استخدم القسط الحالي كما هو أو التأجيل الكامل؛ التجزئة تتطلب مبلغًا أقل من قيمة القسط', 400);
    const amountToKeep = round2(keepRaw);
    const carriedAmount = round2(Number(inst.Amount) - amountToKeep);

    const target = opts.targetMonth != null ? String(opts.targetMonth).trim() : '';
    let newMonth;
    if (target) {
      if (!isValidMonthFormat(target)) throw loanError('صيغة الشهر غير صحيحة — مثال: 2026-08', 400);
      newMonth = target;
    } else {
      newMonth = addMonths(inst.DeductionMonth, 1);
    }

    const targetBlock = await validateTargetMonth(mk, inst.EmployeeId, newMonth, inst.DeductionMonth, inst.StartDeductionMonth);
    if (targetBlock) throw loanError(targetBlock.message, targetBlock.statusCode);
    const unpaidBlock = await getUnpaidPayrollBlock(mk, inst.EmployeeId, inst.DeductionMonth);
    if (unpaidBlock) throw loanError(unpaidBlock, 409);

    const last = await fetchLastInstallment(mk, inst.LoanId);
    const reason = opts.reason != null ? String(opts.reason) : '';
    if (reason.trim()) {
      await mk()
        .input('instId', sql.Int, installmentId)
        .input('amount', sql.Decimal(18,2), amountToKeep)
        .input('notes', sql.NVarChar(500), appendNote(inst.Notes, reason))
        .query(`UPDATE LoanInstallments SET Amount = @amount, Notes = @notes WHERE InstallmentId = @instId`);
    } else {
      // سبب فارغ: بلازور AppendNote كان سيضيف سطرًا فارغًا — نتجاوزه ونبقي
      // الملاحظات كما هي، ونحدّث المبلغ فقط.
      await mk()
        .input('instId', sql.Int, installmentId)
        .input('amount', sql.Decimal(18,2), amountToKeep)
        .query(`UPDATE LoanInstallments SET Amount = @amount WHERE InstallmentId = @instId`);
    }
    await insertInstallment(mk, {
      loanId: inst.LoanId, employeeId: inst.EmployeeId,
      number: last.InstallmentNumber + 1, month: newMonth,
      amount: carriedAmount,
      notes: `مُرحّل من تجزئة القسط رقم ${inst.InstallmentNumber}`, username,
    });
    await incrementLoanInstallments(mk, inst.LoanId);

    await tx.commit();
    return {
      installmentId, keptAmount: amountToKeep, carriedAmount, newMonth,
      message: `تم تجزئة القسط: ${amountToKeep.toFixed(2)} جـ لهذا الشهر، وترحيل ${carriedAmount.toFixed(2)} جـ إلى ${newMonth}`,
    };
  }catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}

// تعديل قسط معلق — UpdateInstallmentAsync:851. تعديل المبلغ لا يمتد لأي
// قسط آخر ولا لـ RemainingAmount (بلازور لا يطبق أي أثر متسلسل — موثق).
// حارس الراتب غير المصروف يُفحص فقط عند طلب تغيير الشهر (داخل فرع الشهر).
// الملاحظات تُستبدل عند وجود مفتاح notes في الطلب ولو كان نصًا فارغًا.
async function updateInstallment(installmentId, opts = {}, username){
  const pool = await connectDB();
  const tx = new sql.Transaction(pool); await tx.begin();
  try{
    const mk = () => new sql.Request(tx);
    const inst = await fetchInstallmentWithLoan(mk, installmentId);
    if (!inst) throw loanError('القسط غير موجود', 404);
    if (inst.Status !== 'Pending') throw loanError('يمكن تعديل الأقساط المعلقة فقط — المخصومة والمؤجلة سجل تاريخي لا يعدل', 409);
    if (inst.LoanStatus !== 'Active') throw loanError('السلفة غير نشطة', 409);

    const req = mk().input('instId', sql.Int, installmentId);
    const sets = [];

    if (opts.newAmount !== undefined && opts.newAmount !== null) {
      const na = Number(opts.newAmount);
      if (!(na > 0)) throw loanError('قيمة القسط يجب أن تكون أكبر من صفر', 400);
      sets.push('Amount = @newAmount');
      req.input('newAmount', sql.Decimal(18,2), round2(na));
    }

    const newMonth = opts.newMonth != null ? String(opts.newMonth).trim() : '';
    if (newMonth) {
      if (!isValidMonthFormat(newMonth)) throw loanError('صيغة الشهر غير صحيحة — مثال: 2026-08', 400);
      const targetBlock = await validateTargetMonth(mk, inst.EmployeeId, newMonth, inst.DeductionMonth, inst.StartDeductionMonth);
      if (targetBlock) throw loanError(targetBlock.message, targetBlock.statusCode);
      const unpaidBlock = await getUnpaidPayrollBlock(mk, inst.EmployeeId, inst.DeductionMonth);
      if (unpaidBlock) throw loanError(unpaidBlock, 409);
      sets.push('DeductionMonth = @newMonth');
      req.input('newMonth', sql.NVarChar(7), newMonth);
    }

    if (opts.notesPresent) {
      sets.push('Notes = @notes');
      req.input('notes', sql.NVarChar(500), opts.notes ?? null);
    }

    if (sets.length) {
      await req.query(`UPDATE LoanInstallments SET ${sets.join(', ')} WHERE InstallmentId = @instId`);
    }
    await mk()
      .input('loanId', sql.Int, inst.LoanId)
      .query(`UPDATE EmployeeLoans SET LastUpdatedAt = GETDATE() WHERE LoanId = @loanId`);

    await tx.commit();
    return { installmentId, message: 'تم تعديل القسط بنجاح' };
  }catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}

// إلغاء سلفة — CancelLoanAsync:363: نشطة فقط، بلا أقساط مخصومة،
// وحركة عكس «LoanCancel» قبض في المعاملة نفسها عند وجود خزينة.
async function cancelLoan(loanId, username){
  const pool = await connectDB();
  const tx = new sql.Transaction(pool); await tx.begin();
  try{
    const loanRes = await new sql.Request(tx)
      .input('loanId', sql.Int, loanId)
      .query(`SELECT LoanId, Status, LoanAmount, CashBoxId FROM EmployeeLoans WHERE LoanId = @loanId`);
    const loan = loanRes.recordset[0];
    if (!loan) throw loanError('السلفة غير موجودة', 404);
    if (loan.Status !== 'Active') throw loanError('لا يمكن إلغاء سلفة غير نشطة');

    const deductedRes = await new sql.Request(tx)
      .input('loanId', sql.Int, loanId)
      .query(`SELECT COUNT(*) AS C FROM LoanInstallments WHERE LoanId = @loanId AND Status = 'Deducted'`);
    if (deductedRes.recordset[0].C > 0) throw loanError('لا يمكن إلغاء سلفة تم خصم أقساط منها');

    if (loan.CashBoxId && Number(loan.LoanAmount) > 0) {
      await new sql.Request(tx)
        .input('cashBoxId', sql.Int, loan.CashBoxId)
        .input('amount', sql.Decimal(18,2), loan.LoanAmount)
        .input('referenceId', sql.Int, loanId)
        .input('notes', sql.NVarChar(500), `عكس صرف السلفة رقم ${loanId} بعد الإلغاء`)
        .input('user', sql.NVarChar(50), username)
        .query(`
          INSERT INTO CashboxTransactions (
            CashBoxID, TransactionType, ReferenceType, ReferenceID,
            Amount, TransactionDate, Notes, CreatedBy, CreatedAt
          )
          VALUES (@cashBoxId, N'قبض', 'LoanCancel', @referenceId, @amount, GETDATE(), @notes, @user, GETDATE())
        `);
    }

    await new sql.Request(tx)
      .input('loanId', sql.Int, loanId)
      .query(`
        UPDATE EmployeeLoans SET Status = 'Cancelled', RemainingAmount = 0, LastUpdatedAt = GETDATE() WHERE LoanId = @loanId;
        UPDATE LoanInstallments SET Status = 'Skipped' WHERE LoanId = @loanId AND Status = 'Pending';
      `);

    await tx.commit();
    return { loanId, cancelled: true };
  }catch(e){ try{await tx.rollback();}catch(_){} throw e; }
}

// بحث موظفين لشاشة السلف (نقطة مخصصة بدل /api/employees/lookup الغائبة)
async function getEmployeesLookup(search){
  const pool = await connectDB();
  const req = pool.request();
  let where = `WHERE (Status = N'نشط' OR Status = 'Active')`;
  if (search) {
    req.input('search', sql.NVarChar(100), `%${String(search).trim()}%`);
    where += ` AND FullName LIKE @search`;
  }
  const rs = await req.query(`
    SELECT TOP 50 EmployeeID, EmployeeID AS EmployeeId, FullName, Department, JobTitle
    FROM Employees
    ${where}
    ORDER BY FullName
  `);
  return rs.recordset;
}

module.exports={ getStats, getLoans, create, createWithInstallments, getMonthInstallments, getEmployeeStatement, cancelLoan, getEmployeesLookup, getLoanDetail, skipInstallment, splitInstallment, updateInstallment, validateTargetMonth, getUnpaidPayrollBlock, PAYROLL_STATUS };
