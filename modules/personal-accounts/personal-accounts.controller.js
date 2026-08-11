const personalAccountsQueries = require('./personal-accounts.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

function actorName(req) {
  return req.body?.userName || req.body?.createdBy || req.headers['x-user'] || 'System';
}

// GET /api/personal-accounts
async function getAll(req, res) {
  try {
    const result = await personalAccountsQueries.getAccounts(req.query);
    return successResponse(res, result, 'تم جلب الحسابات');
  } catch (err) {
    console.error('personal-accounts.getAll:', err);
    return errorResponse(res, 'فشل تحميل الحسابات', 500, err.message);
  }
}

// GET /api/personal-accounts/totals
async function getTotals(req, res) {
  try {
    const totals = await personalAccountsQueries.getTotals();
    return successResponse(res, totals, 'تم جلب الإحصائيات');
  } catch (err) {
    console.error('personal-accounts.getTotals:', err);
    return errorResponse(res, 'فشل تحميل الإحصائيات', 500, err.message);
  }
}

// GET /api/personal-accounts/types
async function getTypes(req, res) {
  try {
    const types = await personalAccountsQueries.getAccountTypes();
    return successResponse(res, types, 'تم جلب الأنواع');
  } catch (err) {
    console.error('personal-accounts.getTypes:', err);
    return errorResponse(res, 'فشل تحميل الأنواع', 500, err.message);
  }
}

// GET /api/personal-accounts/:id
async function getById(req, res) {
  try {
    const account = await personalAccountsQueries.getAccountById(req.params.id);
    if (!account) return notFoundResponse(res, 'الحساب غير موجود');
    return successResponse(res, account, 'تم جلب الحساب');
  } catch (err) {
    console.error('personal-accounts.getById:', err);
    return errorResponse(res, 'فشل تحميل الحساب', 500, err.message);
  }
}

// GET /api/personal-accounts/:id/statement
async function getStatement(req, res) {
  try {
    const { from, to } = req.query;
    const statement = await personalAccountsQueries.getStatement(req.params.id, from || null, to || null);
    if (!statement) return notFoundResponse(res, 'الحساب غير موجود');
    return successResponse(res, statement, 'تم جلب كشف الحساب');
  } catch (err) {
    console.error('personal-accounts.getStatement:', err);
    return errorResponse(res, 'فشل تحميل كشف الحساب', 500, err.message);
  }
}

// POST /api/personal-accounts
async function create(req, res) {
  try {
    const result = await personalAccountsQueries.createAccount(req.body, actorName(req));
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('personal-accounts.create:', err);
    return errorResponse(res, 'فشل إنشاء الحساب', 500, err.message);
  }
}

// PUT /api/personal-accounts/:id
async function update(req, res) {
  try {
    const result = await personalAccountsQueries.updateAccount(req.params.id, req.body, actorName(req));
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('personal-accounts.update:', err);
    return errorResponse(res, 'فشل تحديث الحساب', 500, err.message);
  }
}

// DELETE /api/personal-accounts/:id
async function remove(req, res) {
  try {
    const result = await personalAccountsQueries.deleteAccount(req.params.id, actorName(req));
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('personal-accounts.delete:', err);
    return errorResponse(res, 'فشل حذف الحساب', 500, err.message);
  }
}

// POST /api/personal-accounts/:id/transactions
async function createTx(req, res) {
  try {
    const result = await personalAccountsQueries.createTransaction(req.params.id, req.body, actorName(req));
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('personal-accounts.createTx:', err);
    return errorResponse(res, 'فشل تسجيل الحركة', 500, err.message);
  }
}

module.exports = {
  getAll,
  getTotals,
  getTypes,
  getById,
  getStatement,
  create,
  update,
  remove,
  createTx,
};
