const { sql, connectDB } = require('../../core/database');

// ═══════════════════════════════════════════════════════════
// مساعدات مشتركة — مرآة ExpenseService.cs في بلازور
// ═══════════════════════════════════════════════════════════

// تطبيع عربي حرفي من StringExtensions.NormalizeArabic (بلازور):
// أ/إ/آ ← ا، ة ← ه، ى ← ي، ئ/ؤ ← ء. تُطبَّق على نص البحث وعلى
// الحقول المبحوث فيها معًا (الاسم + الملاحظات + المستلم + مسار المجموعة).
function normalizeArabic(input) {
  if (input == null) return '';
  return String(input).replace(/[أإآ]/g, 'ا').replace(/ة/g, 'ه')
    .replace(/ى/g, 'ي').replace(/[ئؤ]/g, 'ء');
}

function round1(value) { return Math.round((Number(value) || 0) * 10) / 10; }
function round2(value) { return Math.round((Number(value) || 0) * 100) / 100; }

// مفتاح تاريخ 'YYYY-MM-DD' من قيمة تاريخ (نص أو Date) بلا انزياح منطقة زمنية
function dateKey(value) {
  if (value == null) return null;
  if (typeof value === 'string') {
    const m = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (m) return `${m[1]}-${m[2]}-${m[3]}`;
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return null;
    return dateKey(d);
  }
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return null;
    const p = (n) => String(n).padStart(2, '0');
    return `${value.getFullYear()}-${p(value.getMonth() + 1)}-${p(value.getDate())}`;
  }
  return dateKey(new Date(value));
}
function monthKeyOf(value) { const k = dateKey(value); return k ? k.slice(0, 7) : null; }
function monthKeyShift(monthKey, delta) {
  const [y, m] = monthKey.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
function monthLabel(monthKey, style) {
  const [y, m] = monthKey.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat('ar-EG', style === 'short'
      ? { month: 'short' } : { month: 'long', year: 'numeric' }).format(new Date(y, m - 1, 1));
  } catch (_) { return monthKey; }
}
function monthShortLabel(monthKey) {
  const [y, m] = monthKey.split('-').map(Number);
  try {
    return new Intl.DateTimeFormat('ar-EG', { month: 'short', year: 'numeric' }).format(new Date(y, m - 1, 1));
  } catch (_) { return monthKey; }
}

function isAdvanceHeader(row) {
  return Boolean(row.IsAdvance) && row.AdvanceParentExpenseId == null
    && Number(row.AdvanceMonthIndex) === 0;
}
// التعريف المعترف به (ExpenseService.cs:31-40): العادية + أشهر المقدم الفرعية فقط
function isRecognized(row) { return !row.IsAdvance || row.AdvanceParentExpenseId != null; }

// مسار المجموعة الكامل 'أب > ابن > حفيد' — مرآة BuildGroupPathFromDict (حد أمان 10)
function buildGroupPath(groupId, groupsById) {
  if (groupId == null || !groupsById.has(Number(groupId))) return null;
  const path = [];
  let current = Number(groupId);
  let safety = 10;
  while (current != null && safety-- > 0) {
    const g = groupsById.get(current);
    if (!g) break;
    path.unshift(g.ExpenseGroupName);
    current = g.ParentGroupID != null ? Number(g.ParentGroupID) : null;
  }
  return path.join(' > ');
}

// كل أحفاد مجموعة (GetExpenseGroupDescendantIdsAsync)
function descendantIds(parentId, groups) {
  const childrenOf = new Map();
  for (const g of groups) {
    if (g.ParentGroupID != null) {
      const key = Number(g.ParentGroupID);
      if (!childrenOf.has(key)) childrenOf.set(key, []);
      childrenOf.get(key).push(Number(g.ExpenseGroupID));
    }
  }
  const result = new Set();
  const stack = [Number(parentId)];
  while (stack.length) {
    const cur = stack.pop();
    for (const child of childrenOf.get(cur) || []) {
      if (!result.has(child)) { result.add(child); stack.push(child); }
    }
  }
  return result;
}

// عقد ExpenseFilterDto كاملًا من معاملات الاستعلام (مع أسماء إرثية مقبولة)
function parseFilter(q = {}) {
  const pick = (...keys) => {
    for (const k of keys) if (q[k] !== undefined && q[k] !== null && q[k] !== '') return q[k];
    return null;
  };
  const toInt = (v) => { const n = parseInt(v, 10); return Number.isNaN(n) ? null : n; };
  const toNum = (v) => { if (v == null) return null; const n = Number(v); return Number.isNaN(n) ? null : n; };
  const toBool = (v) => {
    if (v === undefined || v === null || v === '') return null;
    if (v === true || v === 'true' || v === '1') return true;
    if (v === false || v === 'false' || v === '0') return false;
    return null;
  };
  const pageRaw = toInt(pick('page', 'pageNumber'));
  const sizeRaw = toInt(pick('pageSize', 'limit'));
  const excludeRaw = pick('excludeAdvanceHeaders');
  return {
    searchText: pick('search', 'searchText'),
    branchId: toInt(pick('branchId', 'BranchId')),
    parentGroupId: toInt(pick('parentGroupId', 'ParentGroupId')),
    expenseGroupId: toInt(pick('groupId', 'expenseGroupId', 'ExpenseGroupId')),
    cashBoxId: toInt(pick('cashBoxId', 'CashBoxId')),
    dateFrom: pick('dateFrom', 'from', 'startDate'),
    dateTo: pick('dateTo', 'to', 'endDate'),
    amountFrom: toNum(pick('amountFrom', 'minAmount')),
    amountTo: toNum(pick('amountTo', 'maxAmount')),
    isAdvance: toBool(pick('isAdvance')),
    onlyParents: toBool(pick('onlyParents')) === true,
    // ExcludeAdvanceHeaders افتراضي true في بلازور (ExpenseDto.cs:60-65)
    excludeAdvanceHeaders: excludeRaw == null ? true : toBool(excludeRaw) !== false,
    page: Math.max(pageRaw || 1, 1),
    pageSize: Math.min(Math.max(sizeRaw || 25, 1), 10000),
    sortBy: pick('sortBy') || 'ExpenseDate',
    sortDescending: toBool(pick('sortDescending')) !== false,
  };
}

