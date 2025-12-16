const opportunitiesQueries = require('./opportunities.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// ===================================
// 📋 Lookups Controllers
// ===================================

// جلب مراحل البيع
async function getStages(req, res) {
  try {
    const stages = await opportunitiesQueries.getStages();
    return res.json(stages);
  } catch (err) {
    console.error('خطأ في جلب المراحل:', err);
    return errorResponse(res, 'فشل تحميل المراحل', 500, err.message);
  }
}

// جلب مصادر التواصل
async function getSources(req, res) {
  try {
    const sources = await opportunitiesQueries.getSources();
    return res.json(sources);
  } catch (err) {
    console.error('خطأ في جلب مصادر التواصل:', err);
    return errorResponse(res, 'فشل تحميل المصادر', 500, err.message);
  }
}

// جلب حالات التواصل
async function getStatuses(req, res) {
  try {
    const statuses = await opportunitiesQueries.getStatuses();
    return res.json(statuses);
  } catch (err) {
    console.error('خطأ في جلب حالات التواصل:', err);
    return errorResponse(res, 'فشل تحميل الحالات', 500, err.message);
  }
}

// جلب أنواع الإعلانات
async function getAdTypes(req, res) {
  try {
    const adTypes = await opportunitiesQueries.getAdTypes();
    return res.json(adTypes);
  } catch (err) {
    console.error('خطأ في جلب أنواع الإعلانات:', err);
    return errorResponse(res, 'فشل تحميل أنواع الإعلانات', 500, err.message);
  }
}

// جلب فئات الاهتمام
async function getCategories(req, res) {
  try {
    const categories = await opportunitiesQueries.getCategories();
    return res.json(categories);
  } catch (err) {
    console.error('خطأ في جلب فئات الاهتمام:', err);
    return errorResponse(res, 'فشل تحميل الفئات', 500, err.message);
  }
}

// جلب أسباب الخسارة
async function getLostReasons(req, res) {
  try {
    const reasons = await opportunitiesQueries.getLostReasons();
    return res.json(reasons);
  } catch (err) {
    console.error('خطأ في جلب أسباب الخسارة:', err);
    return errorResponse(res, 'فشل تحميل أسباب الخسارة', 500, err.message);
  }
}

// جلب أنواع المهام
async function getTaskTypes(req, res) {
  try {
    const taskTypes = await opportunitiesQueries.getTaskTypes();
    return res.json(taskTypes);
  } catch (err) {
    console.error('خطأ في جلب أنواع المهام:', err);
    return errorResponse(res, 'فشل تحميل أنواع المهام', 500, err.message);
  }
}

// جلب الموظفين
async function getEmployees(req, res) {
  try {
    const employees = await opportunitiesQueries.getEmployees();
    return res.json(employees);
  } catch (err) {
    console.error('خطأ في جلب الموظفين:', err);
    return errorResponse(res, 'فشل تحميل الموظفين', 500, err.message);
  }
}

// ===================================
// 📊 الإحصائيات
// ===================================

// ملخص الفرص
async function getSummary(req, res) {
  try {
    const summary = await opportunitiesQueries.getOpportunitiesSummary();
    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب ملخص الفرص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// ===================================
// 🎯 الفرص - CRUD
// ===================================

// جلب كل الفرص
async function getAll(req, res) {
  try {
    const { search, stageId, sourceId, employeeId, followUpStatus } = req.query;
    const opportunities = await opportunitiesQueries.getAllOpportunities({
      search,
      stageId,
      sourceId,
      employeeId,
      followUpStatus
    });
    return res.json(opportunities);
  } catch (err) {
    console.error('خطأ في جلب الفرص:', err);
    return errorResponse(res, 'فشل تحميل الفرص', 500, err.message);
  }
}

// التحقق من وجود فرصة مفتوحة للعميل
async function checkOpenOpportunity(req, res) {
  try {
    const { partyId } = req.params;
    const result = await opportunitiesQueries.checkOpenOpportunity(partyId);
    return res.json(result);
  } catch (err) {
    console.error('خطأ في التحقق من الفرصة:', err);
    return errorResponse(res, 'فشل التحقق', 500, err.message);
  }
}

// جلب فرصة بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const opportunity = await opportunitiesQueries.getOpportunityById(id);

    if (!opportunity) {
      return notFoundResponse(res, 'الفرصة غير موجودة');
    }

    return res.json(opportunity);
  } catch (err) {
    console.error('خطأ في جلب تفاصيل الفرصة:', err);
    return errorResponse(res, 'فشل تحميل الفرصة', 500, err.message);
  }
}

// إضافة فرصة جديدة
async function create(req, res) {
  try {
    const { partyId } = req.body;

    if (!partyId) {
      return errorResponse(res, 'العميل مطلوب', 400);
    }

    const opportunityId = await opportunitiesQueries.createOpportunity(req.body);

    return res.json({
      success: true,
      opportunityId: opportunityId,
      message: 'تم إضافة الفرصة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الفرصة:', err);
    return errorResponse(res, 'فشل إضافة الفرصة', 500, err.message);
  }
}

// تعديل فرصة
async function update(req, res) {
  try {
    const { id } = req.params;

    await opportunitiesQueries.updateOpportunity(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل الفرصة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل الفرصة:', err);
    return errorResponse(res, 'فشل تعديل الفرصة', 500, err.message);
  }
}

// تغيير مرحلة الفرصة
async function updateStage(req, res) {
  try {
    const { id } = req.params;
    const { stageId, updatedBy } = req.body;

    if (!stageId) {
      return errorResponse(res, 'المرحلة مطلوبة', 400);
    }

    await opportunitiesQueries.updateOpportunityStage(id, stageId, updatedBy);

    return res.json({
      success: true,
      message: 'تم تغيير المرحلة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تغيير المرحلة:', err);
    return errorResponse(res, 'فشل تغيير المرحلة', 500, err.message);
  }
}

// حذف فرصة
async function remove(req, res) {
  try {
    const { id } = req.params;

    await opportunitiesQueries.deleteOpportunity(id);

    return res.json({
      success: true,
      message: 'تم حذف الفرصة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حذف الفرصة:', err);
    return errorResponse(res, 'فشل حذف الفرصة', 500, err.message);
  }
}

// تصدير الدوال
module.exports = {
  // Lookups
  getStages,
  getSources,
  getStatuses,
  getAdTypes,
  getCategories,
  getLostReasons,
  getTaskTypes,
  getEmployees,
  // Summary
  getSummary,
  // CRUD
  getAll,
  checkOpenOpportunity,
  getById,
  create,
  update,
  updateStage,
  remove
};