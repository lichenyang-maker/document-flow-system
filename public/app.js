// app.js - 智能公文流转系统前端逻辑

const API = window.location.hostname === 'localhost' ? 'http://localhost:3000' : '';
let token = '';
let currentUser = null;
let isAdmin = false;

// ===================== 登录 =====================
const _loginBtn = document.getElementById('loginBtn');
if (_loginBtn) _loginBtn.addEventListener('click', doLogin);
const _loginPass = document.getElementById('loginPass');
if (_loginPass) _loginPass.addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });

async function doLogin() {
  const u = document.getElementById('loginUser').value.trim();
  const p = document.getElementById('loginPass').value;
  const err = document.getElementById('loginErr');
  err.textContent = '';
  if (!u || !p) { err.textContent = '请输入用户名和密码'; return; }
  try {
    const res = await fetch(API + '/api/public/login', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: u, password: p })
    });
    const data = await res.json();
    if (!res.ok) { err.textContent = data.message || '登录失败'; return; }
    token = data.token;
    await initApp();
  } catch (e) { err.textContent = '网络错误，请检查后端服务'; }
}

async function initApp() {
  const lo = document.getElementById('loginOverlay');
  if (lo) lo.classList.add('hidden');
  const lp = document.getElementById('loginPage');
  if (lp) lp.style.display = 'none';
  try {
    const res = await fetch(API + '/api/auth/me', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return doLogout();
    currentUser = await res.json();
    isAdmin = currentUser.role === 'ADMIN' || currentUser.username === 'admin';
    const name = currentUser.name || currentUser.username || '用户';
    document.getElementById('sbName').textContent = name;
    document.getElementById('sbRole').textContent = isAdmin ? '管理员' : '普通用户';
    document.getElementById('sbAvatar').textContent = name.charAt(0).toUpperCase();
    document.getElementById('topbarAvatar').textContent = name.charAt(0).toUpperCase();
    const h = new Date().getHours();
    const greet = h < 6 ? '凌晨好' : h < 9 ? '早上好' : h < 12 ? '上午好' : h < 14 ? '中午好' : h < 18 ? '下午好' : '晚上好';
    document.getElementById('welcomeMsg').textContent = greet + '，' + name;
  } catch (e) {}
  startClock();
  switchTab('dashboard');
}

function doLogout() {
  token = '';
  currentUser = null;
  isAdmin = false;
  document.getElementById('loginOverlay').classList.remove('hidden');
}

// ===================== 时钟 =====================
function startClock() {
  function update() {
    const now = new Date();
    const ts = now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const ds = now.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'long' });
    const elClock = document.getElementById('clockBig');
    const elDate = document.getElementById('clockDate');
    const elTopbar = document.getElementById('topbarTime');
    if (elClock) elClock.textContent = ts;
    if (elDate) elDate.textContent = ds;
    if (elTopbar) elTopbar.textContent = ts;
  }
  update();
  setInterval(update, 1000);
}

// ===================== 侧边栏 =====================
function toggleSidebar() {
  const sb = document.getElementById('sidebar');
  if (sb) sb.classList.toggle('open');
}

function switchTab(tab) {
  document.querySelectorAll('.ni').forEach(n => n.classList.remove('active'));
  const activeNav = document.querySelector('.ni[data-tab="' + tab + '"]');
  if (activeNav) activeNav.classList.add('active');
  document.querySelectorAll('.ps').forEach(p => p.classList.add('hidden'));
  const section = document.getElementById(tab + 'Section');
  if (section) section.classList.remove('hidden');
  const titleMap = { dashboard: '工作台', docs: '公文管理', leave: '请假管理' };
  const pageTitle = document.getElementById('pageTitle');
  if (pageTitle) pageTitle.textContent = titleMap[tab] || '工作台';
  if (tab === 'dashboard') loadDashboard();
  if (tab === 'docs') loadDocs();
}

