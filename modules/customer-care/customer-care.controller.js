const queries = require('./customer-care.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse } = require('../../shared/response.helper');

function capabilities(auth) {
  return {
    canView: policy.customerCare.canView(auth),
    canLog: policy.customerCare.canLog(auth),
    canViewAll: policy.customerCare.canViewAll(auth),
    canExport: policy.customerCare.canExport(auth),
    canHide: policy.customerCare.canHide(auth),
  };
}

async function getDashboard(req, res) {
  try {
    const data = await queries.getDashboard({
      daysBack: req.query.daysBack,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      includeContacted: req.query.includeContacted,
    }, req.auth, {
      canViewAll: policy.customerCare.canViewAll(req.auth),
    });
    return res.json({
      success: true,
      data: { ...data, capabilities: capabilities(req.auth) },
    });
  } catch (error) {
    console.error('customerCare.getDashboard:', error);
    return errorResponse(
      res,
      error.message || 'فشل تحميل لوحة خدمة العملاء',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function logOutcome(req, res) {
  try {
    const data = await queries.logOutcome(req.body || {}, req.auth, {
      canViewAll: policy.customerCare.canViewAll(req.auth),
    });
    return res.json({
      success: true,
      message: data.status === 'Open'
        ? 'تم حفظ الفيدباك وجدولة المتابعة'
        : data.status === 'Skipped'
          ? 'تم إسقاط المتابعة مؤقتًا'
          : 'تم حفظ الفيدباك بنجاح',
      data,
    });
  } catch (error) {
    console.error('customerCare.logOutcome:', error);
    return errorResponse(
      res,
      error.message || 'فشل حفظ الفيدباك',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function getHistory(req, res) {
  try {
    const result = await queries.getHistory({
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      kind: req.query.kind,
      status: req.query.status,
      search: req.query.search,
      feedbackId: req.query.feedbackId,
      page: req.query.page,
      limit: req.query.limit,
    }, req.auth, {
      canViewAll: policy.customerCare.canViewAll(req.auth),
    });
    const rows = result.rows.map((raw) => {
      const row = { ...raw };
      delete row.TotalRows;
      return row;
    });
    return res.json({
      success: true,
      data: {
        rows,
        outcomeStats: result.outcomeStats,
        pagination: {
          page: result.page,
          limit: result.limit,
          total: result.total,
          totalPages: Math.max(Math.ceil(result.total / result.limit), 1),
          hasMore: result.page * result.limit < result.total,
        },
        capabilities: capabilities(req.auth),
      },
    });
  } catch (error) {
    console.error('customerCare.getHistory:', error);
    return errorResponse(
      res,
      error.message || 'فشل تحميل سجل خدمة العملاء',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function hideFeedback(req, res) {
  try {
    const data = await queries.hideFeedback(req.params.id, req.auth);
    return res.json({ success: true, message: 'تم إخفاء السجل', data });
  } catch (error) {
    console.error('customerCare.hideFeedback:', error);
    return errorResponse(res, error.message || 'فشل إخفاء السجل', error.statusCode || 500, error.message);
  }
}

async function exportRows(req, res) {
  try {
    const rows = await queries.getExportRows({
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      kind: req.query.kind,
      status: req.query.status,
      search: req.query.search,
    }, req.auth, {
      canViewAll: policy.customerCare.canViewAll(req.auth),
    });
    return res.json({
      success: true,
      data: {
        rows,
        generatedAt: new Date().toISOString(),
      },
    });
  } catch (error) {
    console.error('customerCare.exportRows:', error);
    return errorResponse(
      res,
      error.message || 'فشل تصدير سجل خدمة العملاء',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

module.exports = {
  getDashboard,
  logOutcome,
  getHistory,
  hideFeedback,
  exportRows,
};
