// ===== DocFlow 前端工具库 =====
// 统一错误处理 + Loading + 自定义角色管理

// Loading 状态管理
var loadingCount = 0;

function showLoading() {
  loadingCount++;
  var el = document.getElementById('loadingOverlay');
  if (!el) {
    el = document.createElement('div');
    el.id = 'loadingOverlay';
    el.className = 'loading-overlay show';
    el.innerHTML = '<div class="loading-spinner"></div>';
    document.body.appendChild(el);
  } else {
    el.classList.add('show');
  }
}

function hideLoading() {
  loadingCount = Math.max(0, loadingCount - 1);
  if (loadingCount === 0) {
    var el = document.getElementById('loadingOverlay');
    if (el) el.classList.remove('show');
  }
}

// 统一 API 请求
async function api(url, options) {
  showLoading();
  try {
    var opts = options || {};
    if (!opts.headers) opts.headers = {};
    if (!opts.headers['Authorization'] && window.token) {
      opts.headers['Authorization'] = 'Bearer ' + window.token;
    }
    if (!opts.headers['Content-Type'] && opts.body) {
      opts.headers['Content-Type'] = 'application/json';
    }
    var res = await fetch((window.API || '') + url, opts);
    if (res.status === 401 || res.status === 403) {
      toast('\u767b\u5f55\u5df2\u8fc7\u671f\uff0c\u8bf7\u91cd\u65b0\u767b\u5f55', 'error');
      setTimeout(function() {
        localStorage.removeItem('token');
        window.location.href = '/';
      }, 1500);
      return null;
    }
    return await res.json();
  } catch (e) {
    toast('\u7f51\u7edc\u9519\u8bef: ' + e.message, 'error');
    return null;
  } finally {
    hideLoading();
  }
}

// Toast 通知
function toast(msg, type) {
  type = type || 'info';
  var el = document.createElement('div');
  el.className = 'toast-notice ' + type;
  el.textContent = msg;
  document.body.appendChild(el);
  setTimeout(function() {
    el.style.opacity = '0';
    el.style.transition = 'opacity .3s';
    setTimeout(function() { el.remove(); }, 300);
  }, 3000);
}

// 自定义角色管理
function editCustomRole(id, currentRole, name) {
  var modal = document.getElementById('customRoleModal');
  if (!modal) return;
  document.getElementById('customRoleUserId').value = id;
  document.getElementById('customRoleInput').value = currentRole || '';
  document.getElementById('customRoleName').textContent = name;
  modal.style.display = 'flex';
}

function closeCustomRoleModal() {
  var modal = document.getElementById('customRoleModal');
  if (modal) modal.style.display = 'none';
}

async function saveCustomRole() {
  var id = parseInt(document.getElementById('customRoleUserId').value);
  var roleName = document.getElementById('customRoleInput').value.trim();
  if (!id) return;
  try {
    var res = await fetch((window.API || '') + '/api/users/' + id, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + window.token },
      body: JSON.stringify({ custom_role: roleName })
    });
    var result = await res.json();
    if (result.success) {
      toast('\u5df2\u66f4\u65b0\u89d2\u8272\u79f0\u547c', 'success');
      closeCustomRoleModal();
      if (typeof loadUsers === 'function') loadUsers();
    } else {
      toast(result.message || '\u5931\u8d25', 'error');
    }
  } catch(e) {
    toast('\u7f51\u7edc\u9519\u8bef', 'error');
  }
}

// 自动初始化
(function() {
  // Override window.showToast if it exists
  if (typeof window.showToast !== 'function') {
    window.showToast = toast;
  }
})();
