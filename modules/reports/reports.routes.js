const express = require('express');
const router = express.Router();
const controller = require('./reports.controller');
const financial = require('./financial-reports.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { reports } = require('../../shared/authorization.policy');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

// لوحة CRM/التسويق — بوابة تحليلات المبيعات القائمة (بند 21):
// المسار يعيد إيرادات فعلية، فلا يكفي التوثيق وحده.
router.get('/dashboard', requirePolicy(
  reports.canViewSalesAnalytics,
  'لوحة التسويق متاحة للإدارة أو مدير الحسابات أو مدير المبيعات أو حامل صلاحية تحليلات المبيعات',
), controller.getDashboard);

// تحليلات المبيعات (بند 23) — SalesAnalytics.razor/SalesAnalyticsService.cs
const salesAnalyticsGate = requirePolicy(
  reports.canViewSalesAnalytics,
  'تحليلات المبيعات متاحة للإدارة أو مدير الحسابات أو مدير المبيعات أو حامل صلاحية تحليلات المبيعات',
);
router.get('/sales-analytics', salesAnalyticsGate, controller.getSalesAnalytics);
router.get('/sales-analytics/filters', salesAnalyticsGate, controller.getSalesAnalyticsFilters);

// القوائم المالية — بوابة لكل قائمة بحرفيات بلازور الحقيقية (بند 14، D19):
// قائمة الدخل: frmIncomeStatement:View أو frmCashBoxDashboard:View أو Admin
// (IncomeStatement.razor:1118-1120)
router.get('/income-statement', requirePolicy(
  reports.canViewIncomeStatement,
  'قائمة الدخل متاحة للإدارة أو حامل صلاحية قائمة الدخل أو لوحة الخزينة',
), financial.getIncomeStatement);
// الميزانية: frmIncomeStatement:View أو rpt_IncomeStatement:View أو
// frmCashBoxDashboard:View أو Admin (BalanceSheet.razor:697-700)
router.get('/balance-sheet', requirePolicy(
  reports.canViewBalanceSheet,
  'الميزانية العمومية متاحة للإدارة أو حامل صلاحية قائمة الدخل أو لوحة الخزينة',
), financial.getBalanceSheet);
// التدفقات: frm_CashFlowNew:View أو frmCashBoxDashboard:View أو Admin
// (CashFlowStatement.razor:901-903)
router.get('/cash-flow', requirePolicy(
  reports.canViewCashFlow,
  'قائمة التدفقات النقدية متاحة للإدارة أو حامل صلاحية التدفقات النقدية أو لوحة الخزينة',
), financial.getCashFlow);
// اللوحة المالية: صفحة بلازور [Authorize] فقط بلا بوابة Claim
// (FinancialDashboard.razor:18) — تبقى على التوثيق وحده تحقيقًا للتطابق،
// مع استبعاد المنشئين المحميين داخل الاستعلام لمن لا يملك رؤيتهم.
router.get('/financial-dashboard', financial.getFinancialDashboard);

module.exports = router;
