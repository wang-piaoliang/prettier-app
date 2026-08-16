/* ============================================================
   prettier PWA
   ------------------------------------------------------------
   本文件不含任何个人数据。记录和照片都在 GitHub 私有仓库里
   （见 assets/store.js），令牌存在本机 localStorage。

   为什么用 GitHub 而不是 Cloudflare：workers.dev / pages.dev 在国内
   网络下 DNS 被污染，手机不挂代理打不开；api.github.com 直连可用。
   多端共享靠的就是这个云端，任何设备填一次令牌即可。
   ============================================================ */

(function () {
  'use strict';

  var LS = {
    owner: 'prettier.owner',
    repo:  'prettier.repo',
    token: 'prettier.token',
    theme: 'prettier.theme',
    cache: 'prettier.cache',   // 上次拉到的数据，离线冷启动用
  };

  var state = {
    owner: '', repo: '', token: '',
    data: null,      // {settings..., entries}
    tree: {},        // 路径 → blob sha，取照片用
    view: 'timeline',
    draft: null,
  };

  /* ================= 工具 ================= */

  var $ = function (s, r) { return (r || document).querySelector(s); };
  var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function el(html) {
    var t = document.createElement('template');
    t.innerHTML = html.trim();
    return t.content.firstElementChild;
  }

  function get(k, d) { try { return localStorage.getItem(k) || d; } catch (e) { return d; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  var SLOT = { morning: '上午', afternoon: '下午', night: '晚上' };
  var FACE = { bare: '素颜', makeup: '带妆' };
  var SLOT_ORDER = ['morning', 'afternoon', 'night'];

  function fmtDate(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? p[0] + '.' + p[1] + '.' + p[2] : iso;
  }
  function weekday(iso) {
    var d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? '' : '周' + '日一二三四五六'[d.getDay()];
  }
  function todayISO() { return nowLocal().slice(0, 10); }

  /* 本地时间，格式 YYYY-MM-DDTHH:MM —— 正好是 datetime-local 输入框要的格式。
     不用 toISOString()：那个会转成 UTC，晚上 8 点会变成当天中午甚至前一天。 */
  function nowLocal() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) +
           'T' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function fmtTime(at) {
    var m = String(at || '').match(/T(\d{2}:\d{2})/);
    return m ? m[1] : '';
  }
  // 完全由时间决定，不再让用户单独选 —— 时间已经填了，时段是它的派生
  function slotFromHour(h) {
    if (h < 12) return 'morning';
    if (h < 18) return 'afternoon';
    return 'night';
  }
  function slotOf(e) {
    var h = Number(String(e.at || '').slice(11, 13));
    return isNaN(h) ? (e.slot || '') : slotFromHour(h);
  }

  function dims() { return (state.data && state.data.dimensions) || []; }
  function zoneLabels() { return (state.data && state.data.zoneLabels) || {}; }

  function overall(e) {
    if (!e || !e.scores) return null;
    var v = dims().map(function (d) { return e.scores[d.key]; })
                  .filter(function (x) { return typeof x === 'number'; });
    return v.length ? v.reduce(function (a, b) { return a + b; }, 0) / v.length : null;
  }
  function level(v) { return v == null ? '' : v <= 2.4 ? 'lv-low' : v <= 3.6 ? 'lv-mid' : 'lv-high'; }
  function pillLevel(v) { return v == null ? '' : v <= 2.4 ? 'watch' : v <= 3.6 ? 'ok' : 'good'; }

  function ascCompare(a, b) {
    // 有完整时间就按时间排，没有的老记录退回按日期 + 时段
    if (a.at && b.at && a.at !== b.at) return a.at < b.at ? -1 : 1;
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var sa = SLOT_ORDER.indexOf(slotOf(a)), sb = SLOT_ORDER.indexOf(slotOf(b));
    if (sa !== sb) return sa - sb;
    return String(a.id) < String(b.id) ? -1 : 1;
  }
  function newestFirst(list) {
    return list.slice().sort(function (a, b) { return -ascCompare(a, b); });
  }

  /* ================= 提示 / 主题 ================= */

  var toastTimer;
  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 4200 : 2200);
  }

  var THEMES = ['light', 'dark', 'auto'];
  var THEME_LABEL = { light: '浅色', dark: '深色', auto: '自动' };
  function applyTheme(t) {
    var r = document.documentElement;
    // 切换主题前先关过渡：颜色走 CSS 变量，变量一变正在跑的过渡会卡在旧值上
    r.classList.add('theme-switching');
    r.setAttribute('data-theme', t);
    requestAnimationFrame(function () {
      requestAnimationFrame(function () { r.classList.remove('theme-switching'); });
    });
    set(LS.theme, t);
    var b = $('#themeBtn');
    if (b) b.textContent = THEME_LABEL[t];
  }

  function syncDot(cls, title) {
    var d = $('#syncDot');
    if (d) { d.className = 'syncdot ' + (cls || ''); d.title = title || ''; }
  }

  /* ================= 云端（GitHub 私有仓库） ================= */

  function configureStore() {
    GitStore.configure({ owner: state.owner, repo: state.repo, token: state.token });
  }

  function loadData() {
    syncDot('busy', '同步中');
    configureStore();

    // 一次拿整棵树，顺带得到每张照片的 blob sha，省掉逐个文件查询
    return GitStore.head()
      .then(function (sha) { return GitStore.tree(sha); })
      .then(function (t) {
        state.tree = {};
        (t.tree || []).forEach(function (n) {
          if (n.type === 'blob') state.tree[n.path] = n.sha;
        });
        return Promise.all([
          GitStore.readJSON('settings.json'),
          GitStore.readJSON('entries.json'),
        ]);
      })
      .then(function (r) {
        var settings = r[0] || {};
        settings.entries = r[1] || [];
        state.data = settings;
        set(LS.cache, JSON.stringify({ data: settings, tree: state.tree }));
        syncDot('', '已同步');
        return settings;
      })
      .catch(function (err) {
        // 断网就退回上次拉到的内容，但要如实说明看到的是旧数据
        var cached = get(LS.cache, '');
        if (cached && !state.data) {
          try {
            var c = JSON.parse(cached);
            state.data = c.data;
            state.tree = c.tree || {};
            syncDot('off', '离线，显示上次同步的内容');
            toast('离线，显示上次同步的内容');
            return state.data;
          } catch (e) {}
        }
        syncDot('err', String(err.message || err));
        throw err;
      });
  }

  /* 照片：先看本机缓存，没有再从仓库取。
     照片内容不会变（改动都是新路径），所以按 blob sha 缓存，永不失效。 */
  var photoURLCache = {};

  function photoURL(path) {
    if (photoURLCache[path]) return Promise.resolve(photoURLCache[path]);
    var sha = state.tree[path];
    if (!sha) return Promise.reject(new Error('仓库里没有这张照片：' + path));

    return GitStore.cacheGet(sha).then(function (hit) {
      if (hit) return hit;
      return GitStore.readBlobBySha(sha).then(function (blob) {
        GitStore.cachePut(sha, blob);
        return blob;
      });
    }).then(function (blob) {
      var u = URL.createObjectURL(blob);
      photoURLCache[path] = u;
      return u;
    });
  }

  /* 该延后的是【网络请求】，不是解码。
     img 上不要写 loading="lazy"：blob 取回来时已经在内存里，
     lazy 只会让「先 fetch 再赋 src」这套流程卡住不显示。 */
  var photoObserver = ('IntersectionObserver' in window)
    ? new IntersectionObserver(function (rows) {
        rows.forEach(function (row) {
          if (!row.isIntersecting) return;
          photoObserver.unobserve(row.target);
          fillPhoto(row.target);
        });
      }, { rootMargin: '400px' })
    : null;

  function fillPhoto(img) {
    if (img.dataset.loaded) return;
    img.dataset.loaded = '1';
    photoURL(img.dataset.key).then(function (u) { img.src = u; })
      .catch(function () { img.alt = '照片加载失败'; });
  }

  // 首屏几张直接取，不等 IntersectionObserver：
  // 页面在后台/未渲染时 IO 不上报可见性，光靠它首屏可能一直空白。
  var EAGER = 3;

  function hydratePhotos(root) {
    $$('img[data-key]', root).forEach(function (img, i) {
      if (img.dataset.loaded) return;
      if (i < EAGER || !photoObserver) fillPhoto(img);
      else photoObserver.observe(img);
    });
  }

  /* ================= 照片处理 ================= */

  function processImage(file) {
    // 归一化的两件事都在 store.js 里：压平 iPhone 的 HDR（否则 Safari
    // 按扩展动态范围渲染，缩略图过曝且每张亮度都不同），再做温和的亮度归一。
    // 对皮肤档案这是刚需 —— 明暗不一的照片没法纵向比色斑深浅。
    return PrettierPhoto.normalize(file).then(function (r) {
      return {
        blob: r.blob,
        width: r.width,
        height: r.height,
        gain: r.gain,
        // iPhone 从相册选的图，lastModified 通常就是拍摄时间，
        // 拿它给日期字段做默认值，省得又把日期记错
        takenAt: file.lastModified ? new Date(file.lastModified).toISOString() : null,
        filename: (file.name || 'photo').replace(/\.[^.]+$/, '') + '.jpg',
        preview: URL.createObjectURL(r.blob),
      };
    });
  }

  /* ================= 渲染片段 ================= */

  function scoresHTML(scores) {
    if (!scores) return '';
    var items = dims().filter(function (d) { return typeof scores[d.key] === 'number'; })
      .map(function (d) {
        var v = scores[d.key];
        var on = new Array(v + 1).join('●');
        var off = new Array(5 - v + 1).join('●');
        return '<div class="score"><b>' + esc(d.label) + '</b>' +
          '<span class="dots ' + level(v) + '">' + on +
          (off ? '<span class="off">' + off + '</span>' : '') + '</span></div>';
      }).join('');
    return items ? '<div class="scores">' + items + '</div>' : '';
  }

  function zonesHTML(zones) {
    if (!zones) return '';
    var Z = zoneLabels();
    var rows = Object.keys(Z).filter(function (k) { return zones[k]; }).map(function (k) {
      return '<div class="zone"><div class="zone-name">' + esc(Z[k]) + '</div>' +
        '<div class="zone-text">' + esc(zones[k]) + '</div></div>';
    }).join('');
    return rows ? '<div class="zones">' + rows + '</div>' : '';
  }

  var COVER_MAX = 2;   // 时间线上最多铺开几张，其余折叠

  function entryHTML(e, showTime) {
    var keys = (e.photos || []).slice();
    // AI 判断出的最佳那张顶到最前，没有就按原顺序
    var best = e.ai && typeof e.ai.best === 'number' ? e.ai.best : -1;
    if (best > 0 && best < keys.length) {
      keys = [keys[best]].concat(keys.filter(function (_, i) { return i !== best; }));
    }

    var shown = keys.slice(0, COVER_MAX);
    var hidden = keys.length - shown.length;

    var photos = keys.length
      ? '<div class="entry-photos n' + shown.length + '" data-id="' + esc(e.id) + '">' +
        shown.map(function (k, i) {
          return '<button class="ph" data-idx="' + i + '" type="button">' +
                 '<img data-key="' + esc(k) + '" alt="">' +
                 (i === shown.length - 1 && hidden > 0
                   ? '<span class="more">+' + hidden + '</span>' : '') +
                 '</button>';
        }).join('') + '</div>'
      : '';

    var ov = overall(e);
    var pills = [];
    if (e.face) pills.push('<span class="pill">' + esc(FACE[e.face] || e.face) + '</span>');
    var sl = slotOf(e);
    if (sl) pills.push('<span class="pill">' + esc(SLOT[sl] || sl) + '</span>');
    if (ov != null) pills.push('<span class="pill ' + pillLevel(ov) + '">肤况 ' + ov.toFixed(1) + '</span>');
    if (e.makeup && typeof e.makeup.fit === 'number') {
      pills.push('<span class="pill ' + pillLevel(e.makeup.fit) + '">妆 ' + e.makeup.fit + '</span>');
    }
    if (e.ai) pills.push('<span class="pill accent">AI</span>');

    var tags = (e.tags || []).map(function (t) {
      return '<span class="pill accent">' + esc(t) + '</span>';
    }).join('');

    var prod = productsHTML(e.products);

    return '<article class="entry" data-id="' + esc(e.id) + '">' + photos +
      '<div class="entry-body">' +
        '<div class="entry-head">' +
        (fmtTime(e.at) ? '<span class="entry-time">' + fmtTime(e.at) + '</span>' : '') +
        '<div class="meta" style="margin-left:auto">' + pills.join('') + '</div></div>' +
        (e.light ? '<div class="tiny" style="margin-bottom:10px">' + esc(e.light) + '</div>' : '') +
        (tags ? '<div class="meta" style="margin-bottom:10px">' + tags + '</div>' : '') +
        scoresHTML(e.scores) +
        prod +
        zonesHTML(e.zones) +
        makeupHTML(e.makeup) +
        (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') +
        '<div class="entry-act">' +
          '<button data-edit="' + esc(e.id) + '">编辑</button>' +
          '<button data-del="' + esc(e.id) + '">删除</button>' +
        '</div>' +
      '</div></article>';
  }

  function productsHTML(p) {
    if (!p) return '';
    var rows = '';
    if (p.skincare && p.skincare.length)
      rows += '<div class="prow"><b>护肤</b><span>' + p.skincare.map(esc).join(' · ') + '</span></div>';
    if (p.makeup && p.makeup.length)
      rows += '<div class="prow"><b>彩妆</b><span>' + p.makeup.map(esc).join(' · ') + '</span></div>';
    return rows ? '<div class="products">' + rows + '</div>' : '';
  }

  function makeupHTML(m) {
    if (!m || (!m.verdict && !m.issues && !m.state && typeof m.lasting !== 'number')) return '';
    var bits = [];
    if (typeof m.lasting === 'number') bits.push('持妆 ' + m.lasting + '/5');
    if (m.state && m.state.length) bits.push(m.state.join('、'));
    if (m.issues && m.issues.length) bits.push(m.issues.join('；'));
    return '<div class="note">' +
      (bits.length ? '<b>妆容</b>　' + esc(bits.join('　·　')) + (m.verdict ? '<br>' : '') : '') +
      (m.verdict ? esc(m.verdict) : '') + '</div>';
  }

  /* ---- 趋势图：按日聚合，横轴按真实日期间隔 ---- */
  function chartSVG(entries, dimKey) {
    var byDay = {};
    entries.slice().sort(ascCompare).forEach(function (e) {
      var v = dimKey === '__all' ? overall(e) : (e.scores ? e.scores[dimKey] : null);
      if (typeof v !== 'number') return;
      (byDay[e.date] = byDay[e.date] || []).push(v);
    });
    var pts = Object.keys(byDay).sort().map(function (d) {
      var vs = byDay[d];
      return { date: d, v: vs.reduce(function (a, b) { return a + b; }, 0) / vs.length, n: vs.length };
    });

    if (!pts.length) return '<div class="empty">这个维度还没有数据。</div>';
    if (pts.length === 1) {
      return '<div class="empty"><strong>' + pts[0].v.toFixed(1) + ' / 5</strong>' +
        fmtDate(pts[0].date) + ' 的记录。只有一个观察日，还画不出趋势。</div>';
    }

    var W = 680, H = 170, PL = 30, PR = 12, PT = 12, PB = 26;
    var iw = W - PL - PR, ih = H - PT - PB, n = pts.length;
    var days = function (a, b) {
      return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
    };
    var span = days(pts[0].date, pts[n - 1].date);
    var x = function (i) { return span <= 0 ? PL + iw / 2 : PL + iw * (days(pts[0].date, pts[i].date) / span); };
    var y = function (v) { return PT + ih - ((v - 1) / 4) * ih; };

    var grid = '', labels = '';
    [1, 2, 3, 4, 5].forEach(function (v) {
      var yy = y(v);
      grid += '<line x1="' + PL + '" y1="' + yy + '" x2="' + (W - PR) + '" y2="' + yy +
        '" stroke="currentColor" stroke-opacity=".14"/>';
      labels += '<text x="' + (PL - 8) + '" y="' + (yy + 4) + '" text-anchor="end" font-size="11" ' +
        'fill="var(--ink-soft)">' + v + '</text>';
    });

    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + x(i) + ' ' + y(p.v); }).join(' ');
    var dots = pts.map(function (p, i) {
      return '<circle cx="' + x(i) + '" cy="' + y(p.v) + '" r="4" fill="var(--card)" ' +
        'stroke="var(--accent)" stroke-width="2"><title>' + esc(p.date + ' · ' + p.v.toFixed(1)) +
        '</title></circle>';
    }).join('');
    var xs = [0, n - 1].map(function (i) {
      return '<text x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="' + (i ? 'end' : 'start') +
        '" font-size="11" fill="var(--ink-soft)">' + esc(pts[i].date.slice(5)) + '</text>';
    }).join('');

    return '<svg class="chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" ' +
      'style="color:var(--ink)">' + grid + labels +
      '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' + dots + xs + '</svg>';
  }

  /* ================= 视图 ================= */

  var collapsedDays = {};      // date -> true 表示收起
  var allCollapsed = false;

  function renderTimeline() {
    var host = $('#view-timeline');
    var list = newestFirst((state.data && state.data.entries) || []);
    if (!list.length) {
      host.innerHTML = '<div class="empty"><strong>还没有记录</strong>点下面的「记一条」开始。</div>';
      return;
    }

    // 按天分组：同一天的多次拍摄归到一个区块，块内按时间从早到晚
    var days = [], index = {};
    list.forEach(function (e) {
      if (!index[e.date]) { index[e.date] = { date: e.date, rows: [] }; days.push(index[e.date]); }
      index[e.date].rows.push(e);
    });
    days.forEach(function (d) { d.rows.sort(ascCompare); });

    host.innerHTML =
      '<div class="tl-bar">' +
        '<span class="tiny">' + days.length + ' 天 · ' + list.length + ' 条</span>' +
        '<button id="foldAll" type="button">' +
          (allCollapsed ? '全部展开' : '全部折叠') +
        '</button>' +
      '</div>' +
      days.map(function (d) {
        var closed = collapsedDays[d.date];
        var n = d.rows.length;
        var photos = d.rows.reduce(function (a, e) { return a + (e.photos || []).length; }, 0);
        return '<section class="day' + (closed ? ' closed' : '') + '" data-date="' + esc(d.date) + '">' +
          '<button class="day-head" type="button" data-fold="' + esc(d.date) + '">' +
            '<span class="day-date">' + fmtDate(d.date) + '</span>' +
            '<span class="day-week">' + esc(weekday(d.date)) + '</span>' +
            '<span class="day-count">' + (n > 1 ? n + ' 次 · ' : '') + photos + ' 张</span>' +
            '<span class="ml-caret">▾</span>' +
          '</button>' +
          '<div class="day-body"' + (closed ? ' hidden' : '') + '>' +
            d.rows.map(function (e) { return entryHTML(e); }).join('') +
          '</div>' +
        '</section>';
      }).join('');

    host.addEventListener('click', function (ev) {
      var f = ev.target.closest('[data-fold]');
      if (f) {
        var date = f.dataset.fold;
        collapsedDays[date] = !collapsedDays[date];
        var sec = f.closest('.day');
        sec.classList.toggle('closed', collapsedDays[date]);
        sec.querySelector('.day-body').hidden = collapsedDays[date];
        if (!collapsedDays[date]) hydratePhotos(sec);
        return;
      }
      if (ev.target.closest('#foldAll')) {
        allCollapsed = !allCollapsed;
        days.forEach(function (d) { collapsedDays[d.date] = allCollapsed; });
        renderTimeline();
        return;
      }
      var ed = ev.target.closest('[data-edit]');
      if (ed) return editEntry(ed.dataset.edit);
      var dl = ev.target.closest('[data-del]');
      if (dl) return deleteEntry(dl.dataset.del);
    });

    hydratePhotos(host);
  }

  function renderTrend() {
    var host = $('#view-trend');
    var entries = (state.data && state.data.entries) || [];
    var opts = [{ value: '__all', label: '综合' }].concat(
      dims().map(function (d) { return { value: d.key, label: d.label }; })
    );

    host.innerHTML =
      '<div class="section-title">状态趋势</div>' +
      '<div class="card"><div class="segmented" id="dimSeg" style="margin-bottom:14px">' +
      opts.map(function (o, i) {
        return '<button data-v="' + esc(o.value) + '"' + (i ? '' : ' class="on"') + '>' +
          esc(o.label) + '</button>';
      }).join('') +
      '</div><div id="chartBox"></div>' +
      '<div class="tiny" style="margin-top:12px;text-align:center">1–5 分，5 = 状态最好</div></div>' +
      '<div class="section-title">拍摄条件</div>' +
      '<div class="card muted">不同光线、距离、上妆与否的照片<b>不能直接比分数高低</b>。' +
      '要看某个产品有没有用，得在同样光线下、同样素颜再拍一张对比。</div>';

    var box = $('#chartBox', host);
    box.innerHTML = chartSVG(entries, '__all');
    $('#dimSeg', host).addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      $$('#dimSeg button', host).forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      box.innerHTML = chartSVG(entries, b.dataset.v);
    });
  }

  function renderMainlines() {
    var host = $('#view-mainlines');
    var ml = (state.data && state.data.mainlines) || [];
    if (!ml.length) {
      host.innerHTML = '<div class="empty">还没有主线问题。</div>';
      return;
    }

    var card = function (m, idx) {
      var body = [
        m.summary ? '<div class="body">' + esc(m.summary) + '</div>' : '',
        m.plan ? '<div class="next"><b>怎么做</b><br>' + esc(m.plan) + '</div>' : '',
        m.watch ? '<div class="next"><b>注意</b><br>' + esc(m.watch) + '</div>' : '',
        m.invalid ? '<div class="next"><b>无效的做法</b><br>' + esc(m.invalid) + '</div>' : '',
      ].join('');

      return '<div class="card mainline">' +
        '<button class="ml-head" type="button" data-i="' + idx + '" aria-expanded="false">' +
          '<span class="ml-title">' + esc(m.key) + '</span>' +
          (m.area ? '<span class="pill">' + esc(m.area) + '</span>' : '') +
          '<span class="ml-caret">▾</span>' +
        '</button>' +
        '<div class="ml-body" hidden>' + body + '</div>' +
      '</div>';
    };

    host.innerHTML = '<div class="section-title">在跟的问题</div>' +
      ml.map(card).join('') +
      procedureHTML();

    host.addEventListener('click', function (ev) {
      var h = ev.target.closest('.ml-head');
      if (!h) return;
      var body = h.nextElementSibling;
      var open = !body.hidden;
      body.hidden = open;
      h.setAttribute('aria-expanded', String(!open));
      h.classList.toggle('open', !open);
    });
  }

  function procedureHTML() {
    var list = (state.data && state.data.procedures) || [];
    if (!list.length) {
      return '<div class="section-title">医美记录</div>' +
        '<div class="empty">还没有记录。做过什么、什么时候做的，记在这里。</div>';
    }
    return '<div class="section-title">医美记录</div>' +
      list.slice().reverse().map(function (p) {
        return '<div class="card" style="margin-bottom:12px">' +
          '<div class="entry-head" style="border:none;margin:0;padding:0">' +
            '<span class="entry-date">' + fmtDate(p.date) + '</span>' +
            '<span class="pill accent" style="margin-left:auto">' + esc(p.name) + '</span>' +
          '</div>' +
          (p.note ? '<div class="note" style="border:none;padding-top:8px">' +
                    esc(p.note) + '</div>' : '') +
        '</div>';
      }).join('');
  }

  /* ---- 记一条 ---- */

  function lastEntry() {
    var all = newestFirst((state.data && state.data.entries) || []);
    return all[0] || null;
  }

  function blankDraft() {
    var now = new Date();
    // 护肤品从照片上看不出来，而且基本天天一样 —— 默认沿用上一条，自己改
    var prev = lastEntry();
    var carried = prev && prev.products
      ? { skincare: (prev.products.skincare || []).slice(),
          makeup: (prev.products.makeup || []).slice() }
      : { skincare: [], makeup: [] };

    return {
      photos: [],
      // 拍完就传，所以上传当下的时间就是记录时间。可以改。
      at: nowLocal(),
      date: todayISO(),
      slot: slotFromHour(now.getHours()),
      slotManual: false,
      face: 'makeup',
      kind: 'both',
      light: '',
      scores: {},
      makeupScores: {},
      products: carried,
      carriedFrom: prev ? prev.date : null,
      note: '',
      tags: [],
      ai: null,
    };
  }

  /* 带妆时的持妆状态。AI 会自动勾，不准直接点掉 —— 这些是判断
     「这个底妆到底扛不扛得住」最直接的证据，比分数更具体。 */
  var MAKEUP_STATES = ['泛油光', '斑驳', '卡粉', '脱妆', '暗沉', '干纹', '完好'];

  var LIGHT_PRESETS = ['窗边自然光', '室内暖光', '室内白光', '近距离侧光', '均匀正面光', '室外'];

  function renderCompose() {
    var host = $('#view-compose');
    if (!state.draft) state.draft = blankDraft();
    var d = state.draft;

    host.innerHTML =
      '<div class="section-title">' + (d.editingId ? '编辑记录' : '记一条') + '</div>' +

      /* 常用的三样放最上面：照片、时间、备注，填完就能存。
         其余大部分时候不填，收进下面的折叠区。 */
      '<div class="field"><label>照片</label>' +
        '<div class="picker" id="picker"></div>' +
      '</div>' +

      '<div class="field"><label>时间</label>' +
        '<input type="datetime-local" id="fAt" value="' + esc(d.at) + '">' +
        '<div class="tiny hint" id="slotHint"></div>' +
      '</div>' +

      '<div class="field"><label>备注</label>' +
        '<textarea id="fNote" placeholder="看到什么写什么，可留空">' + esc(d.note) + '</textarea>' +
      '</div>' +

      '<button class="btn" id="saveBtn">' + (d.editingId ? '保存修改' : '保存') + '</button>' +

      '<button class="btn ghost" id="aiBtn" type="button" style="margin-top:10px">' +
        '让 AI 看照片打分' +
      '</button>' +
      '<div id="aiOut"></div>' +

      /* ---- 以下折叠 ---- */
      '<button class="more-toggle" id="moreToggle" type="button" aria-expanded="false">' +
        '更多（素颜/带妆、光线、评分、产品、标签）<span class="ml-caret">▾</span>' +
      '</button>' +
      '<div id="moreBox" hidden>' +

        '<div class="field"><label>素颜还是带妆</label>' +
          '<div class="segmented" id="fFace">' +
          ['bare', 'makeup'].map(function (x) {
            return '<button data-v="' + x + '"' + (d.face === x ? ' class="on"' : '') + '>' +
              FACE[x] + '</button>';
          }).join('') + '</div>' +
        '</div>' +

        '<div class="field"><label>光线条件</label>' +
          '<input type="text" id="fLight" placeholder="比如：窗边自然光" value="' + esc(d.light) + '">' +
          '<div class="segmented" id="lightPresets" style="margin-top:8px">' +
          LIGHT_PRESETS.map(function (p) {
            return '<button data-v="' + esc(p) + '" style="flex:0 1 auto;font-size:12px;min-height:36px">' +
              esc(p) + '</button>';
          }).join('') + '</div>' +
          '<div class="tiny hint">填了这个，AI 判读会准很多。</div>' +
        '</div>' +

        '<div class="field"><label>肤况评分（看不清就留空）</label>' +
          '<div class="card" id="fScores"></div>' +
        '</div>' +

        (d.face === 'makeup'
          ? '<div class="field"><label>妆容</label>' +
              '<div class="card" id="fMakeupScores"></div>' +
              '<div class="tiny hint" style="margin:10px 0 8px">持妆状态（AI 会自动勾，不准就点掉）</div>' +
              '<div class="segmented" id="fMakeupState">' +
              MAKEUP_STATES.map(function (x) {
                var on = (d.makeupState || []).indexOf(x) >= 0;
                return '<button data-v="' + esc(x) + '"' + (on ? ' class="on"' : '') +
                  ' style="flex:0 1 auto;font-size:12px;min-height:36px">' + esc(x) + '</button>';
              }).join('') +
              '</div>' +
            '</div>'
          : '') +

        '<div class="field"><label>今天用的产品' +
          (d.carriedFrom ? '（沿用 ' + fmtDate(d.carriedFrom) + '）' : '') + '</label>' +
          '<div class="prod-edit">' +
            '<div class="prow"><b>护肤</b>' +
              '<input type="text" id="fSkincare" placeholder="顿号分隔" value="' +
              esc((d.products.skincare || []).join('、')) + '"></div>' +
            '<div class="prow"><b>彩妆</b>' +
              '<input type="text" id="fMakeupProd" placeholder="顿号分隔" value="' +
              esc((d.products.makeup || []).join('、')) + '"></div>' +
          '</div>' +
        '</div>' +

        '<div class="field"><label>标签</label>' +
          '<input type="text" id="fTags" value="' + esc((d.tags || []).join(' ')) + '">' +
        '</div>' +

      '</div>' +

      '<button class="btn ghost" id="resetBtn" style="margin-top:18px">' +
        (d.editingId ? '取消编辑' : '清空重来') + '</button>';

    drawPicker();
    drawRates();
    updateSlotHint();

    $('#moreToggle', host).addEventListener('click', function () {
      var box = $('#moreBox', host);
      var open = !box.hidden;
      box.hidden = open;
      this.setAttribute('aria-expanded', String(!open));
      this.classList.toggle('open', !open);
    });

    $('#picker', host).addEventListener('click', function (ev) {
      if (ev.target.closest('#addPhoto')) { $('#fileInput').click(); return; }

      var mv = ev.target.closest('[data-mv]');
      if (mv) {
        if (movePhoto(d.photos, Number(mv.dataset.mv), Number(mv.dataset.dir))) drawPicker();
        return;
      }
      var kmv = ev.target.closest('[data-kmv]');
      if (kmv) {
        if (movePhoto(d.keepPhotos, Number(kmv.dataset.kmv), Number(kmv.dataset.dir))) drawPicker();
        return;
      }
      var kdel = ev.target.closest('[data-kdel]');
      if (kdel) {
        d.keepPhotos.splice(Number(kdel.dataset.kdel), 1);
        drawPicker();
        return;
      }
      var b = ev.target.closest('.del');
      if (!b || b.dataset.i === undefined) return;
      var i = Number(b.dataset.i);
      URL.revokeObjectURL(d.photos[i].preview);
      d.photos.splice(i, 1);
      drawPicker();
    });

    $('#fScores', host).addEventListener('click', function (ev) {
      var c = ev.target.closest('[data-clear]');
      if (c) { delete d.scores[c.dataset.clear]; drawRates(); return; }
      var b = ev.target.closest('[data-k]');
      if (!b) return;
      d.scores[b.dataset.k] = Number(b.dataset.v);
      drawRates();
    });

    var ms = $('#fMakeupState', host);
    if (ms) ms.addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      d.makeupState = d.makeupState || [];
      var at = d.makeupState.indexOf(b.dataset.v);
      if (at >= 0) d.makeupState.splice(at, 1); else d.makeupState.push(b.dataset.v);
      b.classList.toggle('on');
    });

    var fms = $('#fMakeupScores', host);
    if (fms) fms.addEventListener('click', function (ev) {
      var c = ev.target.closest('[data-clear]');
      if (c) { delete d.makeupScores[c.dataset.clear]; drawRates(); return; }
      var b = ev.target.closest('[data-k]');
      if (!b) return;
      d.makeupScores[b.dataset.k] = Number(b.dataset.v);
      drawRates();
    });

    $('#fAt', host).addEventListener('change', function () {
      d.at = this.value || nowLocal();
      d.date = d.at.slice(0, 10);
      var h = Number(d.at.slice(11, 13));
      d.slot = slotFromHour(isNaN(h) ? 12 : h);
      updateSlotHint();
    });
    $('#fLight', host).addEventListener('input', function () { d.light = this.value; });
    $('#fNote', host).addEventListener('input', function () { d.note = this.value; });
    $('#fTags', host).addEventListener('input', function () {
      d.tags = this.value.split(/[\s,，、]+/).filter(Boolean);
    });
    var splitList = function (v) { return v.split(/[,，、]+/).map(function (x) { return x.trim(); }).filter(Boolean); };
    $('#fSkincare', host).addEventListener('input', function () { d.products.skincare = splitList(this.value); });
    $('#fMakeupProd', host).addEventListener('input', function () { d.products.makeup = splitList(this.value); });

    var seg = function (sel, key, redraw) {
      var node = $(sel, host);
      if (!node) return;
      node.addEventListener('click', function (ev) {
        var b = ev.target.closest('button');
        if (!b) return;
        d[key] = b.dataset.v;
        if (redraw) { renderCompose(); $('#moreToggle').click(); return; }
        $$(sel + ' button', host).forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    };
    seg('#fFace', 'face', true);

    $('#lightPresets', host).addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      d.light = b.dataset.v;
      $('#fLight', host).value = d.light;
    });

    $('#aiBtn', host).addEventListener('click', runAI);
    $('#saveBtn', host).addEventListener('click', saveDraft);
    $('#resetBtn', host).addEventListener('click', function () {
      if (!confirm('清空这条草稿？')) return;
      state.draft = blankDraft();
      renderCompose();
    });
  }

  function updateSlotHint() {
    var el2 = $('#slotHint');
    if (!el2) return;
    var d = state.draft;
    el2.textContent = '默认是上传当下的时间，可以改。当前归类为「' +
      (SLOT[d.slot] || '') + '」。';
  }

  /* ---- AI 判读 ---- */

  function runAI() {
    var d = state.draft;
    if (!d.photos.length) return toast('先加照片', true);

    if (!ensureKey()) return;

    var btn = $('#aiBtn'), out = $('#aiOut');
    btn.disabled = true;
    btn.textContent = 'AI 看照片中…';
    out.innerHTML = '';

    var S = state.data || {};
    PrettierAI.analyze(d.photos.map(function (p) { return p.blob; }), {
      face: d.face,
      light: d.light,
      slotLabel: SLOT[d.slot],
      dimensions: S.dimensions || [],
      makeupDimensions: S.makeupDimensions || [],
      mirrored: true,
      background: (S.mainlines || []).map(function (m) {
        return '· ' + m.key + (m.area ? '（' + m.area + '）' : '');
      }).join('\n'),
    }).then(function (r) {
      d.ai = r;
      // AI 给的分直接填进去，你可以再改
      Object.assign(d.scores, r.scores || {});
      Object.assign(d.makeupScores, r.makeup || {});
      if (r.tags && r.tags.length) d.tags = r.tags;
      if (r.makeupState && r.makeupState.length) {
        d.makeupState = r.makeupState.filter(function (x) { return MAKEUP_STATES.indexOf(x) >= 0; });
      }
      if (r.summary && !d.note) d.note = r.summary;

      renderCompose();
      $('#aiOut').innerHTML =
        '<div class="card" style="margin-bottom:20px">' +
          '<div class="tiny" style="margin-bottom:8px">AI 判读 · ' + esc(r.model) + '</div>' +
          (r.summary ? '<div class="zone-text">' + esc(r.summary) + '</div>' : '') +
          zonesHTML(r.zones) +
          '<div class="tiny" style="margin-top:10px">分数已填进下面，随时可以改。' +
          '看不清的项目 AI 会留空，那是对的。</div>' +
        '</div>';
    }).catch(function (err) {
      toast('AI 判读失败：' + (err.message || err), true);
      btn.disabled = false;
      btn.textContent = '让 AI 看照片打分';
    });
  }

  function drawPicker() {
    var host = $('#picker');
    if (!host) return;
    var d = state.draft;
    var keep = d.keepPhotos || [];

    // 已有照片（编辑时）在前，新加的在后；两段各自可以左右移动
    var cells = keep.map(function (p, i) {
      return '<div class="slot"><img data-key="' + esc(p) + '" alt="">' +
        '<button class="del" data-kdel="' + i + '" aria-label="删除">×</button>' +
        '<div class="mv">' +
          '<button data-kmv="' + i + '" data-dir="-1" aria-label="左移">‹</button>' +
          '<button data-kmv="' + i + '" data-dir="1" aria-label="右移">›</button>' +
        '</div></div>';
    }).concat(d.photos.map(function (p, i) {
      return '<div class="slot new"><img src="' + p.preview + '" alt="">' +
        '<button class="del" data-i="' + i + '" aria-label="删除">×</button>' +
        '<span class="badge">新</span>' +
        '<div class="mv">' +
          '<button data-mv="' + i + '" data-dir="-1" aria-label="左移">‹</button>' +
          '<button data-mv="' + i + '" data-dir="1" aria-label="右移">›</button>' +
        '</div></div>';
    }));

    host.innerHTML = cells.join('') +
      '<button class="add" id="addPhoto"><span class="glyph">＋</span>加照片</button>';
    hydratePhotos(host);
  }

  function movePhoto(list, i, dir) {
    var j = i + dir;
    if (j < 0 || j >= list.length) return false;
    var t = list[i]; list[i] = list[j]; list[j] = t;
    return true;
  }

  function rateRows(host, list, bag) {
    if (!host) return;
    host.innerHTML = list.map(function (dim) {
      var v = bag[dim.key];
      var stars = '';
      for (var i = 1; i <= 5; i++) {
        stars += '<button data-k="' + dim.key + '" data-v="' + i + '" class="' +
          (v >= i ? 'on' : '') + '" aria-label="' + dim.label + ' ' + i + '">●</button>';
      }
      return '<div class="rate" title="' + esc(dim.hint || '') + '">' +
        '<span class="name">' + esc(dim.label) + '</span>' +
        '<span class="stars">' + stars + '</span>' +
        (v ? '<button class="clear" data-clear="' + dim.key + '">清除</button>' : '') +
        '</div>';
    }).join('') || '<div class="tiny">还没有维度</div>';
  }

  function drawRates() {
    var d = state.draft, S = state.data || {};
    rateRows($('#fScores'), S.dimensions || [], d.scores);
    rateRows($('#fMakeupScores'), S.makeupDimensions || [], d.makeupScores);
  }

  function onFilesPicked(files) {
    var d = state.draft;
    var jobs = Array.prototype.slice.call(files).map(function (f) {
      return processImage(f).then(function (p) { d.photos.push(p); })
        .catch(function (err) { toast(err.message, true); });
    });
    // 时间用上传当下的，不从照片元数据里取 —— 拍完立刻传，当下时间更可靠，
    // 而且相册里的 lastModified 可能是导入时间，不是拍摄时间。
    Promise.all(jobs).then(drawPicker);
  }

  function makeEntryId(date) {
    var base = date.replace(/-/g, '');
    var existing = ((state.data && state.data.entries) || [])
      .filter(function (e) { return e.date === date; })
      .map(function (e) { return e.id; });
    // 从 01 往上找第一个没被占的，避免删过记录后重新撞号
    for (var n = 1; n < 100; n++) {
      var id = base + '-' + String(n).padStart(2, '0');
      if (existing.indexOf(id) < 0) return id;
    }
    return base + '-' + Date.now().toString(36);
  }

  /* ================= 后台上传队列 =================
     点保存立刻返回，上传在后台跑，可以马上接着记下一条。
     队列串行执行：手机上行就那么宽，并发只会让每一条都变慢。 */

  var queue = [];
  var running = false;

  function enqueue(job) {
    queue.push(job);
    renderQueue();
    pump();
  }

  function pump() {
    if (running || !queue.length) return;
    running = true;
    var job = queue[0];
    job.state = 'running';
    job.step = '准备…';
    renderQueue();

    runJob(job).then(function () {
      queue.shift();
      running = false;
      renderQueue();
      toast('已保存 ' + job.label);
      return loadData().then(function () { if (state.view === 'timeline') go('timeline'); });
    }).catch(function (err) {
      job.state = 'failed';
      job.error = (err.step ? '「' + err.step + '」' : '') + (err.message || err);
      running = false;
      renderQueue();
      toast('保存失败：' + job.error, true);
    }).then(function () { pump(); });
  }

  function runJob(job) {
    /* 提交前重新读一次云端的 entries.json，而不是用内存里的。
       两次上传排队时，第二条如果拿的是排队那一刻的旧列表，
       会把第一条刚写进去的记录覆盖掉。 */
    return GitStore.readJSON('entries.json').then(function (remote) {
      var entries = (remote || []).slice();
      var at = entries.findIndex(function (x) { return x.id === job.entry.id; });
      if (at >= 0) entries[at] = job.entry; else entries.push(job.entry);

      var files = job.files.concat([
        { path: 'entries.json', text: JSON.stringify(entries, null, 2) },
      ]);
      return GitStore.commit(files, job.message, function (t) {
        job.step = t;
        renderQueue();
      });
    });
  }

  function renderQueue() {
    var host = $('#queue');
    if (!queue.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML = queue.map(function (j, i) {
      if (j.state === 'failed') {
        return '<div class="qrow err"><span class="qtxt">' + esc(j.label) + ' · ' +
          esc(j.error) + '</span>' +
          '<button data-retry="' + i + '">重试</button>' +
          '<button data-drop="' + i + '">丢弃</button></div>';
      }
      return '<div class="qrow"><span class="spin"></span>' +
        '<span class="qtxt">' + esc(j.label) + ' · ' +
        esc(j.state === 'running' ? (j.step || '上传中') : '排队中') + '</span></div>';
    }).join('');
  }

  function bindQueue() {
    $('#queue').addEventListener('click', function (ev) {
      var r = ev.target.closest('[data-retry]');
      if (r) {
        var j = queue[Number(r.dataset.retry)];
        if (j) { j.state = 'queued'; j.error = ''; renderQueue(); pump(); }
        return;
      }
      var d = ev.target.closest('[data-drop]');
      if (d) {
        var idx = Number(d.dataset.drop);
        if (confirm('丢弃这次上传？照片会丢失。')) { queue.splice(idx, 1); renderQueue(); pump(); }
      }
    });
  }

  function saveDraft() {
    var d = state.draft;
    if (!d.date) return toast('先选时间', true);
    if (!d.photos.length && !d.note) return toast('至少加一张照片或写点备注', true);

    var id = d.editingId || makeEntryId(d.date);
    var files = [];
    var paths = (d.keepPhotos || []).slice();   // 编辑时保留的老照片

    d.photos.forEach(function (p, i) {
      var path = 'photos/' + id + '/' + Date.now().toString(36) + i + '.jpg';
      files.push({ path: path, blob: p.blob });
      paths.push(path);
    });

    var entry = {
      id: id, date: d.date, at: d.at, slot: d.slot, face: d.face, kind: d.kind,
      light: d.light, scores: d.scores, tags: d.tags, note: d.note,
      photos: paths,
      products: d.products,
    };
    if ((d.makeupScores && Object.keys(d.makeupScores).length) ||
        (d.makeupState && d.makeupState.length)) {
      entry.makeup = Object.assign({}, d.makeupScores);
      if (d.makeupState && d.makeupState.length) entry.makeup.state = d.makeupState;
    }
    if (d.ai) {
      entry.ai = { model: d.ai.model, at: d.ai.at, best: d.ai.best };
      if (d.ai.zones) entry.zones = Object.assign({}, d.ai.zones, d.zones || {});
    } else if (d.zones) {
      entry.zones = d.zones;
    }

    enqueue({
      entry: entry,
      files: files,
      label: fmtDate(d.date) + ' ' + fmtTime(d.at),
      message: (d.editingId ? '修改 ' : '记录 ') + d.date + '（' + id + '）',
      state: 'queued',
    });

    // 立刻放行：草稿清空、回时间线，可以马上接着记下一条
    d.photos.forEach(function (p) { URL.revokeObjectURL(p.preview); });
    state.draft = null;
    toast(files.length ? '后台上传中，可以继续记录' : '已加入队列');
    go('timeline');
  }

  function editEntry(id) {
    var e = ((state.data && state.data.entries) || [])
      .filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    state.draft = {
      editingId: e.id,
      photos: [],                       // 新加的
      keepPhotos: (e.photos || []).slice(),   // 已有的，可删可排序
      at: e.at || (e.date + 'T12:00'),
      date: e.date,
      slot: e.slot,
      face: e.face || 'makeup',
      kind: e.kind || 'both',
      light: e.light || '',
      scores: Object.assign({}, e.scores),
      makeupScores: Object.assign({}, e.makeup),
      makeupState: (e.makeup && e.makeup.state) ? e.makeup.state.slice() : [],
      products: {
        skincare: ((e.products || {}).skincare || []).slice(),
        makeup: ((e.products || {}).makeup || []).slice(),
      },
      zones: Object.assign({}, e.zones),
      note: e.note || '',
      tags: (e.tags || []).slice(),
      ai: null,
    };
    go('compose');
  }

  function deleteEntry(id) {
    var entries = ((state.data && state.data.entries) || []);
    var e = entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    if (!confirm('删除 ' + fmtDate(e.date) + ' ' + fmtTime(e.at) + ' 这条记录？\n' +
                 (e.photos || []).length + ' 张照片会一起删掉，不可恢复。')) return;

    toast('删除中…');
    // 提交前重读云端，避免把别处刚加的记录覆盖掉
    GitStore.readJSON('entries.json').then(function (remote) {
      var rest = (remote || []).filter(function (x) { return x.id !== id; });
      return GitStore.commit(
        [{ path: 'entries.json', text: JSON.stringify(rest, null, 2) }],
        '删除记录 ' + id
      ).then(function () {
        // 记录先删干净，再清照片文件 —— 反过来的话中途失败会留下引用不到的记录
        return (e.photos || []).length
          ? GitStore.commitDelete(e.photos, '删除 ' + id + ' 的照片')
          : null;
      });
    }).then(loadData).then(function () {
      toast('已删除');
      go('timeline');
    }).catch(function (err) {
      toast('删除失败：' + (err.message || err), true);
    });
  }

  /* ================= 路由 ================= */

  var RENDER = {
    timeline: renderTimeline,
    trend: renderTrend,
    compose: renderCompose,
    products: renderProducts,
    settings: renderSettings,
    mainlines: renderMainlines,
  };

  function go(view) {
    state.view = view;
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
    window.scrollTo(0, 0);
    (RENDER[view] || function () {})();
    hydratePhotos(document);
  }

  /* ================= AI 引擎 ================= */

  var AI_INFO = {
    qwen: {
      label: '百炼',
      where: 'bailian.console.aliyun.com → API-KEY',
      note: '国内直连可用，手机上也能用。推荐日常用这个。',
      ph: 'sk-...',
    },
    gemini: {
      label: 'Gemini',
      where: 'aistudio.google.com/apikey',
      note: '判读更细，但国内要代理 —— 手机上通常连不上。',
      ph: 'AIza...',
    },
  };

  /* 不用 prompt()：装成 PWA 之后 iOS 上那个弹窗很难用，
     长长的 API Key 粘不进去，有时干脆不弹。引导到设置页填。 */
  function ensureKey() {
    if (PrettierAI.getKey()) return true;
    toast('先去设置里填 API Key', true);
    go('settings');
    return false;
  }



  /* ================= 设置 ================= */

  function renderSettings() {
    var host = $('#view-settings');
    var p = PrettierAI.provider();

    host.innerHTML =
      '<div class="section-title">AI 判读</div>' +
      '<div class="card">' +
        '<div class="segmented" id="aiProvider">' +
          ['qwen', 'gemini'].map(function (k) {
            return '<button data-v="' + k + '"' + (p === k ? ' class="on"' : '') + '>' +
              esc(AI_INFO[k].label) + '</button>';
          }).join('') +
        '</div>' +
        '<div class="tiny" style="margin:10px 0 16px" id="aiNote">' + esc(AI_INFO[p].note) + '</div>' +

        '<div class="field" style="margin:0">' +
          '<label>API Key</label>' +
          '<div class="key-row">' +
            '<input type="password" id="aiKey" autocomplete="off" autocapitalize="off" ' +
              'autocorrect="off" spellcheck="false" placeholder="' + esc(AI_INFO[p].ph) + '" ' +
              'value="' + esc(PrettierAI.getKey()) + '">' +
            '<button id="keyEye" type="button">显示</button>' +
          '</div>' +
          '<div class="tiny hint">去这里拿：' + esc(AI_INFO[p].where) + '</div>' +
        '</div>' +

        '<button class="btn ghost" id="aiTest" type="button" style="margin-top:14px">' +
          '保存并测试' +
        '</button>' +
        '<div class="tiny" id="aiTestOut" style="margin-top:10px"></div>' +
      '</div>' +

      '<div class="section-title">云端</div>' +
      '<div class="card">' +
        '<div class="kv-line"><b>仓库</b><span>' + esc(state.owner + '/' + state.repo) + '</span></div>' +
        '<button class="btn ghost" id="diagBtn" type="button" style="margin-top:14px">' +
          '检查读写权限' +
        '</button>' +
        '<div class="tiny" id="diagOut" style="margin-top:10px"></div>' +
      '</div>' +

      '<div class="section-title">外观</div>' +
      '<div class="card">' +
        '<div class="segmented" id="themeSeg">' +
          THEMES.map(function (t) {
            return '<button data-v="' + t + '"' +
              (get(LS.theme, 'light') === t ? ' class="on"' : '') + '>' +
              THEME_LABEL[t] + '</button>';
          }).join('') +
        '</div>' +
      '</div>';

    var keyInput = $('#aiKey', host);

    $('#aiProvider', host).addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      PrettierAI.setProvider(b.dataset.v);
      renderSettings();
    });

    $('#keyEye', host).addEventListener('click', function () {
      var show = keyInput.type === 'password';
      keyInput.type = show ? 'text' : 'password';
      this.textContent = show ? '隐藏' : '显示';
    });

    $('#aiTest', host).addEventListener('click', function () {
      var out = $('#aiTestOut', host);
      var k = keyInput.value.trim();
      if (!k) { out.textContent = '先填 Key'; return; }
      PrettierAI.setKey(k);
      out.textContent = '测试中…';
      // 拿一张 8×8 的小图去打一次真实请求，能最快确认 key 和网络
      var c = document.createElement('canvas');
      c.width = c.height = 8;
      c.getContext('2d').fillRect(0, 0, 8, 8);
      c.toBlob(function (b) {
        PrettierAI.identifyProducts([b])
          .then(function () { out.innerHTML = '✅ 可用（' + esc(PrettierAI.modelName()) + '）'; })
          .catch(function (e) { out.innerHTML = '❌ ' + esc(e.message || e); });
      }, 'image/jpeg');
    });

    $('#diagBtn', host).addEventListener('click', function () {
      var o = $('#diagOut', host);
      o.textContent = '检查中…';
      GitStore.selftest().then(function (r) {
        o.innerHTML = [
          '读取：' + (r.read || '—'),
          '写入：' + (r.write || '—'),
          r.error ? '错误：' + esc(r.error) : '',
        ].filter(Boolean).join('<br>');
      });
    });

    $('#themeSeg', host).addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      applyTheme(b.dataset.v);
      $$('#themeSeg button', host).forEach(function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    });
  }

  /* ================= 产品库 ================= */

  function allProducts() { return (state.data && state.data.products) || []; }

  function renderProducts() {
    var host = $('#view-products');
    var list = allProducts();

    var body;
    if (!list.length) {
      body = '<div class="empty"><strong>产品库还是空的</strong>' +
        '拍一张护肤品或彩妆的照片，AI 会认出品牌和品名。<br>' +
        '入库之后，记录里就能直接引用。</div>';
    } else {
      var out = [];
      ['skincare', 'makeup'].forEach(function (kind) {
        var rows = list.filter(function (p) {
          return (p.kind || 'skincare') === kind && p.status !== 'retired';
        });
        if (!rows.length) return;
        out.push('<div class="cat-head">' + (kind === 'skincare' ? '护肤' : '彩妆') +
                 '<span>' + rows.length + '</span></div>');
        out.push('<div class="prod-list">' + rows.map(prodCardHTML).join('') + '</div>');
      });
      var retired = list.filter(function (p) { return p.status === 'retired'; });
      if (retired.length) {
        out.push('<div class="cat-head">已停用<span>' + retired.length + '</span></div>');
        out.push('<div class="prod-list dim">' + retired.map(prodCardHTML).join('') + '</div>');
      }
      body = out.join('');
    }

    host.innerHTML =
      '<div class="tl-bar">' +
        '<span class="tiny">产品库 · ' +
          list.filter(function (p) { return p.status !== 'retired'; }).length + ' 件在用</span>' +
        '<button id="scanBtn" type="button">＋ 拍照识别</button>' +
      '</div>' +
      '<div id="scanOut"></div>' +
      body +
      '<button class="more-toggle" id="addProdBtn" type="button">手动添加一件</button>';

    $('#scanBtn', host).addEventListener('click', function () { $('#prodInput').click(); });
    $('#addProdBtn', host).addEventListener('click', addProductManually);
    host.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-del]');
      if (b) return removeProduct(b.dataset.del);
      var t = ev.target.closest('[data-toggle]');
      if (t) return toggleProduct(t.dataset.toggle);
    });
    hydratePhotos(host);
  }

  function prodCardHTML(p) {
    var sub = [p.brand, p.category].filter(Boolean).join(' · ');
    return '<div class="prod-card">' +
      '<div class="pc-main">' +
        '<div class="nm">' + esc(p.name) + '</div>' +
        (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
      '</div>' +
      '<div class="act">' +
        '<button data-toggle="' + esc(p.id) + '">' +
          (p.status === 'retired' ? '恢复' : '停用') + '</button>' +
        '<button data-del="' + esc(p.id) + '">删除</button>' +
      '</div></div>';
  }

  function saveProducts(list, message) {
    var s = Object.assign({}, state.data);
    delete s.entries;
    s.products = list;
    return GitStore.commit(
      [{ path: 'settings.json', text: JSON.stringify(s, null, 2) }],
      message
    ).then(loadData).then(function () { go('products'); });
  }

  function removeProduct(id) {
    var p = allProducts().filter(function (x) { return x.id === id; })[0];
    if (!p || !confirm('从产品库删除「' + p.name + '」？')) return;
    saveProducts(allProducts().filter(function (x) { return x.id !== id; }), '产品库：删除 ' + p.name)
      .then(function () { toast('已删除'); })
      .catch(function (e) { toast('失败：' + e.message, true); });
  }

  function toggleProduct(id) {
    var list = allProducts().map(function (x) {
      if (x.id !== id) return x;
      return Object.assign({}, x, { status: x.status === 'retired' ? 'using' : 'retired' });
    });
    saveProducts(list, '产品库：切换状态').catch(function (e) { toast('失败：' + e.message, true); });
  }

  function addProductManually() {
    var name = prompt('产品名（例：某某氨基酸洁面）');
    if (!name) return;
    var brand = prompt('品牌（可留空）') || '';
    var kind = confirm('是彩妆吗？\n确定 = 彩妆，取消 = 护肤') ? 'makeup' : 'skincare';
    var p = {
      id: 'p' + Date.now().toString(36),
      name: name.trim(), brand: brand.trim(), kind: kind,
      status: 'using', addedAt: new Date().toISOString().slice(0, 10),
    };
    saveProducts(allProducts().concat([p]), '产品库：添加 ' + p.name)
      .then(function () { toast('已入库'); })
      .catch(function (e) { toast('失败：' + e.message, true); });
  }

  /* 拍产品 → AI 识别 → 只把【库里没有的】加进去 */
  function scanProducts(files) {
    if (!files || !files.length) return;
    if (!ensureKey()) return;

    var out = $('#scanOut');
    out.innerHTML = '<div class="card" style="margin-bottom:18px"><div class="tiny">识别中…</div></div>';

    Promise.all(Array.prototype.slice.call(files).map(function (f) {
      return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
    })).then(function (blobs) {
      return PrettierAI.identifyProducts(blobs).then(function (found) {
        return { blobs: blobs, found: found };
      });
    }).then(function (r) {
      var existing = allProducts();
      var isNew = function (x) {
        var key = (x.brand + x.name).replace(/\s/g, '').toLowerCase();
        return !existing.some(function (p) {
          return ((p.brand || '') + p.name).replace(/\s/g, '').toLowerCase() === key;
        });
      };
      var fresh = (r.found.products || []).filter(isNew);
      var dup = (r.found.products || []).length - fresh.length;

      if (!fresh.length) {
        out.innerHTML = '<div class="card" style="margin-bottom:18px"><div class="tiny">' +
          '认出 ' + dup + ' 件，都已经在库里了，没有新增。</div></div>';
        return;
      }

      out.innerHTML = '<div class="card" style="margin-bottom:18px">' +
        '<div class="tiny" style="margin-bottom:8px">新认出 ' + fresh.length + ' 件' +
        (dup ? '（另有 ' + dup + ' 件已在库）' : '') + '，正在入库…</div>' +
        fresh.map(function (x) {
          return '<div class="prow"><b>' + (x.kind === 'makeup' ? '彩妆' : '护肤') + '</b>' +
                 '<span>' + esc([x.brand, x.name].filter(Boolean).join(' ')) + '</span></div>';
        }).join('') + '</div>';

      var now = new Date().toISOString().slice(0, 10);
      var added = fresh.map(function (x, i) {
        return {
          id: 'p' + Date.now().toString(36) + i,
          name: x.name, brand: x.brand || '', kind: x.kind || 'skincare',
          category: x.category || '', status: 'using', addedAt: now,
        };
      });
      return saveProducts(existing.concat(added), '产品库：AI 识别新增 ' + added.length + ' 件')
        .then(function () { toast('新增 ' + added.length + ' 件'); });
    }).catch(function (err) {
      out.innerHTML = '';
      toast('识别失败：' + (err.message || err), true);
    });
  }

  /* ================= 灯箱（可左右滑） ================= */

  var lb = { keys: [], i: 0 };

  function openLightbox(entryId, startIdx) {
    var e = ((state.data && state.data.entries) || [])
      .filter(function (x) { return x.id === entryId; })[0];
    if (!e || !e.photos || !e.photos.length) return;

    var keys = e.photos.slice();
    var best = e.ai && typeof e.ai.best === 'number' ? e.ai.best : -1;
    if (best > 0 && best < keys.length) {
      keys = [keys[best]].concat(keys.filter(function (_, i) { return i !== best; }));
    }
    lb.keys = keys;
    lb.i = Math.max(0, Math.min(startIdx || 0, keys.length - 1));

    $('#lightbox').hidden = false;
    renderLightbox();
  }

  function renderLightbox() {
    var box = $('#lightbox');
    var img = $('#lbImg');
    var cnt = $('#lbCount');
    cnt.textContent = (lb.i + 1) + ' / ' + lb.keys.length;
    cnt.hidden = lb.keys.length < 2;
    $('#lbPrev').hidden = $('#lbNext').hidden = lb.keys.length < 2;

    img.style.opacity = '.25';
    photoURL(lb.keys[lb.i]).then(function (u) {
      img.src = u;
      img.style.opacity = '1';
    }).catch(function () { img.style.opacity = '1'; });

    // 顺手预取相邻两张，滑动时不用等
    [lb.i - 1, lb.i + 1].forEach(function (j) {
      if (j >= 0 && j < lb.keys.length) photoURL(lb.keys[j]).catch(function () {});
    });
  }

  function step(d) {
    if (lb.keys.length < 2) return;
    lb.i = (lb.i + d + lb.keys.length) % lb.keys.length;
    renderLightbox();
  }

  function bindLightbox() {
    var box = $('#lightbox');

    document.addEventListener('click', function (ev) {
      var ph = ev.target.closest && ev.target.closest('.entry-photos .ph');
      if (ph) {
        var wrap = ph.closest('.entry-photos');
        openLightbox(wrap.dataset.id, Number(ph.dataset.idx) || 0);
        return;
      }
      if (ev.target.closest('#lbPrev')) { step(-1); return; }
      if (ev.target.closest('#lbNext')) { step(1); return; }
      // 点图片本身不关闭，点背景才关
      if (ev.target.id === 'lightbox' || ev.target.closest('#lbClose')) box.hidden = true;
    });

    document.addEventListener('keydown', function (ev) {
      if (box.hidden) return;
      if (ev.key === 'Escape') box.hidden = true;
      if (ev.key === 'ArrowLeft') step(-1);
      if (ev.key === 'ArrowRight') step(1);
    });

    // 触摸横滑
    var x0 = null, y0 = null;
    box.addEventListener('touchstart', function (ev) {
      x0 = ev.touches[0].clientX; y0 = ev.touches[0].clientY;
    }, { passive: true });
    box.addEventListener('touchend', function (ev) {
      if (x0 == null) return;
      var dx = ev.changedTouches[0].clientX - x0;
      var dy = ev.changedTouches[0].clientY - y0;
      // 横向位移够大、且明显比纵向大，才算翻页；否则可能是想滚动或关闭
      if (Math.abs(dx) > 45 && Math.abs(dx) > Math.abs(dy) * 1.4) step(dx < 0 ? 1 : -1);
      x0 = y0 = null;
    }, { passive: true });
  }

  /* ================= 启动 ================= */

  function showApp() {
    $('#gate').hidden = true;
    $('#app').hidden = false;
    loadData().then(function () { go('timeline'); })
      .catch(function (err) { toast(String(err.message || err), true); });
  }

  function bindGate() {
    $('#gateForm').addEventListener('submit', function (ev) {
      ev.preventDefault();
      var repoFull = $('#gateRepo').value.trim().replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '');
      var token = $('#gateToken').value.trim();
      var parts = repoFull.split('/');
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        return toast('仓库要写成 用户名/仓库名', true);
      }
      if (!token) return toast('要填令牌', true);

      var btn = $('#gateBtn');
      btn.disabled = true;
      btn.textContent = '连接中…';

      state.owner = parts[0];
      state.repo = parts[1];
      state.token = token;

      loadData().then(function () {
        set(LS.owner, state.owner);
        set(LS.repo, state.repo);
        set(LS.token, token);
        showApp();
      }).catch(function (err) {
        toast(String(err.message || err), true);
        btn.disabled = false;
        btn.textContent = '进入';
      });
    });
  }

  function init() {
    applyTheme(get(LS.theme, 'light'));

    state.owner = get(LS.owner, '');
    state.repo = get(LS.repo, '');
    state.token = get(LS.token, '');

    bindGate();

    $('#fileInput').addEventListener('change', function () {
      onFilesPicked(this.files);
      this.value = '';
    });

    $('.tabbar').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (b) go(b.dataset.view);
    });

    $('#settingsBtn').addEventListener('click', function () { go('settings'); });

    $('#themeBtn').addEventListener('click', function () {
      var cur = get(LS.theme, 'light');
      applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    });

    $('#refreshBtn').addEventListener('click', function () {
      loadData().then(function () { go(state.view); toast('已刷新'); })
        .catch(function (err) { toast(String(err.message || err), true); });
    });

    // 灯箱：点开后可左右滑动看同一条记录里的全部照片
    bindLightbox();

    if (state.owner && state.repo && state.token) {
      showApp();
    } else {
      $('#gate').hidden = false;
      $('#gateRepo').value = (state.owner && state.repo)
        ? state.owner + '/' + state.repo
        : 'wang-piaoliang/prettier-data';
    }

    // 页脚版本号：手机上一眼确认加载到第几版
    var av = $('#appVersion');
    if (av && window.PRETTIER_BUILD) {
      av.textContent = 'prettier ' + PRETTIER_BUILD.v + ' · ' + PRETTIER_BUILD.at;
    }

    /* 加到主屏后是 standalone 模式，Safari 不会像普通标签页那样每次导航都
       重新检查 Service Worker —— 应用可以一直活着、一直用旧的外壳缓存，
       除非彻底杀掉重开。所以：新 worker 接管时主动刷新一次，
       并且每次回到前台都再检查一遍有没有新版本。 */
    if ('serviceWorker' in navigator && location.protocol !== 'file:') {
      var hadController = !!navigator.serviceWorker.controller;
      var reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloading || !hadController) return;   // 首次安装不需要刷
        reloading = true;
        location.reload();
      });
      window.addEventListener('load', function () {
        navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' })
          .then(function (reg) {
            reg.update();
            document.addEventListener('visibilitychange', function () {
              if (document.visibilityState === 'visible') reg.update();
            });
          }).catch(function () {});
      });
    }

    $('#prodInput').addEventListener('change', function () {
      scanProducts(this.files);
      this.value = '';
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
