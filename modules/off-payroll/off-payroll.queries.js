const { sql, connectDB } = require('../../core/database');
const payrollEngine = require('../payroll/payroll.queries');

// ============================================================
// دفعات خارج الراتب — مرآة PayrollService.cs (OffPayroll):
// الدفعة = تشغيل PayrollRuns موسوم + صف Payroll موسوم [OFFPAYROLL]
// بصفر أساسي/خصومات + بند PayrollDetails واحد PaymentType='Separate'
// يحمل النوع والوصف والمبلغ (SaveOffPayrollPaymentAsync:1334).
// NetSalary عمود محسوب = (الأساسي + الحافز) − الخصومات ⇒ صفر دائمًا
// لصفوف خارج الراتب؛ المبلغ الحقيقي في البند المنفصل حصرًا.
// الانتقاء بالوسم بـ CHARINDEX لا LIKE: أقواس [OFFPAYROLL] في LIKE
// فئة أحرف (Wildcard) تطابق أي ملحوظة فيها أحد أحرفها — نفس درس
// وحدة السلف (loans.queries.js:257).
// ============================================================

const OFF_MARKER = '[OFFPAYROLL]';
const MARKER_WHERE = `CHARINDEX(N'[OFFPAYROLL]', p.Notes) > 0`;

const PAYMENT_TYPES = {
  BonusSeparate: 'مكافأة منفصلة',
  CommissionSeparate: 'عمولة منفصلة',
};

function offError(message, statusCode = 400) {
  const err = new Error(message);
  err.statusCode = statusCode;
  return err;
}

