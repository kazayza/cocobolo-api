// ════════════════════════════════════════════════════════════════════
//  تحليلات المبيعات — مرآة SalesAnalyticsService.cs في بلازور (بند 23).
//  النطاق الإجباري في طبقة الخدمة كما في بلازور:
//   ① فواتير البيع التي أنشأها مديرو الحسابات تُستبعد لمن لا يملك رؤيتها
//      (SalesInvoiceAccess — عبر financial-reports.queries.getProtectedCreators).
//   ② نطاق CrmAccessFrom (تاريخ بدء الاطّلاع من Claims بلازور): جلسة الـ API
//      لا تحمل هذا الادعاء أصلًا (لا AccessFrom في auth.middleware)، لذا
//      ScopeFromDate = null دائمًا هنا — موثّق كفجوة جلسة لا كقرار تعريف.
//  الفلاتر (فرع/موظف/حالة) تنطبق على كل الأرقام والرسوم معًا كما في بلازور.
//  الصافي = NetTotalAmount ?? 0 حرفيًا (FetchSalesAsync — بلا بديل GrandTotal).
//  التصدير (ExportAsync/Excel) خارج النطاق: لا مقابل له في الـ API.
// ════════════════════════════════════════════════════════════════════
const { sql, connectDB } = require('../../core/database');
const { addDays, money } = require('../../shared/reporting.utils');
const fin = require('./financial-reports.queries');
const { invoices: invoicePolicy } = require('../../shared/authorization.policy');

const SALE_STATUS_OPTIONS = ['Open', 'PartiallyPaid', 'Paid'];
const PAY_METHOD_LABELS = {
  Cash: 'نقدي', Bank: 'بنك / تحويل', Visa: 'فيزا', InstaPay: 'انستاباي',
  Credit: 'اعتماد / آجل', Advance: 'عربون / دفعة مقدمة',
};
function payMethodLabel(m) { return PAY_METHOD_LABELS[m] || 'أخرى'; }
function round1(v) { return Math.round(Number(v || 0) * 10) / 10; }
function round2(v) { return Math.round(Number(v || 0) * 100) / 100; }
function dstr(date) { return date.toISOString().slice(0, 10); }
function dayOf(value) {
  const d = new Date(value);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}
function parseFilter(query = {}) {
  const today = new Date();
  const defFrom = new Date(Date.UTC(today.getFullYear(), today.getMonth(), 1));
  const defTo = new Date(Date.UTC(today.getFullYear(), today.getMonth(), today.getDate()));
  const parse = (value, fallback) => {
    if (!value) return fallback;
    const d = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(d.getTime()) ? null : d;
  };
  let from = parse(query.dateFrom || query.from, defFrom);
  let to = parse(query.dateTo || query.to, defTo);
  if (!from || !to) throw Object.assign(new Error('نطاق التاريخ غير صالح'), { statusCode: 400, code: 'INVALID_DATE_RANGE' });
  if (to < from) to = from;
  const intOrNull = (v) => {
    const n = Number(v);
    return v != null && v !== '' && Number.isSafeInteger(n) && n > 0 ? n : null;
  };
  return {
    from, to,
    branchId: intOrNull(query.branchId),
    employeeId: intOrNull(query.employeeId),
    invoiceStatus: query.invoiceStatus ? String(query.invoiceStatus) : null,
  };
}

async function request(pool, params, text) {
  return fin._internal.request(pool, params, text);
}

async function ctxData(pool) {
  const [branches, warehouses, employees] = await Promise.all([
    request(pool, [], 'SELECT BranchID AS Id, BranchNameAr AS Name FROM Branches'),
    request(pool, [], 'SELECT WarehouseID AS Id, BranchID AS BranchId FROM Warehouses'),
    request(pool, [], 'SELECT EmployeeID AS Id, FullName AS Name, BranchID AS BranchId FROM Employees'),
  ]);
  return {
    branchNames: new Map(branches.map((b) => [Number(b.Id), b.Name || `فرع ${b.Id}`])),
    warehouseBranch: new Map(warehouses.map((w) => [Number(w.Id), w.BranchId == null ? null : Number(w.BranchId)])),
    empNames: new Map(employees.map((e) => [Number(e.Id), e.Name || `موظف ${e.Id}`])),
    empBranch: new Map(employees.map((e) => [Number(e.Id), e.BranchId == null ? null : Number(e.BranchId)])),
    branches: branches.map((b) => ({ Id: Number(b.Id), Name: b.Name || '' })).sort((a, b) => a.Name.localeCompare(b.Name)),
  };
}

