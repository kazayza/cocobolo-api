const { sql, connectDB } = require('../../core/database');

// ===================================
// 🔧 Generic CRUD للجداول المرجعية
// ===================================

async function getAll(tableName, idColumn) {
  const pool = await connectDB();
  
  // تحديد الأعمدة حسب الجدول
  const columns = getColumnsForTable(tableName);
  
  const result = await pool.request()
    .query(`
      SELECT ${idColumn} as id, ${columns.nameEn} as nameEn, ${columns.nameAr} as nameAr,
             ${columns.extra ? columns.extra + ',' : ''} IsActive
      FROM ${tableName}
      WHERE IsActive = 1
      ORDER BY ${columns.nameAr}
    `);
  return result.recordset;
}

async function create(tableName, data) {
  const pool = await connectDB();
  
  const columns = Object.keys(data).join(', ');
  const values = Object.keys(data).map((_, i) => `@p${i}`).join(', ');
  
  const request = pool.request();
  Object.keys(data).forEach((key, i) => {
    const value = data[key];
    if (typeof value === 'number') {
      request.input(`p${i}`, sql.Int, value);
    } else {
      request.input(`p${i}`, sql.NVarChar(200), value);
    }
  });
  
  const result = await request.query(`
    INSERT INTO ${tableName} (${columns})
    VALUES (${values});
    SELECT SCOPE_IDENTITY() AS NewID;
  `);
  
  return result.recordset[0]?.NewID;
}

async function update(tableName, idColumn, id, data) {
  const pool = await connectDB();
  
  // 1. تجهيز جملة SET
  const setClauses = Object.keys(data).map((key, i) => `${key} = @p${i}`).join(', ');
  
  const request = pool.request();
  
  // 2. إضافة القيم (p0, p1, ...)
  Object.keys(data).forEach((key, i) => {
    const value = data[key];
    if (typeof value === 'number') {
      request.input(`p${i}`, sql.Int, value);
    } else {
      request.input(`p${i}`, sql.NVarChar(200), value);
    }
  });
  
  // 3. إضافة الـ ID باسم مميز (targetId)
  request.input('targetId', sql.Int, id);
  
  // 4. تنفيذ الاستعلام
  await request.query(`
    UPDATE ${tableName} 
    SET ${setClauses}
    WHERE ${idColumn} = @targetId
  `);
  
  return true;
}

async function softDelete(tableName, idColumn, id) {
  const pool = await connectDB();
  await pool.request()
    .input('id', sql.Int, id)
    .query(`UPDATE ${tableName} SET IsActive = 0 WHERE ${idColumn} = @id`);
  return true;
}

// ===================================
// 📋 تحديد الأعمدة لكل جدول (مهم جداً!)
// ===================================
function getColumnsForTable(tableName) {
  const mapping = {
    'AdTypes': {
      nameEn: 'AdTypeName',
      nameAr: 'AdTypeNameAr',
      extra: null
    },
    'ContactSources': {
      nameEn: 'SourceName',
      nameAr: 'SourceNameAr',
      extra: 'SourceIcon as icon'
    },
    'SalesStages': {
      nameEn: 'StageName',
      nameAr: 'StageNameAr',
      extra: 'StageColor as color, StageOrder as sortOrder'
    },
    'InterestCategories': {
      nameEn: 'CategoryName',
      nameAr: 'CategoryNameAr',
      extra: null
    },
    'ContactStatus': {
      nameEn: 'StatusName',
      nameAr: 'StatusNameAr',
      extra: null
    },
    'TaskTypes': {
      nameEn: 'TaskTypeName',
      nameAr: 'TaskTypeNameAr',
      extra: null
    },
    'LostReasons': {
      nameEn: 'ReasonName',
      nameAr: 'ReasonNameAr',
      extra: null
    },
  };
  
  return mapping[tableName] || { nameEn: 'Name', nameAr: 'NameAr', extra: null };
}

module.exports = {
  getAll,
  create,
  update,
  softDelete,
  getColumnsForTable
};