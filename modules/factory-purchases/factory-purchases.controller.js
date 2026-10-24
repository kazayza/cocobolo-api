const queries = require('./factory-purchases.queries');
const purchaseReceiptQueries = require('../purchase-receipts/purchase-receipts.queries');
const notifications = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse } = require('../../shared/response.helper');

function capabilities(auth) {
  return {
    canView: policy.factoryPurchases.canView(auth),
    canCreate: policy.factoryPurchases.canCreate(auth),
    canSeeAmounts: policy.factoryPurchases.canSeeAmounts(auth),
    canReceive: policy.factoryPurchases.canReceive(auth),
    canCancel: policy.factoryPurchases.canCancel(auth),
    canOpenInvoice: policy.factoryPurchases.canOpenInvoice(auth),
    canOpenJobOrder: policy.factoryPurchases.canOpenJobOrder(auth),
  };
}

function maskAmounts(row) {
  const copy = { ...row };
  for (const key of [
    'GrandTotal',
    'PaidAmount',
    'RemainingAmount',
    'TotalAmount',
    'TotalPaid',
    'TotalRemaining',
  ]) delete copy[key];
  return copy;
}

function scoped(row, auth) {
  return policy.factoryPurchases.canSeeAmounts(auth) ? row : maskAmounts(row);
}

async function notifyRoles(data, roles) {
  for (const role of roles) {
    try {
      await notifications.createNotificationSmart(data, role);
    } catch (error) {
      console.error(`factory purchase notification ${role}:`, error.message);
    }
  }
}

async function getAll(req, res) {
  try {
    const filters = {
      search: req.query.search,
      dateFrom: req.query.dateFrom,
      dateTo: req.query.dateTo,
      status: req.query.status,
      receipt: req.query.receipt,
      overdue: req.query.overdue,
      page: req.query.page,
      limit: req.query.limit,
    };
    const [list, stats] = await Promise.all([
      queries.getFactoryPurchases(filters),
      queries.getFactoryPurchaseStats(filters),
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
    console.error('factoryPurchases.getAll:', error);
    return errorResponse(
      res,
      error.message || 'فشل تحميل فواتير شراء المصنع',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function getLookups(req, res) {
  try {
    const data = await queries.getLookups();
    return res.json({
      success: true,
      data: { ...data, capabilities: capabilities(req.auth) },
    });
  } catch (error) {
    console.error('factoryPurchases.getLookups:', error);
    return errorResponse(res, error.message || 'فشل تحميل بيانات الفاتورة', error.statusCode || 500, error.code || error.message);
  }
}

async function searchCustomers(req, res) {
  try {
    const rows = await queries.searchLinkedCustomers(req.query.search || '');
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('factoryPurchases.searchCustomers:', error);
    return errorResponse(res, 'فشل البحث عن العملاء', error.statusCode || 500, error.message);
  }
}

async function searchProducts(req, res) {
  try {
    const rows = await queries.searchShowroomProducts({
      search: req.query.search,
      limit: req.query.limit,
    });
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('factoryPurchases.searchProducts:', error);
    return errorResponse(res, 'فشل البحث عن منتجات المعرض', error.statusCode || 500, error.message);
  }
}

async function getAlternatives(req, res) {
  try {
    const rows = await queries.getProductAlternatives(req.params.productId);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('factoryPurchases.getAlternatives:', error);
    return errorResponse(res, 'فشل تحميل بدائل المنتج', error.statusCode || 500, error.message);
  }
}

async function create(req, res) {
  try {
    const row = await queries.createFactoryPurchase(req.body || {}, req.auth);
    const jobOrderNotification = {
      title: 'أمر توريد مصنع جديد',
      message: `تم إنشاء فاتورة شراء ${row.referenceNumber} بعدد ${row.itemCount} صنف${row.dueDate ? ` وموعد استلام ${new Date(row.dueDate).toISOString().slice(0, 10)}` : ''}. برجاء بدء التصنيع والمتابعة.`,
      createdBy: req.auth.username,
      formName: 'factory/job-orders',
      relatedTable: 'Transactions',
      relatedId: row.transactionId,
    };
    await notifyRoles(jobOrderNotification, [
      'ProductionManager',
      'FactoryManager',
      'factory',
    ]);
    await notifyRoles({
      title: 'فاتورة شراء مصنع جديدة',
      message: `تم إنشاء ${row.referenceNumber} بقيمة ${row.grandTotal.toFixed(2)} بواسطة ${req.auth.username}. المخزون لن يتغير قبل تأكيد الاستلام.`,
      createdBy: req.auth.username,
      formName: 'factory/purchases',
      relatedTable: 'Transactions',
      relatedId: row.transactionId,
    }, ['Admin', 'AccountManager']);
    return res.status(201).json({
      success: true,
      message: `تم إنشاء فاتورة الشراء ${row.referenceNumber} وأمر التوريد. سيتم إدخال المخزون عند الاستلام الفعلي.`,
      data: row,
    });
  } catch (error) {
    console.error('factoryPurchases.create:', error);
    return errorResponse(
      res,
      error.message || 'فشل إنشاء فاتورة شراء المصنع',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function receive(req, res) {
  try {
    const row = await purchaseReceiptQueries.receivePurchase(
      req.params.id,
      req.body || {},
      req.auth,
    );
    await notifyRoles({
      title: 'تم استلام توريد المصنع',
      message: `تم استلام ${row.ReferenceNumber || `#${row.TransactionID}`} وإضافة ${row.ItemsCount} صنف إلى ${row.WarehouseName} بواسطة ${req.auth.username}.`,
      createdBy: req.auth.username,
      formName: 'purchase-receipt-status',
      relatedTable: 'Transactions',
      relatedId: row.TransactionID,
    }, ['Admin', 'AccountManager', 'ProductionManager', 'FactoryManager']);
    return res.json({
      success: true,
      message: 'تم استلام فاتورة المصنع وإضافة الأصناف إلى المخزون بنجاح',
      data: row,
    });
  } catch (error) {
    console.error('factoryPurchases.receive:', error);
    return errorResponse(
      res,
      error.message || 'فشل تأكيد استلام فاتورة المصنع',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

async function cancel(req, res) {
  try {
    const row = await queries.cancelFactoryPurchase(
      req.params.id,
      req.body?.reason,
      req.auth,
    );
    await notifyRoles({
      title: 'إلغاء فاتورة شراء مصنع',
      message: `تم إلغاء ${row.referenceNumber || `#${row.transactionId}`} بواسطة ${req.auth.username}${row.stockReversed ? ' وعكس المخزون المستلم.' : '.'}`,
      createdBy: req.auth.username,
      formName: 'factory/purchases',
      relatedTable: 'Transactions',
      relatedId: row.transactionId,
    }, ['Admin', 'AccountManager', 'ProductionManager', 'FactoryManager', 'factory']);
    return res.json({
      success: true,
      message: row.stockReversed
        ? 'تم إلغاء الفاتورة وعكس المخزون وإغلاق أمر التوريد'
        : 'تم إلغاء الفاتورة وإغلاق أمر التوريد',
      data: row,
    });
  } catch (error) {
    console.error('factoryPurchases.cancel:', error);
    return errorResponse(
      res,
      error.message || 'فشل إلغاء فاتورة شراء المصنع',
      error.statusCode || 500,
      error.code || error.message,
    );
  }
}

module.exports = {
  getAll,
  getLookups,
  searchCustomers,
  searchProducts,
  getAlternatives,
  create,
  receive,
  cancel,
};
