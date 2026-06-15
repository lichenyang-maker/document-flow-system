/**
 * 销售订货系统 - 全功能综合测试脚本
 * 测试 server-sqlite.js 的所有 API 路由
 */
const http = require('http');
const path = require('path');

const BASE = 'http://localhost:3000';
let token = null;

async function api(method, url, body = null) {
  return new Promise((resolve, reject) => {
    const opts = {
      method,
      hostname: 'localhost',
      port: 3000,
      path: url,
      headers: { 'Content-Type': 'application/json' },
      timeout: 5000
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', e => reject(e));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

function assert(cond, msg) {
  if (!cond) { console.log('  ❌ FAIL: ' + msg); process.exitCode = 1; }
  else console.log('  ✅ PASS: ' + msg);
}

async function waitForServer(retries = 30) {
  for (let i = 0; i < retries; i++) {
    try {
      const r = await api('GET', '/health');
      if (r.status === 200) return true;
    } catch (e) { /* retry */ }
    await new Promise(r => setTimeout(r, 1000));
  }
  throw new Error('Server failed to start in ' + retries + 's');
}

async function runTests() {
  console.log('========================================');
  console.log('  销售订货系统 v6.0 - 全功能测试');
  console.log('========================================\n');

  // === Step 0: Wait for server ===
  console.log('[0] 等待服务器启动...');
  await waitForServer();
  console.log('  ✅ 服务器已就绪\n');

  // === Step 1: Login ===
  console.log('[1] 测试登录');
  let r = await api('POST', '/api/auth/login', { username: 'admin', password: 'admin123' });
  assert(r.status === 200 && r.body.token, '管理员登录成功');
  token = r.body.token;
  console.log('  Token: ' + token.slice(0, 20) + '...\n');

  // === Step 2: Create order (5.1) ===
  console.log('[2] 创建销售订单 (5.1)');
  r = await api('POST', '/api/sales-orders', {
    customer_name: '华为科技', contact_person: '张三', contact_phone: '13800138000',
    order_type: 'normal', product_type: 'standard', quantity: 10, unit: 'PCS',
    price: 5000, amount: 50000, delivery_date: '2026-07-15',
    special_requirements: '需提供合格证'
  });
  assert(r.status === 200 && r.body.success, '创建销售订单');
  const orderId = r.body.id;
  console.log('  订单ID: ' + orderId + ', 单号: ' + r.body.order_no + '\n');

  // === Step 3: Get order list ===
  console.log('[3] 查询订单列表');
  r = await api('GET', '/api/sales-orders');
  assert(r.status === 200 && Array.isArray(r.body) && r.body.length > 0, '获取订单列表');
  console.log('  共 ' + r.body.length + ' 个订单\n');

  // === Step 4: Get single order ===
  console.log('[4] 查询单个订单');
  r = await api('GET', '/api/sales-orders/' + orderId);
  assert(r.status === 200 && r.body.id === orderId, '获取订单#' + orderId + '详情');
  assert(r.body.status === 'draft', '订单状态为draft');
  console.log('  客户: ' + r.body.customer_name + ', 状态: ' + r.body.status + '\n');

  // === Step 5: Submit order for review (5.2) ===
  console.log('[5] 提交订单评审 (5.2)');
  r = await api('POST', '/api/sales-orders/' + orderId + '/review', {
    stage: 'engineering', comment: 'BOM已确认，物料齐套', bom_status: 'completed'
  });
  assert(r.status === 200 && r.body.success, '工程部评审通过');
  console.log('  工程部评审完成\n');

  // === Step 6: Planning review (5.3) ===
  console.log('[6] 计划部交期评审 (5.3)');
  r = await api('POST', '/api/sales-orders/' + orderId + '/review', {
    stage: 'planning', comment: '交期可行', delivery_date: '2026-07-20'
  });
  assert(r.status === 200 && r.body.success, '计划部评审通过');
  console.log('  计划部交期评审完成\n');

  // === Step 7: Business confirmation (5.3) ===
  console.log('[7] 业务部确认 (5.3)');
  r = await api('POST', '/api/sales-orders/' + orderId + '/review', {
    stage: 'business', comment: '已确认'
  });
  assert(r.status === 200 && r.body.success, '业务部确认通过');
  console.log('  业务部确认完成\n');

  // === Step 8: Order change (5.4) ===
  console.log('[8] 订单变更 (5.4)');
  r = await api('POST', '/api/sales-orders/' + orderId + '/change', {
    change_notes: '客户要求数量改为20台'
  });
  assert(r.status === 200 && r.body.success, '订单变更');
  console.log('  订单变更为draft状态\n');

  // === Step 9: Change review API (5.4) ===
  console.log('[9] 变更评审记录 (5.4)');
  r = await api('POST', '/api/change-reviews', {
    order_id: orderId, change_type: '数量变更', change_detail: '10台→20台', reason: '客户需求增加'
  });
  assert(r.status === 200 && r.body.success, '创建变更评审记录');
  r = await api('GET', '/api/change-reviews?order_id=' + orderId);
  assert(r.status === 200 && Array.isArray(r.body), '查询变更评审记录');
  console.log('  变更评审记录数: ' + r.body.length + '\n');

  // === Step 10: New product review (5.5) ===
  console.log('[10] 新产品评审 (5.5)');
  r = await api('POST', '/api/new-product-reviews', {
    order_id: orderId, product_name: '定制服务器SVR-2000',
    product_code: 'SVR-2000', specification: '2U机架式/64核/256GB'
  });
  assert(r.status === 200 && r.body.success, '创建新产品评审');
  r = await api('GET', '/api/new-product-reviews');
  assert(r.status === 200 && Array.isArray(r.body), '查询新产品评审列表');
  console.log('  新产品评审记录数: ' + r.body.length + '\n');

  // === Step 11: Rush order (5.6) ===
  console.log('[11] 急插单管理 (5.6)');
  r = await api('POST', '/api/rush-orders', {
    order_id: orderId, rush_reason: '客户紧急需求',
    original_delivery: '2026-07-20', new_delivery: '2026-07-10', days_ahead: 10
  });
  assert(r.status === 200 && r.body.success, '创建急插单');
  r = await api('GET', '/api/rush-orders?order_id=' + orderId);
  assert(r.status === 200 && Array.isArray(r.body), '查询急插单记录');
  console.log('  急插单记录数: ' + r.body.length + '\n');

  // === Step 12: Order confirmation (5.7) ===
  console.log('[12] 订单确认 (5.7)');
  r = await api('POST', '/api/order-confirmations', {
    order_id: orderId, customer_name: '华为科技',
    total_amount: 100000, deposit_amount: 30000,
    delivery_terms: 'FOB深圳', payment_terms: '30%定金+70%尾款'
  });
  assert(r.status === 200 && r.body.success, '创建订单确认单');
  assert(r.body.conf_no, '确认单号生成');
  console.log('  确认单号: ' + r.body.conf_no + '\n');

  // === Step 13: Contact form (5.8) ===
  console.log('[13] 联络单管理 (5.8)');
  r = await api('POST', '/api/contact-forms', {
    title: '关于SVR-2000样品确认的联络', content: '请计划部安排样品生产',
    department: '业务部/市场部'
  });
  assert(r.status === 200 && r.body.success, '创建联络单');
  r = await api('GET', '/api/contact-forms');
  assert(r.status === 200 && Array.isArray(r.body), '查询联络单列表');
  console.log('  联络单数: ' + r.body.length + '\n');

  // === Step 14: Monthly forecast (5.8) ===
  console.log('[14] 月度预测计划 (5.8)');
  r = await api('POST', '/api/monthly-forecasts', {
    month: '2026-07', department: '业务部/市场部',
    product_category: '服务器', forecast_quantity: 200, notes: '预计量'
  });
  assert(r.status === 200 && r.body.success, '创建月度预测');
  r = await api('GET', '/api/monthly-forecasts');
  assert(r.status === 200 && Array.isArray(r.body), '查询月度预测列表');
  console.log('  预测记录数: ' + r.body.length + '\n');

  // === Step 15: Inventory (5.9) ===
  console.log('[15] 库存管理 (5.9)');
  r = await api('POST', '/api/inventory', {
    product_code: 'SVR-2000', product_name: '定制服务器',
    category: '电子设备', specification: '2U', quantity: 50, unit: '台',
    location: 'A1-01', min_stock: 10, max_stock: 200
  });
  assert(r.status === 200 && r.body.success, '添加/更新库存');
  r = await api('GET', '/api/inventory?product_code=SVR-2000');
  assert(r.status === 200 && r.body.length > 0, '查询库存');
  console.log('  库存数量: ' + (r.body[0]?.quantity || 0) + '\n');

  // === Step 16: Production cycle (5.10) ===
  console.log('[16] 生产周期表 (5.10)');
  r = await api('POST', '/api/production-cycles', {
    product_code: 'SVR-2000', product_name: '定制服务器',
    lead_days: 30, cycle_category: 'standard'
  });
  assert(r.status === 200 && r.body.success, '添加生产周期');
  r = await api('GET', '/api/production-cycles');
  assert(r.status === 200 && Array.isArray(r.body), '查询生产周期');
  console.log('  生产周期记录数: ' + r.body.length + '\n');

  // === Step 17: Delivery stats (5.9) ===
  console.log('[17] 交付率统计 (5.9)');
  r = await api('POST', '/api/delivery-stats', {
    month: '2026-06', total_orders: 50, on_time: 45,
    delay_count: 5, delay_reason: '物料短缺', improvement: '加强供应商管理'
  });
  assert(r.status === 200 && r.body.success, '添加交付率统计');
  r = await api('GET', '/api/delivery-stats');
  assert(r.status === 200 && Array.isArray(r.body), '查询交付率统计');
  console.log('  准时率: ' + (r.body[0]?.on_time_pct || 'N/A') + '%\n');

  // === Step 18: Order stats ===
  console.log('[18] 订单统计');
  r = await api('GET', '/api/sales-orders/stats/info');
  assert(r.status === 200, '获取订单统计');
  console.log('  统计: ' + JSON.stringify(r.body) + '\n');

  // === Step 19: BOM materials ===
  console.log('[19] BOM物料管理');
  r = await api('POST', '/api/bom-materials', {
    order_id: orderId, product_code: 'SVR-2000',
    material_code: 'CPU-001', material_name: 'Intel Xeon处理器',
    specification: '64核', quantity: 2, unit: '颗'
  });
  assert(r.status === 200 && r.body.success, '添加BOM物料');
  r = await api('GET', '/api/bom-materials?order_id=' + orderId);
  assert(r.status === 200 && Array.isArray(r.body), '查询BOM物料');
  console.log('  BOM物料数: ' + r.body.length + '\n');

  // === Step 20: Notification logs ===
  console.log('[20] 通知日志');
  r = await api('GET', '/api/notification-logs');
  if (r.status === 200) console.log('  ✅ 通知日志API正常');
  else console.log('  ⚠️ 通知日志查询: ' + r.status + '\n');

  // === Step 21: Router API ===
  console.log('[21] AI Router API');
  r = await api('POST', '/api/ai/router', {
    message: '查询我的订单'
  });
  assert(r.status === 200 && r.body.success !== false, 'AI路由正常工作');
  console.log('  AI响应: ' + (r.body.content || r.body.message || '').slice(0, 60) + '...\n');

  // === Step 22: Health check ===
  console.log('[22] 健康检查');
  r = await api('GET', '/health');
  assert(r.status === 200, '健康检查通过');
  console.log('  ' + JSON.stringify(r.body) + '\n');

  // === Summary ===
  console.log('========================================');
  if (process.exitCode) {
    console.log('  ⚠️ 部分测试失败');
  } else {
    console.log('  ✅ 全部测试通过！');
  }
  console.log('========================================');
}

runTests().catch(e => {
  console.error('❌ 测试异常:', e.message);
  process.exit(1);
});
