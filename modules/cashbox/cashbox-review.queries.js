const { sql, connectDB } = require('../../core/database');

// ═══════════════════════════════════════════════════════════
// مراجعة الخزينة — منفذ من Blazor CashBoxReviewService.cs
// (cashbox-review.patch): أرقام فترة بالتعريف الموحد + تفصيل مصادر +
// مساعدات مراجعة + ختم خفيف بكشف التغيّر بعد المراجعة. لا قفل ولا منع
// تعديل في أي مكان. جدول الأختام CashBoxReviews يُنشأ بـ
// cashbox-review.sql؛ غيابه آمن في القراءات (RequiresSql) ويرد الختم
// برسالة بلازور الواضحة.
// ═══════════════════════════════════════════════════════════

const MOVEMENT_CAP = 2000;
const MISSING_TABLE_MESSAGE = 'جدول أختام مراجعة الخزينة غير مهيأ بعد — برجاء تشغيل سكربت cashbox-review.sql أولًا.';

function isMissingTableError(error) {
  return /Invalid object name .*CashBoxReviews/i.test(String(error?.message || ''));
}

function dateOnly(value, fallback) {
  const d = value ? new Date(value) : fallback;
  if (!d || Number.isNaN(d.getTime())) return fallback;
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

// الفترة بتاريخ فقط شاملة الطرفين — NormalizePeriod في بلازور
function normalizePeriod(from, to) {
  const today = dateOnly(new Date(), new Date());
  let f = dateOnly(from, today);
  let t = dateOnly(to, f);
  if (f > t) { const tmp = f; f = t; t = tmp; }
  return { from: f, to: t };
}

function money(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : 0;
}

// فئة مصدر الحركة — منقولة من CashBoxReviewService.GetSourceCategory
function getSourceCategory(referenceType) {
  if (!referenceType || !String(referenceType).trim()) return 'حركات يدوية';
  const raw = String(referenceType).trim();
  if (raw === 'ManualReceipt' || raw === 'ManualPayment' || raw === 'Manual') return 'حركات يدوية';
  if (/Cancel$/i.test(raw) && raw.toLowerCase() !== 'loancancel') return 'إلغاءات ومرتجعات القيود';
  switch (raw) {
    case 'SaleInvoice': case 'Invoice': case 'SaleInvoiceEdit': return 'تحصيل مبيعات';
    case 'Charge': return 'رسوم ومصروفات إضافية';
    case 'PurchaseInvoice': return 'مدفوعات مشتريات';
    case 'OpeningBalance': return 'رصيد افتتاحي';
    case 'Loan': case 'LoanCancel': case 'LoanIn': case 'LoanRepayment': return 'قروض';
    case 'TransferIn': case 'TransferOut': case 'WarehouseTransferIn': case 'WarehouseTransferOut': return 'تحويلات';
    case 'Expense': return 'مصروفات';
    case 'Payroll': case 'BonusSeparate': case 'CommissionSeparate': return 'رواتب ومستحقات';
    default: return `أخرى (${raw})`;
  }
}

async function computeFingerprint(request, cashBoxId, from, to) {
  const result = await request.query(`
    SELECT COUNT(*) AS TxCount,
      ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount ELSE 0 END), 0) AS TotalIn,
      ISNULL(SUM(CASE WHEN TransactionType = N'صرف' THEN Amount ELSE 0 END), 0) AS TotalOut,
      MAX(CreatedAt) AS LastTxCreatedAt
    FROM CashboxTransactions
    WHERE CashBoxID = @cashboxId
      AND CAST(TransactionDate AS DATE) >= @fromDate
      AND CAST(TransactionDate AS DATE) <= @toDate
  `);
  const row = result.recordset[0] || {};
  return {
    TxCount: Number(row.TxCount || 0),
    TotalIn: money(row.TotalIn),
    TotalOut: money(row.TotalOut),
    LastTxCreatedAt: row.LastTxCreatedAt || null,
  };
}

function sameInstant(a, b) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return new Date(a).getTime() === new Date(b).getTime();
}

