const q = require('./payments.queries');
const transactionsQueries = require('../transactions/transactions.queries');
const policies = require('../../shared/authorization.policy');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');

const DENIED = 'غير مصرح لك بتنفيذ هذا الإجراء على المدفوعات.';

function sendError(res, err, fallback) {
  const status = err.statusCode || 500;
  return errorResponse(res, status === 500 ? fallback : err.message, status, err.message);
}

// GET /api/payments — قائمة بيع/شراء (بوابة العرض في المسارات)
async function list(req, res) {
  try {
    const data = await q.getPayments(req.query);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('payments.list:', err);
    return sendError(res, err, 'فشل تحميل المدفوعات');
  }
}

// GET /api/payments/stats
async function stats(req, res) {
  try {
    const data = await q.getStats(req.query);
    return res.json({ success: true, data });
  } catch (err) {
    console.error('payments.stats:', err);
    return sendError(res, err, 'فشل تحميل إحصائيات المدفوعات');
  }
}

// POST /api/payments — إنشاء مستقل يفوَّض لنواة transactions.addPayment
// نفسها؛ البوابة payments.canCreate تُحسم بنوع الفاتورة الهدف.
async function create(req, res) {
  try {
    const transactionId = parseInt(req.body?.transactionId, 10);
    if (!transactionId) return errorResponse(res, 'يرجى اختيار الفاتورة.', 400);
    const invoice = await q.getTransactionType(transactionId);
    if (!invoice) return notFoundResponse(res, 'الفاتورة غير موجودة.');
    if (!policies.payments.canCreate(req.auth, q.isPurchaseType(invoice.TransactionType))) {
      return errorResponse(res, DENIED, 403);
    }
    const paymentId = await transactionsQueries.addPayment({
      transactionId,
      amount: req.body.amount,
      cashBoxId: req.body.cashBoxId,
      paymentMethod: req.body.paymentMethod,
      paymentDate: req.body.paymentDate,
      notes: req.body.notes,
      createdBy: req.auth.username,
    });
    return res.status(201).json({
      success: true,
      paymentId,
      message: 'تم تسجيل الدفعة بنجاح.',
      data: { paymentId },
    });
  } catch (err) {
    console.error('payments.create:', err);
    return sendError(res, err, 'فشل تسجيل الدفعة');
  }
}

// DELETE /api/payments/:id — السبب إلزامي (واجهة بلازور) ويُحفظ في
// سجل التدقيق داخل queries.cancelPayment.
async function remove(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف دفعة غير صالح', 400);
    const reason = String(req.body?.reason || '').trim();
    if (!reason) return errorResponse(res, 'سبب إلغاء الدفعة مطلوب', 400);
    const result = await q.cancelPayment(id, reason, req.auth.username);
    return res.json({ success: true, message: 'تم إلغاء الدفعة وردت قيمتها للخزينة.', data: result });
  } catch (err) {
    console.error('payments.remove:', err);
    return sendError(res, err, 'فشل إلغاء الدفعة');
  }
}

// PUT /api/payments/:id — البوابة payments.canEdit بنوع فاتورة الدفعة.
async function update(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف دفعة غير صالح', 400);
    const linked = await q.getPaymentInvoiceType(id);
    if (!linked) return notFoundResponse(res, 'الدفعة غير موجودة.');
    if (!policies.payments.canEdit(req.auth, q.isPurchaseType(linked.TransactionType))) {
      return errorResponse(res, DENIED, 403);
    }
    const result = await q.updatePayment(id, req.body || {}, req.auth.username);
    return res.json({ success: true, message: 'تم تعديل الدفعة بنجاح.', data: result });
  } catch (err) {
    console.error('payments.update:', err);
    return sendError(res, err, 'فشل تعديل الدفعة');
  }
}

// GET /api/payments/:id/receipt
async function receipt(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    if (!id) return errorResponse(res, 'معرّف دفعة غير صالح', 400);
    const data = await q.getReceipt(id);
    if (!data) return notFoundResponse(res, 'الدفعة غير موجودة.');
    return res.json({ success: true, data });
  } catch (err) {
    console.error('payments.receipt:', err);
    return sendError(res, err, 'فشل تحميل سند الدفعة');
  }
}

// GET /api/payments/analysis/:transactionId?amount=
async function analysis(req, res) {
  try {
    const id = parseInt(req.params.transactionId, 10);
    if (!id) return errorResponse(res, 'معرّف فاتورة غير صالح', 400);
    const data = await q.getAnalysis(id, req.query.amount);
    if (!data) return notFoundResponse(res, 'الفاتورة غير موجودة.');
    return res.json({ success: true, data });
  } catch (err) {
    console.error('payments.analysis:', err);
    return sendError(res, err, 'فشل تحليل الدفعة');
  }
}

module.exports = { list, stats, create, remove, update, receipt, analysis };
