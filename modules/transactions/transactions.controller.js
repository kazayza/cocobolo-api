const transactionsQueries = require('./transactions.queries');
const fullEditQueries = require('./invoice-full-edit.queries');
const invoicePolicy = require('../../shared/authorization.policy').invoices;
const deliveryDates = require('../../shared/delivery-dates');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

function sendOperationResult(res, result) {
  if (!result?.ok) {
    return errorResponse(res, result?.message || 'فشل تنفيذ الطلب', result?.status || 400);
  }
  return res.status(result.status || 200).json({
    success: true,
    message: result.message || 'تم التنفيذ بنجاح',
    data: result.data ?? null,
  });
}

// جلب كل الفواتير
async function getAll(req, res) {
  try {
    const {
      type, startDate, endDate, partyId,
      search, status, hasRemaining, overdue, page, limit,
      dateFrom, dateTo, // أسماء بديلة (الشاشة بتبعت دي)
    } = req.query;

    // توحيد الأسماء: لو جات dateFrom/dateTo نستخدمهم
    const effStart = startDate || dateFrom;
    const effEnd = endDate || dateTo;

    const invoiceType = type || 'Sale';
    const canView = invoiceType === 'Purchase'
      ? invoicePolicy.canViewPurchases(req.auth)
      : invoicePolicy.canViewSales(req.auth);
    if (!canView) return errorResponse(res, 'ليس لديك صلاحية عرض هذه الفواتير', 403);

    const security = {
      excludeProtectedAccountManagerSales:
        !invoicePolicy.canSeeProtectedAccountManagerInvoices(req.auth),
      includeProfit: invoiceType === 'Sale' && invoicePolicy.canViewProfit(req.auth),
    };

    const remainingFilter = hasRemaining === 'true' || hasRemaining === true
      ? true
      : hasRemaining === 'false' || hasRemaining === false
        ? false
        : null;

    const transactions = await transactionsQueries.getAllTransactions({
      type: invoiceType, startDate: effStart, endDate: effEnd, partyId,
      search, status, hasRemaining: remainingFilter, overdue,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
      ...security,
    });

    // تاريخ الاستحقاق المتفق عليه لفواتير البيع يُعرض مخفيًا لغير
    // المستثنين (قاعدة بلازور) — عرض فقط ولا يُكتب في القاعدة أبدًا.
    // أسطح نموذج التعديل (getById/full) ليست هنا عمدًا: محرروها يرون
    // الحقيقي، وإخفاؤها سيُحفظ مخفيًا عند الحفظ ويفسد البيانات.
    for (const row of transactions) {
      if (row.TransactionType === 'Sale') deliveryDates.maskRowDueDate(row, req.auth);
    }

    const stats = await transactionsQueries.getInvoicesStats({
      type: invoiceType, startDate: effStart, endDate: effEnd,
      search, status, hasRemaining: remainingFilter, overdue,
      ...security,
    });

    return res.json({
      data: transactions,
      stats,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
    });
  } catch (err) {
    console.error('خطأ في جلب الفواتير:', err);
    return errorResponse(res, 'فشل تحميل الفواتير', 500, err.message);
  }
}

// جلب فاتورة بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const model = await fullEditQueries.getEditModel(parseInt(id, 10), req.auth);
    if (!model.ok) return sendOperationResult(res, model);
    const payments = await transactionsQueries.getPayments(id);
    return res.json({
      ...model.data.header,
      details: model.data.details,
      charges: model.data.charges,
      payments,
      mirror: model.data.mirror,
      profit: model.data.profit,
      capabilities: model.data.capabilities,
    });
  } catch (err) {
    console.error('خطأ في جلب الفاتورة:', err);
    return errorResponse(res, 'فشل تحميل الفاتورة', 500, err.message);
  }
}