function buildStampState(stamp, live) {
  if (!stamp) {
    return {
      Status: 'NotReviewed',
      StampId: null,
      LiveFingerprint: live,
      StoredFingerprint: null,
      CountDifference: 0,
      TotalInDifference: 0,
      TotalOutDifference: 0,
      LastTxCreatedAtChanged: false,
    };
  }
  const stored = {
    TxCount: Number(stamp.TxCount || 0),
    TotalIn: money(stamp.TotalIn),
    TotalOut: money(stamp.TotalOut),
    LastTxCreatedAt: stamp.LastTxCreatedAt || null,
  };
  const countDifference = live.TxCount - stored.TxCount;
  const totalInDifference = money(live.TotalIn - stored.TotalIn);
  const totalOutDifference = money(live.TotalOut - stored.TotalOut);
  const lastChanged = !sameInstant(live.LastTxCreatedAt, stored.LastTxCreatedAt);
  const unchanged = countDifference === 0 && totalInDifference === 0
    && totalOutDifference === 0 && !lastChanged;
  return {
    Status: unchanged ? 'Reviewed' : 'ChangedAfterReview',
    StampId: stamp.Id,
    ReviewedByUserName: stamp.ReviewedByUserName,
    ReviewedByName: stamp.ReviewedByName || null,
    ReviewedAt: stamp.ReviewedAt,
    Note: stamp.Note || null,
    StoredFingerprint: stored,
    LiveFingerprint: live,
    CountDifference: countDifference,
    TotalInDifference: totalInDifference,
    TotalOutDifference: totalOutDifference,
    LastTxCreatedAtChanged: lastChanged,
  };
}

async function tryGetLatestStamp(pool, cashBoxId, from, to) {
  try {
    const result = await pool.request()
      .input('cashboxId', sql.Int, cashBoxId)
      .input('fromDate', sql.Date, from)
      .input('toDate', sql.Date, to)
      .query(`
        SELECT TOP 1 * FROM CashBoxReviews
        WHERE CashBoxId = @cashboxId AND PeriodFrom = @fromDate AND PeriodTo = @toDate
        ORDER BY ReviewedAt DESC, Id DESC
      `);
    return { stamp: result.recordset[0] || null, missing: false };
  } catch (error) {
    if (isMissingTableError(error)) return { stamp: null, missing: true };
    throw error;
  }
}

function isManualMovement(m) {
  const raw = m.ReferenceType ? String(m.ReferenceType).trim() : '';
  return !raw || raw === 'ManualReceipt' || raw === 'ManualPayment' || raw === 'Manual';
}

function buildSourceBreakdown(movements) {
  const groups = new Map();
  for (const m of movements) {
    const raw = m.ReferenceType ? String(m.ReferenceType).trim() : '';
    const category = getSourceCategory(m.ReferenceType);
    const key = category.startsWith('أخرى (') ? `other:${raw}` : `cat:${category}`;
    if (!groups.has(key)) {
      groups.set(key, { Category: category, RawReferenceTypes: [], Count: 0, TotalIn: 0, TotalOut: 0 });
    }
    const row = groups.get(key);
    if (raw && !row.RawReferenceTypes.includes(raw)) row.RawReferenceTypes.push(raw);
    row.Count += 1;
    if (m.TransactionType === 'قبض') row.TotalIn = money(row.TotalIn + Number(m.Amount || 0));
    else if (m.TransactionType === 'صرف') row.TotalOut = money(row.TotalOut + Number(m.Amount || 0));
  }
  return [...groups.values()].sort((a, b) =>
    (b.TotalIn + b.TotalOut) - (a.TotalIn + a.TotalOut) || a.Category.localeCompare(b.Category));
}

function buildAids(movements, opening, isTruncated) {
  const aids = {
    ManualMovementIds: movements.filter(isManualMovement).map((m) => m.CashboxTransactionId),
    NoReferenceMovementIds: movements
      .filter((m) => (!m.ReferenceID || Number(m.ReferenceID) === 0)
        && !(m.ReferenceType && String(m.ReferenceType).trim())
        && !(m.SourceTitle && String(m.SourceTitle).trim()))
      .map((m) => m.CashboxTransactionId),
    BackdatedMovementIds: movements
      .filter((m) => m.CreatedAt && dateOnly(m.CreatedAt, null) > dateOnly(m.TransactionDate, null))
      .map((m) => m.CashboxTransactionId),
    LargestMovements: [...movements]
      .sort((a, b) => Number(b.Amount || 0) - Number(a.Amount || 0)
        || new Date(b.TransactionDate) - new Date(a.TransactionDate)
        || Number(b.CashboxTransactionId) - Number(a.CashboxTransactionId))
      .slice(0, 5),
    NegativeDays: [],
    NegativeDayMovementIds: [],
    NegativeDaysAvailable: !isTruncated,
  };
  // أيام الإغلاق السالب: رصيد جارٍ من أول المدة — فقط عند اكتمال المجموعة
  if (!isTruncated) {
    let running = opening;
    const byDay = new Map();
    for (const m of movements) {
      const key = dateOnly(m.TransactionDate, new Date(0)).getTime();
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key).push(m);
    }
    for (const key of [...byDay.keys()].sort((a, b) => a - b)) {
      const dayMovements = byDay.get(key);
      for (const m of dayMovements) {
        if (m.TransactionType === 'قبض') running += Number(m.Amount || 0);
        else if (m.TransactionType === 'صرف') running -= Number(m.Amount || 0);
      }
      running = money(running);
      if (running < 0) {
        aids.NegativeDays.push({ Date: new Date(key), ClosingBalance: running });
        aids.NegativeDayMovementIds.push(...dayMovements.map((m) => m.CashboxTransactionId));
      }
    }
  }
  return aids;
}

