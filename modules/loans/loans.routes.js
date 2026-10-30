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

router.get('/stats', authenticate, ctrl.getStats);
router.get('/installments', authenticate, ctrl.getInstallments);
router.get('/statement/:employeeId', authenticate, ctrl.getStatement);
router.get('/employees-lookup', authenticate, ctrl.employeesLookup);
router.get('/', authenticate, ctrl.getAll);
router.post('/', authenticate, canCreateLoan, ctrl.create);
router.post('/:id/cancel', authenticate, canCancelLoan, ctrl.cancel);
module.exports = router;
