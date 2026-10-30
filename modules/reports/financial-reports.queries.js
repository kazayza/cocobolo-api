// ════════════════════════════════════════════════════════════════════
//  التقارير المالية — مرآة حرفية لخدمات بلازور:
//    FinancialReportsService.cs (قائمة الدخل + الميزانية)
//    CashFlowService.cs (التدفقات النقدية)
//    FinancialDashboardService.cs (اللوحة المالية)
//  كل تعريف موثّق بسطر بلازور المقابل في تعليق بجانبه.
//  ⚠️ انحراف موثّق: لوحة بلازور المالية تستبعد فواتير «المنشئين المحميين»
//     (FinancialDashboardService.GetProtectedCreatorsAsync :27) بناءً على
//     جلسة بلازور — لا مقابل لها في جلسة الـ API، لذا يحسب الـ API على كل
//     الفواتير، وهو مطابق حرفيًا لقائمة الدخل نفسها في بلازور
//     (FinancialReportsService.cs:22-24: القوائم المالية تشمل كل الفواتير).
// ════════════════════════════════════════════════════════════════════
const { sql, connectDB } = require('../../core/database');
const { addDays, addMonths, money, intId } = require('../../shared/reporting.utils');

// حالات الرواتب المعترف بها — PayrollDto.cs:353-358 (أسماء قاعدة البيانات العربية)
const PAYROLL_RECOGNIZED = ['قيد المراجعة', 'معتمد', 'غير مدفوع', 'مدفوع'];
const PAYROLL_PAID = 'مدفوع';
const GROUP_COLORS = ['#3b82f6', '#10b981', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#06b6d4', '#84cc16', '#d4af37', '#6366f1'];
// تصنيفات التدفقات — CashFlowDto.cs (CashFlowCategories)؛ AdvanceCharge مرجعه الحرفي 'Charge'
const FLOW_CATEGORIES = {
  SaleInvoice: ['تحصيل من عملاء', '#10b981', 'Receipt'],
  Charge: ['رسوم معاينة', '#84cc16', 'Savings'],
  ManualReceipt: ['سندات قبض يدوية', '#22c55e', 'AddCard'],
  OpeningBalance: ['رصيد افتتاحي', '#6366f1', 'Stars'],
  TransferIn: ['تحويلات داخلة', '#06b6d4', 'CallReceived'],
  PurchaseInvoice: ['سداد للموردين', '#ef4444', 'ShoppingCart'],
  Expense: ['مصروفات تشغيلية', '#f59e0b', 'MoneyOff'],
  Payroll: ['رواتب', '#8b5cf6', 'Payments'],
  ManualPayment: ['سندات صرف يدوية', '#dc2626', 'RemoveCircle'],
  TransferOut: ['تحويلات خارجة', '#06b6d4', 'CallMade'],
  Loan: ['قروض', '#3b82f6', 'AccountBalance'],
};
const CHARGE_TYPE_NAMES = {
  Inspection: 'رسوم معاينة', Shipping: 'رسوم شحن', Installation: 'رسوم تركيب',
  Advance: 'دفعة مقدمة', Modification: 'رسوم تعديل', Other: 'رسوم أخرى',
};

function toSqlDate(date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}
function dstr(date) { return toSqlDate(date).toISOString().slice(0, 10); }
function monthKey(date) { return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`; }
function round2(v) { return Math.round(Number(v || 0) * 100) / 100; }
function round1(v) { return Math.round(Number(v || 0) * 10) / 10; }

function parseRange(query) {
  const today = new Date();
  const defFrom = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));
  const defTo = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const parse = (value, fallback) => {
    if (!value) return fallback;
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  const from = parse(query.from, defFrom);
  const to = parse(query.to, defTo);
  if (!from || !to || to < from) {
    throw Object.assign(new Error('نطاق التاريخ غير صالح'), { statusCode: 400, code: 'INVALID_DATE_RANGE' });
  }
  const branchId = query.branchId ? intId(query.branchId, { label: 'معرّف الفرع' }) : null;
  const cashBoxId = query.cashBoxId ? intId(query.cashBoxId, { label: 'معرّف الخزينة' }) : null;
  return { from, to, branchId, cashBoxId };
}

async function request(pool, params, text) {
  const r = pool.request();
  for (const [name, type, value] of params) r.input(name, type, value);
  const result = await r.query(text);
  return result.recordset;
}
function baseParams(range, extra = []) {
  return [
    ['fromDate', sql.Date, toSqlDate(range.from)],
    ['toDate', sql.Date, toSqlDate(range.to)],
    ['branchId', sql.Int, range.branchId],
    ...extra,
  ];
}
// إسناد الفرع لفاتورة — FinancialReportsService.cs:119,141:
// منشئها موظف الفرع أولًا، واحتياطيًا (المنشئ بلا فرع/بلا موظف) مخزن الفرع.
function txScope(alias, scoped) {
  if (!scoped) return '';
  return ` AND ((${alias}.EmpId IN (SELECT EmployeeID FROM Employees WHERE BranchID = @branchId))
    OR (((${alias}.EmpId IS NULL OR NOT EXISTS (SELECT 1 FROM Employees ex WHERE ex.EmployeeID = ${alias}.EmpId AND ex.BranchID IS NOT NULL))
      AND ${alias}.WarehouseID IN (SELECT WarehouseID FROM Warehouses WHERE BranchID = @branchId))))`;
}
function creatorScope(column, scoped) {
  if (!scoped) return '';
  return ` AND (${column} IS NOT NULL AND EXISTS (SELECT 1 FROM Users u INNER JOIN Employees e ON e.EmployeeID = u.EmployeeID WHERE u.Username = ${column} AND e.BranchID = @branchId))`;
}
const NOT_CANCELLED = `(InvoiceStatus IS NULL OR InvoiceStatus <> 'Cancelled')`;

// ─── الرواتب بالتناسب حسب أيام التداخل — FinancialReportsService.cs:448,548, SumPayrollProRated ───
function proRatePayroll(rows, from, to) {
  const byMonth = new Map();
  for (const row of rows) {
    const key = String(row.PayrollMonth || '');
    byMonth.set(key, (byMonth.get(key) || 0) + Number(row.Amount || 0));
  }
  let total = 0;
  for (const [key, amount] of byMonth) {
    const m = /^(\d{4})-(\d{2})$/.exec(key);
    if (!m) continue;
    const mStart = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, 1));
    const mEnd = addDays(addMonths(mStart, 1), -1);
    const oFrom = mStart > from ? mStart : from;
    const oTo = mEnd < to ? mEnd : to;
    const days = Math.round((oTo - oFrom) / 86400000) + 1;
    if (days <= 0) continue;
    const daysInMonth = new Date(Date.UTC(mStart.getUTCFullYear(), mStart.getUTCMonth() + 1, 0)).getUTCDate();
    total += (amount * days) / daysInMonth;
  }
  return round2(total);
}

async function payrollRows(pool, range, from, to) {
  const rows = await request(pool, baseParams({ from, to, branchId: range.branchId }), `
    SELECT p.PayrollMonth,
           (p.BasicSalary + ISNULL(p.Allowances, p.BonusInPayroll)) AS Amount,
           (ISNULL(p.NetSalary, p.BasicSalary)) AS NetAmount,
           p.PaymentStatus
    FROM Payrolls p
    WHERE p.PayrollMonth >= @monthFrom AND p.PayrollMonth <= @monthTo
      AND p.PaymentStatus IN (${PAYROLL_RECOGNIZED.map((s) => `N'${s}'`).join(',')})
      ${range.branchId ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeID = p.EmployeeID AND e.BranchID = @branchId)' : ''}
  `.replace('@monthFrom', `'${monthKey(from)}'`).replace('@monthTo', `'${monthKey(to)}'`));
  return rows;
}

// ─── تكلفة البضاعة — FinancialReportsService.cs:255 (مرآة) + :304 (معرض عبر PriceHistory) ───
function extractTier(notes) {
  const n = String(notes || '');
  if (n.startsWith('[CClass]')) return 'CClass';
  if (n.startsWith('[Elite]')) return 'Elite';
  return 'Premium';
}
async function computeCogs(pool, range, from, to) {
  const scoped = Boolean(range.branchId);
  const eff = { from, to, branchId: range.branchId };
  const saleRows = await request(pool, baseParams(eff), `
    SELECT t.TransactionID FROM Transactions t
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
      ${txScope('t', scoped)}
  `);
  const saleIds = saleRows.map((r) => Number(r.TransactionId)).filter(Number.isSafeInteger);
  if (!saleIds.length) return 0;
  const idList = saleIds.join(',');
  const mirrorRows = await request(pool, [], `
    SELECT ISNULL(SUM(GrandTotal), 0) AS Total FROM Transactions
    WHERE TransactionType = 'Purchase' AND ${NOT_CANCELLED}
      AND ReferenceType IN (${saleIds.map((id) => `'MirrorOf:${id}'`).join(',')})
  `);
  const mirrorCogs = Number(mirrorRows[0]?.Total || 0);
  const coveredRows = await request(pool, [], `
    SELECT DISTINCT p.ReferenceType, d.ProductID
    FROM Transactions p INNER JOIN TransactionDetails d ON d.TransactionID = p.TransactionID
    WHERE p.TransactionType = 'Purchase' AND (p.InvoiceStatus IS NULL OR p.InvoiceStatus <> 'Cancelled')
      AND p.ReferenceType IN (${saleIds.map((id) => `'MirrorOf:${id}'`).join(',')})
  `);
  const covered = new Map();
  for (const r of coveredRows) {
    if (!covered.has(r.ReferenceType)) covered.set(r.ReferenceType, new Set());
    covered.get(r.ReferenceType).add(Number(r.ProductId));
  }
  const lines = await request(pool, [], `
    SELECT d.TransactionID, d.ProductID, d.Quantity, d.PricingTier, d.Notes, d.SelectedAlternativeID,
           tx.TransactionDate, p.PurchasePrice, p.PurchasePriceCClass, p.PurchasePriceElite,
           a.PurchasePriceCClass AS AltCClass, a.PurchasePricePremium AS AltPremium, a.PurchasePriceElite AS AltElite
    FROM TransactionDetails d
    INNER JOIN Transactions tx ON tx.TransactionID = d.TransactionID
    INNER JOIN Products p ON p.ProductID = d.ProductID
    LEFT JOIN ProductFactoryAlternatives a ON a.AlternativeID = d.SelectedAlternativeID
    WHERE d.TransactionID IN (${idList})
  `);
  let historyByProduct = new Map();
  try {
    const productIds = [...new Set(lines.map((l) => Number(l.ProductId)))];
    if (productIds.length) {
      const hist = await request(pool, [], `
        SELECT ProductID, PriceType, NewPrice, ChangedAt FROM PriceHistory
        WHERE ProductID IN (${productIds.join(',')}) AND PriceType LIKE '%\\_Cost' ESCAPE '\\'
        ORDER BY ChangedAt
      `);
      for (const h of hist) {
        if (!historyByProduct.has(Number(h.ProductId))) historyByProduct.set(Number(h.ProductId), []);
        historyByProduct.get(Number(h.ProductId)).push(h);
      }
    }
  } catch { historyByProduct = new Map(); /* بلا تاريخ أسعار: السعر الحالي بديلًا — نفس Fallback بلازور */ }
  let total = 0;
  for (const r of lines) {
    const cov = covered.get(`MirrorOf:${r.TransactionId}`);
    if (cov && cov.has(Number(r.ProductId))) continue;
    const tierRaw = r.PricingTier && String(r.PricingTier).trim() ? String(r.PricingTier) : extractTier(r.Notes);
    let unit;
    if (r.SelectedAlternativeId != null) {
      unit = tierRaw === 'CClass' ? (r.AltCClass ?? 0)
        : tierRaw === 'Elite' ? (r.AltElite ?? r.AltPremium ?? 0)
          : (r.AltPremium ?? 0);
    } else {
      const current = tierRaw === 'CClass' ? (r.PurchasePriceCClass ?? 0)
        : tierRaw === 'Elite' ? (r.PurchasePriceElite ?? r.PurchasePrice ?? 0)
          : (r.PurchasePrice ?? 0);
      const tierKey = tierRaw === 'CClass' ? 'CClass' : tierRaw === 'Elite' ? 'Elite' : 'Premium';
      let histPrice = null;
      const points = historyByProduct.get(Number(r.ProductId)) || [];
      const at = new Date(r.TransactionDate);
      for (const pt of points) {
        if (pt.PriceType !== `${tierKey}_Cost`) continue;
        if (new Date(pt.ChangedAt) > at) break;
        histPrice = Number(pt.NewPrice);
      }
      unit = histPrice ?? current;
    }
    total += Math.round(Number(r.Quantity || 0) * Number(unit || 0) * 100) / 100;
  }
  return round2(mirrorCogs + total);
}

async function otherRevenue(pool, range, from, to) {
  const scoped = Boolean(range.branchId);
  const rows = await request(pool, baseParams({ from, to, branchId: range.branchId }), `
    SELECT c.ChargeType, ISNULL(c.ChargeAmount, 0) AS Amount
    FROM AdditionalCharges c
    WHERE c.TransactionID IS NULL AND c.AppliedToTransactionId IS NULL
      AND (c.Status = 'Paid' OR c.Status = 'NonRefundable')
      AND NOT (c.ChargeType = 'Advance' AND c.Status = 'Paid')
      AND c.CreatedAt IS NOT NULL AND c.CreatedAt >= @fromDate AND c.CreatedAt < DATEADD(DAY, 1, @toDate)
      ${creatorScope('c.CreatedBy', scoped)}
  `);
  return rows;
}

async function expenseSum(pool, range, from, to) {
  const rows = await request(pool, baseParams({ from, to, branchId: range.branchId }), `
    SELECT ISNULL(SUM(Amount), 0) AS Total FROM Expenses
    WHERE ExpenseDate >= @fromDate AND ExpenseDate < DATEADD(DAY, 1, @toDate)
      AND (ISNULL(IsAdvance, 0) <> 1 OR AdvanceParentExpenseId IS NOT NULL)
      ${range.branchId ? 'AND BranchId = @branchId' : ''}
  `);
  return Number(rows[0]?.Total || 0);
}

async function summaryFor(pool, range, from, to) {
  const scoped = Boolean(range.branchId);
  const revRows = await request(pool, baseParams(range), `
    SELECT ISNULL(SUM(ISNULL(t.NetTotalAmount, t.GrandTotal)), 0) AS Revenue
    FROM Transactions t
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
      ${txScope('t', scoped)}
  `);
  const charges = await otherRevenue(pool, range, from, to);
  const other = charges.reduce((s, c) => s + Number(c.Amount || 0), 0);
  const [cogs, expenses, payroll] = await Promise.all([
    computeCogs(pool, range, from, to),
    expenseSum(pool, range, from, to),
    payrollRows(pool, range, from, to),
  ]);
  const payrollAmount = proRatePayroll(payroll.map((p) => ({ PayrollMonth: p.PayrollMonth, Amount: p.Amount })), from, to);
  return { Revenue: Number(revRows[0]?.Revenue || 0) + other, Cogs: cogs, Expenses: expenses, Payroll: payrollAmount, OtherRevenue: other };
}

function breakEven(dto) {
  const be = {
    FixedExpenses: dto.TotalOperatingExpenses, GrossProfitMargin: dto.GrossProfitMargin,
    CurrentRevenue: dto.NetRevenue, BreakEvenRevenue: 0, RevenueGap: 0, SafetyMargin: 0, Status: '', Description: '', AboveBreakEven: false,
  };
  be.BreakEvenRevenue = dto.GrossProfitMargin > 0
    ? round2(be.FixedExpenses / (dto.GrossProfitMargin / 100)) : be.FixedExpenses;
  be.RevenueGap = round2(be.CurrentRevenue - be.BreakEvenRevenue);
  if (be.BreakEvenRevenue > 0) be.SafetyMargin = round1(((be.CurrentRevenue - be.BreakEvenRevenue) / be.BreakEvenRevenue) * 100);
  be.AboveBreakEven = be.CurrentRevenue >= be.BreakEvenRevenue;
  if (be.CurrentRevenue >= be.BreakEvenRevenue * 1.5) { be.Status = 'آمن جداً'; be.Description = `إيراداتك أعلى من نقطة التعادل بمقدار ${Math.abs(be.RevenueGap)} ج (+${be.SafetyMargin}%) — وضع ممتاز!`; }
  else if (be.AboveBreakEven) { be.Status = 'آمن'; be.Description = `تجاوزت نقطة التعادل بـ ${Math.abs(be.RevenueGap)} ج. هامش الأمان: ${be.SafetyMargin}%`; }
  else if (be.CurrentRevenue >= be.BreakEvenRevenue * 0.8) { be.Status = 'حرج'; be.Description = `تحتاج ${Math.abs(be.RevenueGap)} ج إيراد إضافي للوصول لنقطة التعادل`; }
  else { be.Status = 'تحت التعادل'; be.Description = `خطر! إيراداتك أقل من نقطة التعادل بمقدار ${Math.abs(be.RevenueGap)} ج`; }
  return be;
}

function profitTarget(dto) {
  const t = {
    CurrentMargin: dto.NetProfitMargin, CurrentTargetPercentage: 10, NextTargetPercentage: 20,
    TargetAmount: 0, NextTargetAmount: 0, AchievementPercentage: 0, Status: '', Message: '',
    GapToTarget: 0, GapToNextTarget: 0, RevenueIncreaseNeeded: 0, ExpensesReductionNeeded: 0,
  };
  if (t.CurrentMargin <= 0) { t.Status = 'تحت الهدف'; t.Message = 'العمل بخسارة - أولوية: الوصول لنقطة التعادل ثم تحقيق ربح 10%'; }
  else {
    const achieved = Math.floor(t.CurrentMargin / 10) * 10;
    if (achieved === 0) { t.Status = 'قريب من الهدف'; t.Message = `اقتربت من تحقيق ربح 10%. الفجوة: ${(10 - t.CurrentMargin).toFixed(1)}%`; }
    else {
      t.CurrentTargetPercentage = achieved; t.NextTargetPercentage = achieved + 10;
      if (t.CurrentMargin >= achieved + 5) { t.Status = 'متجاوز الهدف'; t.Message = `رائع! حققت ${t.CurrentMargin.toFixed(1)}% — أعلى من هدف ${achieved}%. اطمح للوصول لـ ${achieved + 10}%`; }
      else { t.Status = 'محقق الهدف'; t.Message = `ممتاز! حققت ${t.CurrentMargin.toFixed(1)}% (هدف ${achieved}%). اطمح للوصول لـ ${achieved + 10}%`; }
    }
  }
  t.TargetAmount = round2(dto.NetRevenue * (t.CurrentTargetPercentage / 100));
  t.NextTargetAmount = round2(dto.NetRevenue * (t.NextTargetPercentage / 100));
  if (t.TargetAmount > 0) t.AchievementPercentage = Math.min(100, Math.max(0, round1((dto.NetProfit / t.TargetAmount) * 100)));
  t.GapToTarget = round2(t.TargetAmount - dto.NetProfit);
  t.GapToNextTarget = round2(t.NextTargetAmount - dto.NetProfit);
  if (t.GapToNextTarget > 0) {
    if (dto.GrossProfitMargin > 0) t.RevenueIncreaseNeeded = round2(t.GapToNextTarget / (dto.GrossProfitMargin / 100));
    t.ExpensesReductionNeeded = t.GapToNextTarget;
  }
  return t;
}

function buildComparison(label, current, prev) {
  const prevTotalExp = prev.Expenses + prev.Payroll;
  const prevNet = prev.Revenue - prev.Cogs - prevTotalExp;
  const prevMargin = prev.Revenue === 0 ? 0 : round2((prevNet / prev.Revenue) * 100);
  const revChange = prev.Revenue === 0 ? 0 : round1(((current.NetRevenue - prev.Revenue) / prev.Revenue) * 100);
  const expChange = prevTotalExp === 0 ? 0 : round1(((current.TotalOperatingExpenses - prevTotalExp) / prevTotalExp) * 100);
  const profitChange = prevNet === 0 ? 0 : round1(((current.NetProfit - prevNet) / Math.abs(prevNet)) * 100);
  return {
    Label: label, Revenue: money(prev.Revenue), Expenses: money(prev.Expenses), NetProfit: money(prevNet),
    NetProfitMargin: prevMargin, RevenueChange: revChange, ExpensesChange: expChange, NetProfitChange: profitChange,
    Trend: profitChange > 5 ? 'تحسن' : profitChange < -5 ? 'تراجع' : 'ثابت',
  };
}

function recommendations(dto) {
  const recs = [];
  const push = (Type, Title, Description, Priority, Color) => recs.push({ Type, Title, Description, Priority, Color, Icon: '' });
  if (dto.NetProfit < 0) push('Critical', 'العمل بخسارة!', `خسارة ${Math.abs(dto.NetProfit)} ج هذه الفترة. يجب اتخاذ إجراءات فورية لتقليل المصروفات أو زيادة المبيعات.`, 1, '#dc2626');
  if (!dto.BreakEvenAnalysis.AboveBreakEven) push('Critical', 'تحت نقطة التعادل', `تحتاج ${Math.abs(dto.BreakEvenAnalysis.RevenueGap)} ج إيراد إضافي للوصول لنقطة التعادل.`, 2, '#dc2626');
  else if (dto.BreakEvenAnalysis.SafetyMargin < 20) push('Warning', 'هامش الأمان منخفض', `هامش الأمان فقط ${dto.BreakEvenAnalysis.SafetyMargin}%. حاول زيادته لـ 30% على الأقل.`, 3, '#f59e0b');
  if (dto.NetProfitMargin < 10 && dto.NetProfit > 0) push('Warning', 'نسبة الربح أقل من 10%', `حالياً: ${dto.NetProfitMargin.toFixed(1)}%. للوصول لـ 10% تحتاج إما زيادة الإيراد بـ ${dto.ProfitTarget.RevenueIncreaseNeeded} ج أو تقليل المصروفات بـ ${dto.ProfitTarget.GapToTarget} ج`, 4, '#f59e0b');
  else if (dto.NetProfitMargin >= 10 && dto.NetProfitMargin < 20) push('Success', 'نسبة ربح ممتازة - اطمح للأعلى', `حققت ${dto.NetProfitMargin.toFixed(1)}%. للوصول لـ 20% تحتاج زيادة إيراد بـ ${dto.ProfitTarget.RevenueIncreaseNeeded} ج`, 5, '#10b981');
  else if (dto.NetProfitMargin >= 20) push('Success', 'أداء استثنائي!', `نسبة ربح ${dto.NetProfitMargin.toFixed(1)}% — وضع ممتاز! الهدف القادم: ${dto.ProfitTarget.NextTargetPercentage}%. فكر في توسيع النشاط أو الاستثمار في النمو.`, 6, '#10b981');
  const biggest = dto.ExpensesByGroup[0];
  if (biggest && biggest.Percentage > 40) push('Warning', `مصروفات ${biggest.GroupName} مرتفعة`, `تمثل ${biggest.Percentage}% من إجمالي المصروفات (${biggest.Amount} ج). راجع إمكانية التخفيض.`, 7, '#f59e0b');
  if (dto.PreviousPeriod) {
    if (dto.PreviousPeriod.RevenueChange < -10) push('Critical', 'تراجع في الإيرادات', `الإيرادات تراجعت بـ ${Math.abs(dto.PreviousPeriod.RevenueChange).toFixed(1)}% مقارنة بالفترة السابقة. ابحث عن الأسباب.`, 8, '#dc2626');
    else if (dto.PreviousPeriod.RevenueChange > 20) push('Success', 'نمو رائع في الإيرادات', `الإيرادات نمت بـ +${dto.PreviousPeriod.RevenueChange.toFixed(1)}% مقارنة بالفترة السابقة. استمر!`, 9, '#10b981');
    if (dto.PreviousPeriod.ExpensesChange > 20) push('Warning', 'زيادة في المصروفات', `المصروفات زادت بـ +${dto.PreviousPeriod.ExpensesChange.toFixed(1)}% عن الفترة السابقة. راجع المصروفات الجديدة.`, 10, '#f59e0b');
  }
  if (dto.GrossProfitMargin < 30 && dto.NetRevenue > 0) push('Warning', 'هامش الربح الإجمالي منخفض', `الربح الإجمالي ${dto.GrossProfitMargin.toFixed(1)}% — تكلفة المبيعات مرتفعة. فكر في رفع الأسعار أو تقليل تكلفة الشراء.`, 11, '#f59e0b');
  if (dto.NetProfit > 0 && dto.NetProfitMargin >= 15 && dto.BreakEvenAnalysis.SafetyMargin > 30) push('Info', 'نصيحة: استثمر في النمو', 'أداؤك المالي قوي. فكر في الاستثمار في التسويق، التوسع، أو إضافة منتجات جديدة لزيادة الإيرادات.', 12, '#3b82f6');
  return recs.sort((a, b) => a.Priority - b.Priority);
}

// ═══ قائمة الدخل — FinancialReportsService.GetIncomeStatementAsync:28 ═══
// الإيراد: بيع فقط غير ملغاة، NetTotalAmount ?? GrandTotal، بلا طرح مرتجعات (:152)
// إيراد آخر: رسوم مستقلة Paid/NonRefundable عدا Advance+Paid (:182)
async function getIncomeStatement(pool, range, options = {}) {
  const includeComparison = options.includeComparison !== false;
  const includeMonthlyTrend = options.includeMonthlyTrend !== false;
  const { from, to } = range;
  const scoped = Boolean(range.branchId);
  const dto = {
    FromDate: dstr(from), ToDate: dstr(to),
    PeriodLabel: `من ${dstr(from)} إلى ${dstr(to)}`,
    BranchId: range.branchId,
  };
  const revRows = await request(pool, baseParams(range), `
    SELECT COUNT(*) AS Cnt, ISNULL(SUM(t.GrandTotal), 0) AS TotalRevenue,
           ISNULL(SUM(ISNULL(t.NetTotalAmount, t.GrandTotal)), 0) AS NetRevenue
    FROM Transactions t
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
      ${txScope('t', scoped)}
  `);
  const rev = revRows[0] || {};
  dto.TotalRevenue = money(rev.TotalRevenue); dto.InvoiceRevenue = money(rev.TotalRevenue);
  dto.NetRevenue = money(rev.NetRevenue); dto.InvoicesCount = Number(rev.Cnt || 0);
  dto.AverageInvoiceValue = dto.InvoicesCount === 0 ? 0 : round2(dto.TotalRevenue / dto.InvoicesCount);

  const charges = await otherRevenue(pool, range, from, to);
  dto.OtherRevenue = money(charges.reduce((s, c) => s + Number(c.Amount || 0), 0));
  dto.OtherRevenueCount = charges.length;
  const byType = new Map();
  for (const c of charges) {
    const key = c.ChargeType || 'Other';
    if (!byType.has(key)) byType.set(key, { ChargeType: key, ChargeTypeName: CHARGE_TYPE_NAMES[key] || 'إيرادات رسوم أخرى', Amount: 0, Count: 0 });
    const row = byType.get(key); row.Amount += Number(c.Amount || 0); row.Count += 1;
  }
  dto.OtherRevenueByType = [...byType.values()].sort((a, b) => b.Amount - a.Amount)
    .map((r) => ({ ...r, Amount: money(r.Amount), Percentage: dto.OtherRevenue === 0 ? 0 : round1((r.Amount / dto.OtherRevenue) * 100) }));
  dto.TotalRevenue = money(dto.TotalRevenue + dto.OtherRevenue);
  dto.NetRevenue = money(dto.NetRevenue + dto.OtherRevenue);

  dto.CostOfGoodsSold = await computeCogs(pool, range, from, to);
  dto.GrossProfit = money(dto.NetRevenue - dto.CostOfGoodsSold);
  dto.GrossProfitMargin = dto.NetRevenue === 0 ? 0 : round2((dto.GrossProfit / dto.NetRevenue) * 100);

  const payroll = await payrollRows(pool, range, from, to);
  dto.PayrollExpense = proRatePayroll(payroll.map((p) => ({ PayrollMonth: p.PayrollMonth, Amount: p.Amount })), from, to);
  dto.PayrollPaidAmount = money(payroll.filter((p) => p.PaymentStatus === PAYROLL_PAID).reduce((s, p) => s + Number(p.NetAmount || 0), 0));
  dto.PayrollOutstandingAmount = money(payroll.filter((p) => p.PaymentStatus !== PAYROLL_PAID).reduce((s, p) => s + Number(p.NetAmount || 0), 0));

  const loanRows = await request(pool, baseParams(range), `
    SELECT
      (SELECT ISNULL(SUM(l.LoanAmount), 0) FROM EmployeeLoans l WHERE l.LoanDate >= @fromDate AND l.LoanDate < DATEADD(DAY, 1, @toDate) ${range.branchId ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}) AS Disbursed,
      (SELECT ISNULL(SUM(i.Amount), 0) FROM LoanInstallments i WHERE i.DeductionMonth >= '${monthKey(from)}' AND i.DeductionMonth <= '${monthKey(to)}' AND i.Status <> 'Skipped' ${range.branchId ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = i.EmployeeId AND e.BranchId = @branchId)' : ''}) AS DueAmt,
      (SELECT ISNULL(SUM(i.Amount), 0) FROM LoanInstallments i WHERE i.DeductionMonth >= '${monthKey(from)}' AND i.DeductionMonth <= '${monthKey(to)}' AND i.Status = 'Deducted' ${range.branchId ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = i.EmployeeId AND e.BranchId = @branchId)' : ''}) AS DeductedAmt,
      (SELECT ISNULL(SUM(l.RemainingAmount), 0) FROM EmployeeLoans l WHERE l.Status = 'Active' ${range.branchId ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}) AS Outstanding,
      (SELECT COUNT(*) FROM EmployeeLoans l WHERE l.Status = 'Active' ${range.branchId ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}) AS ActiveCount,
      (SELECT COUNT(DISTINCT l.EmployeeID) FROM EmployeeLoans l WHERE l.Status = 'Active' ${range.branchId ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}) AS EmpCount
  `);
  const lr = loanRows[0] || {};
  dto.EmployeeLoans = {
    LoansDisbursed: money(lr.Disbursed), InstallmentsDue: money(lr.DueAmt), InstallmentsDeducted: money(lr.DeductedAmt),
    OutstandingBalance: money(lr.Outstanding), ActiveLoansCount: Number(lr.ActiveCount || 0), EmployeesWithLoansCount: Number(lr.EmpCount || 0),
  };

  // المصروفات: عادية أو أشهر فرعية لمقدم — بلا أي فلتر حالة ترحيل (:548)
  const expRows = await request(pool, baseParams(range), `
    SELECT e.ExpenseGroupID, ISNULL(g.ExpenseGroupName, N'غير محدد') AS GroupName,
           ISNULL(SUM(e.Amount), 0) AS Total, COUNT(*) AS Cnt
    FROM Expenses e LEFT JOIN ExpenseGroups g ON g.ExpenseGroupID = e.ExpenseGroupID
    WHERE e.ExpenseDate >= @fromDate AND e.ExpenseDate < DATEADD(DAY, 1, @toDate)
      AND (ISNULL(e.IsAdvance, 0) <> 1 OR e.AdvanceParentExpenseId IS NOT NULL)
      ${range.branchId ? 'AND e.BranchId = @branchId' : ''}
    GROUP BY e.ExpenseGroupID, g.ExpenseGroupName
    ORDER BY Total DESC
  `);
  dto.ExpensesByGroup = expRows.map((r, idx) => ({
    GroupId: Number(r.ExpenseGroupId), GroupName: r.GroupName, Amount: money(r.Total), Count: Number(r.Cnt || 0),
    Percentage: 0, Color: GROUP_COLORS[idx % GROUP_COLORS.length],
  }));
  if (dto.PayrollExpense > 0) {
    dto.ExpensesByGroup.push({ GroupId: -1, GroupName: 'الأجور والرواتب', Amount: dto.PayrollExpense, Count: 0, Percentage: 0, Color: '#7c3aed' });
  }
  dto.TotalOperatingExpenses = money(dto.ExpensesByGroup.reduce((s, g) => s + g.Amount, 0));
  for (const g of dto.ExpensesByGroup) g.Percentage = dto.TotalOperatingExpenses === 0 ? 0 : round1((g.Amount / dto.TotalOperatingExpenses) * 100);
  dto.ExpensesByGroup.sort((a, b) => b.Amount - a.Amount);

  dto.NetProfit = money(dto.GrossProfit - dto.TotalOperatingExpenses);
  dto.NetProfitMargin = dto.NetRevenue === 0 ? 0 : round2((dto.NetProfit / dto.NetRevenue) * 100);
  dto.ProfitStatus = dto.NetProfit > 0 ? 'ربح' : dto.NetProfit < 0 ? 'خسارة' : 'تعادل';
  dto.BreakEvenAnalysis = breakEven(dto);
  dto.ProfitTarget = profitTarget(dto);

  const topRows = await request(pool, baseParams(range), `
    SELECT TOP 10 e.ExpenseID, e.ExpenseName, e.Amount, e.ExpenseDate, ISNULL(g.ExpenseGroupName, N'') AS GroupName
    FROM Expenses e LEFT JOIN ExpenseGroups g ON g.ExpenseGroupID = e.ExpenseGroupID
    WHERE e.ExpenseDate >= @fromDate AND e.ExpenseDate < DATEADD(DAY, 1, @toDate)
      AND (ISNULL(e.IsAdvance, 0) <> 1 OR e.AdvanceParentExpenseId IS NOT NULL)
      ${range.branchId ? 'AND e.BranchId = @branchId' : ''}
    ORDER BY e.Amount DESC
  `);
  dto.TopExpenses = topRows.map((r) => ({
    ExpenseId: Number(r.ExpenseId), ExpenseName: r.ExpenseName || '', GroupName: r.GroupName,
    Amount: money(r.Amount), Date: r.ExpenseDate,
    PercentageOfTotal: dto.TotalOperatingExpenses === 0 ? 0 : round1((Number(r.Amount || 0) / dto.TotalOperatingExpenses) * 100),
  }));

  dto.PreviousPeriod = null; dto.PreviousYear = null;
  if (includeComparison) {
    const len = Math.round((to - from) / 86400000) + 1;
    const prev = await summaryFor(pool, range, addDays(from, -len), addDays(from, -1));
    dto.PreviousPeriod = buildComparison('الفترة السابقة', dto, prev);
    const yearFrom = new Date(Date.UTC(from.getUTCFullYear() - 1, from.getUTCMonth(), from.getUTCDate()));
    const yearTo = new Date(Date.UTC(to.getUTCFullYear() - 1, to.getUTCMonth(), to.getUTCDate()));
    const prevYear = await summaryFor(pool, range, yearFrom, yearTo);
    if (prevYear.Revenue > 0) dto.PreviousYear = buildComparison('نفس الفترة العام السابق', dto, prevYear);
  }
  dto.MonthlyTrend = [];
  if (includeMonthlyTrend) {
    const today = new Date();
    let cursor = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 11, 1));
    for (let i = 0; i < 12; i += 1) {
      const mEnd = addDays(addMonths(cursor, 1), -1);
      const s = await summaryFor(pool, range, cursor, mEnd);
      const totalExp = s.Expenses + s.Payroll;
      const profit = s.Revenue - s.Cogs - totalExp;
      dto.MonthlyTrend.push({
        Month: dstr(cursor), MonthLabel: `${cursor.getUTCFullYear()}/${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`,
        Revenue: money(s.Revenue), Cogs: money(s.Cogs), Expenses: money(totalExp), NetProfit: money(profit),
        NetProfitMargin: s.Revenue === 0 ? 0 : round1((profit / s.Revenue) * 100),
      });
      cursor = addMonths(cursor, 1);
    }
  }
  dto.Recommendations = recommendations(dto);
  return dto;
}

// ═══ الميزانية — FinancialReportsService.GetBalanceSheetAsync:1211 ═══
async function getBalanceSheet(pool, range) {
  const branchId = range.branchId;
  const scoped = Boolean(branchId);
  const dto = { AsOfDate: dstr(new Date()), BranchId: branchId, BranchName: '' };
  if (branchId) {
    const rows = await request(pool, baseParams(range), 'SELECT BranchNameAr FROM Branches WHERE BranchId = @branchId');
    dto.BranchName = rows[0]?.BranchNameAr || '';
  }
  // النقدية: OpeningBalance + قبض − صرف (أنواع عربية فقط — :1211)
  const cashRows = await request(pool, baseParams(range), `
    SELECT COUNT(*) AS Cnt, ISNULL(SUM(cb.OpeningBalance
      + (SELECT ISNULL(SUM(t.Amount), 0) FROM CashboxTransactions t WHERE t.CashBoxID = cb.CashBoxID AND t.TransactionType = N'قبض')
      - (SELECT ISNULL(SUM(t.Amount), 0) FROM CashboxTransactions t WHERE t.CashBoxID = cb.CashBoxID AND t.TransactionType = N'صرف')), 0) AS Total
    FROM CashBoxes cb ${scoped ? 'WHERE cb.BranchId = @branchId' : ''}
  `);
  dto.CashBoxesCount = Number(cashRows[0]?.Cnt || 0);
  dto.CashBalance = money(cashRows[0]?.Total);
  const recvRows = await request(pool, baseParams(range), `
    SELECT COUNT(*) AS Cnt, ISNULL(SUM(t.GrandTotal - t.PaidAmount), 0) AS Total FROM Transactions t
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.GrandTotal > t.PaidAmount ${txScope('t', scoped)}
  `);
  dto.AccountsReceivable = money(recvRows[0]?.Total); dto.ReceivableInvoicesCount = Number(recvRows[0]?.Cnt || 0);
  // المخزون بتكلفة باقة المنتج نفسه (PricingType) — :1211
  const invRows = await request(pool, baseParams(range), `
    SELECT ISNULL(SUM(sl.Quantity * CASE
        WHEN LTRIM(RTRIM(ISNULL(p.pricingType, 'Premium'))) = 'CClass' THEN ISNULL(p.PurchasePriceCClass, ISNULL(p.PurchasePrice, 0))
        WHEN LTRIM(RTRIM(ISNULL(p.pricingType, 'Premium'))) = 'Elite' THEN ISNULL(p.PurchasePriceElite, ISNULL(p.PurchasePrice, 0))
        ELSE ISNULL(p.PurchasePrice, ISNULL(p.PurchasePriceCClass, ISNULL(p.PurchasePriceElite, 0))) END), 0) AS Total,
      COUNT(DISTINCT sl.ProductID) AS Cnt
    FROM StockLevels sl
    INNER JOIN Warehouses w ON w.WarehouseID = sl.WarehouseID AND ISNULL(w.IsActive, 1) = 1
    INNER JOIN Products p ON p.ProductID = sl.ProductID
    WHERE sl.Quantity > 0 ${scoped ? 'AND w.BranchId = @branchId' : ''}
  `);
  dto.InventoryValue = money(invRows[0]?.Total); dto.InventoryItemsCount = Number(invRows[0]?.Cnt || 0);
  const loanBalRows = await request(pool, baseParams(range), `
    SELECT COUNT(*) AS Cnt, ISNULL(SUM(l.RemainingAmount), 0) AS Total FROM EmployeeLoans l
    WHERE l.Status = 'Active' ${scoped ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = l.EmployeeId AND e.BranchId = @branchId)' : ''}
  `);
  dto.ActiveLoansCount = Number(loanBalRows[0]?.Cnt || 0); dto.EmployeeLoansOutstanding = money(loanBalRows[0]?.Total);
  const prepaidRows = await request(pool, baseParams(range), `
    SELECT ISNULL(SUM(Amount), 0) AS Total FROM Expenses
    WHERE AdvanceParentExpenseId IS NOT NULL AND ExpenseDate > CAST(GETDATE() AS DATE)
    ${scoped ? 'AND BranchId = @branchId' : ''}
  `);
  dto.PrepaidExpensesAsset = money(prepaidRows[0]?.Total);
  dto.TotalAssets = money(dto.CashBalance + dto.AccountsReceivable + dto.InventoryValue + dto.EmployeeLoansOutstanding + dto.PrepaidExpensesAsset);
  // الالتزامات — الرواتب المستحقة عدا Paid/Rejected/Cancelled
  const payOutRows = await request(pool, baseParams(range), `
    SELECT COUNT(*) AS Cnt, ISNULL(SUM(ISNULL(p.NetSalary, p.BasicSalary)), 0) AS Total FROM Payrolls p
    WHERE p.PaymentStatus NOT IN (N'مدفوع', N'مرفوض', N'ملغي') AND p.PaymentStatus IS NOT NULL
    ${scoped ? 'AND EXISTS (SELECT 1 FROM Employees e WHERE e.EmployeeId = p.EmployeeID AND e.BranchId = @branchId)' : ''}
  `);
  dto.PayrollPendingCount = Number(payOutRows[0]?.Cnt || 0); dto.PayrollOutstanding = money(payOutRows[0]?.Total);
  // مستحقات الموردين تشمل المرآة (قرار المالك — :1349)
  const payRows = await request(pool, baseParams(range), `
    SELECT COUNT(*) AS Cnt, ISNULL(SUM(t.GrandTotal - t.PaidAmount), 0) AS Total FROM Transactions t
    WHERE t.TransactionType = 'Purchase' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.GrandTotal > t.PaidAmount ${txScope('t', scoped)}
  `);
  dto.SupplierPayables = money(payRows[0]?.Total); dto.PayablePurchasesCount = Number(payRows[0]?.Cnt || 0);
  const advRows = await request(pool, baseParams(range), `
    SELECT ISNULL(SUM(ISNULL(c.ChargeAmount, 0)), 0) AS Total FROM AdditionalCharges c
    WHERE c.ChargeType = 'Advance' AND c.Status = 'Paid' AND c.TransactionID IS NULL AND c.AppliedToTransactionId IS NULL
    ${creatorScope('c.CreatedBy', scoped)}
  `);
  dto.CustomerAdvances = money(advRows[0]?.Total);
  dto.TotalLiabilities = money(dto.PayrollOutstanding + dto.SupplierPayables + dto.CustomerAdvances);
  // حقوق الملكية: رأس المال الافتتاحي من FinancialSettings + أرباح محتجزة تراكمية من 2000-01-01
  let capital = { Value: 0, Notes: null, UpdatedAt: null, UpdatedBy: null };
  try {
    const capRows = await request(pool, [], `
      SELECT SettingKey, SettingValue, Notes, UpdatedAt, UpdatedBy FROM FinancialSettings
      WHERE SettingKey = 'OpeningCapital' OR SettingKey LIKE 'OpeningCapital:%'
    `);
    if (branchId) {
      const row = capRows.find((r) => r.SettingKey === `OpeningCapital:${branchId}`);
      if (row) capital = { Value: Number(row.SettingValue || 0), Notes: row.Notes, UpdatedAt: row.UpdatedAt, UpdatedBy: row.UpdatedBy };
    } else if (capRows.length) {
      const latest = [...capRows].sort((a, b) => new Date(b.UpdatedAt || 0) - new Date(a.UpdatedAt || 0))[0];
      capital = { Value: capRows.reduce((s, r) => s + Number(r.SettingValue || 0), 0), Notes: latest?.Notes ?? null, UpdatedAt: latest?.UpdatedAt ?? null, UpdatedBy: latest?.UpdatedBy ?? null };
    }
  } catch { /* جدول الإعدادات غائب: رأس المال صفر ولا تنكسر الميزانية */ }
  dto.OpeningCapital = money(capital.Value); dto.CapitalNotes = capital.Notes; dto.CapitalUpdatedAt = capital.UpdatedAt; dto.CapitalUpdatedBy = capital.UpdatedBy;
  const cumulative = await getIncomeStatement(pool, {
    from: new Date(Date.UTC(2000, 0, 1)), to: new Date(), branchId,
  }, { includeComparison: false, includeMonthlyTrend: false });
  dto.RetainedEarnings = cumulative.NetProfit;
  dto.CumulativeRevenue = cumulative.NetRevenue; dto.CumulativeCogs = cumulative.CostOfGoodsSold;
  dto.CumulativeOperatingExpenses = cumulative.TotalOperatingExpenses; dto.CumulativeFrom = cumulative.FromDate;
  dto.TotalEquity = money(dto.OpeningCapital + dto.RetainedEarnings);
  dto.LiabilitiesAndEquity = money(dto.TotalLiabilities + dto.TotalEquity);
  dto.BalanceDifference = money(dto.TotalAssets - dto.LiabilitiesAndEquity);
  dto.IsBalanced = Math.abs(dto.BalanceDifference) < 0.5;
  dto.BalanceStatus = dto.IsBalanced ? 'متوازنة' : dto.BalanceDifference > 0 ? 'فرق إيجابي' : 'فرق سلبي';
  return dto;
}

// ═══ التدفقات النقدية — CashFlowService.cs:19 ═══
function cashScope(range) {
  if (range.cashBoxId) return 'AND t.CashBoxId = @cashBoxId';
  if (range.branchId) return 'AND EXISTS (SELECT 1 FROM CashBoxes cb WHERE cb.CashBoxId = t.CashBoxId AND cb.BranchId = @branchId)';
  return '';
}
async function cashSum(pool, range, whereSql, params) {
  const rows = await request(pool, baseParams(range, [['cashBoxId', sql.Int, range.cashBoxId]]), `
    SELECT ISNULL(SUM(t.Amount), 0) AS Total FROM CashboxTransactions t WHERE ${whereSql} ${cashScope(range)}
  `);
  return Number(rows[0]?.Total || 0);
}
async function getCashFlow(pool, range) {
  const { from, to } = range;
  const dto = { FromDate: dstr(from), ToDate: dstr(to), PeriodLabel: `من ${dstr(from)} إلى ${dstr(to)}`, BranchId: range.branchId, CashBoxId: range.cashBoxId };
  // الرصيد الافتتاحي: OpeningBalance المحفوظ يُستخدم فقط إن لم توجد حركة OpeningBalance قبل الفترة لنفس الخزينة
  const boxesRows = await request(pool, baseParams(range, [['cashBoxId', sql.Int, range.cashBoxId]]), `
    SELECT cb.CashBoxID, cb.CashBoxName, cb.Color, cb.OpeningBalance, cb.OpeningDate, cb.IsActive,
      CASE WHEN EXISTS (SELECT 1 FROM CashboxTransactions t WHERE t.CashBoxID = cb.CashBoxID AND t.ReferenceType = 'OpeningBalance' AND t.TransactionDate < @fromDate)
           THEN 0 ELSE 1 END AS UseConfigured
    FROM CashBoxes cb
    WHERE 1 = 1 ${range.cashBoxId ? 'AND cb.CashBoxId = @cashBoxId' : ''} ${range.branchId ? 'AND cb.BranchId = @branchId' : ''}
  `);
  const preIn = await cashSum(pool, range, `t.TransactionDate < @fromDate AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
  const preOut = await cashSum(pool, range, `t.TransactionDate < @fromDate AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
  const configured = boxesRows.filter((b) => Number(b.UseConfigured) === 1 && b.OpeningDate && new Date(b.OpeningDate) < from)
    .reduce((s, b) => s + Number(b.OpeningBalance || 0), 0);
  dto.OpeningBalance = money(configured + preIn - preOut);
  // التدفقات مجمعة ReferenceType × TransactionType
  const grouped = await request(pool, baseParams(range, [['cashBoxId', sql.Int, range.cashBoxId]]), `
    SELECT ISNULL(t.ReferenceType, 'Other') AS RefType, t.TransactionType AS TransType,
           ISNULL(SUM(t.Amount), 0) AS Total, COUNT(*) AS Cnt
    FROM CashboxTransactions t
    WHERE t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${cashScope(range)}
    GROUP BY t.ReferenceType, t.TransactionType
  `);
  const inflows = []; const outflows = [];
  for (const g of grouped) {
    const isIn = g.TransType === 'قبض' || g.TransType === 'In';
    const cat = FLOW_CATEGORIES[g.RefType] || ['أخرى', '#94a3b8', 'MoreHoriz'];
    const row = { ReferenceType: g.RefType, CategoryName: cat[0], Amount: money(g.Total), Count: Number(g.Cnt || 0), Color: cat[1], Icon: cat[2], Percentage: 0 };
    (isIn ? inflows : outflows).push(row);
  }
  dto.TotalInflows = money(inflows.reduce((s, r) => s + r.Amount, 0));
  dto.TotalOutflows = money(outflows.reduce((s, r) => s + r.Amount, 0));
  for (const r of inflows) r.Percentage = dto.TotalInflows === 0 ? 0 : round1((r.Amount / dto.TotalInflows) * 100);
  for (const r of outflows) r.Percentage = dto.TotalOutflows === 0 ? 0 : round1((r.Amount / dto.TotalOutflows) * 100);
  dto.Inflows = inflows.sort((a, b) => b.Amount - a.Amount);
  dto.Outflows = outflows.sort((a, b) => b.Amount - a.Amount);
  dto.ClosingBalance = money(dto.OpeningBalance + dto.TotalInflows - dto.TotalOutflows);
  dto.NetCashFlow = money(dto.ClosingBalance - dto.OpeningBalance);
  // بحسب الخزينة
  dto.ByCashBox = [];
  for (const b of boxesRows) {
    const perBox = { ...range, cashBoxId: Number(b.CashBoxId) };
    const bPreIn = await cashSum(pool, perBox, `t.TransactionDate < @fromDate AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
    const bPreOut = await cashSum(pool, perBox, `t.TransactionDate < @fromDate AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
    const bCfg = Number(b.UseConfigured) === 1 && b.OpeningDate && new Date(b.OpeningDate) < from ? Number(b.OpeningBalance || 0) : 0;
    const bIn = await cashSum(pool, perBox, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
    const bOut = await cashSum(pool, perBox, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
    const opening = money(bCfg + bPreIn - bPreOut);
    dto.ByCashBox.push({
      CashBoxId: Number(b.CashBoxId), CashBoxName: b.CashBoxName, Color: b.Color || '#94a3b8',
      OpeningBalance: opening, Inflows: money(bIn), Outflows: money(bOut), NetFlow: money(bIn - bOut),
      ClosingBalance: money(opening + bIn - bOut), IsActive: Boolean(b.IsActive),
    });
  }
  dto.ByCashBox.sort((a, b) => Number(b.IsActive) - Number(a.IsActive) || b.ClosingBalance - a.ClosingBalance);
  // الترند اليومي
  const dailyRows = await request(pool, baseParams(range, [['cashBoxId', sql.Int, range.cashBoxId]]), `
    SELECT CAST(t.TransactionDate AS DATE) AS Day,
      ISNULL(SUM(CASE WHEN t.TransactionType = N'قبض' OR t.TransactionType = 'In' THEN t.Amount ELSE 0 END), 0) AS InAmt,
      ISNULL(SUM(CASE WHEN t.TransactionType = N'صرف' OR t.TransactionType = 'Out' THEN t.Amount ELSE 0 END), 0) AS OutAmt
    FROM CashboxTransactions t
    WHERE t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${cashScope(range)}
    GROUP BY CAST(t.TransactionDate AS DATE)
  `);
  const dailyMap = new Map(dailyRows.map((r) => [dstr(new Date(r.Day)), r]));
  dto.DailyTrend = [];
  let running = dto.OpeningBalance;
  const totalDays = Math.round((to - from) / 86400000) + 1;
  for (let i = 0; i < totalDays; i += 1) {
    const day = addDays(from, i);
    const row = dailyMap.get(dstr(day));
    const inAmt = money(row?.InAmt); const outAmt = money(row?.OutAmt);
    running = money(running + inAmt - outAmt);
    dto.DailyTrend.push({ Date: dstr(day), Inflows: inAmt, Outflows: outAmt, NetFlow: money(inAmt - outAmt), RunningBalance: running });
  }
  // الترند الشهري (12 شهرًا)
  dto.MonthlyTrend = [];
  const today = new Date();
  let cursor = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 11, 1));
  for (let i = 0; i < 12; i += 1) {
    const mRange = { from: cursor, to: addDays(addMonths(cursor, 1), -1), branchId: range.branchId, cashBoxId: range.cashBoxId };
    const inAmt = await cashSum(pool, mRange, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
    const outAmt = await cashSum(pool, mRange, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
    dto.MonthlyTrend.push({
      Month: dstr(cursor), MonthLabel: `${cursor.getUTCFullYear()}/${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`,
      Inflows: money(inAmt), Outflows: money(outAmt), NetFlow: money(inAmt - outAmt),
    });
    cursor = addMonths(cursor, 1);
  }
  // أكبر الحركات
  const topSql = (typeSql) => `
    SELECT TOP 5 t.TransactionDate AS Day, ISNULL(t.Notes, N'—') AS Description, ISNULL(cb.CashBoxName, '-') AS CashBoxName,
           t.ReferenceType, t.Amount
    FROM CashboxTransactions t LEFT JOIN CashBoxes cb ON cb.CashBoxID = t.CashBoxID
    WHERE t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (${typeSql}) ${cashScope(range).replaceAll('t.CashBoxId', 't.CashBoxId')}
    ORDER BY t.Amount DESC`;
  const mapTop = (rows) => rows.map((r) => ({
    Date: r.Day, Description: r.Description, CashBoxName: r.CashBoxName, ReferenceType: r.ReferenceType,
    ReferenceTypeAr: (FLOW_CATEGORIES[r.ReferenceType] || [r.ReferenceType || '-'])[0], Amount: money(r.Amount),
  }));
  dto.TopInflows = mapTop(await request(pool, baseParams(range, [['cashBoxId', sql.Int, range.cashBoxId]]), topSql(`t.TransactionType = N'قبض' OR t.TransactionType = 'In'`)));
  dto.TopOutflows = mapTop(await request(pool, baseParams(range, [['cashBoxId', sql.Int, range.cashBoxId]]), topSql(`t.TransactionType = N'صرف' OR t.TransactionType = 'Out'`)));
  // السيولة: الإغلاق ÷ متوسط صرف آخر 3 شهور
  const threeAgo = addMonths(new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())), -3);
  const out3 = await cashSum(pool, { ...range, from: threeAgo, to: new Date() },
    `t.TransactionDate >= @fromDate AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
  const avgOut = round2(out3 / 3);
  const ratio = avgOut > 0 ? round1(dto.ClosingBalance / avgOut) : 0;
  const liq = { CurrentBalance: dto.ClosingBalance, AverageMonthlyOutflow: avgOut, LiquidityRatio: ratio, MonthsCoverage: ratio, Status: '', Icon: '', Description: '' };
  if (ratio >= 6) { liq.Status = 'ممتاز'; liq.Description = `رصيدك يكفي لـ ${ratio} شهر بدون أي إيراد جديد. وضع سيولة قوي جداً.`; }
  else if (ratio >= 3) { liq.Status = 'جيد'; liq.Description = `رصيدك يكفي لـ ${ratio} شهر. سيولة جيدة ومستقرة.`; }
  else if (ratio >= 1) { liq.Status = 'متوسط'; liq.Description = `رصيدك يكفي لـ ${ratio} شهر فقط. حاول زيادة السيولة.`; }
  else if (ratio > 0) { liq.Status = 'حرج'; liq.Description = `تنبيه! رصيدك يكفي فقط لـ ${ratio} شهر. يجب تحسين التدفق فوراً.`; }
  else { liq.Status = 'خطر'; liq.Description = 'خطر شديد! الرصيد سالب أو غير كافي. أوقف المصروفات غير الضرورية.'; }
  dto.LiquidityAnalysis = liq;
  // التوقع من متوسطات آخر 3 شهور (حتى نهاية الشهر الماضي)
  const endLastMonth = addDays(new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1)), -1);
  const fcRange = { ...range, from: threeAgo, to: endLastMonth };
  const in3 = await cashSum(pool, fcRange, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
  const out3f = await cashSum(pool, fcRange, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
  const lastMonthStart = new Date(Date.UTC(endLastMonth.getFullYear(), endLastMonth.getMonth(), 1));
  const lastIn = await cashSum(pool, { ...range, from: lastMonthStart, to: endLastMonth }, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
  const twoStart = addMonths(lastMonthStart, -1);
  const twoIn = await cashSum(pool, { ...range, from: twoStart, to: addDays(lastMonthStart, -1) }, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
  const avgIn = round2(in3 / 3); const avgOutF = round2(out3f / 3);
  const trendPct = twoIn > 0 ? round1(((lastIn - twoIn) / twoIn) * 100) : 0;
  const forecast = {
    AverageMonthlyInflow: avgIn, AverageMonthlyOutflow: avgOutF, AverageMonthlyNet: round2(avgIn - avgOutF),
    NextMonthExpectedInflow: avgIn, NextMonthExpectedOutflow: avgOutF, NextMonthExpectedNet: round2(avgIn - avgOutF),
    NextMonthExpectedBalance: round2(dto.ClosingBalance + avgIn - avgOutF),
    TrendPercentage: trendPct, Trend: '', TrendIcon: '', Description: '',
  };
  if (trendPct > 5) { forecast.Trend = 'نمو'; forecast.Description = `الإيرادات في نمو بمعدل ${trendPct}% شهرياً. توقع الشهر القادم: ${avgIn} ج`; }
  else if (trendPct < -5) { forecast.Trend = 'تراجع'; forecast.Description = `الإيرادات تتراجع بمعدل ${Math.abs(trendPct)}% شهرياً. ابحث عن الأسباب.`; }
  else { forecast.Trend = 'ثابت'; forecast.Description = `الإيرادات مستقرة. التوقع للشهر القادم: ${avgIn} ج`; }
  dto.Forecast = forecast;
  // التنبيهات — CashFlowService.GenerateSmartAlerts
  const alerts = [];
  const pushA = (Type, Title, Description, Priority, Color) => alerts.push({ Type, Title, Description, Priority, Color, Icon: '' });
  if (dto.NetCashFlow < 0) pushA('Critical', 'صافي التدفق سالب', `المصروفات أعلى من الإيرادات بـ ${Math.abs(dto.NetCashFlow)} ج. يجب اتخاذ إجراءات فورية.`, 1, '#dc2626');
  else if (dto.NetCashFlow > 0) pushA('Success', 'صافي التدفق موجب', `التدفق النقدي إيجابي بـ +${dto.NetCashFlow} ج. وضع جيد.`, 9, '#10b981');
  if (liq.LiquidityRatio < 1) pushA('Critical', 'سيولة منخفضة جداً', `رصيدك يكفي فقط لـ ${liq.LiquidityRatio} شهر. ابحث عن تمويل أو زيادة الإيرادات فوراً.`, 2, '#dc2626');
  else if (liq.LiquidityRatio < 2) pushA('Warning', 'سيولة متوسطة', `رصيدك يكفي لـ ${liq.LiquidityRatio} شهر. حاول زيادة الاحتياطي.`, 3, '#f59e0b');
  if (forecast.Trend === 'تراجع') pushA('Warning', 'تراجع في الإيرادات', `الإيرادات تتراجع بمعدل ${Math.abs(forecast.TrendPercentage)}% شهرياً. تحقق من أسباب الانخفاض.`, 4, '#f59e0b');
  else if (forecast.Trend === 'نمو') pushA('Success', 'نمو في الإيرادات', `الإيرادات تنمو بمعدل +${forecast.TrendPercentage}% شهرياً. استمر!`, 7, '#10b981');
  if (forecast.NextMonthExpectedNet < 0) pushA('Warning', 'توقع شهر قادم سلبي', `بناءً على المتوسط، يُتوقع أن يكون التدفق الشهر القادم: ${forecast.NextMonthExpectedNet} ج. خطط للإجراءات اللازمة.`, 5, '#f59e0b');
  if (dto.TotalOutflows > dto.TotalInflows && dto.TotalInflows > 0) pushA('Warning', 'المصروفات تتجاوز الإيرادات', `المصروفات ${round1((dto.TotalOutflows / dto.TotalInflows) * 100)}% من الإيرادات. حاول تقليلها لـ 80% أو أقل.`, 6, '#f59e0b');
  const biggestOut = dto.Outflows[0];
  if (biggestOut && biggestOut.Percentage > 50) pushA('Info', `${biggestOut.CategoryName} يمثل ${biggestOut.Percentage}% من المصروفات`, `بقيمة ${biggestOut.Amount} ج. راجع إمكانية التحسين أو التوزيع.`, 8, '#3b82f6');
  if (liq.LiquidityRatio >= 6 && dto.NetCashFlow > 0) pushA('Info', 'نصيحة: استثمر السيولة الفائضة', 'لديك سيولة جيدة. فكر في الاستثمار، التوسع، أو سداد الالتزامات لتحسين العائد.', 10, '#3b82f6');
  dto.Alerts = alerts.sort((a, b) => a.Priority - b.Priority);
  return dto;
}

// ═══ اللوحة المالية — FinancialDashboardService.cs:69 ═══
function scoreColor(score, max) {
  const pct = (score / max) * 100;
  if (pct >= 80) return '#10b981'; if (pct >= 60) return '#84cc16'; if (pct >= 40) return '#f59e0b'; if (pct >= 20) return '#fb923c';
  return '#ef4444';
}
async function getFinancialDashboard(pool, range) {
  const { from, to } = range;
  const income = await getIncomeStatement(pool, range, { includeComparison: true, includeMonthlyTrend: false });
  const cf = await getCashFlow(pool, range);
  const dto = {
    FromDate: dstr(from), ToDate: dstr(to), PeriodLabel: income.PeriodLabel, BranchId: range.branchId,
    ProtectedCreatorsDeviation: 'اللوحة في بلازور تستبعد فواتير المنشئين المحميين بجلسة بلازور؛ الـ API يحسب على كل الفواتير كقائمة الدخل نفسها (FinancialReportsService.cs:22-24).',
  };
  dto.IncomeSummary = {
    Revenue: income.NetRevenue, Cogs: income.CostOfGoodsSold, GrossProfit: income.GrossProfit,
    OperatingExpenses: income.TotalOperatingExpenses, NetProfit: income.NetProfit, NetProfitMargin: income.NetProfitMargin,
    ProfitStatus: income.ProfitStatus, TargetPercentage: income.ProfitTarget.CurrentTargetPercentage,
    AchievedPercentage: income.ProfitTarget.AchievementPercentage, BreakEvenRevenue: income.BreakEvenAnalysis.BreakEvenRevenue,
    AboveBreakEven: income.BreakEvenAnalysis.AboveBreakEven,
  };
  dto.CashFlowSummary = {
    CurrentBalance: cf.ClosingBalance, Inflows: cf.TotalInflows, Outflows: cf.TotalOutflows, NetCashFlow: cf.NetCashFlow,
    LiquidityRatio: cf.LiquidityAnalysis.LiquidityRatio, LiquidityStatus: cf.LiquidityAnalysis.Status,
    NextMonthForecast: cf.Forecast.NextMonthExpectedNet, Trend: cf.Forecast.Trend,
  };
  const trendIcon = (change, inverse = false) => {
    if (Math.abs(change || 0) < 1) return '➡️';
    const positive = inverse ? change < 0 : change > 0;
    return positive ? '📈' : '📉';
  };
  dto.MainKpis = [
    { Title: 'إجمالي الإيرادات', Subtitle: `${income.InvoicesCount} فاتورة`, Value: income.NetRevenue, Format: 'money', Icon: 'TrendingUp', Color: '#10b981', ChangePercentage: income.PreviousPeriod?.RevenueChange ?? null, ChangeLabel: income.PreviousPeriod ? 'vs الفترة السابقة' : '', TrendIcon: trendIcon(income.PreviousPeriod?.RevenueChange ?? 0), Url: '/reports/income-statement' },
    { Title: 'صافي الربح', Subtitle: `${income.NetProfitMargin.toFixed(1)}% هامش ربح`, Value: income.NetProfit, Format: 'money', Icon: income.NetProfit >= 0 ? 'AccountBalance' : 'Warning', Color: income.NetProfit >= 0 ? '#10b981' : '#ef4444', ChangePercentage: income.PreviousPeriod?.NetProfitChange ?? null, ChangeLabel: income.PreviousPeriod ? 'vs الفترة السابقة' : '', TrendIcon: trendIcon(income.PreviousPeriod?.NetProfitChange ?? 0), Url: '/reports/income-statement' },
    { Title: 'إجمالي المصروفات', Subtitle: `${income.ExpensesByGroup.length} مجموعة`, Value: income.TotalOperatingExpenses, Format: 'money', Icon: 'MoneyOff', Color: '#f59e0b', ChangePercentage: income.PreviousPeriod?.ExpensesChange ?? null, ChangeLabel: income.PreviousPeriod ? 'vs الفترة السابقة' : '', TrendIcon: trendIcon(income.PreviousPeriod?.ExpensesChange ?? 0, true), Url: '/expenses' },
    { Title: 'الرصيد النقدي', Subtitle: `${cf.LiquidityAnalysis.LiquidityRatio} شهر سيولة`, Value: cf.ClosingBalance, Format: 'money', Icon: 'AccountBalanceWallet', Color: '#06b6d4', ChangePercentage: null, ChangeLabel: '', TrendIcon: '', Url: '/cashbox/dashboard' },
    { Title: 'صافي التدفق', Subtitle: 'في الفترة', Value: cf.NetCashFlow, Format: 'money', Icon: cf.NetCashFlow >= 0 ? 'TrendingUp' : 'TrendingDown', Color: cf.NetCashFlow >= 0 ? '#10b981' : '#ef4444', ChangePercentage: null, ChangeLabel: '', TrendIcon: '', Url: '/reports/cash-flow' },
    { Title: 'هامش الربح الإجمالي', Subtitle: `تكلفة: ${Math.round(income.CostOfGoodsSold)} ج`, Value: income.GrossProfitMargin, Format: 'percent', Icon: 'PieChart', Color: income.GrossProfitMargin >= 30 ? '#10b981' : '#f59e0b', ChangePercentage: null, ChangeLabel: '', TrendIcon: '', Url: '/reports/income-statement' },
  ];
  // النسب — BuildRatiosAsync:268 (التحصيل على كل الفواتير: انحراف المنشئين المحميين الموثّق أعلاه)
  const scoped = Boolean(range.branchId);
  const ratioRows = await request(pool, baseParams(range), `
    SELECT ISNULL(SUM(t.GrandTotal), 0) AS Invoiced, ISNULL(SUM(t.PaidAmount), 0) AS Collected,
           (SELECT ISNULL(SUM(x.GrandTotal - x.PaidAmount), 0) FROM Transactions x WHERE x.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 'x.InvoiceStatus')} AND x.GrandTotal > x.PaidAmount) AS Receivables
    FROM Transactions t
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScope('t', scoped)}
  `);
  const rr = ratioRows[0] || {};
  const quick = cf.LiquidityAnalysis.AverageMonthlyOutflow > 0
    ? round1((cf.ClosingBalance + Number(rr.Receivables || 0)) / cf.LiquidityAnalysis.AverageMonthlyOutflow) : 0;
  dto.Ratios = {
    GrossProfitMargin: income.GrossProfitMargin, NetProfitMargin: income.NetProfitMargin,
    OperatingExpenseRatio: income.NetRevenue === 0 ? 0 : round1((income.TotalOperatingExpenses / income.NetRevenue) * 100),
    CashRatio: cf.LiquidityAnalysis.LiquidityRatio, QuickRatio: quick, CurrentRatio: quick,
    RevenuePerInvoice: income.AverageInvoiceValue,
    CollectionRate: Number(rr.Invoiced || 0) === 0 ? 0 : round1((Number(rr.Collected || 0) / Number(rr.Invoiced)) * 100),
    RevenueGrowthRate: income.PreviousPeriod?.RevenueChange ?? 0, ExpenseGrowthRate: income.PreviousPeriod?.ExpensesChange ?? 0,
  };
  // الصحة المالية — BuildHealthScore: أوزان 25/25/20/15/15 بعتبات بلازور الحرفية
  const factors = [];
  const m = income.NetProfitMargin;
  const profScore = m >= 20 ? 25 : m >= 15 ? 22 : m >= 10 ? 18 : m >= 5 ? 12 : m > 0 ? 6 : 0;
  factors.push({ Name: 'الربحية', Score: profScore, MaxScore: 25, Description: `هامش صافي الربح: ${m.toFixed(1)}%`, Color: scoreColor(profScore, 25), Icon: 'TrendingUp' });
  const lratio = cf.LiquidityAnalysis.LiquidityRatio;
  const liqScore = lratio >= 6 ? 25 : lratio >= 3 ? 20 : lratio >= 1 ? 12 : lratio > 0 ? 5 : 0;
  factors.push({ Name: 'السيولة', Score: liqScore, MaxScore: 25, Description: `تغطية ${lratio} شهر`, Color: scoreColor(liqScore, 25), Icon: 'WaterDrop' });
  let growthScore = 10;
  if (income.PreviousPeriod) {
    const c = income.PreviousPeriod.RevenueChange;
    growthScore = c >= 20 ? 20 : c >= 10 ? 16 : c >= 5 ? 13 : c >= 0 ? 10 : c >= -10 ? 5 : 0;
  }
  factors.push({ Name: 'النمو', Score: growthScore, MaxScore: 20, Description: income.PreviousPeriod ? `تغير الإيرادات: ${income.PreviousPeriod.RevenueChange >= 0 ? '+' : ''}${income.PreviousPeriod.RevenueChange.toFixed(1)}%` : 'لا توجد بيانات للمقارنة', Color: scoreColor(growthScore, 20), Icon: 'ShowChart' });
  const er = dto.Ratios.OperatingExpenseRatio;
  const effScore = er <= 30 ? 15 : er <= 50 ? 12 : er <= 70 ? 8 : er <= 90 ? 4 : 0;
  factors.push({ Name: 'الكفاءة التشغيلية', Score: effScore, MaxScore: 15, Description: `نسبة المصروفات: ${er.toFixed(1)}%`, Color: scoreColor(effScore, 15), Icon: 'Speed' });
  const cr = dto.Ratios.CollectionRate;
  const collScore = cr >= 90 ? 15 : cr >= 75 ? 12 : cr >= 60 ? 8 : cr >= 40 ? 4 : 0;
  factors.push({ Name: 'كفاءة التحصيل', Score: collScore, MaxScore: 15, Description: `نسبة التحصيل: ${cr.toFixed(1)}%`, Color: scoreColor(collScore, 15), Icon: 'Payments' });
  const overall = factors.reduce((s, f) => s + f.Score, 0);
  const hs = { Factors: factors, OverallScore: overall, Grade: '', Status: '', Color: '', Description: '' };
  if (overall >= 90) { hs.Grade = 'A+'; hs.Status = 'ممتاز'; hs.Color = '#10b981'; hs.Description = 'الصحة المالية ممتازة! استمر على هذا المستوى وفكر في التوسع.'; }
  else if (overall >= 80) { hs.Grade = 'A'; hs.Status = 'ممتاز'; hs.Color = '#10b981'; hs.Description = 'الصحة المالية قوية وفي المسار الصحيح.'; }
  else if (overall >= 70) { hs.Grade = 'B+'; hs.Status = 'جيد جداً'; hs.Color = '#22c55e'; hs.Description = 'وضع جيد جداً مع مجال للتحسين في بعض المؤشرات.'; }
  else if (overall >= 60) { hs.Grade = 'B'; hs.Status = 'جيد'; hs.Color = '#84cc16'; hs.Description = 'وضع جيد، لكن يحتاج لتحسين بعض المؤشرات للوصول للمستوى الممتاز.'; }
  else if (overall >= 50) { hs.Grade = 'C'; hs.Status = 'متوسط'; hs.Color = '#f59e0b'; hs.Description = 'وضع متوسط - يحتاج عمل على تحسين الربحية والسيولة.'; }
  else if (overall >= 35) { hs.Grade = 'D'; hs.Status = 'ضعيف'; hs.Color = '#fb923c'; hs.Description = 'وضع ضعيف - يحتاج تدخل سريع لتحسين الأداء المالي.'; }
  else { hs.Grade = 'F'; hs.Status = 'حرج'; hs.Color = '#ef4444'; hs.Description = 'وضع حرج! يجب اتخاذ إجراءات فورية لتحسين الصحة المالية.'; }
  dto.HealthScore = hs;
  const mapComp = (src) => src ? {
    Label: src.Label, Revenue: src.Revenue, Expenses: src.Expenses, NetProfit: src.NetProfit,
    RevenueChange: src.RevenueChange, ExpensesChange: src.ExpensesChange, NetProfitChange: src.NetProfitChange,
    OverallTrend: src.NetProfitChange > 5 ? 'نمو' : src.NetProfitChange < -5 ? 'تراجع' : 'ثابت',
    TrendIcon: src.NetProfitChange > 5 ? '📈' : src.NetProfitChange < -5 ? '📉' : '➡️',
  } : null;
  dto.VsPreviousPeriod = mapComp(income.PreviousPeriod);
  dto.VsLastYear = mapComp(income.PreviousYear);
  // الترند الموحّد — BuildUnifiedMonthlyTrendAsync:539: تكلفة = الكمية × PurchasePrice الحالي،
  // والمصروفات بلا رواتب (تعريف اللوحة الخاص — محفوظ حرفيًا وإن خالف قائمة الدخل)
  dto.Last12Months = [];
  const today = new Date();
  let cursor = new Date(Date.UTC(today.getFullYear(), today.getMonth() - 11, 1));
  let runningBalance = money(await cashSum(pool, { ...range, from: new Date(Date.UTC(2000, 0, 1)), to: cursor },
    `t.TransactionDate < @toDate AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`)
    - await cashSum(pool, { ...range, from: new Date(Date.UTC(2000, 0, 1)), to: cursor },
      `t.TransactionDate < @toDate AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`));
  // ملحوظة: الرصيد الجاري أعلاه بلا OpeningBalance المحفوظ — نفس بلازور (حركات فقط)
  for (let i = 0; i < 12; i += 1) {
    const mTo = addDays(addMonths(cursor, 1), -1);
    const mRange = { from: cursor, to: mTo, branchId: range.branchId, cashBoxId: range.cashBoxId };
    const revRows = await request(pool, baseParams(mRange), `
      SELECT ISNULL(SUM(ISNULL(t.NetTotalAmount, t.GrandTotal)), 0) AS Revenue FROM Transactions t
      WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
        AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScope('t', scoped)}
    `);
    const cogsRows = await request(pool, baseParams(mRange), `
      SELECT ISNULL(SUM(d.Quantity * ISNULL(p.PurchasePrice, 0)), 0) AS Cogs
      FROM Transactions t
      INNER JOIN TransactionDetails d ON d.TransactionID = t.TransactionID
      INNER JOIN Products p ON p.ProductID = d.ProductID
      WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
        AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScope('t', scoped)}
    `);
    const exp = await expenseSum(pool, mRange, cursor, mTo);
    const cIn = await cashSum(pool, mRange, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
    const cOut = await cashSum(pool, mRange, `t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
    const revenue = Number(revRows[0]?.Revenue || 0); const cogs = Number(cogsRows[0]?.Cogs || 0);
    const netProfit = revenue - cogs - exp;
    runningBalance = money(runningBalance + cIn - cOut);
    dto.Last12Months.push({
      Month: dstr(cursor), MonthLabel: `${cursor.getUTCFullYear()}/${String(cursor.getUTCMonth() + 1).padStart(2, '0')}`,
      Revenue: money(revenue), Cogs: money(cogs), Expenses: money(exp), NetProfit: money(netProfit),
      NetProfitMargin: revenue === 0 ? 0 : round1((netProfit / revenue) * 100),
      CashInflows: money(cIn), CashOutflows: money(cOut), NetCashFlow: money(cIn - cOut), CashBalance: runningBalance,
    });
    cursor = addMonths(cursor, 1);
  }
  const topProducts = await request(pool, baseParams(range), `
    SELECT TOP 10 p.ProductID, p.ProductName,
      ISNULL(SUM(CAST(d.Quantity AS int)), 0) AS QuantitySold,
      ISNULL(SUM(d.Quantity * d.UnitPrice), 0) AS Revenue,
      ISNULL(SUM(d.Quantity * ISNULL(p.PurchasePrice, 0)), 0) AS Cogs,
      COUNT(DISTINCT t.TransactionID) AS OrdersCount
    FROM Transactions t
    INNER JOIN TransactionDetails d ON d.TransactionID = t.TransactionID
    INNER JOIN Products p ON p.ProductID = d.ProductID
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScope('t', scoped)}
    GROUP BY p.ProductID, p.ProductName ORDER BY Revenue DESC
  `);
  dto.TopProducts = topProducts.map((r) => {
    const revenue = money(r.Revenue); const cogs = money(r.Cogs);
    return {
      ProductId: Number(r.ProductId), ProductName: r.ProductName || '', QuantitySold: Number(r.QuantitySold || 0),
      Revenue: revenue, Cogs: cogs, Profit: money(revenue - cogs),
      ProfitMargin: revenue === 0 ? 0 : round1(((revenue - cogs) / revenue) * 100), OrdersCount: Number(r.OrdersCount || 0),
    };
  });
  const topCustomers = await request(pool, baseParams(range), `
    SELECT TOP 10 pa.PartyID, pa.PartyName, pa.Phone, COUNT(*) AS InvoicesCount,
      ISNULL(SUM(t.GrandTotal), 0) AS TotalRevenue, ISNULL(SUM(t.PaidAmount), 0) AS TotalPaid
    FROM Transactions t INNER JOIN Parties pa ON pa.PartyID = t.PartyID
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')}
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate) ${txScope('t', scoped)}
    GROUP BY pa.PartyID, pa.PartyName, pa.Phone ORDER BY TotalRevenue DESC
  `);
  dto.TopCustomers = topCustomers.map((r) => {
    const total = money(r.TotalRevenue); const paid = money(r.TotalPaid); const count = Number(r.InvoicesCount || 0);
    return {
      PartyId: Number(r.PartyId), CustomerName: r.PartyName || '', Phone: r.Phone, InvoicesCount: count,
      TotalRevenue: total, TotalPaid: paid, Remaining: money(total - paid),
      AverageInvoiceValue: count === 0 ? 0 : round2(total / count),
    };
  });
  dto.TopExpenseCategories = income.ExpensesByGroup.slice(0, 8).map((g) => ({
    GroupName: g.GroupName, Amount: g.Amount, Percentage: g.Percentage, Color: g.Color || '#94a3b8',
  }));
  // الذمم — BuildReceivablesSummaryAsync (مستحقات الموردين تستبعد PartyId=11 الافتراضي وتشمل المرآة ضمن المشتريات)
  const recvSumRows = await request(pool, baseParams(range), `
    SELECT ISNULL(SUM(t.GrandTotal - t.PaidAmount), 0) AS Total, COUNT(DISTINCT t.PartyID) AS Debtors,
      (SELECT COUNT(*) FROM Transactions o WHERE o.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 'o.InvoiceStatus')} AND o.GrandTotal > o.PaidAmount AND o.DueDate IS NOT NULL AND o.DueDate < CAST(GETDATE() AS DATE) ${txScope('o', scoped)}) AS Overdue,
      (SELECT ISNULL(SUM(s.GrandTotal - s.PaidAmount), 0) FROM Transactions s WHERE s.TransactionType = 'Purchase' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 's.InvoiceStatus')} AND s.PartyID <> 11 AND s.GrandTotal > s.PaidAmount ${txScope('s', scoped)}) AS SupplierTotal
    FROM Transactions t
    WHERE t.TransactionType = 'Sale' AND ${NOT_CANCELLED.replaceAll('InvoiceStatus', 't.InvoiceStatus')} AND t.GrandTotal > t.PaidAmount ${txScope('t', scoped)}
  `);
  const rs = recvSumRows[0] || {};
  let personalCredit = 0; let personalDebit = 0;
  try {
    const accounts = await request(pool, [], 'SELECT PersonalAccountId, OpeningBalance, OpeningType FROM PersonalAccounts');
    for (const acc of accounts) {
      const loanRange = { ...range, from: new Date(Date.UTC(2000, 0, 1)), to: new Date() };
      const inAmt = await cashSum(pool, loanRange, `t.ReferenceType = 'Loan' AND t.ReferenceId = ${Number(acc.PersonalAccountId)} AND (t.TransactionType = N'قبض' OR t.TransactionType = 'In')`);
      const outAmt = await cashSum(pool, loanRange, `t.ReferenceType = 'Loan' AND t.ReferenceId = ${Number(acc.PersonalAccountId)} AND (t.TransactionType = N'صرف' OR t.TransactionType = 'Out')`);
      const openingDebit = acc.OpeningType === 'Debit' ? Number(acc.OpeningBalance || 0) : 0;
      const openingCredit = acc.OpeningType === 'Credit' ? Number(acc.OpeningBalance || 0) : 0;
      const balance = (openingCredit - openingDebit) + (inAmt - outAmt);
      if (balance > 0) personalCredit += balance; else if (balance < 0) personalDebit += Math.abs(balance);
    }
  } catch { /* جدول الحسابات الشخصية غائب: القيم صفر */ }
  dto.Receivables = {
    CustomerReceivables: money(rs.Total), SupplierPayables: money(rs.SupplierTotal),
    PersonalAccountsCredit: money(personalCredit), PersonalAccountsDebit: money(personalDebit),
    NetReceivables: money(Number(rs.Total || 0) - Number(rs.SupplierTotal || 0) - personalCredit + personalDebit),
    CustomersWithDebtCount: Number(rs.Debtors || 0), OverdueInvoicesCount: Number(rs.Overdue || 0),
  };
  // التنبيهات الموحدة + التوصيات الاستراتيجية — ConsolidateAlerts / GenerateStrategicRecommendations
  const alerts = [];
  for (const rec of income.Recommendations.slice(0, 5)) alerts.push({ ...rec, ActionUrl: '/reports/income-statement', ActionLabel: 'عرض القائمة الكاملة', Category: 'Income' });
  for (const a of cf.Alerts.slice(0, 5)) alerts.push({ Type: a.Type, Icon: a.Icon, Title: a.Title, Description: a.Description, ActionUrl: '/reports/cash-flow', ActionLabel: 'عرض التدفقات', Priority: a.Priority + 100, Color: a.Color, Category: 'CashFlow' });
  if (dto.Receivables.OverdueInvoicesCount > 0) alerts.push({ Type: 'Warning', Icon: '', Title: `${dto.Receivables.OverdueInvoicesCount} فاتورة متأخرة`, Description: `يوجد ${dto.Receivables.OverdueInvoicesCount} فاتورة تجاوزت تاريخ الاستحقاق. تابع التحصيل.`, ActionUrl: '/sales/invoices', ActionLabel: 'عرض الفواتير', Priority: 50, Color: '#f59e0b', Category: 'Receivables' });
  if (dto.Receivables.CustomerReceivables > cf.ClosingBalance) alerts.push({ Type: 'Info', Icon: '', Title: 'مستحقات العملاء أعلى من الرصيد النقدي', Description: `لديك ${dto.Receivables.CustomerReceivables} ج مستحقات. تركيز على التحصيل سيحسّن السيولة.`, ActionUrl: '/sales/invoices', ActionLabel: 'عرض المستحقات', Priority: 60, Color: '#3b82f6', Category: 'Receivables' });
  dto.Alerts = alerts.sort((a, b) => (a.Priority || 0) - (b.Priority || 0)).slice(0, 10);
  const strategic = [];
  if (income.NetProfitMargin < 10 && income.NetRevenue > 0) strategic.push({ Title: 'تحسين هامش الربح', Description: `هامش الربح الحالي ${income.NetProfitMargin.toFixed(1)}% أقل من الهدف 10%. ركّز على تقليل تكلفة المبيعات أو زيادة الأسعار.`, Impact: 'High', Difficulty: 'Medium', ExpectedOutcome: 'زيادة صافي الربح بـ 30-50%', Icon: '', Color: '#10b981', ActionSteps: ['راجع أسعار الشراء مع الموردين الحاليين', 'ابحث عن موردين بديلين بأسعار أفضل', 'ارفع أسعار البيع للمنتجات الأقل حساسية للسعر', 'قلل المصروفات التشغيلية غير الضرورية'] });
  if (cf.LiquidityAnalysis.LiquidityRatio < 3) strategic.push({ Title: 'تعزيز السيولة النقدية', Description: `السيولة الحالية تكفي ${cf.LiquidityAnalysis.LiquidityRatio} شهر فقط. اهدف للوصول لـ 3-6 شهور كحد آمن.`, Impact: 'High', Difficulty: 'Medium', ExpectedOutcome: 'حماية الشركة من المخاطر المالية', Icon: '', Color: '#06b6d4', ActionSteps: ['فعّل سياسة تحصيل أسرع للفواتير', 'تفاوض مع الموردين على فترات سداد أطول', 'أجّل المصروفات الاستثمارية غير الضرورية', 'فكر في خط ائتمان احتياطي من البنك'] });
  if (dto.TopProducts.length && dto.TopProducts[0].Revenue > income.NetRevenue * 0.5) strategic.push({ Title: 'تنويع مصادر الإيرادات', Description: 'المنتج الرئيسي يمثل أكثر من 50% من الإيرادات. الاعتماد على منتج واحد يشكّل مخاطرة.', Impact: 'Medium', Difficulty: 'Hard', ExpectedOutcome: 'تقليل المخاطر وزيادة الإيرادات بـ 20-40%', Icon: '', Color: '#8b5cf6', ActionSteps: ['حدّد المنتجات الأكثر طلباً ولكن أقل ترويجاً', 'طوّر منتجات جديدة مكملة', 'وسّع قاعدة العملاء جغرافياً أو في قطاعات جديدة', 'ادرس فرص الشراكات والتعاون'] });
  if (dto.Ratios.CollectionRate < 75 && dto.Receivables.CustomerReceivables > 0) strategic.push({ Title: 'تحسين كفاءة التحصيل', Description: `نسبة التحصيل ${dto.Ratios.CollectionRate.toFixed(1)}% منخفضة. لديك ${dto.Receivables.CustomerReceivables} ج مستحقات معلقة.`, Impact: 'High', Difficulty: 'Easy', ExpectedOutcome: 'تحرير سيولة فورية', Icon: '', Color: '#f59e0b', ActionSteps: ['اتصل بكل العملاء أصحاب الفواتير المتأخرة', 'اطلب دفعات مقدمة على الطلبات الكبيرة', 'اعرض خصم 2% للسداد المبكر', 'حدّد سقف ائتمان لكل عميل حسب تاريخه'] });
  if (dto.TopExpenseCategories.length && dto.TopExpenseCategories[0].Percentage > 40) strategic.push({ Title: `مراجعة مصروفات ${dto.TopExpenseCategories[0].GroupName}`, Description: `تمثل ${dto.TopExpenseCategories[0].Percentage}% من إجمالي المصروفات (${dto.TopExpenseCategories[0].Amount} ج). فرصة كبيرة للتوفير.`, Impact: 'Medium', Difficulty: 'Medium', ExpectedOutcome: 'توفير 10-25% من هذا البند', Icon: '', Color: '#ef4444', ActionSteps: ['حلل تفاصيل المصروفات في هذه المجموعة', 'ابحث عن بنود غير ضرورية', 'تفاوض على عقود أفضل', 'ضع حد أقصى شهري للإنفاق'] });
  if (income.NetProfitMargin >= 15 && cf.LiquidityAnalysis.LiquidityRatio >= 3 && (income.PreviousPeriod?.RevenueChange ?? 0) > 10) strategic.push({ Title: 'وقت الاستثمار في النمو', Description: 'أداء مالي ممتاز - الوقت مناسب للاستثمار في توسيع النشاط.', Impact: 'High', Difficulty: 'Hard', ExpectedOutcome: 'نمو 50-100% خلال سنة', Icon: '', Color: '#10b981', ActionSteps: ['زد الاستثمار في التسويق والإعلان', 'وظّف موظفين إضافيين للمبيعات', 'افتح فرع جديد أو وسّع المنطقة الجغرافية', 'استثمر في تطوير المنتجات الجديدة'] });
  dto.StrategicRecommendations = strategic;
  return dto;
}

async function withPool(fn) {
  const pool = await connectDB();
  return fn(pool);
}

module.exports = {
  parseRange, getIncomeStatement, getBalanceSheet, getCashFlow, getFinancialDashboard, withPool,
  // تُعاد استخدامها من لوحة القيادة التنفيذية (نفس تعريفات قائمة الدخل)
  _internal: { txScope, creatorScope, NOT_CANCELLED, request, baseParams, payrollRows, proRatePayroll, computeCogs },
};
