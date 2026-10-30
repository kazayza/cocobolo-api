const { sql, connectDB } = require('../../core/database');
const productsQueries = require('./products.queries');
const notificationsQueries = require('../notifications/notifications.queries');
const { successResponse, errorResponse, notFoundResponse } = require('../../shared/response.helper');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

function normalizeRole(value) {
  return String(value || '').toLowerCase().replace(/[\s_-]+/g, '');
}

function scopeProductPricing(product, auth) {
  const scoped = { ...product };
  const role = normalizeRole(auth?.role);
  const canSeeFullPricing = role === 'admin' || role === 'accountmanager';
  const isFactory = role === 'factory';

  if (!canSeeFullPricing && !isFactory) {
    delete scoped.PurchasePrice;
    delete scoped.PurchasePriceCClass;
    delete scoped.PurchasePriceElite;
  }

  if (isFactory) {
    delete scoped.SuggestedSalePrice;
    delete scoped.SuggestedSalePriceCClass;
    delete scoped.SuggestedSalePriceElite;
  }

  return scoped;
}

// ===================================
// رفع صور المنتجات (زي بلازور — ملف على القرص)
// ===================================
const PRODUCT_IMG_FOLDER = 'uploads/images';
const MAX_IMG_SIZE = 8 * 1024 * 1024; // 8 ميجا

const uploadProductImage = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_IMG_SIZE },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (!allowed.includes(ext)) {
      return cb(new Error('صيغة الصورة غير مدعومة'));
    }
    cb(null, true);
  }
}).single('image');


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

// جلب كل المنتجات (بحث + مجموعة + حالة + ملكية + مسعرة + فرع + مخزن)
async function getAll(req, res) {
  try {
    const { search, groupId, statusId, ownership, priced, branchId, warehouseId } = req.query;
    const products = await productsQueries.getAllProducts(
      search, groupId, statusId, ownership || 'all', priced || 'all', branchId || null, warehouseId || null
    );
    return res.json(products.map((product) => scopeProductPricing(product, req.auth)));
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

    return res.json(scopeProductPricing(product, req.auth));
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

// إضافة صورة للمنتج (multipart — زي بلازور)
// ✅ الصورة بتتحفظ على القرص + مسارها في الداتابيز
async function addImage(req, res) {
  try {
    const { id } = req.params;
    const imageNote = req.body.imageNote || '';

    // 1) الملف الجديد (multipart)
    if (req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const safeName = `${crypto.randomBytes(16).toString('hex')}${ext}`;
      const filePath = `/${PRODUCT_IMG_FOLDER}/${safeName}`;

      // نحفظ الملف على القرص
      const localDir = path.join(process.cwd(), PRODUCT_IMG_FOLDER);
      fs.mkdirSync(localDir, { recursive: true });
      fs.writeFileSync(path.join(localDir, safeName), req.file.buffer);

      // نسجل المسار في الداتابيز
      await productsQueries.addProductImageByPath(id, filePath, imageNote);

      return res.json({
        success: true,
        message: 'تم إضافة الصورة بنجاح',
        imagePath: filePath
      });
    }

    // 2) التوافق القديم (base64) — للموبايل القديم
    const { imageBase64 } = req.body;
    if (imageBase64) {
      await productsQueries.addProductImage(id, imageBase64, imageNote);
      return res.json({
        success: true,
        message: 'تم إضافة الصورة بنجاح (base64)'
      });
    }

    return errorResponse(res, 'الصورة مطلوبة', 400);
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
// حذف منتج مع منع حذف المنتجات المستخدمة في مستندات أو حركات مخزون.
async function remove(req, res) {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
      return errorResponse(res, 'رقم المنتج غير صالح', 400);
    }

    const deleted = await productsQueries.deleteProduct(productId);
    if (!deleted) return notFoundResponse(res, 'المنتج غير موجود');

    return res.json({ success: true, message: 'تم حذف المنتج بنجاح' });
  } catch (err) {
    console.error('خطأ في حذف المنتج:', err);
    if (err.number === 547) {
      return errorResponse(
        res,
        'لا يمكن حذف المنتج لأنه مستخدم في فاتورة أو حركة مخزون أو مستند مرتبط.',
        409,
        err.message
      );
    }
    return errorResponse(res, 'فشل حذف المنتج', 500, err.message);
  }
}

// ===================================
// رفع ملف PDF المنتج — مرآة بلازور ProductForm.razor:4729 (UploadPdf)
// وحد الحجم 10MB في :3061 (MaxPdfSize). الشكل الذي يتوقعه التطبيق:
// JSON { pdfBase64 } أو multipart بحقل pdf. تخزين مزدوج كما قررت
// الجولة الأولى: ملف uploads/pdf/<hex>.pdf (+ PdfPath) وعمود PDFFile
// الذي تخدمه نقطة القراءة القائمة GET /:id/pdf.
// ===================================
const PRODUCT_PDF_FOLDER = 'uploads/pdf';
const MAX_PDF_SIZE = 10 * 1024 * 1024; // 10 ميجا — ProductForm.razor:3061

const uploadProductPdfFile = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_PDF_SIZE },
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname || '').toLowerCase();
    if (ext !== '.pdf') {
      return cb(new Error('صيغة الملف غير مدعومة — PDF فقط'));
    }
    cb(null, true);
  }
}).single('pdf');