// ===================== 统计 =====================
async function loadDashboard() {
  try {
    const res = await fetch(API + '/api/stats', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return;
    const s = await res.json();
    const elTotal = document.getElementById('statTotal');
    const elPending = document.getElementById('statPending');
    const elApproved = document.getElementById('statApproved');
    const elRejected = document.getElementById('statRejected');
    if (elTotal) elTotal.textContent = (s.totalDocs || 0) + (s.totalLeave || 0);
    if (elPending) elPending.textContent = s.pending || 0;
    if (elApproved) elApproved.textContent = s.approved || 0;
    if (elRejected) elRejected.textContent = s.rejected || 0;
  } catch (e) {}
}

// ===================== 公文/请假 统一列表 =====================
let currentDocFilter = 'all';

async function loadDocs() {
  try {
    const resDocs = await fetch(API + '/api/docs', { headers: { 'Authorization': 'Bearer ' + token } });
    const docs = resDocs.ok ? (await resDocs.json()).data || [] : [];
    const resLeaves = await fetch(API + '/api/leave', { headers: { 'Authorization': 'Bearer ' + token } });
    const leaves = resLeaves.ok ? (await resLeaves.json()).data || [] : [];

    let combined = [];
    docs.forEach(d => combined.push({ ...d, _type: 'doc', _title: d.title, _time: d.created_at }));
    leaves.forEach(l => combined.push({ ...l, _type: 'leave', _title: (l.user_name || '未知') + '的请假', _time: l.created_at }));

    if (currentDocFilter === 'doc') combined = combined.filter(x => x._type === 'doc');
    if (currentDocFilter === 'leave') combined = combined.filter(x => x._type === 'leave');

    combined.sort((a, b) => new Date(b._time) - new Date(a._time));

    const tbody = document.getElementById('docTableBody');
    if (!combined.length) { if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="em">暂无数据</td></tr>'; return; }

    if (tbody) tbody.innerHTML = combined.map(item => {
      const typeBadge = item._type === 'doc'
        ? '<span class="typ-b typ-doc">📄 公文</span>'
        : '<span class="typ-b typ-leave">🏖️ 请假</span>';
      const statusBadge = item.status === 'APPROVED' ? '<span class="bdge bdge-a">已通过</span>'
        : item.status === 'REJECTED' ? '<span class="bdge bdge-r">已驳回</span>'
        : '<span class="bdge bdge-p"><span class="d"></span>待审批</span>';
      const title = item._type === 'doc' ? (item.title || '无标题') : (item.user_name || '未知') + '的' + (item.type || '请假');
      const detail = item._type === 'doc' ? ((item.content || '').substring(0, 30) + '...') : (item.type || '') + ' ' + (item.days || '?') + '天';
      const time = item._time ? new Date(item._time).toLocaleString('zh-CN') : '—';
      let actions = '';
      if (isAdmin && item.status !== 'APPROVED' && item.status !== 'REJECTED') {
        actions = '<div class="ac"><button class="btn btn-ok" onclick="approveItem(\'' + item._type + '\',' + item.id + ')">通过</button>'
                + '<button class="btn btn-no" onclick="rejectItem(\'' + item._type + '\',' + item.id + ')">驳回</button></div>';
      }
      return '<tr><td>' + typeBadge + '</td><td>' + title + '</td><td>' + detail + '</td><td>' + time + '</td><td>' + statusBadge + '</td><td>' + actions + '</td></tr>';
    }).join('');
  } catch (e) { const tbody = document.getElementById('docTableBody'); if (tbody) tbody.innerHTML = '<tr><td colspan="6" class="em">加载失败</td></tr>'; }
}

function filterDocs(filter, btn) {
  currentDocFilter = filter;
  document.querySelectorAll('.filters .ft').forEach(b => b.classList.remove('active'));
  if (btn) btn.classList.add('active');
  loadDocs();
}

// ===================== 审批 =====================
async function approveItem(type, id) {
  try {
    const endpoint = type === 'doc' ? '/api/docs/' + id + '/approve' : '/api/leave/' + id + '/approve';
    await fetch(API + endpoint, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
    showToast('已通过');
    loadDocs();
    loadDashboard();
  } catch (e) { showToast('操作失败', 'error'); }
}

async function rejectItem(type, id) {
  try {
    const endpoint = type === 'doc' ? '/api/docs/' + id + '/reject' : '/api/leave/' + id + '/reject';
    await fetch(API + endpoint, { method: 'POST', headers: { 'Authorization': 'Bearer ' + token } });
    showToast('已驳回');
    loadDocs();
    loadDashboard();
  } catch (e) { showToast('操作失败', 'error'); }
}

// ===================== 新增弹窗 =====================
function openAddModal() {
  const modal = document.getElementById('addModal');
  if (modal) modal.classList.add('show');
  loadUsersForLeave();
}

function closeAddModal() {
  const modal = document.getElementById('addModal');
  if (modal) modal.classList.remove('show');
  const docForm = document.getElementById('docForm');
  const leaveForm = document.getElementById('leaveForm');
  const submitDocBtn = document.getElementById('submitDocBtn');
  const submitLeaveBtn = document.getElementById('submitLeaveBtn');
  const typeDoc = document.getElementById('typeDoc');
  const typeLeave = document.getElementById('typeLeave');
  if (docForm) docForm.classList.add('hidden');
  if (leaveForm) leaveForm.classList.add('hidden');
  if (submitDocBtn) submitDocBtn.classList.add('hidden');
  if (submitLeaveBtn) submitLeaveBtn.classList.add('hidden');
  if (typeDoc) typeDoc.classList.remove('selected');
  if (typeLeave) typeLeave.classList.remove('selected');
}

function selectType(type) {
  const typeDoc = document.getElementById('typeDoc');
  const typeLeave = document.getElementById('typeLeave');
  const docForm = document.getElementById('docForm');
  const leaveForm = document.getElementById('leaveForm');
  const submitDocBtn = document.getElementById('submitDocBtn');
  const submitLeaveBtn = document.getElementById('submitLeaveBtn');
  if (typeDoc) typeDoc.classList.toggle('selected', type === 'doc');
  if (typeLeave) typeLeave.classList.toggle('selected', type === 'leave');
  if (docForm) docForm.classList.toggle('hidden', type !== 'doc');
  if (leaveForm) leaveForm.classList.toggle('hidden', type !== 'leave');
  if (submitDocBtn) submitDocBtn.classList.toggle('hidden', type !== 'doc');
  if (submitLeaveBtn) submitLeaveBtn.classList.toggle('hidden', type !== 'leave');
}

async function loadUsersForLeave() {
  try {
    const res = await fetch(API + '/api/users', { headers: { 'Authorization': 'Bearer ' + token } });
    if (!res.ok) return;
    const users = await res.json();
    const sel = document.getElementById('leaveUser');
    if (sel) sel.innerHTML = users.map(u => '<option value="' + u.id + '">' + (u.name || u.username) + '</option>').join('');
  } catch (e) {}
}

// ===================== 提交 =====================
async function submitDoc() {
  const title = document.getElementById('docTitle').value.trim();
  const content = document.getElementById('docContent').value.trim();
  const type = document.getElementById('docType').value;
  const priority = document.getElementById('docPriority').value;
  if (!title) { showToast('请输入标题', 'error'); return; }
  try {
    await fetch(API + '/api/docs', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title, content, type, priority })
    });
    showToast('提交成功');
    closeAddModal();
    loadDocs();
    loadDashboard();
  } catch (e) { showToast('提交失败', 'error'); }
}

