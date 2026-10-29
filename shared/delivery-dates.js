// ════════════════════════════════════════════════════════════════════
// إخفاء تاريخ الاستحقاق + حلّ جدولة بنود التسليم — مرآة بلازور:
//   • DeliveryPermissions.CanSeeRealDeliveryDate (Services/DeliveryPermissions.cs)
//   • SalesDeliveryStatusService.MaskValues / ShiftDueDateRange
//     (Services/SalesDeliveryStatusService.cs:56-99)
//   • DeliveryScheduleResolver (Services/DeliveryScheduleResolver.cs)
// القاعدة: المستثنون (مدير/مدير حسابات/مبيعات/مدير عام/مسئول تسليمات)
// يرون التاريخ الحقيقي، ومن عداهم يرونه منقوصًا هامش الأيام — عرض فقط،
// ولا يُكتب أي تاريخ مخفي في قاعدة البيانات أبدًا. تواريخ أحداث التسليم
// الفعلية حقائق منجزة لا تُخفى أبدًا فلا تمر من هنا.
// هامش الأيام: متغير البيئة DELIVERY_DATE_BUFFER_DAYS (مرآة مفتاح بلازور
// Delivery:DateBufferDays) والافتراضي 4 عند غيابه أو فساده.
// ════════════════════════════════════════════════════════════════════
const policy = require('./authorization.policy');

const DAY_MS = 86400000;

function dateBufferDays() {
  const parsed = Number.parseInt(process.env.DELIVERY_DATE_BUFFER_DAYS, 10);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : 4;
}

function canSeeRealDate(auth) {
  return policy.delivery.canSeeRealDate(auth);
}

// تاريخ فقط (منتصف ليل UTC) من أي قيمة تاريخ — بنفس اتفاق الكود القائم
// (toISOString().slice(0,10)) حتى لا تنحرف الحسابات عن باقي الوحدة.
function dateOnly(value) {
  if (value == null || value === '') return null;
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

function addDays(date, days) {
  if (!date) return null;
  return new Date(date.getTime() + days * DAY_MS);
}

function diffDays(from, to) {
  if (!from || !to) return null;
  return Math.round((dateOnly(from).getTime() - dateOnly(to).getTime()) / DAY_MS);
}

function todayOnly() {
  return dateOnly(new Date());
}

// DeliveryScheduleResolver.EffectiveDate: تاريخ البند الخاص إن كان مفصولًا
// وله تاريخ، وإلا تاريخ استحقاق الفاتورة.
function effectiveLineDate(lineDate, isCustom, invoiceDueDate) {
  if (isCustom && lineDate) return dateOnly(lineDate);
  return dateOnly(invoiceDueDate);
}

// DeliveryScheduleResolver.DisplayDate: المعروض للمستخدم — الحقيقي
// للمستثنين، ومن عداهم منقوص الهامش وبأرضية تاريخ الفاتورة.
function displayDate(effectiveDate, transactionDate, seesReal, buffer = dateBufferDays()) {
  const effective = dateOnly(effectiveDate);
  if (!effective) return null;
  if (seesReal) return effective;
  let shown = addDays(effective, -buffer);
  const floor = dateOnly(transactionDate);
  if (floor && shown < floor) shown = floor;
  return shown;
}

// SalesDeliveryStatusService.MaskValues على مفاتيح حالات الـ API:
// التاريخ المعروض + الأيام المتبقية منه + تحويل عائلة «جارى»
// (today/soon/upcoming) إلى overdue إن فات المعروض — المسَلَّمة والمرتجعة
// نتائج نهائية تحتفظ بحالتها كما في بلازور.
const PENDING_FAMILY = new Set(['today', 'soon', 'upcoming', 'pending']);
function maskDueValues({ dueDate, transactionDate, status }, seesReal, buffer = dateBufferDays()) {
  const real = dateOnly(dueDate);
  if (!real) return { dueDate: dueDate ?? null, daysRemaining: null, status };
  if (seesReal) {
    return { dueDate: real, daysRemaining: diffDays(real, todayOnly()), status };
  }
  const shown = displayDate(real, transactionDate, false, buffer);
  const days = diffDays(shown, todayOnly());
  let maskedStatus = status;
  if (PENDING_FAMILY.has(status) && shown < todayOnly()) maskedStatus = 'overdue';
  return { dueDate: shown, daysRemaining: days, status: maskedStatus };
}

// يخفي DueDate في صف قائمة/تفاصيل (ويعيد حساب DaysRemaining/DeliveryStatus
// إن وُجدا). لا يمس DeliveredAt أو أي تاريخ حدث فعلي.
function maskRowDueDate(row, auth) {
  if (!row || row.DueDate == null) return row;
  const masked = maskDueValues(
    { dueDate: row.DueDate, transactionDate: row.TransactionDate, status: row.DeliveryStatus },
    canSeeRealDate(auth),
  );
  row.DueDate = masked.dueDate;
  if ('DaysRemaining' in row) row.DaysRemaining = masked.daysRemaining;
  if ('DeliveryStatus' in row && row.DeliveryStatus != null) row.DeliveryStatus = masked.status;
  return row;
}

// SalesDeliveryStatusService.ShiftDueDateRange: فلاتر مدى الاستحقاق
// للمخفيين تُزاح +الهامش قبل الاستعلام فتطابق النتائج ما يرونه معروضًا.
function shiftDueRange(dateFrom, dateTo, auth) {
  if (canSeeRealDate(auth)) return { dateFrom, dateTo };
  const buffer = dateBufferDays();
  const shift = (value) => {
    const d = dateOnly(value);
    return d ? addDays(d, buffer).toISOString().slice(0, 10) : value;
  };
  return { dateFrom: shift(dateFrom), dateTo: shift(dateTo) };
}

// DeliveryScheduleResolver.Normalize قبل الكتابة: لا يُخزَّن تاريخ إلا مع
// الفصل اليدوي، والفصل بلا تاريخ يعود وارثًا.
function normalizeLineDate(lineDate, isCustom) {
  const d = dateOnly(lineDate);
  if (isCustom && d) return { date: d, isCustom: true };
  return { date: null, isCustom: false };
}

// DeliveryScheduleResolver.IsLineOverdue: الموعد المعروض فات وما زال مفتوحًا.
function isLineOverdue(display, remainingQty) {
  const shown = dateOnly(display);
  return Number(remainingQty || 0) > 0.0005 && shown != null && shown < todayOnly();
}

module.exports = {
  dateBufferDays,
  canSeeRealDate,
  dateOnly,
  addDays,
  diffDays,
  todayOnly,
  effectiveLineDate,
  displayDate,
  maskDueValues,
  maskRowDueDate,
  shiftDueRange,
  normalizeLineDate,
  isLineOverdue,
};
