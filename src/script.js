(function() {
  'use strict';

  const state = {
    nodes: new Map(),
    viewMode: localStorage.getItem('nodeViewMode') || 'grid',
    settings: {},
    pollTimer: null,
    pollInterval: 3000,
    isInitialRender: true,
    activeNodeUuid: null,
    modalTimeScale: 1, // ping hours (latency)
    modalLoadTimeScale: 1, // load hours
    charts: {},
    loadRequestId: 0,
    latencyRequestId: 0,
    modalCloseId: 0,
    publicSettings: {},
    isLoggedIn: false,
    authForced: false,
    authNeedsOtp: false
  };

  const elements = {
    container: document.getElementById('nodes-container'),
    statNodes: document.getElementById('stat-nodes'),
    statOnline: document.getElementById('stat-online'),
    statCpu: document.getElementById('stat-cpu'),
    statRam: document.getElementById('stat-ram'),
    statNetIn: document.getElementById('stat-net-in'),
    statNetOut: document.getElementById('stat-net-out'),
    modal: document.getElementById('node-modal'),
    modalContent: document.getElementById('modal-content'),
    modalClose: document.getElementById('modal-close'),
    adminButton: document.querySelector('.btn-admin'),
    authModal: document.getElementById('auth-modal'),
    authClose: document.getElementById('auth-close'),
    authForm: document.getElementById('auth-form'),
    authCredentials: document.getElementById('auth-credentials'),
    authUsername: document.getElementById('auth-username'),
    authPassword: document.getElementById('auth-password'),
    authOtp: document.getElementById('auth-otp'),
    authOtpCode: document.getElementById('auth-otp-code'),
    authBack: document.getElementById('auth-back'),
    authMessage: document.getElementById('auth-message'),
    authSubmit: document.getElementById('auth-submit'),
    authOauth: document.getElementById('auth-oauth')
  };

  let requestId = 0;

  const PING_COLORS = ['#FF3333', '#00A896', '#9B5DE5', '#0066FF', '#F59E0B', '#EC4899', '#10B981', '#F97316'];

  // Helper: only scramble changed characters
  function scrambleTextIfChanged(element, finalText) {
    const prevText = element.dataset.prev || '';
    if (prevText === finalText) return;
    element.dataset.prev = finalText;
    scrambleText(element, finalText, prevText);
  }

  // Characters for scramble animation (monospace)
  const scrambleChars = '!@#$%^&*0123456789ABCDEF';

  function scrambleText(element, finalText, previousText = '', duration = 400) {
    const startTime = Date.now();
    // Pad previous text to same length from the start (align right)
    const prevPadded = previousText.padStart(finalText.length, ' ');

    function animate() {
      const elapsed = Date.now() - startTime;
      const progress = Math.min(elapsed / duration, 1);

      let result = '';
      for (let i = 0; i < finalText.length; i++) {
        // Reverse progress: right-to-left
        const charProgress = (finalText.length - 1 - i) / finalText.length;
        const isChanged = prevPadded[i] !== finalText[i];

        if (!isChanged) {
          result += finalText[i];
        } else if (charProgress < progress) {
          result += finalText[i];
        } else {
          if (scrambleChars.includes(finalText[i]) || finalText[i] === ' ') {
            result += scrambleChars[Math.floor(Math.random() * scrambleChars.length)];
          } else {
            result += finalText[i];
          }
        }
      }

      element.textContent = result;

      if (progress < 1) {
        requestAnimationFrame(animate);
      }
    }

    animate();
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
  }

  function formatUptime(seconds) {
    if (!seconds || seconds <= 0) return '-';
    const days = Math.floor(seconds / 86400);
    const hours = Math.floor((seconds % 86400) / 3600);
    const mins = Math.floor((seconds % 3600) / 60);
    if (days > 0) return `${days}d ${hours}h`;
    if (hours > 0) return `${hours}h ${mins}m`;
    return `${mins}m`;
  }

  function formatPing(ms) {
    if (ms == null || ms < 0) return '-';
    return ms.toFixed(1) + ' ms';
  }

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getPingClass(ms) {
    if (ms == null) return '';
    if (ms < 100) return 'good';
    if (ms < 300) return 'medium';
    return 'bad';
  }

  function formatNetworkSpeed(bytesPerSec) {
    if (bytesPerSec == null) return '-';
    return formatBytes(bytesPerSec) + '/s';
  }

  function parseRecordTime(value) {
    if (value == null || value === '') return null;

    if (typeof value === 'number' || /^\d+(?:\.\d+)?$/.test(String(value))) {
      const numericValue = Number(value);
      if (!Number.isFinite(numericValue)) return null;
      return numericValue < 1e12 ? numericValue * 1000 : numericValue;
    }

    const normalizedValue = String(value).includes('T')
      ? String(value)
      : String(value).replace(' ', 'T');
    const timestamp = Date.parse(normalizedValue);
    return Number.isFinite(timestamp) ? timestamp : null;
  }

  function getPercentage(used, total) {
    if (!total || total === 0) return 0;
    return Math.round((used / total) * 100);
  }

  function getMetricClass(percentage) {
    if (percentage >= 80) return 'high';
    if (percentage >= 50) return 'medium';
    return 'low';
  }

  function getTrafficLimitLabel(type) {
    const labels = { max: '(max)', sum: '(sum)', min: '(min)', down: '(down)', up: '(up)' };
    return labels[type] || '(max)';
  }

  function getNetBarWidths(node) {
    const limit = node.traffic_limit || 0;
    const type = node.traffic_limit_type || 'max';
    const up = node.net_total_up || 0;
    const down = node.net_total_down || 0;

    if (limit <= 0) {
      return { upPct: 0, downPct: 0, upLeft: 0, downLeft: 0, upDim: false, downDim: false, upHide: false, downHide: false, upZIndex: 1, downZIndex: 2 };
    }

    let upPct = (up / limit * 100);
    let downPct = (down / limit * 100);
    let upDim = false;
    let downDim = false;
    let upHide = false;
    let downHide = false;
    let upLeft = 0;
    let downLeft = 0;
    let upZIndex = 1;
    let downZIndex = 2;

    switch (type) {
      case 'sum':
        // 拼接：in 从 0 开始，out 从 in 末尾开始
        upLeft = 0;
        downLeft = upPct;
        upZIndex = 1;
        downZIndex = 1;
        upDim = false;
        downDim = false;
        break;
      case 'max':
        // 较大的 opaque 在下层，较小的 dimmed 在上层
        if (upPct >= downPct) {
          upDim = false; downDim = true;
          upZIndex = 1; downZIndex = 2;
        } else {
          upDim = true; downDim = false;
          upZIndex = 2; downZIndex = 1;
        }
        break;
      case 'min':
        // 较小的 opaque 在下层，较大的 dimmed 在上层
        if (upPct >= downPct) {
          upDim = true; downDim = false;
          upZIndex = 2; downZIndex = 1;
        } else {
          upDim = false; downDim = true;
          upZIndex = 1; downZIndex = 2;
        }
        break;
      case 'up':
        upDim = false; downDim = true;
        upZIndex = 1; downZIndex = 2;
        break;
      case 'down':
        upDim = true; downDim = false;
        upZIndex = 2; downZIndex = 1;
        break;
      default:
        upDim = false;
        downDim = false;
    }

    return {
      upPct: Math.min(upPct, 100),
      downPct: Math.min(downPct, 100),
      upLeft, downLeft,
      upDim,
      downDim,
      upHide,
      downHide,
      upZIndex,
      downZIndex
    };
  }

  function getNetTotalByType(node) {
    const type = node.traffic_limit_type || 'max';
    const up = node.net_total_up || 0;
    const down = node.net_total_down || 0;

    switch (type) {
      case 'sum':
        return up + down;
      case 'max':
        return Math.max(up, down);
      case 'min':
        return Math.min(up, down);
      case 'down':
        return down;
      case 'up':
        return up;
      default:
        return up + down;
    }
  }

  function applySettings() {
    const accentColor = state.settings.accentColor || 'yellow';
    const cardStyle = state.settings.cardStyle || 'thick';
    const showUptime = state.settings.showUptime !== false;

    document.documentElement.style.setProperty('--accent', `var(--accent-${accentColor})`);

    document.body.classList.remove('card-style-thin', 'card-style-double');
    if (cardStyle === 'thin') {
      document.body.classList.add('card-style-thin');
    } else if (cardStyle === 'double') {
      document.body.classList.add('card-style-double');
    }

    document.querySelectorAll('.node-footer').forEach(el => {
      el.style.display = showUptime ? '' : 'none';
    });
  }

  async function rpcCall(method, params) {
    const id = ++requestId;
    const request = {
      jsonrpc: '2.0',
      method: method,
      params: params || {},
      id: id
    };

    const res = await fetch('/api/rpc2', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(request)
    });

    if (!res.ok) {
      throw new Error(`RPC error: ${res.status}`);
    }

    const response = await res.json();
    if (response.error) {
      throw new Error(`RPC error: ${response.error.message}`);
    }
    return response.result;
  }

  async function fetchPublicSettings() {
    try {
      const res = await fetch('/api/public');
      if (res.ok) {
        const response = await res.json();
        const publicSettings = response?.data && typeof response.data === 'object'
          ? response.data
          : response;
        state.publicSettings = publicSettings || {};
        const siteName = typeof publicSettings?.sitename === 'string' && publicSettings.sitename.trim()
          ? publicSettings.sitename.trim()
          : 'Komari Monitor';
        const siteNameElement = document.getElementById('site-name');
        if (siteNameElement) siteNameElement.textContent = siteName;
        document.title = siteName;

        if (publicSettings?.theme_settings) {
          state.settings = publicSettings.theme_settings;
          applySettings();
        }
      }
    } catch (e) {
      console.warn('[Komari Theme] Could not fetch theme settings:', e);
    }
  }

  async function fetchAuthState() {
    try {
      const me = await rpcCall('public:getMe', {});
      state.isLoggedIn = me?.logged_in === true;
    } catch (error) {
      state.isLoggedIn = false;
      console.warn('[Komari Theme] Could not determine login state:', error);
    }
    updateAuthButton();
    return state.isLoggedIn;
  }

  function updateAuthButton() {
    if (!elements.adminButton) return;
    const label = elements.adminButton.querySelector('span');
    if (state.isLoggedIn) {
      elements.adminButton.hidden = false;
      elements.adminButton.href = '/admin';
      elements.adminButton.title = 'Admin Panel';
      if (label) label.textContent = 'Admin';
      return;
    }

    const showLogin = state.publicSettings?.private_site || state.settings.showLoginButton !== false;
    elements.adminButton.hidden = !showLogin;
    elements.adminButton.href = '#login';
    elements.adminButton.title = 'Login';
    if (label) label.textContent = 'Login';
  }

  function setAuthStep(needsOtp) {
    state.authNeedsOtp = needsOtp;
    elements.authCredentials.hidden = needsOtp;
    elements.authOtp.hidden = !needsOtp;
    elements.authSubmit.textContent = needsOtp ? 'VERIFY' : 'LOGIN';
    elements.authMessage.textContent = '';
    if (needsOtp) {
      elements.authOtpCode.value = '';
      elements.authOtpCode.focus();
    }
  }

  function openAuthModal(forced = false) {
    state.authForced = forced;
    setAuthStep(false);
    elements.authClose.hidden = forced;
    elements.authOauth.hidden = !state.publicSettings?.oauth_enable;
    elements.authModal.classList.add('active');
    elements.authModal.setAttribute('aria-hidden', 'false');
    document.body.style.overflow = 'hidden';
    requestAnimationFrame(() => elements.authUsername.focus());
  }

  function closeAuthModal() {
    if (state.authForced) return;
    elements.authModal.classList.remove('active');
    elements.authModal.setAttribute('aria-hidden', 'true');
    elements.authForm.reset();
    elements.authMessage.textContent = '';
    document.body.style.overflow = '';
  }

  async function submitLogin(event) {
    event.preventDefault();
    const username = elements.authUsername.value.trim();
    const password = elements.authPassword.value;
    const otp = elements.authOtpCode.value.trim();
    if (!username || !password || (state.authNeedsOtp && !/^\d{6}$/.test(otp))) {
      elements.authMessage.textContent = state.authNeedsOtp ? 'ENTER A VALID 6-DIGIT CODE.' : 'USERNAME AND PASSWORD ARE REQUIRED.';
      return;
    }

    elements.authSubmit.disabled = true;
    elements.authSubmit.textContent = state.authNeedsOtp ? 'VERIFYING...' : 'AUTHENTICATING...';
    elements.authMessage.textContent = '';
    const body = { username, password };
    if (state.authNeedsOtp) body['2fa_code'] = otp;

    try {
      const response = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify(body)
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok || result?.status === 'error') {
        const message = String(result?.message || `Login failed (${response.status})`);
        if (!state.authNeedsOtp && /2fa|two.?factor/i.test(message)) {
          setAuthStep(true);
          return;
        }
        throw new Error(message);
      }

      await fetchAuthState();
      if (!state.isLoggedIn) throw new Error('The server did not create a login session.');
      state.authForced = false;
      elements.authModal.classList.remove('active');
      elements.authModal.setAttribute('aria-hidden', 'true');
      document.body.style.overflow = '';
      await fetchNodesAndStatus();
      startPolling();
    } catch (error) {
      elements.authMessage.textContent = state.authNeedsOtp
        ? 'INVALID VERIFICATION CODE. TRY AGAIN.'
        : 'LOGIN FAILED. CHECK YOUR CREDENTIALS.';
      console.error('[Komari Theme] Login failed:', error);
    } finally {
      elements.authSubmit.disabled = false;
      elements.authSubmit.textContent = state.authNeedsOtp ? 'VERIFY' : 'LOGIN';
    }
  }

  async function fetchNodesAndStatus() {
    try {
      const [clients, statuses] = await Promise.all([
        rpcCall('common:getNodes', {}),
        rpcCall('common:getNodesLatestStatus', {})
      ]);

      if (clients && typeof clients === 'object') {
        Object.keys(clients).forEach(uuid => {
          const client = clients[uuid];
          const status = statuses && statuses[uuid];

          state.nodes.set(uuid, {
            uuid: uuid,
            name: client.name || 'Unknown',
            os: client.os || '',
            cpu_name: client.cpu_name || '',
            cpu_cores: client.cpu_cores || 0,
            arch: client.arch || '',
            mem_total: client.mem_total || 0,
            disk_total: client.disk_total || 0,
            swap_total: client.swap_total || 0,
            region: client.region || '',
            group: client.group || '',
            tags: client.tags || '',
            hidden: client.hidden || false,
            weight: client.weight || 0,
            traffic_limit: client.traffic_limit || 0,
            traffic_limit_type: client.traffic_limit_type || 'max',
            virtualization: client.virtualization || '',
            kernel_version: client.kernel_version || '',
            gpu_name: client.gpu_name || '',
            online: status ? status.online : false,
            cpu: status ? (status.cpu || 0) : 0,
            ram: status ? (status.ram || 0) : 0,
            ram_total: status ? (status.ram_total || client.mem_total || 0) : (client.mem_total || 0),
            disk: status ? (status.disk || 0) : 0,
            disk_total: status ? (status.disk_total || client.disk_total || 0) : (client.disk_total || 0),
            swap: status ? (status.swap || 0) : 0,
            swap_total: status ? (status.swap_total || client.swap_total || 0) : (client.swap_total || 0),
            load: status ? (status.load || 0) : 0,
            load5: status ? (status.load5 || 0) : 0,
            load15: status ? (status.load15 || 0) : 0,
            net_in: status ? (status.net_in || 0) : 0,
            net_out: status ? (status.net_out || 0) : 0,
            net_total_up: status ? (status.net_total_up || 0) : 0,
            net_total_down: status ? (status.net_total_down || 0) : 0,
            uptime: status ? (status.uptime || 0) : 0,
            process: status ? (status.process || 0) : 0,
            connections: status ? (status.connections || 0) : 0,
            connections_udp: status ? (status.connections_udp || 0) : 0,
            temp: status ? (status.temp || 0) : 0,
            gpu: status ? (status.gpu || 0) : 0,
            last_report: status ? (status.time || '') : '',
            time: status ? (status.time || '') : '',
          });
        });
      }

      const clientUuids = new Set(Object.keys(clients || {}));
      state.nodes.forEach((_, uuid) => {
        if (!clientUuids.has(uuid)) {
          state.nodes.delete(uuid);
        }
      });

      if (state.isInitialRender) {
        render();
        state.isInitialRender = false;
      } else {
        updateAllCards();
      }
      updateStats();

      if (state.activeNodeUuid) {
        updateModalLiveInfo();
      }
    } catch (e) {
      console.error('[Komari Theme] Error fetching data:', e);
      renderError();
    }
  }

  function createNodeCard(node) {
    const cpu = node.cpu || 0;
    const ramPct = node.ram_total ? getPercentage(node.ram, node.ram_total) : 0;
    const diskPct = node.disk_total ? getPercentage(node.disk, node.disk_total) : 0;
    const isOnline = node.online !== false && node.name !== undefined;

    const cpuText = `${cpu.toFixed(1)}%`;
    const ramText = `${formatBytes(node.ram || 0)} / ${formatBytes(node.ram_total || 0)}`;
    const diskText = `${formatBytes(node.disk || 0)} / ${formatBytes(node.disk_total || 0)}`;
    const netTotal = node.traffic_limit > 0 ? getNetTotalByType(node) : (node.net_total_up || 0) + (node.net_total_down || 0);
    const netTotalText = formatBytes(netTotal) + (node.traffic_limit ? ' / ' + formatBytes(node.traffic_limit) : '');
    const netTypeLabel = getTrafficLimitLabel(node.traffic_limit_type || 'max');
    const { upPct, downPct, upDim, downDim, upHide, downHide, upLeft, downLeft, upZIndex, downZIndex } = getNetBarWidths(node);
    
    // speed logic
    const downSpeedText = isOnline ? `↓ ${formatNetworkSpeed(node.net_in || 0)}` : '↓ -';
    const upSpeedText = isOnline ? `↑ ${formatNetworkSpeed(node.net_out || 0)}` : '↑ -';
    
    const uptimeText = isOnline ? formatUptime(node.uptime) : '-';
    const upTotalText = `↑ ${formatBytes(node.net_total_up || 0)}`;
    const downTotalText = `↓ ${formatBytes(node.net_total_down || 0)}`;

    const card = document.createElement('div');
    card.className = `node-card${isOnline ? '' : ' offline'}`;
    card.dataset.uuid = node.uuid;
    card.style.cursor = 'pointer';

    card.innerHTML = `
      <div class="node-header">
        <div>
          <div class="node-name">${node.name || 'Unknown'}</div>
          <div class="node-info">${node.os || ''} · ${node.cpu_name || ''}</div>
        </div>
        <div class="node-status${isOnline ? '' : ' offline'}"></div>
      </div>
      <div class="metrics">
        <div class="metric">
          <div class="metric-header">
            <span>CPU</span>
            <span class="metric-value" data-prev="${cpuText}">${cpuText}</span>
          </div>
          <div class="metric-bar">
            <div class="metric-fill ${getMetricClass(cpu)}" style="width: ${Math.min(cpu, 100)}%"></div>
          </div>
        </div>
        <div class="metric">
          <div class="metric-header">
            <span>RAM</span>
            <span class="metric-value" data-prev="${ramText}">${ramText}</span>
          </div>
          <div class="metric-bar">
            <div class="metric-fill ${getMetricClass(ramPct)}" style="width: ${ramPct}%"></div>
          </div>
        </div>
        <div class="metric">
          <div class="metric-header">
            <span>DISK</span>
            <span class="metric-value" data-prev="${diskText}">${diskText}</span>
          </div>
          <div class="metric-bar">
            <div class="metric-fill ${getMetricClass(diskPct)}" style="width: ${diskPct}%"></div>
          </div>
        </div>
        <div class="metric">
          <div class="metric-header">
            <span>NETWORK${node.traffic_limit > 0 ? ' ' + netTypeLabel : ''}</span>
            <span class="metric-value" data-prev="${netTotalText}">${netTotalText}</span>
          </div>
          <div class="metric-bar net-bar${node.traffic_limit > 0 ? '' : ' unlimited'}">
            ${(node.traffic_limit > 0) ? `
            <div class="metric-fill net-in${upDim ? ' dimmed' : ''}${upHide ? ' hidden' : ''}" style="width: ${upPct.toFixed(1)}%; left: ${upLeft.toFixed(1)}%; z-index: ${upZIndex}"></div>
            <div class="metric-fill net-out${downDim ? ' dimmed' : ''}${downHide ? ' hidden' : ''}" style="width: ${downPct.toFixed(1)}%; left: ${downLeft.toFixed(1)}%; z-index: ${downZIndex}"></div>
            ` : `
            <div class="metric-fill net-in" style="width: 0%"></div>
            <div class="metric-fill net-out" style="width: 0%"></div>
            `}
          </div>
          <div class="net-totals">
            <span class="net-total-item" data-prev="${upTotalText}">${upTotalText}</span>
            <span class="net-total-item" data-prev="${downTotalText}">${downTotalText}</span>
          </div>
        </div>
      </div>
      <div class="node-footer">
        <div class="footer-stat">
          <span data-prev="${upSpeedText}">${upSpeedText}</span>
          UP SPEED
        </div>
        <div class="footer-stat">
          <span data-prev="${downSpeedText}">${downSpeedText}</span>
          DOWN SPEED
        </div>
        <div class="footer-stat">
          <span data-prev="${uptimeText}">${uptimeText}</span>
          UPTIME
        </div>
      </div>
    `;

    card.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      openNodeModal(node.uuid);
    });

    return card;
  }

  function updateNodeCard(node) {
    const existingCard = document.querySelector(`[data-uuid="${node.uuid}"]`);
    if (!existingCard) return;

    const cpu = node.cpu || 0;
    const ramPct = node.ram_total ? getPercentage(node.ram, node.ram_total) : 0;
    const diskPct = node.disk_total ? getPercentage(node.disk, node.disk_total) : 0;
    const isOnline = node.online !== false && node.name !== undefined;

    existingCard.className = `node-card${isOnline ? '' : ' offline'}`;

    // Update CPU
    const cpuValue = existingCard.querySelector('.metric:nth-child(1) .metric-value');
    const cpuFill = existingCard.querySelector('.metric:nth-child(1) .metric-fill');
    const newCpuText = `${cpu.toFixed(1)}%`;
    if (cpuValue) scrambleTextIfChanged(cpuValue, newCpuText);
    if (cpuFill) {
      const newWidth = `${Math.min(cpu, 100)}%`;
      if (cpuFill.style.width !== newWidth) {
        cpuFill.style.width = newWidth;
        cpuFill.classList.remove('high', 'medium', 'low');
        cpuFill.classList.add(getMetricClass(cpu));
      }
    }

    // Update RAM
    const ramValue = existingCard.querySelector('.metric:nth-child(2) .metric-value');
    const ramFill = existingCard.querySelector('.metric:nth-child(2) .metric-fill');
    const newRamText = `${formatBytes(node.ram || 0)} / ${formatBytes(node.ram_total || 0)}`;
    if (ramValue) scrambleTextIfChanged(ramValue, newRamText);
    if (ramFill) {
      const newWidth = `${ramPct}%`;
      if (ramFill.style.width !== newWidth) {
        ramFill.style.width = newWidth;
        ramFill.classList.remove('high', 'medium', 'low');
        ramFill.classList.add(getMetricClass(ramPct));
      }
    }

    // Update Disk
    const diskValue = existingCard.querySelector('.metric:nth-child(3) .metric-value');
    const diskFill = existingCard.querySelector('.metric:nth-child(3) .metric-fill');
    const newDiskText = `${formatBytes(node.disk || 0)} / ${formatBytes(node.disk_total || 0)}`;
    if (diskValue) scrambleTextIfChanged(diskValue, newDiskText);
    if (diskFill) {
      const newWidth = `${diskPct}%`;
      if (diskFill.style.width !== newWidth) {
        diskFill.style.width = newWidth;
        diskFill.classList.remove('high', 'medium', 'low');
        diskFill.classList.add(getMetricClass(diskPct));
      }
    }

    // Update Network total
    const netTotalValue = existingCard.querySelector('.metric:nth-child(4) .metric-value');
    const netTotal = node.traffic_limit > 0 ? getNetTotalByType(node) : (node.net_total_up || 0) + (node.net_total_down || 0);
    const newNetTotalText = formatBytes(netTotal) + (node.traffic_limit ? ' / ' + formatBytes(node.traffic_limit) : '');
    if (netTotalValue) scrambleTextIfChanged(netTotalValue, newNetTotalText);

    // Update network bar
    const netBar = existingCard.querySelector('.metric:nth-child(4) .net-bar');
    if (netBar) {
      const netIn = existingCard.querySelector('.net-in');
      const netOut = existingCard.querySelector('.net-out');
      const { upPct, downPct, upDim, downDim, upHide, downHide, upLeft, downLeft, upZIndex, downZIndex } = getNetBarWidths(node);
      if (node.traffic_limit > 0) {
        netBar.classList.remove('unlimited');
        if (netIn) {
          netIn.style.width = `${upPct.toFixed(1)}%`;
          netIn.style.left = `${upLeft.toFixed(1)}%`;
          netIn.style.zIndex = upZIndex;
          netIn.classList.toggle('dimmed', upDim);
          netIn.classList.toggle('hidden', upHide);
        }
        if (netOut) {
          netOut.style.width = `${downPct.toFixed(1)}%`;
          netOut.style.left = `${downLeft.toFixed(1)}%`;
          netOut.style.zIndex = downZIndex;
          netOut.classList.toggle('dimmed', downDim);
          netOut.classList.toggle('hidden', downHide);
        }
      } else {
        netBar.classList.add('unlimited');
        if (netIn) netIn.style.width = '0%';
        if (netOut) netOut.style.width = '0%';
      }
    }

    const netTotals = existingCard.querySelectorAll('.net-total-item');
    if (netTotals.length === 2) {
      scrambleTextIfChanged(netTotals[0], `↑ ${formatBytes(node.net_total_up || 0)}`);
      scrambleTextIfChanged(netTotals[1], `↓ ${formatBytes(node.net_total_down || 0)}`);
    }

    const netUp = existingCard.querySelector('.footer-stat:nth-child(1) span');
    const netDown = existingCard.querySelector('.footer-stat:nth-child(2) span');
    const uptime = existingCard.querySelector('.footer-stat:nth-child(3) span');
    
    const newDownSpeedText = isOnline ? `↓ ${formatNetworkSpeed(node.net_in || 0)}` : '↓ -';
    const newUpSpeedText = isOnline ? `↑ ${formatNetworkSpeed(node.net_out || 0)}` : '↑ -';
    const newUptimeText = isOnline ? formatUptime(node.uptime) : '-';

    if (netUp) scrambleTextIfChanged(netUp, newUpSpeedText);
    if (netDown) scrambleTextIfChanged(netDown, newDownSpeedText);
    if (uptime) scrambleTextIfChanged(uptime, newUptimeText);
  }

  function createNodeListItem(node) {
    const cpu = node.cpu || 0;
    const ramPct = node.ram_total ? getPercentage(node.ram, node.ram_total) : 0;
    const diskPct = node.disk_total ? getPercentage(node.disk, node.disk_total) : 0;
    const isOnline = node.online !== false && node.name !== undefined;

    const cpuText = `${cpu.toFixed(1)}%`;
    const ramText = `${formatBytes(node.ram || 0)} / ${formatBytes(node.ram_total || 0)}`;
    const diskText = `${formatBytes(node.disk || 0)} / ${formatBytes(node.disk_total || 0)}`;
    const netTotal = node.traffic_limit > 0 ? getNetTotalByType(node) : (node.net_total_up || 0) + (node.net_total_down || 0);
    const netTotalText = formatBytes(netTotal) + (node.traffic_limit ? ' / ' + formatBytes(node.traffic_limit) : '');
    const { upPct, downPct, upDim, downDim, upHide, downHide, upLeft, downLeft, upZIndex, downZIndex } = getNetBarWidths(node);

    const downSpeedText = isOnline ? `${formatNetworkSpeed(node.net_in || 0)}` : '-';
    const upSpeedText = isOnline ? `${formatNetworkSpeed(node.net_out || 0)}` : '-';
    const uptimeText = isOnline ? formatUptime(node.uptime) : '-';

    const row = document.createElement('div');
    row.className = `node-row${isOnline ? '' : ' offline'}`;
    row.dataset.uuid = node.uuid;
    row.style.cursor = 'pointer';

    row.innerHTML = `
      <div class="row-head">
        <div class="row-status${isOnline ? '' : ' offline'}"></div>
        <div class="row-name">
          <div class="row-node-name">${escapeHtml(node.name || 'Unknown')}</div>
          <div class="row-node-info">${escapeHtml(node.os || '')}${node.cpu_name ? ' · ' + escapeHtml(node.cpu_name) : ''}</div>
        </div>
        <div class="row-uptime">
          <span class="row-uptime-label">UPTIME</span>
          <span class="row-uptime-value" data-prev="${uptimeText}">${uptimeText}</span>
        </div>
      </div>
      <div class="row-metrics">
        <div class="row-metric row-cpu">
          <div class="row-metric-header">
            <span class="row-metric-label">CPU</span>
            <span class="row-metric-value" data-prev="${cpuText}">${cpuText}</span>
          </div>
          <div class="row-metric-bar"><div class="row-fill ${getMetricClass(cpu)}" style="width: ${Math.min(cpu, 100)}%"></div></div>
        </div>
        <div class="row-metric row-ram">
          <div class="row-metric-header">
            <span class="row-metric-label">RAM</span>
            <span class="row-metric-value" data-prev="${ramText}">${ramText}</span>
          </div>
          <div class="row-metric-bar"><div class="row-fill ${getMetricClass(ramPct)}" style="width: ${ramPct}%"></div></div>
        </div>
        <div class="row-metric row-disk">
          <div class="row-metric-header">
            <span class="row-metric-label">DISK</span>
            <span class="row-metric-value" data-prev="${diskText}">${diskText}</span>
          </div>
          <div class="row-metric-bar"><div class="row-fill ${getMetricClass(diskPct)}" style="width: ${diskPct}%"></div></div>
        </div>
        <div class="row-metric row-net">
          <div class="row-metric-header">
            <span class="row-metric-label">NET${node.traffic_limit > 0 ? ' ' + escapeHtml(getTrafficLimitLabel(node.traffic_limit_type || 'max')) : ''}</span>
            <span class="row-metric-value" data-prev="${netTotalText}">${netTotalText}</span>
          </div>
          <div class="row-metric-bar net-bar${node.traffic_limit > 0 ? '' : ' unlimited'}">
            ${(node.traffic_limit > 0) ? `
            <div class="row-fill net-in${upDim ? ' dimmed' : ''}${upHide ? ' hidden' : ''}" style="width: ${upPct.toFixed(1)}%; left: ${upLeft.toFixed(1)}%; z-index: ${upZIndex}"></div>
            <div class="row-fill net-out${downDim ? ' dimmed' : ''}${downHide ? ' hidden' : ''}" style="width: ${downPct.toFixed(1)}%; left: ${downLeft.toFixed(1)}%; z-index: ${downZIndex}"></div>
            ` : `
            <div class="row-fill net-in" style="width: 0%"></div>
            <div class="row-fill net-out" style="width: 0%"></div>
            `}
          </div>
        </div>
      </div>
      <div class="row-speeds">
        <div class="row-speed row-up">
          <span class="row-speed-label"><span class="row-arrow">↑</span></span>
          <span class="row-speed-value" data-prev="${upSpeedText}">${upSpeedText}</span>
        </div>
        <div class="row-speed row-down">
          <span class="row-speed-label"><span class="row-arrow">↓</span></span>
          <span class="row-speed-value" data-prev="${downSpeedText}">${downSpeedText}</span>
        </div>
      </div>
    `;

    row.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') return;
      openNodeModal(node.uuid);
    });

    return row;
  }

  function updateNodeListItem(row, node) {
    const cpu = node.cpu || 0;
    const ramPct = node.ram_total ? getPercentage(node.ram, node.ram_total) : 0;
    const diskPct = node.disk_total ? getPercentage(node.disk, node.disk_total) : 0;
    const isOnline = node.online !== false && node.name !== undefined;

    row.className = `node-row${isOnline ? '' : ' offline'}`;

    const updateMetric = (key, value, pct, fillClass) => {
      const valueEl = row.querySelector(`.row-${key} .row-metric-value`);
      const fillEl = row.querySelector(`.row-${key} .row-fill`);
      if (valueEl) scrambleTextIfChanged(valueEl, value);
      if (fillEl) {
        const newWidth = `${key === 'cpu' ? Math.min(pct, 100) : pct}%`;
        if (fillEl.style.width !== newWidth) {
          fillEl.style.width = newWidth;
          fillEl.classList.remove('high', 'medium', 'low');
          fillEl.classList.add(fillClass);
        }
      }
    };

    updateMetric('cpu', `${cpu.toFixed(1)}%`, cpu, getMetricClass(cpu));
    updateMetric('ram', `${formatBytes(node.ram || 0)} / ${formatBytes(node.ram_total || 0)}`, ramPct, getMetricClass(ramPct));
    updateMetric('disk', `${formatBytes(node.disk || 0)} / ${formatBytes(node.disk_total || 0)}`, diskPct, getMetricClass(diskPct));

    const netTotal = node.traffic_limit > 0 ? getNetTotalByType(node) : (node.net_total_up || 0) + (node.net_total_down || 0);
    const netTotalText = formatBytes(netTotal) + (node.traffic_limit ? ' / ' + formatBytes(node.traffic_limit) : '');
    const netValueEl = row.querySelector('.row-net .row-metric-value');
    if (netValueEl) scrambleTextIfChanged(netValueEl, netTotalText);

    const netBar = row.querySelector('.row-net .net-bar');
    if (netBar) {
      const netIn = netBar.querySelector('.net-in');
      const netOut = netBar.querySelector('.net-out');
      const { upPct, downPct, upDim, downDim, upHide, downHide, upLeft, downLeft, upZIndex, downZIndex } = getNetBarWidths(node);
      if (node.traffic_limit > 0) {
        netBar.classList.remove('unlimited');
        if (netIn) {
          netIn.style.width = `${upPct.toFixed(1)}%`;
          netIn.style.left = `${upLeft.toFixed(1)}%`;
          netIn.style.zIndex = upZIndex;
          netIn.classList.toggle('dimmed', upDim);
          netIn.classList.toggle('hidden', upHide);
        }
        if (netOut) {
          netOut.style.width = `${downPct.toFixed(1)}%`;
          netOut.style.left = `${downLeft.toFixed(1)}%`;
          netOut.style.zIndex = downZIndex;
          netOut.classList.toggle('dimmed', downDim);
          netOut.classList.toggle('hidden', downHide);
        }
      } else {
        netBar.classList.add('unlimited');
        if (netIn) netIn.style.width = '0%';
        if (netOut) netOut.style.width = '0%';
      }
    }

    const upValue = row.querySelector('.row-up .row-speed-value');
    const downValue = row.querySelector('.row-down .row-speed-value');
    const upSpan = row.querySelector('.row-uptime-value');
    if (upValue) scrambleTextIfChanged(upValue, isOnline ? formatNetworkSpeed(node.net_out || 0) : '-');
    if (downValue) scrambleTextIfChanged(downValue, isOnline ? formatNetworkSpeed(node.net_in || 0) : '-');
    if (upSpan) scrambleTextIfChanged(upSpan, isOnline ? formatUptime(node.uptime) : '-');
  }

  function render() {
    if (state.nodes.size === 0) {
      elements.container.innerHTML = `
        <div class="empty-state">
          <h2>NO NODES</h2>
          <p>No monitoring targets found.</p>
        </div>
      `;
      return;
    }

    elements.container.innerHTML = '';
    elements.container.className = `nodes-container${state.viewMode === 'list' ? ' list-view' : ''}`;

    const sortedNodes = Array.from(state.nodes.values()).sort((a, b) => a.weight - b.weight);

    sortedNodes.forEach(node => {
      const item = state.viewMode === 'list' ? createNodeListItem(node) : createNodeCard(node);
      elements.container.appendChild(item);
    });
  }

  function updateAllCards() {
    if (state.nodes.size === 0) return;
    state.nodes.forEach((node, uuid) => {
      const el = document.querySelector(`[data-uuid="${uuid}"]`);
      if (!el) return;
      if (el.classList.contains('node-row')) {
        updateNodeListItem(el, node);
      } else {
        updateNodeCard(node);
      }
    });
  }

  function updateStats() {
    let totalCpu = 0;
    let totalRam = 0;
    let onlineCount = 0;
    let ramCount = 0;
    let totalNetIn = 0;
    let totalNetOut = 0;

    state.nodes.forEach(node => {
      if (node.online !== false) {
        onlineCount++;
        totalCpu += node.cpu || 0;
        totalNetIn += node.net_in || 0;
        totalNetOut += node.net_out || 0;
        if (node.ram_total > 0) {
          totalRam += ((node.ram || 0) / node.ram_total) * 100;
          ramCount++;
        }
      }
    });

    const nodeCount = state.nodes.size;
    const avgCpu = nodeCount > 0 ? (totalCpu / nodeCount) : 0;
    const avgRam = ramCount > 0 ? (totalRam / ramCount) : 0;
    const netInText = (totalNetIn > 0 ? formatNetworkSpeed(totalNetIn) : '0 B/s').replace(' ', '\n');
    const netOutText = (totalNetOut > 0 ? formatNetworkSpeed(totalNetOut) : '0 B/s').replace(' ', '\n');

    const nodesText = nodeCount.toString();
    const onlineText = onlineCount.toString();
    const cpuText = avgCpu.toFixed(0) + '%';
    const ramText = avgRam.toFixed(0) + '%';

    if (state.isInitialRender) {
      elements.statNodes.dataset.prev = nodesText;
      elements.statOnline.dataset.prev = onlineText;
      elements.statCpu.dataset.prev = cpuText;
      elements.statRam.dataset.prev = ramText;
      elements.statNetIn.dataset.prev = netInText;
      elements.statNetOut.dataset.prev = netOutText;

      elements.statNodes.textContent = nodesText;
      elements.statOnline.textContent = onlineText;
      elements.statCpu.textContent = cpuText;
      elements.statRam.textContent = ramText;
      elements.statNetIn.textContent = netInText;
      elements.statNetOut.textContent = netOutText;
    } else {
      scrambleTextIfChanged(elements.statNodes, nodesText);
      scrambleTextIfChanged(elements.statOnline, onlineText);
      scrambleTextIfChanged(elements.statCpu, cpuText);
      scrambleTextIfChanged(elements.statRam, ramText);
      scrambleTextIfChanged(elements.statNetIn, netInText);
      scrambleTextIfChanged(elements.statNetOut, netOutText);
    }
  }

  function renderError() {
    elements.container.innerHTML = `
      <div class="empty-state">
        <h2>CONNECTION ERROR</h2>
        <p>Could not connect to Komari Monitor API.</p>
      </div>
    `;
  }

  function setViewMode(mode) {
    state.viewMode = mode;
    localStorage.setItem('nodeViewMode', mode);
    document.querySelectorAll('.btn-view').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === mode);
    });
    elements.container.className = `nodes-container${mode === 'list' ? ' list-view' : ''}`;
    render();
  }

  // --- Modal & Charts ---

  async function openNodeModal(uuid) {
    state.modalCloseId++;
    state.activeNodeUuid = uuid;
    state.modalTimeScale = 1; // Reset to 1h on open
    const node = state.nodes.get(uuid);
    if (!node) return;

    const netSpeedDown = formatNetworkSpeed(node.net_in || 0);
    const netSpeedUp = formatNetworkSpeed(node.net_out || 0);
    const memoryPercent = getPercentage(node.ram || 0, node.ram_total || 0);
    const swapPercent = getPercentage(node.swap || 0, node.swap_total || 0);
    const diskPercent = getPercentage(node.disk || 0, node.disk_total || 0);

    elements.modalContent.innerHTML = `
      <div class="modal-node-header">
        <div class="modal-node-title">
          <h2 class="modal-node-name">${node.name}</h2>
          <span class="modal-node-status-tag ${node.online ? 'online' : 'offline'}">${node.online ? 'Online' : 'Offline'}</span>
        </div>
        <div class="modal-node-meta">${node.os || ''} · ${node.arch || ''} · ${node.region || ''}</div>
      </div>

      <div class="modal-info-row">
        <div class="modal-info-section">
          <h3 class="modal-info-section-title">HARDWARE</h3>
          <div class="modal-info-grid">
            <div class="info-item"><span class="info-label">CPU</span><span class="info-value">${node.cpu_name || '-'} (${node.cpu_cores || 0} Cores)</span></div>
            <div class="info-item"><span class="info-label">Architecture</span><span class="info-value">${node.arch || '-'}</span></div>
            <div class="info-item"><span class="info-label">Virtualization</span><span class="info-value">${node.virtualization || '-'}</span></div>
            <div class="info-item"><span class="info-label">GPU</span><span class="info-value">${node.gpu_name || '-'}</span></div>
          </div>
        </div>

        <div class="modal-info-section">
          <h3 class="modal-info-section-title">SYSTEM</h3>
          <div class="modal-info-grid">
            <div class="info-item"><span class="info-label">OS</span><span class="info-value">${node.os || '-'}</span></div>
            <div class="info-item"><span class="info-label">Kernel</span><span class="info-value">${node.kernel_version || '-'}</span></div>
            <div class="info-item"><span class="info-label">Uptime</span><span class="info-value" id="modal-uptime">${formatUptime(node.uptime)}</span></div>
            <div class="info-item"><span class="info-label">Last Report</span><span class="info-value" id="modal-last-report">${node.last_report ? new Date(node.last_report).toLocaleString() : '-'}</span></div>
          </div>
        </div>

        <div class="modal-info-section modal-storage-section">
          <h3 class="modal-info-section-title">STORAGE</h3>
          <div class="storage-stack">
            <div class="storage-meter">
              <div class="storage-meter-header">
                <span class="storage-meter-label">MEMORY</span>
                <span class="storage-meter-value">${formatBytes(node.ram || 0)} / ${formatBytes(node.ram_total || 0)}</span>
              </div>
              <div class="storage-meter-track"><span class="storage-meter-fill ${getMetricClass(memoryPercent)}" style="width: ${memoryPercent}%"></span></div>
              <span class="storage-meter-percent">${memoryPercent}% USED</span>
            </div>
            <div class="storage-meter${node.swap_total > 0 ? '' : ' unlimited'}">
              <div class="storage-meter-header">
                <span class="storage-meter-label">SWAP</span>
                <span class="storage-meter-value">${node.swap_total > 0 ? `${formatBytes(node.swap || 0)} / ${formatBytes(node.swap_total)}` : 'NOT CONFIGURED'}</span>
              </div>
              <div class="storage-meter-track">${node.swap_total > 0 ? `<span class="storage-meter-fill ${getMetricClass(swapPercent)}" style="width: ${swapPercent}%"></span>` : ''}</div>
              <span class="storage-meter-percent">${node.swap_total > 0 ? `${swapPercent}% USED` : 'UNLIMITED'}</span>
            </div>
            <div class="storage-meter">
              <div class="storage-meter-header">
                <span class="storage-meter-label">DISK</span>
                <span class="storage-meter-value">${formatBytes(node.disk || 0)} / ${formatBytes(node.disk_total || 0)}</span>
              </div>
              <div class="storage-meter-track"><span class="storage-meter-fill ${getMetricClass(diskPercent)}" style="width: ${diskPercent}%"></span></div>
              <span class="storage-meter-percent">${diskPercent}% USED</span>
            </div>
          </div>
        </div>

        <div class="modal-info-section modal-network-section">
          <h3 class="modal-info-section-title">NETWORK</h3>
          <div class="network-channels">
            <div class="network-channel up">
              <div class="network-channel-direction"><span class="network-channel-arrow">↑</span><span>UPLOAD</span></div>
              <span class="network-channel-speed">${netSpeedUp}</span>
              <div class="network-channel-total"><span>TOTAL SENT</span><strong>${formatBytes(node.net_total_up || 0)}</strong></div>
            </div>
            <div class="network-channel down">
              <div class="network-channel-direction"><span class="network-channel-arrow">↓</span><span>DOWNLOAD</span></div>
              <span class="network-channel-speed">${netSpeedDown}</span>
              <div class="network-channel-total"><span>TOTAL RECEIVED</span><strong>${formatBytes(node.net_total_down || 0)}</strong></div>
            </div>
          </div>
          <div class="network-connections">
            <span>CONNECTIONS</span>
            <strong>${node.connections || 0} TCP · ${node.connections_udp || 0} UDP</strong>
          </div>
        </div>
      </div>

      <section class="modal-chart-section modal-load-section">
        <div class="modal-load-title-container">
          <h3 class="modal-load-title">LOAD OVERVIEW</h3>
          <div class="modal-timescale-selector load-timescale">
            <button class="btn-timescale active" data-hours="1">1H</button>
            <button class="btn-timescale" data-hours="6">6H</button>
            <button class="btn-timescale" data-hours="24">24H</button>
            <button class="btn-timescale" data-hours="72">3D</button>
            <button class="btn-timescale" data-hours="168">7D</button>
            <button class="btn-timescale" data-hours="720">30D</button>
          </div>
        </div>
        <div class="modal-load-grid">
        <div class="load-chart-card">
          <div class="load-chart-label">CPU</div>
          <div class="load-chart-value" id="modal-cpu-val">${(node.cpu || 0).toFixed(1)}%</div>
          <div id="chart-cpu" class="load-chart-container"></div>
        </div>
        <div class="load-chart-card">
          <div class="load-chart-label">Memory</div>
          <div class="load-chart-value" id="modal-ram-val">${(node.ram_total > 0 ? (node.ram / node.ram_total * 100) : 0).toFixed(1)}%</div>
          <div id="chart-ram" class="load-chart-container"></div>
        </div>
        <div class="load-chart-card">
          <div class="load-chart-label">Disk</div>
          <div class="load-chart-value" id="modal-disk-val">${(node.disk_total > 0 ? (node.disk / node.disk_total * 100) : 0).toFixed(1)}%</div>
          <div id="chart-disk" class="load-chart-container"></div>
        </div>
        <div class="load-chart-card">
          <div class="load-chart-label">Network</div>
          <div class="load-chart-value load-network-value" id="modal-net-val">
            <span class="load-network-up">↑ <span id="modal-net-up-val">${netSpeedUp}</span></span>
            <span class="load-network-separator">/</span>
            <span class="load-network-down">↓ <span id="modal-net-down-val">${netSpeedDown}</span></span>
          </div>
          <div id="chart-net" class="load-chart-container"></div>
        </div>
        <div class="load-chart-card">
          <div class="load-chart-label">Connections</div>
          <div class="load-chart-value" id="modal-conn-val">${node.connections || 0}</div>
          <div id="chart-conn" class="load-chart-container"></div>
        </div>
        <div class="load-chart-card">
          <div class="load-chart-label">Processes</div>
          <div class="load-chart-value" id="modal-proc-val">${node.process || 0}</div>
          <div id="chart-proc" class="load-chart-container"></div>
        </div>
        </div>
      </section>

      <section class="modal-chart-section modal-latency-section">
        <div class="modal-latency-header">
          <h3 class="modal-section-title">LATENCY</h3>
          <div class="modal-timescale-selector latency-timescale">
            <button class="btn-timescale active" data-hours="1">1H</button>
            <button class="btn-timescale" data-hours="6">6H</button>
            <button class="btn-timescale" data-hours="12">12H</button>
            <button class="btn-timescale" data-hours="24">24H</button>
          </div>
        </div>
        <div class="modal-latency-tasks" id="modal-latency-tasks"></div>
        <div id="chart-ping" class="chart-container"></div>
      </section>
    `;

    // Timescale events for LOAD
    elements.modalContent.querySelectorAll('.load-timescale .btn-timescale').forEach(btn => {
      btn.addEventListener('click', () => {
        const hours = parseInt(btn.dataset.hours);
        if (state.modalLoadTimeScale === hours) return;
        state.modalLoadTimeScale = hours;
        elements.modalContent.querySelectorAll('.load-timescale .btn-timescale').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        refreshLoadCharts(uuid);
      });
    });

    // Timescale events for LATENCY
    elements.modalContent.querySelectorAll('.latency-timescale .btn-timescale').forEach(btn => {
      btn.addEventListener('click', () => {
        const hours = parseInt(btn.dataset.hours);
        if (state.modalTimeScale === hours) return;
        state.modalTimeScale = hours;
        elements.modalContent.querySelectorAll('.latency-timescale .btn-timescale').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        refreshLatencyChart(uuid);
      });
    });

    document.body.style.overflow = 'hidden';
    elements.modal.classList.add('active');
    requestAnimationFrame(() => {
      refreshLoadCharts(uuid);
      refreshLatencyChart(uuid);
    });
  }

  function setChartLoading(sectionSelector, isLoading) {
    const section = elements.modalContent.querySelector(sectionSelector);
    if (!section) return;

    section.classList.toggle('is-loading', isLoading);
    let overlay = section.querySelector('.chart-loading-overlay');

    if (isLoading) {
      if (!overlay) {
        overlay = document.createElement('div');
        overlay.className = 'chart-loading-overlay';
        overlay.setAttribute('role', 'status');
        overlay.setAttribute('aria-label', 'Loading chart data');
        overlay.innerHTML = `
          <div class="chart-loading-panel">
            <div class="chart-loading-pixels" aria-hidden="true">
              ${Array.from({ length: 25 }, (_, index) => `<span class="chart-loading-pixel" style="--pixel-index: ${index}"></span>`).join('')}
            </div>
            <span class="chart-loading-text">RESOLVING DATA...</span>
          </div>
        `;
        section.appendChild(overlay);
      }
      overlay.classList.remove('is-leaving');
      requestAnimationFrame(() => overlay.classList.add('is-visible'));
    } else if (overlay) {
      overlay.classList.remove('is-visible');
      overlay.classList.add('is-leaving');
      setTimeout(() => {
        if (!section.classList.contains('is-loading')) overlay.remove();
      }, 250);
    }
  }

  async function refreshLoadCharts(uuid) {
    const requestId = ++state.loadRequestId;
    setChartLoading('.modal-load-section', true);

    try {
      const records = await fetchLoadHistory(uuid, state.modalLoadTimeScale);
      const history = records
        .map(record => ({ ...record, timestamp: parseRecordTime(record.time ?? record.updated_at) }))
        .filter(record => record.timestamp != null)
        .sort((a, b) => a.timestamp - b.timestamp);
      if (requestId !== state.loadRequestId || state.activeNodeUuid !== uuid) return;
      renderLoadCharts(history);
    } catch (error) {
      if (requestId === state.loadRequestId) console.warn('Error refreshing load charts:', error);
    } finally {
      if (requestId === state.loadRequestId) setChartLoading('.modal-load-section', false);
    }
  }

  async function refreshLatencyChart(uuid) {
    const requestId = ++state.latencyRequestId;
    setChartLoading('.modal-latency-section', true);

    try {
      const response = await rpcCall('common:getRecords', { uuid, type: 'ping', hours: state.modalTimeScale });
      if (requestId !== state.latencyRequestId || state.activeNodeUuid !== uuid) return;
      renderLatencyChart(response?.records || [], response?.tasks || []);
    } catch (error) {
      if (requestId === state.latencyRequestId) console.warn('Error refreshing latency chart:', error);
    } finally {
      if (requestId === state.latencyRequestId) setChartLoading('.modal-latency-section', false);
    }
  }

  async function fetchLoadHistory(uuid, hours) {
    try {
      const response = await fetch(`/api/records/load?uuid=${encodeURIComponent(uuid)}&hours=${hours}`);
      if (!response.ok) throw new Error(`Load history error: ${response.status}`);
      const payload = await response.json();
      return payload?.data?.records || payload?.records || [];
    } catch (error) {
      console.warn('[Komari Theme] Falling back to recent load records:', error);
      const limit = Math.min(1000, Math.max(60, hours * 60));
      const result = await rpcCall('common:getNodeRecentStatus', { uuid, limit });
      return result?.records || [];
    }
  }

  function closeNodeModal() {
    const closeId = ++state.modalCloseId;
    state.activeNodeUuid = null;
    state.loadRequestId++;
    state.latencyRequestId++;
    elements.modal.classList.remove('active');
    document.body.style.overflow = '';

    setTimeout(() => {
      if (closeId === state.modalCloseId && !elements.modal.classList.contains('active')) {
        disposeCharts();
      }
    }, 280);
  }

  function disposeCharts() {
    Object.values(state.charts).forEach(chart => {
      if (chart && typeof chart.dispose === 'function' && !chart.isDisposed()) chart.dispose();
    });
    state.charts = {};
  }

  function disposeChart(key) {
    const chart = state.charts[key];
    if (chart && typeof chart.dispose === 'function' && !chart.isDisposed()) chart.dispose();
    delete state.charts[key];
  }

  function formatChartTime(timestamp, hours, includeSeconds = false) {
    const date = new Date(timestamp);
    if (hours >= 24) {
      return `${String(date.getMonth() + 1).padStart(2, '0')}/${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    }
    const time = `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    return includeSeconds ? `${time}:${String(date.getSeconds()).padStart(2, '0')}` : time;
  }

  function createSeries(name, color, data, areaOpacity = 0.16) {
    return {
    name,
    type: 'line',
    data,
    showSymbol: false,
    smooth: true,
    connectNulls: false,
    lineStyle: { width: 2, color },
    itemStyle: { color },
    areaStyle: areaOpacity ? { opacity: areaOpacity, color } : undefined,
    emphasis: { focus: 'series' }
    };
  }

  function createChartOption(series, hours, formatter, yMax, showLegend = false, splitNumber = 4) {
    const timestamps = series.flatMap(item => item.data.map(point => point[0])).filter(Number.isFinite);
    const dataMin = timestamps.length ? Math.min(...timestamps) : null;
    const dataMax = timestamps.length ? Math.max(...timestamps) : null;
    return {
    animation: false,
    backgroundColor: 'transparent',
    textStyle: { fontFamily: 'Space Grotesk, sans-serif' },
    color: series.map(item => item.itemStyle.color),
    grid: { top: showLegend ? 38 : 16, right: 18, bottom: 34, left: 58, containLabel: false },
    legend: {
      show: showLegend,
      top: 6,
      right: 12,
      textStyle: { color: '#000', fontWeight: 700, fontSize: 11 }
    },
    tooltip: {
      trigger: 'axis',
      confine: true,
      backgroundColor: '#fff',
      borderColor: '#000',
      borderWidth: 2,
      padding: 0,
      textStyle: { color: '#000', fontWeight: 700 },
      axisPointer: { type: 'line', lineStyle: { color: '#000', type: 'dashed' } },
      formatter: params => {
        if (!params.length) return '';
        const timestamp = params[0].value[0];
        const rows = params.map(item => `${item.marker}${item.seriesName}: ${formatter(item.value[1])}`);
        return `<div style="background:#000;color:#fff;padding:6px 10px;font-weight:700">${formatChartTime(timestamp, hours, true)}</div><div style="padding:8px 10px;line-height:1.7">${rows.join('<br>')}</div>`;
      }
    },
    xAxis: {
      type: 'time',
      boundaryGap: false,
      min: dataMin == null ? undefined : dataMin,
      max: dataMax == null ? undefined : dataMax,
      splitNumber,
      z: 10,
      axisLine: { show: true, lineStyle: { color: '#000', width: 2 } },
      axisTick: { show: false },
      splitLine: { show: true, lineStyle: { color: 'rgba(0, 0, 0, 0.12)', type: 'dashed' } },
      axisLabel: {
        color: '#555',
        fontSize: 10,
        fontWeight: 700,
        hideOverlap: true,
        formatter: value => formatChartTime(value, hours)
      }
    },
    yAxis: {
      type: 'value',
      min: 0,
      max: yMax,
      splitNumber,
      z: 10,
      axisLabel: { color: '#555', fontSize: 10, fontWeight: 700, formatter },
      axisLine: { show: true, lineStyle: { color: '#000', width: 2 } },
      axisTick: { show: false },
      splitLine: { lineStyle: { color: 'rgba(0, 0, 0, 0.12)', type: 'dashed' } }
    },
    series,
    media: [
      {
        query: { maxWidth: 600 },
        option: {
          legend: { show: false },
          grid: { top: 12, right: 10, bottom: 28, left: 46 }
        }
      }
    ]
    };
  }

  function mountChart(key, selector, option) {
    const element = document.querySelector(selector);
    if (!element) return;
    const chart = echarts.init(element, null, { renderer: 'canvas' });
    chart.setOption(option, { notMerge: true });
    state.charts[key] = chart;
  };


  function renderLoadCharts(history) {
    ['cpu', 'ram', 'disk', 'net', 'conn', 'proc'].forEach(disposeChart);
    if (typeof echarts === 'undefined') return;

    const toPoint = (record, value) => [record.timestamp, value];
    const netDownData = history.map(h => toPoint(h, h.net_in ?? 0));
    const netUpData = history.map(h => toPoint(h, h.net_out ?? 0));
    const cpuData = history.map(h => toPoint(h, h.cpu ?? 0));
    const ramData = history.map(h => toPoint(h, h.ram_total > 0 ? (h.ram / h.ram_total * 100) : 0));
    const diskData = history.map(h => toPoint(h, h.disk_total > 0 ? (h.disk / h.disk_total * 100) : 0));
    const connData = history.map(h => toPoint(h, h.connections ?? 0));
    const procData = history.map(h => toPoint(h, h.process ?? 0));
    const percentFormatter = value => `${Number(value).toFixed(0)}%`;
    const integerFormatter = value => Number(value).toFixed(0);
    mountChart('cpu', '#chart-cpu', createChartOption([createSeries('CPU', '#E0C900', cpuData)], state.modalLoadTimeScale, percentFormatter, 100, false, 5));
    mountChart('ram', '#chart-ram', createChartOption([createSeries('RAM', '#9B5DE5', ramData)], state.modalLoadTimeScale, percentFormatter, 100, false, 5));
    mountChart('disk', '#chart-disk', createChartOption([createSeries('Disk', '#00A854', diskData)], state.modalLoadTimeScale, percentFormatter, 100, false, 5));
    mountChart('net', '#chart-net', createChartOption([
      createSeries('Down', '#0066FF', netDownData),
      createSeries('Up', '#00A854', netUpData)
    ], state.modalLoadTimeScale, formatBytes, null, true));
    mountChart('conn', '#chart-conn', createChartOption([createSeries('Connections', '#FF3333', connData)], state.modalLoadTimeScale, integerFormatter));
    mountChart('proc', '#chart-proc', createChartOption([createSeries('Processes', '#0066FF', procData)], state.modalLoadTimeScale, integerFormatter));


  }

  function computeTaskStats(pingRecords, pingTasks) {
    const nameById = {};
    (pingTasks || []).forEach(task => { nameById[task.id] = task.name; });

    const grouped = new Map();
    (pingRecords || []).forEach(record => {
      const taskId = record.task_id ?? 'Default';
      const timestamp = parseRecordTime(record.time ?? record.updated_at);
      if (timestamp == null) return;
      if (!grouped.has(taskId)) grouped.set(taskId, []);
      grouped.get(taskId).push({ timestamp, value: record.value });
    });

    const order = [];
    (pingTasks || []).forEach(task => { if (grouped.has(task.id) && !order.includes(task.id)) order.push(task.id); });
    grouped.forEach((_, id) => { if (!order.includes(id)) order.push(id); });

    return order.map(taskId => {
      const recs = grouped.get(taskId).slice().sort((a, b) => a.timestamp - b.timestamp);
      const total = recs.length;
      const lossCount = recs.filter(r => typeof r.value === 'number' && r.value < 0).length;
      const loss = total > 0 ? (lossCount / total) * 100 : 0;
      const latestRecord = recs[recs.length - 1];
      const latestRaw = latestRecord ? latestRecord.value : null;
      const latest = typeof latestRaw === 'number' && latestRaw >= 0 ? latestRaw : null;

      const validValues = recs
        .map(r => r.value)
        .filter(v => typeof v === 'number' && v >= 0);

      const stats = validValues.length ? {
        min: Math.min(...validValues),
        max: Math.max(...validValues),
        avg: validValues.reduce((sum, v) => sum + v, 0) / validValues.length,
        p50: percentile(validValues, 50),
        p99: percentile(validValues, 99),
      } : { min: null, max: null, avg: null, p50: null, p99: null };

      return {
        id: taskId,
        name: nameById[taskId] || (taskId === 'Default' ? 'Ping' : `Task ${taskId}`),
        latest,
        loss,
        ...stats,
        total
      };
    });
  }

  function percentile(values, p) {
    if (!values.length) return null;
    const sorted = values.slice().sort((a, b) => a - b);
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.floor((p / 100) * sorted.length)));
    return sorted[idx];
  }

  function renderLatencyTasks(stats, colorByTaskId) {
    const container = document.getElementById('modal-latency-tasks');
    if (!container) return;
    if (!stats.length) { container.innerHTML = ''; return; }

    container.innerHTML = stats.map((task, index) => {
      const color = colorByTaskId.get(String(task.id)) || PING_COLORS[index % PING_COLORS.length];
      const lossText = `${task.loss.toFixed(1)}% LOSS`;
      const lossClass = task.loss > 0 ? 'has-loss' : '';
      const latestText = formatPing(task.latest);
      const detailRows = [];
      if (task.min != null) detailRows.push(['MIN', `${task.min.toFixed(0)} ms`]);
      if (task.avg != null) detailRows.push(['AVG', `${task.avg.toFixed(0)} ms`]);
      if (task.max != null) detailRows.push(['MAX', `${task.max.toFixed(0)} ms`]);
      if (task.p50 != null) detailRows.push(['P50', `${task.p50.toFixed(0)} ms`]);
      if (task.p99 != null) detailRows.push(['P99', `${task.p99.toFixed(0)} ms`]);
      const detailHtml = detailRows.length
        ? `<div class="latency-task-detail-wrap"><div class="latency-task-detail">${detailRows.map(([k, v]) =>
            `<div class="info-item"><span class="info-label">${k}</span><span class="info-value">${escapeHtml(v)}</span></div>`
          ).join('')}</div></div>`
        : '';

      return `
        <div class="latency-task-card" data-series-index="${index}" style="--task-color: ${color};">
          <div class="latency-task-row">
            <div class="latency-task-strip"></div>
            <div class="latency-task-body">
              <div class="latency-task-header">
                <span class="latency-task-name" title="${escapeHtml(task.name)}">${escapeHtml(task.name)}</span>
              </div>
              <div class="latency-task-stats">
                <span class="latency-task-latest">${escapeHtml(latestText)}</span>
                <span class="latency-task-sep">·</span>
                <span class="latency-task-loss ${lossClass}">${escapeHtml(lossText)}</span>
              </div>
            </div>
          </div>
          ${detailHtml}
        </div>
      `;
    }).join('');
  }

  function bindLatencyTaskInteractions(chart) {
    const container = document.getElementById('modal-latency-tasks');
    if (!container || !chart) return;
    const cards = Array.from(container.querySelectorAll('.latency-task-card'));
    const usesHover = window.matchMedia('(hover: hover) and (pointer: fine)').matches;
    let activeIndex = null;

    const setActive = index => {
      activeIndex = index;
      container.classList.toggle('has-active', index != null);
      cards.forEach(card => {
        card.classList.toggle('is-active', Number(card.dataset.seriesIndex) === index);
      });
      chart.dispatchAction({ type: 'downplay', seriesIndex: 'all' });
      if (index != null) chart.dispatchAction({ type: 'highlight', seriesIndex: index });
    };

    cards.forEach(card => {
      const index = Number(card.dataset.seriesIndex);
      if (usesHover) {
        card.addEventListener('mouseenter', () => setActive(index));
        card.addEventListener('mouseleave', () => setActive(null));
      } else {
        card.addEventListener('click', () => setActive(activeIndex === index ? null : index));
      }
    });

    chart.on('mouseover', params => {
      if (params.componentType === 'series') setActive(params.seriesIndex);
    });
    chart.on('globalout', () => {
      if (usesHover) setActive(null);
    });
  }

  function renderLatencyChart(pingRecords, pingTasks) {
    disposeChart('ping');
    if (typeof echarts === 'undefined') return;

    const stats = computeTaskStats(pingRecords, pingTasks);
    const colorByTaskId = new Map(stats.map((task, index) => [
      String(task.id),
      PING_COLORS[index % PING_COLORS.length]
    ]));
    renderLatencyTasks(stats, colorByTaskId);

    const nameById = {};
    (pingTasks || []).forEach(task => { nameById[task.id] = task.name; });
    const pingGroups = {};
    (pingRecords || []).forEach(record => {
      const taskId = record.task_id || 'Default';
      const timestamp = parseRecordTime(record.time ?? record.updated_at);
      if (timestamp == null) return;
      if (!pingGroups[taskId]) {
        pingGroups[taskId] = {
          name: nameById[record.task_id] || (taskId === 'Default' ? 'Ping' : `Task ${taskId}`),
          data: []
        };
      }
      const value = (record.value == null || record.value < 0) ? null : record.value;
      pingGroups[taskId].data.push([timestamp, value]);
    });

    const orderedTaskIds = stats
      .map(task => String(task.id))
      .filter(taskId => pingGroups[taskId]);
    Object.keys(pingGroups).forEach(taskId => {
      if (!orderedTaskIds.includes(taskId)) orderedTaskIds.push(taskId);
    });
    const pingSeries = orderedTaskIds.map((taskId, index) => createSeries(
      pingGroups[taskId].name,
      colorByTaskId.get(taskId) || PING_COLORS[index % PING_COLORS.length],
      pingGroups[taskId].data.sort((a, b) => a[0] - b[0]),
      0.08
    ));
    if (pingSeries.length) {
      mountChart('ping', '#chart-ping', createChartOption(pingSeries, state.modalTimeScale, value => `${Number(value).toFixed(1)} ms`, null, false));
      bindLatencyTaskInteractions(state.charts.ping);
    }
  }

  function updateModalLiveInfo() {
    if (!state.activeNodeUuid) return;
    const node = state.nodes.get(state.activeNodeUuid);
    if (!node) return;

    const uptimeEl = document.getElementById('modal-uptime');
    if (uptimeEl) {
      const isOnline = node.online !== false && node.name !== undefined;
      uptimeEl.textContent = isOnline ? formatUptime(node.uptime) : '-';
    }

    const lastReportEl = document.getElementById('modal-last-report');
    if (lastReportEl) {
      lastReportEl.textContent = node.last_report ? new Date(node.last_report).toLocaleString() : '-';
    }

    // Animate value changes in Load Overview cards.
    const cpuVal = document.getElementById('modal-cpu-val');
    if (cpuVal) scrambleTextIfChanged(cpuVal, (node.cpu || 0).toFixed(1) + '%');
    const ramVal = document.getElementById('modal-ram-val');
    if (ramVal) scrambleTextIfChanged(ramVal, (node.ram_total > 0 ? (node.ram / node.ram_total * 100) : 0).toFixed(1) + '%');
    const diskVal = document.getElementById('modal-disk-val');
    if (diskVal) scrambleTextIfChanged(diskVal, (node.disk_total > 0 ? (node.disk / node.disk_total * 100) : 0).toFixed(1) + '%');
    const netUpVal = document.getElementById('modal-net-up-val');
    if (netUpVal) scrambleTextIfChanged(netUpVal, formatNetworkSpeed(node.net_out || 0));
    const netDownVal = document.getElementById('modal-net-down-val');
    if (netDownVal) scrambleTextIfChanged(netDownVal, formatNetworkSpeed(node.net_in || 0));
    const connVal = document.getElementById('modal-conn-val');
    if (connVal) scrambleTextIfChanged(connVal, String(node.connections || 0));
    const procVal = document.getElementById('modal-proc-val');
    if (procVal) scrambleTextIfChanged(procVal, String(node.process || 0));
  }

  function startPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
    }
    state.pollTimer = setInterval(fetchNodesAndStatus, state.pollInterval);
  }

  function stopPolling() {
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
  }

  function init() {
    document.querySelectorAll('.btn-view').forEach(btn => {
      btn.classList.toggle('active', btn.dataset.view === state.viewMode);
      btn.addEventListener('click', () => setViewMode(btn.dataset.view));
    });

    elements.adminButton.addEventListener('click', event => {
      if (state.isLoggedIn) return;
      event.preventDefault();
      openAuthModal(false);
    });
    elements.authClose.addEventListener('click', closeAuthModal);
    elements.authModal.addEventListener('click', event => {
      if (event.target === elements.authModal) closeAuthModal();
    });
    elements.authForm.addEventListener('submit', submitLogin);
    elements.authBack.addEventListener('click', () => setAuthStep(false));

    elements.modalClose.addEventListener('click', closeNodeModal);
    elements.modal.addEventListener('click', (e) => {
      if (e.target === elements.modal) closeNodeModal();
    });

    document.addEventListener('keydown', (event) => {
      if (event.key !== 'Escape') return;
      if (elements.authModal.classList.contains('active')) {
        event.preventDefault();
        closeAuthModal();
      } else if (elements.modal.classList.contains('active')) {
        event.preventDefault();
        closeNodeModal();
      }
    });

    window.addEventListener('resize', () => {
      Object.values(state.charts).forEach(chart => {
        if (chart && typeof chart.resize === 'function' && !chart.isDisposed()) chart.resize();
      });
    });

    // Header scroll hide/show - shows on any upscroll
    const header = document.querySelector('.header');
    if (header) {
      let lastScrollY = 0;

      function handleScroll() {
        const currentScrollY = window.scrollY;

        if (currentScrollY < lastScrollY) {
          // Scrolling up - show header
          header.style.transform = 'translateY(0)';
        } else if (currentScrollY > 100) {
          // Scrolling down past threshold - hide header
          header.style.transform = 'translateY(-100%)';
        }

        lastScrollY = currentScrollY;
      }

      window.addEventListener('scroll', handleScroll, { passive: true });

      // Set main padding to header height after render
      requestAnimationFrame(() => {
        const mainEl = document.querySelector('.main');
        if (mainEl) {
          mainEl.style.paddingTop = (header.offsetHeight + 24) + 'px';
        }
      });
    }

    fetchPublicSettings().then(async () => {
      await fetchAuthState();
      if (state.publicSettings?.private_site && !state.isLoggedIn) {
        stopPolling();
        openAuthModal(true);
        return;
      }
      await fetchNodesAndStatus();
      startPolling();
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
