// opportunities.controller.js

const opportunitiesQueries = require('./opportunities.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');

// ===================================
// 📋 Lookups Controllers
// ===================================

async function getStages(req, res) {
  try {
    const stages = await opportunitiesQueries.getStages();
    return res.json(stages);
  } catch (err) {
    console.error('خطأ في جلب المراحل:', err);
    return errorResponse(res, 'فشل تحميل المراحل', 500, err.message);
  }
}

async function getSources(req, res) {
  try {
    const sources = await opportunitiesQueries.getSources();
    return res.json(sources);
  } catch (err) {
    console.error('خطأ في جلب مصادر التواصل:', err);
    return errorResponse(res, 'فشل تحميل المصادر', 500, err.message);
  }
}

async function getStatuses(req, res) {
  try {
    const statuses = await opportunitiesQueries.getStatuses();
    return res.json(statuses);
  } catch (err) {
    console.error('خطأ في جلب حالات التواصل:', err);
    return errorResponse(res, 'فشل تحميل الحالات', 500, err.message);
  }
}

async function getAdTypes(req, res) {
  try {
    const adTypes = await opportunitiesQueries.getAdTypes();
    return res.json(adTypes);
  } catch (err) {
    console.error('خطأ في جلب أنواع الإعلانات:', err);
    return errorResponse(res, 'فشل تحميل أنواع الإعلانات', 500, err.message);
  }
}

async function getCategories(req, res) {
  try {
    const categories = await opportunitiesQueries.getCategories();
    return res.json(categories);
  } catch (err) {
    console.error('خطأ في جلب فئات الاهتمام:', err);
    return errorResponse(res, 'فشل تحميل الفئات', 500, err.message);
  }
}

async function getLostReasons(req, res) {
  try {
    const reasons = await opportunitiesQueries.getLostReasons();
    return res.json(reasons);
  } catch (err) {
    console.error('خطأ في جلب أسباب الخسارة:', err);
    return errorResponse(res, 'فشل تحميل أسباب الخسارة', 500, err.message);
  }
}

async function getTaskTypes(req, res) {
  try {
    const taskTypes = await opportunitiesQueries.getTaskTypes();
    return res.json(taskTypes);
  } catch (err) {
    console.error('خطأ في جلب أنواع المهام:', err);
    return errorResponse(res, 'فشل تحميل أنواع المهام', 500, err.message);
  }
}

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
// 📊 ملخص الفرص (Summary)
// ===================================

async function getSummary(req, res) {
  try {
    const { employeeId, sourceId, adTypeId, stageId, dateFrom, dateTo } = req.query;

    const summary = await opportunitiesQueries.getOpportunitiesSummary({
      employeeId,
      sourceId,
      adTypeId,
      stageId,
      dateFrom,
      dateTo
    });

    return res.json(summary);
  } catch (err) {
    console.error('خطأ في جلب ملخص الفرص:', err);
    return errorResponse(res, 'فشل تحميل الملخص', 500, err.message);
  }
}

// ===================================
// 🎯 جلب كل الفرص مع كل الفلاتر
// ===================================

async function getAll(req, res) {
  try {
    const {
      search,
      stageId,
      sourceId,
      adTypeId,
      employeeId,
      followUpStatus,
      sortBy,
      dateFrom,
      dateTo,
      page = 1,
      limit = 30
    } = req.query;

    // للتأكد إن الفلاتر واصلة
    console.log('فلاتر الفرص:', { search, stageId, sourceId, adTypeId, employeeId, followUpStatus, sortBy, dateFrom, dateTo });

const opportunities = await opportunitiesQueries.getAllOpportunities({
  search,
  stageId,
  sourceId,
  adTypeId,
  employeeId,
  followUpStatus,
  sortBy,
  dateFrom,
  dateTo,
  page,
  limit
});

const total = await opportunitiesQueries.getTotalOpportunitiesCount({
  search,
  stageId,
  sourceId,
  adTypeId,
  employeeId,
  followUpStatus,
  dateFrom,
  dateTo
});

return res.json({
  data: opportunities,
  pagination: {
    page: parseInt(page),
    limit: parseInt(limit),
    total: total,
    totalPages: Math.ceil(total / limit),
    hasMore: page * limit < total
  }
});
  } catch (err) {
    console.error('خطأ في جلب الفرص:', err);
    return errorResponse(res, 'فشل تحميل الفرص', 500, err.message);
  }
}

