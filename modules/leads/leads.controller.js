const leadsQueries = require('./leads.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

function actorName(req) {
  return (
    req.body?.userName ||
    req.body?.username ||
    req.body?.createdBy ||
    req.query?.userName ||
    req.headers['x-username'] ||
    'MobileUser'
  );
}

// GET /api/leads
async function getAll(req, res) {
  try {
    const result = await leadsQueries.getLeads(req.query);
    return res.json(result);
  } catch (err) {
    console.error('leads.getAll:', err);
    return errorResponse(res, 'فشل تحميل العملاء المحتملين', 500, err.message);
  }
}

// GET /api/leads/stats
async function getStats(req, res) {
  try {
    const stats = await leadsQueries.getStats(req.query);
    return res.json(stats);
  } catch (err) {
    console.error('leads.getStats:', err);
    return errorResponse(res, 'فشل تحميل الإحصائيات', 500, err.message);
  }
}

// GET /api/leads/employees
async function getEmployees(req, res) {
  try {
    const employees = await leadsQueries.getAssignableEmployees();
    return res.json(employees);
  } catch (err) {
    console.error('leads.getEmployees:', err);
    return errorResponse(res, 'فشل تحميل الموظفين', 500, err.message);
  }
}

// GET /api/leads/meta (constants for mobile)
async function getMeta(req, res) {
  return res.json({
    statuses: [
      leadsQueries.STATUSES.NEW,
      leadsQueries.STATUSES.ASSIGNED,
      leadsQueries.STATUSES.CONTACTED,
      leadsQueries.STATUSES.CONVERTED,
      leadsQueries.STATUSES.REJECTED,
    ],
    interactionTypes: Object.values(leadsQueries.INTERACTION_TYPES),
  });
}

// GET /api/leads/filter-options  (cities + project types)
async function getFilterOptions(req, res) {
  try {
    const options = await leadsQueries.getFilterOptions();
    return res.json(options);
  } catch (err) {
    console.error('leads.getFilterOptions:', err);
    return errorResponse(res, 'فشل تحميل خيارات الفلتر', 500, err.message);
  }
}

// GET /api/leads/:id
async function getById(req, res) {
  try {
    const lead = await leadsQueries.getLeadById(req.params.id);
    if (!lead) return errorResponse(res, 'العميل المحتمل غير موجود', 404);
    return res.json(lead);
  } catch (err) {
    console.error('leads.getById:', err);
    return errorResponse(res, 'فشل جلب التفاصيل', 500, err.message);
  }
}

// POST /api/leads
async function create(req, res) {
  try {
    const result = await leadsQueries.createLead(req.body, actorName(req));
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('leads.create:', err);
    return errorResponse(res, 'فشل إنشاء الـ Lead', 500, err.message);
  }
}

// PUT /api/leads/:id
async function update(req, res) {
  try {
    const body = {
      leadStatus: req.body.leadStatus ?? req.body.LeadStatus ?? req.body.status,
      assignedEmployeeId:
        req.body.assignedEmployeeId ?? req.body.AssignedEmployeeId ?? req.body.employeeId,
      notes: req.body.notes ?? req.body.Notes,
      feedback: req.body.feedback ?? req.body.Feedback,
      rejectedReason: req.body.rejectedReason ?? req.body.RejectedReason,
    };

    // Direct reject only for GeneralManager / Admin
    const actorRole = (req.body.actorRole || req.headers['x-user-role'] || '').toString();
    const roleNorm = actorRole.toLowerCase().replace(/\s+/g, '');
    const isGm = !actorRole || roleNorm === 'generalmanager' || roleNorm === 'admin' || roleNorm === 'gm' || roleNorm === 'general_manager';
    // If client sends role and tries reject without GM → block
    if (actorRole && !isGm && (body.leadStatus === 'مرفوض')) {
      return errorResponse(res, 'رفض الـ Lead يحتاج موافقة المدير العام — استخدم طلب الرفض', 403);
    }

    // Support explicit null unassign
    if (
      Object.prototype.hasOwnProperty.call(req.body, 'assignedEmployeeId') ||
      Object.prototype.hasOwnProperty.call(req.body, 'AssignedEmployeeId')
    ) {
      const raw = req.body.assignedEmployeeId ?? req.body.AssignedEmployeeId;
      body.assignedEmployeeId = raw === null || raw === '' ? null : raw;
    }

    const result = await leadsQueries.updateLead(req.params.id, body, actorName(req));
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('leads.update:', err);
    return errorResponse(res, 'فشل تحديث البيانات', 500, err.message);
  }
}

// POST /api/leads/:id/convert
async function convertToClient(req, res) {
  try {
    const dto = {
      employeeId: req.body.employeeId ?? req.body.EmployeeId,
      expectedValue: req.body.expectedValue ?? req.body.ExpectedValue,
      notes: req.body.notes ?? req.body.Notes,
      sourceId: req.body.sourceId ?? req.body.SourceId,
      adTypeId: req.body.adTypeId ?? req.body.AdTypeId,
      categoryId: req.body.categoryId ?? req.body.CategoryId,
      taskTypeId: req.body.taskTypeId ?? req.body.TaskTypeId,
    };

    const result = await leadsQueries.convertLeadToClient(
      req.params.id,
      dto,
      actorName(req)
    );

    if (!result.success) {
      return errorResponse(res, result.message, 400);
    }
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('leads.convert:', err);
    return errorResponse(res, 'فشل تحويل العميل المحتمل', 500, err.message);
  }
}

// GET /api/leads/:id/interactions
async function getInteractions(req, res) {
  try {
    const interactions = await leadsQueries.getLeadInteractions(req.params.id);
    return res.json(interactions);
  } catch (err) {
    console.error('leads.getInteractions:', err);
    // Fallback empty if table missing during rollout
    if (String(err.message || '').includes('Invalid object name')) {
      return res.json([]);
    }
    return errorResponse(res, 'فشل تحميل سجل التواصل', 500, err.message);
  }
}

// POST /api/leads/:id/interactions
async function addInteraction(req, res) {
  try {
    const data = {
      interactionType: req.body.interactionType ?? req.body.InteractionType,
      summary: req.body.summary ?? req.body.Summary,
      notes: req.body.notes ?? req.body.Notes,
      newLeadStatus: req.body.newLeadStatus ?? req.body.NewLeadStatus,
      rejectedReason: req.body.rejectedReason ?? req.body.RejectedReason,
      nextFollowUpDate: req.body.nextFollowUpDate ?? req.body.NextFollowUpDate,
      employeeId: req.body.employeeId ?? req.body.EmployeeId,
    };

    if (!data.notes && !data.summary && !data.interactionType) {
      return errorResponse(res, 'محتوى التواصل مطلوب', 400);
    }

    // Block direct reject via interaction unless actor is GM/Admin (client should use reject-request)
    const actorRole = (req.body.actorRole || req.headers['x-user-role'] || '').toString();
    const roleNorm = actorRole.toLowerCase().replace(/\s+/g, '');
    const isGm = roleNorm === 'generalmanager' || roleNorm === 'admin' || roleNorm === 'gm';
    if (
      !isGm &&
      (data.newLeadStatus === 'مرفوض' || data.interactionType === 'رفض')
    ) {
      return errorResponse(
        res,
        'رفض الـ Lead يحتاج موافقة المدير العام — استخدم طلب الرفض',
        403
      );
    }

    const result = await leadsQueries.addLeadInteraction(
      req.params.id,
      data,
      actorName(req)
    );

    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('leads.addInteraction:', err);
    return errorResponse(res, 'فشل تسجيل التواصل', 500, err.message);
  }
}

// POST /api/leads/:id/reject-request
async function requestReject(req, res) {
  try {
    const result = await leadsQueries.requestLeadReject(
      req.params.id,
      {
        reason: req.body.reason ?? req.body.rejectedReason ?? req.body.notes,
        employeeId: req.body.employeeId,
      },
      actorName(req)
    );
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('leads.requestReject:', err);
    return errorResponse(res, 'فشل إرسال طلب الرفض', 500, err.message);
  }
}

// GET /api/leads/reject-requests/pending
async function pendingRejectRequests(req, res) {
  try {
    const rows = await leadsQueries.getPendingRejectRequests();
    return res.json(rows);
  } catch (err) {
    console.error('leads.pendingRejectRequests:', err);
    return errorResponse(res, 'فشل تحميل طلبات الرفض', 500, err.message);
  }
}

// GET /api/leads/:id/reject-request
async function leadPendingReject(req, res) {
  try {
    const row = await leadsQueries.getLeadPendingReject(req.params.id);
    return res.json(row || null);
  } catch (err) {
    console.error('leads.leadPendingReject:', err);
    return errorResponse(res, 'فشل جلب طلب الرفض', 500, err.message);
  }
}

// POST /api/leads/reject-requests/:requestId/decide
async function decideReject(req, res) {
  try {
    const actorRole = (req.body.actorRole || req.headers['x-user-role'] || '').toString();
    const roleNorm = actorRole.toLowerCase().replace(/\s+/g, '');
    const isGm =
      roleNorm === 'generalmanager' ||
      roleNorm === 'admin' ||
      roleNorm === 'gm' ||
      roleNorm === 'general_manager';

    // Soft gate (full auth later). Allow if role says GM/Admin.
    if (actorRole && !isGm) {
      return errorResponse(res, 'هذه العملية للمدير العام فقط', 403);
    }

    const result = await leadsQueries.decideLeadRejectRequest(
      req.params.requestId,
      {
        approve: req.body.approve,
        decisionNotes: req.body.decisionNotes ?? req.body.notes,
      },
      actorName(req)
    );
    if (!result.success) return errorResponse(res, result.message, 400);
    return successResponse(res, result, result.message);
  } catch (err) {
    console.error('leads.decideReject:', err);
    return errorResponse(res, 'فشل البت في طلب الرفض', 500, err.message);
  }
}

module.exports = {
  getAll,
  getStats,
  getEmployees,
  getMeta,
  getFilterOptions,
  getById,
  create,
  update,
  convertToClient,
  getInteractions,
  addInteraction,
  requestReject,
  pendingRejectRequests,
  leadPendingReject,
  decideReject,
};
