const cashboxQueries = require('./cashbox.queries');
const cashboxReviewQueries = require('./cashbox-review.queries');
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

// جلب الخزائن النشطة فقط — مطابق لبلازور activeOnly:true
async function getActive(req, res) {
  try {
    const cashboxes = await cashboxQueries.getActiveCashboxes();
    return res.json(cashboxes);
  } catch (err) {
    console.error('خطأ في جلب الخزائن النشطة:', err);
    return errorResponse(res, 'فشل تحميل الخزائن النشطة', 500, err.message);
  }
}



// جلب خزينة بالـ ID — مع تحقق من صحة الرقم (زي بلازور: CashBoxID رقمي فقط)
async function getById(req, res) {
  try {
    const { id } = req.params;
    const parsed = Number(id);
    if (!Number.isInteger(parsed) || parsed <= 0) {
      return errorResponse(res, 'معرّف الخزينة غير صالح', 400, 'INVALID_CASHBOX_ID');
    }
    const cashbox = await cashboxQueries.getCashboxById(parsed);

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
    const { cashboxId, from, startDate, to, endDate } = req.query;
    const summary = await cashboxQueries.getCashboxSummary(
      cashboxId, from || startDate || null, to || endDate || null,
    );
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب الملخص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// جلب حركات الخزينة
async function getTransactions(req, res) {
  try {
    const { cashboxId, startDate, endDate, transactionType, referenceType, search, page, limit } = req.query;
    const result = await cashboxQueries.getCashboxTransactions(
      cashboxId, startDate, endDate, transactionType, referenceType, search, page, limit
    );
    return res.json(result);
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
    return errorResponse(res, err.message || 'فشل إنشاء الخزينة', err.statusCode || 500, err.message);
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
    return errorResponse(res, err.message || 'فشل تعديل الخزينة', err.statusCode || 500, err.message);
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
    return errorResponse(res, err.message || 'فشل إضافة الحركة', err.statusCode || 500, err.message);
  }
}

// تحويل بين خزينتين
async function transfer(req, res) {
  try {
    const { cashBoxIdFrom, cashBoxIdTo, cashBoxFromName, cashBoxToName, amount, notes, createdBy } = req.body;

    if (!cashBoxIdFrom || !cashBoxIdTo || !amount) {
      return errorResponse(res, 'البيانات غير مكتملة', 400);
    }

    if (cashBoxIdFrom === cashBoxIdTo) {
      return errorResponse(res, 'الخزنة المصدر والمستقبلة يجب أن تكونا مختلفتين', 400);
    }

    if (amount <= 0) {
      return errorResponse(res, 'المبلغ يجب أن يكون أكبر من صفر', 400);
    }

    const result = await cashboxQueries.createTransfer(req.body);

    return res.json({
      success: true,
      ...result,
      message: 'تم التحويل بنجاح'
    });
  } catch (err) {
    console.error('خطأ في التحويل:', err);
    return errorResponse(res, err.message || 'فشل التحويل', err.statusCode || 500, err.message);
  }
}

// ══════════════════════════════════════════
// ✅ دوال داشبورد الخزينة
// ══════════════════════════════════════════

// إحصائيات عامة
async function getDashboardStats(req, res) {
  try {
    const { period } = req.query;
    const stats = await cashboxQueries.getDashboardStats(period || 'month');
    return res.json(stats);
  } catch (err) {
    console.error('خطأ في جلب الإحصائيات:', err);
    return errorResponse(res, 'فشل تحميل الإحصائيات', 500, err.message);
  }
}

// بيانات الرسم البياني
async function getChartData(req, res) {
  try {
    const { days } = req.query;
    const data = await cashboxQueries.getChartData(parseInt(days) || 7);
    return res.json(data);
  } catch (err) {
    console.error('خطأ في جلب بيانات الرسم:', err);
    return errorResponse(res, 'فشل تحميل بيانات الرسم', 500, err.message);
  }
}

// توزيع المصروفات
async function getDistribution(req, res) {
  try {
    const { period } = req.query;
    const data = await cashboxQueries.getDistribution(period || 'month');
    return res.json(data);
  } catch (err) {
    console.error('خطأ في جلب التوزيع:', err);
    return errorResponse(res, 'فشل تحميل التوزيع', 500, err.message);
  }
}

// رصيد كل خزنة
async function getCashboxBalances(req, res) {
  try {
    const data = await cashboxQueries.getCashboxBalances();
    return res.json(data);
  } catch (err) {
    console.error('خطأ في جلب الأرصدة:', err);
    return errorResponse(res, 'فشل تحميل الأرصدة', 500, err.message);
  }
}

// آخر الحركات
async function getRecentTransactions(req, res) {
  try {
    const { limit } = req.query;
    const data = await cashboxQueries.getRecentTransactions(parseInt(limit) || 5);
    return res.json(data);
  } catch (err) {
    console.error('خطأ في جلب آخر الحركات:', err);
    return errorResponse(res, 'فشل تحميل آخر الحركات', 500, err.message);
  }
}

// مقارنة شهرية
async function getMonthlyComparison(req, res) {
  try {
    const data = await cashboxQueries.getMonthlyComparison();
    return res.json(data);
  } catch (err) {
    console.error('خطأ في جلب المقارنة:', err);
    return errorResponse(res, 'فشل تحميل المقارنة', 500, err.message);
  }
}

// ═══════════════════════════════════════════════════════════
// 📊 الداشبورد الكامل للخزينة
// ═══════════════════════════════════════════════════════════
async function getFullDashboard(req, res) {
  try {
    const dashboard = await cashboxQueries.getFullDashboard();
    return successResponse(res, dashboard, 'تم جلب الداشبورد بنجاح');
  } catch (err) {
    console.error('❌ getFullDashboard:', err.message);
    return errorResponse(res, 'فشل تحميل الداشبورد', 500, err.message);
  }
}

// عملية يدوية (الأنواع الستة) — POST /api/cashbox/manual
async function createManual(req, res) {
  try {
    const result = await cashboxQueries.createManualOperation({
      ...req.body,
      createdBy: req.auth?.username || req.body.createdBy,
    });
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('خطأ في العملية اليدوية:', err);
    return errorResponse(res, err.message || 'فشل تنفيذ العملية اليدوية', err.statusCode || 500, err.message);
  }
}

// ══════════════════════════════════════════
// مراجعة الخزينة (Item 27) — البوابة في المسارات (canReview)
// ══════════════════════════════════════════
async function getReview(req, res) {
  try {
    const review = await cashboxReviewQueries.getReview(
      req.query.cashboxId, req.query.from, req.query.to,
    );
    return res.json({ success: true, data: review });
  } catch (err) {
    console.error('خطأ في مراجعة الخزينة:', err);
    return errorResponse(res, err.message || 'فشل تحميل مراجعة الخزينة', err.statusCode || 500, err.message);
  }
}

async function getReviewRecent(req, res) {
  try {
    const recent = await cashboxReviewQueries.getRecentStamps();
    return res.json({ success: true, data: recent });
  } catch (err) {
    console.error('خطأ في أختام المراجعة:', err);
    return errorResponse(res, err.message || 'فشل تحميل أختام المراجعة', err.statusCode || 500, err.message);
  }
}

async function stampReview(req, res) {
  try {
    const result = await cashboxReviewQueries.stampReview(
      req.body.cashboxId, req.body.from, req.body.to, req.body.note, req.auth,
    );
    return res.json({ success: true, ...result });
  } catch (err) {
    console.error('خطأ في ختم المراجعة:', err);
    return errorResponse(res, err.message || 'فشل حفظ ختم المراجعة', err.statusCode || 400, err.message);
  }
}

// تصدير الدوال
module.exports = {
  getReview,
  getReviewRecent,
  stampReview,
  createManual,
  getFullDashboard,
  getAll,
  getActive,
  getById,
  getSummary,
  getTransactions,
  create,
  update,
  createTransaction,
  transfer,
   getDashboardStats,
  getChartData,
  getDistribution,
  getCashboxBalances,
  getRecentTransactions,
  getMonthlyComparison
};