// تطبيق فلاتر بلازور (ApplyExpenseFiltersAsync) على صفوف محمّلة
function applyFilters(rows, groups, filter, { includeDate = true } = {}) {
  const groupsById = new Map(groups.map((g) => [Number(g.ExpenseGroupID), g]));
  let out = rows.slice();
  if (filter.branchId != null) out = out.filter((r) => Number(r.BranchId) === filter.branchId);
  if (filter.parentGroupId != null) {
    const allowed = descendantIds(filter.parentGroupId, groups);
    allowed.add(filter.parentGroupId);
    out = out.filter((r) => allowed.has(Number(r.ExpenseGroupID)));
  }
  if (filter.expenseGroupId != null) {
    out = out.filter((r) => Number(r.ExpenseGroupID) === filter.expenseGroupId);
  }
  if (filter.searchText && String(filter.searchText).trim() !== '') {
    const needle = normalizeArabic(String(filter.searchText).trim()).toLowerCase();
    out = out.filter((r) => {
      const path = buildGroupPath(r.ExpenseGroupID, groupsById) || '';
      return [r.ExpenseName, r.Notes, r.Torecipient, path]
        .some((v) => v != null && normalizeArabic(v).toLowerCase().includes(needle));
    });
  }
  if (filter.cashBoxId != null) out = out.filter((r) => Number(r.CashBoxID) === filter.cashBoxId);
  if (includeDate) {
    const fromKey = filter.dateFrom ? dateKey(filter.dateFrom) : null;
    const toKey = filter.dateTo ? dateKey(filter.dateTo) : null;
    if (fromKey) out = out.filter((r) => dateKey(r.ExpenseDate) >= fromKey);
    if (toKey) out = out.filter((r) => dateKey(r.ExpenseDate) <= toKey);
  }
  if (filter.amountFrom != null) out = out.filter((r) => Number(r.Amount) >= filter.amountFrom);
  if (filter.amountTo != null) out = out.filter((r) => Number(r.Amount) <= filter.amountTo);
  if (filter.isAdvance != null) out = out.filter((r) => Boolean(r.IsAdvance) === filter.isAdvance);
  if (filter.onlyParents) out = out.filter((r) => r.AdvanceParentExpenseId == null);
  else if (filter.excludeAdvanceHeaders) out = out.filter((r) => !isAdvanceHeader(r));
  return out;
}

function shapeListRow(row, groupsById) {
  const group = groupsById.get(Number(row.ExpenseGroupID));
  return {
    ExpenseID: row.ExpenseID,
    BranchId: row.BranchId != null ? Number(row.BranchId) : null,
    BranchName: row.BranchName ?? null,
    ExpenseName: row.ExpenseName,
    ExpenseDate: row.ExpenseDate,
    Amount: Number(row.Amount) || 0,
    IsAdvance: Boolean(row.IsAdvance),
    AdvanceMonths: row.AdvanceMonths != null ? Number(row.AdvanceMonths) : null,
    AdvanceParentExpenseId: row.AdvanceParentExpenseId != null ? Number(row.AdvanceParentExpenseId) : null,
    AdvanceMonthIndex: row.AdvanceMonthIndex != null ? Number(row.AdvanceMonthIndex) : null,
    Notes: row.Notes ?? null,
    Torecipient: row.Torecipient ?? null,
    ExpenseGroupID: Number(row.ExpenseGroupID),
    ExpenseGroupName: group ? group.ExpenseGroupName : (row.ExpenseGroupName ?? null),
    FullGroupPath: buildGroupPath(row.ExpenseGroupID, groupsById),
    CashBoxID: Number(row.CashBoxID),
    CashBoxName: row.CashBoxName ?? null,
    CreatedBy: row.CreatedBy ?? null,
    CreatedAt: row.CreatedAt ?? null,
  };
}

// تحميل كل المصروفات مزوّدة بأسماء المجموعة/الخزينة/الفرع (LEFT JOIN كما في بلازور)
async function fetchExpenseRows() {
  const pool = await connectDB();
  const result = await pool.request().query(`
    SELECT e.ExpenseID, e.BranchID AS BranchId, b.BranchNameAr AS BranchName,
      e.ExpenseName, e.ExpenseDate, e.Amount, e.IsAdvance, e.AdvanceMonths,
      e.AdvanceParentExpenseId, e.AdvanceMonthIndex, e.Notes, e.Torecipient,
      e.ExpenseGroupID, eg.ExpenseGroupName, e.CashBoxID, cb.CashBoxName,
      e.CreatedBy, e.CreatedAt
    FROM Expenses e
    LEFT JOIN ExpenseGroups eg ON e.ExpenseGroupID = eg.ExpenseGroupID
    LEFT JOIN CashBoxes cb ON e.CashBoxID = cb.CashBoxID
    LEFT JOIN Branches b ON e.BranchID = b.BranchID
  `);
  return result.recordset;
}

async function fetchGroupRows(requestFactory) {
  const make = requestFactory || (async () => (await connectDB()).request());
  const request = await make();
  const result = await request.query(
    'SELECT ExpenseGroupID, ExpenseGroupName, ParentGroupID, CreatedBy, CreatedAt FROM ExpenseGroups ORDER BY ExpenseGroupName');
  return result.recordset;
}

// سجل تدقيق — نفس نمط Audit_Log في وحدة الحضور (attendance.queries)
async function insertAudit(makeRequest, table, action, id, username, oldData, newData) {
  await makeRequest()
    .input('table', sql.NVarChar(128), table)
    .input('action', sql.NVarChar(100), action)
    .input('key', sql.NVarChar(200), String(id))
    .input('username', sql.NVarChar(100), username)
    .input('oldData', sql.NVarChar(sql.MAX), oldData == null ? null : JSON.stringify(oldData))
    .input('newData', sql.NVarChar(sql.MAX), newData == null ? null : JSON.stringify(newData))
    .query(`
      INSERT INTO [dbo].[Audit_Log]
        (TableName, ActionType, PrimaryKeyValue, OldData, NewData,
         ActionDate, LoginName, AppName, AccessUserName)
      VALUES
        (@table, @action, @key, @oldData, @newData,
         GETDATE(), @username, N'COCOBOLO Flutter', @username)
    `);
}

// جلب مجموعات المصروفات — العقد الكامل (ExpenseService.cs:885-935):
// عدد الأبناء + عدد المصروفات وإجماليها بالتعريف المعترف به + المنشئ والتاريخ
async function getExpenseGroups() {
  const [groups, rows] = await Promise.all([fetchGroupRows(), fetchExpenseRows()]);
  const totals = new Map();
  for (const r of rows) {
    if (!isRecognized(r)) continue;
    const key = Number(r.ExpenseGroupID);
    const t = totals.get(key) || { total: 0, count: 0 };
    t.total += Number(r.Amount) || 0; t.count += 1;
    totals.set(key, t);
  }
  const byId = new Map(groups.map((g) => [Number(g.ExpenseGroupID), g]));
  return groups.map((g) => {
    const t = totals.get(Number(g.ExpenseGroupID)) || { total: 0, count: 0 };
    return {
      ExpenseGroupID: Number(g.ExpenseGroupID),
      ExpenseGroupName: g.ExpenseGroupName,
      ParentGroupID: g.ParentGroupID != null ? Number(g.ParentGroupID) : null,
      ParentGroupName: g.ParentGroupID != null
        ? (byId.get(Number(g.ParentGroupID))?.ExpenseGroupName ?? null) : null,
      ChildrenCount: groups.filter((x) => Number(x.ParentGroupID) === Number(g.ExpenseGroupID)).length,
      ExpensesCount: t.count,
      TotalAmount: round2(t.total),
      CreatedBy: g.CreatedBy ?? null,
      CreatedAt: g.CreatedAt ?? null,
    };
  });
}

// جلب الخزائن — نشطة فقط، مع اسم الفرع والرصيد الحالي بالتعريف الموحّد
// (OpeningBalance + قبض − صرف) واللون والافتراضية (ExpenseForm.razor:511)
async function getCashboxes() {
  const pool = await connectDB();
  const result = await pool.request()
    .query(`
      SELECT c.CashBoxID, c.CashBoxName, c.Description,
        c.BranchID AS BranchId, b.BranchNameAr AS BranchName,
        c.Color, c.IsDefault, c.IsActive,
        ISNULL(c.OpeningBalance, 0) + ISNULL((
          SELECT SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                          WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END)
          FROM CashboxTransactions WHERE CashBoxID = c.CashBoxID
        ), 0) AS CurrentBalance
      FROM CashBoxes c
      LEFT JOIN Branches b ON c.BranchID = b.BranchID
      WHERE c.IsActive = 1
      ORDER BY c.IsDefault DESC, c.CashBoxName
    `);
  return result.recordset.map((r) => ({
    ...r,
    CurrentBalance: round2(r.CurrentBalance),
    IsDefault: Boolean(r.IsDefault),
    IsActive: Boolean(r.IsActive),
  }));
}

