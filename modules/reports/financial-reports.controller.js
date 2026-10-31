const queries = require('./financial-reports.queries');
const { errorResponse } = require('../../shared/response.helper');

function handler(name, fn) {
  return async (req, res) => {
    try {
      const range = queries.parseRange(req.query);
      const pool = await queries.withPool((p) => p);
      const data = await fn(pool, range, req.auth);
      return res.json({ success: true, data });
    } catch (error) {
      console.error(`financialReports.${name}:`, error);
      return errorResponse(
        res,
        error.statusCode === 400 ? error.message : 'فشل تحميل التقرير المالي',
        error.statusCode || 500,
        error.code || error.message,
      );
    }
  };
}

module.exports = {
  getIncomeStatement: handler('incomeStatement', (pool, range) => queries.getIncomeStatement(pool, range)),
  getBalanceSheet: handler('balanceSheet', (pool, range) => queries.getBalanceSheet(pool, range)),
  getCashFlow: handler('cashFlow', (pool, range) => queries.getCashFlow(pool, range)),
  getFinancialDashboard: handler('financialDashboard', (pool, range, auth) => queries.getFinancialDashboard(pool, range, auth)),
};
