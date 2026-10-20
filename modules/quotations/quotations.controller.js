const quotationsQueries = require('./quotations.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const policy = require('../../shared/authorization.policy');
const { errorResponse, notFoundResponse } = require('../../shared/response.helper');
const { sql, connectDB } = require('../../core/database');

function capabilities(auth) {
  return {
    canView: policy.quotations.canView(auth),
    canAdd: policy.quotations.canAdd(auth),
    canEdit: policy.quotations.canEdit(auth),
    canDelete: policy.quotations.canDelete(auth),
    canViewCost: policy.quotations.canViewCost(auth),
    canEditCost: policy.quotations.canEditCost(auth),
    canViewSalePrices: policy.quotations.canViewSalePrices(auth),
    canConvert: policy.quotations.canConvert(auth),
    canApproveDiscount: policy.quotations.canApproveDiscount(auth),
    canExport: policy.quotations.canExport(auth),
    isCostOnlyViewer: policy.quotations.isCostOnlyViewer(auth),
  };
}

async function isProtectedQuotation(quotation, auth) {
  if (!quotation || policy.quotations.canViewProtectedAccountManager(auth)) return false;
  const pool = await connectDB();
  const result = await pool.request()
    .input('username', sql.NVarChar(100), quotation.CreatedBy)
    .query(`SELECT TOP 1 1 AS Protected FROM Users WHERE Username = @username AND Role = N'AccountManager'`);
  return result.recordset.length > 0;
}

async function assertQuotationAccess(id, auth) {
  const quotation = await quotationsQueries.getQuotationById(id);
  if (!quotation) {
    const error = new Error('عرض السعر غير موجود');
    error.statusCode = 404;
    throw error;
  }
  if (await isProtectedQuotation(quotation, auth)) {
    const error = new Error('عرض السعر محمي حسب نطاق صلاحيات الحسابات');
    error.statusCode = 403;
    throw error;
  }
  return quotation;
}

function costForDetail(detail) {
  const tier = String(detail.PricingTier || 'Premium');
  if (detail.SelectedAlternativeID != null) {
    if (tier === 'CClass') return Number(detail.AlternativePurchasePriceCClass || 0);
    if (tier === 'Elite') return Number(detail.AlternativePurchasePriceElite ?? detail.AlternativePurchasePricePremium ?? 0);
    return Number(detail.AlternativePurchasePricePremium || 0);
  }
  if (tier === 'CClass') return Number(detail.PurchasePriceCClass || 0);
  if (tier === 'Elite') return Number(detail.PurchasePriceElite ?? detail.PurchasePrice ?? 0);
  return Number(detail.PurchasePrice || 0);
}

function scopeQuotation(quotation, auth) {
  const scoped = { ...quotation };
  const canCost = policy.quotations.canViewCost(auth);
  const canSale = policy.quotations.canViewSalePrices(auth);
  scoped.PricesMasked = !canSale;
  scoped.capabilities = capabilities(auth);
  scoped.publicUrl = process.env.PUBLIC_WEB_BASE_URL
    ? `${String(process.env.PUBLIC_WEB_BASE_URL).replace(/\/$/, '')}/q/quotation/${quotation.QuotationID}`
    : null;

  scoped.details = (quotation.details || []).map((raw) => {
    const detail = { ...raw };
    if (canCost) detail.UnitCost = costForDetail(detail);
    if (!canCost) {
      delete detail.PurchasePriceCClass;
      delete detail.PurchasePrice;
      delete detail.PurchasePriceElite;
      delete detail.AlternativePurchasePriceCClass;
      delete detail.AlternativePurchasePricePremium;
      delete detail.AlternativePurchasePriceElite;
      delete detail.UnitCost;
    }
    if (!canSale) {
      delete detail.UnitPrice;
      delete detail.TotalAmount;
      delete detail.SuggestedSalePriceCClass;
      delete detail.SuggestedSalePrice;
      delete detail.SuggestedSalePriceElite;
      delete detail.AlternativeSalePriceCClass;
      delete detail.AlternativeSalePricePremium;
      delete detail.AlternativeSalePriceElite;
    }
    return detail;
  });
  if (!canSale) {
    scoped.TotalAmount = 0;
    scoped.DiscountAmount = null;
    scoped.GrandTotal = 0;
    scoped.charges = [];
  }
  return scoped;
}

function scopeListRow(row, auth) {
  const scoped = { ...row };
  const canCost = policy.quotations.canViewCost(auth);
  const canSale = policy.quotations.canViewSalePrices(auth);
  scoped.PricesMasked = !canSale;
  if (!canCost) delete scoped.TotalCost;
  if (!canSale) {
    scoped.TotalAmount = 0;
    scoped.DiscountAmount = null;
    scoped.GrandTotal = 0;
  }
  delete scoped.TotalRows;
  return scoped;
}

async function getAll(req, res) {
  try {
    const filters = {
      search: req.query.search,
      partyId: req.query.partyId,
      employeeId: req.query.employeeId,
      startDate: req.query.startDate,
      endDate: req.query.endDate,
      status: req.query.status,
      converted: req.query.converted,
      pendingOnly: req.query.pendingOnly,
      expired: req.query.expired,
      page: req.query.page,
      limit: req.query.limit,
      sortBy: req.query.sortBy,
      sortDirection: req.query.sortDirection,
    };
    const [list, stats] = await Promise.all([
      quotationsQueries.getQuotations(filters, req.auth),
      quotationsQueries.getQuotationStats(filters, req.auth),
    ]);
    const canSale = policy.quotations.canViewSalePrices(req.auth);
    const scopedStats = { ...stats };
    if (!canSale) {
      scopedStats.TotalValue = 0;
      scopedStats.ConvertedValue = 0;
      scopedStats.AvgConvertedCustomerValue = 0;
    }
    return res.json({
      success: true,
      data: {
        rows: list.rows.map((row) => scopeListRow(row, req.auth)),
        pagination: {
          page: list.page,
          limit: list.limit,
          total: list.total,
          totalPages: Math.max(Math.ceil(list.total / list.limit), 1),
          hasMore: list.page * list.limit < list.total,
        },
        stats: scopedStats,
        capabilities: capabilities(req.auth),
      },
    });
  } catch (error) {
    console.error('quotations.getAll:', error);
    return errorResponse(res, 'فشل تحميل عروض الأسعار', 500, error.message);
  }
}

async function getById(req, res) {
  try {
    const quotation = await quotationsQueries.getQuotationById(parseInt(req.params.id, 10));
    if (!quotation) return notFoundResponse(res, 'عرض السعر غير موجود');
    if (await isProtectedQuotation(quotation, req.auth)) {
      return errorResponse(res, 'عرض السعر محمي حسب نطاق صلاحيات الحسابات', 403);
    }
    return res.json({ success: true, data: scopeQuotation(quotation, req.auth) });
  } catch (error) {
    console.error('quotations.getById:', error);
    return errorResponse(res, 'فشل تحميل عرض السعر', 500, error.message);
  }
}

async function getLookups(req, res) {
  try {
    const data = await quotationsQueries.getQuotationLookups(
      req.query.partyId ? parseInt(req.query.partyId, 10) : null,
      req.query.search || '',
    );
    return res.json({ success: true, data });
  } catch (error) {
    console.error('quotations.getLookups:', error);
    return errorResponse(res, 'فشل تحميل البيانات الأساسية', 500, error.message);
  }
}

async function getProducts(req, res) {
  try {
    const partyId = parseInt(req.query.partyId, 10);
    if (!partyId) return errorResponse(res, 'العميل مطلوب', 400);
    const rows = await quotationsQueries.getAvailableProducts(
      partyId,
      req.query.warehouseId ? parseInt(req.query.warehouseId, 10) : null,
      req.query.search || '',
    );
    const canSale = policy.quotations.canViewSalePrices(req.auth);
    const canCost = policy.quotations.canViewCost(req.auth);
    const scoped = rows.map((raw) => {
      const row = { ...raw };
      if (!canSale) {
        delete row.SuggestedSalePriceCClass;
        delete row.SuggestedSalePrice;
        delete row.SuggestedSalePriceElite;
      }
      if (!canCost) {
        delete row.PurchasePriceCClass;
        delete row.PurchasePrice;
        delete row.PurchasePriceElite;
      }
      return row;
    });
    return res.json({ success: true, data: scoped });
  } catch (error) {
    console.error('quotations.getProducts:', error);
    return errorResponse(res, 'فشل تحميل المنتجات المتاحة', 500, error.message);
  }
}

async function getAlternatives(req, res) {
  try {
    const rows = await quotationsQueries.getProductAlternatives(parseInt(req.params.productId, 10));
    const canSale = policy.quotations.canViewSalePrices(req.auth);
    const canCost = policy.quotations.canViewCost(req.auth);
    const scoped = rows.map((raw) => {
      const row = { ...raw };
      if (!canSale) {
        delete row.SuggestedSalePriceCClass;
        delete row.SuggestedSalePricePremium;
        delete row.SuggestedSalePriceElite;
      }
      if (!canCost) {
        delete row.PurchasePriceCClass;
        delete row.PurchasePricePremium;
        delete row.PurchasePriceElite;
      }
      return row;
    });
    return res.json({ success: true, data: scoped });
  } catch (error) {
    console.error('quotations.getAlternatives:', error);
    return errorResponse(res, 'فشل تحميل بدائل المنتج', 500, error.message);
  }
}

async function create(req, res) {
  try {
    const result = await quotationsQueries.saveQuotation(null, req.body || {}, req.auth);
    await notifyManagement(result.quotationId, req.auth.username, 'تم إنشاء عرض سعر جديد');
    return res.status(201).json({
      success: true,
      data: result,
      message: 'تم إنشاء عرض السعر بنجاح',
    });
  } catch (error) {
    console.error('quotations.create:', error);
    if (error.code) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message,
        code: error.code,
        allowedDiscount: error.allowedDiscount ?? null,
      });
    }
    return errorResponse(res, error.message || 'فشل إنشاء عرض السعر', error.statusCode || 500, error.message);
  }
}