// إحصائيات القائمة — مرآة GetStatsAsync (ExpenseService.cs:326-386):
// نطاق الاختيار (كل الفلاتر عدا المدة) لكروت اليوم/الفترة/السنة/الإجمالي،
// وتفصيل المجموعات يتبع الفلتر الكامل مع المدة.
async function getExpensesSummary(filter = parseFilter({})) {
  const [rows, groups] = await Promise.all([fetchExpenseRows(), fetchGroupRows()]);
  const scope = applyFilters(rows, groups, filter, { includeDate: false });
  const full = applyFilters(rows, groups, filter, { includeDate: true });

  const todayKey = dateKey(new Date());
  const thisMonth = todayKey.slice(0, 7);
  const thisYear = todayKey.slice(0, 4);
  const prevMonth = monthKeyShift(thisMonth, -1);
  const hasDateRange = Boolean(filter.dateFrom || filter.dateTo);
  const fromKey = filter.dateFrom ? dateKey(filter.dateFrom) : null;
  const toKey = filter.dateTo ? dateKey(filter.dateTo) : null;

  const sumCount = (list) => ({
    amount: round2(list.reduce((s, r) => s + (Number(r.Amount) || 0), 0)),
    count: list.length,
  });
  const today = sumCount(scope.filter((r) => dateKey(r.ExpenseDate) === todayKey));
  const period = hasDateRange
    ? sumCount(scope.filter((r) => {
      const k = dateKey(r.ExpenseDate);
      return (!fromKey || k >= fromKey) && (!toKey || k <= toKey);
    }))
    : sumCount(scope.filter((r) => monthKeyOf(r.ExpenseDate) === thisMonth));
  const year = sumCount(scope.filter((r) => String(dateKey(r.ExpenseDate) || '').startsWith(thisYear)));
  const total = sumCount(scope);
  const prev = sumCount(scope.filter((r) => monthKeyOf(r.ExpenseDate) === prevMonth));

  const byGroup = new Map();
  for (const r of full) {
    const key = Number(r.ExpenseGroupID);
    const t = byGroup.get(key) || { total: 0, count: 0 };
    t.total += Number(r.Amount) || 0; t.count += 1;
    byGroup.set(key, t);
  }
  const groupsById = new Map(groups.map((g) => [Number(g.ExpenseGroupID), g]));
  const groupTotal = [...byGroup.values()].reduce((s, t) => s + t.total, 0);
  const pctBase = groupTotal === 0 ? 1 : groupTotal;
  const groupBreakdown = [...byGroup.entries()].map(([id, t]) => ({
    ExpenseGroupID: id,
    GroupName: groupsById.get(id)?.ExpenseGroupName ?? 'غير محدد',
    groupName: groupsById.get(id)?.ExpenseGroupName ?? 'غير محدد',
    Total: round2(t.total), total: round2(t.total),
    Count: t.count, count: t.count,
    Percentage: round1((t.total / pctBase) * 100),
    percentage: round1((t.total / pctBase) * 100),
  })).sort((a, b) => b.Total - a.Total);

  return {
    totalCount: total.count, totalAmount: total.amount,
    todayAmount: today.amount, todayCount: today.count,
    monthAmount: period.amount, monthCount: period.count,
    periodAmount: period.amount, periodCount: period.count,
    isPeriod: hasDateRange,
    yearAmount: year.amount, yearCount: year.count,
    prevMonthAmount: prev.amount, prevMonthCount: prev.count,
    groupBreakdown,
  };
}

// جلب المصروفات — عقد ExpenseFilterDto كاملًا مع الصفحات (GetExpensesAsync)
async function getAllExpenses(filterInput) {
  const filter = (filterInput && typeof filterInput === 'object' && !Array.isArray(filterInput)
    && ('page' in filterInput || 'searchText' in filterInput || 'expenseGroupId' in filterInput))
    ? { ...parseFilter({}), ...filterInput }
    : parseFilter({});
  // توافق إرثي مع التوقيع القديم (search, groupId, startDate, endDate)
  if (typeof filterInput === 'string') {
    filter.searchText = filterInput;
    filter.expenseGroupId = arguments[1] != null && arguments[1] !== '' ? Number(arguments[1]) : null;
    filter.dateFrom = arguments[2] || null;
    filter.dateTo = arguments[3] || null;
  }
  const [rows, groups] = await Promise.all([fetchExpenseRows(), fetchGroupRows()]);
  const groupsById = new Map(groups.map((g) => [Number(g.ExpenseGroupID), g]));
  const filtered = applyFilters(rows, groups, filter);
  const dir = filter.sortDescending ? -1 : 1;
  filtered.sort((a, b) => {
    if (filter.sortBy === 'Amount') {
      const d = (Number(a.Amount) || 0) - (Number(b.Amount) || 0);
      if (d !== 0) return d * dir;
    } else {
      const ka = dateKey(a.ExpenseDate) || ''; const kb = dateKey(b.ExpenseDate) || '';
      if (ka !== kb) return ka < kb ? -dir : dir;
    }
    return (Number(a.ExpenseID) - Number(b.ExpenseID)) * dir;
  });
  const totalCount = filtered.length;
  const start = (filter.page - 1) * filter.pageSize;
  const items = filtered.slice(start, start + filter.pageSize)
    .map((r) => shapeListRow(r, groupsById));
  return { items, totalCount, pageNumber: filter.page, pageSize: filter.pageSize };
}

// ═══════════════════════════════════════════════════════════
// حرّاس بلازور — ExpenseService.SaveExpenseAsync:581 بنفس الترتيب والرسائل
// ═══════════════════════════════════════════════════════════
function guardError(message, statusCode = 400) {
  return Object.assign(new Error(message), { statusCode });
}

