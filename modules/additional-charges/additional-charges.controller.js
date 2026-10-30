const queries = require('./additional-charges.queries');
const notifications = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');

function capabilities(auth) {
  return {
    canView: policy.additionalCharges.canView(auth),
    canCreate: policy.additionalCharges.canCreate(auth),
    canEdit: policy.additionalCharges.canEdit(auth),
    canDelete: policy.additionalCharges.canDelete(auth),
    canApply: policy.additionalCharges.canApply(auth),
    canMarkNonRefundable: policy.additionalCharges.canMarkNonRefundable(auth),
    canSeeAmounts: policy.additionalCharges.canSeeAmounts(auth),
  };
}

async function notifyFinance(data) {
  for (const role of ['Admin', 'AccountManager', 'Account']) {
    try {
      await notifications.createNotificationSmart(data, role);
    } catch (error) {
      console.error(`additional charge notification ${role}:`, error.message);
    }
  }
}

function filters(req) {
  return {
    search: req.query.search,
    type: req.query.type,
    advanceLike: req.query.advanceLike,
    status: req.query.status,
    partyId: req.query.partyId,
    unappliedOnly: req.query.unappliedOnly,
    dateFrom: req.query.dateFrom,
    dateTo: req.query.dateTo,
    page: req.query.page,
    limit: req.query.limit,
  };
}

