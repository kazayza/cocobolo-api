const PERIODS = new Set(['today', 'week', 'month', 'quarter', 'year']);

function cairoToday() {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Cairo',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day)));
}

function addDays(date, days) {
  const value = new Date(date);
  value.setUTCDate(value.getUTCDate() + days);
  return value;
}

function addMonths(date, months) {
  const source = new Date(date);
  const targetMonth = source.getUTCMonth() + months;
  const targetYear = source.getUTCFullYear() + Math.floor(targetMonth / 12);
  const normalizedMonth = ((targetMonth % 12) + 12) % 12;
  const maxDay = new Date(Date.UTC(targetYear, normalizedMonth + 1, 0)).getUTCDate();
  return new Date(Date.UTC(
    targetYear,
    normalizedMonth,
    Math.min(source.getUTCDate(), maxDay),
  ));
}

function addYears(date, years) {
  const source = new Date(date);
  const targetYear = source.getUTCFullYear() + years;
  const month = source.getUTCMonth();
  const maxDay = new Date(Date.UTC(targetYear, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(targetYear, month, Math.min(source.getUTCDate(), maxDay)));
}

function rangeOfPeriod(rawPeriod) {
  const period = PERIODS.has(String(rawPeriod || '').toLowerCase())
    ? String(rawPeriod).toLowerCase()
    : 'month';
  const today = cairoToday();
  let from;
  let to;
  if (period === 'today') {
    from = today;
    to = today;
  } else if (period === 'week') {
    // JavaScript: Sunday=0 ... Saturday=6. Week starts Saturday like Blazor.
    const daysSinceSaturday = (today.getUTCDay() - 6 + 7) % 7;
    from = addDays(today, -daysSinceSaturday);
    to = addDays(from, 6);
  } else if (period === 'quarter') {
    const quarterMonth = Math.floor(today.getUTCMonth() / 3) * 3;
    from = new Date(Date.UTC(today.getUTCFullYear(), quarterMonth, 1));
    to = addDays(addMonths(from, 3), -1);
  } else if (period === 'year') {
    from = new Date(Date.UTC(today.getUTCFullYear(), 0, 1));
    to = new Date(Date.UTC(today.getUTCFullYear(), 11, 31));
  } else {
    from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
    to = addDays(addMonths(from, 1), -1);
  }
  return { period, from, to, today };
}

function previousRange(from, to) {
  const days = Math.round((to - from) / 86400000) + 1;
  const previousTo = addDays(from, -1);
  return { from: addDays(previousTo, -(days - 1)), to: previousTo };
}

function periodLabel(period) {
  return {
    today: 'اليوم',
    week: 'هذا الأسبوع',
    month: 'هذا الشهر',
    quarter: 'ربع السنة',
    year: 'السنة',
  }[period] || 'هذا الشهر';
}

function money(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 100) / 100 : 0;
}

function percentage(current, comparison) {
  const cur = money(current);
  const cmp = money(comparison);
  if (!cmp) return 0;
  return Math.round(((cur - cmp) / Math.abs(cmp)) * 1000) / 10;
}

function intId(value, { optional = true, label = 'المعرّف' } = {}) {
  if ((value == null || value === '') && optional) return null;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0 || parsed > 2147483647) {
    throw Object.assign(new Error(`${label} غير صالح`), { statusCode: 400 });
  }
  return parsed;
}

module.exports = {
  PERIODS,
  cairoToday,
  addDays,
  addMonths,
  addYears,
  rangeOfPeriod,
  previousRange,
  periodLabel,
  money,
  percentage,
  intId,
};
