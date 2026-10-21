const queries = require('./delivery.queries');
const notifications = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');

function capabilities(auth) {
  return {
    canView: policy.delivery.canView(auth),
    canSeeAmounts: policy.delivery.canSeeAmounts(auth),
    canEditFull: policy.delivery.canEditFull(auth),
    canConfirmDelivery: policy.delivery.canConfirm(auth),
    canOverrideRemaining: policy.delivery.canOverrideRemaining(auth),
    canPrint: policy.delivery.canPrint(auth),
    canViewPurchaseReceipts: policy.purchaseReceipts.canView(auth),
  };
}

function maskAmounts(row) {
  const copy = { ...row };
  delete copy.GrandTotal;
  delete copy.PaidAmount;
  delete copy.RemainingAmount;
  delete copy.TotalGrandTotal;
  delete copy.TotalPaidAmount;
  delete copy.TotalRemaining;
  if (Array.isArray(copy.Products)) {
    copy.Products = copy.Products.map((item) => {
      const masked = { ...item };
      delete masked.UnitPrice;
      delete masked.TotalAmount;
      return masked;
    });
  }
  return copy;
}

function scoped(row, auth) {
  return policy.delivery.canSeeAmounts(auth) ? row : maskAmounts(row);
}

async function notifyRoles(data, roles) {
  for (const role of roles) {
    try {
      await notifications.createNotificationSmart(data, role);
    } catch (error) {
      console.error(`delivery notification ${role}:`, error.message);
    }
  }
}

