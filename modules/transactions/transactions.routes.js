const express = require('express');
const router = express.Router();
const transactionsController = require('./transactions.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { invoices: invoicePolicy, payments: paymentsPolicy } = require('../../shared/authorization.policy');
const paymentsQueries = require('../payments/payments.queries');
const { errorResponse } = require('../../shared/response.helper');

// بوابة إضافة دفعة: payments.canCreate تُحسم بنوع الفاتورة الهدف
// (بيع/شراء) — تُحمَّل من قاعدة البيانات قبل أي كتابة.
async function paymentsCreateGate(req, res, next) {
  try {
    const invoice = await paymentsQueries.getTransactionType(parseInt(req.params.id, 10));
    if (!invoice) return errorResponse(res, 'الفاتورة غير موجودة.', 404);
    if (!paymentsPolicy.canCreate(req.auth, paymentsQueries.isPurchaseType(invoice.TransactionType))) {
      return errorResponse(res, 'غير مصرح لك بتنفيذ هذا الإجراء على المدفوعات.', 403);
    }
    return next();
  } catch (err) {
    console.error('paymentsCreateGate:', err);
    return errorResponse(res, 'فشل التحقق من صلاحية الدفع', 500, err.message);
  }
}

// كل بيانات الفواتير مالية/مخزنية؛ لا يوجد Route مجهول هنا.
router.use(authenticate);

// ===================================
// 🧾 Transactions Routes - مرتبة صح لمنع تعارض المسارات
// ===================================

// ملخص الفواتير
router.get('/summary', transactionsController.getSummary);

// قائمة طلبات التعديل المعلقة (Admin/AccountManager)
router.get(
  '/edit-requests',
  requirePolicy(invoicePolicy.canApproveEdit),
  transactionsController.getPendingEditRequests,
);

// جلب كل الفواتير
router.get('/', transactionsController.getAll);

// نموذج التعديل الكامل + القدرات المحسوبة من صلاحيات السيرفر
router.get('/:id/edit-model', transactionsController.getEditModel);
router.put(
  '/:id/full-edit',
  requirePolicy(invoicePolicy.canFullEdit, 'التعديل الكامل متاح للمدير ومدير الحسابات فقط'),
  transactionsController.fullEdit,
);
router.get(
  '/:id/edit-history',
  requirePolicy(invoicePolicy.canViewHistory, 'سجل التعديلات متاح للمدير ومدير الحسابات فقط'),
  transactionsController.getEditHistory,
);
router.post(
  '/:id/restore/:auditId',
  requirePolicy(invoicePolicy.canRestore, 'الاسترجاع متاح للمدير ومدير الحسابات فقط'),
  transactionsController.restoreSnapshot,
);
router.post(
  '/mirror/:mirrorId/sync',
  requirePolicy(invoicePolicy.canFullEdit, 'مزامنة المرآة متاحة للمدير ومدير الحسابات فقط'),
  transactionsController.syncMirror,
);

// بيانات كاملة للتفاصيل والطباعة
router.get('/:id/full', transactionsController.getFullInvoice);

// جلب مدفوعات فاتورة
router.get('/:id/payments', transactionsController.getPayments);

// جلب فاتورة بالـ ID (عام - بعد المسارات المحددة)
router.get('/:id', transactionsController.getById);

// إنشاء فاتورة جديدة
router.post('/', transactionsController.create);

// إضافة دفعة لفاتورة — بوابة المدفوعات (PaymentService.CanMutatePayment)
// لا بوابة تعديل الفواتير: تُحسم بنوع الفاتورة داخل paymentsCreateGate.
router.post(
  '/:id/payments',
  paymentsCreateGate,
  transactionsController.addPayment,
);

// إلغاء فاتورة — صلاحية بلازور نفسها: frm_PartiesInvoices:Delete
router.post(
  '/:id/cancel',
  requirePolicy(invoicePolicy.canCancel, 'إلغاء الفواتير متاح لصاحب صلاحية حذف الفواتير أو المدير فقط'),
  transactionsController.cancel,
);

// طلب تعديل فاتورة
router.post('/:id/request-edit', transactionsController.requestEdit);

// موافقة / رفض طلب تعديل
router.post(
  '/:id/approve-edit',
  requirePolicy(invoicePolicy.canApproveEdit, 'مراجعة طلب تعديل الفاتورة متاحة للمدير ومدير الحسابات فقط'),
  transactionsController.approveEdit,
);
router.post(
  '/:id/reject-edit',
  requirePolicy(invoicePolicy.canApproveEdit, 'مراجعة طلب تعديل الفاتورة متاحة للمدير ومدير الحسابات فقط'),
  transactionsController.rejectEdit,
);

// تطبيق التعديل الفعلي (تاريخ تسليم + خصم) - مصحح 100% لحساب الإجماليات
router.put(
  '/:id/apply-edit',
  requirePolicy(invoicePolicy.canFullEdit),
  transactionsController.applyEdit,
);

// تعديل سعر صنف منفرد يعتبر تعديلًا ماليًا كاملاً
router.put(
  '/:id/details/:detailId/price',
  requirePolicy(invoicePolicy.canFullEdit),
  transactionsController.updateDetailPrice,
);

// التعديل المحدود (ملاحظات/تسليم...) للأدوار المسموحة
router.put(
  '/:id',
  requirePolicy(invoicePolicy.canLimitedEdit),
  transactionsController.update,
);

// تصدير الراوتر
module.exports = router;