async function fetchSales(pool, from, to, protectedCreators) {
  const rows = await request(pool, [
    ['fromDate', sql.Date, from], ['toDate', sql.Date, to],
  ], `
    SELECT t.TransactionID AS Id, t.TransactionDate AS [Date],
           ISNULL(t.NetTotalAmount, 0) AS Net, t.PartyID AS PartyId,
           t.WarehouseID AS WarehouseId, t.EmpId, t.InvoiceStatus AS [Status],
           t.ReferenceNumber AS RefNo, ISNULL(t.PaidAmount, 0) AS Paid,
           t.PaymentMethod AS PayMethod, t.CreatedBy
    FROM Transactions t
    WHERE t.TransactionType = 'Sale'
      AND (t.InvoiceStatus IS NULL OR t.InvoiceStatus <> 'Cancelled')
      AND t.TransactionDate >= @fromDate AND t.TransactionDate < DATEADD(DAY, 1, @toDate)
      ${fin._internal.protectedSql('t', protectedCreators)}
  `);
  return rows.map((r) => ({
    Id: Number(r.Id), Date: r.Date, Net: Number(r.Net || 0), PartyId: Number(r.PartyId || 0),
    WarehouseId: r.WarehouseId == null ? null : Number(r.WarehouseId),
    EmpId: r.EmpId == null ? null : Number(r.EmpId),
    Status: r.Status || null, RefNo: r.RefNo || null,
    Paid: Number(r.Paid || 0), PayMethod: r.PayMethod || null, CreatedBy: r.CreatedBy || null,
  }));
}

async function fetchOpps(pool, from, to) {
  const rows = await request(pool, [
    ['fromDate', sql.DateTime, from], ['toDate', sql.DateTime, addDays(to, 1)],
  ], `
    SELECT EmployeeID AS EmployeeId, StageID AS StageId, TransactionID AS TransactionId,
           LostReasonID AS LostReasonId, CreatedAt
    FROM SalesOpportunities
    WHERE IsActive = 1 AND CreatedAt >= @fromDate AND CreatedAt < @toDate AND EmployeeID IS NOT NULL
  `);
  return rows.map((r) => ({
    EmployeeId: Number(r.EmployeeId), StageId: Number(r.StageId),
    TransactionId: r.TransactionId == null ? null : Number(r.TransactionId),
    LostReasonId: r.LostReasonId == null ? null : Number(r.LostReasonId),
    CreatedAt: r.CreatedAt,
    Won: Number(r.StageId) === 3 && r.TransactionId != null,
    IsLost: Number(r.StageId) === 4 || Number(r.StageId) === 5,
  }));
}

// مالك الفاتورة = موظف فرصة «تم البيع» المرتبطة، وإلا منشئها (EmpId)؛
// والرابط لا يتجاوز حماية المنشئين لمن لا يملك رؤيتها (BuildOwnerMapAsync).
async function buildOwnerMap(pool, sales, protectedCreators, canSeeProtected) {
  const map = new Map(sales.map((s) => [s.Id, s.EmpId]));
  if (!sales.length) return map;
  const ids = sales.map((s) => s.Id);
  const linked = await request(pool, [], `
    SELECT TransactionID AS TransactionId, EmployeeID AS EmployeeId FROM SalesOpportunities
    WHERE IsActive = 1 AND StageID = 3 AND TransactionID IS NOT NULL AND EmployeeID IS NOT NULL
      AND TransactionID IN (${ids.join(',')})`);
  const byId = new Map(sales.map((s) => [s.Id, s]));
  for (const x of linked) {
    const tid = Number(x.TransactionId);
    if (!canSeeProtected) {
      const creator = byId.get(tid)?.CreatedBy;
      if (creator && protectedCreators.includes(creator)) continue;
    }
    map.set(tid, Number(x.EmployeeId));
  }
  return map;
}

