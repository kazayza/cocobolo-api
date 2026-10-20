const queries = require('./job-orders.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');
const { sql, connectDB } = require('../../core/database');

async function isProtected(row, auth) {
  if (!row || policy.jobOrders.canViewProtectedAccountManager(auth)) return false;
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar(100), row.CreatedBy)
    .query(`SELECT TOP 1 1 AS Protected FROM Users WHERE Username = @username AND Role = N'AccountManager'`);
  return result.recordset.length > 0;
}

function capabilities(auth) {
  return {
    canView: policy.jobOrders.canView(auth),
    canSeeAmounts: policy.jobOrders.canSeeAmounts(auth),
    canEditDueDate: policy.jobOrders.canEditDueDate(auth),
    canOpenInvoices: policy.jobOrders.canOpenInvoices(auth),
  };
}

async function getAll(req, res) {
  try {
    const filters = {
      search: req.query.search,
      delivery: req.query.delivery || 'undelivered',
      type: req.query.type || 'all',
      due: req.query.due || 'all',
      dueFrom: req.query.dueFrom,
      dueTo: req.query.dueTo,
      page: req.query.page,
      limit: req.query.limit,
    };
    const options = {
      excludeProtectedAccountManager:
        !policy.jobOrders.canViewProtectedAccountManager(req.auth),
    };
    const [list, stats, company] = await Promise.all([
      queries.getJobOrders(filters, options),
      queries.getJobOrderStats(filters, options),
      queries.getCompanyInfo(),
    ]);
    const canSeeAmounts = policy.jobOrders.canSeeAmounts(req.auth);
    const rows = list.rows.map((raw) => {
      const row = { ...raw };
      delete row.TotalRows;
      if (!canSeeAmounts) delete row.GrandTotal;
      return row;
    });
    return res.json({
      success: true,
      data: {
        rows,
        stats,
        company,
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
    console.error('jobOrders.getAll:', error);
    return errorResponse(res, 'فشل تحميل أوامر التشغيل', 500, error.message);
  }
}

async function getById(req, res) {
  try {
    const row = await queries.getJobOrderById(parseInt(req.params.id, 10));
    if (!row) return notFoundResponse(res, 'أمر التشغيل غير موجود');
    if (await isProtected(row, req.auth)) {
      return errorResponse(res, 'أمر التشغيل محمي حسب نطاق صلاحيات الحسابات', 403);
    }
    if (!policy.jobOrders.canSeeAmounts(req.auth)) delete row.GrandTotal;
    row.capabilities = capabilities(req.auth);
    return res.json({ success: true, data: row });
  } catch (error) {
    console.error('jobOrders.getById:', error);
    return errorResponse(res, 'فشل تحميل أمر التشغيل', 500, error.message);
  }
}

async function updateDueDate(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    const current = await queries.getJobOrderById(id);
    if (!current) return notFoundResponse(res, 'أمر التشغيل غير موجود');
    if (await isProtected(current, req.auth)) {
      return errorResponse(res, 'أمر التشغيل محمي حسب نطاق صلاحيات الحسابات', 403);
    }
    const previous = await queries.updateDueDate(
      id,
      req.body.dueDate,
      req.body.notes,
      req.auth.username,
    );
    const message = [
      `تم تعديل تاريخ التسليم المتوقع للفاتورة ${previous.ReferenceNumber || `#${id}`}`,
      `بواسطة ${req.auth.username}`,
      `من: ${previous.DueDate ? new Date(previous.DueDate).toISOString().slice(0, 10) : 'غير محدد'}`,
      `إلى: ${req.body.dueDate ? String(req.body.dueDate).slice(0, 10) : 'غير محدد'}`,
      req.body.notes ? `ملاحظات: ${req.body.notes}` : null,
    ].filter(Boolean).join('\n');
    const recipient = previous.EditBy;
    if (recipient && previous.EditStatus === 1) {
      await notificationsQueries.createNotification({
        title: 'تعديل تاريخ تسليم فاتورة',
        message,
        recipientUser: recipient,
        createdBy: req.auth.username,
        formName: 'sales/invoices',
        relatedTable: 'Transactions',
        relatedId: id,
      });
    } else {
      await notificationsQueries.createNotificationSmart({
        title: 'تعديل تاريخ تسليم فاتورة',
        message,
        createdBy: req.auth.username,
        formName: 'sales/invoices',
        relatedTable: 'Transactions',
        relatedId: id,
      }, 'Admin');
    }
    return res.json({ success: true, message: 'تم تعديل تاريخ التسليم وإرسال الإشعار' });
  } catch (error) {
    console.error('jobOrders.updateDueDate:', error);
    return errorResponse(res, error.message || 'فشل تعديل التاريخ', error.statusCode || 500, error.message);
  }
}

module.exports = {
  getAll,
  getById,
  updateDueDate,
};