async function getReview(cashboxId, fromRaw, toRaw) {
  const parsedId = Number(cashboxId);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    throw Object.assign(new Error('معرّف الخزينة غير صالح'), { statusCode: 400 });
  }
  const { from, to } = normalizePeriod(fromRaw, toRaw);
  const pool = await connectDB();

  const boxResult = await pool.request()
    .input('cashboxId', sql.Int, parsedId)
    .query(`SELECT CashBoxID, CashBoxName, ISNULL(OpeningBalance, 0) AS OpeningBalance FROM CashBoxes WHERE CashBoxID = @cashboxId`);
  const box = boxResult.recordset[0];
  if (!box) throw Object.assign(new Error('الخزينة المختارة غير موجودة.'), { statusCode: 404 });

  // رصيد أول المدة: الافتتاحي المخزّن + صافي كل الحركات قبل بداية الفترة
  const beforeResult = await pool.request()
    .input('cashboxId', sql.Int, parsedId)
    .input('fromDate', sql.Date, from)
    .query(`
      SELECT ISNULL(SUM(CASE WHEN TransactionType = N'قبض' THEN Amount
                             WHEN TransactionType = N'صرف' THEN -Amount ELSE 0 END), 0) AS Net
      FROM CashboxTransactions
      WHERE CashBoxID = @cashboxId AND CAST(TransactionDate AS DATE) < @fromDate
    `);
  const opening = money(Number(box.OpeningBalance || 0) + Number(beforeResult.recordset[0]?.Net || 0));

  const fingerprintRequest = pool.request()
    .input('cashboxId', sql.Int, parsedId)
    .input('fromDate', sql.Date, from)
    .input('toDate', sql.Date, to);
  const live = await computeFingerprint(fingerprintRequest, parsedId, from, to);
  const isTruncated = live.TxCount > MOVEMENT_CAP;

  const movementsResult = await pool.request()
    .input('cashboxId', sql.Int, parsedId)
    .input('fromDate', sql.Date, from)
    .input('toDate', sql.Date, to)
    .query(`
      SELECT TOP ${MOVEMENT_CAP}
        CashboxTransactionID AS CashboxTransactionId, CashBoxID AS CashBoxId,
        TransactionDate, TransactionType, Amount, ReferenceType, ReferenceID,
        Notes, CreatedBy, CreatedAt, CAST(NULL AS NVARCHAR(200)) AS SourceTitle
      FROM CashboxTransactions
      WHERE CashBoxID = @cashboxId
        AND CAST(TransactionDate AS DATE) >= @fromDate
        AND CAST(TransactionDate AS DATE) <= @toDate
      ORDER BY TransactionDate ASC, CashboxTransactionID ASC
    `);
  const movements = movementsResult.recordset;

  const { stamp, missing } = await tryGetLatestStamp(pool, parsedId, from, to);

  return {
    CashBoxId: parsedId,
    CashBoxName: box.CashBoxName,
    PeriodFrom: from,
    PeriodTo: to,
    OpeningBalance: opening,
    TotalIn: live.TotalIn,
    TotalOut: live.TotalOut,
    ClosingBalance: money(opening + live.TotalIn - live.TotalOut),
    Movements: movements,
    TotalMovementCount: live.TxCount,
    IsTruncated: isTruncated,
    SourceBreakdown: buildSourceBreakdown(movements),
    Aids: buildAids(movements, opening, isTruncated),
    Stamp: buildStampState(stamp, live),
    RequiresSql: missing,
  };
}