async function update(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await assertQuotationAccess(id, req.auth);
    const result = await quotationsQueries.saveQuotation(id, req.body || {}, req.auth);
    return res.json({ success: true, data: result, message: 'تم تحديث عرض السعر بنجاح' });
  } catch (error) {
    console.error('quotations.update:', error);
    if (error.code) {
      return res.status(error.statusCode || 400).json({
        success: false,
        message: error.message,
        code: error.code,
        allowedDiscount: error.allowedDiscount ?? null,
      });
    }
    return errorResponse(res, error.message || 'فشل تحديث عرض السعر', error.statusCode || 500, error.message);
  }
}

async function changeStatus(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await assertQuotationAccess(id, req.auth);
    const result = await quotationsQueries.changeQuotationStatus(
      id,
      String(req.body.status || ''),
      req.auth.username,
      { reason: req.body.reason || null },
    );
    return res.json({ success: true, data: result, message: 'تم تحديث حالة عرض السعر' });
  } catch (error) {
    console.error('quotations.changeStatus:', error);
    return errorResponse(res, error.message || 'فشل تغيير الحالة', error.statusCode || 500, error.message);
  }
}

async function remove(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await assertQuotationAccess(id, req.auth);
    await quotationsQueries.deleteQuotation(id, req.auth.username);
    return res.json({ success: true, message: 'تم حذف عرض السعر بنجاح' });
  } catch (error) {
    console.error('quotations.remove:', error);
    return errorResponse(res, error.message || 'فشل حذف عرض السعر', error.statusCode || 500, error.message);
  }
}

