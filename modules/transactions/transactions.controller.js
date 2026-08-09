const transactionsQueries = require('./transactions.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب كل الفواتير
async function getAll(req, res) {
  try {
    const {
      type, startDate, endDate, partyId,
      search, status, hasRemaining, overdue, page, limit,
    } = req.query;

    const transactions = await transactionsQueries.getAllTransactions({
      type, startDate, endDate, partyId,
      search, status, hasRemaining, overdue,
      page: parseInt(page, 10) || 1,
      limit: parseInt(limit, 10) || 20,
    });

    const stats = await transactionsQueries.getInvoicesStats({
      type, search, status, hasRemaining, overdue,
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
    const transaction = await transactionsQueries.getTransactionById(id);

    if (!transaction) {
      return notFoundResponse(res, 'الفاتورة غير موجودة');
    }

    // جلب التفاصيل والرسوم والمدفوعات
    const details = await transactionsQueries.getTransactionDetails(id);
    const charges = await transactionsQueries.getAdditionalCharges(id);
    const payments = await transactionsQueries.getPayments(id);

    transaction.details = details;
    transaction.charges = charges;
    transaction.payments = payments;

    return res.json(transaction);
  } catch (err) {
    console.error('خطأ في جلب الفاتورة:', err);
    return errorResponse(res, 'فشل تحميل الفاتورة', 500, err.message);
  }
}

// ملخص الفواتير
async function getSummary(req, res) {
  try {
    const { type } = req.query;
    const summary = await transactionsQueries.getTransactionsSummary(type);
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// إنشاء فاتورة
async function create(req, res) {
  try {
    const { partyId, transactionType, warehouseId, createdBy } = req.body;

    if (!partyId || !transactionType || !warehouseId || !createdBy) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const transactionId = await transactionsQueries.createTransaction(req.body);

    return res.json({
      success: true,
      transactionId: transactionId,
      message: 'تم إنشاء الفاتورة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء الفاتورة:', err);
    return errorResponse(res, 'فشل إنشاء الفاتورة', 500, err.message);
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
      ...req.body
    });

    return res.json({
      success: true,
      paymentId: paymentId,
      message: 'تم إضافة الدفعة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الدفعة:', err);
    return errorResponse(res, 'فشل إضافة الدفعة', 500, err.message);
  }
}

// جلب مدفوعات فاتورة
async function getPayments(req, res) {
  try {
    const { id } = req.params;
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

    const { requestedBy, reason } = req.body || {};
    if (!requestedBy) return errorResponse(res, 'اسم المستخدم مطلوب', 400);

    await transactionsQueries.requestEdit(id, requestedBy, reason);
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

    const { approvedBy } = req.body || {};
    await transactionsQueries.approveEditRequest(id, approvedBy || 'Admin');
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

    const { rejectedBy, reason } = req.body || {};
    await transactionsQueries.rejectEditRequest(id, rejectedBy || 'Admin', reason);
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

    const { dueDate, discountPercentage, discountAmount, editedBy } = req.body || {};

    await transactionsQueries.applyInvoiceEdit({
      transactionId: id,
      dueDate,
      discountPercentage,
      discountAmount,
      editedBy: editedBy || 'Admin',
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

    const { newUnitPrice, editedBy, changeReason } = req.body || {};
    if (newUnitPrice === undefined || newUnitPrice === null) {
      return errorResponse(res, 'السعر الجديد مطلوب', 400);
    }

    const result = await transactionsQueries.updateDetailPrice(
      transactionId, detailId, newUnitPrice,
      editedBy || 'Admin', changeReason,
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

    const data = await transactionsQueries.getFullInvoiceData(id);
    if (!data.header) return notFoundResponse(res, 'الفاتورة غير موجودة');

    return successResponse(res, data, 'تم جلب بيانات الفاتورة');
  } catch (err) {
    console.error('❌ getFullInvoice:', err.message);
    return errorResponse(res, 'فشل جلب بيانات الفاتورة', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getById,
  getSummary,
  create,
  addPayment,
  getPayments,
  requestEdit,
  getPendingEditRequests,
  approveEdit,
  rejectEdit,
  applyEdit,
  updateDetailPrice,
  getFullInvoice
};