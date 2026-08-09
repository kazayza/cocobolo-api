const express = require('express');
const router = express.Router();
const transactionsController = require('./transactions.controller');

// ===================================
// 🧾 Transactions Routes
// ===================================

// ملخص الفواتير
// GET /api/transactions/summary?type=Sale
router.get('/summary', transactionsController.getSummary);

// جلب كل الفواتير
// GET /api/transactions?type=Sale&startDate=xxx&endDate=xxx&partyId=xxx
router.get('/', transactionsController.getAll);

// جلب فاتورة بالـ ID
// GET /api/transactions/:id
router.get('/:id', transactionsController.getById);

// إنشاء فاتورة جديدة
// POST /api/transactions
router.post('/', transactionsController.create);

// جلب مدفوعات فاتورة
// GET /api/transactions/:id/payments
router.get('/:id/payments', transactionsController.getPayments);

// إضافة دفعة لفاتورة
// POST /api/transactions/:id/payments
router.post('/:id/payments', transactionsController.addPayment);

// ═══════════════════════════════════════════════════════════
// 🧾 نظام طلبات تعديل الفواتير
// ═══════════════════════════════════════════════════════════

// قائمة طلبات التعديل المعلقة (مهم: قبل /:id عشان متتعرفش كـ id)
router.get('/edit-requests', transactionsController.getPendingEditRequests);

// طلب تعديل فاتورة
router.post('/:id/request-edit', transactionsController.requestEdit);

// موافقة / رفض
router.post('/:id/approve-edit', transactionsController.approveEdit);
router.post('/:id/reject-edit', transactionsController.rejectEdit);

// تطبيق التعديل الفعلي
router.put('/:id/apply-edit', transactionsController.applyEdit);

// تعديل مبلغ صنف
router.put('/:id/details/:detailId/price', transactionsController.updateDetailPrice);

// بيانات كاملة للـ PDF
router.get('/:id/full', transactionsController.getFullInvoice);

// تصدير الراوتر
module.exports = router;