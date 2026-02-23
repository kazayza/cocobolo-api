const clientsQueries = require('./clients.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// جلب كل العملاء
async function getAll(req, res) {
  try {
    const clients = await clientsQueries.getAllClients();
    return res.json(clients);
  } catch (err) {
    console.error('خطأ في جلب العملاء:', err);
    return errorResponse(res, 'فشل تحميل العملاء', 500, err.message);
  }
}

// جلب قائمة العملاء (مختصرة)
async function getList(req, res) {
  try {
    const clients = await clientsQueries.getClientsList();
    return res.json(clients);
  } catch (err) {
    console.error('خطأ في جلب العملاء:', err);
    return errorResponse(res, 'فشل تحميل العملاء', 500, err.message);
  }
}

// البحث عن عميل
async function search(req, res) {
  try {
    const { q } = req.query;

    if (!q) {
      return res.json([]);
    }

    const clients = await clientsQueries.searchClients(q);
    return res.json(clients);
  } catch (err) {
    console.error('خطأ في البحث عن العميل:', err);
    return errorResponse(res, 'فشل البحث', 500, err.message);
  }
}

// ملخص العملاء
async function getSummary(req, res) {
  try {
    const summary = await clientsQueries.getClientsSummary();
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب ملخص العملاء:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// جلب عميل بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const client = await clientsQueries.getClientById(id);

    if (!client) {
      return notFoundResponse(res, 'العميل غير موجود');
    }

    return res.json(client);
  } catch (err) {
    console.error('خطأ في جلب تفاصيل العميل:', err);
    return errorResponse(res, 'فشل تحميل بيانات العميل', 500, err.message);
  }
}

// إضافة عميل جديد
async function create(req, res) {
  try {
    const { partyName } = req.body;

    // التحقق من وجود الاسم
    if (!partyName) {
      return errorResponse(res, 'اسم العميل مطلوب', 400);
    }

    // التحقق من تكرار الاسم
    const exists = await clientsQueries.checkClientNameExists(partyName);
    if (exists) {
      return res.json({ success: false, message: 'اسم العميل موجود مسبقاً' });
    }

    // إضافة العميل
    const partyId = await clientsQueries.createClient(req.body);

    return res.json({
      success: true,
      partyId: partyId,
      message: 'تم إضافة العميل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة العميل:', err);
    return errorResponse(res, 'فشل إضافة العميل', 500, err.message);
  }
}

// تعديل عميل
async function update(req, res) {
  try {
    const { id } = req.params;
    const { partyName } = req.body;

    // التحقق من وجود الاسم
    if (!partyName) {
      return errorResponse(res, 'اسم العميل مطلوب', 400);
    }

    // التحقق من تكرار الاسم (مع استثناء العميل الحالي)
    const exists = await clientsQueries.checkClientNameExists(partyName, id);
    if (exists) {
      return res.json({ success: false, message: 'اسم العميل موجود مسبقاً' });
    }

    // تعديل العميل
    await clientsQueries.updateClient(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل العميل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل العميل:', err);
    return errorResponse(res, 'فشل تعديل العميل', 500, err.message);
  }
}

// حذف عميل
async function remove(req, res) {
  try {
    const { id } = req.params;

    // التحقق من وجود معاملات
    const hasTransactions = await clientsQueries.checkClientHasTransactions(id);
    if (hasTransactions) {
      return res.json({
        success: false,
        message: 'لا يمكن حذف العميل لوجود معاملات مرتبطة به'
      });
    }

    // حذف العميل
    await clientsQueries.deleteClient(id);

    return res.json({
      success: true,
      message: 'تم حذف العميل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف العميل:', err);
    return errorResponse(res, 'فشل حذف العميل', 500, err.message);
  }
}

// جلب مصادر الإحالة
async function getReferralSources(req, res) {
  try {
    const sources = await clientsQueries.getReferralSources();
    return res.json(sources);
  } catch (err) {
    console.error('خطأ في جلب مصادر الإحالة:', err);
    return errorResponse(res, 'فشل تحميل مصادر الإحالة', 500, err.message);
  }
}

// التحقق من تكرار رقم الهاتف
async function checkPhone(req, res) {
  try {
    const { phone, phone2, excludeId } = req.query;
    
    if (!phone && !phone2) {
      return res.json({ exists: false });
    }
    
    const existingClient = await clientsQueries.checkPhoneExists(
      phone || null,
      phone2 || null,
      excludeId || null
    );
    
    if (existingClient) {
      return res.json({
        exists: true,
        client: existingClient
      });
    }
    
    return res.json({ exists: false });
  } catch (err) {
    console.error('خطأ في التحقق من الهاتف:', err);
    return errorResponse(res, 'فشل التحقق من الهاتف', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getAll,
  getList,
  search,
  getSummary,
  getById,
  create,
  update,
  remove,
  getReferralSources,
  checkPhone
};