function money2(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

async function getCashBoxBalanceInTx(transaction, cashBoxId) {
  // تعريف ExpenseService.GetCashBoxBalanceAsync:828 حرفيًا: قبض − صرف من
  // الحركات فقط — الرصيد الافتتاحي المخزّن مستبعَد عمدًا (مرآة مقصودة).
  const result = await transaction.request()
    .input('cashBoxId', sql.Int, cashBoxId)
    .query(`
      SELECT ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                             WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END), 0) AS Balance
      FROM CashboxTransactions WHERE CashBoxID = @cashBoxId
    `);
  return money2(result.recordset[0]?.Balance || 0);
}

async function assertBranchAndCashbox(transaction, branchId, cashBoxId) {
  if (branchId == null || !(Number(branchId) > 0)) throw guardError('الفرع مطلوب');
  const cashResult = await transaction.request()
    .input('cashBoxId', sql.Int, cashBoxId)
    .query(`SELECT CashBoxID, BranchID AS BranchId, IsActive FROM CashBoxes WHERE CashBoxID = @cashBoxId`);
  const cashbox = cashResult.recordset[0];
  if (!cashbox) throw guardError('الخزينة المحددة غير موجودة');
  if (!cashbox.IsActive) throw guardError('الخزينة المحددة غير نشطة');
  if (cashbox.BranchId == null) throw guardError('الخزينة المحددة غير مربوطة بفرع');
  if (Number(cashbox.BranchId) !== Number(branchId)) {
    throw guardError('لا يمكن اختيار خزينة من فرع مختلف عن فرع المصروف');
  }
  const branchResult = await transaction.request()
    .input('branchId', sql.Int, branchId)
    .query(`SELECT BranchID FROM Branches WHERE BranchID = @branchId AND ISNULL(IsActive, 0) = 1`);
  if (!branchResult.recordset[0]) throw guardError('الفرع المحدد غير موجود أو غير نشط');
}

// ====================== مصروف عادي ======================
async function createRegularExpense(expenseData, transaction) {
  await transaction.request()
    .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
    .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('branchId', sql.Int, expenseData.branchId)
    .input('amount', sql.Decimal(18, 2), expenseData.amount)
    .input('expenseDate', sql.DateTime, expenseData.expenseDate || new Date())
    .input('notes', sql.NVarChar(255), expenseData.notes || null)
    .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
    .input('isAdvance', sql.Bit, false)
    .input('advanceMonths', sql.Int, null)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO Expenses (
        ExpenseName, ExpenseGroupID, CashBoxID, BranchID, Amount, ExpenseDate,
        Notes, Torecipient, IsAdvance, AdvanceMonths,
        AdvanceParentExpenseId, AdvanceMonthIndex, CreatedBy, CreatedAt
      )
      VALUES (
        @expenseName, @expenseGroupId, @cashBoxId, @branchId, @amount, @expenseDate,
        @notes, @toRecipient, @isAdvance, @advanceMonths,
        NULL, NULL, @createdBy, GETDATE()
      );
    `);

  const idResult = await transaction.request()
    .query('SELECT SCOPE_IDENTITY() AS ExpenseID');
  const expenseId = idResult.recordset[0].ExpenseID;

  // حركة الخزينة بتاريخ المصروف نفسه (لا بتاريخ الإنشاء)
  await transaction.request()
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('referenceId', sql.Int, expenseId)
    .input('amount', sql.Decimal(18, 2), expenseData.amount)
    .input('expenseDate', sql.DateTime, expenseData.expenseDate || new Date())
    .input('notes', sql.NVarChar(sql.MAX), expenseData.notes || null)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO CashboxTransactions (
        CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
        Amount, TransactionDate, Notes, CreatedBy, CreatedAt
      )
      VALUES (
        @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
        @amount, @expenseDate, @notes, @createdBy, GETDATE()
      )
    `);

  return expenseId;
}

