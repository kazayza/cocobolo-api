const queries = require('./purchase-receipts.queries');
const notifications = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');

function capabilities(auth) {
  return {
    canView: policy.purchaseReceipts.canView(auth),
    canSeeAmounts: policy.purchaseReceipts.canSeeAmounts(auth),
    canOpenInvoice: policy.purchaseReceipts.canOpenInvoice(auth),
    canConfirmReceipt: policy.purchaseReceipts.canConfirm(auth),
  };
}

function maskAmounts(row) {
  const result = { ...row };
  delete result.GrandTotal;
  delete result.PaidAmount;
  delete result.RemainingAmount;
  delete result.TotalGrandTotal;
  delete result.TotalPaidAmount;
  delete result.TotalRemaining;
  if (Array.isArray(result.items)) {
    result.items = result.items.map((raw) => {
      const item = { ...raw };
      delete item.UnitPrice;
      delete item.TotalAmount;
      return item;
    });
  }
  return result;
}

function scoped(row, auth) {
  return policy.purchaseReceipts.canSeeAmounts(auth) ? row : maskAmounts(row);
}

async function getAll(req, res) {
  try {
    const [list, stats] = await Promise.all([
      queries.getReceipts({
        search: req.query.search,
        status: req.query.status,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        dateFilterType: req.query.dateFilterType || 'DueDate',
        page: req.query.page,
        limit: req.query.limit,
      }),
      queries.getStats({
        search: req.query.search,
        dateFrom: req.query.dateFrom,
        dateTo: req.query.dateTo,
        dateFilterType: req.query.dateFilterType || 'DueDate',
      }),
    ]);
    const rows = list.rows.map((raw) => {
      const row = scoped(raw, req.auth);
      delete row.TotalRows;
      return row;
    });
    return res.json({
      success: true,
      data: {
        rows,
        stats: scoped(stats, req.auth),
        pagination: {
          page: list.page,
          limit: list.limit,
          total: list.total,
          totalPages: Math.max(Math.ceil(list.total / list.limit), 1),
          hasMore: list.page * list.limit < list.total,
        },
        capabilities: capabilities(req.auth),
      },
    });
  } catch (error) {
    console.error('purchaseReceipts.getAll:', error);
    return errorResponse(res, 'فشل تحميل استلامات الشراء', error.statusCode || 500, error.message);
  }
}

async function getById(req, res) {
  try {
    const row = await queries.getReceiptById(req.params.id);
    if (!row) return notFoundResponse(res, 'فاتورة الشراء غير موجودة');
    const data = scoped(row, req.auth);
    data.capabilities = capabilities(req.auth);
    return res.json({ success: true, data });
  } catch (error) {
    console.error('purchaseReceipts.getById:', error);
    return errorResponse(res, 'فشل تحميل تفاصيل الاستلام', error.statusCode || 500, error.message);
  }
}

async function confirmReceipt(req, res) {
  try {
    const row = await queries.receivePurchase(req.params.id, req.body || {}, req.auth);
    const notification = {
      title: 'تم استلام فاتورة شراء',
      message: `تم استلام ${row.ReferenceNumber || `#${row.TransactionID}`} من ${row.SupplierName} وإضافة ${row.ItemsCount} صنف إلى ${row.WarehouseName} بواسطة ${req.auth.username}`,
      createdBy: req.auth.username,
      formName: 'purchase-receipt-status',
      relatedTable: 'Transactions',
      relatedId: row.TransactionID,
    };
    for (const role of ['Admin', 'AccountManager', 'ProductionManager', 'FactoryManager']) {
      try {
        await notifications.createNotificationSmart(notification, role);
      } catch (error) {
        console.error(`purchase receipt notification ${role}:`, error.message);
      }
    }
    return res.json({
      success: true,
      message: 'تم استلام فاتورة الشراء وإضافة الأصناف إلى المخزون بنجاح',
      data: row,
    });
  } catch (error) {
    console.error('purchaseReceipts.confirmReceipt:', error);
    return errorResponse(res, error.message || 'فشل تأكيد الاستلام', error.statusCode || 500, error.message);
  }
}

module.exports = { getAll, getById, confirmReceipt };
