const queries = require('./executive-cockpit.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse } = require('../../shared/response.helper');

const VALID_PERIODS = new Set(['today', 'week', 'month', 'quarter', 'year', 'custom']);

function capabilities(auth) {
  return {
    canView: policy.reports.canViewExecutiveCockpit(auth),
    canExport: policy.reports.canExportExecutiveCockpit(auth),
    canViewEmployeeTimeline: policy.reports.canViewExecutiveCockpit(auth),
  };
}

function parseCockpitQuery(req) {
  const requested = String(req.query.period || 'month').toLowerCase();
  if (!VALID_PERIODS.has(requested)) {
    return { error: { message: 'الفترة غير صالحة', code: 'INVALID_REPORT_PERIOD' } };
  }
  const from = req.query.from || null;
  const to = req.query.to || null;
  if (requested === 'custom' && (!from || !to || Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to)))) {
    return { error: { message: 'الفترة المخصصة تتطلب تاريخي بداية ونهاية صالحين', code: 'INVALID_CUSTOM_PERIOD' } };
  }
  let branchId = null;
  if (req.query.branchId) {
    branchId = Number(req.query.branchId);
    if (!Number.isSafeInteger(branchId) || branchId <= 0) {
      return { error: { message: 'معرّف الفرع غير صالح', code: 'INVALID_BRANCH' } };
    }
  }
  return { period: requested, from, to, branchId };
}

async function getCockpit(req, res) {
  try {
    const parsed = parseCockpitQuery(req);
    if (parsed.error) return errorResponse(res, parsed.error.message, 400, parsed.error.code);
    const data = await queries.getCockpit(parsed);
    return res.json({
      success: true,
      data: { ...data, Capabilities: capabilities(req.auth) },
    });
  } catch (error) {
    console.error('executiveCockpit.getCockpit:', error);
    return errorResponse(
      res,
      error.message || 'فشل تحميل لوحة القيادة التنفيذية',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function getEmployeeTimeline(req, res) {
  try {
    const rows = await queries.getEmployeeTimeline(req.params.id);
    return res.json({ success: true, data: { rows } });
  } catch (error) {
    console.error('executiveCockpit.getEmployeeTimeline:', error);
    return errorResponse(
      res,
      error.message || 'فشل تحميل الخط الزمني للموظف',
      error.statusCode || 500,
      error.message,
    );
  }
}

async function listSnapshots(req, res) {
  try {
    const data = await queries.listSnapshots();
    return res.json({ success: true, data });
  } catch (error) {
    console.error('executiveCockpit.listSnapshots:', error);
    return errorResponse(res, 'فشل تحميل اللقطات المحفوظة', 500, error.message);
  }
}

async function getSnapshot(req, res) {
  try {
    const data = await queries.getSnapshot(req.params.id);
    if (!data) return errorResponse(res, 'اللقطة غير موجودة أو جدول اللقطات غير متاح', 404, 'SNAPSHOT_NOT_FOUND');
    return res.json({ success: true, data });
  } catch (error) {
    console.error('executiveCockpit.getSnapshot:', error);
    return errorResponse(res, 'فشل تحميل اللقطة', 500, error.message);
  }
}

async function saveSnapshot(req, res) {
  try {
    const parsed = parseCockpitQuery({ query: req.body || {} });
    if (parsed.error) return errorResponse(res, parsed.error.message, 400, parsed.error.code);
    const data = await queries.getCockpit(parsed);
    await queries.saveSnapshot(data, req.auth?.username || '');
    const list = await queries.listSnapshots();
    return res.status(201).json({ success: true, data: { saved: true, snapshots: list } });
  } catch (error) {
    console.error('executiveCockpit.saveSnapshot:', error);
    return errorResponse(
      res,
      error.message || 'فشل حفظ اللقطة',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

module.exports = { getCockpit, getEmployeeTimeline, listSnapshots, getSnapshot, saveSnapshot };