function branchOf(sale, ctx) {
  if (sale.WarehouseId == null) return null;
  return ctx.warehouseBranch.has(sale.WarehouseId) ? ctx.warehouseBranch.get(sale.WarehouseId) : null;
}
function ownerOf(sale, ownerMap) {
  return ownerMap.has(sale.Id) ? ownerMap.get(sale.Id) : sale.EmpId;
}
function matches(sale, filter, ctx, ownerMap) {
  if (filter.branchId != null && branchOf(sale, ctx) !== filter.branchId) return false;
  if (filter.employeeId != null && ownerOf(sale, ownerMap) !== filter.employeeId) return false;
  if (filter.invoiceStatus && sale.Status !== filter.invoiceStatus) return false;
  return true;
}

function buildEmployees(cur, opps, ctx, oppBranchOk, onlyEmployeeId, ownerMap) {
  const byOwner = new Map();
  for (const s of cur) {
    const o = ownerOf(s, ownerMap);
    if (o == null) continue;
    if (!byOwner.has(o)) byOwner.set(o, { Count: 0, Sum: 0 });
    const agg = byOwner.get(o); agg.Count += 1; agg.Sum += s.Net;
  }
  const ids = new Set([...byOwner.keys(), ...opps.filter((o) => oppBranchOk(o.EmployeeId)).map((o) => o.EmployeeId)]);
  if (onlyEmployeeId != null && !ids.has(onlyEmployeeId)) ids.add(onlyEmployeeId);
  const list = [];
  for (const empId of ids) {
    if (onlyEmployeeId != null && empId !== onlyEmployeeId) continue;
    const empOpps = opps.filter((o) => o.EmployeeId === empId && oppBranchOk(empId));
    const won = empOpps.filter((o) => o.Won).length;
    const inv = byOwner.get(empId) || { Count: 0, Sum: 0 };
    list.push({
      EmpId: empId,
      Name: ctx.empNames.get(empId) || `موظف ${empId}`,
      Opportunities: empOpps.length,
      WonDeals: won,
      ConversionRate: empOpps.length > 0 ? round1((won / empOpps.length) * 100) : 0,
      InvoiceCount: inv.Count,
      SalesAmount: money(inv.Sum),
      AvgInvoice: inv.Count > 0 ? round2(inv.Sum / inv.Count) : 0,
      AvgCycleDays: 0,
      Invoices: [],
    });
  }
  return list.sort((a, b) => b.SalesAmount - a.SalesAmount || b.InvoiceCount - a.InvoiceCount || b.Opportunities - a.Opportunities);
}

function buildTrend(cur, from, prev, prevFrom, days) {
  const step = days <= 31 ? 1 : days <= 183 ? 7 : 30;
  const startsOf = (base) => {
    const list = [];
    const end = addDays(base, days - 1);
    for (let d = base; d <= end; d = addDays(d, step)) list.push(d);
    return list.length ? list : [base];
  };
  const curStarts = startsOf(from);
  const prevStarts = startsOf(prevFrom);
  const n = Math.max(curStarts.length, prevStarts.length);
  const bucket = (date, base) => {
    let idx = Math.floor((dayOf(date) - base) / 86400000 / step);
    if (idx < 0) idx = 0;
    if (idx >= n) idx = n - 1;
    return idx;
  };
  const curSum = new Array(n).fill(0); const prevSum = new Array(n).fill(0);
  for (const s of cur) curSum[bucket(s.Date, from)] += s.Net;
  for (const s of prev) prevSum[bucket(s.Date, prevFrom)] += s.Net;
  return {
    labels: curStarts.map((d) => `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`),
    current: curSum.map(money), prev: prevSum.map(money),
  };
}