async function saveCosts(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await assertQuotationAccess(id, req.auth);
    const changed = await quotationsQueries.updateQuotationItemCosts(
      id,
      req.body.updates,
      req.auth.username,
    );
    return res.json({
      success: true,
      data: { changedProducts: changed },
      message: changed.length ? `تم تحديث تكلفة ${changed.length} صنف` : 'التكاليف مطابقة للحالية',
    });
  } catch (error) {
    console.error('quotations.saveCosts:', error);
    return errorResponse(res, error.message || 'فشل تحديث التكاليف', error.statusCode || 500, error.message);
  }
}

async function requestPricing(req, res) {
  try {
    const quotation = await assertQuotationAccess(
      parseInt(req.params.id, 10),
      req.auth,
    );
    if (quotation.InvoiceID != null) return errorResponse(res, 'لا يمكن طلب تسعير لعرض تم تحويله', 400);
    const reference = quotation.ReferenceNumber || `#${quotation.QuotationID}`;
    const note = String(req.body.note || '').trim();
    const message = note
      ? `طلب تحديث تكاليف عرض السعر ${reference}: ${note}`
      : `طلب تحديث تكاليف عرض السعر ${reference}. برجاء فتح العرض وتحديث تكلفة الأصناف.`;
    for (const role of ['ProductionManager', 'factory']) {
      await notificationsQueries.createNotificationSmart({
        title: 'طلب تسعير عرض سعر',
        message,
        createdBy: req.auth.username,
        formName: 'quotations',
        relatedTable: 'Quotations',
        relatedId: quotation.QuotationID,
      }, role);
    }
    return res.json({ success: true, message: 'تم إرسال طلب التسعير للمصنع' });
  } catch (error) {
    console.error('quotations.requestPricing:', error);
    return errorResponse(res, 'فشل إرسال طلب التسعير', 500, error.message);
  }
}

