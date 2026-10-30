const express = require('express');
const router = express.Router();
const ctrl = require('./loans.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const policies = require('../../shared/authorization.policy');
// مرحلة صفر الموارد: إنشاء السلفة وإلغاؤها عمليتان ماليتان — خلف بوابة
// أدوار/Claims مطابقة لبلازور (frmEmployeeLoans:Add / :Delete)؛
// القراءات والكشوف تبقى لأي جلسة مصادقة.
const canCreateLoan = requirePolicy(policies.loans.canCreate, 'غير مصرح لك بإنشاء سلفة');
const canCancelLoan = requirePolicy(policies.loans.canCancel, 'غير مصرح لك بإلغاء سلفة');
// تعديل الأقساط (تأجيل/تجزئة/تعديل) خلف frmEmployeeLoans:Edit بنفس أدوار الإنشاء/الإلغاء.
const canEditLoan = requirePolicy(policies.loans.canEdit, 'غير مصرح لك بتعديل أقساط السلفة');

router.get('/stats', authenticate, ctrl.getStats);
router.get('/installments', authenticate, ctrl.getInstallments);
router.get('/statement/:employeeId', authenticate, ctrl.getStatement);
router.get('/employees-lookup', authenticate, ctrl.employeesLookup);
router.get('/', authenticate, ctrl.getAll);
// تفاصيل سلفة — تُسجَّل بعد المسارات المحددة حتى لا تبتلعها.
router.get('/:id', authenticate, ctrl.getById);
router.post('/', authenticate, canCreateLoan, ctrl.create);
router.post('/installments/:id/skip', authenticate, canEditLoan, ctrl.skipInstallment);
router.post('/installments/:id/split', authenticate, canEditLoan, ctrl.splitInstallment);
router.post('/installments/:id/update', authenticate, canEditLoan, ctrl.updateInstallment);
router.post('/:id/cancel', authenticate, canCancelLoan, ctrl.cancel);
module.exports = router;