// يمرر multipart إلى multer ويترك JSON (pdfBase64) كما هو للمتحكم
function uploadProductPdf(req, res, next) {
  if (req.is('multipart/form-data')) {
    return uploadProductPdfFile(req, res, next);
  }
  return next();
}

async function uploadPdf(req, res) {
  try {
    const productId = parseInt(req.params.id, 10);
    if (!Number.isInteger(productId) || productId <= 0) {
      return errorResponse(res, 'رقم المنتج غير صالح', 400);
    }

    let buffer = null;
    if (req.file) {
      buffer = req.file.buffer;
    } else if (req.body && req.body.pdfBase64) {
      buffer = Buffer.from(String(req.body.pdfBase64), 'base64');
    }
    if (!buffer || buffer.length === 0) {
      return errorResponse(res, 'ملف PDF مطلوب', 400);
    }
    if (buffer.length > MAX_PDF_SIZE) {
      return errorResponse(res, 'حجم الملف يتجاوز 10 ميجا', 400);
    }
    // بصمة PDF السحرية %PDF-
    if (!(buffer[0] === 0x25 && buffer[1] === 0x50 && buffer[2] === 0x44 && buffer[3] === 0x46 && buffer[4] === 0x2D)) {
      return errorResponse(res, 'الملف ليس PDF صالحًا', 400);
    }

    const pool = await connectDB();
    const exists = await pool.request()
      .input('id', sql.Int, productId)
      .query('SELECT ProductID FROM Products WHERE ProductID = @id');
    if (exists.recordset.length === 0) {
      return notFoundResponse(res, 'المنتج غير موجود');
    }

    // 1) ملف على القرص تحت uploads/pdf باسم عشوائي آمن
    const safeName = `${crypto.randomBytes(16).toString('hex')}.pdf`;
    const pdfPath = `/${PRODUCT_PDF_FOLDER}/${safeName}`;
    const localDir = path.join(process.cwd(), PRODUCT_PDF_FOLDER);
    fs.mkdirSync(localDir, { recursive: true });
    fs.writeFileSync(path.join(localDir, safeName), buffer);

    // 2) عمود PDFFile (تخدمه نقطة القراءة) + PdfPath للمسار على القرص
    await pool.request()
      .input('id', sql.Int, productId)
      .input('pdfFile', sql.VarBinary(sql.MAX), buffer)
      .input('pdfPath', sql.NVarChar(500), pdfPath)
      .query('UPDATE Products SET PDFFile = @pdfFile, PdfPath = @pdfPath WHERE ProductID = @id');

    return res.json({
      success: true,
      message: 'تم رفع ملف PDF بنجاح',
      pdfPath,
    });
  } catch (err) {
    console.error('خطأ في رفع PDF المنتج:', err);
    return errorResponse(res, err.message || 'فشل رفع ملف PDF', err.statusCode || 500, err.message);
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
  uploadProductImage,
  addImage,
  deleteImage,
  saveComponents,
  remove,
  getProductPdf,
  uploadProductPdf,
  uploadPdf
};