async function stampReview(cashboxId, fromRaw, toRaw, note, auth) {
  const parsedId = Number(cashboxId);
  if (!Number.isInteger(parsedId) || parsedId <= 0) {
    throw Object.assign(new Error('معرّف الخزينة غير صالح'), { statusCode: 400 });
  }
  const cleanNote = note != null ? String(note).trim() : '';
  if (cleanNote.length > 1000) {
    throw Object.assign(new Error('ملاحظة المراجعة أطول من الحد المسموح (1000 حرف).'), { statusCode: 400 });
  }
  const { from, to } = normalizePeriod(fromRaw, toRaw);
  const pool = await connectDB();
  try {
    const boxResult = await pool.request()
      .input('cashboxId', sql.Int, parsedId)
      .query(`SELECT CashBoxID FROM CashBoxes WHERE CashBoxID = @cashboxId`);
    if (!boxResult.recordset[0]) {
      throw Object.assign(new Error('الخزينة المختارة غير موجودة.'), { statusCode: 404 });
    }
    const fingerprintRequest = pool.request()
      .input('cashboxId', sql.Int, parsedId)
      .input('fromDate', sql.Date, from)
      .input('toDate', sql.Date, to);
    const live = await computeFingerprint(fingerprintRequest, parsedId, from, to);
    const userResult = await pool.request()
      .input('username', sql.NVarChar(100), auth.username)
      .query(`SELECT FullName FROM Users WHERE Username = @username`);
    const displayName = userResult.recordset[0]?.FullName || null;
    // كل ختم صف تاريخي جديد — الأحدث لنفس (خزينة، فترة) هو الفعّال
    await pool.request()
      .input('cashboxId', sql.Int, parsedId)
      .input('fromDate', sql.Date, from)
      .input('toDate', sql.Date, to)
      .input('username', sql.NVarChar(256), auth.username)
      .input('displayName', sql.NVarChar(256), displayName)
      .input('note', sql.NVarChar(1000), cleanNote || null)
      .input('txCount', sql.Int, live.TxCount)
      .input('totalIn', sql.Decimal(18, 2), live.TotalIn)
      .input('totalOut', sql.Decimal(18, 2), live.TotalOut)
      .input('lastTxCreatedAt', sql.DateTime2, live.LastTxCreatedAt)
      .query(`
        INSERT INTO CashBoxReviews
          (CashBoxId, PeriodFrom, PeriodTo, ReviewedByUserName, ReviewedByName,
           Note, TxCount, TotalIn, TotalOut, LastTxCreatedAt)
        VALUES
          (@cashboxId, @fromDate, @toDate, @username, @displayName,
           @note, @txCount, @totalIn, @totalOut, @lastTxCreatedAt)
      `);
    return { message: 'تم حفظ ختم المراجعة.' };
  } catch (error) {
    if (isMissingTableError(error)) {
      throw Object.assign(new Error(MISSING_TABLE_MESSAGE), { statusCode: 400 });
    }
    throw error;
  }
}

async function getRecentStamps() {
  const pool = await connectDB();
  let all;
  try {
    const result = await pool.request().query(`
      SELECT r.*, c.CashBoxName
      FROM CashBoxReviews r
      LEFT JOIN CashBoxes c ON c.CashBoxID = r.CashBoxId
      ORDER BY r.ReviewedAt DESC, r.Id DESC
    `);
    all = result.recordset;
  } catch (error) {
    if (isMissingTableError(error)) return { Items: [], RequiresSql: true };
    throw error;
  }
  const seen = new Set();
  const latest = [];
  for (const row of all) {
    const key = `${row.CashBoxId}|${new Date(row.PeriodFrom).toDateString()}|${new Date(row.PeriodTo).toDateString()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    latest.push(row);
    if (latest.length >= 20) break;
  }
  const items = [];
  for (const stamp of latest) {
    const request = pool.request()
      .input('cashboxId', sql.Int, stamp.CashBoxId)
      .input('fromDate', sql.Date, stamp.PeriodFrom)
      .input('toDate', sql.Date, stamp.PeriodTo);
    const live = await computeFingerprint(request, stamp.CashBoxId, stamp.PeriodFrom, stamp.PeriodTo);
    const state = buildStampState(stamp, live);
    items.push({
      StampId: stamp.Id,
      CashBoxId: stamp.CashBoxId,
      CashBoxName: stamp.CashBoxName || '',
      PeriodFrom: stamp.PeriodFrom,
      PeriodTo: stamp.PeriodTo,
      ReviewedByUserName: stamp.ReviewedByUserName,
      ReviewedByName: stamp.ReviewedByName || null,
      ReviewedAt: stamp.ReviewedAt,
      Note: stamp.Note || null,
      Status: state.Status,
      CountDifference: state.CountDifference,
      TotalInDifference: state.TotalInDifference,
      TotalOutDifference: state.TotalOutDifference,
      LastTxCreatedAtChanged: state.LastTxCreatedAtChanged,
    });
  }
  return { Items: items, RequiresSql: false };
}

module.exports = {
  getReview,
  stampReview,
  getRecentStamps,
  getSourceCategory,
  MISSING_TABLE_MESSAGE,
};
