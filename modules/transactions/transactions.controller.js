const transactionsQueries = require('./transactions.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب كل الفواتير
async function getAll(req, res) {
  try {
    const { type, startDate, endDate, partyId } = req.query;
    const transactions = await transactionsQueries.getAllTransactions(
      type, startDate, endDate, partyId
    );
    return res.json(transactions);
  } catch (err) {
    console.error('خطأ في جلب الفواتير:', err);
    return errorResponse(res, 'فشل تحميل الفواتير', 500, err.message);
  }
}

// جلب فاتورة بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const transaction = await transactionsQueries.getTransactionById(id);

    if (!transaction) {
      return notFoundResponse(res, 'الفاتورة غير موجودة');
    }

    // جلب التفاصيل والرسوم والمدفوعات
    const details = await transactionsQueries.getTransactionDetails(id);
    const charges = await transactionsQueries.getAdditionalCharges(id);
    const payments = await transactionsQueries.getPayments(id);

    transaction.details = details;
    transaction.charges = charges;
    transaction.payments = payments;

    return res.json(transaction);
  } catch (err) {
    console.error('خطأ في جلب الفاتورة:', err);
    return errorResponse(res, 'فشل تحميل الفاتورة', 500, err.message);
  }
}

// ملخص الفواتير
async function getSummary(req, res) {
  try {
    const { type } = req.query;
    const summary = await transactionsQueries.getTransactionsSummary(type);
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// إنشاء فاتورة
async function create(req, res) {
  try {
    const { partyId, transactionType, warehouseId, createdBy } = req.body;

    if (!partyId || !transactionType || !warehouseId || !createdBy) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const transactionId = await transactionsQueries.createTransaction(req.body);

    return res.json({
      success: true,
      transactionId: transactionId,
      message: 'تم إنشاء الفاتورة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء الفاتورة:', err);
    return errorResponse(res, 'فشل إنشاء الفاتورة', 500, err.message);
  }
}

// إضافة دفعة
async function addPayment(req, res) {
  try {
    const { id } = req.params;
    const { amount, createdBy } = req.body;

    if (!amount || amount <= 0) {
      return errorResponse(res, 'المبلغ مطلوب ويجب أن يكون أكبر من صفر', 400);
    }

    const paymentId = await transactionsQueries.addPayment({
      transactionId: id,
      ...req.body
    });

    return res.json({
      success: true,
      paymentId: paymentId,
      message: 'تم إضافة الدفعة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الدفعة:', err);
    return errorResponse(res, 'فشل إضافة الدفعة', 500, err.message);
  }
}

// جلب مدفوعات فاتورة
async function getPayments(req, res) {
  try {
    const { id } = req.params;
    const payments = await transactionsQueries.getPayments(id);
    return res.json(payments);
  } catch (err) {
    console.error('خطأ في جلب المدفوعات:', err);
    return errorResponse(res, 'فشل تحميل المدفوعات', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getById,
  getSummary,
  create,
  addPayment,
  getPayments
};