const { sql, connectDB } = require('../../core/database');

// ===================================
// 🔧 Generic CRUD
// ===================================

async function getAll(tableName, idColumn) {
  const pool = await connectDB();
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
  
  // ✅ ضبط أنواع البيانات (نص، رقم، تاريخ)
  Object.keys(data).forEach((key, i) => {
    const value = data[key];
    if (value instanceof Date) {
      request.input(`p${i}`, sql.DateTime, value);
    } else if (typeof value === 'number') {
      request.input(`p${i}`, sql.Int, value);
    } else {
      request.input(`p${i}`, sql.NVarChar(sql.MAX), value);
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
  
  const setClauses = Object.keys(data).map((key, i) => `${key} = @p${i}`).join(', ');
  
  const request = pool.request();
  request.input('targetId', sql.Int, id); // ✅ اسم مميز للـ ID
  
  // ✅ ضبط أنواع البيانات في التحديث أيضاً
  Object.keys(data).forEach((key, i) => {
    const value = data[key];
    if (value instanceof Date) {
      request.input(`p${i}`, sql.DateTime, value);
    } else if (typeof value === 'number') {
      request.input(`p${i}`, sql.Int, value);
    } else {
      request.input(`p${i}`, sql.NVarChar(sql.MAX), value);
    }
  });
  
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
// 📋 أسماء الجداول والأعمدة (بدون dbo_)
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