async function getDeliveries(req, res) {
  try {
    const result = await queries.getDeliveries({
      status: req.query.status || 'all',
      search: req.query.search,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      dateFilterType: req.query.dateFilterType || 'due',
      debt: req.query.debt || 'all',
      page: req.query.page,
      limit: req.query.limit,
    });
    const rows = result.rows.map((raw) => {
      const row = scoped(raw, req.auth);
      delete row.TotalRows;
      return row;
    });
    return res.json({
      success: true,
      data: {
        rows,
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
    console.error('delivery.getDeliveries:', error);
    return errorResponse(res, 'فشل تحميل التسليمات', error.statusCode || 500, error.message);
  }
}

async function getDeliveryStats(req, res) {
  try {
    const stats = await queries.getDeliveryStats({
      search: req.query.search,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      dateFilterType: req.query.dateFilterType || 'due',
      debt: req.query.debt || 'all',
    });
    return res.json({
      success: true,
      data: {
        stats: scoped(stats, req.auth),
        capabilities: capabilities(req.auth),
      },
    });
  } catch (error) {
    console.error('delivery.getDeliveryStats:', error);
    return errorResponse(res, 'فشل تحميل إحصائيات التسليم', error.statusCode || 500, error.message);
  }
}

async function getDeliveryDetails(req, res) {
  try {
    const details = await queries.getDeliveryDetails(req.params.id);
    if (!details) return notFoundResponse(res, 'فاتورة التسليم غير موجودة');
    const data = scoped(details, req.auth);
    data.capabilities = capabilities(req.auth);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('delivery.getDeliveryDetails:', error);
    return errorResponse(res, 'فشل تحميل تفاصيل التسليم', error.statusCode || 500, error.message);
  }
}

async function getEmployees(req, res) {
  try {
    const rows = await queries.getDeliveryEmployees();
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('delivery.getEmployees:', error);
    return errorResponse(res, 'فشل تحميل مندوبي التسليم', 500, error.message);
  }
}

async function markAsDelivered(req, res) {
  try {
    const row = await queries.markAsDelivered(
      req.params.id,
      req.body || {},
      req.auth,
      { canOverrideRemaining: policy.delivery.canOverrideRemaining(req.auth) },
    );
    const message = `تم تأكيد تسليم الفاتورة ${row.ReferenceNumber || `#${row.TransactionID}`} للعميل ${row.PartyName} بواسطة ${req.auth.username}`;
    await notifyRoles({
      title: 'تم تأكيد التسليم',
      message,
      createdBy: req.auth.username,
      formName: 'sales-delivery-status',
      relatedTable: 'Transactions',
      relatedId: row.TransactionID,
    }, ['Admin', 'AccountManager', 'SalesManager']);
    return res.json({ success: true, message: 'تم تأكيد التسليم بنجاح', data: row });
  } catch (error) {
    console.error('delivery.markAsDelivered:', error);
    return errorResponse(
      res,
      error.message || 'فشل تأكيد التسليم',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function updateDeliveryDetails(req, res) {
  try {
    const row = await queries.updateDeliveryDetails(
      req.params.id,
      req.body || {},
      req.auth,
      { canOverrideRemaining: policy.delivery.canOverrideRemaining(req.auth) },
    );
    return res.json({ success: true, message: 'تم تحديث بيانات التسليم', data: row });
  } catch (error) {
    console.error('delivery.updateDeliveryDetails:', error);
    return errorResponse(res, error.message || 'فشل تحديث بيانات التسليم', error.statusCode || 500, error.message);
  }
}

async function requestPermission(req, res) {
  try {
    const row = await queries.requestDeliveryPermission(req.params.id, req.auth);
    const message = `الفاتورة ${row.ReferenceNumber || `#${row.TransactionID}`} للعميل ${row.PartyName} عليها مبلغ متبقٍ ${Number(row.RemainingAmount || 0).toFixed(2)}. طلب الإذن: ${req.auth.username}`;
    await notifyRoles({
      title: 'طلب إذن تسليم',
      message,
      createdBy: req.auth.username,
      formName: 'sales-delivery-status',
      relatedTable: 'Transactions',
      relatedId: row.TransactionID,
    }, ['Admin', 'AccountManager']);
    return res.json({ success: true, message: 'تم إرسال طلب إذن التسليم للإدارة والحسابات' });
  } catch (error) {
    console.error('delivery.requestPermission:', error);
    return errorResponse(res, error.message || 'فشل طلب إذن التسليم', error.statusCode || 500, error.message);
  }
}

async function grantPermission(req, res) {
  try {
    const row = await queries.grantDeliveryPermission(req.params.id, req.auth);
    if (row.RequestedBy && row.RequestedBy !== req.auth.username) {
      try {
        await notifications.createNotification({
          title: 'تم منح إذن التسليم',
          message: `تم منح إذن تسليم الفاتورة ${row.ReferenceNumber || `#${row.TransactionID}`} بواسطة ${req.auth.username}`,
          recipientUser: row.RequestedBy,
          createdBy: req.auth.username,
          formName: 'sales-delivery-status',
          relatedTable: 'Transactions',
          relatedId: row.TransactionID,
        });
      } catch (error) {
        console.error('delivery grant requester notification:', error.message);
      }
    }
    return res.json({ success: true, message: 'تم منح إذن التسليم وإشعار طالب الإذن' });
  } catch (error) {
    console.error('delivery.grantPermission:', error);
    return errorResponse(res, error.message || 'فشل منح إذن التسليم', error.statusCode || 500, error.message);
  }
}

async function getDailySheet(req, res) {
  try {
    const rows = await queries.getDailySheet({
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      search: req.query.search,
    });
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('delivery.getDailySheet:', error);
    return errorResponse(res, 'فشل تحميل كشف التسليمات', 500, error.message);
  }
}

async function getUpcomingDeliveries(req, res) {
  try {
    const rows = await queries.getUpcomingDeliveries();
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('delivery.getUpcomingDeliveries:', error);
    return errorResponse(res, 'فشل تحميل التسليمات القريبة', 500, error.message);
  }
}

module.exports = {
  getDeliveries,
  getDeliveryStats,
  getDeliveryDetails,
  getEmployees,
  markAsDelivered,
  updateDeliveryDetails,
  requestPermission,
  grantPermission,
  getDailySheet,
  getUpcomingDeliveries,
};