// ملخص الفواتير
async function getSummary(req, res) {
  try {
    const type = req.query.type || 'Sale';
    const canView = type === 'Purchase'
      ? invoicePolicy.canViewPurchases(req.auth)
      : invoicePolicy.canViewSales(req.auth);
    if (!canView) return errorResponse(res, 'ليس لديك صلاحية عرض الملخص', 403);
    const stats = await transactionsQueries.getInvoicesStats({
      type,
      excludeProtectedAccountManagerSales:
        !invoicePolicy.canSeeProtectedAccountManagerInvoices(req.auth),
    });
    const summary = {
      totalCount: stats.TotalCount,
      totalAmount: stats.TotalSales,
      totalPaid: stats.TotalPaid,
      totalRemaining: stats.TotalRemaining,
    };
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// إنشاء فاتورة
async function create(req, res) {
  try {
    const { partyId, transactionType, warehouseId } = req.body;

    if (!partyId || !transactionType || !warehouseId) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }
    const canCreate = transactionType === 'Purchase'
      ? invoicePolicy.canCreatePurchase(req.auth)
      : invoicePolicy.canCreateSales(req.auth);
    if (!canCreate) return errorResponse(res, 'ليس لديك صلاحية إنشاء هذه الفاتورة', 403);

    const transactionId = await transactionsQueries.createTransaction({
      ...req.body,
      createdBy: req.auth.username,
    });

    return res.json({
      success: true,
      transactionId: transactionId,
      message: 'تم إنشاء الفاتورة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء الفاتورة:', err);
    const status = err.statusCode || 500;
    return errorResponse(res, status === 500 ? 'فشل إنشاء الفاتورة' : err.message, status, err.message);
  }
}

// إلغاء فاتورة (مطابق لبلازور CancelInvoiceAsync)
// POST /api/transactions/:id/cancel — Body: { reason? }
async function cancel(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const result = await transactionsQueries.cancelTransaction(
      id,
      (req.body && req.body.reason) || '',
      req.auth.username,
    );
    return successResponse(res, null, result.message);
  } catch (err) {
    console.error('❌ cancel:', err.message);
    const status = err.statusCode || 500;
    return errorResponse(res, status === 500 ? 'فشل إلغاء الفاتورة' : err.message, status, err.message);
  }
}

// إضافة دفعة
async function addPayment(req, res) {
  try {
    const { id } = req.params;
    const { amount, createdBy } = req.body;

    if (!amount || amount <= 0) {
      return errorResponse(res, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر', 400);
    }

    const paymentId = await transactionsQueries.addPayment({
      transactionId: id,
      ...req.body,
      createdBy: req.auth.username,
    });

    return res.json({
      success: true,
      paymentId: paymentId,
      message: 'تم إضافة الدفعة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الدفعة:', err);
    const status = err.statusCode || 500;
    return errorResponse(res, status === 500 ? 'فشل إضافة الدفعة' : err.message, status, err.message);
  }
}

// جلب مدفوعات فاتورة
async function getPayments(req, res) {
  try {
    const { id } = req.params;
    const access = await fullEditQueries.getEditModel(parseInt(id, 10), req.auth);
    if (!access.ok) return sendOperationResult(res, access);
    const payments = await transactionsQueries.getPayments(id);
    return res.json(payments);
  } catch (err) {
    console.error('خطأ في جلب المدفوعات:', err);
    return errorResponse(res, 'فشل تحميل المدفوعات', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// 🧾 نظام طلبات تعديل الفواتير
// ═══════════════════════════════════════════════════════════

// طلب تعديل فاتورة
// POST /api/transactions/:id/request-edit
// Body: { requestedBy, reason }
async function requestEdit(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const { reason } = req.body || {};
    if (!String(reason || '').trim()) return errorResponse(res, 'سبب التعديل مطلوب', 400);

    await transactionsQueries.requestEdit(id, req.auth.username, reason);
    return successResponse(res, null, 'تم إرسال طلب التعديل بنجاح');
  } catch (err) {
    console.error('❌ requestEdit:', err.message);
    return errorResponse(res, 'فشل إرسال طلب التعديل', 500, err.message);
  }
}

// قائمة طلبات التعديل المعلقة
// GET /api/transactions/edit-requests
async function getPendingEditRequests(req, res) {
  try {
    const requests = await transactionsQueries.getPendingEditRequests();
    return successResponse(res, requests, 'تم جلب الطلبات بنجاح');
  } catch (err) {
    console.error('❌ getPendingEditRequests:', err.message);
    return errorResponse(res, 'فشل جلب الطلبات', 500, err.message);
  }
}

// موافقة على طلب تعديل
// POST /api/transactions/:id/approve-edit
// Body: { approvedBy }
async function approveEdit(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    await transactionsQueries.approveEditRequest(
      id,
      req.auth.username,
      req.body?.notes || req.body?.reviewNotes || null,
    );
    return successResponse(res, null, 'تمت الموافقة على طلب التعديل');
  } catch (err) {
    console.error('❌ approveEdit:', err.message);
    return errorResponse(res, 'فشل الموافقة', 500, err.message);
  }
}

// رفض طلب تعديل
// POST /api/transactions/:id/reject-edit
// Body: { rejectedBy, reason }
async function rejectEdit(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const { reason } = req.body || {};
    await transactionsQueries.rejectEditRequest(id, req.auth.username, reason);
    return successResponse(res, null, 'تم رفض طلب التعديل');
  } catch (err) {
    console.error('❌ rejectEdit:', err.message);
    return errorResponse(res, 'فشل الرفض', 500, err.message);
  }
}

// تطبيق التعديل الفعلي (تاريخ تسليم + خصم)
// PUT /api/transactions/:id/apply-edit
// Body: { dueDate?, discountPercentage?, discountAmount?, editedBy }
async function applyEdit(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const { dueDate, discountPercentage, discountAmount } = req.body || {};

    await transactionsQueries.applyInvoiceEdit({
      transactionId: id,
      dueDate,
      discountPercentage,
      discountAmount,
      editedBy: req.auth.username,
    });
    return successResponse(res, null, 'تم تطبيق التعديل بنجاح');
  } catch (err) {
    console.error('❌ applyEdit:', err.message);
    return errorResponse(res, 'فشل تطبيق التعديل', 500, err.message);
  }
}

// تعديل مبلغ صنف + تسجيل PriceHistory
// PUT /api/transactions/:id/details/:detailId/price
// Body: { newUnitPrice, editedBy, changeReason }
async function updateDetailPrice(req, res) {
  try {
    const transactionId = parseInt(req.params.id, 10);
    const detailId = parseInt(req.params.detailId, 10);
    if (!transactionId || !detailId) {
      return errorResponse(res, 'معرّفات غير صالحة', 400);
    }

    const { newUnitPrice, changeReason } = req.body || {};
    if (newUnitPrice === undefined || newUnitPrice === null) {
      return errorResponse(res, 'السعر الجديد مطلوب', 400);
    }

    const result = await transactionsQueries.updateDetailPrice(
      transactionId, detailId, newUnitPrice,
      req.auth.username, changeReason,
    );

    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, null, 'تم تعديل سعر الصنف وتسجيله في سجل التسعير');
  } catch (err) {
    console.error('❌ updateDetailPrice:', err.message);
    return errorResponse(res, 'فشل تعديل السعر', 500, err.message);
  }
}

// تصدير بيانات الفاتورة كاملة (للـ PDF)
// GET /api/transactions/:id/full
async function getFullInvoice(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const editModel = await fullEditQueries.getEditModel(id, req.auth);
    if (!editModel.ok) return sendOperationResult(res, editModel);

    const payments = await transactionsQueries.getPayments(id);
    const data = {
      header: editModel.data.header,
      details: editModel.data.details,
      charges: editModel.data.charges,
      payments,
      mirror: editModel.data.mirror,
      profit: editModel.data.profit,
      capabilities: editModel.data.capabilities,
    };
    return successResponse(res, data, 'تم جلب بيانات الفاتورة');
  } catch (err) {
    console.error('❌ getFullInvoice:', err.message);
    return errorResponse(res, 'فشل جلب بيانات الفاتورة', 500, err.message);
  }
}