// ====================== مصروف مقدم ======================
// مرآة كتلة المقدم في SaveExpenseAsync: الأصل Amount=0 وAdvanceMonthIndex=0،
// والأشهر i=1..N بقسط مقرب لمنزلتين وآخر شهر يمتص فرق التقريب، وحركة خزينة
// واحدة على الأصل بنوع مرجع 'Expense'.
async function createAdvanceExpense(expenseData, transaction) {
  const months = Number(expenseData.advanceMonths);
  const total = money2(expenseData.amount);
  const baseDate = expenseData.expenseDate ? new Date(expenseData.expenseDate) : new Date();

  await transaction.request()
    .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
    .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('branchId', sql.Int, expenseData.branchId)
    .input('expenseDate', sql.DateTime, baseDate)
    .input('notes', sql.NVarChar(255), expenseData.notes || null)
    .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
    .input('advanceMonths', sql.Int, months)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO Expenses (
        ExpenseName, ExpenseGroupID, CashBoxID, BranchID, Amount, ExpenseDate,
        Notes, Torecipient, IsAdvance, AdvanceMonths,
        AdvanceParentExpenseId, AdvanceMonthIndex, CreatedBy, CreatedAt
      )
      VALUES (
        @expenseName, @expenseGroupId, @cashBoxId, @branchId, 0, @expenseDate,
        @notes, @toRecipient, 1, @advanceMonths,
        NULL, 0, @createdBy, GETDATE()
      );
    `);
  const parentResult = await transaction.request()
    .query('SELECT SCOPE_IDENTITY() AS ExpenseID');
  const parentId = parentResult.recordset[0].ExpenseID;

  const monthlyAmount = money2(total / months);
  const difference = money2(total - monthlyAmount * months);
  for (let i = 1; i <= months; i++) {
    const monthDate = new Date(baseDate);
    monthDate.setMonth(monthDate.getMonth() + (i - 1));
    const amount = i === months ? money2(monthlyAmount + difference) : monthlyAmount;
    await transaction.request()
      .input('expenseName', sql.NVarChar(100), `${expenseData.expenseName} - شهر ${i}/${months}`)
      .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('branchId', sql.Int, expenseData.branchId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, monthDate)
      .input('notes', sql.NVarChar(255), `الشهر رقم ${i} من المصروف المقدم`)
      .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
      .input('advanceMonths', sql.Int, months)
      .input('parentId', sql.Int, parentId)
      .input('monthIndex', sql.Int, i)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
      .query(`
        INSERT INTO Expenses (
          ExpenseName, ExpenseGroupID, CashBoxID, BranchID, Amount, ExpenseDate,
          Notes, Torecipient, IsAdvance, AdvanceMonths,
          AdvanceParentExpenseId, AdvanceMonthIndex, CreatedBy, CreatedAt
        )
        VALUES (
          @expenseName, @expenseGroupId, @cashBoxId, @branchId, @amount, @expenseDate,
          @notes, @toRecipient, 1, @advanceMonths,
          @parentId, @monthIndex, @createdBy, GETDATE()
        );
      `);
  }

  // خصم واحد من الخزينة على الأصل بالمبلغ الكلي وبتاريخ المصروف
  await transaction.request()
    .input('cashBoxId', sql.Int, expenseData.cashBoxId)
    .input('referenceId', sql.Int, parentId)
    .input('amount', sql.Decimal(18, 2), total)
    .input('expenseDate', sql.DateTime, baseDate)
    .input('notes', sql.NVarChar(sql.MAX), `مصروف مقدم: ${expenseData.expenseName} (${months} شهور)`)
    .input('createdBy', sql.NVarChar(50), expenseData.createdBy)
    .query(`
      INSERT INTO CashboxTransactions (
        CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
        Amount, TransactionDate, Notes, CreatedBy, CreatedAt
      )
      VALUES (
        @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
        @amount, @expenseDate, @notes, @createdBy, GETDATE()
      )
    `);

  return parentId;
}

// ====================== إضافة مصروف (الوظيفة الرئيسية) ======================
async function createExpense(expenseData) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const branchId = Number(expenseData.branchId ?? expenseData.BranchId) || null;
    const amount = money2(expenseData.amount);
    if (!String(expenseData.expenseName || '').trim()) throw guardError('اسم المصروف مطلوب');
    if (!(amount > 0)) throw guardError('المبلغ يجب أن يكون أكبر من صفر');
    if (!expenseData.cashBoxId) throw guardError('الخزينة مطلوبة');
    if (!expenseData.expenseGroupId) throw guardError('مجموعة المصروف مطلوبة');
    await assertBranchAndCashbox(transaction, branchId, expenseData.cashBoxId);

    const isAdvance = Boolean(expenseData.isAdvance);
    const months = Number(expenseData.advanceMonths) || 0;
    if (isAdvance) {
      if (months < 1) throw guardError('عدد الشهور يجب أن يكون على الأقل 1');
      if (months > 60) throw guardError('الحد الأقصى لعدد الشهور هو 60 شهر');
    }

    // حارس الرصيد عند الإنشاء: الرصيد (قبض − صرف) يغطي كامل المبلغ
    const balance = await getCashBoxBalanceInTx(transaction, expenseData.cashBoxId);
    if (balance < amount) {
      throw guardError(`رصيد الخزينة غير كافي. المتاح: ${balance.toFixed(2)}`);
    }

    const data = { ...expenseData, branchId, amount };
    // التقسيم فقط عندما تكون الشهور أكثر من شهر واحد
    const expenseId = isAdvance && months > 1
      ? await createAdvanceExpense(data, transaction)
      : await createRegularExpense(data, transaction);

    await insertAudit(() => transaction.request(), 'Expenses', 'Insert', expenseId,
      expenseData.createdBy, null, {
        ExpenseName: expenseData.expenseName, Amount: amount,
        ExpenseGroupID: expenseData.expenseGroupId, CashBoxID: expenseData.cashBoxId,
        BranchID: branchId, IsAdvance: isAdvance && months > 1, AdvanceMonths: months || null,
      });

    await transaction.commit();
    return expenseId;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ====================== تعديل مصروف ======================
async function updateExpense(id, expenseData) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const existingResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM Expenses WHERE ExpenseID = @id`);
    const existing = existingResult.recordset[0];
    if (!existing) throw guardError('المصروف غير موجود', 404);

    // منع تعديل عائلة المقدم — رسائل بلازور حرفيًا
    if (existing.AdvanceParentExpenseId != null) {
      throw guardError('هذا شهر فرعي من مصروف مقدم - لا يمكن تعديله. عدّل الأصل أو احذفه.');
    }
    if (existing.IsAdvance && Number(existing.AdvanceMonthIndex) === 0) {
      throw guardError('لا يمكن تعديل مصروف مقدم بعد الحفظ. احذفه وأنشئ واحد جديد.');
    }

    const branchId = Number(expenseData.branchId ?? expenseData.BranchId ?? existing.BranchId) || null;
    const amount = money2(expenseData.amount);
    if (!String(expenseData.expenseName || '').trim()) throw guardError('اسم المصروف مطلوب');
    if (!(amount > 0)) throw guardError('المبلغ يجب أن يكون أكبر من صفر');
    if (!expenseData.cashBoxId) throw guardError('الخزينة مطلوبة');
    if (!expenseData.expenseGroupId) throw guardError('مجموعة المصروف مطلوبة');
    await assertBranchAndCashbox(transaction, branchId, expenseData.cashBoxId);

    // حارس الرصيد عند التعديل: الزيادة فقط، أو كامل المبلغ عند تغيير الخزينة
    const oldAmount = money2(existing.Amount);
    const cashBoxChanged = Number(existing.CashBoxID) !== Number(expenseData.cashBoxId);
    const requiredAmount = cashBoxChanged ? amount : Math.max(amount - oldAmount, 0);
    if (requiredAmount > 0) {
      const balance = await getCashBoxBalanceInTx(transaction, expenseData.cashBoxId);
      if (balance < requiredAmount) {
        throw guardError(cashBoxChanged
          ? `رصيد الخزينة غير كافي. الخزينة الجديدة هتدفع المبلغ كامل (${requiredAmount.toFixed(2)}) والمتاح: ${balance.toFixed(2)}`
          : `رصيد الخزينة غير كافي. قيمة الزيادة المطلوبة: ${requiredAmount.toFixed(2)} والمتاح: ${balance.toFixed(2)}`);
      }
    }

    const expenseDate = expenseData.expenseDate ? new Date(expenseData.expenseDate) : existing.ExpenseDate;
    await transaction.request()
      .input('id', sql.Int, id)
      .input('expenseName', sql.NVarChar(100), expenseData.expenseName)
      .input('expenseGroupId', sql.Int, expenseData.expenseGroupId)
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('branchId', sql.Int, branchId)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, expenseDate)
      .input('notes', sql.NVarChar(255), expenseData.notes || null)
      .input('toRecipient', sql.NVarChar(100), expenseData.toRecipient || null)
      .query(`
        UPDATE Expenses SET
          ExpenseName = @expenseName, ExpenseGroupID = @expenseGroupId,
          CashBoxID = @cashBoxId, BranchID = @branchId,
          Amount = @amount, ExpenseDate = @expenseDate,
          Notes = @notes, Torecipient = @toRecipient,
          IsAdvance = 0, AdvanceMonths = NULL, AdvanceMonthIndex = NULL
        WHERE ExpenseID = @id
      `);

    // استبدال حركة الخزينة بالكامل بالمبلغ الجديد وبتاريخ المصروف
    await transaction.request()
      .input('referenceId', sql.Int, id)
      .query(`
        DELETE FROM CashboxTransactions
        WHERE ReferenceID = @referenceId AND ReferenceType IN ('Expense', 'AdvanceExpense')
      `);
    await transaction.request()
      .input('cashBoxId', sql.Int, expenseData.cashBoxId)
      .input('referenceId', sql.Int, id)
      .input('amount', sql.Decimal(18, 2), amount)
      .input('expenseDate', sql.DateTime, expenseDate)
      .input('notes', sql.NVarChar(sql.MAX), expenseData.notes || null)
      .input('createdBy', sql.NVarChar(50), expenseData.createdBy || existing.CreatedBy)
      .query(`
        INSERT INTO CashboxTransactions (
          CashBoxID, PaymentID, ReferenceID, ReferenceType, TransactionType,
          Amount, TransactionDate, Notes, CreatedBy, CreatedAt
        )
        VALUES (
          @cashBoxId, NULL, @referenceId, 'Expense', N'صرف',
          @amount, @expenseDate, @notes, @createdBy, GETDATE()
        )
      `);

    await insertAudit(() => transaction.request(), 'Expenses', 'Update', id,
      expenseData.createdBy || existing.CreatedBy, {
        ExpenseName: existing.ExpenseName, Amount: oldAmount,
        ExpenseGroupID: existing.ExpenseGroupID, CashBoxID: existing.CashBoxID,
        BranchID: existing.BranchID,
      }, {
        ExpenseName: expenseData.expenseName, Amount: amount,
        ExpenseGroupID: expenseData.expenseGroupId, CashBoxID: expenseData.cashBoxId,
        BranchID: branchId,
      });

    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// ====================== حذف مصروف ======================
