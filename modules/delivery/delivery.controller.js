const queries = require('./delivery.queries');
const notifications = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');
const dates = require('../../shared/delivery-dates');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');

function capabilities(auth) {
  return {
    canView: policy.delivery.canView(auth),
    canSeeAmounts: policy.delivery.canSeeAmounts(auth),
    canSeeRealDate: policy.delivery.canSeeRealDate(auth),
    canEditFull: policy.delivery.canEditFull(auth),
    canConfirmDelivery: policy.delivery.canConfirm(auth),
    canRecordDelivery: policy.delivery.canConfirm(auth),
    canVoidDelivery: policy.delivery.canOverrideRemaining(auth),
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
  // رسوم التعديل المولودة من أحداث التسليم مبالغ أيضًا — تُحجب بنفس القاعدة
  if (Array.isArray(copy.Charges)) {
    copy.Charges = copy.Charges.map((charge) => {
      const masked = { ...charge };
      delete masked.ChargeAmount;
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
    const dateFilterType = req.query.dateFilterType || 'due';
    // فلاتر مدى الاستحقاق للمخفيين تُزاح +الهامش قبل الاستعلام (بلازور:
    // ShiftDueDateRange) فتطابق النتائج التواريخ المعروضة لهم
    const range = dateFilterType === 'due'
      ? dates.shiftDueRange(req.query.dateFrom, req.query.dateTo, req.auth)
      : { dateFrom: req.query.dateFrom, dateTo: req.query.dateTo };
    const result = await queries.getDeliveries({
      status: req.query.status || 'all',
      search: req.query.search,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      dateFilterType,
      debt: req.query.debt || 'all',
      page: req.query.page,
      limit: req.query.limit,
    }, req.auth);
    const rows = result.rows.map((raw) => {
      const row = scoped(raw, req.auth);
      delete row.TotalRows;
      // إخفاء تاريخ الاستحقاق المتفق عليه لغير المستثنين — عرض فقط
      dates.maskRowDueDate(row, req.auth);
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
    const dateFilterType = req.query.dateFilterType || 'due';
    const range = dateFilterType === 'due'
      ? dates.shiftDueRange(req.query.dateFrom, req.query.dateTo, req.auth)
      : { dateFrom: req.query.dateFrom, dateTo: req.query.dateTo };
    const stats = await queries.getDeliveryStats({
      search: req.query.search,
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      dateFilterType,
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
    const details = await queries.getDeliveryDetails(req.params.id, req.auth);
    if (!details) return notFoundResponse(res, 'فاتورة التسليم غير موجودة');
    const data = scoped(details, req.auth);
    // تاريخ الاستحقاق يُخفى لغير المستثنين؛ تواريخ الأحداث الفعلية لا تُمس
    dates.maskRowDueDate(data, req.auth);
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
    }, ['Admin', 'AccountManager', 'SalesManager', 'ProductionManager']);
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
    const range = dates.shiftDueRange(req.query.dateFrom, req.query.dateTo, req.auth);
    const rows = await queries.getDailySheet({
      dateFrom: range.dateFrom,
      dateTo: range.dateTo,
      search: req.query.search,
    });
    // الكشف بتواريخ الاستحقاق — تُعرض مخفية لغير المستثنين كالقائمة
    const masked = rows.map((row) => dates.maskRowDueDate({ ...row }, req.auth));
    return res.json({ success: true, data: masked });
  } catch (error) {
    console.error('delivery.getDailySheet:', error);
    return errorResponse(res, 'فشل تحميل كشف التسليمات', 500, error.message);
  }
}

async function getUpcomingDeliveries(req, res) {
  try {
    const rows = await queries.getUpcomingDeliveries(req.auth, req.query.days);
    return res.json({ success: true, data: rows });
  } catch (error) {
    console.error('delivery.getUpcomingDeliveries:', error);
    return errorResponse(res, 'فشل تحميل التسليمات القريبة', 500, error.message);
  }
}

// ── أحداث التسليم (التسليم على دفعات) ──────────────────────────────

async function getEvents(req, res) {
  try {
    const data = await queries.getDeliveryEvents(req.params.id);
    if (!policy.delivery.canSeeAmounts(req.auth)) {
      data.Charges = data.Charges.map((charge) => {
        const masked = { ...charge };
        delete masked.ChargeAmount;
        return masked;
      });
    }
    return res.json({ success: true, data });
  } catch (error) {
    console.error('delivery.getEvents:', error);
    return errorResponse(res, 'فشل تحميل أحداث التسليم', error.statusCode || 500, error.message);
  }
}

async function getCoverage(req, res) {
  try {
    const data = await queries.getBatchCoverage(
      req.params.id,
      (req.body || {}).items || [],
      req.auth,
    );
    return res.json({ success: true, data });
  } catch (error) {
    console.error('delivery.getCoverage:', error);
    return errorResponse(res, error.message || 'فشل حساب تغطية الدفعة', error.statusCode || 500, error.code || error.message);
  }
}

async function recordEvent(req, res) {
  try {
    const row = await queries.recordDeliveryEvent(req.params.id, req.body || {}, req.auth);
    if (!row.alreadyRecorded) {
      const reference = row.ReferenceNumber || `#${row.TransactionID}`;
      await notifyRoles({
        title: row.CompletedInvoice ? '✅ اكتمل تسليم الفاتورة' : '🚚 تسليمة جزئية',
        message: row.CompletedInvoice
          ? `اكتمل تسليم الفاتورة ${reference} للعميل ${row.PartyName} بالكامل بواسطة ${req.auth.username}`
          : `سُجلت دفعة تسليم للفاتورة ${reference} للعميل ${row.PartyName} بواسطة ${req.auth.username} — المتبقي ${row.OpenQty} من ${row.TotalInvoicedQty}`,
        createdBy: req.auth.username,
        formName: 'sales-delivery-status',
        relatedTable: 'Transactions',
        relatedId: row.TransactionID,
      }, ['Admin', 'AccountManager', 'SalesManager', 'ProductionManager']);
      if (row.courierUsername && row.courierUsername !== req.auth.username) {
        try {
          await notifications.createNotification({
            title: row.CompletedInvoice ? '✅ اكتمل تسليم فاتورة سلمتها' : '🚚 سجلت دفعة تسليم',
            message: `الفاتورة ${reference} للعميل ${row.PartyName}`,
            recipientUser: row.courierUsername,
            createdBy: req.auth.username,
            formName: 'sales-delivery-status',
            relatedTable: 'Transactions',
            relatedId: row.TransactionID,
          });
        } catch (error) {
          console.error('delivery courier notification:', error.message);
        }
      }
      if (Number(row.TotalReturnedQty || 0) > 0) {
        await notifyRoles({
          title: '↩️ مرتجعات من تسليم',
          message: `وصلت مرتجعات بكمية ${row.TotalReturnedQty} من تسليم الفاتورة ${reference} للعميل ${row.PartyName} — بانتظار فحص الجودة/الصيانة`,
          createdBy: req.auth.username,
          formName: 'sales-delivery-status',
          relatedTable: 'Transactions',
          relatedId: row.TransactionID,
        }, ['ProductionManager', 'FactoryManager']);
      }
    }
    return res.json({ success: true, message: row.message, data: row });
  } catch (error) {
    console.error('delivery.recordEvent:', error);
    return errorResponse(res, error.message || 'فشل تسجيل التسليمة', error.statusCode || 500, error.code || error.message);
  }
}

async function voidEvent(req, res) {
  try {
    const row = await queries.voidDeliveryEvent(
      req.params.id,
      req.params.deliveryId,
      req.body || {},
      req.auth,
    );
    await notifyRoles({
      title: '↩️ أُلغيت تسليمة',
      message: `أُلغيت تسليمة من الفاتورة #${row.TransactionID} بواسطة ${req.auth.username} — السبب: ${(req.body || {}).reason || ''}`,
      createdBy: req.auth.username,
      formName: 'sales-delivery-status',
      relatedTable: 'Transactions',
      relatedId: row.TransactionID,
    }, ['Admin', 'AccountManager']);
    return res.json({ success: true, message: row.message, data: row });
  } catch (error) {
    console.error('delivery.voidEvent:', error);
    return errorResponse(res, error.message || 'فشل إلغاء التسليمة', error.statusCode || 500, error.code || error.message);
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
  getEvents,
  getCoverage,
  recordEvent,
  voidEvent,
};
