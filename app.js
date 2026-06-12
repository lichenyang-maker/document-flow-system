(function() {
  'use strict';

  var API = '/api';
  var currentUser = null;
  var allItems = [];      // 统一列表数据
  var currentFilter = 'all'; // 当前筛选

  // ===== 时钟 =====
  function updateClock() {
    var d = new Date();
    var timeStr = d.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    var dateStr = d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
    var elBig = document.getElementById('clockBig');
    var elDate = document.getElementById('clockDate');
    var elTop = document.getElementById('topbarTime');
    if (elBig) elBig.textContent = timeStr;
    if (elDate) elDate.textContent = dateStr;
    if (elTop) elTop.textContent = timeStr;
  }
  setInterval(updateClock, 1000);
  updateClock();

  // ===== 侧边栏 =====
  window.toggleSidebar = function() {
    var sb = document.getElementById('sidebar');
    if (sb) sb.classList.toggle('open');
  };

  // ===== 登录 =====
  var loginBtn = document.getElementById('loginBtn');
  if (loginBtn) {
    loginBtn.addEventListener('click', function() { doLogin(); });
  }

  async function doLogin() {
    var username = document.getElementById('loginUser').value.trim();
    var password = document.getElementById('loginPass').value;
    var errEl = document.getElementById('loginErr');
    if (errEl) errEl.textContent = '';
    if (!username || !password) {
      if (errEl) errEl.textContent = '请填写用户名和密码';
      return;
    }
    try {
      var res = await fetch(API + '/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username: username, password: password })
      });
      var data = await res.json();
      if (data.success) {
        currentUser = data.user;
        onLoginSuccess();
      } else {
        if (errEl) errEl.textContent = '❌ ' + (data.message || '登录失败');
      }
    } catch(e) {
      if (errEl) errEl.textContent = '❌ 网络错误，请稍后重试';
    }
  }

  function onLoginSuccess() {
    var init = (currentUser.name || 'U')[0];

    var els = ['sbAvatar','topbarAvatar'];
    els.forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.textContent = init;
    });

    var sbName = document.getElementById('sbName');
    var sbRole = document.getElementById('sbRole');
    if (sbName) sbName.textContent = currentUser.name;
    if (sbRole) sbRole.textContent = currentUser.role === 'ADMIN' ? '管理员' : '员工';

    var h = new Date().getHours();
    var greet;
    if (h < 6) greet = '🌙 夜深了，';
    else if (h < 12) greet = '☀️ 上午好，';
    else if (h < 18) greet = '🌤️ 下午好，';
    else greet = '🌙 晚上好，';

    var welcomeMsg = document.getElementById('welcomeMsg');
    var welcomeSub = document.getElementById('welcomeSub');
    if (welcomeMsg) welcomeMsg.textContent = greet + currentUser.name;
    if (welcomeSub) {
      welcomeSub.textContent = currentUser.role === 'ADMIN'
        ? '工作台 · 点击"待审批"卡片快速处理'
        : '你的申请记录 · 点击"新增"提交申请 😊';
    }

    var overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.add('hidden');

    loadAllData();
  }

  window.doLogout = function() {
    currentUser = null;
    var overlay = document.getElementById('loginOverlay');
    if (overlay) overlay.classList.remove('hidden');
    ['loginUser','loginPass'].forEach(function(id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    var errEl = document.getElementById('loginErr');
    if (errEl) errEl.textContent = '';
  };

  // ===== 标签切换 =====
  window.switchTab = function(tab) {
    var navItems = document.querySelectorAll('.ni');
    navItems.forEach(function(item) {
      item.classList.toggle('active', item.getAttribute('data-tab') === tab);
    });
    var dash = document.getElementById('dashboardSection');
    var docs = document.getElementById('docsSection');
    var title = document.getElementById('pageTitle');
    if (dash) dash.classList.toggle('hidden', tab !== 'dashboard');
    if (docs) docs.classList.toggle('hidden', tab !== 'docs');
    if (title) title.textContent = tab === 'dashboard' ? '工作台' : '公文管理';

    if (tab === 'docs') loadAllData();
  };

  // ===== 数据加载 =====
  async function loadAllData() {
    await loadUsers();
    await Promise.all([loadDocs(), loadLeaveRequests()]);
    mergeAndRender();
  }

  async function loadUsers() {
    try {
      var res = await fetch(API + '/public/users');
      var data = await res.json();
      if (data.success) {
        var sel = document.getElementById('leaveUser');
        if (sel) {
          sel.innerHTML = '';
          data.users.forEach(function(u) {
            var opt = document.createElement('option');
            opt.value = u.id;
            opt.textContent = u.name;
            sel.appendChild(opt);
          });
          if (currentUser && currentUser.role !== 'ADMIN') {
            sel.value = currentUser.id;
            sel.disabled = true;
          }
        }
      }
    } catch(e) { console.error(e); }
  }

  async function loadDocs() {
    try {
      var res = await fetch(API + '/docs');
      var data = await res.json();
      if (data.success) {
        window._docs = data.documents || [];
      } else {
        window._docs = [];
      }
    } catch(e) { window._docs = []; }
  }

  async function loadLeaveRequests() {
    try {
      var res = await fetch(API + '/public/leave/list');
      var data = await res.json();
      if (data.success) {
        window._leaves = data.requests || [];
      } else {
        window._leaves = [];
      }
    } catch(e) { window._leaves = []; }
  }

  function mergeAndRender() {
    var docs = window._docs || [];
    var leaves = window._leaves || [];

    // 权限过滤：非管理员只看自己的
    var isAdmin = currentUser && currentUser.role === 'ADMIN';
    var myId = currentUser ? currentUser.id : null;

    if (!isAdmin) {
      docs = docs.filter(function(d) { return d.creator_id == myId; });
      leaves = leaves.filter(function(l) { return (l.user_id || l.userId) == myId; });
    }

    // 标准化为统一格式
    var items = [];

    docs.forEach(function(d) {
      items.push({
        id: 'd' + d.id,
        rawId: d.id,
        type: 'doc',
        title: d.title || '-',
        typeLabel: d.type || '公文',
        detail: (d.content || '').substring(0, 40),
        submitTime: d.created_at,
        status: d.status,
        raw: d
      });
    });

    leaves.forEach(function(l) {
      var userName = l.user_name || l.name || '-';
      items.push({
        id: 'l' + l.id,
        rawId: l.id,
        type: 'leave',
        title: userName + ' 的请假申请',
        typeLabel: '请假 · ' + (l.type || ''),
        detail: l.reason || '-',
        submitTime: l.created_at || l.submitTime,
        status: l.status,
        raw: l
      });
    });

    // 按时间倒序
    items.sort(function(a, b) {
      return new Date(b.submitTime || 0) - new Date(a.submitTime || 0);
    });

    window._allItems = items;

    // 统计
    var total = items.length;
    var pending = items.filter(function(i) { return i.status === 'PENDING'; }).length;
    var approved = items.filter(function(i) { return i.status === 'APPROVED'; }).length;
    var rejected = items.filter(function(i) { return i.status === 'REJECTED'; }).length;

    animNum('statTotal', total);
    animNum('statPending', pending);
    animNum('statApproved', approved);
    animNum('statRejected', rejected);

    renderFiltered();
  }

  window.filterDocs = function(type, btn) {
    currentFilter = type;
    var fts = document.querySelectorAll('.ft');
    fts.forEach(function(b) { b.classList.toggle('active', b === btn); });
    renderFiltered();
  };

  function renderFiltered() {
    var items = window._allItems || [];
    if (currentFilter === 'doc') items = items.filter(function(i) { return i.type === 'doc'; });
    if (currentFilter === 'leave') items = items.filter(function(i) { return i.type === 'leave'; });
    renderTable(items);
  }

  function renderTable(items) {
    var tb = document.getElementById('docTableBody');
    if (!tb) return;

    if (items.length === 0) {
      tb.innerHTML = '<tr><td colspan="6"><div class="em"><div class="em-ico">📭</div><div class="em-txt">暂无数据</div></div></td></tr>';
      return;
    }

    var isAdmin = currentUser && currentUser.role === 'ADMIN';
    var html = '';
    items.forEach(function(item) {
      var typeClass = item.type === 'doc' ? 'typ-doc' : 'typ-leave';
      var statusClass = 'bdge-p';
      if (item.status === 'APPROVED') statusClass = 'bdge-a';
      if (item.status === 'REJECTED') statusClass = 'bdge-r';

      var statusText = item.status;
      if (item.status === 'PENDING') statusText = '待审批';
      else if (item.status === 'APPROVED') statusText = '已通过';
      else if (item.status === 'REJECTED') statusText = '已拒绝';

      var actions = '';
      if (isAdmin && item.status === 'PENDING') {
        if (item.type === 'doc') {
          actions = '<div class="ac"><button class="btn btn-ok" onclick="approveDoc(' + item.rawId + ')">通过</button><button class="btn btn-no" onclick="rejectDoc(' + item.rawId + ')">拒绝</button></div>';
        } else {
          actions = '<div class="ac"><button class="btn btn-ok" onclick="approveLeave(' + item.rawId + ')">通过</button><button class="btn btn-no" onclick="rejectLeave(' + item.rawId + ')">拒绝</button></div>';
        }
      } else if (item.status === 'PENDING') {
        actions = '<span style="color:#f59e0b">· 等待审批</span>';
      } else {
        actions = '-';
      }

      var timeStr = fmtDate(item.submitTime);

      html += '<tr>' +
        '<td><span class="typ-b ' + typeClass + '">' + esc(item.type === 'doc' ? '📄 公文' : '🏖️ 请假') + '</span></td>' +
        '<td><strong>' + esc(item.title) + '</strong><br><span style="font-size:11px;color:var(--tx3)">' + esc(item.typeLabel) + '</span></td>' +
        '<td style="max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + esc(item.detail) + '">' + esc(item.detail || '-') + '</td>' +
        '<td>' + timeStr + '</td>' +
        '<td><span class="bdge ' + statusClass + '"><span class="bd"></span>' + statusText + '</span></td>' +
        '<td>' + actions + '</td>' +
        '</tr>';
    });
    tb.innerHTML = html;
  }

  // ===== 新增弹窗 =====
  window.openAddModal = function() {
    var modal = document.getElementById('addModal');
    if (modal) modal.classList.add('show');
    // 重置
    var typeDoc = document.getElementById('typeDoc');
    var typeLeave = document.getElementById('typeLeave');
    if (typeDoc) typeDoc.classList.remove('selected');
    if (typeLeave) typeLeave.classList.remove('selected');
    var docForm = document.getElementById('docForm');
    var leaveForm = document.getElementById('leaveForm');
    if (docForm) docForm.classList.add('hidden');
    if (leaveForm) leaveForm.classList.add('hidden');
    var btn1 = document.getElementById('submitDocBtn');
    var btn2 = document.getElementById('submitLeaveBtn');
    if (btn1) btn1.classList.add('hidden');
    if (btn2) btn2.classList.add('hidden');

    if (currentUser && currentUser.role !== 'ADMIN') {
      var userSel = document.getElementById('leaveUser');
      if (userSel) userSel.value = currentUser.id;
    }
    var today = new Date().toISOString().split('T')[0];
    var startEl = document.getElementById('leaveStart');
    var endEl = document.getElementById('leaveEnd');
    if (startEl) startEl.value = today;
    if (endEl) endEl.value = today;
  };

  window.closeAddModal = function() {
    var modal = document.getElementById('addModal');
    if (modal) modal.classList.remove('show');
  };

  window.selectType = function(type) {
    var typeDoc = document.getElementById('typeDoc');
    var typeLeave = document.getElementById('typeLeave');
    var docForm = document.getElementById('docForm');
    var leaveForm = document.getElementById('leaveForm');
    var btn1 = document.getElementById('submitDocBtn');
    var btn2 = document.getElementById('submitLeaveBtn');

    if (type === 'doc') {
      if (typeDoc) typeDoc.classList.add('selected');
      if (typeLeave) typeLeave.classList.remove('selected');
      if (docForm) docForm.classList.remove('hidden');
      if (leaveForm) leaveForm.classList.add('hidden');
      if (btn1) btn1.classList.remove('hidden');
      if (btn2) btn2.classList.add('hidden');
    } else {
      if (typeLeave) typeLeave.classList.add('selected');
      if (typeDoc) typeDoc.classList.remove('selected');
      if (leaveForm) leaveForm.classList.remove('hidden');
      if (docForm) docForm.classList.add('hidden');
      if (btn2) btn2.classList.remove('hidden');
      if (btn1) btn1.classList.add('hidden');
    }
  };

  // ===== 提交公文 =====
  window.submitDoc = async function() {
    var title = document.getElementById('docTitle').value.trim();
    var type = document.getElementById('docType').value;
    var priority = document.getElementById('docPriority').value;
    var content = document.getElementById('docContent').value.trim();
    if (!title || !content) { alert('⚠️ 请填写标题和正文'); return; }
    try {
      var res = await fetch(API + '/docs', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title, type: type, priority: priority, content: content })
      });
      var data = await res.json();
      if (data.success) {
        closeAddModal();
        await loadAllData();
      } else {
        alert('提交失败：' + (data.error || '未知错误'));
      }
    } catch(e) { alert('网络错误'); }
  };

  // ===== 提交请假 =====
  window.submitLeave = async function() {
    var userId = document.getElementById('leaveUser').value;
    var type = document.getElementById('leaveType').value;
    var startDate = document.getElementById('leaveStart').value;
    var endDate = document.getElementById('leaveEnd').value;
    var days = parseFloat(document.getElementById('leaveDays').value);
    var reason = document.getElementById('leaveReason').value.trim();
    if (!userId || !startDate || !endDate || !days) { alert('⚠️ 请填写完整信息'); return; }
    try {
      var res = await fetch(API + '/public/leave/submit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: userId, type: type, startDate: startDate, endDate: endDate, days: days, reason: reason })
      });
      var data = await res.json();
      if (data.success) {
        closeAddModal();
        await loadAllData();
      } else {
        alert('提交失败：' + (data.message || '未知错误'));
      }
    } catch(e) { alert('网络错误'); }
  };

  // ===== 审批操作 =====
  window.approveDoc = async function(id) {
    if (!confirm('确认通过此公文？')) return;
    try {
      var res = await fetch(API + '/docs/' + id + '/approve', { method: 'POST' });
      var data = await res.json();
      if (data.success) await loadAllData();
      else alert('操作失败');
    } catch(e) { alert('网络错误'); }
  };

  window.rejectDoc = async function(id) {
    if (!confirm('确认拒绝此公文？')) return;
    try {
      var res = await fetch(API + '/docs/' + id + '/reject', { method: 'POST' });
      var data = await res.json();
      if (data.success) await loadAllData();
      else alert('操作失败');
    } catch(e) { alert('网络错误'); }
  };

  window.approveLeave = async function(id) {
    if (!confirm('确认通过此请假申请？')) return;
    try {
      var res = await fetch(API + '/public/leave/approve/' + id, { method: 'POST' });
      var data = await res.json();
      if (data.success) await loadAllData();
      else alert('操作失败');
    } catch(e) { alert('网络错误'); }
  };

  window.rejectLeave = async function(id) {
    if (!confirm('确认拒绝此请假申请？')) return;
    try {
      var res = await fetch(API + '/public/leave/reject/' + id, { method: 'POST' });
      var data = await res.json();
      if (data.success) await loadAllData();
      else alert('操作失败');
    } catch(e) { alert('网络错误'); }
  };

  // ===== 工具函数 =====
  function animNum(id, target) {
    var el = document.getElementById(id);
    if (!el) return;
    var start = parseInt(el.textContent) || 0;
    var duration = 600;
    var t0 = performance.now();
    function tick(t) {
      var p = Math.min((t - t0) / duration, 1);
      var eased = 1 - Math.pow(1 - p, 3);
      el.textContent = Math.round(start + (target - start) * eased);
      if (p < 1) requestAnimationFrame(tick);
    }
    requestAnimationFrame(tick);
  }

  function fmtDate(s) {
    if (!s) return '-';
    var d = new Date(s);
    var y = d.getFullYear();
    var m = String(d.getMonth() + 1).padStart(2, '0');
    var day = String(d.getDate()).padStart(2, '0');
    return y + '-' + m + '-' + day;
  }

  function esc(s) {
    if (typeof s !== 'string') s = String(s || '');
    var d = document.createElement('div');
    d.textContent = s;
    return d.innerHTML;
  }

})();