// مرآة DeleteExpenseAsync:839 — حذف أي صف من العائلة يحذف الأصل وكل الأشهر
// وحركة خزينة الأصل.
async function deleteExpense(id, username = null) {
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();

    const existingResult = await transaction.request()
      .input('id', sql.Int, id)
      .query(`SELECT * FROM Expenses WHERE ExpenseID = @id`);
    const existing = existingResult.recordset[0];
    if (!existing) throw guardError('المصروف غير موجود', 404);
    const parentId = existing.AdvanceParentExpenseId ?? existing.ExpenseID;

    await transaction.request()
      .input('parentId', sql.Int, parentId)
      .query(`
        DELETE FROM CashboxTransactions
        WHERE ReferenceType = 'Expense' AND ReferenceID = @parentId
      `);
    // تنظيف إرثي: حركات 'AdvanceExpense' القديمة كانت تشير لأول شهر فرعي
    await transaction.request()
      .input('parentId', sql.Int, parentId)
      .query(`
        DELETE FROM CashboxTransactions
        WHERE ReferenceType = 'AdvanceExpense'
          AND ReferenceID IN (
            SELECT ExpenseID FROM Expenses
            WHERE ExpenseID = @parentId OR AdvanceParentExpenseId = @parentId
          )
      `);
    await transaction.request()
      .input('parentId', sql.Int, parentId)
      .query(`
        DELETE FROM Expenses
        WHERE ExpenseID = @parentId OR AdvanceParentExpenseId = @parentId
      `);

    await insertAudit(() => transaction.request(), 'Expenses', 'Delete', id,
      username || existing.CreatedBy, {
        ExpenseName: existing.ExpenseName, Amount: Number(existing.Amount) || 0,
        ExpenseGroupID: existing.ExpenseGroupID, CashBoxID: existing.CashBoxID,
        BranchID: existing.BranchID, AdvanceParentExpenseId: existing.AdvanceParentExpenseId,
      }, null);

    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// جلب مجموعات حسب الأب
async function getExpenseGroupsByParent(parentGroupName = null) {
  const pool = await connectDB();
  
  let query = `
    SELECT 
      G.ExpenseGroupID,
      G.ExpenseGroupName,
      PG.ExpenseGroupName AS ParentGroupName
    FROM 
      ExpenseGroups G
      LEFT JOIN ExpenseGroups PG ON G.ParentGroupID = PG.ExpenseGroupID
    WHERE 1=1
  `;
  
  const request = pool.request();
  
  if (parentGroupName && parentGroupName !== '' && parentGroupName !== 'الكل') {
    query += ` AND PG.ExpenseGroupName = @parentGroupName`;
    request.input('parentGroupName', sql.NVarChar, parentGroupName);
  }
  
  query += ` ORDER BY G.ExpenseGroupName`;
  
  const result = await request.query(query);
  return result.recordset;
}

// جلب مصروف واحد — مشكّل كـ DTO التعديل في بلازور (GetExpenseForEditAsync:
// حقول محدودة، وAdvanceMonths افتراضي 1 عند غيابه)
async function getExpenseById(id) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('id', sql.Int, id)
    .query(`
      SELECT * FROM Expenses WHERE ExpenseID = @id
    `);
  const e = result.recordset[0];
  if (!e) return null;
  return {
    ExpenseID: e.ExpenseID,
    BranchId: e.BranchID != null ? Number(e.BranchID) : null,
    ExpenseName: e.ExpenseName,
    ExpenseDate: e.ExpenseDate,
    ExpenseGroupID: e.ExpenseGroupID,
    CashBoxID: e.CashBoxID,
    Amount: Number(e.Amount) || 0,
    IsAdvance: Boolean(e.IsAdvance),
    AdvanceMonths: e.AdvanceMonths != null ? Number(e.AdvanceMonths) : 1,
    AdvanceParentExpenseId: e.AdvanceParentExpenseId ?? null,
    AdvanceMonthIndex: e.AdvanceMonthIndex ?? null,
    Notes: e.Notes ?? null,
    Torecipient: e.Torecipient ?? null,
    Recipient: e.Torecipient ?? null,
  };
}