function round2(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

function appendNoteLine(notes, line) {
  if (!line) return notes || '';
  return notes ? `${notes}\n${line}` : line;
}

function nowStamp() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

// BuildOffPayrollNotes:1834 — نفس سطور ملحوظات بلازور حرفيًا.
function buildNotes(data, employeeName, username) {
  const lines = [
    OFF_MARKER,
    `[نوع العملية] ${PAYMENT_TYPES[data.paymentType] || 'دفعة خارج الراتب'}`,
    `[الموظف] ${employeeName}`,
    `[الوصف] ${String(data.description || '').trim()}`,
    `[المبلغ] ${Number(data.amount).toFixed(2)} جـ`,
    `[تم الإنشاء بواسطة] ${username} - ${nowStamp()}`,
  ];
  if (data.reason && String(data.reason).trim()) {
    lines.push(`[السبب] ${String(data.reason).trim()}`);
  }
  return lines.join('\n');
}

// شروط القائمة المشتركة (GetOffPayrollPaymentsAsync:1264) — الشهر،
// الموظف، الحالة، النوع (على البند المنفصل موضع العرض)، والبحث في
// الاسم/القسم/الملحوظات/بنود التفصيل.
function buildWhere(filter, req) {
  let where = `WHERE ${MARKER_WHERE}`;
  if (filter.month) { req.input('month', sql.NVarChar(7), filter.month); where += ` AND p.PayrollMonth = @month`; }
  if (filter.employeeId) { req.input('employeeId', sql.Int, parseInt(filter.employeeId, 10)); where += ` AND p.EmployeeID = @employeeId`; }
  if (filter.status) { req.input('status', sql.NVarChar(20), filter.status); where += ` AND p.PaymentStatus = @status`; }
  if (filter.paymentType) {
    req.input('paymentType', sql.NVarChar(50), filter.paymentType);
    where += ` AND EXISTS (SELECT 1 FROM PayrollDetails d WHERE d.PayrollID = p.PayrollID AND d.PaymentType = 'Separate' AND d.DetailType = @paymentType)`;
  }
  if (filter.search) {
    req.input('search', sql.NVarChar(100), `%${filter.search}%`);
    where += ` AND (e.FullName LIKE @search OR e.Department LIKE @search OR p.Notes LIKE @search
      OR EXISTS (SELECT 1 FROM PayrollDetails d WHERE d.PayrollID = p.PayrollID
        AND (d.DetailDescription LIKE @search OR d.DetailType LIKE @search)))`;
  }
  return where;
}

async function getList(filter = {}) {
  const pool = await connectDB();
  const req = pool.request();
  const where = buildWhere(filter, req);
  const page = Math.max(parseInt(filter.page) || 1, 1);
  const pageSize = Math.min(Math.max(parseInt(filter.pageSize) || 15, 1), 100);
  const offset = (page - 1) * pageSize;
  const rs = await req.query(`
    SELECT p.PayrollID, p.EmployeeID, p.PayrollMonth, p.PaymentStatus, p.Notes, p.CreatedBy,
           p.CreatedAt AS RequestedAt, p.PaymentDate AS PaidAt,
           e.FullName AS EmployeeName, e.Department, e.JobTitle,
           sep.DetailType AS PaymentType, sep.DetailDescription AS Description,
           ISNULL(amt.Total, 0) AS Amount
    FROM Payroll p
    INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
    OUTER APPLY (
      SELECT TOP 1 d.DetailType, d.DetailDescription
      FROM PayrollDetails d
      WHERE d.PayrollID = p.PayrollID AND d.PaymentType = 'Separate'
      ORDER BY d.PayrollDetailID
    ) sep
    OUTER APPLY (
      SELECT SUM(d.Amount) AS Total
      FROM PayrollDetails d
      WHERE d.PayrollID = p.PayrollID AND d.PaymentType = 'Separate'
    ) amt
    ${where}
    ORDER BY p.CreatedAt DESC
    OFFSET ${offset} ROWS FETCH NEXT ${pageSize} ROWS ONLY
  `);
  const cntReq = pool.request();
  const cntWhere = buildWhere(filter, cntReq);
  const cnt = await cntReq.query(`SELECT COUNT(*) AS Total FROM Payroll p INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID ${cntWhere}`);
  return { items: rs.recordset, totalCount: cnt.recordset[0]?.Total || rs.recordset.length };
}

// GetOffPayrollPaymentStatsAsync:1320 — يُشتق من مجموعة القائمة
// المفلترة نفسها: المجموع من البنود المنفصلة، والعدّادات من الحالات.
async function getStats(filter = {}) {
  const pool = await connectDB();
  const req = pool.request();
  const where = buildWhere(filter, req);
  const rs = await req.query(`
    SELECT
      SUM(CASE WHEN p.PaymentStatus = N'قيد المراجعة' THEN 1 ELSE 0 END) AS ReviewCount,
      SUM(CASE WHEN p.PaymentStatus = N'معتمد' THEN 1 ELSE 0 END) AS ApprovedCount,
      SUM(CASE WHEN p.PaymentStatus = N'مدفوع' THEN 1 ELSE 0 END) AS PaidCount,
      SUM(CASE WHEN p.PaymentStatus = N'مرفوض' THEN 1 ELSE 0 END) AS RejectedCount,
      SUM(CASE WHEN p.PaymentStatus = N'ملغي' THEN 1 ELSE 0 END) AS CancelledCount
    FROM Payroll p
    INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
    ${where}
  `);
  const amtReq = pool.request();
  const amtWhere = buildWhere(filter, amtReq);
  const amt = await amtReq.query(`
    SELECT ISNULL(SUM(d.Amount), 0) AS TotalAmount
    FROM Payroll p
    INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
    INNER JOIN PayrollDetails d ON d.PayrollID = p.PayrollID AND d.PaymentType = 'Separate'
    ${amtWhere}
  `);
  const row = rs.recordset[0] || {};
  return {
    TotalAmount: Number(amt.recordset[0]?.TotalAmount || 0),
    ReviewCount: Number(row.ReviewCount || 0),
    ApprovedCount: Number(row.ApprovedCount || 0),
    PaidCount: Number(row.PaidCount || 0),
    RejectedCount: Number(row.RejectedCount || 0),
    CancelledCount: Number(row.CancelledCount || 0),
  };
}

// SaveOffPayrollPaymentAsync:1334 — تشغيل + صف + بند في معاملة واحدة.
// الشهر الفعّال = ReferenceMonth إن وُجد وإلا شهر الدفعة (EffectiveMonth).
async function create(data, username) {
  const pool = await connectDB();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const empRes = await new sql.Request(tx)
      .input('empId', sql.Int, data.employeeId)
      .query(`SELECT EmployeeID, FullName FROM Employees WHERE EmployeeID = @empId`);
    const employee = empRes.recordset[0];
    if (!employee) throw offError('الموظف غير موجود', 404);

    const effectiveMonth = data.referenceMonth || data.paymentMonth;
    const amount = round2(data.amount);

    const runRes = await new sql.Request(tx)
      .input('month', sql.NVarChar(7), effectiveMonth)
      .input('notes', sql.NVarChar(500), `${OFF_MARKER} دفعة خارج الراتب للموظف ${employee.FullName}`)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('user', sql.NVarChar(50), username)
      .query(`
        INSERT INTO PayrollRuns (PayrollMonth, Status, Notes, TotalEmployees, TotalGross, TotalDeductions, TotalNet, CreatedBy, CreatedAt)
        OUTPUT INSERTED.RunID
        VALUES (@month, 'PendingReview', @notes, 1, @amount, 0, @amount, @user, GETDATE())
      `);
    const runId = runRes.recordset[0].RunID;

    const payRes = await new sql.Request(tx)
      .input('empId', sql.Int, data.employeeId)
      .input('month', sql.NVarChar(7), effectiveMonth)
      .input('notes', sql.NVarChar(sql.MAX), buildNotes(data, employee.FullName, username))
      .input('runId', sql.Int, runId)
      .input('user', sql.NVarChar(50), username)
      .query(`
        INSERT INTO Payroll (
          EmployeeID, PayrollMonth, BasicSalary, BonusInPayroll, Allowances, Deductions,
          AbsenceDeduction, LateDeduction, LoanDeduction, PenaltyDeduction,
          WorkingDaysInMonth, PresentDays, AbsenceDays, LateMinutesTotal, IsManualAttendance,
          PaymentStatus, Notes, PayrollRunID, CreatedBy, CreatedAt
        )
        OUTPUT INSERTED.PayrollID
        VALUES (@empId, @month, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
          N'قيد المراجعة', @notes, @runId, @user, GETDATE())
      `);
    const payrollId = payRes.recordset[0].PayrollID;

    await new sql.Request(tx)
      .input('payrollId', sql.Int, payrollId)
      .input('detailType', sql.NVarChar(50), data.paymentType)
      .input('description', sql.NVarChar(255), String(data.description).trim())
      .input('amount', sql.Decimal(18, 2), amount)
      .input('user', sql.NVarChar(50), username)
      .query(`
        INSERT INTO PayrollDetails (PayrollID, DetailType, DetailDescription, Amount, IsDeduction, PaymentType, CreatedBy, CreatedAt)
        VALUES (@payrollId, @detailType, @description, @amount, 0, 'Separate', @user, GETDATE())
      `);

    await new sql.Request(tx)
      .input('id', sql.Int, payrollId)
      .input('user', sql.NVarChar(50), username)
      .query(`
        INSERT INTO Audit_Log (TableName, ActionType, PrimaryKeyValue, NewData, ActionDate, LoginName, AppName)
        VALUES (N'Payroll', N'Insert', CAST(@id AS NVARCHAR(20)), N'OffPayrollCreated', GETDATE(), @user, N'COCOBOLO Flutter')
      `).catch(() => {});

    await tx.commit();
    return { payrollId, month: effectiveMonth };
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    throw e;
  }
}