function fmtMoney(v) { return `${Math.round(Number(v || 0)).toLocaleString('en-US')} ج`; }
function buildInsights(c) {
  const list = [];
  if (c.prevTotal > 0) {
    const pct = ((c.total - c.prevTotal) / c.prevTotal) * 100;
    list.push(pct >= 0
      ? `مبيعات هذه الفترة أعلى بنسبة ${round1(pct)}% من الفترة السابقة (${fmtMoney(c.total)} مقابل ${fmtMoney(c.prevTotal)}).`
      : `مبيعات هذه الفترة أقل بنسبة ${round1(-pct)}% من الفترة السابقة (${fmtMoney(c.total)} مقابل ${fmtMoney(c.prevTotal)}).`);
  } else if (c.total > 0) {
    list.push(`سجّلت هذه الفترة مبيعات بقيمة ${fmtMoney(c.total)} مقابل صفر في الفترة السابقة.`);
  }
  if (c.topBranch && c.topBranchAmount > 0) list.push(`الفرع «${c.topBranch}» هو الأعلى إسهاماً بمبيعات ${fmtMoney(c.topBranchAmount)}.`);
  if (c.topEmployee && c.topEmployee.SalesAmount > 0) list.push(`الموظف «${c.topEmployee.Name}» الأعلى قيمة فواتير (${fmtMoney(c.topEmployee.SalesAmount)}) بمتوسط فاتورة ${fmtMoney(c.topEmployee.AvgInvoice)}.`);
  if (c.topCustomer && c.topCustomer.Amount > 0) list.push(`أكبر عملاء الفترة «${c.topCustomer.Name}» بقيمة ${fmtMoney(c.topCustomer.Amount)} تمثّل ${round1(c.topCustomer.Pct)}% من إجمالي الفترة.`);
  if (c.newCustomers > 0 || c.returningCustomers > 0) list.push(`تعاملت الفترة مع ${c.newCustomers} عميل جديد و${c.returningCustomers} عميل عائد.`);
  if (c.teamLost > 0) {
    const suffix = c.topLostReason ? `أكثرها تكراراً «${c.topLostReason}».` : 'دون تسجيل سبب.';
    list.push(`رُصدت ${c.teamLost} فرصة خاسرة ضمن الفرص النشطة في الفترة — ${suffix}`);
  }
  return list;
}

async function getFilterData(pool) {
  const ctx = await ctxData(pool);
  const rows = await request(pool, [], `
    SELECT DISTINCT employeeID AS EmployeeId FROM Users
    WHERE IsActive = 1 AND Role = 'Sales' AND employeeID IS NOT NULL`);
  const salesEmployees = rows
    .map((r) => Number(r.EmployeeId))
    .filter((id) => ctx.empNames.has(id))
    .map((id) => ({ Id: id, Name: ctx.empNames.get(id), BranchId: ctx.empBranch.get(id) ?? null }))
    .sort((a, b) => a.Name.localeCompare(b.Name));
  return { Branches: ctx.branches, SalesEmployees: salesEmployees, InvoiceStatuses: [...SALE_STATUS_OPTIONS] };
}

