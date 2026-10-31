const express = require('express');
const router = express.Router();
const expensesController = require('./expenses.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const policy = require('../../shared/authorization.policy');
const { expenses: expensesPolicy } = policy;

// ===================================
// 💰 Expenses Routes
// Phase 0: كانت الوحدة مفتوحة بالكامل — الآن جلسة + سياسات بمرآة ExpenseService في بلازور.
// ===================================

router.use(authenticate);

const canView = requirePolicy(expensesPolicy.canView, 'غير مصرح لك بعرض المصروفات');
const canAdd = requirePolicy(expensesPolicy.canAdd, 'غير مصرح لك بإضافة مصروف');
const canEdit = requirePolicy(expensesPolicy.canEdit, 'غير مصرح لك بتعديل مصروف');
const canDelete = requirePolicy(expensesPolicy.canDelete, 'غير مصرح لك بحذف مصروف');
const canAddGroup = requirePolicy(expensesPolicy.canAddGroup, 'غير مصرح لك بإضافة مجموعة مصروفات');
// ملاحظة: ملف السياسات المشترك لا يعرّف بعد canEditGroup/canDeleteGroup —
// تُبنى هنا محليًا بنفس نمط cashbox.routes (roles/hasClaim من السياسات)
// إلى أن تُضاف مركزيًا: frm_ExpensesGroup:Edit/Delete (ExpenseService.cs:970).
const canEditGroup = requirePolicy(
  (a) => policy.roles.admin(a) || policy.hasClaim(a, 'frm_ExpensesGroup:Edit'),
  'غير مصرح لك بتعديل مجموعة مصروفات');
const canDeleteGroup = requirePolicy(
  (a) => policy.roles.admin(a) || policy.hasClaim(a, 'frm_ExpensesGroup:Delete'),
  'غير مصرح لك بحذف مجموعة مصروفات');

// ── مجموعات المصروفات ──────────────────────────────
router.get('/groups', canView, expensesController.getGroups);
router.post('/groups', canAddGroup, expensesController.createGroup);
router.get('/groups/by-parent', canView, expensesController.getGroupsByParent);
router.put('/groups/:id', canEditGroup, expensesController.updateGroup);
router.delete('/groups/:id', canDeleteGroup, expensesController.deleteGroup);

// ── الخزائن (نشطة + فرع + رصيد موحّد) ───────────────
router.get('/cashboxes', canView, expensesController.getCashboxes);

// ── اقتراحات الأسماء ────────────────────────────────
router.get('/name-suggestions', canView, expensesController.getNameSuggestions);

// ── الداشبورد والتقارير والتصدير والطباعة ──────────
router.get('/dashboard', canView, expensesController.getDashboard);
router.get('/summary', canView, expensesController.getSummary);
router.get('/monthly-summary', canView, expensesController.getMonthlySummary);
router.get('/export/detailed', canView, expensesController.exportDetailed);
router.get('/export/monthly', canView, expensesController.exportMonthly);
router.get('/print-data', canView, expensesController.getPrintData);

// ── المصروفات ───────────────────────────────────────
router.get('/', canView, expensesController.getAll);
router.post('/', canAdd, expensesController.create);
router.put('/:id', canEdit, expensesController.update);
router.delete('/:id', canDelete, expensesController.remove);
router.get('/:id', canView, expensesController.getById);

module.exports = router;
