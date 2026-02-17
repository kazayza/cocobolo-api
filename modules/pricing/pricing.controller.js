const pricingQueries = require('./pricing.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// =============================================
// 🔢 نسب الربح (PricingMargins)
// =============================================

// جلب النسب الحالية
async function getActiveMargins(req, res) {
  try {
    const margins = await pricingQueries.getActiveMargins();
    return res.json(margins);
  } catch (err) {
    console.error('خطأ في جلب النسب:', err);
    return errorResponse(res, 'فشل تحميل النسب', 500, err.message);
  }
}

// جلب سجل تغييرات النسب
async function getMarginsHistory(req, res) {
  try {
    const history = await pricingQueries.getMarginsHistory();
    return res.json(history);
  } catch (err) {
    console.error('خطأ في جلب سجل النسب:', err);
    return errorResponse(res, 'فشل تحميل السجل', 500, err.message);
  }
}

// تحديث النسب (Admin / AccountManager فقط)
async function updateMargins(req, res) {
  try {
    const { premiumMargin, eliteMargin, reason, createdBy, clientTime } = req.body;

    // التحقق من البيانات
    if (!premiumMargin || !eliteMargin) {
      return errorResponse(res, 'نسبة Premium و Elite مطلوبتين', 400);
    }
    if (!createdBy) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    // تحديث النسب
    const marginId = await pricingQueries.updateMargins(
      premiumMargin, eliteMargin, reason, createdBy, clientTime
    );

    // 🔔 إشعار لـ Factory + SalesManager
    try {
      await notificationsQueries.createNotificationSmart({
        title: 'تحديث نسب الربح',
        message: `تم تحديث نسب الربح: Premium ${premiumMargin}% | Elite ${eliteMargin}%`,
        createdBy: createdBy,
        relatedId: marginId,
        formName: 'frm_PricingMargins'
      }, 'Factory');

      await notificationsQueries.createNotificationSmart({
        title: 'تحديث نسب الربح',
        message: `تم تحديث نسب الربح: Premium ${premiumMargin}% | Elite ${eliteMargin}%`,
        createdBy: createdBy,
        relatedId: marginId,
        formName: 'frm_PricingMargins'
      }, 'SalesManager');
    } catch (notifErr) {
      console.error('فشل إرسال الإشعار:', notifErr);
    }

    return res.json({
      success: true,
      marginId,
      message: 'تم تحديث النسب بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تحديث النسب:', err);
    return errorResponse(res, 'فشل تحديث النسب', 500, err.message);
  }
}

// =============================================
// 💰 تسعير المنتج (Factory)
// =============================================

async function updateProductPricing(req, res) {
  try {
    const { id } = req.params;
    const { purchasePrice, purchasePriceElite, changedBy, clientTime } = req.body;

    // التحقق من البيانات
    if (!purchasePrice && !purchasePriceElite) {
      return errorResponse(res, 'سعر التكلفة مطلوب', 400);
    }
    if (!changedBy) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    const result = await pricingQueries.updateProductPricing(
      id,
      purchasePrice || 0,
      purchasePriceElite || 0,
      changedBy,
      clientTime
    );

    // 🔔 إشعار للسيلز اللي كوّد المنتج
    try {
      if (result.createdBy && result.createdBy !== changedBy) {
        await notificationsQueries.createNotification({
          title: 'تم تسعير المنتج',
          message: `تم تسعير المنتج الذي قمت بتكويده، يمكنك الاطلاع على الأسعار الآن.`,
          recipientUser: result.createdBy,
          relatedId: parseInt(id),
          relatedTable: 'Products',
          formName: 'frm_Products',
          createdBy: changedBy
        });
      }

      // 🔔 إشعار لـ SalesManager
      await notificationsQueries.createNotificationSmart({
        title: 'تم تسعير منتج جديد',
        message: `قام ${changedBy} بتسعير منتج جديد.`,
        createdBy: changedBy,
        relatedId: parseInt(id),
        formName: 'frm_Products'
      }, 'SalesManager');

      // 🔔 إشعار لـ AccountManager
      await notificationsQueries.createNotificationSmart({
        title: 'تم تسعير منتج جديد',
        message: `قام ${changedBy} بتسعير منتج جديد.`,
        createdBy: changedBy,
        relatedId: parseInt(id),
        formName: 'frm_Products'
      }, 'AccountManager');

      // 🔔 إشعار لـ Admin
      await notificationsQueries.createNotificationSmart({
        title: 'تم تسعير منتج جديد',
        message: `قام ${changedBy} بتسعير منتج جديد.`,
        createdBy: changedBy,
        relatedId: parseInt(id),
        formName: 'frm_Products'
      }, 'Admin');

    } catch (notifErr) {
      console.error('فشل إرسال الإشعار:', notifErr);
    }

    return res.json({
      success: true,
      salePricePremium: result.salePricePremium,
      salePriceElite: result.salePriceElite,
      message: 'تم التسعير بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تسعير المنتج:', err);
    return errorResponse(res, 'فشل التسعير', 500, err.message);
  }
}

// =============================================
// 💵 تعديل سعر البيع (Admin / AccountManager)
// =============================================

async function updateSalePrice(req, res) {
  try {
    const { id } = req.params;
    const { priceType, newSalePrice, changedBy, reason, clientTime } = req.body;

    // التحقق من البيانات
    if (!priceType || !newSalePrice) {
      return errorResponse(res, 'نوع السعر والسعر الجديد مطلوبين', 400);
    }
    if (!['Premium', 'Elite'].includes(priceType)) {
      return errorResponse(res, 'نوع السعر يجب أن يكون Premium أو Elite', 400);
    }
    if (!changedBy) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    const result = await pricingQueries.updateSalePrice(
      id, priceType, newSalePrice, changedBy, reason, clientTime
    );

    // 🔔 إشعار للسيلز + SalesManager
    try {
      if (result.createdBy && result.createdBy !== changedBy) {
        await notificationsQueries.createNotification({
          title: 'تم تعديل سعر البيع',
          message: `تم تعديل سعر بيع ${priceType} للمنتج بواسطة ${changedBy}.`,
          recipientUser: result.createdBy,
          relatedId: parseInt(id),
          relatedTable: 'Products',
          formName: 'frm_Products',
          createdBy: changedBy
        });
      }

      await notificationsQueries.createNotificationSmart({
        title: 'تم تعديل سعر البيع',
        message: `قام ${changedBy} بتعديل سعر بيع ${priceType}.`,
        createdBy: changedBy,
        relatedId: parseInt(id),
        formName: 'frm_Products'
      }, 'SalesManager');

    } catch (notifErr) {
      console.error('فشل إرسال الإشعار:', notifErr);
    }

    return res.json({
      success: true,
      message: 'تم تعديل سعر البيع بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل سعر البيع:', err);
    return errorResponse(res, 'فشل تعديل السعر', 500, err.message);
  }
}

// =============================================
// 📝 طلبات تعديل الأسعار
// =============================================

// إنشاء طلب تعديل (Sales)
async function createPriceRequest(req, res) {
  try {
    const { id } = req.params;
    const { priceType, currentPrice, requestedPrice, reason, requestedBy, clientTime } = req.body;

    if (!priceType || !requestedPrice || !reason) {
      return errorResponse(res, 'نوع السعر والسعر المطلوب والسبب مطلوبين', 400);
    }
    if (!['Premium', 'Elite'].includes(priceType)) {
      return errorResponse(res, 'نوع السعر يجب أن يكون Premium أو Elite', 400);
    }

    const requestId = await pricingQueries.createPriceChangeRequest({
      productId: id,
      priceType,
      currentPrice,
      requestedPrice,
      reason,
      requestedBy,
      clientTime
    });

    // 🔔 إشعار لـ SalesManager
    try {
      await notificationsQueries.createNotificationSmart({
        title: 'طلب تعديل سعر جديد',
        message: `${requestedBy} يطلب تعديل سعر ${priceType} من ${currentPrice} إلى ${requestedPrice}. السبب: ${reason}`,
        createdBy: requestedBy,
        relatedId: requestId,
        formName: 'frm_PriceRequests'
      }, 'SalesManager');
    } catch (notifErr) {
      console.error('فشل إرسال الإشعار:', notifErr);
    }

    return res.json({
      success: true,
      requestId,
      message: 'تم إرسال طلب التعديل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إنشاء طلب التعديل:', err);
    return errorResponse(res, 'فشل إرسال الطلب', 500, err.message);
  }
}

// جلب الطلبات المعلقة (SalesManager)
async function getPendingRequests(req, res) {
  try {
    const requests = await pricingQueries.getPendingRequests();
    return res.json(requests);
  } catch (err) {
    console.error('خطأ في جلب الطلبات:', err);
    return errorResponse(res, 'فشل تحميل الطلبات', 500, err.message);
  }
}

// جلب طلباتي (Sales)
async function getMyRequests(req, res) {
  try {
    const { username } = req.query;
    if (!username) return errorResponse(res, 'اسم المستخدم مطلوب', 400);

    const requests = await pricingQueries.getMyRequests(username);
    return res.json(requests);
  } catch (err) {
    console.error('خطأ في جلب الطلبات:', err);
    return errorResponse(res, 'فشل تحميل الطلبات', 500, err.message);
  }
}

// جلب كل الطلبات (Admin)
async function getAllRequests(req, res) {
  try {
    const requests = await pricingQueries.getAllRequests();
    return res.json(requests);
  } catch (err) {
    console.error('خطأ في جلب الطلبات:', err);
    return errorResponse(res, 'فشل تحميل الطلبات', 500, err.message);
  }
}

// موافقة على طلب (SalesManager)
async function approveRequest(req, res) {
  try {
    const { id } = req.params;
    const { reviewedBy, reviewNotes, clientTime } = req.body;

    if (!reviewedBy) return errorResponse(res, 'اسم المستخدم مطلوب', 400);

    const result = await pricingQueries.approveRequest(id, reviewedBy, reviewNotes, clientTime);

    // 🔔 إشعار للسيلز
    try {
      await notificationsQueries.createNotification({
        title: '✅ تمت الموافقة على طلب التعديل',
        message: `تمت الموافقة على طلب تعديل سعر ${result.priceType} من ${result.oldPrice} إلى ${result.newPrice}. ${reviewNotes ? 'السبب: ' + reviewNotes : ''}`,
        recipientUser: result.requestedBy,
        relatedId: parseInt(id),
        relatedTable: 'PriceChangeRequests',
        formName: 'frm_PriceRequests',
        createdBy: reviewedBy
      });

      // 🔔 إشعار لـ AccountManager
      await notificationsQueries.createNotificationSmart({
        title: 'تم تعديل سعر البيع',
        message: `وافق ${reviewedBy} على تعديل سعر ${result.priceType} للمنتج.`,
        createdBy: reviewedBy,
        relatedId: result.productId,
        formName: 'frm_Products'
      }, 'AccountManager');

      // 🔔 إشعار لـ Admin
      await notificationsQueries.createNotificationSmart({
        title: 'تم تعديل سعر البيع',
        message: `وافق ${reviewedBy} على تعديل سعر ${result.priceType} للمنتج.`,
        createdBy: reviewedBy,
        relatedId: result.productId,
        formName: 'frm_Products'
      }, 'Admin');

    } catch (notifErr) {
      console.error('فشل إرسال الإشعار:', notifErr);
    }

    return res.json({
      success: true,
      message: 'تمت الموافقة على الطلب بنجاح'
    });
  } catch (err) {
    console.error('خطأ في الموافقة:', err);
    return errorResponse(res, 'فشل الموافقة على الطلب', 500, err.message);
  }
}

// رفض طلب (SalesManager)
async function rejectRequest(req, res) {
  try {
    const { id } = req.params;
    const { reviewedBy, reviewNotes, clientTime } = req.body;

    if (!reviewedBy) return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    if (!reviewNotes) return errorResponse(res, 'سبب الرفض مطلوب', 400);

    const result = await pricingQueries.rejectRequest(id, reviewedBy, reviewNotes, clientTime);

    // 🔔 إشعار للسيلز بالرفض
    try {
      await notificationsQueries.createNotification({
        title: '❌ تم رفض طلب التعديل',
        message: `تم رفض طلب تعديل السعر. السبب: ${reviewNotes}`,
        recipientUser: result.requestedBy,
        relatedId: parseInt(id),
        relatedTable: 'PriceChangeRequests',
        formName: 'frm_PriceRequests',
        createdBy: reviewedBy
      });
    } catch (notifErr) {
      console.error('فشل إرسال الإشعار:', notifErr);
    }

    return res.json({
      success: true,
      message: 'تم رفض الطلب'
    });
  } catch (err) {
    console.error('خطأ في الرفض:', err);
    return errorResponse(res, 'فشل رفض الطلب', 500, err.message);
  }
}

// =============================================
// 📊 تاريخ الأسعار
// =============================================

async function getPriceHistory(req, res) {
  try {
    const { id } = req.params;
    const history = await pricingQueries.getProductPriceHistory(id);
    return res.json(history);
  } catch (err) {
    console.error('خطأ في جلب تاريخ الأسعار:', err);
    return errorResponse(res, 'فشل تحميل تاريخ الأسعار', 500, err.message);
  }
}

// =============================================
// تصدير الدوال
// =============================================
module.exports = {
  // نسب الربح
  getActiveMargins,
  getMarginsHistory,
  updateMargins,
  // تسعير المصنع
  updateProductPricing,
  // تعديل سعر البيع
  updateSalePrice,
  // طلبات التعديل
  createPriceRequest,
  getPendingRequests,
  getMyRequests,
  getAllRequests,
  approveRequest,
  rejectRequest,
  // تاريخ الأسعار
  getPriceHistory
};