/**
 * 销售订货系统 - 测试数据生成脚本
 * 使用真实的企业级测试数据填充系统
 * 运行: node tools/seed-data.js
 */
const http = require('http');
const API = 'http://localhost:3000';

function api(method, path, body, token) {
  return new Promise((resolve, reject) => {
    const opts = {
      method, hostname: 'localhost', port: 3000, path,
      headers: { 'Content-Type': 'application/json' },
      timeout: 10000
    };
    if (token) opts.headers['Authorization'] = 'Bearer ' + token;
    const req = http.request(opts, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { resolve(data); } });
    });
    req.on('error', e => reject(e));
    if (body) req.write(JSON.stringify(body));
    req.end();
  });
}

async function seed() {
  console.log('=== 销售订货系统 - 测试数据生成 ===\n');
  
  // Login as admin
  const login = await api('POST', '/api/public/login', { username: 'admin', password: 'admin123' });
  if (!login.token) { console.log('登录失败'); return; }
  const t = login.token;
  console.log('✅ 登录成功\n');

  let count = 0;

  // ====== 1. 库存数据 ======
  const inventory = [
    { product_code: 'SVR-2000', product_name: '机架式服务器 2U', category: '服务器', quantity: 150, unit: 'PCS', location: 'A1-01', min_stock: 20, max_stock: 300 },
    { product_code: 'SVR-1580', product_name: '塔式服务器', category: '服务器', quantity: 80, unit: 'PCS', location: 'A1-02', min_stock: 10, max_stock: 200 },
    { product_code: 'SW-5024', product_name: '48口千兆交换机', category: '网络设备', quantity: 200, unit: 'PCS', location: 'B2-01', min_stock: 30, max_stock: 500 },
    { product_code: 'SW-3024', product_name: '24口千兆交换机', category: '网络设备', quantity: 350, unit: 'PCS', location: 'B2-02', min_stock: 50, max_stock: 600 },
    { product_code: 'RT-8806', product_name: '企业核心路由器', category: '网络设备', quantity: 45, unit: 'PCS', location: 'B3-01', min_stock: 5, max_stock: 100 },
    { product_code: 'ST-4TB', product_name: '4TB企业级硬盘', category: '存储', quantity: 500, unit: 'PCS', location: 'C1-01', min_stock: 100, max_stock: 1000 },
    { product_code: 'ST-8TB', product_name: '8TB企业级硬盘', category: '存储', quantity: 300, unit: 'PCS', location: 'C1-02', min_stock: 50, max_stock: 800 },
    { product_code: 'MEM-32G', product_name: '32GB DDR4内存', category: '内存', quantity: 800, unit: 'PCS', location: 'C2-01', min_stock: 200, max_stock: 1500 },
    { product_code: 'MEM-64G', product_name: '64GB DDR4内存', category: '内存', quantity: 400, unit: 'PCS', location: 'C2-02', min_stock: 100, max_stock: 1000 },
    { product_code: 'NW-MOD', product_name: '万兆光模块 SFP+', category: '网络模块', quantity: 1200, unit: 'PCS', location: 'B1-01', min_stock: 300, max_stock: 2500 },
  ];
  for (const inv of inventory) {
    await api('POST', '/api/inventory', inv, t);
    count++;
  }
  console.log(`✅ 库存数据: ${inventory.length} 条`);

  // ====== 2. 生产周期表 ======
  const cycles = [
    { product_code: 'SVR-2000', product_name: '机架式服务器 2U', lead_days: 30, cycle_category: 'standard' },
    { product_code: 'SVR-1580', product_name: '塔式服务器', lead_days: 25, cycle_category: 'standard' },
    { product_code: 'SW-5024', product_name: '48口千兆交换机', lead_days: 20, cycle_category: 'standard' },
    { product_code: 'RT-8806', product_name: '企业核心路由器', lead_days: 45, cycle_category: 'custom' },
    { product_code: 'CUSTOM-SVR', product_name: '定制化服务器', lead_days: 60, cycle_category: 'custom' },
  ];
  for (const cy of cycles) {
    await api('POST', '/api/production-cycles', cy, t);
    count++;
  }
  console.log(`✅ 生产周期表: ${cycles.length} 条`);

  // ====== 3. 销售订单 ======
  const customers = ['华为科技', '腾讯云', '阿里巴巴', '字节跳动', '中兴通讯', '小米科技', '比亚迪'];
  const products = [
    { name: '机架式服务器 2U', code: 'SVR-2000', price: 58000 },
    { name: '48口千兆交换机', code: 'SW-5024', price: 12000 },
    { name: '企业核心路由器', code: 'RT-8806', price: 85000 },
    { name: '8TB企业级硬盘', code: 'ST-8TB', price: 2800 },
    { name: '64GB DDR4内存', code: 'MEM-64G', price: 1800 },
  ];
  const statuses = ['draft', 'draft', 'PENDING_ENG', 'PENDING_ENG', 'PENDING_PLAN', 'PENDING_BIZ', 'confirmed', 'confirmed', 'shipped', 'shipped'];

  for (let i = 0; i < 12; i++) {
    const cust = customers[i % customers.length];
    const prod = products[i % products.length];
    const qty = Math.floor(Math.random() * 100) + 10;
    const status = statuses[i % statuses.length];
    const now = new Date();
    const deliveryDate = new Date(now);
    deliveryDate.setDate(deliveryDate.getDate() + 45);

    const orderData = {
      customer_name: cust,
      product_name: prod.name,
      product_code: prod.code,
      quantity: qty,
      unit: 'PCS',
      price: prod.price,
      amount: prod.price * qty,
      delivery_date: deliveryDate.toISOString().slice(0,10),
      product_type: i % 2 === 0 ? 'standard' : 'non_standard',
      order_type: 'normal',
      contact_person: '张经理',
      special_requirements: i % 3 === 0 ? '需提供原厂质保函' : (i % 3 === 1 ? '含安装调试服务' : '')
    };

    const order = await api('POST', '/api/sales-orders', orderData, t);
    count++;
    
    if (order && order.id) {
      // Submit for draft orders to move to review
      if (status !== 'draft') {
        await api('POST', '/api/orders/' + order.id + '/submit', {}, t);
        
        if (status === 'PENDING_ENG' || status === 'PENDING_PLAN' || status === 'PENDING_BIZ' || status === 'confirmed' || status === 'shipped') {
          await api('POST', '/api/sales-orders/' + order.id + '/review', { stage: 'engineering', comment: 'BOM制定完成，物料齐全', bom_status: 'completed' }, t);
          
          if (status === 'PENDING_PLAN' || status === 'PENDING_BIZ' || status === 'confirmed' || status === 'shipped') {
            const planDelivery = new Date(now);
            planDelivery.setDate(planDelivery.getDate() + 30);
            await api('POST', '/api/sales-orders/' + order.id + '/review', { stage: 'planning', comment: '交期可行，安排在产线2号线生产', delivery_date: planDelivery.toISOString().slice(0,10) }, t);
            
            if (status === 'PENDING_BIZ' || status === 'confirmed' || status === 'shipped') {
              await api('POST', '/api/sales-orders/' + order.id + '/review', { stage: 'business', comment: '交期已确认，同意' }, t);
              
              if (status === 'confirmed' || status === 'shipped') {
                await api('POST', '/api/order-confirmations', { order_id: order.id, customer_name: cust, total_amount: prod.price * qty, deposit_amount: Math.round(prod.price * qty * 0.3), delivery_terms: 'FOB 深圳', payment_terms: '30%定金+70%尾款' }, t);
                
                if (status === 'shipped') {
                  await api('POST', '/api/sales-orders/' + order.id + '/ship', {}, t);
                }
              }
            }
          }
        }
      }
    }
  }
  console.log(`✅ 销售订单: 12 条 (含草稿/评审/确认/发货各状态)`);

  // ====== 4. 急插单 ======
  const rushOrders = [
    { order_id: 3, rush_reason: '客户紧急扩容需求，数据中心项目急需', original_delivery: '2026-07-20', new_delivery: '2026-07-10', days_ahead: 10 },
    { order_id: 5, rush_reason: '华为紧急订单，应对618大促', original_delivery: '2026-07-15', new_delivery: '2026-06-30', days_ahead: 15 },
  ];
  for (const ro of rushOrders) {
    await api('POST', '/api/rush-orders', ro, t);
    count++;
  }
  console.log(`✅ 急插单: ${rushOrders.length} 条`);

  // ====== 5. 变更评审 ======
  const changes = [
    { order_id: 2, change_type: '数量变更', change_detail: '原订50台改为80台', reason: '客户业务量增长' },
    { order_id: 4, change_type: '交期变更', change_detail: '交货期从7月15日延至8月1日', reason: '客户项目延期' },
  ];
  for (const ch of changes) {
    await api('POST', '/api/change-reviews', ch, t);
    count++;
  }
  console.log(`✅ 变更评审: ${changes.length} 条`);

  // ====== 6. 联络单 ======
  const contacts = [
    { title: '请确认SVR-2000新版BOM', content: '工程部已完成新版BOM制定，请计划部确认物料采购计划', department: '工程部' },
    { title: '产线2号线维护通知', content: '计划部暂定7月20日-22日对2号线进行维护，请业务部调整交期安排', department: '计划部' },
    { title: '客户样品测试报告', content: '华为科技对SVR-2000样机测试通过，可以进入量产阶段', department: '品质部' },
    { title: '关于RT-8806路由器配件变更', content: '路由器电源模块供应商变更，新物料编码PWR-8806-NEW，请更新BOM', department: '采购部' },
  ];
  for (const ct of contacts) {
    await api('POST', '/api/contact-forms', ct, t);
    count++;
  }
  console.log(`✅ 联络单: ${contacts.length} 条`);

  // ====== 7. 月度预测 ======
  const forecasts = [
    { month: '2026-07', department: '国内业务部', product_category: '服务器', forecast_quantity: 500, notes: '基于Q3需求预测' },
    { month: '2026-07', department: '国内业务部', product_category: '网络设备', forecast_quantity: 800, notes: '华为/中兴集采项目' },
    { month: '2026-07', department: '国际业务部', product_category: '存储设备', forecast_quantity: 300, notes: '东南亚市场拓展' },
    { month: '2026-08', department: '国内业务部', product_category: '服务器', forecast_quantity: 600, notes: 'Q3旺季备货' },
    { month: '2026-08', department: '国内业务部', product_category: '交换机', forecast_quantity: 1000, notes: '教育行业暑期项目' },
  ];
  for (const fc of forecasts) {
    await api('POST', '/api/monthly-forecasts', fc, t);
    count++;
  }
  console.log(`✅ 月度预测: ${forecasts.length} 条`);

  // ====== 8. 交付率统计 ======
  const deliveries = [
    { month: '2026-04', total_orders: 85, on_time: 72, delay_count: 13, on_time_pct: 84.7, delay_reason: '芯片短缺导致SVR-2000延期交付', improvement: '提前储备关键芯片，增加备选供应商' },
    { month: '2026-05', total_orders: 92, on_time: 81, delay_count: 11, on_time_pct: 88.0, delay_reason: '产线检修影响部分订单', improvement: '优化产线维护计划，安排在淡季检修' },
    { month: '2026-06', total_orders: 78, on_time: 70, delay_count: 8, on_time_pct: 89.7, delay_reason: '物流延误', improvement: '增加备用物流渠道' },
  ];
  for (const dl of deliveries) {
    await api('POST', '/api/delivery-stats', dl, t);
    count++;
  }
  console.log(`✅ 交付率统计: ${deliveries.length} 条`);

  // ====== 9. BOM物料 ======
  const boms = [
    { order_id: 2, product_code: 'SVR-2000', material_code: 'CPU-INTEL-6428', material_name: 'Intel Xeon Gold 6428N', specification: '32核心/64线程', quantity: 2, unit: 'PCS' },
    { order_id: 2, product_code: 'SVR-2000', material_code: 'MEM-64G-DDR5', material_name: '64GB DDR5 ECC内存', specification: 'DDR5-4800', quantity: 8, unit: 'PCS' },
    { order_id: 2, product_code: 'SVR-2000', material_code: 'HDD-4TB-SATA', material_name: '4TB SATA企业级硬盘', specification: '7.2K RPM', quantity: 4, unit: 'PCS' },
    { order_id: 2, product_code: 'SVR-2000', material_code: 'PSU-1200W', material_name: '1200W冗余电源', specification: '1+1冗余', quantity: 2, unit: 'PCS' },
  ];
  for (const bm of boms) {
    await api('POST', '/api/bom-materials', bm, t);
    count++;
  }
  console.log(`✅ BOM物料: ${boms.length} 条`);

  // ====== 10. 新产品评审 ======
  const newProducts = [
    { order_id: 6, product_name: 'AI推理服务器 A800', product_code: 'AI-A800', specification: '8卡GPU/4U机架式' },
    { order_id: 8, product_name: '液冷交换机 LC-12000', product_code: 'LC-12000', specification: '128口/液冷散热' },
  ];
  for (const np of newProducts) {
    await api('POST', '/api/new-product-reviews', np, t);
    count++;
  }
  console.log(`✅ 新产品评审: ${newProducts.length} 条`);

  // ====== 11. 通知日志 ======
  console.log(`✅ 通知日志: 自动记录\n`);

  console.log(`========================================`);
  console.log(`📊 总共生成测试数据: ${count} 条`);
  console.log(`========================================`);
  console.log(`\n📋 访问 http://localhost:3000/sales 查看数据`);
  console.log(`📋 访问 http://localhost:3000/flow 查看流程图实时数据`);
  process.exit(0);
}

seed().catch(e => { console.error('错误:', e.message); process.exit(1); });
