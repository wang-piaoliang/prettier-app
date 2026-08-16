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

  var SLOT = { morning: '早', midday: '中午', evening: '傍晚', night: '夜间' };
  var FACE = { bare: '素颜', makeup: '带妆' };
  var SLOT_ORDER = ['morning', 'midday', 'evening', 'night'];

  function fmtDate(iso) {
    var p = String(iso || '').split('-');
    return p.length === 3 ? p[0] + '.' + p[1] + '.' + p[2] : iso;
  }
  function weekday(iso) {
    var d = new Date(iso + 'T12:00:00');
    return isNaN(d) ? '' : '周' + '日一二三四五六'[d.getDay()];
  }
  function todayISO() {
    var d = new Date(), p = function (n) { return String(n).padStart(2, '0'); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  function slotFromHour(h) {
    if (h < 11) return 'morning';
    if (h < 15) return 'midday';
    if (h < 19) return 'evening';
    return 'night';
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
    if (a.date !== b.date) return a.date < b.date ? -1 : 1;
    var sa = SLOT_ORDER.indexOf(a.slot), sb = SLOT_ORDER.indexOf(b.slot);
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

  function entryHTML(e) {
    var keys = e.photos || [];
    var photos = keys.length
      ? '<div class="entry-photos n' + Math.min(keys.length, 4) + '">' +
        keys.map(function (k) {
          return '<img data-key="' + esc(k) + '" alt="">';
        }).join('') + '</div>'
      : '';

    var ov = overall(e);
    var pills = [];
    if (e.face) pills.push('<span class="pill">' + esc(FACE[e.face] || e.face) + '</span>');
    if (e.slot) pills.push('<span class="pill">' + esc(SLOT[e.slot] || e.slot) + '</span>');
    if (ov != null) pills.push('<span class="pill ' + pillLevel(ov) + '">综合 ' + ov.toFixed(1) + '</span>');

    var tags = (e.tags || []).map(function (t) {
      return '<span class="pill accent">' + esc(t) + '</span>';
    }).join('');

    return '<article class="entry" data-id="' + esc(e.id) + '">' + photos +
      '<div class="entry-body">' +
        '<div class="entry-head"><span class="entry-date">' + fmtDate(e.date) + '</span>' +
        '<span class="tiny">' + esc(weekday(e.date)) + '</span>' +
        '<div class="meta" style="margin-left:auto">' + pills.join('') + '</div></div>' +
        (e.light ? '<div class="tiny" style="margin-bottom:10px">' + esc(e.light) + '</div>' : '') +
        (tags ? '<div class="meta" style="margin-bottom:10px">' + tags + '</div>' : '') +
        scoresHTML(e.scores) +
        zonesHTML(e.zones) +
        (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') +
      '</div></article>';
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

  function renderTimeline() {
    var host = $('#view-timeline');
    var list = newestFirst((state.data && state.data.entries) || []);
    if (!list.length) {
      host.innerHTML = '<div class="empty"><strong>还没有记录</strong>点下面的「记一条」开始。</div>';
      return;
    }
    host.innerHTML = '<div class="section-title">时间线</div>' +
      list.map(entryHTML).join('');
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
    var active = ml.filter(function (m) { return m.status !== 'resolved'; });
    var done = ml.filter(function (m) { return m.status === 'resolved'; });

    var card = function (m) {
      return '<div class="card mainline">' +
        '<h3>' + esc(m.key) + '</h3>' +
        '<div class="body">' + esc(m.summary) + '</div>' +
        (m.next ? '<div class="next">' + esc(m.next) + '</div>' : '') +
        '</div>';
    };

    host.innerHTML =
      '<div class="section-title">在跟的问题</div>' + active.map(card).join('') +
      (done.length ? '<div class="section-title">已排除</div>' + done.map(card).join('') : '');
  }

  /* ---- 记一条 ---- */

  function blankDraft() {
    var now = new Date();
    return {
      photos: [],
      date: todayISO(),
      slot: slotFromHour(now.getHours()),
      face: 'bare',
      kind: 'skin',
      light: '',
      scores: {},
      note: '',
      tags: [],
    };
  }

  var LIGHT_PRESETS = [
    '均匀正面光 · 素颜标准位',
    '室内暖光',
    '近距离侧光',
    '室外自然光',
    '棚灯正面光',
  ];

  function renderCompose() {
    var host = $('#view-compose');
    if (!state.draft) state.draft = blankDraft();
    var d = state.draft;

    host.innerHTML =
      '<div class="section-title">记一条</div>' +

      '<div class="field"><label>照片</label>' +
        '<div class="picker" id="picker"></div>' +
        '<div class="tiny hint">会自动压到长边 1600px 再上传。' +
        '同一次观察的多张（比如左右脸）放在一条里。</div>' +
      '</div>' +

      '<div class="field"><label>日期</label>' +
        '<input type="date" id="fDate" value="' + esc(d.date) + '">' +
        '<div class="tiny hint" id="dateHint"></div>' +
      '</div>' +

      '<div class="field"><label>时段</label>' +
        '<div class="segmented" id="fSlot">' +
        SLOT_ORDER.map(function (s) {
          return '<button data-v="' + s + '"' + (d.slot === s ? ' class="on"' : '') + '>' +
            SLOT[s] + '</button>';
        }).join('') + '</div></div>' +

      '<div class="field"><label>素颜还是带妆</label>' +
        '<div class="segmented" id="fFace">' +
        ['bare', 'makeup'].map(function (s) {
          return '<button data-v="' + s + '"' + (d.face === s ? ' class="on"' : '') + '>' +
            FACE[s] + '</button>';
        }).join('') + '</div>' +
        '<div class="tiny hint">带妆照判读不了色斑和泛红，只有素颜照能进对比。</div>' +
      '</div>' +

      '<div class="field"><label>光线条件</label>' +
        '<input type="text" id="fLight" placeholder="比如：窗边自然光，正面" value="' + esc(d.light) + '">' +
        '<div class="segmented" id="lightPresets" style="margin-top:8px">' +
        LIGHT_PRESETS.map(function (p) {
          return '<button data-v="' + esc(p) + '" style="flex:0 1 auto;font-size:12px;min-height:36px">' +
            esc(p) + '</button>';
        }).join('') + '</div>' +
      '</div>' +

      '<div class="field"><label>评分（没看清就别填）</label>' +
        '<div class="card" id="fScores"></div>' +
      '</div>' +

      '<div class="field"><label>备注</label>' +
        '<textarea id="fNote" placeholder="看到什么就写什么">' + esc(d.note) + '</textarea>' +
      '</div>' +

      '<div class="field"><label>标签（空格或逗号分隔）</label>' +
        '<input type="text" id="fTags" value="' + esc((d.tags || []).join(' ')) + '">' +
      '</div>' +

      '<div id="saveProgress" hidden><div class="progress"><i></i></div>' +
      '<div class="tiny" style="text-align:center;margin-top:6px" id="saveMsg"></div></div>' +

      '<button class="btn" id="saveBtn">保存</button>' +
      '<button class="btn ghost" id="resetBtn">清空重来</button>';

    drawPicker();
    drawRates();

    // 这两个容器在这次 renderCompose 里是固定的，监听器挂一次就够，
    // 内容重绘走 drawPicker / drawRates，不再动监听器。
    $('#picker', host).addEventListener('click', function (ev) {
      if (ev.target.closest('#addPhoto')) { $('#fileInput').click(); return; }
      var b = ev.target.closest('.del');
      if (!b) return;
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

    $('#fDate', host).addEventListener('change', function () { d.date = this.value; });
    $('#fLight', host).addEventListener('input', function () { d.light = this.value; });
    $('#fNote', host).addEventListener('input', function () { d.note = this.value; });
    $('#fTags', host).addEventListener('input', function () {
      d.tags = this.value.split(/[\s,，、]+/).filter(Boolean);
    });

    var seg = function (sel, key) {
      $(sel, host).addEventListener('click', function (ev) {
        var b = ev.target.closest('button');
        if (!b) return;
        d[key] = b.dataset.v;
        $$(sel + ' button', host).forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    };
    seg('#fSlot', 'slot');
    seg('#fFace', 'face');

    $('#lightPresets', host).addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      d.light = b.dataset.v;
      $('#fLight', host).value = d.light;
    });

    $('#saveBtn', host).addEventListener('click', saveDraft);
    $('#resetBtn', host).addEventListener('click', function () {
      if (!confirm('清空这条草稿？')) return;
      state.draft = blankDraft();
      renderCompose();
    });
  }

  function drawPicker() {
    var host = $('#picker');
    if (!host) return;
    var d = state.draft;
    // 只画内容。监听器在 renderCompose 里一次性挂在 #picker 上，
    // 放这里每重绘一次就会多挂一个，删除会连着触发好几次。
    host.innerHTML = d.photos.map(function (p, i) {
      return '<div class="slot"><img src="' + p.preview + '" alt="">' +
        '<button class="del" data-i="' + i + '" aria-label="删除">×</button></div>';
    }).join('') +
      '<button class="add" id="addPhoto"><span class="glyph">＋</span>加照片</button>';
  }

  function drawRates() {
    var host = $('#fScores');
    if (!host) return;
    var d = state.draft;
    host.innerHTML = dims().map(function (dim) {
      var v = d.scores[dim.key];
      var stars = '';
      for (var i = 1; i <= 5; i++) {
        stars += '<button data-k="' + dim.key + '" data-v="' + i + '" class="' +
          (v >= i ? 'on' : '') + '" aria-label="' + dim.label + ' ' + i + '">●</button>';
      }
      return '<div class="rate" title="' + esc(dim.hint) + '">' +
        '<span class="name">' + esc(dim.label) + '</span>' +
        '<span class="stars">' + stars + '</span>' +
        (v ? '<button class="clear" data-clear="' + dim.key + '">清除</button>' : '') +
        '</div>';
    }).join('');
    // 同样只画内容，监听器在 renderCompose 里挂一次
  }

  function onFilesPicked(files) {
    var d = state.draft;
    var jobs = Array.prototype.slice.call(files).map(function (f) {
      return processImage(f).then(function (p) { d.photos.push(p); })
        .catch(function (err) { toast(err.message, true); });
    });
    Promise.all(jobs).then(function () {
      drawPicker();
      // 第一张照片的拍摄时间自动填进日期，避免又记成"今天"
      var first = d.photos[0];
      if (first && first.takenAt) {
        var iso = first.takenAt.slice(0, 10);
        if (iso !== d.date) {
          d.date = iso;
          var inp = $('#fDate');
          if (inp) inp.value = iso;
          var hint = $('#dateHint');
          if (hint) hint.textContent = '已按第一张照片的拍摄时间填好，不对可以改。';
        }
      }
    });
  }

  function makeEntryId(date) {
    var base = date.replace(/-/g, '');
    var used = ((state.data && state.data.entries) || [])
      .filter(function (e) { return e.date === date; }).length;
    return base + '-' + String(used + 1).padStart(2, '0');
  }

  function saveDraft() {
    var d = state.draft;
    if (!d.date) return toast('先选日期', true);
    if (!d.photos.length && !d.note) return toast('至少加一张照片或写点备注', true);

    var btn = $('#saveBtn'), prog = $('#saveProgress'),
        bar = $('#saveProgress i'), msg = $('#saveMsg');
    btn.disabled = true;
    prog.hidden = false;
    bar.style.width = '15%';
    msg.textContent = '准备…';

    var id = makeEntryId(d.date);
    var files = [];
    var paths = [];

    d.photos.forEach(function (p, i) {
      var path = 'photos/' + id + '/' + String(i + 1).padStart(2, '0') + '.jpg';
      files.push({ path: path, blob: p.blob });
      paths.push(path);
    });

    var entry = {
      id: id, date: d.date, slot: d.slot, face: d.face, kind: d.kind,
      light: d.light, scores: d.scores, tags: d.tags, note: d.note,
      photos: paths,
    };

    var entries = ((state.data && state.data.entries) || []).slice();
    // 同 id 就替换，否则追加 —— 免得重复保存产生两条
    var at = entries.findIndex(function (x) { return x.id === id; });
    if (at >= 0) entries[at] = entry; else entries.push(entry);

    files.push({ path: 'entries.json', text: JSON.stringify(entries, null, 2) });

    bar.style.width = '40%';
    msg.textContent = '上传中（' + d.photos.length + ' 张照片）…';

    // 照片和 entries.json 在同一次提交里：要么全成，要么全不成，
    // 不会出现「照片传上去了但记录没写」这种半截状态。
    GitStore.commit(files, '记录 ' + d.date + '（' + id + '）')
      .then(function () {
        bar.style.width = '85%';
        msg.textContent = '刷新…';
        d.photos.forEach(function (p) { URL.revokeObjectURL(p.preview); });
        state.draft = null;
        return loadData();
      })
      .then(function () {
        bar.style.width = '100%';
        toast('已保存到云端');
        go('timeline');
      })
      .catch(function (err) {
        toast('保存失败：' + (err.message || err), true);
        btn.disabled = false;
        prog.hidden = true;
      });
  }

  function deleteEntry(id) {
    var entries = ((state.data && state.data.entries) || []);
    var e = entries.filter(function (x) { return x.id === id; })[0];
    if (!e) return Promise.reject(new Error('找不到这条记录'));

    var rest = entries.filter(function (x) { return x.id !== id; });

    // 先删照片文件，再写回不含它的 entries.json —— 同样是一次提交
    return GitStore.commitDelete(e.photos || [], '删除 ' + id + ' 的照片')
      .then(function () {
        return GitStore.commit(
          [{ path: 'entries.json', text: JSON.stringify(rest, null, 2) }],
          '删除记录 ' + id
        );
      })
      .then(function () { return loadData(); });
  }

  /* ================= 路由 ================= */

  var RENDER = {
    timeline: renderTimeline,
    trend: renderTrend,
    compose: renderCompose,
    mainlines: renderMainlines,
  };

  function go(view) {
    state.view = view;
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
    window.scrollTo(0, 0);
    (RENDER[view] || function () {})();
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

    $('#themeBtn').addEventListener('click', function () {
      var cur = get(LS.theme, 'light');
      applyTheme(THEMES[(THEMES.indexOf(cur) + 1) % THEMES.length]);
    });

    $('#refreshBtn').addEventListener('click', function () {
      loadData().then(function () { go(state.view); toast('已刷新'); })
        .catch(function (err) { toast(String(err.message || err), true); });
    });

    // 灯箱
    var lb = $('#lightbox');
    document.addEventListener('click', function (ev) {
      var img = ev.target.closest('.entry-photos img');
      if (img && img.src) { $('#lightbox img').src = img.src; lb.hidden = false; return; }
      if (ev.target.closest('#lightbox')) lb.hidden = true;
    });

    if (state.owner && state.repo && state.token) {
      showApp();
    } else {
      $('#gate').hidden = false;
      $('#gateRepo').value = (state.owner && state.repo)
        ? state.owner + '/' + state.repo
        : 'wang-piaoliang/prettier-data';
    }

    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(function () {});
    }
  }

  document.addEventListener('DOMContentLoaded', init);
})();