async function submitLeave() {
  const userId = document.getElementById('leaveUser').value;
  const type = document.getElementById('leaveType').value;
  const days = document.getElementById('leaveDays').value;
  const startDate = document.getElementById('leaveStart').value;
  const endDate = document.getElementById('leaveEnd').value;
  const reason = document.getElementById('leaveReason').value.trim();
  if (!days || !startDate || !endDate) { showToast('请填写完整', 'error'); return; }
  try {
    await fetch(API + '/api/leave', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + token, 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: userId, type, days: parseFloat(days), start_date: startDate, end_date: endDate, reason })
    });
    showToast('提交成功');
    closeAddModal();
    loadDocs();
    loadDashboard();
  } catch (e) { showToast('提交失败', 'error'); }
}

// ===================== Toast =====================
function showToast(msg, type) {
  type = type || 'success';
  const t = document.createElement('div');
  t.className = 'toast toast-' + type;
  t.textContent = msg;
  t.style.cssText = 'position:fixed;bottom:24px;right:24px;padding:14px 24px;border-radius:16px;font-size:0.95rem;font-weight:600;z-index:9999;'
    + (type === 'success' ? 'background:rgba(52,211,153,0.18);color:#34d399;border:1px solid rgba(52,211,153,0.25);' : 'background:rgba(251,113,133,0.18);color:#fb7185;border:1px solid rgba(251,113,133,0.25);');
  document.body.appendChild(t);
  setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 2500);
}