// ═══════════════════════════════════════════════════════════
// 📊 داشبورد المصروفات — مرآة GetDashboardDataAsync حرفيًا
// (ExpenseService.cs:388-560) على المصروفات المعترف بها فقط.
// ═══════════════════════════════════════════════════════════
async function getExpenseDashboard(branchId = null) {
  const [rows, groups] = await Promise.all([fetchExpenseRows(), fetchGroupRows()]);
  const groupsById = new Map(groups.map((g) => [Number(g.ExpenseGroupID), g]));
  const inBranch = (r) => branchId == null || Number(r.BranchId) === Number(branchId);
  const recognized = rows.filter((r) => isRecognized(r) && inBranch(r));
  const headers = rows.filter((r) => isAdvanceHeader(r) && inBranch(r));

  const todayKey = dateKey(new Date());
  const curMonth = todayKey.slice(0, 7);
  const prevMonth = monthKeyShift(curMonth, -1);
  const yearStart = `${todayKey.slice(0, 4)}-01-01`;
  const sum = (list) => round2(list.reduce((s, r) => s + (Number(r.Amount) || 0), 0));
  const inMonth = (list, mk) => list.filter((r) => monthKeyOf(r.ExpenseDate) === mk);

  // 1) الشهر الحالي/السابق + النمو
  const currentMonthAmount = sum(inMonth(recognized, curMonth));
  const previousMonthAmount = sum(inMonth(recognized, prevMonth));
  let monthOverMonthGrowth = 0;
  if (previousMonthAmount > 0) {
    monthOverMonthGrowth = round1(((currentMonthAmount - previousMonthAmount) / previousMonthAmount) * 100);
  } else if (currentMonthAmount > 0) monthOverMonthGrowth = 100;

  // 2) المتوسط اليومي = مبلغ الشهر الحالي ÷ رقم اليوم الحالي من الشهر
  const dayOfMonth = Number(todayKey.slice(8, 10));
  const dailyAverage = dayOfMonth > 0 ? round2(currentMonthAmount / dayOfMonth) : 0;

  // 3) المقدمات النشطة: رؤوس AdvanceMonths>1 (عددها) + مجموع مبالغ كل
  //    أشهرها الفرعية (تعريف بلازور الحرفي في GetDashboardDataAsync)
  const activeHeaders = headers.filter((h) => Number(h.AdvanceMonths) > 1);
  const activeIds = new Set(activeHeaders.map((h) => Number(h.ExpenseID)));
  const activeAdvanceExpensesAmount = sum(rows.filter(
    (r) => r.AdvanceParentExpenseId != null && activeIds.has(Number(r.AdvanceParentExpenseId))));

  // 4) توزيع مجموعات السنة (منذ بداية السنة) — أعلى 10 مع النسب
  const yearRows = recognized.filter((r) => dateKey(r.ExpenseDate) >= yearStart);
  const groupAgg = new Map();
  for (const r of yearRows) {
    const key = Number(r.ExpenseGroupID);
    const t = groupAgg.get(key) || { total: 0, count: 0 };
    t.total += Number(r.Amount) || 0; t.count += 1;
    groupAgg.set(key, t);
  }
  const totalYear = [...groupAgg.values()].reduce((s, t) => s + t.total, 0);
  const pctBase = totalYear === 0 ? 1 : totalYear;
  const groupSorted = [...groupAgg.entries()]
    .map(([id, t]) => ({ id, total: t.total, count: t.count }))
    .sort((a, b) => b.total - a.total);
  const groupDistribution = groupSorted.slice(0, 10).map((x) => ({
    ExpenseGroupID: x.id,
    GroupName: groupsById.get(x.id)?.ExpenseGroupName ?? 'غير محدد',
    Total: round2(x.total), Count: x.count,
    Percentage: round1((x.total / pctBase) * 100),
  }));

  // 5) أعلى 5 مصروفات فردية في الشهر الحالي
  const topExpenses = inMonth(recognized, curMonth)
    .slice().sort((a, b) => (Number(b.Amount) || 0) - (Number(a.Amount) || 0))
    .slice(0, 5).map((r) => shapeListRow(r, groupsById));

  // 6) اتجاه 12 شهرًا (مصفّر الفجوات)
  const monthlyTrends = [];
  for (let i = 11; i >= 0; i--) {
    const mk = monthKeyShift(curMonth, -i);
    monthlyTrends.push({
      MonthDate: `${mk}-01`,
      MonthName: monthShortLabel(mk),
      TotalAmount: sum(inMonth(recognized, mk)),
    });
  }

  // 7) الاتجاه اليومي للشهر الحالي (كل أيام الشهر، مصفّرًا)
  const daysInMonth = new Date(Number(curMonth.slice(0, 4)), Number(curMonth.slice(5, 7)), 0).getDate();
  const dailyTrend = [];
  for (let d = 1; d <= daysInMonth; d++) {
    const dk = `${curMonth}-${String(d).padStart(2, '0')}`;
    dailyTrend.push({ Day: d, Amount: sum(recognized.filter((r) => dateKey(r.ExpenseDate) === dk)) });
  }

  // 8) التباين: الشهر الحالي مقابل متوسط الأشهر الثلاثة السابقة لكل مجموعة
  const prev3Months = [monthKeyShift(curMonth, -3), monthKeyShift(curMonth, -2), monthKeyShift(curMonth, -1)];
  const aggFor = (list) => {
    const m = new Map();
    for (const r of list) {
      const key = Number(r.ExpenseGroupID);
      m.set(key, (m.get(key) || 0) + (Number(r.Amount) || 0));
    }
    return m;
  };
  const curAgg = aggFor(inMonth(recognized, curMonth));
  const prevAgg = aggFor(recognized.filter((r) => prev3Months.includes(monthKeyOf(r.ExpenseDate))));
  const varianceAnalysis = [...new Set([...curAgg.keys(), ...prevAgg.keys()])].map((id) => {
    const current = curAgg.get(id) || 0;
    const prevAverage = (prevAgg.get(id) || 0) / 3;
    const variance = prevAverage > 0
      ? round1(((current - prevAverage) / prevAverage) * 100)
      : (current > 0 ? 100 : 0);
    return {
      GroupName: groupsById.get(id)?.ExpenseGroupName ?? 'غير محدد',
      CurrentMonth: round2(current),
      PreviousMonthsAverage: round2(prevAverage),
      VariancePercentage: variance,
    };
  }).sort((a, b) => Math.abs(b.VariancePercentage) - Math.abs(a.VariancePercentage));

  // 9) باريتو منذ بداية السنة (تراكمي من النسب المقرّبة كما في بلازور)
  let cumulative = 0;
  const paretoAnalysis = groupSorted.map((x) => {
    const pct = round1((x.total / pctBase) * 100);
    cumulative += pct;
    return {
      ItemName: groupsById.get(x.id)?.ExpenseGroupName ?? 'غير محدد',
      Amount: round2(x.total),
      Percentage: pct,
      CumulativePercentage: round1(cumulative),
    };
  });

  return {
    CurrentMonthAmount: currentMonthAmount,
    PreviousMonthAmount: previousMonthAmount,
    MonthOverMonthGrowth: monthOverMonthGrowth,
    DailyAverage: dailyAverage,
    ActiveAdvanceExpensesCount: activeHeaders.length,
    ActiveAdvanceExpensesAmount: activeAdvanceExpensesAmount,
    GroupDistribution: groupDistribution,
    TopExpenses: topExpenses,
    MonthlyTrends: monthlyTrends,
    DailyTrend: dailyTrend,
    VarianceAnalysis: varianceAnalysis,
    ParetoAnalysis: paretoAnalysis,
  };
}

// ═══════════════════════════════════════════════════════════
// التقرير الإجمالي الشهري — مرآة GetMonthlySummaryAsync:
// شهور متصلة مصفّرة الفجوات + تغيّر عن السابق + إجمالي عام + متوسط شهر.
// ═══════════════════════════════════════════════════════════
async function getMonthlySummary(filter = parseFilter({})) {
  const [rows, groups] = await Promise.all([fetchExpenseRows(), fetchGroupRows()]);
  const filtered = applyFilters(rows, groups, filter);
  const byMonth = new Map();
  for (const r of filtered) {
    const mk = monthKeyOf(r.ExpenseDate);
    if (!mk) continue;
    const t = byMonth.get(mk) || { count: 0, total: 0 };
    t.count += 1; t.total += Number(r.Amount) || 0;
    byMonth.set(mk, t);
  }
  const keys = [...byMonth.keys()].sort();
  let start = filter.dateFrom ? monthKeyOf(filter.dateFrom) : (keys[0] || monthKeyOf(new Date()));
  let end = filter.dateTo ? monthKeyOf(filter.dateTo) : (keys[keys.length - 1] || start);
  if (end < start) end = start;

  const months = [];
  for (let mk = start; mk <= end; mk = monthKeyShift(mk, 1)) {
    const t = byMonth.get(mk) || { count: 0, total: 0 };
    months.push({
      MonthDate: `${mk}-01`,
      MonthLabel: monthLabel(mk, 'long'),
      MonthShort: monthLabel(mk, 'short'),
      Count: t.count,
      Total: round2(t.total),
      HasPrevious: false, PreviousTotal: 0, ChangePercent: 0,
    });
  }
  let totalCount = 0; let grandTotal = 0;
  months.forEach((item, i) => {
    if (i > 0) {
      const prev = months[i - 1].Total;
      item.HasPrevious = true;
      item.PreviousTotal = prev;
      item.ChangePercent = prev > 0 ? round1(((item.Total - prev) / prev) * 100) : (item.Total > 0 ? 100 : 0);
    }
    totalCount += item.Count; grandTotal += item.Total;
  });
  grandTotal = round2(grandTotal);
  return {
    Months: months, months,
    TotalCount: totalCount, totalCount,
    GrandTotal: grandTotal, grandTotal,
    MonthlyAverage: months.length ? round2(grandTotal / months.length) : 0,
    monthlyAverage: months.length ? round2(grandTotal / months.length) : 0,
  };
}

// بيانات الطباعة — نفس عقد فلاتر بلازور، حد 10000 صف، وضع تفصيلي/إجمالي
async function getPrintData(filter = parseFilter({}), mode = 'detail') {
  if (mode === 'summary') {
    return { mode: 'summary', summary: await getMonthlySummary(filter) };
  }
  // عقد الطباعة في بلازور: PageSize = 10000 ثابتة بصرف النظر عن صفحات القائمة
  const capped = { ...filter, page: 1, pageSize: 10000 };
  const [rows, groups] = await Promise.all([fetchExpenseRows(), fetchGroupRows()]);
  const filtered = applyFilters(rows, groups, filter);
  const totalAmount = round2(filtered.reduce((s, r) => s + (Number(r.Amount) || 0), 0));
  const page = await getAllExpenses(capped);
  return { mode: 'detail', items: page.items, totalCount: page.totalCount, totalAmount };
}