async function getAll(req, res) {
  try {
    const [list, stats] = await Promise.all([
      queries.getCharges(filters(req)),
      queries.getStats(filters(req)),
    ]);
    const rows = list.rows.map((raw) => {
      const row = { ...raw };
      delete row.TotalRows;
      return row;
    });
    return res.json({
      success: true,
      data: {
        rows,
        stats,
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
    console.error('additionalCharges.getAll:', error);
    return errorResponse(res, 'فشل تحميل الرسوم والدفعات المقدمة', error.statusCode || 500, error.message);
  }
}

async function getById(req, res) {
  try {
    const row = await queries.getCharge(req.params.id);
    if (!row) return notFoundResponse(res, 'الرسوم غير موجودة');
    return res.json({ success: true, data: { ...row, capabilities: capabilities(req.auth) } });
  } catch (error) {
    console.error('additionalCharges.getById:', error);
    return errorResponse(res, 'فشل تحميل بيانات الرسوم', error.statusCode || 500, error.message);
  }
}

async function getReceipt(req, res) {
  try {
    const row = await queries.getReceipt(req.params.id);
    if (!row) return notFoundResponse(res, 'إيصال الرسوم غير موجود');
    return res.json({ success: true, data: row });
  } catch (error) {
    console.error('additionalCharges.getReceipt:', error);
    return errorResponse(res, 'فشل تحميل الإيصال', error.statusCode || 500, error.message);
  }
}

async function getLookups(req, res) {
  try {
    const data = await queries.getLookups({
      search: req.query.search,
      partyId: req.query.partyId,
      invoiceSearch: req.query.invoiceSearch,
    });
    return res.json({ success: true, data });
  } catch (error) {
    console.error('additionalCharges.getLookups:', error);
    return errorResponse(res, 'فشل تحميل بيانات النموذج', error.statusCode || 500, error.message);
  }
}

async function create(req, res) {
  try {
    const row = await queries.createCharge(req.body || {}, req.auth);
    await notifyFinance({
      title: 'رسوم أو دفعة مقدمة جديدة',
      message: `تم تسجيل ${row.description} بقيمة ${row.amount.toFixed(2)} للعميل ${row.partyName} بواسطة ${req.auth.username}`,
      createdBy: req.auth.username,
      formName: 'additional-charges',
      relatedTable: 'AdditionalCharges',
      relatedId: row.chargeId,
    });
    return res.status(201).json({
      success: true,
      message: 'تم تسجيل الرسوم والتحصيل في الخزينة بنجاح',
      data: row,
    });
  } catch (error) {
    console.error('additionalCharges.create:', error);
    return errorResponse(res, error.message || 'فشل تسجيل الرسوم', error.statusCode || 500, error.message);
  }
}

async function update(req, res) {
  try {
    const row = await queries.updateCharge(req.params.id, req.body || {}, req.auth);
    return res.json({ success: true, message: 'تم تعديل الرسوم وتحديث حركة الخزينة', data: row });
  } catch (error) {
    console.error('additionalCharges.update:', error);
    return errorResponse(res, error.message || 'فشل تعديل الرسوم', error.statusCode || 500, error.message);
  }
}

async function remove(req, res) {
  try {
    const row = await queries.deleteCharge(req.params.id, req.auth);
    return res.json({ success: true, message: 'تم حذف الرسوم وإلغاء حركة الخزينة', data: row });
  } catch (error) {
    console.error('additionalCharges.remove:', error);
    return errorResponse(res, error.message || 'فشل حذف الرسوم', error.statusCode || 500, error.message);
  }
}

async function apply(req, res) {
  try {
    const row = await queries.applyToInvoice(
      req.params.id,
      req.body?.transactionId,
      req.auth,
    );
    await notifyFinance({
      title: 'تطبيق رسوم على فاتورة',
      message: `تم تطبيق رسوم #${row.chargeId} بقيمة ${row.amount.toFixed(2)} على الفاتورة ${row.referenceNumber || `#${row.transactionId}`} بواسطة ${req.auth.username}`,
      createdBy: req.auth.username,
      formName: 'additional-charges',
      relatedTable: 'AdditionalCharges',
      relatedId: row.chargeId,
    });
    return res.json({ success: true, message: 'تم تطبيق الرسوم على الفاتورة بنجاح', data: row });
  } catch (error) {
    console.error('additionalCharges.apply:', error);
    return errorResponse(res, error.message || 'فشل تطبيق الرسوم', error.statusCode || 500, error.message);
  }
}

async function markNonRefundable(req, res) {
  try {
    const row = await queries.markNonRefundable(
      req.params.id,
      req.body?.reason,
      req.auth,
    );
    return res.json({ success: true, message: 'تم تحديد الرسوم كغير مستردة', data: row });
  } catch (error) {
    console.error('additionalCharges.markNonRefundable:', error);
    return errorResponse(res, error.message || 'فشل تحديث حالة الرسوم', error.statusCode || 500, error.message);
  }
}

async function approveModification(req, res) {
  try {
    const row = await queries.approveModificationCharge(
      req.params.id, req.body?.amount, req.auth,
    );
    // إشعار مسجّل حدث التسليم (منشئ الرسم) إن اعتمد غيره — AdditionalChargeService.cs:501
    if (row.createdBy && String(row.createdBy).toLowerCase() !== String(req.auth.username).toLowerCase()) {
      try {
        await notifications.createNotification({
          title: '💰 اعتُمدت رسوم تعديل',
          message: `اعتُمدت رسوم التعديل على الفاتورة #${row.transactionId} بمبلغ ${row.amount.toFixed(2)} ج بواسطة ${req.auth.username} — يمكن تحصيلها الآن من قائمة الرسوم.`,
          recipientUser: row.createdBy,
          createdBy: req.auth.username,
          formName: 'additional-charges',
          relatedTable: 'AdditionalCharges',
          relatedId: row.chargeId,
        });
      } catch (notifyError) {
        console.error('modification approve notify:', notifyError.message);
      }
    }
    return res.json({ success: true, message: row.message, data: row });
  } catch (error) {
    console.error('additionalCharges.approveModification:', error);
    return errorResponse(res, error.message || 'فشل اعتماد رسوم التعديل', error.statusCode || 500, error.message);
  }
}

async function rejectModification(req, res) {
  try {
    const row = await queries.rejectModificationCharge(
      req.params.id, req.body?.reason, req.auth,
    );
    return res.json({ success: true, message: row.message, data: row });
  } catch (error) {
    console.error('additionalCharges.rejectModification:', error);
    return errorResponse(res, error.message || 'فشل رفض رسوم التعديل', error.statusCode || 500, error.message);
  }
}

async function collectModification(req, res) {
  try {
    const row = await queries.collectModificationCharge(
      req.params.id, req.body?.cashBoxId, req.auth,
    );
    return res.json({ success: true, message: row.message, data: row });
  } catch (error) {
    console.error('additionalCharges.collectModification:', error);
    return errorResponse(res, error.message || 'فشل تحصيل رسوم التعديل', error.statusCode || 500, error.message);
  }
}

module.exports = {
  approveModification,
  rejectModification,
  collectModification,
  getAll,
  getById,
  getReceipt,
  getLookups,
  create,
  update,
  remove,
  apply,
  markNonRefundable,
};