// تحديث فاتورة (مطابق بلازور UpdateInvoiceAsync) - يحدث الملاحظات والتسليم والدفع والخصم مع إعادة حساب الإجماليات
// PUT /api/transactions/:id
async function update(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);

    const result = await transactionsQueries.updateTransaction(id, {
      ...req.body,
      editedBy: req.auth.username,
    });
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, null, 'تم تحديث الفاتورة بنجاح - تم إعادة حساب الإجماليات');
  } catch (err) {
    console.error('❌ update:', err.message);
    return errorResponse(res, 'فشل تحديث الفاتورة', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// التعديل الكامل + السجل + الاسترجاع (Blazor 913cc57)
// ═══════════════════════════════════════════════════════════
async function getEditModel(req, res) {
  try {
    const result = await fullEditQueries.getEditModel(parseInt(req.params.id, 10), req.auth);
    return sendOperationResult(res, result);
  } catch (err) {
    console.error('getEditModel:', err);
    return errorResponse(res, 'فشل تحميل نموذج تعديل الفاتورة', 500, err.message);
  }
}

async function fullEdit(req, res) {
  try {
    const result = await fullEditQueries.fullEditInvoice(
      parseInt(req.params.id, 10),
      req.body || {},
      req.auth,
    );
    return sendOperationResult(res, result);
  } catch (err) {
    console.error('fullEdit invoice:', err);
    return errorResponse(res, 'فشل حفظ التعديل الكامل', 500, err.message);
  }
}

async function getEditHistory(req, res) {
  try {
    const result = await fullEditQueries.getEditHistory(
      parseInt(req.params.id, 10),
      req.auth,
    );
    return sendOperationResult(res, result);
  } catch (err) {
    console.error('getEditHistory:', err);
    return errorResponse(res, 'فشل تحميل سجل التعديلات', 500, err.message);
  }
}

async function restoreSnapshot(req, res) {
  try {
    const result = await fullEditQueries.restoreSnapshot(
      parseInt(req.params.id, 10),
      req.params.auditId,
      req.body?.reason,
      req.auth,
    );
    return sendOperationResult(res, result);
  } catch (err) {
    console.error('restoreSnapshot:', err);
    return errorResponse(res, 'فشل استرجاع نسخة الفاتورة', 500, err.message);
  }
}

async function syncMirror(req, res) {
  try {
    const result = await fullEditQueries.syncMirrorWithSale(
      parseInt(req.params.mirrorId, 10),
      req.auth,
    );
    return sendOperationResult(res, result);
  } catch (err) {
    console.error('syncMirror:', err);
    return errorResponse(res, 'فشل مزامنة فاتورة الشراء المرآة', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getById,
  getSummary,
  create,
  update,
  addPayment,
  cancel,
  getPayments,
  requestEdit,
  getPendingEditRequests,
  approveEdit,
  rejectEdit,
  applyEdit,
  updateDetailPrice,
  getFullInvoice,
  getEditModel,
  fullEdit,
  getEditHistory,
  restoreSnapshot,
  syncMirror,
};