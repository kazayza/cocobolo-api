const { sql, connectDB } = require('../../core/database');
const productsQueries = require('./products.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');


// جلب مجموعات المنتجات
async function getGroups(req, res) {
  try {
    const groups = await productsQueries.getProductGroups();
    return res.json(groups);
  } catch (err) {
    console.error('خطأ في جلب المجموعات:', err);
    return errorResponse(res, 'فشل تحميل المجموعات', 500, err.message);
  }
}

// جلب كل المنتجات (بحث + مجموعة + حالة + ملكية + مسعرة)
async function getAll(req, res) {
  try {
    const { search, groupId, statusId, ownership, priced } = req.query;
    const products = await productsQueries.getAllProducts(
      search, groupId, statusId, ownership || 'all', priced || 'all'
    );
    return res.json(products);
  } catch (err) {
    console.error('خطأ في جلب المنتجات:', err);
    return errorResponse(res, 'فشل تحميل المنتجات', 500, err.message);
  }
}

// إحصائيات المنتجات
async function getStats(req, res) {
  try {
    const stats = await productsQueries.getProductStats();
    return res.json(stats);
  } catch (err) {
    console.error('خطأ في جلب إحصائيات المنتجات:', err);
    return errorResponse(res, 'فشل تحميل الإحصائيات', 500, err.message);
  }
}

// حالات التسعير
async function getPricingStatuses(req, res) {
  try {
    const statuses = await productsQueries.getPricingStatuses();
    return res.json(statuses);
  } catch (err) {
    console.error('خطأ في جلب حالات التسعير:', err);
    return errorResponse(res, 'فشل تحميل الحالات', 500, err.message);
  }
}

// جلب منتج بالـ ID
async function getById(req, res) {
  try {
    const { id } = req.params;
    const product = await productsQueries.getProductById(id);

    if (!product) {
      return notFoundResponse(res, 'المنتج غير موجود');
    }

    return res.json(product);
  } catch (err) {
    console.error('خطأ في جلب المنتج:', err);
    return errorResponse(res, 'فشل تحميل المنتج', 500, err.message);
  }
}

// إضافة منتج جديد
async function create(req, res) {
  try {
    const { productName } = req.body;

    if (!productName) {
      return errorResponse(res, 'اسم المنتج مطلوب', 400);
    }

    const productId = await productsQueries.createProduct(req.body);
    // 👇👇👇 كود الإشعار السحري 👇👇👇
    // إرسال إشعار للمصنع للتسعير
    try {
      await notificationsQueries.createNotificationSmart({
        title: 'منتج جديد للتسعير',
        message: `تم إضافة منتج جديد: ${productName}، يرجى التسعير.`,
        createdBy: req.body.createdBy || 'System', // اسم السيلز
        relatedId: productId,             // رقم المنتج
        formName: 'frm_Products'          // الشاشة اللي هتفتح
      }, 'factory'); // 👈 ابعت لليوزر "Factory"
    } catch (notifError) {
      console.error('فشل إرسال الإشعار:', notifError);
      // بنكمل عادي حتى لو الإشعار فشل، المهم المنتج اتضاف
    }

    return res.json({
      success: true,
      productId: productId,
      message: 'تم إضافة المنتج بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة المنتج:', err);
    return errorResponse(res, 'فشل إضافة المنتج', 500, err.message);
  }
}

// تعديل منتج
async function update(req, res) {
  try {
    const { id } = req.params;
    const { productName } = req.body;

    if (!productName) {
      return errorResponse(res, 'اسم المنتج مطلوب', 400);
    }

    await productsQueries.updateProduct(id, req.body);

    return res.json({
      success: true,
      message: 'تم تعديل المنتج بنجاح'
    });
  } catch (err) {
    console.error('خطأ في تعديل المنتج:', err);
    return errorResponse(res, 'فشل تعديل المنتج', 500, err.message);
  }
}

// إضافة صورة للمنتج
async function addImage(req, res) {
  try {
    const { id } = req.params;
    const { imageBase64, imageNote } = req.body;

    if (!imageBase64) {
      return errorResponse(res, 'الصورة مطلوبة', 400);
    }

    await productsQueries.addProductImage(id, imageBase64, imageNote);

    return res.json({
      success: true,
      message: 'تم إضافة الصورة بنجاح'
    });
  } catch (err) {
    console.error('خطأ في إضافة الصورة:', err);
    return errorResponse(res, 'فشل إضافة الصورة', 500, err.message);
  }
}

// حذف صورة
async function deleteImage(req, res) {
  try {
    const { id } = req.params;

    await productsQueries.deleteProductImage(id);

    return res.json({
      success: true,
      message: 'تم حذف الصورة'
    });
  } catch (err) {
    console.error('خطأ في حذف الصورة:', err);
    return errorResponse(res, 'فشل حذف الصورة', 500, err.message);
  }
}

// حفظ مكونات المنتج
async function saveComponents(req, res) {
  try {
    const { id } = req.params;
    const { components, createdBy } = req.body;

    if (!components || !Array.isArray(components)) {
      return errorResponse(res, 'المكونات مطلوبة', 400);
    }

    await productsQueries.saveProductComponents(id, components, createdBy);

    return res.json({
      success: true,
      message: 'تم حفظ المكونات بنجاح'
    });
  } catch (err) {
    console.error('خطأ في حفظ المكونات:', err);
    return errorResponse(res, 'فشل حفظ المكونات', 500, err.message);
  }
}
// دالة لجلب ملف PDF المنتج
async function getProductPdf(req, res) {
  try {
    const { id } = req.params;
    
    const pool = await connectDB();
    const result = await pool.request()
      .input('id', sql.Int, id)
      .query('SELECT PDFFile FROM Products WHERE ProductID = @id');

    // 1. التأكد إن المنتج موجود
    if (!result.recordset || result.recordset.length === 0) {
      return res.status(404).send('المنتج غير موجود');
    }

    const fileData = result.recordset[0].PDFFile;

    // 2. التأكد إن فيه ملف فعلاً ومش NULL
    if (!fileData) {
      return res.status(404).send('لا يوجد ملف PDF لهذا المنتج');
    }

    // 3. إعداد الـ Headers
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Length', fileData.length); // مهم عشان التطبيق يعرف حجم الملف
    res.setHeader('Content-Disposition', `inline; filename="product_${id}.pdf"`);

    // 4. إرسال الملف (Buffer)
    res.write(fileData);
    res.end();

  } catch (err) {
    console.error('❌ خطأ في جلب PDF:', err);
    res.status(500).send('خطأ في السيرفر');
  }
}



// تصدير الدوال
module.exports = {
  getGroups,
  getAll,
  getStats,
  getPricingStatuses,
  getById,
  create,
  update,
  addImage,
  deleteImage,
  saveComponents,
  getProductPdf
};