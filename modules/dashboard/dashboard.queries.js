const { sql, connectDB } = require('../../core/database');

// جلب إحصائيات لوحة التحكم الرئيسية
async function getDashboardStats(userId, username) {
  const pool = await connectDB();
  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('username', sql.NVarChar, username)
    .query(`
      SELECT 
        (SELECT COUNT(*) FROM Parties WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as newClientsToday,
        (SELECT COUNT(*) FROM SalesOpportunities WHERE IsActive = 1 AND StageID NOT IN (3,4,5)) as openOpportunities,
        (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed') as tasksToday,
        (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'Sale') as salesToday,
        (SELECT COUNT(*) FROM Notifications WHERE RecipientUser = @username AND IsRead = 0) as unreadCount
    `);
  return result.recordset[0];
}

// جلب النشاطات الأخيرة
async function getRecentActivities() {
  const pool = await connectDB();
  let allActivities = [];

  // العملاء الجدد
  try {
    const clients = await pool.request().query(`
      SELECT TOP 5
        'client' as type, N'عميل جديد' as title,
        PartyName as description, CreatedAt as createdAt,
        'person_add' as icon, '#4CAF50' as color
      FROM Parties 
      WHERE PartyType = 1 AND IsActive = 1
      ORDER BY CreatedAt DESC
    `);
    allActivities = [...allActivities, ...clients.recordset];
  } catch (e) {
    console.error('خطأ في جلب العملاء:', e.message);
  }

  // المصروفات
  try {
    const expenses = await pool.request().query(`
      SELECT TOP 5
        'expense' as type, N'مصروف' as title,
        ExpenseName + N' - ' + CAST(Amount AS NVARCHAR) + N' ج.م' as description,
        CreatedAt as createdAt, 'money_off' as icon, '#F44336' as color
      FROM Expenses
      ORDER BY CreatedAt DESC
    `);
    allActivities = [...allActivities, ...expenses.recordset];
  } catch (e) {
    console.error('خطأ في جلب المصروفات:', e.message);
  }

  // الفرص
  try {
    const opportunities = await pool.request().query(`
      SELECT TOP 5
        'opportunity' as type, N'فرصة جديدة' as title,
        p.PartyName + N' - ' + CAST(ISNULL(o.ExpectedValue, 0) AS NVARCHAR) + N' ج.م' as description,
        o.CreatedAt as createdAt, 'lightbulb' as icon, '#FF9800' as color
      FROM SalesOpportunities o
      LEFT JOIN Parties p ON o.PartyID = p.PartyID
      WHERE o.IsActive = 1
      ORDER BY o.CreatedAt DESC
    `);
    allActivities = [...allActivities, ...opportunities.recordset];
  } catch (e) {
    console.error('خطأ في جلب الفرص:', e.message);
  }

  // ترتيب حسب التاريخ وأخذ أحدث 10
  allActivities.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  allActivities = allActivities.slice(0, 10);

  // حساب الوقت المنقضي
  return allActivities.map(activity => {
    const now = new Date();
    const created = new Date(activity.createdAt);
    const diffMs = now - created;
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    let timeAgo;
    if (diffMins < 1) timeAgo = 'الآن';
    else if (diffMins < 60) timeAgo = `منذ ${diffMins} د`;
    else if (diffHours < 24) timeAgo = `منذ ${diffHours} س`;
    else timeAgo = `منذ ${diffDays} يوم`;

    return { ...activity, timeAgo };
  });
}

// جلب بيانات التشخيص
async function getDebugData() {
  const pool = await connectDB();
  const results = {};

  try {
    const parties = await pool.request().query(`SELECT TOP 1 PartyName, CreatedAt FROM Parties WHERE PartyType = 1`);
    results.parties = { success: true, count: parties.recordset.length, sample: parties.recordset[0] || null };
  } catch (e) {
    results.parties = { success: false, error: e.message };
  }

  try {
    const expenses = await pool.request().query(`SELECT TOP 1 ExpenseName, Amount, CreatedAt FROM Expenses`);
    results.expenses = { success: true, count: expenses.recordset.length, sample: expenses.recordset[0] || null };
  } catch (e) {
    results.expenses = { success: false, error: e.message };
  }

  try {
    const opportunities = await pool.request().query(`SELECT TOP 1 OpportunityID, ExpectedValue, CreatedAt FROM SalesOpportunities`);
    results.salesOpportunities = { success: true, count: opportunities.recordset.length, sample: opportunities.recordset[0] || null };
  } catch (e) {
    results.salesOpportunities = { success: false, error: e.message };
  }

  return results;
}

// تصدير الدوال
module.exports = {
  getDashboardStats,
  getRecentActivities,
  getDebugData
};