// GetPendingInstallmentsAsync (EmployeeLoanService.cs:1095) — أقساط
// معلّقة لسلف نشطة، مرتبة بشهر الخصم ثم الرقم: وقود حوار المقاصة.
async function getPendingInstallments(employeeId) {
  const pool = await connectDB();
  const rs = await pool.request()
    .input('employeeId', sql.Int, employeeId)
    .query(`
      SELECT li.InstallmentId, li.LoanId, li.InstallmentNumber, li.DeductionMonth,
             li.Amount, li.Status, li.Notes, li.DeductionDate
      FROM LoanInstallments li
      INNER JOIN EmployeeLoans l ON li.LoanId = l.LoanId
      WHERE li.EmployeeId = @employeeId AND li.Status = 'Pending' AND l.Status = 'Active'
      ORDER BY li.DeductionMonth, li.InstallmentNumber
    `);
  return rs.recordset;
}

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

// ============================================================
// صرف دفعة خارج الراتب مع مقاصة أقساط سلف — مرآة حرفية لـ
// PayOneWithLoanAllocationAsync (PayrollService.cs:881):
// النقدي = قيمة الدفعة − المخصص؛ حركة صرف واحدة بالنقدي فقط؛
// القسط الكامل/الجزء المسدد → PaidExternal والباقي الجزئي قسط
// Pending جديد؛ لا LoanDeduction على صف الدفعة إطلاقًا.
// ============================================================
async function payWithAllocations(payrollId, cashBoxId, allocations, auth) {
  if (!payrollEngine.isPayrollReviewer(auth)) {
    throw offError('ليس لديك صلاحية صرف الرواتب', 403);
  }
  if (!cashBoxId) throw offError('اختيار الخزينة مطلوب');
  if (!Array.isArray(allocations) || allocations.length === 0) {
    throw offError('لا توجد مخصصات أقساط');
  }
  if (allocations.some((a) => !(Number(a.amount) > 0))) {
    throw offError('كل مبلغ مخصص يجب أن يكون أكبر من صفر');
  }
  const ids = allocations.map((a) => parseInt(a.installmentId, 10));
  if (ids.some((id) => !Number.isInteger(id) || id <= 0)) {
    throw offError('معرّف قسط غير صالح');
  }
  if (new Set(ids).size !== ids.length) {
    throw offError('يوجد قسط مكرر في التخصيص');
  }

  const pool = await connectDB();
  const tx = new sql.Transaction(pool);
  await tx.begin();
  try {
    const makeRequest = () => new sql.Request(tx);

    const payRes = await makeRequest()
      .input('id', sql.Int, payrollId)
      .query(`
        SELECT p.*, e.FullName AS EmployeeName
        FROM Payroll p
        INNER JOIN Employees e ON p.EmployeeID = e.EmployeeID
        WHERE p.PayrollID = @id
      `);
    const p = payRes.recordset[0];
    if (!p) throw offError('الدفعة غير موجودة', 404);
    if (!String(p.Notes || '').toUpperCase().includes(OFF_MARKER)) {
      throw offError('المقاصة مقابل السلف متاحة للدفعات خارج الراتب فقط');
    }
    if (p.PaymentStatus === 'مدفوع') throw offError('الدفعة تم صرفها بالفعل');
    if (p.PaymentStatus === 'ملغي') throw offError('لا يمكن صرف دفعة ملغاة');
    if (p.PaymentStatus !== 'معتمد' && p.PaymentStatus !== 'غير مدفوع') {
      throw offError('لا يمكن صرف الدفعة قبل الاعتماد');
    }

    const netAmount = Number(p.NetSalary ?? p.BasicSalary ?? 0);
    const sepRes = await makeRequest()
      .input('payrollId', sql.Int, payrollId)
      .query(`
        SELECT PayrollDetailID, DetailType, DetailDescription, Amount
        FROM PayrollDetails
        WHERE PayrollID = @payrollId AND PaymentType = 'Separate' AND CashboxTransactionID IS NULL
      `);
    const separateDetails = sepRes.recordset;
    const paymentAmount = round2(netAmount + separateDetails.reduce((s, d) => s + Number(d.Amount || 0), 0));

    const idParams = ids.map((_, i) => `@id${i}`).join(',');
    const instReq = makeRequest();
    ids.forEach((id, i) => instReq.input(`id${i}`, sql.Int, id));
    const instRes = await instReq.query(`
      SELECT li.InstallmentId, li.LoanId, li.EmployeeId, li.InstallmentNumber,
             li.Amount, li.Status, li.DeductionMonth, li.Notes, l.Status AS LoanStatus
      FROM LoanInstallments li
      INNER JOIN EmployeeLoans l ON li.LoanId = l.LoanId
      WHERE li.InstallmentId IN (${idParams})
    `);
    const installments = instRes.recordset;
    if (installments.length !== ids.length) throw offError('بعض الأقساط غير موجودة');
    if (installments.some((i) => i.EmployeeId !== p.EmployeeID)) {
      throw offError('كل الأقساط يجب أن تكون خاصة بموظف الدفعة');
    }
    if (installments.some((i) => i.Status !== 'Pending')) {
      throw offError('يمكن تخصيص أقساط معلقة (لم تُخصم بعد) فقط');
    }
    if (installments.some((i) => i.LoanStatus !== 'Active')) {
      throw offError('توجد أقساط لسلف غير نشطة');
    }

    let totalAlloc = 0;
    for (const a of allocations) {
      const inst = installments.find((i) => i.InstallmentId === parseInt(a.installmentId, 10));
      const amount = round2(a.amount);
      if (amount > Number(inst.Amount)) {
        throw offError(`المبلغ المخصص للقسط رقم ${inst.InstallmentNumber} أكبر من قيمته (${Number(inst.Amount).toFixed(2)} جـ)`);
      }
      totalAlloc = round2(totalAlloc + amount);

      // حارس الراتب المحسوب غير المصروف (نفس حارس تعديل الأقساط في
      // بلازور) — باستثناء صفوف [OFFPAYROLL] نفسها كما في أصل الحارس.
      const blockRes = await makeRequest()
        .input('employeeId', sql.Int, inst.EmployeeId)
        .input('month', sql.NVarChar(10), inst.DeductionMonth)
        .query(`
          SELECT TOP 1 PayrollID FROM Payroll
          WHERE EmployeeID = @employeeId AND PayrollMonth = @month
            AND ISNULL(LoanDeduction, 0) > 0
            AND PaymentStatus IN (N'قيد المراجعة', N'معتمد', N'غير مدفوع')
            AND (Notes IS NULL OR CHARINDEX(N'[OFFPAYROLL]', Notes) = 0)
        `);
      if (blockRes.recordset.length > 0) {
        throw offError(`القسط رقم ${inst.InstallmentNumber} داخل راتب شهر ${inst.DeductionMonth} المحسوب وغير المصروف — ارفض الراتب أو أعد حسابه أولًا`);
      }
    }
    if (totalAlloc > paymentAmount) {
      throw offError(`إجمالي المخصص للأقساط (${totalAlloc.toFixed(2)} جـ) أكبر من قيمة الدفعة (${paymentAmount.toFixed(2)} جـ)`);
    }

    const cashAmount = round2(paymentAmount - totalAlloc);
    const balance = await getCashBalance(makeRequest, cashBoxId);
    if (balance == null) throw offError('الخزينة غير موجودة', 404);
    if (balance < cashAmount) {
      throw offError(`رصيد الخزينة (${balance.toFixed(2)} جـ) أقل من المطلوب للصرف النقدي (${cashAmount.toFixed(2)} جـ)`);
    }

    // 1) حركة الصرف النقدي — صفر نقدي يعني لا حركة إطلاقًا، وتُربط
    // بها البنود المنفصلة كما يفعل بلازور حرفيًا.
    if (cashAmount > 0) {
      const txRes = await makeRequest()
        .input('cashBoxId', sql.Int, cashBoxId)
        .input('amount', sql.Decimal(18, 2), cashAmount)
        .input('referenceId', sql.Int, payrollId)
        .input('notes', sql.NVarChar(500), `الدفعة خارج الراتب ${p.EmployeeName} - ${p.PayrollMonth} (مقاصة أقساط سلف ${totalAlloc.toFixed(2)} جـ)`)
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
      for (const d of separateDetails) {
        await makeRequest()
          .input('detailId', sql.Int, d.PayrollDetailID)
          .input('txId', sql.Int, salaryTxId)
          .query(`UPDATE PayrollDetails SET CashboxTransactionID = @txId WHERE PayrollDetailID = @detailId`);
      }
    }

    // 2) تخصيص الأقساط
    const lastNumberByLoan = {};
    for (const a of allocations) {
      const inst = installments.find((i) => i.InstallmentId === parseInt(a.installmentId, 10));
      const allocAmount = round2(a.amount);
      const allocNote = `مقاصة مقابل الدفعة خارج الراتب رقم ${payrollId} (${p.PayrollMonth}) بواسطة ${auth.username}`;
      const instAmount = round2(inst.Amount);

      if (allocAmount === instAmount) {
        await makeRequest()
          .input('installmentId', sql.Int, inst.InstallmentId)
          .input('notes', sql.NVarChar(300), appendNoteLine(inst.Notes, allocNote))
          .query(`
            UPDATE LoanInstallments
            SET Status = 'PaidExternal', DeductionDate = GETDATE(), Notes = @notes
            WHERE InstallmentId = @installmentId
          `);
      } else {
        const remaining = round2(instAmount - allocAmount);
        if (!(inst.LoanId in lastNumberByLoan)) {
          const maxRes = await makeRequest()
            .input('loanId', sql.Int, inst.LoanId)
            .query(`SELECT MAX(InstallmentNumber) AS MaxNumber FROM LoanInstallments WHERE LoanId = @loanId`);
          lastNumberByLoan[inst.LoanId] = Number(maxRes.recordset[0]?.MaxNumber || 0);
        }
        lastNumberByLoan[inst.LoanId] += 1;

        await makeRequest()
          .input('installmentId', sql.Int, inst.InstallmentId)
          .input('amount', sql.Decimal(18, 2), allocAmount)
          .input('notes', sql.NVarChar(300), appendNoteLine(inst.Notes, allocNote))
          .query(`
            UPDATE LoanInstallments
            SET Amount = @amount, Status = 'PaidExternal', DeductionDate = GETDATE(), Notes = @notes
            WHERE InstallmentId = @installmentId
          `);
        await makeRequest()
          .input('loanId', sql.Int, inst.LoanId)
          .input('employeeId', sql.Int, inst.EmployeeId)
          .input('number', sql.Int, lastNumberByLoan[inst.LoanId])
          .input('amount', sql.Decimal(18, 2), remaining)
          .input('month', sql.NVarChar(7), inst.DeductionMonth)
          .input('notes', sql.NVarChar(300), `المتبقي بعد مقاصة جزئية من الدفعة خارج الراتب رقم ${payrollId} (قسط ${inst.InstallmentNumber})`)
          .input('createdBy', sql.NVarChar(50), auth.username)
          .query(`
            INSERT INTO LoanInstallments (LoanId, EmployeeId, InstallmentNumber, Amount, DeductionMonth, Status, Notes, CreatedBy, CreatedAt)
            VALUES (@loanId, @employeeId, @number, @amount, @month, 'Pending', @notes, @createdBy, GETDATE())
          `);
        await makeRequest()
          .input('loanId', sql.Int, inst.LoanId)
          .query(`UPDATE EmployeeLoans SET TotalInstallments = TotalInstallments + 1 WHERE LoanId = @loanId`);
      }

      await makeRequest()
        .input('loanId', sql.Int, inst.LoanId)
        .input('amount', sql.Decimal(18, 2), allocAmount)
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

    // 3) تعليم الدفعة مدفوعة
    await makeRequest()
      .input('id', sql.Int, payrollId)
      .input('notes', sql.NVarChar(sql.MAX), appendNoteLine(p.Notes, `[صرف: ${auth.username} - ${nowStamp()} | خزينة #${cashBoxId} | نقدي ${cashAmount.toFixed(2)} + مقاصة سلف ${totalAlloc.toFixed(2)}]`))
      .query(`
        UPDATE Payroll
        SET PaymentStatus = N'مدفوع', PaymentDate = GETDATE(), Notes = @notes
        WHERE PayrollID = @id
      `);

    await new sql.Request(tx)
      .input('id', sql.Int, payrollId)
      .input('user', sql.NVarChar(50), auth.username)
      .query(`
        INSERT INTO Audit_Log (TableName, ActionType, PrimaryKeyValue, NewData, ActionDate, LoginName, AppName)
        VALUES (N'LoanInstallments', N'OffPayrollAllocation', CAST(@id AS NVARCHAR(20)), N'OffPayrollAllocation', GETDATE(), @user, N'COCOBOLO Flutter')
      `).catch(() => {});

    await tx.commit();
    return { payrollId, paymentAmount, cashAmount, loanAllocation: totalAlloc, status: 'مدفوع' };
  } catch (e) {
    try { await tx.rollback(); } catch (_) {}
    throw e;
  }
}

module.exports = {
  getStats, getList, create, getPendingInstallments, payWithAllocations,
  OFF_MARKER, PAYMENT_TYPES,
};