async function getSalesAnalytics(pool, filter, auth) {
  const { from, to } = filter;
  const days = Math.round((to - from) / 86400000) + 1;
  const prevFrom = addDays(from, -days);
  const prevTo = addDays(from, -1);
  const canSeeProtected = invoicePolicy.canSeeProtectedAccountManagerInvoices(auth || {});
  const protectedCreators = await fin._internal.getProtectedCreators(pool, auth);
  const ctx = await ctxData(pool);

  const [curSalesRaw, prevSalesRaw, curOpps, prevOpps] = await Promise.all([
    fetchSales(pool, from, to, protectedCreators),
    fetchSales(pool, prevFrom, prevTo, protectedCreators),
    fetchOpps(pool, from, to),
    fetchOpps(pool, prevFrom, prevTo),
  ]);
  const ownerMap = await buildOwnerMap(pool, [...curSalesRaw, ...prevSalesRaw], protectedCreators, canSeeProtected);
  const cur = curSalesRaw.filter((s) => matches(s, filter, ctx, ownerMap));
  const prev = prevSalesRaw.filter((s) => matches(s, filter, ctx, ownerMap));

  const empMatches = (empId) => filter.employeeId == null || empId === filter.employeeId;
  const oppBranchOk = (empId) => filter.branchId == null
    || (empId != null && ctx.empBranch.get(empId) === filter.branchId);
  const scopeOpps = curOpps.filter((o) => empMatches(o.EmployeeId) && oppBranchOk(o.EmployeeId));
  const prevScopeOpps = prevOpps.filter((o) => empMatches(o.EmployeeId) && oppBranchOk(o.EmployeeId));
  const teamOpps = scopeOpps.length;
  const teamWon = scopeOpps.filter((o) => o.Won).length;
  const teamLost = scopeOpps.filter((o) => o.IsLost).length;
  const prevTeamOpps = prevScopeOpps.length;
  const prevTeamWon = prevScopeOpps.filter((o) => o.Won).length;

  const total = money(cur.reduce((s, x) => s + x.Net, 0));
  const prevTotal = money(prev.reduce((s, x) => s + x.Net, 0));
  const count = cur.length; const prevCount = prev.length;
  const customers = new Set(cur.map((s) => s.PartyId)).size;
  const prevCustomers = new Set(prev.map((s) => s.PartyId)).size;

  const employees = buildEmployees(cur, curOpps, ctx, oppBranchOk, filter.employeeId, ownerMap);

  // أسماء العملاء + تواريخ فرص الفواتير الحالية
  const partyIds = [...new Set(cur.map((s) => s.PartyId))].filter((id) => id > 0);
  const partyNames = new Map();
  if (partyIds.length) {
    const rows = await request(pool, [], `SELECT PartyID AS Id, PartyName AS Name FROM Parties WHERE PartyID IN (${partyIds.join(',')})`);
    for (const r of rows) partyNames.set(Number(r.Id), r.Name || '');
  }
  const txIds = [...new Set(cur.map((s) => s.Id))];
  const oppDates = new Map();
  if (txIds.length) {
    const rows = await request(pool, [], `
      SELECT TransactionID AS TxId, MIN(CreatedAt) AS Dt FROM SalesOpportunities
      WHERE IsActive = 1 AND StageID = 3 AND TransactionID IS NOT NULL AND TransactionID IN (${txIds.join(',')})
      GROUP BY TransactionID`);
    for (const r of rows) oppDates.set(Number(r.TxId), r.Dt);
  }
  const invoiceItem = (s) => ({
    Customer: partyNames.get(s.PartyId) || `عميل ${s.PartyId}`,
    Reference: s.RefNo || '',
    Net: money(s.Net),
    Date: s.Date,
    OpportunityDate: oppDates.get(s.Id) ?? null,
  });
  const byOwner = new Map();
  for (const s of cur) {
    const o = ownerOf(s, ownerMap);
    if (o == null) continue;
    if (!byOwner.has(o)) byOwner.set(o, []);
    byOwner.get(o).push(s);
  }
  for (const e of employees) {
    const rows = (byOwner.get(e.EmpId) || []).sort((a, b) => new Date(b.Date) - new Date(a.Date));
    e.Invoices = rows.map(invoiceItem);
  }
  // متوسط دورة البيع: فرصة مغلقة ← تاريخ فاتورتها (AttachEmployeeCyclesAsync)
  const wonOpps = scopeOpps.filter((o) => o.Won);
  if (employees.length && wonOpps.length) {
    const wonTxIds = [...new Set(wonOpps.map((o) => o.TransactionId))];
    const dateRows = await request(pool, [], `
      SELECT TransactionID AS TxId, TransactionDate AS Dt FROM Transactions WHERE TransactionID IN (${wonTxIds.join(',')})`);
    const dateMap = new Map(dateRows.map((r) => [Number(r.TxId), r.Dt]));
    const daysByEmp = new Map();
    for (const o of wonOpps) {
      const invDate = dateMap.get(o.TransactionId);
      if (!invDate) continue;
      let d = Math.round((dayOf(invDate) - dayOf(o.CreatedAt)) / 86400000);
      if (d < 0) d = 0;
      if (!daysByEmp.has(o.EmployeeId)) daysByEmp.set(o.EmployeeId, []);
      daysByEmp.get(o.EmployeeId).push(d);
    }
    for (const e of employees) {
      const lst = daysByEmp.get(e.EmpId);
      if (lst && lst.length) e.AvgCycleDays = round1(lst.reduce((a, b) => a + b, 0) / lst.length);
    }
  }

  // طرق الدفع + التحصيل
  const totalPaid = cur.reduce((s, x) => s + x.Paid, 0);
  const collectionRate = total > 0 ? Math.min(100, (totalPaid / total) * 100) : 0;
  const outstanding = Math.max(0, total - Math.min(total, totalPaid));
  const pmMap = new Map();
  let undefSum = 0; let hasUndef = false;
  for (const s of cur) {
    if (s.PayMethod && String(s.PayMethod).trim()) {
      pmMap.set(s.PayMethod, (pmMap.get(s.PayMethod) || 0) + s.Net);
    } else { hasUndef = true; undefSum += s.Net; }
  }
  const paymentMethods = [...pmMap.entries()]
    .map(([m, v]) => ({ Label: payMethodLabel(m), Value: money(v) }))
    .sort((a, b) => b.Value - a.Value);
  if (hasUndef) paymentMethods.push({ Label: 'غير محددة', Value: money(undefSum) });

  // عملاء جدد / عائدون: أول شراء لكل عميل حالي (بلا نطاق CrmAccessFrom — انظر الترويسة)
  let newCustomers = 0; let returningCustomers = 0;
  if (partyIds.length) {
    const rows = await request(pool, [], `
      SELECT PartyID AS PartyId, MIN(TransactionDate) AS FirstBuy FROM Transactions
      WHERE TransactionType = 'Sale' AND (InvoiceStatus IS NULL OR InvoiceStatus <> 'Cancelled')
        AND PartyID IN (${partyIds.join(',')})
      GROUP BY PartyID`);
    for (const r of rows) {
      if (dayOf(r.FirstBuy) >= from) newCustomers += 1; else returningCustomers += 1;
    }
  }

  // أهم العملاء (Top 10)
  const custAgg = new Map();
  for (const s of cur) {
    if (!custAgg.has(s.PartyId)) custAgg.set(s.PartyId, { Amount: 0, Count: 0 });
    const a = custAgg.get(s.PartyId); a.Amount += s.Net; a.Count += 1;
  }
  const topCustomers = [...custAgg.entries()]
    .map(([partyId, a]) => ({ PartyId: partyId, Amount: a.Amount, Count: a.Count }))
    .sort((a, b) => b.Amount - a.Amount).slice(0, 10)
    .map((g) => ({
      PartyId: g.PartyId,
      Name: partyNames.get(g.PartyId) || `عميل ${g.PartyId}`,
      Amount: money(g.Amount),
      InvoiceCount: g.Count,
      Pct: total > 0 ? round1((g.Amount / total) * 100) : 0,
      Invoices: cur.filter((s) => s.PartyId === g.PartyId)
        .sort((a, b) => new Date(b.Date) - new Date(a.Date)).slice(0, 300).map(invoiceItem),
    }));

  // أسباب الخسارة
  let lostReasons = [];
  const lostWithReason = scopeOpps.filter((o) => o.IsLost && o.LostReasonId != null);
  if (lostWithReason.length) {
    const reasonIds = [...new Set(lostWithReason.map((o) => o.LostReasonId))];
    const rows = await request(pool, [], `
      SELECT LostReasonID AS Id, ISNULL(ReasonNameAr, ReasonName) AS Name FROM LostReasons WHERE LostReasonID IN (${reasonIds.join(',')})`);
    const names = new Map(rows.map((r) => [Number(r.Id), r.Name || `سبب ${r.Id}`]));
    const counts = new Map();
    for (const o of lostWithReason) counts.set(o.LostReasonId, (counts.get(o.LostReasonId) || 0) + 1);
    lostReasons = [...counts.entries()]
      .map(([id, c]) => ({ Label: names.get(id) || `سبب ${id}`, Value: c }))
      .sort((a, b) => b.Value - a.Value);
  }

  const trend = buildTrend(cur, from, prev, prevFrom, days);
  const branchAgg = new Map();
  for (const s of cur) {
    const b = branchOf(s, ctx);
    if (b == null) continue;
    branchAgg.set(b, (branchAgg.get(b) || 0) + s.Net);
  }
  const branchesChart = [...branchAgg.entries()]
    .map(([b, v]) => ({ Label: ctx.branchNames.get(b) || `فرع ${b}`, Value: money(v) }))
    .sort((a, b) => b.Value - a.Value).slice(0, 10);
  const share = employees.filter((e) => e.SalesAmount > 0)
    .map((e) => ({ Label: e.Name, Value: e.SalesAmount }))
    .sort((a, b) => b.Value - a.Value).slice(0, 8);

  const insights = buildInsights({
    total, prevTotal,
    topBranch: branchesChart[0]?.Label || null,
    topBranchAmount: branchesChart[0]?.Value || 0,
    topEmployee: employees.find((e) => e.SalesAmount > 0) || null,
    topCustomer: topCustomers[0] || null,
    newCustomers, returningCustomers, teamLost,
    topLostReason: lostReasons[0]?.Label || null,
  });

  const growth = (curV, prevV) => (prevV > 0 ? round1(((curV - prevV) / prevV) * 100) : null);
  const dto = {
    DateFrom: dstr(from), DateTo: dstr(to), PrevFrom: dstr(prevFrom), PrevTo: dstr(prevTo),
    PeriodDays: days,
    ScopeFromDate: null,
    UserCanSeeAccountManagerInvoices: canSeeProtected,
    HiddenAccountManagerSales: !canSeeProtected && protectedCreators.length > 0,
    TotalAmount: total, PrevTotalAmount: prevTotal,
    InvoiceCount: count, PrevInvoiceCount: prevCount,
    AvgInvoice: count > 0 ? round2(total / count) : 0,
    PrevAvgInvoice: prevCount > 0 ? round2(prevTotal / prevCount) : 0,
    Customers: customers, PrevCustomers: prevCustomers,
    TeamOpportunities: teamOpps, TeamWonDeals: teamWon,
    TeamConversionRate: teamOpps > 0 ? round1((teamWon / teamOpps) * 100) : 0,
    PrevTeamOpportunities: prevTeamOpps, PrevTeamWonDeals: prevTeamWon,
    PrevTeamConversionRate: prevTeamOpps > 0 ? round1((prevTeamWon / prevTeamOpps) * 100) : 0,
    CollectionRate: round1(collectionRate),
    CollectedAmount: round2(Math.min(totalPaid, total)),
    OutstandingAmount: round2(outstanding),
    NewCustomers: newCustomers, ReturningCustomers: returningCustomers,
    TeamInProgress: Math.max(0, teamOpps - teamWon - teamLost),
    TeamLostOpportunities: teamLost,
    LostReasons: lostReasons,
    Employees: employees,
    TrendLabels: trend.labels, TrendCurrent: trend.current, TrendPrev: trend.prev,
    Branches: branchesChart, Share: share, PaymentMethods: paymentMethods,
    TopCustomers: topCustomers,
    Insights: insights,
  };
  dto.TotalGrowthPct = growth(dto.TotalAmount, dto.PrevTotalAmount);
  dto.CountGrowthPct = growth(dto.InvoiceCount, dto.PrevInvoiceCount);
  dto.AvgGrowthPct = growth(dto.AvgInvoice, dto.PrevAvgInvoice);
  dto.CustomersGrowthPct = growth(dto.Customers, dto.PrevCustomers);
  return dto;
}

async function withPool(fn) {
  const pool = await connectDB();
  return fn(pool);
}

module.exports = {
  parseFilter, getFilterData, getSalesAnalytics, withPool,
  _test: { buildTrend, buildEmployees, matches, branchOf, ownerOf, payMethodLabel },
};
