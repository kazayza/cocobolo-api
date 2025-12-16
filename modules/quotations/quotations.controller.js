const quotationsQueries = require('./quotations.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب كل عروض الأسعار
async function getAll(req, res) {
  try {
    const { startDate, endDate, partyId } = req.query;
    const quotations = await quotationsQueries.getAllQuotations(startDate, endDate, partyId);
    return res.json(quotations);
  } catch (err) {
    console.error('خطأ في جلب عروض الأسعار:', err);
    return errorResponse(res, 'فشل تحميل عروض الأسعار', 500, err.message);
  }
}

// جلب عرض سعر بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const quotation = await quotationsQueries.getQuotationById(id);

    if (!quotation) {
      return notFoundResponse(res, 'عرض السعر غير موجود');
    }

    // جلب التفاصيل والرسوم
    const details = await quotationsQueries.getQuotationDetails(id);
    const charges = await quotationsQueries.getQuotationCharges(id);

    quotation.details = details;
    quotation.charges = charges;

    return res.json(quotation);
  } catch (err) {
    console.error('خطأ في جلب عرض السعر:', err);
    return errorResponse(res, 'فشل تحميل عرض السعر', 500, err.message);
  }
}

// إنشاء عرض سعر
async function create(req, res) {
  try {
    const { partyId, createdBy } = req.body;

    if (!partyId || !createdBy) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    const quotationId = await quotationsQueries.createQuotation(req.body);

    return res.json({
      success: true,
      quotationId: quotationId,
      message: 'تم إنشاء عرض السعر بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء عرض السعر:', err);
    return errorResponse(res, 'فشل إنشاء عرض السعر', 500, err.message);
  }
}

// تحويل لفاتورة
async function convertToInvoice(req, res) {
  try {
    const { id } = req.params;
    const { transactionId } = req.body;

    if (!transactionId) {
      return errorResponse(res, 'رقم الفاتورة مطلوب', 400);
    }

    await quotationsQueries.convertToInvoice(id, transactionId);

    return res.json({
      success: true,
      message: 'تم تحويل عرض السعر لفاتورة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تحويل عرض السعر:', err);
    return errorResponse(res, 'فشل تحويل عرض السعر', 500, err.message);
  }
}

// حذف عرض سعر
async function remove(req, res) {
  try {
    const { id } = req.params;

    // التحقق من عدم تحويله لفاتورة
    const quotation = await quotationsQueries.getQuotationById(id);
    if (quotation && quotation.InvoiceID) {
      return errorResponse(res, 'لا يمكن حذف عرض سعر تم تحويله لفاتورة', 400);
    }

    await quotationsQueries.deleteQuotation(id);

    return res.json({
      success: true,
      message: 'تم حذف عرض السعر بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف عرض السعر:', err);
    return errorResponse(res, 'فشل حذف عرض السعر', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getById,
  create,
  convertToInvoice,
  remove
};