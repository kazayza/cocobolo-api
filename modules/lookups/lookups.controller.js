const lookupsQueries = require('./lookups.queries');
const { successResponse, errorResponse } = require('../../shared/response.helper');

// ===================================
// 📢 الحملات الإعلانية (AdTypes)
// ===================================
async function getAdTypes(req, res) {
  try {
    const items = await lookupsQueries.getAll('AdTypes', 'AdTypeID');
    return res.json(items);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createAdType(req, res) {
  try {
    const { nameAr, nameEn, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('AdTypes', {
      AdTypeName: nameEn || nameAr,
      AdTypeNameAr: nameAr,
      IsActive: 1, // ✅ تفعيل السجل
      CreatedBy: createdBy
    });
    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateAdType(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('AdTypes', 'AdTypeID', id, {
      AdTypeName: nameEn || nameAr,
      AdTypeNameAr: nameAr,
      UpdatedBy: updatedBy
    });
    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteAdType(req, res) {
  try {
    const { id } = req.params;
    // ✅ Soft Delete: IsActive = 0
    await lookupsQueries.softDelete('AdTypes', 'AdTypeID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

// ===================================
// 📱 مصادر التواصل (ContactSources)
// ===================================
async function getSources(req, res) {
  try {
    const items = await lookupsQueries.getAll('ContactSources', 'SourceID');
    return res.json(items);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createSource(req, res) {
  try {
    const { nameAr, nameEn, icon, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('ContactSources', {
      SourceName: nameEn || nameAr,
      SourceNameAr: nameAr,
      SourceIcon: icon || '📞',
      IsActive: 1, // ✅ تفعيل
      CreatedBy: createdBy
    });
    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateSource(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, icon, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('ContactSources', 'SourceID', id, {
      SourceName: nameEn || nameAr,
      SourceNameAr: nameAr,
      SourceIcon: icon || '📞',
      UpdatedBy: updatedBy
    });
    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteSource(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('ContactSources', 'SourceID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

// ===================================
// 📊 مراحل البيع (SalesStages)
// ===================================
async function getStages(req, res) {
  try {
    const items = await lookupsQueries.getAll('SalesStages', 'StageID');
    return res.json(items);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createStage(req, res) {
  try {
    const { nameAr, nameEn, color, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('SalesStages', {
      StageName: nameEn || nameAr,
      StageNameAr: nameAr,
      StageColor: color || '#3498db',
      IsActive: 1, // ✅ تفعيل
      CreatedBy: createdBy
    });
    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateStage(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, color, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('SalesStages', 'StageID', id, {
      StageName: nameEn || nameAr,
      StageNameAr: nameAr,
      StageColor: color || '#3498db',
      UpdatedBy: updatedBy
    });
    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteStage(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('SalesStages', 'StageID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

// ===================================
// 🏷️ فئات الاهتمام (InterestCategories)
// ===================================
async function getCategories(req, res) {
  try {
    const items = await lookupsQueries.getAll('InterestCategories', 'CategoryID');
    return res.json(items);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createCategory(req, res) {
  try {
    const { nameAr, nameEn, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('InterestCategories', {
      CategoryName: nameEn || nameAr,
      CategoryNameAr: nameAr,
      IsActive: 1, // ✅ تفعيل
      CreatedBy: createdBy
    });
    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateCategory(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('InterestCategories', 'CategoryID', id, {
      CategoryName: nameEn || nameAr,
      CategoryNameAr: nameAr,
      UpdatedBy: updatedBy
    });
    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteCategory(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('InterestCategories', 'CategoryID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

// ===================================
// 📋 حالات التواصل (ContactStatus)
// ===================================
async function getStatuses(req, res) {
  try {
    const items = await lookupsQueries.getAll('ContactStatus', 'StatusID');
    return res.json(items);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createStatus(req, res) {
  try {
    const { nameAr, nameEn, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('ContactStatus', {
      StatusName: nameEn || nameAr,
      StatusNameAr: nameAr,
      IsActive: 1, // ✅ تفعيل
      CreatedBy: createdBy
    });
    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateStatus(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('ContactStatus', 'StatusID', id, {
      StatusName: nameEn || nameAr,
      StatusNameAr: nameAr,
      UpdatedBy: updatedBy
    });
    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteStatus(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('ContactStatus', 'StatusID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

// ===================================
// ✅ أنواع المهام (TaskTypes)
// ===================================
async function getTaskTypes(req, res) {
  try {
    const items = await lookupsQueries.getAll('TaskTypes', 'TaskTypeID');
    return res.json(items);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createTaskType(req, res) {
  try {
    const { nameAr, nameEn, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('TaskTypes', {
      TaskTypeName: nameEn || nameAr,
      TaskTypeNameAr: nameAr,
      IsActive: 1, // ✅ تفعيل
      CreatedBy: createdBy
    });
    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateTaskType(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('TaskTypes', 'TaskTypeID', id, {
      TaskTypeName: nameEn || nameAr,
      TaskTypeNameAr: nameAr,
      UpdatedBy: updatedBy
    });
    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteTaskType(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('TaskTypes', 'TaskTypeID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

// ===================================
// ❌ أسباب الخسارة (LostReasons)
// ===================================
async function getLostReasons(req, res) {
  try {
    const items = await lookupsQueries.getAll('LostReasons', 'LostReasonID');
    return res.json(items);
  } catch (err) {
    return errorResponse(res, 'فشل تحميل البيانات', 500, err.message);
  }
}

async function createLostReason(req, res) {
  try {
    const { nameAr, nameEn, createdBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    const id = await lookupsQueries.create('LostReasons', {
      ReasonName: nameEn || nameAr,
      ReasonNameAr: nameAr,
      IsActive: 1, // ✅ تفعيل
      CreatedBy: createdBy
    });
    return res.json({ success: true, id, message: 'تم الإضافة بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الإضافة', 500, err.message);
  }
}

async function updateLostReason(req, res) {
  try {
    const { id } = req.params;
    const { nameAr, nameEn, updatedBy } = req.body;
    if (!nameAr) return errorResponse(res, 'الاسم العربي مطلوب', 400);

    await lookupsQueries.update('LostReasons', 'LostReasonID', id, {
      ReasonName: nameEn || nameAr,
      ReasonNameAr: nameAr,
      UpdatedBy: updatedBy
    });
    return res.json({ success: true, message: 'تم التعديل بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل التعديل', 500, err.message);
  }
}

async function deleteLostReason(req, res) {
  try {
    const { id } = req.params;
    await lookupsQueries.softDelete('LostReasons', 'LostReasonID', id);
    return res.json({ success: true, message: 'تم الحذف بنجاح' });
  } catch (err) {
    return errorResponse(res, 'فشل الحذف', 500, err.message);
  }
}

module.exports = {
  getAdTypes, createAdType, updateAdType, deleteAdType,
  getSources, createSource, updateSource, deleteSource,
  getStages, createStage, updateStage, deleteStage,
  getCategories, createCategory, updateCategory, deleteCategory,
  getStatuses, createStatus, updateStatus, deleteStatus,
  getTaskTypes, createTaskType, updateTaskType, deleteTaskType,
  getLostReasons, createLostReason, updateLostReason, deleteLostReason,
};