// ===================================
// باقي الدوال (بدون تغيير)
// ===================================

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

async function getById(req, res) {
  try {
    const { id } = req.params;
    const opportunity = await opportunitiesQueries.getOpportunityById(id);
    if (!opportunity) return notFoundResponse(res, 'الفرصة غير موجودة');
    return res.json(opportunity);
  } catch (err) {
    console.error('خطأ في جلب تفاصيل الفرصة:', err);
    return errorResponse(res, 'فشل تحميل الفرصة', 500, err.message);
  }
}

async function create(req, res) {
  try {
    const { partyId } = req.body;
    if (!partyId) return errorResponse(res, 'العميل مطلوب', 400);

    const opportunityId = await opportunitiesQueries.createOpportunity(req.body);

    return res.json({
      success: true,
      opportunityId: opportunityId.OpportunityID || opportunityId,
      message: 'تم إضافة الفرصة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الفرصة:', err);
    return errorResponse(res, 'فشل إضافة الفرصة', 500, err.message);
  }
}

async function update(req, res) {
  try {
    const { id } = req.params;
    const body = req.body;
    const stageId = body.stageId ?? body.StageID ?? body.StageId ?? body.stageID;
    const isClosure = stageId == 3 || stageId == 4 || stageId == 5;
    if (isClosure) {
      const actorRole = (body.actorRole || req.headers['x-user-role'] || '').toString().toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
      const canDirect = actorRole === 'admin' || actorRole === 'salesmanager' || actorRole === 'generalmanager' || actorRole === 'gm' || actorRole === 'general';
      // لو مش مصرح و role موجود (يعني من فلاتر) → حول لطلب موافقة مع إشعار GM
      if (!canDirect && actorRole) {
        const result = await opportunitiesQueries.requestClosureApproval(parseInt(id, 10), {
          requestedStageId: parseInt(stageId, 10),
          lostReasonId: body.lostReasonId ?? body.LostReasonID,
          requestReasonNotes: body.lostNotes || body.requestReasonNotes || body.notes || body.reason,
          requestSource: body.requestSource || 'Flutter-Edit',
        }, body.updatedBy || body.userName || 'MobileUser');
        if (!result.success) return res.json(result);
        return res.json({ success: true, requiresApproval: true, requestId: result.requestId, message: result.message });
      }
    }
    await opportunitiesQueries.updateOpportunity(id, req.body);
    return res.json({ success: true, message: 'تم تعديل الفرصة بنجاح' });
  } catch (err) {
    console.error('خطأ في تعديل الفرصة:', err);
    return errorResponse(res, 'فشل تعديل الفرصة', 500, err.message);
  }
}

// ── طلبات إغلاق الفرص - مطابقة بلازور ──
async function requestClosure(req, res) {
  try {
    const { id } = req.params;
    const result = await opportunitiesQueries.requestClosureApproval(parseInt(id, 10), {
      requestedStageId: req.body.requestedStageId || req.body.stageId || req.body.RequestedStageId,
      lostReasonId: req.body.lostReasonId || req.body.LostReasonID,
      requestReasonNotes: req.body.requestReasonNotes || req.body.lostNotes || req.body.reason || req.body.notes,
      requestSource: req.body.requestSource || 'Flutter',
    }, req.body.userName || req.body.updatedBy || 'MobileUser');
    if (!result.success) return res.json(result);
    return res.json({ success: true, requestId: result.requestId, message: result.message });
  } catch (err) {
    console.error('requestClosure:', err);
    return errorResponse(res, 'فشل إرسال طلب الإغلاق', 500, err.message);
  }
}

async function getClosureRequests(req, res) {
  try {
    const list = await opportunitiesQueries.getClosureApprovalRequests(req.query.status || null);
    return res.json(list);
  } catch (err) {
    console.error('getClosureRequests:', err);
    return errorResponse(res, 'فشل تحميل طلبات الإغلاق', 500, err.message);
  }
}

async function getPendingClosureByOpp(req, res) {
  try {
    const row = await opportunitiesQueries.getPendingClosureByOpportunity(parseInt(req.params.id, 10));
    return res.json(row || null);
  } catch (err) {
    console.error('getPendingClosure:', err);
    return errorResponse(res, 'فشل جلب طلب الإغلاق', 500, err.message);
  }
}

async function approveClosure(req, res) {
  try {
    const actorRole = (req.body.actorRole || req.headers['x-user-role'] || '').toString().toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
    const canApprove = actorRole === 'admin' || actorRole === 'salesmanager' || actorRole === 'generalmanager' || actorRole === 'gm';
    if (actorRole && !canApprove) return errorResponse(res, 'الاعتماد للمدير العام أو مدير المبيعات فقط', 403);
    const result = await opportunitiesQueries.approveClosureRequest(parseInt(req.params.requestId, 10), req.body.userName || 'GM', req.body.reviewNotes || req.body.decisionNotes);
    if (!result.success) return res.json(result);
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('approveClosure:', err);
    return errorResponse(res, 'فشل اعتماد الطلب', 500, err.message);
  }
}

async function rejectClosure(req, res) {
  try {
    const actorRole = (req.body.actorRole || req.headers['x-user-role'] || '').toString().toLowerCase().replace(/\s+/g, '').replace(/_/g, '');
    const canApprove = actorRole === 'admin' || actorRole === 'salesmanager' || actorRole === 'generalmanager' || actorRole === 'gm';
    if (actorRole && !canApprove) return errorResponse(res, 'الرفض للمدير العام أو مدير المبيعات فقط', 403);
    const result = await opportunitiesQueries.rejectClosureRequest(parseInt(req.params.requestId, 10), req.body.userName || 'GM', req.body.reviewNotes || req.body.decisionNotes);
    if (!result.success) return res.json(result);
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('rejectClosure:', err);
    return errorResponse(res, 'فشل رفض الطلب', 500, err.message);
  }
}

async function executeClosure(req, res) {
  try {
    const result = await opportunitiesQueries.executeApprovedClosure(parseInt(req.params.id, 10), req.body.userName || 'MobileUser');
    if (!result.success) return res.json(result);
    return res.json({ success: true, message: result.message });
  } catch (err) {
    console.error('executeClosure:', err);
    return errorResponse(res, 'فشل تنفيذ الإغلاق', 500, err.message);
  }
}

async function updateStage(req, res) {
  try {
    const { id } = req.params;
    const { stageId, updatedBy } = req.body;
    if (!stageId) return errorResponse(res, 'المرحلة مطلوبة', 400);

    await opportunitiesQueries.updateOpportunityStage(id, stageId, updatedBy);
    return res.json({ success: true, message: 'تم تغيير المرحلة بنجاح' });
  } catch (err) {
    console.error('خطأ في تغيير المرحلة:', err);
    return errorResponse(res, 'فشل تغيير المرحلة', 500, err.message);
  }
}

async function remove(req, res) {
  try {
    const { id } = req.params;
    await opportunitiesQueries.deleteOpportunity(id);
    return res.json({ success: true, message: 'تم حذف الفرصة بنجاح' });
  } catch (err) {
    console.error('خطأ في حذف الفرصة:', err);
    return errorResponse(res, 'فشل حذف الفرصة', 500, err.message);
  }
}

// ===================================
// ➕ إنشاء فرصة مع عميل جديد
// ===================================

async function createWithClient(req, res) {
  try {
    const { clientName, phone1, createdBy } = req.body;

    // التحقق من البيانات المطلوبة
    if (!clientName || !clientName.trim()) {
      return errorResponse(res, 'اسم العميل مطلوب', 400);
    }

    if (!phone1 || !phone1.trim()) {
      return errorResponse(res, 'رقم الهاتف مطلوب', 400);
    }

    if (!createdBy) {
      return errorResponse(res, 'اسم المستخدم مطلوب', 400);
    }

    const result = await opportunitiesQueries.createOpportunityWithClient(req.body);

    if (result.success) {
      return res.json({
        success: true,
        opportunityId: result.opportunityId,
        partyId: result.partyId,
        isNewClient: result.isNewClient,
        message: result.message
      });
    } else {
      return res.json({
        success: false,
        message: result.message,
        existingOpportunityId: result.existingOpportunityId,
        partyId: result.partyId
      });
    }

  } catch (err) {
    console.error('خطأ في إنشاء الفرصة مع العميل:', err);
    return errorResponse(res, 'فشل إنشاء الفرصة', 500, err.message);
  }
}

// ===================================
// 🔍 البحث عن عميل بالتليفون
// ===================================

async function searchByPhone(req, res) {
  try {
    const { phone } = req.query;

    if (!phone || phone.length < 6) {
      return res.json({ found: false, client: null });
    }

    const result = await opportunitiesQueries.searchClientByPhone(phone);
    return res.json(result);

  } catch (err) {
    console.error('خطأ في البحث عن العميل:', err);
    return errorResponse(res, 'فشل البحث', 500, err.message);
  }
}

// ===================================
// 📊 Pipeline Summary
// ===================================

async function getPipelineSummary(req, res) {
  try {
    const { employeeId, sourceId, adTypeId, dateFrom, dateTo } = req.query;

    const pipeline = await opportunitiesQueries.getPipelineSummary({
      employeeId,
      sourceId,
      adTypeId,
      dateFrom,
      dateTo
    });

    return res.json(pipeline);
  } catch (err) {
    console.error('خطأ في جلب Pipeline Summary:', err);
    return errorResponse(res, 'فشل تحميل ملخص المراحل', 500, err.message);
  }
}

// ===================================
// 🔍 بحث عن عملاء
// ===================================

async function searchClients(req, res) {
  try {
    const { q } = req.query;

    if (!q || q.length < 2) {
      return res.json([]);
    }

    const clients = await opportunitiesQueries.searchClients(q);
    return res.json(clients);
  } catch (err) {
    console.error('خطأ في البحث عن العملاء:', err);
    return errorResponse(res, 'فشل البحث', 500, err.message);
  }
}

// تصدير الكل

// KANBAN BOARD
async function getKanban(req, res) {
  try {
    const board = await opportunitiesQueries.getKanbanBoard(req.query);
    return res.json({ success: true, data: board });
  } catch (err) {
    console.error('opportunities.getKanban:', err);
    return errorResponse(res, 'فشل تحميل لوحة المبيعات', 500, err.message);
  }
}


module.exports = {
  getStages,
  getSources,
  getStatuses,
  getAdTypes,
  getCategories,
  getLostReasons,
  getTaskTypes,
  getEmployees,
  getSummary,
  getPipelineSummary,
  getKanban,
  getAll,
  checkOpenOpportunity,
  getById,
  create,
  update,
  updateStage,
  remove,
  createWithClient,
  searchByPhone,
  searchClients,
  // 🛑 Closure Approval - مطابقة بلازور
  requestClosure,
  getClosureRequests,
  getPendingClosureByOpp,
  approveClosure,
  rejectClosure,
  executeClosure,
};