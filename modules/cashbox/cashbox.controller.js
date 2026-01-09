const cashboxQueries = require('./cashbox.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب كل الخزائن
async function getAll(req, res) {
  try {
    const cashboxes = await cashboxQueries.getAllCashboxes();
    return res.json(cashboxes);
  } catch (err) {
    console.error('خطأ في جلب الخزائن:', err);
    return errorResponse(res, 'فشل تحميل الخزائن', 500, err.message);
  }
}



// جلب خزينة بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const cashbox = await cashboxQueries.getCashboxById(id);

    if (!cashbox) {
      return notFoundResponse(res, 'الخزينة غير موجودة');
    }

    return res.json(cashbox);
  } catch (err) {
    console.error('خطأ في جلب الخزينة:', err);
    return errorResponse(res, 'فشل تحميل الخزينة', 500, err.message);
  }
}

// ملخص الخزينة
async function getSummary(req, res) {
  try {
    const { cashboxId } = req.query;
    const summary = await cashboxQueries.getCashboxSummary(cashboxId);
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// جلب حركات الخزينة
async function getTransactions(req, res) {
  try {
    const { cashboxId, startDate, endDate, transactionType } = req.query;
    const transactions = await cashboxQueries.getCashboxTransactions(
      cashboxId, startDate, endDate, transactionType
    );
    return res.json(transactions);
  } catch (err) {
    console.error('خطأ في جلب الحركات:', err);
    return errorResponse(res, 'فشل تحميل الحركات', 500, err.message);
  }
}

// إنشاء خزينة
async function create(req, res) {
  try {
    const { cashBoxName, createdBy } = req.body;

    if (!cashBoxName) {
      return errorResponse(res, 'اسم الخزينة مطلوب', 400);
    }

    const cashBoxId = await cashboxQueries.createCashbox(req.body);

    return res.json({
      success: true,
      cashBoxId: cashBoxId,
      message: 'تم إنشاء الخزينة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء الخزينة:', err);
    return errorResponse(res, 'فشل إنشاء الخزينة', 500, err.message);
  }
}

// تعديل خزينة
async function update(req, res) {
  try {
    const { id } = req.params;
    const { cashBoxName } = req.body;

    if (!cashBoxName) {
      return errorResponse(res, 'اسم الخزينة مطلوب', 400);
    }

    await cashboxQueries.updateCashbox(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل الخزينة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل الخزينة:', err);
    return errorResponse(res, 'فشل تعديل الخزينة', 500, err.message);
  }
}

// إضافة حركة
async function createTransaction(req, res) {
  try {
    const { cashBoxId, transactionType, amount, createdBy } = req.body;

    if (!cashBoxId || !transactionType || !amount) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const transactionId = await cashboxQueries.createTransaction(req.body);

    return res.json({
      success: true,
      transactionId: transactionId,
      message: 'تم إضافة الحركة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الحركة:', err);
    return errorResponse(res, 'فشل إضافة الحركة', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getById,
  getSummary,
  getTransactions,
  create,
  update,
  createTransaction
};