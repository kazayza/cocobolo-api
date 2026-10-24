const queries = require('./executive-cockpit.queries');
const policy = require('../../shared/authorization.policy');
const { PERIODS } = require('../../shared/reporting.utils');
const { errorResponse } = require('../../shared/response.helper');

function capabilities(auth) {
  return {
    canView: policy.reports.canViewExecutiveCockpit(auth),
    canExport: policy.reports.canExportExecutiveCockpit(auth),
    canViewEmployeeTimeline: policy.reports.canViewExecutiveCockpit(auth),
  };
}

async function getCockpit(req, res) {
  try {
    const requested = String(req.query.period || 'month').toLowerCase();
    if (!PERIODS.has(requested)) {
      return errorResponse(res, 'الفترة غير صالحة', 400, 'INVALID_REPORT_PERIOD');
    }
    const data = await queries.getCockpit(requested);
    return res.json({
      success: true,
      data: {
        ...data,
        Capabilities: capabilities(req.auth),
      },
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
      error.message || 'فشل تحميل الخط  الزمني للموظف',
      error.statusCode || 500,
      error.message,
    );
  }
}

module.exports = { getCockpit, getEmployeeTimeline };