async function requestDiscount(req, res) {
  try {
    const quotation = req.params.id
      ? await assertQuotationAccess(parseInt(req.params.id, 10), req.auth)
      : null;
    const message = [
      `طلب خصم بواسطة ${req.auth.username}`,
      `عرض السعر: ${quotation?.ReferenceNumber || 'مسودة جديدة'}`,
      `العميل: ${quotation?.PartyName || req.body.partyName || 'غير محدد'}`,
      `الإجمالي: ${quotation?.GrandTotal || req.body.grandTotal || 0}`,
      `الخصم المطلوب: ${req.body.discountAmount || 0}`,
      `السبب: ${req.body.reason || 'بدون سبب'}`,
    ].join('\n');
    for (const role of ['Admin', 'AccountManager', 'SalesManager']) {
      await notificationsQueries.createNotificationSmart({
        title: 'طلب خصم على عرض سعر',
        message,
        createdBy: req.auth.username,
        formName: 'quotations',
        relatedTable: quotation ? 'Quotations' : null,
        relatedId: quotation?.QuotationID || null,
      }, role);
    }
    return res.json({ success: true, message: 'تم إرسال طلب الخصم للمراجعة' });
  } catch (error) {
    console.error('quotations.requestDiscount:', error);
    return errorResponse(res, 'فشل إرسال طلب الخصم', 500, error.message);
  }
}

async function convertToInvoice(req, res) {
  try {
    const id = parseInt(req.params.id, 10);
    await assertQuotationAccess(id, req.auth);
    const result = await quotationsQueries.convertQuotationToInvoice(
      id,
      req.body || {},
      req.auth,
    );
    await notifyManagement(id, req.auth.username, 'تم تحويل عرض السعر إلى فاتورة');
    return res.json({
      success: true,
      data: result,
      message: `تم التحويل إلى الفاتورة ${result.invoiceReference} بنجاح`,
    });
  } catch (error) {
    console.error('quotations.convertToInvoice:', error);
    return errorResponse(res, error.message || 'فشل تحويل عرض السعر', error.statusCode || 500, error.message);
  }
}

async function getPublic(req, res) {
  try {
    const quotation = await quotationsQueries.getPublicQuotation(parseInt(req.params.id, 10));
    if (!quotation) return notFoundResponse(res, 'عرض السعر غير موجود');
    return res.json({ success: true, data: quotation });
  } catch (error) {
    console.error('quotations.getPublic:', error);
    return errorResponse(res, 'فشل تحميل عرض السعر', 500, error.message);
  }
}

async function publicRespond(req, res) {
  try {
    const quotationId = parseInt(req.params.id, 10);
    const quotation = await quotationsQueries.getPublicQuotation(quotationId);
    if (!quotation) return notFoundResponse(res, 'عرض السعر غير موجود');
    if (quotation.InvoiceID != null || ['Accepted', 'Rejected', 'Converted'].includes(quotation.Status)) {
      return errorResponse(res, 'تم تسجيل الرد على عرض السعر من قبل', 409);
    }
    if (quotation.ValidUntil && new Date(quotation.ValidUntil).getTime() < new Date().setHours(0, 0, 0, 0)) {
      return errorResponse(res, 'انتهت صلاحية عرض السعر', 400);
    }
    const accepted = req.body.accepted === true || req.body.status === 'Accepted';
    const status = accepted ? 'Accepted' : 'Rejected';
    const actor = String(req.body.customerName || 'Public Customer').trim();
    const result = await quotationsQueries.changeQuotationStatus(
      quotationId,
      status,
      actor,
      { isPublic: true, reason: accepted ? null : req.body.reason },
    );
    return res.json({
      success: true,
      data: result,
      message: accepted ? 'تم تسجيل الموافقة' : 'تم تسجيل الرد',
    });
  } catch (error) {
    console.error('quotations.publicRespond:', error);
    return errorResponse(res, error.message || 'فشل تسجيل الرد', error.statusCode || 500, error.message);
  }
}

async function notifyManagement(quotationId, actor, action) {
  try {
    const quotation = await quotationsQueries.getQuotationById(quotationId);
    if (!quotation) return;
    const message = `${action} - ${quotation.ReferenceNumber || `#${quotationId}`} للعميل ${quotation.PartyName || ''} بواسطة ${actor}`;
    for (const role of ['Admin', 'SalesManager', 'AccountManager']) {
      await notificationsQueries.createNotificationSmart({
        title: 'إشعار عرض سعر',
        message,
        createdBy: actor,
        formName: 'quotations',
        relatedTable: 'Quotations',
        relatedId: quotationId,
      }, role);
    }
  } catch (error) {
    console.error('quotation notification:', error.message);
  }
}

module.exports = {
  getAll,
  getById,
  getLookups,
  getProducts,
  getAlternatives,
  create,
  update,
  changeStatus,
  remove,
  saveCosts,
  requestPricing,
  requestDiscount,
  convertToInvoice,
  getPublic,
  publicRespond,
};
