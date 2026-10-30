const express = require('express');
const router = express.Router();
const controller = require('./reports.controller');
const financial = require('./financial-reports.controller');
const { authenticate, requirePolicy } = require('../../core/auth.middleware');
const { reports } = require('../../shared/authorization.policy');
// Phase 0: deny-by-default — كل مسارات الوحدة تتطلب جلسة صالحة.
router.use(authenticate);

router.get('/dashboard', controller.getDashboard);

// التقارير المالية (بند 28) — بوابة reports.canViewFinancialStatements نفسها
// (FinancialReportsService/FinancialDashboardService/CashFlowService في بلازور)
const financialGate = requirePolicy(
  reports.canViewFinancialStatements,
  'التقارير المالية متاحة للإدارة أو مدير الحسابات أو حامل صلاحية القوائم المالية',
);
router.get('/income-statement', financialGate, financial.getIncomeStatement);
router.get('/balance-sheet', financialGate, financial.getBalanceSheet);
router.get('/cash-flow', financialGate, financial.getCashFlow);
router.get('/financial-dashboard', financialGate, financial.getFinancialDashboard);

module.exports = router;
