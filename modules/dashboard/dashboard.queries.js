const { sql, connectDB } = require('../../core/database');

// جلب إحصائيات لوحة التحكم الرئيسية
// جلب إحصائيات لوحة التحكم الرئيسية (حسب الـ Role)
async function getDashboardStats(userId, username, role, employeeId) {
  const pool = await connectDB();
  
  let query = '';
  
  // تحديد الاستعلام حسب الـ Role
  if (role === 'Admin' || role === 'SalesManager') {
    // الأدمن ومدير المبيعات يشوفوا كل حاجة
    query = `
      SELECT 
        (SELECT COUNT(*) FROM Parties WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as newClientsToday,
        (SELECT COUNT(*) FROM SalesOpportunities WHERE IsActive = 1 AND StageID NOT IN (3,4,5)) as openOpportunities,
        (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed') as tasksToday,
        (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'Sale') as salesToday,
        (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE YEAR(TransactionDate) = YEAR(GETDATE()) AND MONTH(TransactionDate) = MONTH(GETDATE()) AND TransactionType = 'Sale') as salesMonth,
        (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE YEAR(TransactionDate) = YEAR(DATEADD(MONTH,-1,GETDATE())) AND MONTH(TransactionDate) = MONTH(DATEADD(MONTH,-1,GETDATE())) AND TransactionType = 'Sale') as salesPrevMonth,
        (SELECT COUNT(*) FROM Notifications WHERE RecipientUser = @username AND IsRead = 0) as unreadCount
    `;
  } else if (role === 'Sales') {
    // موظف المبيعات يشوف بتاعه بس
    query = `
      SELECT 
        (SELECT COUNT(*) FROM Parties WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE) AND CreatedBy = @username) as newClientsToday,
        (SELECT COUNT(*) FROM SalesOpportunities WHERE IsActive = 1 AND StageID NOT IN (3,4,5) AND EmployeeID = @employeeId) as openOpportunities,
        (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed' AND AssignedTo = @employeeId) as tasksToday,
        (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'Sale' AND CreatedBy = @username) as salesToday,
        (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE YEAR(TransactionDate) = YEAR(GETDATE()) AND MONTH(TransactionDate) = MONTH(GETDATE()) AND TransactionType = 'Sale' AND CreatedBy = @username) as salesMonth,
        (SELECT ISNULL(SUM(GrandTotal),0) FROM Transactions WHERE YEAR(TransactionDate) = YEAR(DATEADD(MONTH,-1,GETDATE())) AND MONTH(TransactionDate) = MONTH(DATEADD(MONTH,-1,GETDATE())) AND TransactionType = 'Sale' AND CreatedBy = @username) as salesPrevMonth,
        (SELECT COUNT(*) FROM Notifications WHERE RecipientUser = @username AND IsRead = 0) as unreadCount
    `;
  } else if (role === 'AccountManager' || role === 'Account') {
    // الحسابات يشوفوا إحصائيات مالية
    query = `
      SELECT 
        (SELECT COUNT(*) FROM Transactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE)) as invoicesToday,
        (SELECT COUNT(*) FROM Expenses WHERE CAST(CreatedAt AS DATE) = CAST(GETDATE() AS DATE)) as expensesToday,
        (SELECT ISNULL(SUM(Amount),0) FROM CashboxTransactions WHERE CAST(TransactionDate AS DATE) = CAST(GETDATE() AS DATE) AND TransactionType = 'In') as collectionsToday,
        (SELECT ISNULL(SUM(CASE WHEN TransactionType = 'In' THEN Amount ELSE -Amount END),0) FROM CashboxTransactions) as cashBalance,
        (SELECT COUNT(*) FROM Notifications WHERE RecipientUser = @username AND IsRead = 0) as unreadCount
    `;
  } else {
    // باقي المستخدمين - إحصائيات عامة محدودة
    query = `
      SELECT 
        (SELECT COUNT(*) FROM CRM_Tasks WHERE CAST(DueDate AS DATE) = CAST(GETDATE() AS DATE) AND Status != 'Completed' AND AssignedTo = @employeeId) as tasksToday,
        (SELECT COUNT(*) FROM Notifications WHERE RecipientUser = @username AND IsRead = 0) as unreadCount
    `;
  }

  const result = await pool.request()
    .input('userId', sql.Int, userId)
    .input('username', sql.NVarChar, username)
    .input('employeeId', sql.Int, employeeId)
    .query(query);
    
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

// ═══════════════════════════════════════════════════════════
// Trends — آخر 7 أيام (باستعلام بسيط Group By)
// ═══════════════════════════════════════════════════════════
async function getDashboardTrends(userId, username, role, employeeId) {
  const pool = await connectDB();

  // فلتر المستخدم (للسيلز فقط)
  const userFilter = role === 'Sales' ? ' AND CreatedBy = @username' : '';
  const taskFilter = role === 'Sales' ? ' AND AssignedTo = @employeeId' : '';

  const request = pool.request()
    .input('username', sql.NVarChar, username)
    .input('employeeId', sql.Int, employeeId);

  // 1. العملاء الجدد آخر 7 أيام
  const clientsRes = await request.query(`
    SELECT CAST(CreatedAt AS DATE) as d, COUNT(*) as cnt
    FROM Parties
    WHERE CreatedAt >= DATEADD(DAY, -6, CAST(GETDATE() AS DATE))${userFilter}
    GROUP BY CAST(CreatedAt AS DATE)
  `);

  // 2. المهام آخر 7 أيام
  const tasksRes = await request.query(`
    SELECT CAST(DueDate AS DATE) as d, COUNT(*) as cnt
    FROM CRM_Tasks
    WHERE DueDate >= DATEADD(DAY, -6, CAST(GETDATE() AS DATE))
      AND Status != 'Completed'${taskFilter}
    GROUP BY CAST(DueDate AS DATE)
  `);

  // 3. المبيعات آخر 7 أيام
  const salesRes = await request.query(`
    SELECT CAST(TransactionDate AS DATE) as d, ISNULL(SUM(GrandTotal),0) as cnt
    FROM Transactions
    WHERE TransactionDate >= DATEADD(DAY, -6, CAST(GETDATE() AS DATE))
      AND TransactionType = 'Sale'${userFilter}
    GROUP BY CAST(TransactionDate AS DATE)
  `);

  // تجميع النتائج في مصفوفة 7 أيام (الأحدث آخراً)
  function buildSeries(rows) {
    const map = {};
    for (const r of rows) {
      const d = r.d instanceof Date ? r.d : new Date(r.d);
      map[d.toISOString().slice(0, 10)] = r.cnt;
    }
    const series = [];
    for (let i = 6; i >= 0; i--) {
      const day = new Date();
      day.setDate(day.getDate() - i);
      const key = day.toISOString().slice(0, 10);
      series.push(map[key] ?? 0);
    }
    return series.join(',');
  }

  return {
    clientsTrend7: buildSeries(clientsRes.recordset),
    tasksTrend7: buildSeries(tasksRes.recordset),
    salesTrend7: buildSeries(salesRes.recordset),
  };
}

// تصدير الدوال
module.exports = {
  getDashboardStats,
  getDashboardTrends,
  getRecentActivities,
  getDebugData
};