// اقتراحات أسماء المصروفات — المصروفات الأصلية فقط (لا رؤوس مقدم ولا أشهر
// فرعية)، حتى 1000 اسم، مع مجموعة كل اسم للتعبئة التلقائية (ExpenseForm.razor:540-610)
async function getNameSuggestions() {
  const [rows, groups] = await Promise.all([fetchExpenseRows(), fetchGroupRows()]);
  const groupsById = new Map(groups.map((g) => [Number(g.ExpenseGroupID), g]));
  const originals = rows.filter((r) => r.AdvanceParentExpenseId == null && !isAdvanceHeader(r))
    .slice().sort((a, b) => String(dateKey(b.ExpenseDate)).localeCompare(String(dateKey(a.ExpenseDate))));
  const seen = new Map();
  for (const r of originals) {
    const name = (r.ExpenseName || '').trim();
    if (!name || seen.has(name)) continue;
    seen.set(name, {
      ExpenseName: name,
      ExpenseGroupID: Number(r.ExpenseGroupID),
      ExpenseGroupName: groupsById.get(Number(r.ExpenseGroupID))?.ExpenseGroupName ?? null,
      FullGroupPath: buildGroupPath(r.ExpenseGroupID, groupsById),
    });
    if (seen.size >= 1000) break;
  }
  return [...seen.values()];
}

// ═══════════════════════════════════════════════════════════
// مجموعات المصروفات — إنشاء/تعديل/حذف بحرّاس بلازور + تدقيق
// ═══════════════════════════════════════════════════════════
async function createExpenseGroup({ expenseGroupName, parentGroupId = null, createdBy = null }) {
  if (!expenseGroupName || !String(expenseGroupName).trim()) throw guardError('اسم المجموعة مطلوب');
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    if (parentGroupId != null) {
      const parent = await transaction.request()
        .input('parentId', sql.Int, parentGroupId)
        .query('SELECT ExpenseGroupID FROM ExpenseGroups WHERE ExpenseGroupID = @parentId');
      if (!parent.recordset[0]) throw guardError('المجموعة الأم المحددة غير موجودة');
    }
    const result = await transaction.request()
      .input('name', sql.NVarChar(200), String(expenseGroupName).trim())
      .input('parentId', sql.Int, parentGroupId)
      .input('createdBy', sql.NVarChar(50), createdBy)
      .query(`
        INSERT INTO ExpenseGroups (ExpenseGroupName, ParentGroupID, CreatedBy, CreatedAt)
        OUTPUT INSERTED.ExpenseGroupID
        VALUES (@name, @parentId, @createdBy, GETDATE())
      `);
    const id = result.recordset[0]?.ExpenseGroupID || null;
    await insertAudit(() => transaction.request(), 'ExpenseGroups', 'Insert', id, createdBy, null,
      { ExpenseGroupName: String(expenseGroupName).trim(), ParentGroupID: parentGroupId });
    await transaction.commit();
    return id;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

async function updateExpenseGroup(id, { expenseGroupName, parentGroupId = null }, username) {
  if (!expenseGroupName || !String(expenseGroupName).trim()) throw guardError('اسم المجموعة مطلوب');
  const groupId = Number(id);
  const pool = await connectDB();
  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    const existingRes = await transaction.request()
      .input('id', sql.Int, groupId)
      .query('SELECT ExpenseGroupID, ExpenseGroupName, ParentGroupID FROM ExpenseGroups WHERE ExpenseGroupID = @id');
    const existing = existingRes.recordset[0];
    if (!existing) throw guardError('المجموعة غير موجودة', 404);

    // حماية الدورات — رسائل SaveExpenseGroupAsync حرفيًا (974-1000)
    if (parentGroupId != null) {
      if (Number(parentGroupId) === groupId) throw guardError('لا يمكن جعل المجموعة أبًا لنفسها');
      const parent = await transaction.request()
        .input('parentId', sql.Int, parentGroupId)
        .query('SELECT ExpenseGroupID FROM ExpenseGroups WHERE ExpenseGroupID = @parentId');
      if (!parent.recordset[0]) throw guardError('المجموعة الأم المحددة غير موجودة');
      const allGroups = await fetchGroupRows(() => transaction.request());
      if (descendantIds(groupId, allGroups).has(Number(parentGroupId))) {
        throw guardError('لا يمكن جعل مجموعة فرعية من هذه المجموعة أبًا لها — هذا سينشئ دورة في الشجرة');
      }
    }

    await transaction.request()
      .input('id', sql.Int, groupId)
      .input('name', sql.NVarChar(200), String(expenseGroupName).trim())
      .input('parentId', sql.Int, parentGroupId)
      .query('UPDATE ExpenseGroups SET ExpenseGroupName = @name, ParentGroupID = @parentId WHERE ExpenseGroupID = @id');
    await insertAudit(() => transaction.request(), 'ExpenseGroups', 'Update', groupId, username,
      { ExpenseGroupName: existing.ExpenseGroupName, ParentGroupID: existing.ParentGroupID },
      { ExpenseGroupName: String(expenseGroupName).trim(), ParentGroupID: parentGroupId });
    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

async function deleteExpenseGroup(id, username) {
  const groupId = Number(id);
  const pool = await connectDB();
  // فحوص الرفض قبل أي كتابة: رفضٌ لا يكتب شيئًا (لا حذف ولا تدقيق)
  const groupRes = await pool.request()
    .input('id', sql.Int, groupId)
    .query('SELECT ExpenseGroupID, ExpenseGroupName, ParentGroupID FROM ExpenseGroups WHERE ExpenseGroupID = @id');
  const group = groupRes.recordset[0];
  if (!group) throw guardError('المجموعة غير موجودة', 404);
  const expRes = await pool.request()
    .input('id', sql.Int, groupId)
    .query('SELECT COUNT(*) AS C FROM Expenses WHERE ExpenseGroupID = @id');
  if (Number(expRes.recordset[0]?.C || 0) > 0) throw guardError('لا يمكن حذف مجموعة بها مصروفات');
  const childRes = await pool.request()
    .input('id', sql.Int, groupId)
    .query('SELECT COUNT(*) AS C FROM ExpenseGroups WHERE ParentGroupID = @id');
  if (Number(childRes.recordset[0]?.C || 0) > 0) throw guardError('لا يمكن حذف مجموعة بها مجموعات فرعية');

  const transaction = new sql.Transaction(pool);
  try {
    await transaction.begin();
    await transaction.request()
      .input('id', sql.Int, groupId)
      .query('DELETE FROM ExpenseGroups WHERE ExpenseGroupID = @id');
    await insertAudit(() => transaction.request(), 'ExpenseGroups', 'Delete', groupId, username, group, null);
    await transaction.commit();
    return true;
  } catch (err) {
    try { await transaction.rollback(); } catch (_) {}
    throw err;
  }
}

// تصدير الدوال
module.exports = {
  getExpenseGroups,
  getCashboxes,
  getExpensesSummary,
  getExpenseDashboard,
  getAllExpenses,
  createExpense,
  updateExpense,
  deleteExpense,
  getExpenseGroupsByParent,
  createExpenseGroup,
  updateExpenseGroup,
  deleteExpenseGroup,
  getExpenseById,
  getMonthlySummary,
  getPrintData,
  getNameSuggestions,
  parseFilter,
  normalizeArabic,
  applyFilters,
  isAdvanceHeader,
  isRecognized,
};