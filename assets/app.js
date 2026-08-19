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


  /* 所有多行输入框都随内容长高。
     写长了看不见前面写过什么，很难接着写 —— 备注、评价、小结都一样。 */
  function autoGrow(root) {
    $$('textarea', root || document).forEach(function (t) {
      if (t.dataset.grow) return;
      t.dataset.grow = '1';
      var fit = function () {
        t.style.height = 'auto';
        t.style.height = Math.min(t.scrollHeight + 2, 460) + 'px';
      };
      t.addEventListener('input', fit);
      fit();
    });
  }

  function el(html) {
    // 这里造出来的框大多带 textarea，统一挂上自动长高
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
  /* 本地存了多少还没传上去 —— 必须显眼。
     数据只在这台手机上的时候，人得知道，不然会以为已经安全了。 */
  function renderPending() {
    var host = $('#pending');
    if (!host) return;
    var p = GitStore.pending();
    if (!p || !p.total) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    host.innerHTML =
      '<span class="ptxt">还有 <b>' + p.total + '</b> 项只存在这台手机上' +
      (p.photos ? '（' + p.photos + ' 张照片）' : '') + '</span>' +
      '<button type="button" id="syncNow">' +
      (state.token ? '立即上传' : '填令牌后上传') + '</button>';
    $('#syncNow').addEventListener('click', function () {
      if (!state.token) return go('settings');
      var b = this;
      b.disabled = true; b.textContent = '上传中…';
      GitStore.drain(function (t) { b.textContent = t + '…'; })
        .then(function () { return loadData(); })
        .then(function () { toast('已全部上传'); refresh(); })
        .catch(function (e) {
          toast('上传失败：' + (e.message || e), true);
          b.disabled = false; b.textContent = '重试上传';
        });
    });
  }

  function toast(msg, isErr) {
    var t = $('#toast');
    t.textContent = msg;
    t.className = isErr ? 'err' : '';
    t.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { t.hidden = true; }, isErr ? 9000 : 2200);
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
  }

  function syncDot(cls, title) {
    var d = $('#syncDot');
    if (d) { d.className = 'syncdot ' + (cls || ''); d.title = title || ''; }
  }

  /* ================= 云端（GitHub 私有仓库） ================= */

  function configureStore() {
    GitStore.configure({ owner: state.owner, repo: state.repo, token: state.token });
  }

  function seedFromCache() {
    try { return JSON.parse(get(LS.cache, '')) || null; } catch (e) { return null; }
  }

  /* 转本地：把上次同步下来的内容当底子，接着往下记。
     照片和记录先落 IndexedDB，等令牌恢复了再补传。 */
  function fallLocal(why) {
    return GitStore.goLocal(seedFromCache()).then(function () {
      return GitStore.head().then(GitStore.tree).then(function (t) {
        state.tree = {};
        (t.tree || []).forEach(function (n) { state.tree[n.path] = n.sha; });
        return Promise.all([
          GitStore.readJSON('settings.json'),
          GitStore.readJSON('entries.json'),
        ]);
      }).then(function (r) {
        var settings = r[0] || {};
        settings.entries = r[1] || [];
        state.data = settings;
        syncDot('off', why || '本地模式');
        renderPending();
        return settings;
      });
    });
  }

  function loadData() {
    syncDot('busy', '同步中');
    configureStore();

    if (!state.token) return fallLocal('本地模式 · 还没填令牌');

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
        renderPending();
        return settings;
      })
      .catch(function (err) {
        // 令牌不灵了：转本地接着用，别把人挡在门外
        if (err.status === 401 || err.status === 403) {
          return fallLocal('本地模式 · 令牌暂时不可用');
        }
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
  var photoExpand = {};   // 点过 +N 平铺的记录

  function entryHTML(e, showTime) {
    var keys = (e.photos || []).slice();
    // AI 判断出的最佳那张顶到最前，没有就按原顺序
    var best = e.ai && typeof e.ai.best === 'number' ? e.ai.best : -1;
    if (best > 0 && best < keys.length) {
      keys = [keys[best]].concat(keys.filter(function (_, i) { return i !== best; }));
    }

    var expanded = photoExpand[e.id];
    var shown = expanded ? keys : keys.slice(0, COVER_MAX);
    var hidden = keys.length - shown.length;

    var photos = !keys.length
      ? ''
      : '<div class="entry-photos n' + Math.min(shown.length, 4) +
        (expanded ? ' grid' : '') + '" data-id="' + esc(e.id) + '">' +
        shown.map(function (k, i) {
          var local = e._local && e._local[keys.indexOf(k)];
          return '<button class="ph" data-idx="' + i + '" type="button">' +
                 (local
                   ? '<img src="' + esc(local) + '" alt="" draggable="false">'
                   : '<img data-key="' + esc(k) + '" alt="" draggable="false">') +
                 (i === shown.length - 1 && hidden > 0
                   ? '<span class="more-chip">+' + hidden + '</span>' : '') +
                 '</button>';
        }).join('') + '</div>';

    var ov = overall(e);
    var pills = [];
    if (e.face) pills.push('<span class="pill">' + esc(FACE[e.face] || e.face) + '</span>');

    if (e.rating != null) {
      pills.push('<span class="pill ' + pillLevel(e.rating) + '">' + e.rating.toFixed(1) + '</span>');
    }
    if (ov != null) pills.push('<span class="pill ' + pillLevel(ov) + '">肤况 ' + ov.toFixed(1) + '</span>');
    if (e.makeup && typeof e.makeup.fit === 'number') {
      pills.push('<span class="pill ' + pillLevel(e.makeup.fit) + '">妆 ' + e.makeup.fit + '</span>');
    }
    if (e.ai) pills.push('<span class="pill accent">AI</span>');
    if (e._pending) pills.push('<span class="pill ok">上传中</span>');

    var tags = (e.tags || []).map(function (t) {
      return '<span class="pill accent">' + esc(t) + '</span>';
    }).join('');

    var prod = productsHTML(e);
    /* 素颜默认收起：时间线一拉全是素颜大图，在外面翻不合适。
       用的就是普通的折叠状态，不再做特例封面 —— 一种收起方式就够了。 */
    var folded = entryFold[e.id] === undefined ? (e.face === 'bare') : entryFold[e.id];

    /* 时间在照片【上面】：一屏里先看到「这是几点、什么状态」，
       再往下看照片，顺序才对。写在照片底下要先看完图才知道是哪次。 */
    return '<article class="entry' + (folded ? ' folded' : '') +
      (selectMode ? ' selectable' : '') +
      (cmpSel.indexOf(e.id) >= 0 ? ' picked' : '') +
      '" data-id="' + esc(e.id) + '">' +
      '<div class="entry-head top">' +
        (fmtTime(e.at)
          ? '<span class="entry-time"><span class="slot-name">' + esc(SLOT[slotOf(e)] || '') +
            '</span>' + fmtTime(e.at) + '</span>'
          : '') +
        '<div class="meta">' + pills.join('') + '</div>' +
        '<div class="entry-act">' +
          '<button data-del="' + esc(e.id) + '" aria-label="删除">🗑</button>' +
          '<button data-edit="' + esc(e.id) + '" aria-label="编辑">✎</button>' +
        '</div>' +
        (folded && keys.length ? '<span class="fold-n">' + keys.length + ' 张</span>' : '') +
      '</div>' +
      (folded ? '' : photos) +
      (folded ? '' : bodyWrap(
        scoresHTML(e.scores) +
        /* 卡片上只放【你自己写的】和事实数据：备注、用了什么产品、分数。
           AI 那些分区描述、光线说明、妆容点评一律不上卡片 ——
           那是它的观察笔记，不是你的记录。数据还在，需要时另说。 */
        ((prod || e.note || true)
          ? '<div class="entry-detail" id="dt-' + esc(e.id) + '">' +
              ratingRow(e) + prod + noteHTML(e) +
            '</div>'
          : '')
      )) + '</article>';
  }

  /* 没内容就整个不渲染。
     以前无条件套一层 .entry-body，素颜那种只有照片的记录
     底下会平白多出一块带内边距的白块，很难看。 */
  /* 每条记录单独折叠。整天折叠用 collapsedDays，这个是「这一组照片」。 */
  var entryFold = {};
  var prodOpen = {};
  var noteOpen = {};

  function bodyWrap(inner) {
    return inner && inner.trim()
      ? '<div class="entry-body">' + inner + '</div>'
      : '';
  }

  /* 上一次记了这类产品的那条记录。
     彩妆只跟带妆的比 —— 和素颜那条比没有意义。 */
  /* 和【前一天】比，不和今天早些时候比。
     同一天里补妆、再拍一张，用的当然是同一套产品 ——
     跟今天的上一次比，永远比不出东西来。
     真正有意义的是「今天和昨天换了什么」。 */
  function prevUsed(e, kind) {
    /* ⚠️ 要拿前一天【最后一条】记录来比。
       同一天常有好几条（早上、下午、晚上），只有晚上那条补了腮红的话，
       拿白天那条比，第二天就会把腮红判成「新用的」——
       它其实已经连着用好几天了。 */
    var all = ((state.data && state.data.entries) || []).filter(function (x) {
      if (!x.date || !e.date || x.date >= e.date) return false;
      if (kind === 'makeup' && x.face !== 'makeup') return false;
      var list = x.products && x.products[kind];
      return !!(list && list.length);
    }).sort(function (p, q) {
      var pa = (p.at || p.date), qa = (q.at || q.date);
      return pa < qa ? 1 : pa > qa ? -1 : 0;
    });
    if (!all.length) return null;

    var day = all[0].date;                       // 最近的有记录的那一天
    var sameDay = all.filter(function (x) { return x.date === day; });
    return sameDay[0].products[kind];            // 那天最晚的一条
  }

  /* 默认折叠：天天基本一样，全列出来是噪音。
     真正有信息量的是【和上次不一样的那几件】—— 标红，收起时也看得见。 */

  /* 备注默认折叠，和「用的产品」一套。
     收起时给一行摘要，知道里面有东西、值不值得点开。 */

  /* 这一组照片本身也能打个分：今天这个状态几分。
     和产品评分、护肤记录用同一个滑条，一处学会处处一样。 */
  function ratingRow(e) {
    var v = e.rating;
    return '<button class="prod-fold rating-row" type="button" data-rate="' + esc(e.id) + '">' +
      '<b>评分</b><span class="pf-sum">' +
      (v == null ? '点一下打分' : v.toFixed(1) + ' / 5') + '</span>' +
      '<span class="ml-caret" style="transform:none">✎</span>' +
    '</button>';
  }

  function openEntryRating(id, anchor) {
    if (anchor.parentNode.querySelector('.inline-edit')) return;
    var e = ((state.data && state.data.entries) || [])
      .filter(function (x) { return x.id === id; })[0];
    if (!e) return;
    var v = e.rating == null ? 3 : e.rating;
    var box = el(
      '<div class="inline-edit">' +
        '<div class="score-row">' +
          '<span class="score-val">' + v.toFixed(1) + '</span>' +
          '<input type="range" min="0" max="5" step="0.1" value="' + v + '">' +
        '</div>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          (e.rating != null
            ? '<button class="ie-cancel" id="rate-clear" type="button">清除</button>' : '') +
          '<button class="ie-ok" type="button">记下</button>' +
        '</div>' +
      '</div>'
    );
    anchor.insertAdjacentElement('afterend', box);
    var range = box.querySelector('input');
    var val = box.querySelector('.score-val');
    range.addEventListener('input', function () { val.textContent = Number(this.value).toFixed(1); });
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    var clr = box.querySelector('#rate-clear');
    if (clr) clr.addEventListener('click', function () { box.remove(); saveEntryRating(id, null); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var n = Number(range.value);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      saveEntryRating(id, n);
    });
  }

  function saveEntryRating(id, score) {
    var list = ((state.data && state.data.entries) || []).map(function (x) {
      if (x.id !== id) return x;
      var y = Object.assign({}, x);
      if (score == null) delete y.rating; else y.rating = score;
      return y;
    });
    if (state.data) state.data.entries = list;   // 先本地生效
    redrawTimeline();

    GitStore.updateJSON('entries.json', function (remote) {
      return (remote || []).map(function (x) {
        if (x.id !== id) return x;
        var y = Object.assign({}, x);
        if (score == null) delete y.rating; else y.rating = score;
        return y;
      });
    }, score == null ? '清除评分' : '打分 ' + score.toFixed(1))
      .catch(function (err) { toast('保存失败：' + (err.message || err), true); });
  }

  function noteHTML(e) {
    if (!e.note) return '';
    var open = !!noteOpen[e.id];
    var oneLine = String(e.note).replace(/\s+/g, ' ').trim();
    return '<div class="note-fold' + (open ? ' open' : '') + '">' +
      '<button class="prod-fold" type="button" data-note-open="' + esc(e.id) + '">' +
        '<b>备注</b><span class="pf-sum">' + esc(open ? '' : oneLine) + '</span>' +
        '<span class="ml-caret">▾</span>' +
      '</button>' +
      (open ? '<div class="note">' + esc(e.note) + '</div>' : '') +
    '</div>';
  }

  function productsHTML(e) {
    var p = e.products;
    if (!p) return '';
    var open = !!prodOpen[e.id];
    var parts = [], changedAll = [];

    // 素颜没上妆，就别列彩妆 —— 那多半是沿用上一条带进来的
    var groups = e.face === 'bare'
      ? [{ k: 'skincare', label: '护肤' }]
      : [{ k: 'skincare', label: '护肤' }, { k: 'makeup', label: '彩妆' }];
    groups.forEach(function (g) {
      var list = p[g.k] || [];
      if (!list.length) return;
      var prev = (prevUsed(e, g.k) || []).map(prodKey);
      var isNew = function (n) { return prev.length ? prev.indexOf(prodKey(n)) < 0 : false; };
      list.forEach(function (n) { if (isNew(n)) changedAll.push(prodLabel(n)); });
      parts.push('<div class="prow"><b>' + g.label + '</b><span>' +
        list.map(function (n) {
          return isNew(n)
            ? '<em class="p-new">' + esc(prodLabel(n)) + '</em>'
            : esc(prodLabel(n));
        }).join(' · ') + '</span></div>');
    });
    if (!parts.length) return '';

    var n = (p.skincare || []).length + (p.makeup || []).length;
    var head = '<button class="prod-fold" type="button" data-prod-open="' + esc(e.id) + '">' +
      '<b>用的产品</b><span class="pf-sum">' +
      (changedAll.length
        ? '<em class="p-new">' + changedAll.map(esc).join(' · ') + '</em>'
        : n + ' 件') +
      '</span><span class="ml-caret">▾</span></button>';

    return '<div class="products' + (open ? ' open' : '') + '">' + head +
      (open ? parts.join('') : '') + '</div>';
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
  function chartSVG(entries, dimKey) {   // entries: [{date, scores}]
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

    var notes = (state.data && state.data.dayNotes) || {};

    host.innerHTML =

      days.map(function (d) {
        var closed = collapsedDays[d.date];
        var n = d.rows.length;
        var photos = d.rows.reduce(function (a, e) { return a + (e.photos || []).length; }, 0);
        return '<section class="day' + (closed ? ' closed' : '') + '" data-date="' + esc(d.date) + '">' +
          /* 折叠和「在这天记一条」是两个动作，得是两个按钮。
             按钮里不能再套按钮，所以外面用 div 兜住。 */
          '<div class="day-head">' +
            '<button class="dh-main" type="button" data-fold="' + esc(d.date) + '">' +
              '<span class="day-date">' + fmtDate(d.date) + '</span>' +
              '<span class="day-week">' + esc(weekday(d.date)) + '</span>' +
              '<span class="day-count">' + (n > 1 ? n + ' 次 · ' : '') + photos + ' 张</span>' +
              '<span class="ml-caret">▾</span>' +
            '</button>' +
            '<button class="dh-add" type="button" data-add-day="' + esc(d.date) + '" ' +
              'aria-label="在这天记一条">＋</button>' +
          '</div>' +
          '<div class="day-body"' + (closed ? ' hidden' : '') + '>' +
            (notes[d.date]
              ? '<div class="day-note" data-note="' + esc(d.date) + '">' +
                esc(notes[d.date]) + '</div>'
              : '<button class="day-note-btn" data-note="' + esc(d.date) + '" type="button">' +
                '＋ 写一句今天的小结</button>') +
            d.rows.map(function (e) { return entryHTML(e); }).join('') +
          '</div>' +
        '</section>';
      }).join('');

    host.insertAdjacentHTML('afterbegin', cmpBar());

    hydratePhotos(host);
    bindTimelineDrag(host);

    if (!host.dataset.bound) {
      host.dataset.bound = '1';
      bindTimeline(host);
    }
  }


  /* 折叠、选中这类操作会整页重画，浏览器把滚动位置归零，
     人就被弹到列表顶上去了。重画前后把滚动位置接回来。 */
  // go() 现在自己会保持滚动位置，这里只是个名字更明确的入口
  function redrawTimeline() { go('timeline'); }

  function bindTimeline(host) {
    host.addEventListener('click', function (ev) {
      var ad = ev.target.closest('[data-add-day]');
      if (ad) return startEntryOn(ad.dataset.addDay);
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
      if (ev.target.closest('#openTrend')) { go('trend'); return; }

      var nt = ev.target.closest('[data-note]');
      if (nt) return openDayNoteEditor(nt.dataset.note, nt);


      var hd = ev.target.closest('[data-hide]');
      if (hd) return collapseEntry(hd.dataset.hide);

      /* 点抬头那一行收起/展开这一组照片。
         .entry-act 里是删除和编辑，得先让开，否则点删除会变成折叠。 */
      var cp = ev.target.closest('[data-cmp]');
      if (cp) return toggleCompare(cp.dataset.cmp);
      if (ev.target.closest('#cmpGo')) return renderCompare();
      if (ev.target.closest('#cmpClear')) { cmpSel = []; selectMode = false; syncTopBtn(); return redrawTimeline(); }

      var rt = ev.target.closest('[data-rate]');
      if (rt) return openEntryRating(rt.dataset.rate, rt);
      var no = ev.target.closest('[data-note-open]');
      if (no) {
        var nid = no.dataset.noteOpen;
        noteOpen[nid] = !noteOpen[nid];
        redrawTimeline();
        return;
      }

      var po = ev.target.closest('[data-prod-open]');
      if (po) {
        var pid2 = po.dataset.prodOpen;
        prodOpen[pid2] = !prodOpen[pid2];
        redrawTimeline();
        return;
      }

      var eh = ev.target.closest('.entry-head.top');
      if (eh && !ev.target.closest('.entry-act')) {
        var eid = eh.closest('.entry').dataset.id;
        // 选择模式下点抬头是「选中来对比」，平时才是折叠
        if (selectMode) return toggleCompare(eid);
        entryFold[eid] = !entryFold[eid];
        redrawTimeline();
        return;
      }

      /* 展开之后，点卡片里任何「不是按钮」的地方都收起。
         照片、编辑、删除、详情这些本来就有自己的行为，不能被抢。 */
      var card = ev.target.closest('.entry');
      if (card && !ev.target.closest('button') && !document.body.classList.contains('no-scroll')) {
        var cid = card.dataset.id;
        if (photoExpand[cid]) return collapseEntry(cid);
      }

      // 点 +N 直接在页面里平铺全部，不进灯箱
      var mc = ev.target.closest('.more-chip');
      if (mc) {
        photoExpand[mc.closest('.entry').dataset.id] = true;
        redrawTimeline();
        return;
      }

      var dt = ev.target.closest('[data-detail]');
      if (dt) {
        var box = document.getElementById('dt-' + dt.dataset.detail);
        if (box) { box.hidden = !box.hidden; dt.classList.toggle('open', !box.hidden); }
        return;
      }
      var ed = ev.target.closest('[data-edit]');
      if (ed) return editEntry(ed.dataset.edit);
      var dl = ev.target.closest('[data-del]');
      if (dl) return deleteEntry(dl.dataset.del);
    });
  }

  /* 页内编辑，不弹窗 —— 弹窗在装成 PWA 的 iOS 上又丑又难用 */
  /* 时间线上的照片也能长按拖拽排序。
     功能就该长在手会伸过去的位置 —— 人自然会在看到照片的地方直接拖。
     和编辑态选择器的区别：这里改完要提交到云端，所以松手才写。 */
  function bindTimelineDrag(host) {
    if (host.dataset.tlDrag) return;
    host.dataset.tlDrag = '1';

    var timer = null, from = null, wrap = null, rects = null, moved = false;
    var sx = 0, sy = 0;

    function measure() {
      rects = $$('.ph', wrap).map(function (n) {
        var r = n.getBoundingClientRect();
        return { idx: Number(n.dataset.idx), cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      });
    }

    function nearest(x, y) {
      var best = null, bd = Infinity;
      rects.forEach(function (r) {
        var d2 = (r.cx - x) * (r.cx - x) + (r.cy - y) * (r.cy - y);
        if (d2 < bd) { bd = d2; best = r.idx; }
      });
      return best;
    }

    function end() {
      clearTimeout(timer);
      timer = null;
      document.body.classList.remove('no-scroll');
      if (wrap) wrap.classList.remove('dragmode');
      $$('.ph.dragging', host).forEach(function (n) { n.classList.remove('dragging'); });
      if (moved && wrap) savePhotoOrder(wrap.dataset.id);
      from = null; wrap = null; rects = null; moved = false;
    }

    host.addEventListener('touchstart', function (ev) {
      var ph = ev.target.closest('.entry-photos .ph');
      if (!ph) return;
      var t = ev.touches[0];
      sx = t.clientX; sy = t.clientY;
      timer = setTimeout(function () {
        from = Number(ph.dataset.idx);
        wrap = ph.closest('.entry-photos');
        measure();
        ph.classList.add('dragging');
        wrap.classList.add('dragmode');
        document.body.classList.add('no-scroll');
        if (navigator.vibrate) navigator.vibrate(12);
      }, 380);
    }, { passive: true });

    host.addEventListener('touchmove', function (ev) {
      var t = ev.touches[0];
      if (from === null) {
        // 手指按住必然有微动，超过 12px 才当成想滚页面
        if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) {
          clearTimeout(timer); timer = null;
        }
        return;
      }
      ev.preventDefault();
      var to = nearest(t.clientX, t.clientY);
      if (to === null || to === from) return;

      var A = wrap.querySelector('.ph[data-idx="' + from + '"]');
      var B = wrap.querySelector('.ph[data-idx="' + to + '"]');
      if (!A || !B) return;

      var mark = document.createElement('span');
      A.parentNode.insertBefore(mark, A);
      B.parentNode.insertBefore(A, B);
      mark.parentNode.insertBefore(B, mark);
      mark.remove();
      A.dataset.idx = to; B.dataset.idx = from;
      from = to;
      moved = true;
      measure();
    }, { passive: false });

    host.addEventListener('touchend', end, { passive: true });
    host.addEventListener('touchcancel', end, { passive: true });
  }

  function savePhotoOrder(entryId) {
    var wrap = $('.entry-photos[data-id="' + entryId + '"]');
    if (!wrap) return;
    var order = $$('.ph img', wrap).map(function (i) { return i.dataset.key; }).filter(Boolean);
    if (!order.length) return;

    var e = ((state.data && state.data.entries) || [])
      .filter(function (x) { return x.id === entryId; })[0];
    if (!e) return;

    // 只展开了一部分时，没露面的那些按原顺序接在后面
    var rest = (e.photos || []).filter(function (p) { return order.indexOf(p) < 0; });
    var next = order.concat(rest);
    if (JSON.stringify(next) === JSON.stringify(e.photos)) return;

    e.photos = next;      // 先本地生效，界面立刻是新顺序
    delete e.ai;          // 手动排过序，AI 挑的封面作废

    GitStore.updateJSON('entries.json', function (remote) {
      return (remote || []).map(function (x) {
        return x.id === entryId ? Object.assign({}, x, { photos: next }) : x;
      });
    }, '调整 ' + entryId + ' 的照片顺序')
      .then(loadData).then(function () { refresh('timeline'); })
      .catch(function (err) { toast('顺序没存上：' + (err.message || err), true); });
  }

  function collapseEntry(id) {
    delete photoExpand[id];
    refresh('timeline');
  }

  function openDayNoteEditor(date, anchor) {
    if (document.getElementById('dn-edit')) return;
    var cur = ((state.data && state.data.dayNotes) || {})[date] || '';
    var box = el(
      '<div class="inline-edit" id="dn-edit">' +
        '<textarea id="dn-text" placeholder="今天的小结">' + esc(cur) + '</textarea>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">保存</button>' +
        '</div>' +
      '</div>'
    );
    anchor.replaceWith(box);
    var ta = box.querySelector('#dn-text');
    ta.focus();
    box.querySelector('.ie-cancel').addEventListener('click', function () {
      box.remove();
      go('timeline');
    });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var v = ta.value;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      saveDayNote(date, v);
    });
  }

  function saveDayNote(date, value) {
    var notes = Object.assign({}, (state.data && state.data.dayNotes) || {});
    var v = String(value || '').trim();
    if (v) notes[date] = v; else delete notes[date];

    var conf = Object.assign({}, state.data);
    delete conf.entries;
    conf.dayNotes = notes;

    // 先本地生效再提交，不让人对着转圈等
    if (state.data) state.data.dayNotes = notes;
    refresh('timeline');
    GitStore.updateJSON('settings.json', function (remote) {
      var base = remote || {};
      base.dayNotes = notes;
      return base;
    }, '小结 ' + date).then(loadData).then(function () {
      refresh('timeline');
    }).catch(function (e) { toast('小结没存上：' + (e.message || e), true); });
  }

  /* 趋势按【月】走，不按每条记录。
     日常那些带妆的、近距离的、光线各异的照片放一起比毫无意义 ——
     只有把同一个月的素颜照凑成一批、在同一次判读里比较，分数才可比。
     所以每月只评一次。 */

  function monthOf(e) { return String(e.date || '').slice(0, 7); }

  function bareOfMonth(ym) {
    return ((state.data && state.data.entries) || []).filter(function (e) {
      return monthOf(e) === ym && e.face === 'bare' && (e.photos || []).length;
    });
  }

  function renderTrend() {
    var host = $('#view-trend');
    var monthly = (state.data && state.data.monthly) || {};
    var keys = Object.keys(monthly).sort();
    var thisMonth = todayISO().slice(0, 7);
    var bare = bareOfMonth(thisMonth);

    var chart = keys.length >= 2
      ? chartSVG(keys.map(function (k) {
          return { date: k + '-15', scores: monthly[k].scores };
        }), '__all')
      : '<div class="empty">' +
        (keys.length === 1
          ? '只有一个月的评分（' + keys[0] + '：' +
            (monthly[keys[0]].overall || 0).toFixed(1) + '），下个月就有趋势线了。'
          : '还没有月度评分。') + '</div>';

    host.innerHTML =
      '<div class="section-title">月度趋势</div>' +
      '<div class="card">' + chart + '</div>' +

      '<div class="section-title">' + thisMonth + '</div>' +
      '<div class="card">' +
        '<div class="tiny" style="margin-bottom:12px">' +
          '本月素颜照 ' + bare.length + ' 条' +
          (monthly[thisMonth] ? '　·　已评：' + monthly[thisMonth].overall.toFixed(1) : '') +
        '</div>' +
        (bare.length
          ? '<button class="btn ghost" id="evalMonth" type="button">' +
              (monthly[thisMonth] ? '重新评这个月' : '让 AI 评这个月') +
            '</button>'
          : '<div class="tiny">这个月还没有素颜照。带妆照判读不了色斑，进不了趋势。</div>') +
        '<div id="evalOut"></div>' +
      '</div>' +

      (keys.length
        ? '<div class="section-title">历月</div>' +
          keys.slice().reverse().map(function (k) {
            var m = monthly[k];
            return '<div class="card" style="margin-bottom:10px">' +
              '<div class="entry-head" style="border:none;margin:0;padding:0">' +
                '<span class="entry-date">' + esc(k) + '</span>' +
                '<span class="pill ' + pillLevel(m.overall) + '" style="margin-left:auto">' +
                  m.overall.toFixed(1) + '</span>' +
              '</div>' +
              scoresHTML(m.scores) +
              (m.summary ? '<div class="note">' + esc(m.summary) + '</div>' : '') +
            '</div>';
          }).join('')
        : '');

    var btn = $('#evalMonth', host);
    if (btn) btn.addEventListener('click', function () { evalMonth(thisMonth); });
  }

  function evalMonth(ym) {
    if (!ensureKey()) return;
    var rows = bareOfMonth(ym);
    if (!rows.length) return toast('这个月没有素颜照', true);

    var btn = $('#evalMonth'), out = $('#evalOut');
    btn.disabled = true;
    btn.textContent = '取照片…';

    // 每条记录取第一张，最多 4 张 —— 再多模型容易串台
    var picks = rows.map(function (e) { return e.photos[0]; }).slice(0, 4);

    picks.reduce(function (chain, p) {
      return chain.then(function (acc) {
        return photoURL(p).then(function (u) { return fetch(u); })
          .then(function (r) { return r.blob(); })
          .then(function (b) { return acc.concat([b]); });
      });
    }, Promise.resolve([])).then(function (blobs) {
      btn.textContent = 'AI 判读中…';
      var S = state.data || {};
      return PrettierAI.analyze(blobs, {
        face: 'bare',
        light: '本月各次素颜记录，光线不完全一致',
        slotLabel: ym + ' 全月',
        dimensions: S.dimensions || [],
        makeupDimensions: [],
        mirrored: true,
        background: (S.mainlines || []).map(function (m) {
          return '· ' + m.key + (m.area ? '（' + m.area + '）' : '');
        }).join('\n'),
      });
    }).then(function (r) {
      var vals = Object.keys(r.scores || {}).map(function (k) { return r.scores[k]; });
      if (!vals.length) throw new Error('AI 没能给出可用的分数');
      var overall = vals.reduce(function (x, y) { return x + y; }, 0) / vals.length;

      var conf = Object.assign({}, state.data);
      delete conf.entries;
      conf.monthly = Object.assign({}, conf.monthly);
      conf.monthly[ym] = {
        scores: r.scores, overall: overall, summary: r.summary || '',
        photos: picks.length, model: r.model, at: r.at,
      };
      return GitStore.commit(
        [{ path: 'settings.json', text: JSON.stringify(conf, null, 2) }],
        '月度评分 ' + ym
      );
    }).then(loadData).then(function () {
      toast('已记下这个月');
      go('trend');
    }).catch(function (e) {
      toast('失败：' + (e.message || e), true);
      btn.disabled = false;
      btn.textContent = '重试';
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

    /* 顺序按看的频率来：体重每天称、护肤记录常写、
       「在跟的问题」是长期背景，放最后。 */
    host.innerHTML =
      weightHTML() + careHTML() +
      foldSection('ml', '在跟的问题', ml.map(card).join('')) +
      procedureHTML();

    if (!host.dataset.bound) {
      host.dataset.bound = '1';
      host.addEventListener('click', function (ev) {
        var am = ev.target.closest('#addMask');
        if (am) return openCareEditor(am.closest('.care-add'), 'mask');
        var ae = ev.target.closest('#addEvent');
        if (ae) return openCareEditor(ae.closest('.care-add'), 'event');
        var ce = ev.target.closest('[data-c-edit]');
        if (ce) return openCareEditor(ce.closest('.care-row'), null, ce.dataset.cEdit);
        var cx = ev.target.closest('[data-c-del]');
        if (cx) return deleteCare(cx.dataset.cDel);

        var mf = ev.target.closest('[data-mlfold]');
        if (mf) {
          var fk = mf.dataset.mlfold;
          mlFold[fk] = !mlFold[fk];
          mf.classList.toggle('closed', mlFold[fk]);
          mf.nextElementSibling.hidden = mlFold[fk];
          return;
        }
        var mm = ev.target.closest('[data-mlmore]');
        if (mm) {
          var mk = 'more:' + mm.dataset.mlmore;
          mlFold[mk] = !mlFold[mk];
          return refresh('mainlines');
        }

        var aw = ev.target.closest('#addWeight');
        if (aw) return openWeightEditor(aw);
        var we = ev.target.closest('[data-w-edit]');
        if (we) return openWeightEditor(we.closest('.w-row'), we.dataset.wEdit);
        var wx = ev.target.closest('[data-w-del]');
        if (wx) return deleteWeight(wx.dataset.wDel);
        var h = ev.target.closest('.ml-head');
        if (!h) return;
        var body = h.nextElementSibling;
        var open = !body.hidden;
        body.hidden = open;
        h.setAttribute('aria-expanded', String(!open));
        h.classList.toggle('open', !open);
      });
    }
  }

  /* 体重单独一区。
     对这份档案它不是附带信息 —— 眶周脂肪垫薄是泪沟的主因，
     而排除注射之后，增重是唯一能补回体积的途径，所以值得单独跟。 */

  /* ================= 护肤记录 =================
     两类东西记在一起，因为它们回答的是同一个问题：
     「最近皮肤变化，是什么带来的？」

       · 敷了什么 —— 从面膜/唇膜/眼膜里选，打分，可以反复打
       · 做了什么 —— 吃烤肉、熬夜、运动…… 这些也会写在脸上

     所以不分成两个列表，按时间混排 —— 翻的时候才看得出前后因果。 */


  /* 主线上这几块都能点标题折叠，默认只露最近 5 条。
     不加箭头图标 —— 标题本身就是开关，多一个 icon 只是噪音。 */
  var mlFold = {};

  function foldSection(key, title, body, n) {
    var closed = !!mlFold[key];
    return '<div class="section-title fold' + (closed ? ' closed' : '') + '" ' +
        'data-mlfold="' + esc(key) + '">' + esc(title) +
        (n ? '<i>' + n + '</i>' : '') + '</div>' +
      '<div class="ml-sec"' + (closed ? ' hidden' : '') + '>' + body + '</div>';
  }

  /* 只给最近 N 条，剩下的收在「还有 M 条」后面。
     翻档案是从近往远翻，一上来就把两年的东西全铺开没有意义。 */
  function limitRows(key, rows, n) {
    n = n || 5;
    if (rows.length <= n) return rows.join('');
    var open = !!mlFold['more:' + key];
    return (open ? rows : rows.slice(0, n)).join('') +
      '<button class="more-toggle" type="button" data-mlmore="' + esc(key) + '">' +
        (open ? '收起' : '还有 ' + (rows.length - n) + ' 条') + '</button>';
  }

  function careList() {
    return ((state.data && state.data.careLog) || []).slice()
      .sort(function (x, y) { return (x.at || '') < (y.at || '') ? 1 : -1; });
  }

  // 能敷的：面膜、唇膜、眼膜
  function maskProducts() {
    return allProducts().filter(function (p) {
      if (p.status === 'retired') return false;
      var hay = (p.category || '') + ' ' + (p.name || '') + ' ' + (p.short || '');
      return /面膜|眼膜|唇膜/.test(hay);
    });
  }

  function careTitle(c) {
    if (c.pid) return prodLabel(c.pid) + (c.variant ? ' · ' + c.variant : '');
    return c.what || '';
  }

  function careHTML() {
    /* 两行排版：手机上一行塞不下「日期+名称+分数+备注+两个按钮」，
       挤在一行的结果是名称被备注顶没了。 */
    var rows = careList().map(function (c) {
      return '<div class="care-row" data-cid="' + esc(c.id) + '">' +
        '<div class="cr-top">' +
          '<b>' + esc(fmtDate((c.at || '').slice(0, 10))) + '</b>' +
          '<span class="care-what">' + esc(careTitle(c)) + '</span>' +
          (c.score != null
            ? '<span class="pill ' + pillLevel(c.score) + '">' + c.score.toFixed(1) + '</span>'
            : '') +
          '<button class="rv-edit" data-c-edit="' + esc(c.id) + '" aria-label="改">✎</button>' +
          '<button class="rv-edit" data-c-del="' + esc(c.id) + '" aria-label="删">×</button>' +
        '</div>' +
        (c.note ? '<div class="cr-note">' + esc(c.note) + '</div>' : '') +
      '</div>';
    });

    return foldSection('care', '护肤记录', '<div class="card" id="careCard">' +
        '<div class="care-add">' +
          '<button class="more-toggle" id="addMask" type="button">＋ 敷了什么</button>' +
          '<button class="more-toggle" id="addEvent" type="button">＋ 做了什么</button>' +
        '</div>' +
        (rows.length ? '<div class="w-list">' + limitRows('care', rows) + '</div>'
              : '<div class="tiny">敷了面膜、或者吃了什么做了什么，都可以记在这儿。</div>') +
      '</div>');
  }

  function openCareEditor(anchor, kind, editId) {
    if (document.getElementById('c-edit')) return;
    var cur = editId
      ? careList().filter(function (x) { return x.id === editId; })[0]
      : null;
    if (cur) kind = cur.pid ? 'mask' : 'event';

    var masks = maskProducts();
    var sel = { pid: cur && cur.pid ? cur.pid : (masks[0] ? masks[0].id : ''),
                variant: (cur && cur.variant) || '',
                score: cur && cur.score != null ? cur.score : null };

    /* 点选，不用下拉 —— 和记皮肤那边一套交互。
       下拉在手机上要点两次、还遮住半屏，选个面膜不该这么费劲。 */
    var chipsHTML = function () {
      var p = prodById(sel.pid);
      var vs = p ? variantList(p) : [];
      return '<div class="pick" id="c-pick">' +
        masks.map(function (m) {
          return '<button type="button" class="pchip' + (m.id === sel.pid ? ' on' : '') +
            '" data-cpid="' + esc(m.id) + '">' + esc(shortName(m)) + '</button>';
        }).join('') + '</div>' +
        (vs.length
          ? '<div class="pick" id="c-vpick" style="margin-top:6px">' +
            vs.map(function (v) {
              return '<button type="button" class="pchip vsub' +
                (v === sel.variant ? ' on' : '') + '" data-cvar="' + esc(v) + '">' +
                esc(v) + '</button>';
            }).join('') + '</div>'
          : '');
    };

    /* 评分用滑条，和产品评分一模一样 —— 同一个动作就该是同一个控件。
       之前那排小圆点在这儿显得很突兀，也点不出 4.2 这种。 */
    var scoreHTML = function () {
      var v = sel.score == null ? 3 : sel.score;
      return '<div class="score-row">' +
        '<span class="score-val">' + v.toFixed(1) + '</span>' +
        '<input type="range" id="c-range" min="0" max="5" step="0.1" value="' + v + '">' +
      '</div>';
    };

    var box = el(
      '<div class="inline-edit" id="c-edit">' +
        (kind === 'mask'
          ? (masks.length
              ? '<div id="c-chips">' + chipsHTML() + '</div>'
              : '<div class="tiny">产品库里还没有面膜/眼膜/唇膜</div>')
          : '<input type="text" id="c-what" placeholder="吃了 / 做了什么，例：吃烤肉、熬夜、做了光子"' +
            (cur && cur.what ? ' value="' + esc(cur.what) + '"' : '') + '>') +
        '<div class="w-form" style="margin-top:8px">' +
          '<input type="date" id="c-date" value="' +
            (cur ? (cur.at || '').slice(0, 10) : todayISO()) + '">' +
        '</div>' +
        '<div id="c-scorebox" style="margin-top:8px">' + scoreHTML() + '</div>' +
        '<input type="text" id="c-note" placeholder="备注：什么感觉、之后皮肤怎么样" style="margin-top:8px"' +
          (cur && cur.note ? ' value="' + esc(cur.note) + '"' : '') + '>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">记下</button>' +
        '</div>' +
      '</div>'
    );
    anchor.replaceWith(box);

    var chipHost = box.querySelector('#c-chips');
    if (chipHost) {
      chipHost.addEventListener('click', function (ev) {
        var pb = ev.target.closest('[data-cpid]');
        if (pb) { sel.pid = pb.dataset.cpid; sel.variant = ''; chipHost.innerHTML = chipsHTML(); return; }
        var vb = ev.target.closest('[data-cvar]');
        if (vb) {
          sel.variant = (sel.variant === vb.dataset.cvar) ? '' : vb.dataset.cvar;
          chipHost.innerHTML = chipsHTML();
        }
      });
    }

    var scoreHost = box.querySelector('#c-scorebox');
    var cRange = scoreHost.querySelector('#c-range');
    var cVal = scoreHost.querySelector('.score-val');
    if (sel.score == null) sel.score = 3;
    cRange.addEventListener('input', function () {
      sel.score = Number(this.value);
      cVal.textContent = sel.score.toFixed(1);
    });

    box.querySelector('.ie-cancel').addEventListener('click', function () {
      box.remove();
      go('mainlines');
    });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var score = sel.score;
      var date = box.querySelector('#c-date').value || todayISO();
      var rec = {
        id: cur ? cur.id : 'c' + Date.now().toString(36),
        // 存到分钟：同一天敷两次也分得清先后
        at: date + 'T' + (cur ? (cur.at || '').slice(11, 16) || '12:00' : nowLocal().slice(11, 16)),
        note: box.querySelector('#c-note').value.trim() || undefined,
      };
      if (score != null) rec.score = Math.round(score * 10) / 10;

      if (kind === 'mask') {
        if (!sel.pid) return toast('先选一个产品', true);
        rec.pid = sel.pid;
        if (sel.variant) rec.variant = sel.variant;
      } else {
        var what = box.querySelector('#c-what').value.trim();
        if (!what) return toast('写一下做了什么', true);
        rec.what = what;
      }

      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      saveCare(rec);
    });
  }

  function saveCare(rec) {
    var list = ((state.data && state.data.careLog) || [])
      .filter(function (x) { return x.id !== rec.id; })
      .concat([rec]);
    persistCare(list, '护肤记录：' + careTitle(rec));
  }

  function deleteCare(id) {
    var c = careList().filter(function (x) { return x.id === id; })[0];
    if (!c || !confirm('删掉「' + careTitle(c) + '」这条？')) return;
    persistCare(careList().filter(function (x) { return x.id !== id; }),
                '护肤记录：删除 ' + careTitle(c));
  }

  function persistCare(list, msg) {
    // 先本地生效，不让人对着转圈等
    if (state.data) state.data.careLog = list;
    refresh('mainlines');
    return GitStore.updateJSON('settings.json', function (remote) {
      var base = remote || {};
      base.careLog = list;
      return base;
    }, msg).catch(function (e) { toast('保存失败：' + (e.message || e), true); });
  }

  function weightHTML() {
    var ws = ((state.data && state.data.weights) || []).slice()
      .sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    var p = (state.data && state.data.profile) || {};
    var h = p.height;

    var last = ws[ws.length - 1];
    var first = ws[0];
    var delta = (last && first && ws.length > 1) ? (last.kg - first.kg) : null;
    var bmi = (last && h) ? (last.kg / Math.pow(h / 100, 2)) : null;

    var chart = ws.length >= 2
      ? weightChart(ws)
      : '';

    var rows = ws.slice().reverse().map(function (w) {
      return '<div class="w-row" data-wd="' + esc(w.date) + '">' +
        '<b>' + esc(fmtDate(w.date)) + '</b>' +
        '<span>' + (w.kg * 2).toFixed(1) + ' 斤</span>' +
        (w.note ? '<i>' + esc(w.note) + '</i>' : '') +
        '<button class="rv-edit" data-w-edit="' + esc(w.date) + '" aria-label="改">✎</button>' +
        '<button class="rv-edit" data-w-del="' + esc(w.date) + '" aria-label="删">×</button>' +
      '</div>';
    });

    return foldSection('w', '体重', '<div class="card" id="weightCard">' +
        (last
          ? '<div class="w-now">' +
              '<span class="w-kg">' + (last.kg * 2).toFixed(1) + '<i>斤</i></span>' +
              (bmi ? '<span class="pill">BMI ' + bmi.toFixed(1) + '</span>' : '') +
              (delta != null
                ? '<span class="pill ' + (delta > 0 ? 'good' : delta < 0 ? 'watch' : '') + '">' +
                  (delta > 0 ? '+' : '') + (delta * 2).toFixed(1) + ' 斤</span>'
                : '') +
              '<span class="tiny" style="margin-left:auto">' + esc(fmtDate(last.date)) + '</span>' +
            '</div>' + chart
          : '<div class="tiny">还没有记录。</div>') +
        (rows.length ? '<div class="w-list">' + limitRows('w', rows) + '</div>' : '') +
        '<button class="more-toggle" id="addWeight" type="button" style="margin-top:6px">' +
          '＋ 记一次体重</button>' +
      '</div>');
  }

  function weightChart(ws) {
    var W = 640, H = 90, PL = 8, PR = 8, PT = 10, PB = 10;
    var kg = ws.map(function (w) { return w.kg; });
    var lo = Math.min.apply(null, kg), hi = Math.max.apply(null, kg);
    if (hi - lo < 1) { lo -= 0.5; hi += 0.5; }
    var days = function (a, b) {
      return Math.round((new Date(b + 'T12:00:00') - new Date(a + 'T12:00:00')) / 86400000);
    };
    var span = days(ws[0].date, ws[ws.length - 1].date) || 1;
    var x = function (w) { return PL + (W - PL - PR) * (days(ws[0].date, w.date) / span); };
    var y = function (v) { return PT + (H - PT - PB) * (1 - (v - lo) / (hi - lo)); };

    var d = ws.map(function (w, i) { return (i ? 'L' : 'M') + x(w) + ' ' + y(w.kg); }).join(' ');
    var dots = ws.map(function (w) {
      return '<circle cx="' + x(w) + '" cy="' + y(w.kg) + '" r="3" fill="var(--card)" ' +
        'stroke="var(--accent)" stroke-width="2"><title>' +
        esc(w.date + ' · ' + w.kg + 'kg') + '</title></circle>';
    }).join('');

    return '<svg class="w-chart" viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none">' +
      '<path d="' + d + '" fill="none" stroke="var(--accent)" stroke-width="2" ' +
      'stroke-linecap="round" stroke-linejoin="round"/>' + dots + '</svg>';
  }

  function deleteWeight(date) {
    if (!confirm('删掉 ' + fmtDate(date) + ' 这条体重记录？')) return;
    var ws = ((state.data && state.data.weights) || [])
      .filter(function (x) { return x.date !== date; });
    persistWeights(ws, '删除体重记录 ' + date);
  }

  function openWeightEditor(anchor, editDate) {
    if (document.getElementById('w-edit')) return;
    var cur = editDate
      ? ((state.data && state.data.weights) || [])
          .filter(function (x) { return x.date === editDate; })[0]
      : null;
    var box = el(
      '<div class="inline-edit" id="w-edit">' +
        '<div class="w-form">' +
          '<input type="number" id="w-kg" step="0.1" inputmode="decimal" placeholder="斤"' +
            (cur ? ' value="' + (cur.kg * 2).toFixed(1) + '"' : '') + '>' +
          '<input type="date" id="w-date" value="' + (cur ? cur.date : todayISO()) + '">' +
        '</div>' +
        '<input type="text" id="w-note" placeholder="备注（可留空）" style="margin-top:8px"' +
          (cur && cur.note ? ' value="' + esc(cur.note) + '"' : '') + '>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">记下</button>' +
        '</div>' +
      '</div>'
    );
    anchor.replaceWith(box);
    box.querySelector('#w-kg').focus();
    box.querySelector('.ie-cancel').addEventListener('click', function () {
      box.remove();
      go('mainlines');
    });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      // 界面上填的是斤，内部统一存 kg —— BMI 要用 kg 算
      var jin = Number(box.querySelector('#w-kg').value);
      if (!jin || jin < 40 || jin > 400) return toast('体重填一下（斤）', true);
      var rec = {
        date: box.querySelector('#w-date').value || todayISO(),
        kg: Math.round((jin / 2) * 100) / 100,
        note: box.querySelector('#w-note').value.trim() || undefined,
      };
      var oldDate = cur ? cur.date : null;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      saveWeight(rec, oldDate);
    });
  }

  function saveWeight(w, oldDate) {
    var ws = ((state.data && state.data.weights) || []).slice();
    // 同一天只留一条；改日期时把原来那条也去掉
    ws = ws.filter(function (x) { return x.date !== w.date && x.date !== oldDate; }).concat([w]);
    ws.sort(function (a, b) { return a.date < b.date ? -1 : 1; });
    persistWeights(ws, '体重 ' + w.date + ' ' + (w.kg * 2).toFixed(1) + '斤');
  }

  function persistWeights(ws, message) {
    var conf = Object.assign({}, state.data);
    delete conf.entries;
    conf.weights = ws;

    if (state.data) state.data.weights = ws;   // 先本地生效
    refresh('mainlines');

    GitStore.updateJSON('settings.json', function (remote) {
      var base = remote || {};
      base.weights = ws;
      return base;
    }, message).then(loadData).then(function () {
      refresh('mainlines');
    }).catch(function (e) { toast('没存上：' + (e.message || e), true); });
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

  /* 找最近一条【记了某类产品】的记录。
     彩妆必须只跟带妆的记录走 —— 直接沿用上一条的话，
     上一条要是素颜，彩妆就成空的了，等于每天都要重填。 */
  function lastProducts(kind, faceNeeded) {
    var all = newestFirst((state.data && state.data.entries) || []);
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (faceNeeded && e.face !== faceNeeded) continue;
      var list = e.products && e.products[kind];
      if (list && list.length) return { list: list.slice(), date: e.date };
    }
    return null;
  }


  /* 产品库点选：手打产品名又慢又容易和库里对不上号。
     库里按顺序列出来，点一下就加/去掉，输入框跟着同步 ——
     输入框留着是为了记库里还没有的东西。 */
  function pickerHTML(sel, bare) {
    var list = allProducts().filter(function (p) { return p.status !== 'retired'; });
    if (!list.length) return '';
    var chosen = {};
    ['skincare', 'makeup'].forEach(function (k) {
      (sel[k] || []).forEach(function (n) { chosen[prodKey(n)] = 1; });
    });

    // 按护肤 / 彩妆 / 仪器分组，组内按你定的使用顺序
    var groups = bare
      ? [{ k: 'skincare', label: '护肤' }, { k: 'device', label: '仪器' }]
      : [
          { k: 'makeup', label: '彩妆' },
          { k: 'skincare', label: '护肤' },
          { k: 'device', label: '仪器' },
        ];
    var html = groups.map(function (g) {
      var rows = list.filter(function (p) { return kindOf(p) === g.k; })
        .sort(function (x, y) {
          return (orderIndex(x) - orderIndex(y)) || String(x.name).localeCompare(String(y.name));
        });
      if (!rows.length) return '';
      return '<div class="pick-group"><i>' + g.label + '</i><div class="pick">' +
        rows.map(function (p) {
          var vs = variantList(p);
          var picked = Object.keys(chosen).filter(function (k) {
            return splitToken(k).id === p.id;
          });
          var on = picked.length > 0;
          var html = '<button type="button" class="pchip' + (on ? ' on' : '') + '" ' +
            'data-pname="' + esc(p.id) + '" data-pkind="' + esc(kindOf(p)) + '">' +
            esc(shortName(p)) + '</button>';
          // 选中之后才展开款式，没选的时候不占地方
          if (on && vs.length) {
            html += '<span class="vpick">' + vs.map(function (v) {
              var tk = joinToken(p.id, v);
              return '<button type="button" class="pchip vsub' +
                (chosen[tk] ? ' on' : '') + '" data-pname="' + esc(tk) + '" ' +
                'data-pkind="' + esc(kindOf(p)) + '" data-base="' + esc(p.id) + '">' +
                esc(v) + '</button>';
            }).join('') + '</span>';
          }
          return html;
        }).join('') + '</div></div>';
    }).join('');
    return '<div class="pick-wrap" id="prodPick">' + html + '</div>';
  }

  function productField(d) {
    /* 只留点选，不要输入框。
       下面的标签区已经把选了什么显示得很清楚了，
       上面再放一行同样内容的文本框是重复的，还占地方。
       素颜不出现彩妆 —— 没有彩妆可记。 */
    var bare = d.face === 'bare';
    return '<div class="field"><label>今天用的产品' +
      (d.carriedFrom ? '（沿用 ' + fmtDate(d.carriedFrom) + '）' : '') + '</label>' +
      pickerHTML(d.products, bare) +
    '</div>';
  }

  function bindPicker(host) {
    var pick = $('#prodPick', host);
    if (!pick) return;
    pick.addEventListener('click', function (ev) {
      var b = ev.target.closest('.pchip');
      if (!b) return;
      var name = b.dataset.pname;
      var kind = b.dataset.pkind === 'makeup' ? 'makeup' : 'skincare';
      var base = b.dataset.base || splitToken(name).id;
      var d = state.draft;
      d._touchedProducts = true;
      var arr = (d.products[kind] || []).slice();
      var at = arr.indexOf(name);

      if (at >= 0) {
        arr.splice(at, 1);
      } else {
        /* 同一件产品只留一条：点款式就是把它换成那个款式，
           不是又加一件。一次只会用一个款式。 */
        arr = arr.filter(function (t) { return splitToken(t).id !== base; });
        arr.push(name);
      }
      d.products[kind] = arr;
      renderCompose();   // 重画：选中后要把款式展开出来
    });
  }


  /* 从时间线某一天直接开记。
     补记昨天/前天的时候，不用先进「记一条」再回头改日期。 */
  function startEntryOn(date) {
    var d = state.draft;
    if (d && (d.photos || []).length &&
        !confirm('现在这条草稿里已经有照片了，换成 ' + fmtDate(date) + ' 重新记？')) return;
    state.draft = blankDraft();
    state.draft.date = date;
    // 日期换成那一天，时间保留当下的钟点 —— 补记时自己再改
    state.draft.at = date + 'T' + nowLocal().slice(11);
    go('compose');
  }

  function blankDraft() {
    var now = new Date();
    // 产品从照片上看不出来，而且基本天天一样 —— 默认沿用上一次，自己改
    var sk = lastProducts('skincare', null);
    var mk = lastProducts('makeup', 'makeup');
    var carried = { skincare: sk ? sk.list : [], makeup: mk ? mk.list : [] };
    var prev = mk || sk;

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

    /* 沿用上次的产品要在【打开这一页时】算，不能只在建草稿时算。
       建草稿可能发生在云端数据还没加载完的时候，那时候翻不到历史记录，
       结果就是「彩妆没有默认带进来」。
       只在你还没动过产品栏时补，动过就不碰。 */
    if (!d.editingId && !d._touchedProducts) {
      var sk0 = lastProducts('skincare', null);
      var mk0 = lastProducts('makeup', 'makeup');
      if (!(d.products.skincare || []).length && sk0) d.products.skincare = sk0.list.slice();
      if (!(d.products.makeup || []).length && mk0) d.products.makeup = mk0.list.slice();
      if (!d.carriedFrom && (mk0 || sk0)) d.carriedFrom = (mk0 || sk0).date;
    }

    host.innerHTML =
      // 标题只在改旧记录时才有意义：新记一条时下面 tab 已经高亮了，重复
      (d.editingId ? '<div class="section-title">编辑记录</div>' : '') +

      /* 常用的三样放最上面：照片、时间、备注，填完就能存。
         其余大部分时候不填，收进下面的折叠区。 */
      '<div class="field"><label>照片</label>' +
        '<div class="picker" id="picker"></div>' +
      '</div>' +

      '<div class="field"><label>时间</label>' +
        /* 拆成两个原生输入框：datetime-local 在 iOS 上要点两次才能改时间，
           分开之后各自一点即改 */
        '<div class="dt-row">' +
          '<input type="date" id="fDate" value="' + esc(d.at.slice(0, 10)) + '">' +
          '<input type="time" id="fTime" value="' + esc(d.at.slice(11, 16)) + '">' +
        '</div>' +
      '</div>' +

      '<div class="field"><label>素颜还是带妆</label>' +
        '<div class="segmented" id="fFace">' +
        ['makeup', 'bare'].map(function (x) {
          return '<button data-v="' + x + '"' + (d.face === x ? ' class="on"' : '') + '>' +
            FACE[x] + '</button>';
        }).join('') + '</div>' +
      '</div>' +

      '<div class="field"><label>备注</label>' +
        '<textarea id="fNote" placeholder="看到什么写什么，可留空">' + esc(d.note) + '</textarea>' +
      '</div>' +

      '<button class="btn" id="saveBtn">' + (d.editingId ? '保存修改' : '保存') + '</button>' +

      '<button class="btn ghost" id="aiBtn" type="button" style="margin-top:10px">' +
        '让 AI 看照片打分' +
      '</button>' +
      '<div id="aiOut"></div>' +

      /* 带妆的记录，「今天用了什么」就是核心信息 —— 放外面。
         塞进折叠的「更多」里等于没有：用户明说「这个功能有了么，我没看到」。
         素颜没有彩妆可记，留在折叠里就够。 */
      (d.face === 'makeup' ? productField(d) : '') +

      /* ---- 以下折叠 ---- */
      '<button class="more-toggle" id="moreToggle" type="button" aria-expanded="false">' +
        '更多（光线、评分、产品、标签）<span class="ml-caret">▾</span>' +
      '</button>' +
      '<div id="moreBox" hidden>' +

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

        (d.face === 'makeup' ? '' : productField(d)) +

        '<div class="field"><label>标签</label>' +
          '<input type="text" id="fTags" value="' + esc((d.tags || []).join(' ')) + '">' +
        '</div>' +

      '</div>' +

      '<button class="btn ghost" id="resetBtn" style="margin-top:18px">' +
        (d.editingId ? '取消编辑' : '清空重来') + '</button>';

    drawPicker();
    drawRates();

    $('#moreToggle', host).addEventListener('click', function () {
      var box = $('#moreBox', host);
      var open = !box.hidden;
      box.hidden = open;
      this.setAttribute('aria-expanded', String(!open));
      this.classList.toggle('open', !open);
    });

    $('#picker', host).addEventListener('click', function (ev) {
      if (ev.target.closest('#addPhoto')) { $('#fileInput').click(); return; }

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

    var syncAt = function () {
      var dt = $('#fDate', host).value || todayISO();
      var tm = $('#fTime', host).value || nowLocal().slice(11, 16);
      d.at = dt + 'T' + tm;
      d.date = dt;
      d.slot = slotFromHour(Number(tm.slice(0, 2)) || 0);
    };
    $('#fDate', host).addEventListener('change', syncAt);
    $('#fTime', host).addEventListener('change', syncAt);
    $('#fLight', host).addEventListener('input', function () { d.light = this.value; });
    var noteBox = $('#fNote', host);
    autoGrow(host);
    noteBox.addEventListener('input', function () { d.note = this.value; });
    $('#fTags', host).addEventListener('input', function () {
      d.tags = this.value.split(/[\s,，、]+/).filter(Boolean);
    });
    var splitList = function (v) { return v.split(/[,，、]+/).map(function (x) { return x.trim(); }).filter(Boolean); };
    bindPicker(host);


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
    seg('#fFace', 'face', true);   // true = 改完重画，产品栏要跟着换位置

    $('#lightPresets', host).addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      d.light = b.dataset.v;
      $('#fLight', host).value = d.light;
    });

    /* 草稿里的照片也要能点开看 —— 传之前就该确认拍清楚没有。
       用的是已经在内存里的 blob，不走仓库。 */
    $('#picker', host).addEventListener('click', function (ev) {
      if (ev.target.closest('.slot-del') || ev.target.closest('button:not(.slot)')) return;
      var slot = ev.target.closest('.slot');
      if (!slot) return;
      var d = state.draft;
      var urls = (d.keepPhotos || []).map(function (p) { return null; });
      var imgs = Array.prototype.slice.call(host.querySelectorAll('.slot img'))
        .map(function (im) { return im.src; }).filter(Boolean);
      if (!imgs.length) return;
      var all = Array.prototype.slice.call(host.querySelectorAll('.slot'));
      openBlobList(imgs, Math.max(0, all.indexOf(slot)));
    });

    $('#aiBtn', host).addEventListener('click', runAI);
    $('#saveBtn', host).addEventListener('click', saveDraft);
    $('#resetBtn', host).addEventListener('click', function () {
      if (!confirm('清空这条草稿？')) return;
      state.draft = blankDraft();
      renderCompose();
    });
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
    // 长按拖拽排序，不放左右箭头按钮 —— 那些按钮又小又丑，
    // 而且在手机上跟点击删除很容易误触
    var cells = keep.map(function (p, i) {
      return '<div class="slot" data-drag="k' + i + '" data-peekk="' + i + '">' +
        '<img data-key="' + esc(p) + '" alt="" draggable="false">' +
        '<button class="del" data-kdel="' + i + '" aria-label="删除">×</button></div>';
    }).concat(d.photos.map(function (p, i) {
      return '<div class="slot new" data-drag="n' + i + '" data-peekn="' + i + '">' +
        '<img src="' + p.preview + '" alt="" draggable="false">' +
        '<button class="del" data-i="' + i + '" aria-label="删除">×</button>' +
        '<span class="badge">新</span></div>';
    }));

    host.innerHTML = cells.join('') +
      '<button class="add" id="addPhoto"><span class="glyph">＋</span>加照片</button>' +
      (cells.length > 1 ? '<div class="tiny hint drag-tip">长按照片可以拖动排序</div>' : '');
    hydratePhotos(host);
    if (!host.dataset.dragBound) { host.dataset.dragBound = '1'; bindDrag(host); }
  }

  /* 长按拖拽排序。
     只在同一段内交换：已有照片和新加的照片分属两段，
     跨段交换会让「哪些要上传、哪些已在云端」乱掉。 */
  /* 长按拖拽排序。
     不用 elementFromPoint 做命中测试 —— 那东西依赖页面真实渲染，
     一旦被遮挡、被缩放、或在不可见状态下就返回 null。
     改成在按下的那一刻把所有格子的位置量好，之后纯按坐标算落在第几格，
     行为完全确定，也不受 .dragging 那个放大动画影响。 */
  function bindDrag(host) {
    var timer = null, from = null, moved = false;
    var sx = 0, sy = 0, rects = null, seg = null;

    function draft() { return state.draft || {}; }
    function listOf(k) {
      var d = draft();
      return k && k[0] === 'k' ? (d.keepPhotos || []) : (d.photos || []);
    }

    function measure() {
      rects = $$('.slot', host).map(function (node) {
        var r = node.getBoundingClientRect();
        return { key: node.dataset.drag, cx: r.left + r.width / 2, cy: r.top + r.height / 2 };
      });
    }

    // 找离手指最近的、同一段里的格子
    function nearest(x, y) {
      var best = null, bd = Infinity;
      rects.forEach(function (r) {
        if (!r.key || r.key[0] !== seg) return;
        var d2 = (r.cx - x) * (r.cx - x) + (r.cy - y) * (r.cy - y);
        if (d2 < bd) { bd = d2; best = r.key; }
      });
      return best;
    }

    function end() {
      clearTimeout(timer);
      timer = null;
      document.body.classList.remove('no-scroll');
      host.classList.remove('dragmode');
      $$('.slot.dragging', host).forEach(function (n) { n.classList.remove('dragging'); });
      from = null;
      rects = null;
      if (moved) { moved = false; drawPicker(); }
    }

    host.addEventListener('touchstart', function (ev) {
      var slot = ev.target.closest('.slot');
      if (!slot || ev.target.closest('.del')) return;
      var t = ev.touches[0];
      sx = t.clientX; sy = t.clientY;
      timer = setTimeout(function () {
        from = slot.dataset.drag;
        seg = from[0];
        measure();
        slot.classList.add('dragging');
        host.classList.add('dragmode');
        document.body.classList.add('no-scroll');
        if (navigator.vibrate) navigator.vibrate(12);
      }, 380);
    }, { passive: true });

    host.addEventListener('touchmove', function (ev) {
      var t = ev.touches[0];
      if (!from) {
        // 手指按住时必然有几像素抖动，超过 12px 才当成想滚页面
        if (Math.abs(t.clientX - sx) > 12 || Math.abs(t.clientY - sy) > 12) {
          clearTimeout(timer);
          timer = null;
        }
        return;
      }
      ev.preventDefault();

      var to = nearest(t.clientX, t.clientY);
      if (!to || to === from) return;

      var list = listOf(from);
      var i = Number(from.slice(1)), j = Number(to.slice(1));
      if (list[i] === undefined || list[j] === undefined) return;

      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
      moved = true;

      /* 只把两个格子在 DOM 里对调，不整块重绘 ——
         重绘会把正在拖的节点换掉，手指就「掉」了。 */
      var A = host.querySelector('[data-drag="' + from + '"]');
      var B = host.querySelector('[data-drag="' + to + '"]');
      if (A && B) {
        var mark = document.createElement('span');
        A.parentNode.insertBefore(mark, A);
        B.parentNode.insertBefore(A, B);
        mark.parentNode.insertBefore(B, mark);
        mark.remove();
        A.dataset.drag = to;
        B.dataset.drag = from;
        measure();                 // 位置变了，重新量
      }
      from = to;
    }, { passive: false });

    host.addEventListener('touchend', end, { passive: true });
    host.addEventListener('touchcancel', end, { passive: true });
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
      renderPending();
      /* 悄悄和云端对齐，但【不要切换页面】。
         以前跑完会 refresh(job.refreshView)，而 refresh 会切到那个视图 ——
         你正在别处看，识别一完成就被拽到产品页去了。
         只有你本来就停在那一页时才重画。 */
      var back = job.refreshView || 'timeline';
      return loadData().then(function () {
        if (state.view === back) refresh(back);
      });
    }).catch(function (err) {
      job.state = 'failed';
      job.error = (err.step ? '「' + err.step + '」' : '') + (err.message || err);
      running = false;
      renderQueue();
      toast('保存失败：' + job.error, true);
    }).then(function () { pump(); });
  }

  function runJob(job) {
    /* 带 run 的是自定义任务（比如产品识别）。
       放进同一个队列，切页面也照跑完 —— 以前识别写在产品页那个元素里，
       一切走就断了，等于白传。 */
    if (job.run) {
      return job.run(function (t) { job.step = t; renderQueue(); });
    }

    /* 提交前重新读一次云端的 entries.json，而不是用内存里的。
       两次上传排队时，第二条如果拿的是排队那一刻的旧列表，
       会把第一条刚写进去的记录覆盖掉。 */
    /* 照片先单独传（纯新增，不会和别人冲突），
       再用读改写把这条记录并进 entries.json —— 这样即使同时有别的写入，
       也不会把对方刚加的记录覆盖掉。 */
    var upload = job.files.length
      ? GitStore.commit(job.files, job.message + '（照片）', function (t) {
          job.step = t;
          renderQueue();
        })
      : Promise.resolve();

    return upload.then(function () {
      job.step = '写入记录';
      renderQueue();
      return GitStore.updateJSON('entries.json', function (remote) {
        var entries = (remote || []).slice();
        var at = entries.findIndex(function (x) { return x.id === job.entry.id; });
        if (at >= 0) entries[at] = job.entry; else entries.push(job.entry);
        return entries;
      }, job.message);
    });
  }

  var queueMini = false;


  /* 队列条右滑收成一个小圆点：后台在跑，但不该一直横在页面底下挡路。
     点圆点再展开。 */
  function bindQueueSwipe() {
    var host = $('#queue');
    if (!host || host.dataset.sw) return;
    host.dataset.sw = '1';
    var x0 = null;
    host.addEventListener('touchstart', function (ev) {
      x0 = ev.touches[0].clientX;
    }, { passive: true });
    host.addEventListener('touchend', function (ev) {
      if (x0 == null) return;
      var dx = ev.changedTouches[0].clientX - x0;
      x0 = null;
      if (dx > 50 && !queueMini) { queueMini = true; renderQueue(); }
      if (dx < -50 && queueMini) { queueMini = false; renderQueue(); }
    }, { passive: true });
  }

  function renderQueue() {
    var host = $('#queue');
    host.classList.toggle('mini', queueMini);
    if (!queue.length) { host.hidden = true; host.innerHTML = ''; return; }
    host.hidden = false;
    if (queueMini) {
      var running0 = queue.filter(function (j) { return j.state === 'running'; })[0];
      host.innerHTML = '<button class="q-dot" type="button" id="qExpand" ' +
        'aria-label="展开进度">' + queue.length + '</button>';
      $('#qExpand').addEventListener('click', function () {
        queueMini = false; renderQueue();
      });
      return;
    }
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
    var hasPhoto = d.photos.length || (d.keepPhotos && d.keepPhotos.length);
    if (!d.editingId && !hasPhoto && !d.note) {
      return toast('至少加一张照片或写点备注', true);
    }

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
      // 素颜不记彩妆 —— 沿用上一条时会顺手带进来，存下去就成了错的
      products: d.face === 'bare'
        ? { skincare: (d.products.skincare || []).slice(), makeup: [] }
        : d.products,
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

    /* 先在本地把这条记录呈现出来，再后台提交。
       等 GitHub 一路 blob→tree→commit→ref 走完要好几秒，
       让人对着转圈等是没必要的 —— 数据在队列里，失败了会提示重试。 */
    var localPhotos = d.photos.map(function (p) { return p.preview; });
    var optimistic = Object.assign({}, entry, { _pending: true, _local: localPhotos });

    var list = ((state.data && state.data.entries) || []).slice();
    var at = list.findIndex(function (x) { return x.id === id; });
    if (at >= 0) list[at] = optimistic; else list.push(optimistic);
    if (state.data) state.data.entries = list;

    enqueue({
      entry: entry,
      files: files,
      label: fmtDate(d.date) + ' ' + fmtTime(d.at),
      message: (d.editingId ? '修改 ' : '记录 ') + d.date + '（' + id + '）',
      state: 'queued',
    });

    // 预览用的 blob URL 交给时间线继续用，这里不能 revoke
    state.draft = null;
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
    GitStore.updateJSON('entries.json', function (remote) {
      return (remote || []).filter(function (x) { return x.id !== id; });
    }, '删除记录 ' + id)
      .then(function () {
        // 记录先删干净，再清照片文件 —— 反过来的话中途失败会留下引用不到的记录
        return (e.photos || []).length
          ? GitStore.commitDelete(e.photos, '删除 ' + id + ' 的照片')
          : null;
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

  /* 后台提交完成会触发重绘。如果这时候人正在填东西，
     重绘会把打开的编辑框连同没保存的内容一起冲掉 —— 丢数据。
     所以自动重绘一律先问一句：现在有人在编辑吗？ */
  function isEditing() {
    // 只有「还挂在页面上的编辑框」才算
    if ($('.inline-edit')) return true;
    var a = document.activeElement;
    if (!a || !/^(INPUT|TEXTAREA|SELECT)$/.test(a.tagName)) return false;
    // 焦点得在真正的编辑区域里；游离在外的输入框不该拦住刷新
    return !!(a.closest && (a.closest('.inline-edit') || a.closest('.prod-detail') ||
                            a.closest('#view-compose')));
  }

  var pendingRefresh = false;

  // 自动重绘走这里；用户主动点的导航仍然直接用 go()
  function refresh(view) {
    if (isEditing()) {
      pendingRefresh = true;      // 等编辑结束再补
      return;
    }
    go(view || state.view);
  }

  // 编辑框关掉之后，把欠着的那次重绘补上
  function flushRefresh() {
    if (pendingRefresh && !isEditing()) {
      pendingRefresh = false;
      go(state.view);
    }
  }


  /* 时间线上这颗按钮是「选择两条来对比」，其它页面才是设置。
     用文字胶囊，和旁边的「刷新」「趋势」一套 ——
     ☑ ✕ 这类符号在不同系统里字形差别很大，出来的样子不受控。 */
  function syncTopBtn() {
    var b = $('#settingsBtn');
    if (!b) return;
    var pick = state.view === 'timeline';
    b.textContent = pick ? (selectMode ? '✓' : '⧉') : '◎';
    b.className = 'glyphbtn' + (pick && selectMode ? ' on' : '');
    b.setAttribute('aria-label', pick ? (selectMode ? '退出选择' : '选择对比') : '设置');
  }

  function go(view) {
    /* 切页面才回到顶部；原地重画要留在原位。
       以前一律 scrollTo(0,0)，于是改个评分、折叠一条、编辑完保存，
       页面都会弹回最上面 —— 手上正在看的位置全丢了。 */
    var sameView = state.view === view;
    var keepY = window.scrollY;

    state.view = view;
    $$('.view').forEach(function (v) { v.classList.toggle('active', v.id === 'view-' + view); });
    $$('.tabbar button').forEach(function (b) { b.classList.toggle('active', b.dataset.view === view); });
    if (!sameView) window.scrollTo(0, 0);
    (RENDER[view] || function () {})();
    syncAppbarHeight();
    if (sameView && keepY) {
      window.scrollTo(0, keepY);
      // 图片是异步填的，下一帧再定位一次才稳
      requestAnimationFrame(function () { window.scrollTo(0, keepY); });
    }
    if (view !== 'timeline') { selectMode = false; cmpSel = []; }
    syncTopBtn();
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
        '<div class="kv-line"><b>状态</b><span>' +
          (GitStore.isLocal()
            ? '本地模式 · ' + GitStore.pending().total + ' 项待上传'
            : '已连云端') + '</span></div>' +

        '<div class="field" style="margin:16px 0 0">' +
          '<label>GitHub 令牌</label>' +
          '<div class="key-row">' +
            '<input type="password" id="ghToken" autocomplete="off" autocapitalize="off" ' +
              'autocorrect="off" spellcheck="false" placeholder="github_pat_… 或 ghp_…" ' +
              'value="' + esc(state.token) + '">' +
            '<button id="ghEye" type="button">显示</button>' +
          '</div>' +
          '<div class="tiny hint">留空 = 本地模式，记的东西只存在这台设备上。' +
            '换新令牌填进来，本地攒下的会自动补传。</div>' +
        '</div>' +
        '<button class="btn" id="ghSave" type="button" style="margin-top:14px">保存令牌并上传</button>' +

        '<button class="btn ghost" id="diagBtn" type="button" style="margin-top:10px">' +
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

    $('#ghEye', host).addEventListener('click', function () {
      var f = $('#ghToken', host);
      var show = f.type === 'password';
      f.type = show ? 'text' : 'password';
      this.textContent = show ? '隐藏' : '显示';
    });

    $('#ghSave', host).addEventListener('click', function () {
      var b = this;
      var t = $('#ghToken', host).value.trim();
      state.token = t;
      set(LS.token, t);
      configureStore();
      if (!t) { toast('已切到本地模式'); return renderSettings(); }

      b.disabled = true; b.textContent = '检查令牌…';
      // 先确认这个令牌真能写，再补传 —— 免得半路失败留下一半
      GitStore.selftest().then(function (r) {
        if (r.error) throw new Error(r.error);
        b.textContent = '上传中…';
        return GitStore.drain(function (s) { b.textContent = s + '…'; });
      }).then(function () {
        return loadData();
      }).then(function () {
        toast('令牌可用，本地内容已上传');
        renderSettings();
        renderPending();
      }).catch(function (e) {
        toast(String(e.message || e), true);
        b.disabled = false; b.textContent = '保存令牌并上传';
      });
    });

    $('#diagBtn', host).addEventListener('click', function () {
      var o = $('#diagOut', host);
      o.textContent = '检查中…';
      GitStore.selftest().then(function (r) {
        o.innerHTML = [
          '读取：' + (r.read || '—'),
          '写入：' + (r.write || '—'),
          r.tokenExpiry ? '令牌有效期至：' + esc(r.tokenExpiry) : '令牌有效期：未设置到期（永久）',
          r.quota ? '本小时剩余配额：' + esc(r.quota) : '',
          r.error ? '<b>错误：</b>' + esc(r.error) : '',
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


  /* ========== 两条记录对比 ==========
     控制变量法：改一两个产品，看妆效差别。
     所以对比要同时给出【照片并排】和【产品差在哪】。 */
  var cmpSel = [];
  var cmpPick = [0, 0];
  var selectMode = false;

  function toggleCompare(id) {
    var at = cmpSel.indexOf(id);
    if (at >= 0) cmpSel.splice(at, 1);
    else {
      cmpSel.push(id);
      if (cmpSel.length > 2) cmpSel.shift();   // 只留最近选的两条
    }
    redrawTimeline();
    if (cmpSel.length === 2) renderCompare();
  }

  function cmpBar() {
    if (!selectMode) return '';
    if (!cmpSel.length) return '<div class="cmp-bar"><span>点记录上方那一行，选两条来对比</span></div>';
    return '<div class="cmp-bar">' +
      '<span>已选 ' + cmpSel.length + '/2</span>' +
      (cmpSel.length === 2
        ? '<button type="button" id="cmpGo">看对比</button>' : '') +
      '<button type="button" id="cmpClear">取消</button>' +
    '</div>';
  }

  function entryById(id) {
    return ((state.data && state.data.entries) || [])
      .filter(function (x) { return x.id === id; })[0];
  }

  function renderCompare() {
    var a1 = entryById(cmpSel[0]), b1 = entryById(cmpSel[1]);
    if (!a1 || !b1) return;
    // 早的放左边，晚的放右边 —— 看变化要有方向
    var pair = [a1, b1].sort(function (x, y) {
      return String(x.at || x.date).localeCompare(String(y.at || y.date));
    });

    /* 光线和角度不一样就比不出东西来，所以要能自己挑那一张。
       上面一排缩略图，点中的那张在下面放大并排。 */
    var col = function (e, side) {
      var all = e.photos || [];
      var pick = cmpPick[side];
      if (pick == null || pick >= all.length) pick = 0;
      cmpPick[side] = pick;
      return '<div class="cmp-col">' +
        '<div class="cmp-when">' + esc(fmtDate(e.date)) + '<i>' +
          esc((SLOT[slotOf(e)] || '') + ' ' + (fmtTime(e.at) || '')) + '</i></div>' +
        (all.length > 1
          ? '<div class="cmp-strip">' + all.map(function (k, i) {
              return '<button type="button" class="cmp-th' + (i === pick ? ' on' : '') + '" ' +
                'data-cmp-pick="' + side + '" data-i="' + i + '">' +
                '<img data-key="' + esc(k) + '" alt=""></button>';
            }).join('') + '</div>'
          : '') +
        '<div class="cmp-big">' +
          (all.length ? '<img data-key="' + esc(all[pick]) + '" alt="">' : '') +
        '</div>' +
        (e.note ? '<div class="note">' + esc(e.note) + '</div>' : '') +
      '</div>';
    };

    var diffRows = ['skincare', 'makeup'].map(function (kind) {
      var L = (pair[0].products && pair[0].products[kind]) || [];
      var R = (pair[1].products && pair[1].products[kind]) || [];
      var only = function (x, y) {
        var ks = y.map(prodKey);
        return x.filter(function (n) { return ks.indexOf(prodKey(n)) < 0; });
      };
      var gone = only(L, R), add = only(R, L);
      if (!gone.length && !add.length) return '';
      return '<div class="cmp-diff"><b>' + (kind === 'makeup' ? '彩妆' : '护肤') + '</b>' +
        (gone.length ? '<div class="cd-row"><i>换掉</i><span>' +
          gone.map(prodLabel).map(esc).join(' · ') + '</span></div>' : '') +
        (add.length ? '<div class="cd-row new"><i>换成</i><span>' +
          add.map(prodLabel).map(esc).join(' · ') + '</span></div>' : '') +
      '</div>';
    }).join('');

    var same = !diffRows;
    var host = $('#view-trend');
    host.innerHTML =
      '<div class="section-title">对比</div>' +
      '<div class="cmp-grid">' + col(pair[0], 0) + col(pair[1], 1) + '</div>' +
      '<div class="card" style="margin-top:16px">' +
        (same
          ? '<div class="tiny">两次用的产品一样 —— 差别不来自产品。</div>'
          : diffRows) +
      '</div>' +
      '<button class="btn ghost" id="cmpBack" type="button" style="margin-top:18px">返回时间线</button>';

    state.view = 'trend';
    $$('.view').forEach(function (v) { v.classList.remove('active'); });
    host.classList.add('active');
    hydratePhotos(host);
    on('#cmpBack', 'click', function () { cmpSel = []; cmpPick = [0, 0]; go('timeline'); });
    host.addEventListener('click', function (ev) {
      var th = ev.target.closest('[data-cmp-pick]');
      if (!th) return;
      cmpPick[Number(th.dataset.cmpPick)] = Number(th.dataset.i);
      renderCompare();
    });
  }

  /* ================= 产品库 ================= */

  function allProducts() { return (state.data && state.data.products) || []; }

  var KINDS = [
    { key: 'makeup',   label: '彩妆' },
    { key: 'skincare', label: '护肤' },
    { key: 'device',   label: '仪器' },
  ];
  var prodFold = {};      // kind -> true 表示收起

  function kindOf(p) {
    var hay = (p.category || '') + ' ' + (p.name || '');

    /* ⚠️ 这两条要排在 p.kind 之前。
       p.kind 是 AI 认的、不是用户填的，认错了就一直错下去 ——
       「唇膜」被认成彩妆就是这么来的。品类词明确时以品类词为准。 */
    if (/粉扑|美妆蛋|粉底刷|散粉刷|刷具|睫毛夹/.test(hay)) return 'makeup';
    if (/唇膜|润唇/.test(hay)) return 'skincare';

    if (p.kind === 'device' || p.kind === 'makeup') return p.kind;

    /* 顺序很重要：先认明确的护肤/彩妆品类，最后才轮到「仪」这种模糊词。
       反过来的话「面膜仪」「导入仪面膜」里的「仪」会把面膜误判成仪器。 */
    if (/面膜|眼膜|洁面|化妆水|爽肤|乳液|精华|眼霜|面霜|防晒|卸妆|磨砂|喷雾/.test(hay)) {
      return 'skincare';
    }
    if (/粉底|遮瑕|粉饼|散粉|定妆|腮红|修容|高光|眉|眼影|眼线|睫毛|口红|唇/.test(hay)) {
      return 'makeup';
    }
    // 真正的仪器：得是独立的器械词，不能只靠一个「仪」字
    if (/(美容仪|射频仪|导入仪|清洁仪|大排灯|LED|射频|光子|微电流)/i.test(hay)) {
      return 'device';
    }
    return 'skincare';
  }

  /* 按使用顺序排 —— 这就是实际上脸的顺序。
     顺序存在 settings.productOrder 里（属于个人偏好，不该写死在代码），
     这里的默认值只是兜底。

     ⚠️ 用词组不能用单字：早先写成 ['水','乳',...]，
     结果「卸妆水」被「水」捞到第一、「身体乳」被「乳」捞到第二，全乱了。 */
  var DEFAULT_ORDER = {
    makeup: ['粉底|粉霜', '遮瑕', '粉饼|散粉|蜜粉|定妆', '睫毛', '眼线', '眼影',
             '修容|腮红|高光', '卸妆'],
    skincare: ['化妆水|爽肤|柔肤|水乳|乳液', '精华', '面膜', '眼膜', '眼霜'],
    device: [],
  };

  /* 顺序以代码为准。
     曾经存进 settings.json，想着「顺序属于个人偏好该放数据里」——
     但顺序只会通过对话调整、改的还是代码，于是数据里那份很快过期，
     而它优先级更高，结果代码改了不生效。一份来源就够了。 */
  function orderList(kind) {
    return DEFAULT_ORDER[kind] || [];
  }

  function orderIndex(p) {
    var list = orderList(kindOf(p));
    var hay = (p.category || '') + ' ' + (p.name || '');
    for (var i = 0; i < list.length; i++) {
      if (new RegExp(list[i]).test(hay)) return i;
    }
    return 999;   // 没匹配上的算「其他」，排最后
  }

  /* 手动拖过的按手动顺序，没拖过的按使用顺序（粉底→遮瑕→…）。
     ord 只在你真的拖动之后才写，所以新加的产品仍然自动落到该在的位置。 */

  /* 产品列表长按拖动排序。
     和照片那套一样：先缓存各行的位置，拖动时按坐标算落点 ——
     用 elementFromPoint 在手指底下永远命中被拖的那个元素，算不出来。 */
  function bindProdDrag(host) {
    if (host.dataset.pDrag) return;
    host.dataset.pDrag = '1';

    var timer = null, from = null, list = null, rects = null, moved = false;

    var clear = function () {
      clearTimeout(timer); timer = null;
      if (from) from.classList.remove('dragging');
      from = null; list = null; rects = null; moved = false;
    };

    host.addEventListener('touchstart', function (ev) {
      var card = ev.target.closest('.prod-card');
      if (!card || ev.target.closest('button')) return;
      timer = setTimeout(function () {
        from = card;
        list = card.parentNode;
        rects = Array.prototype.map.call(list.children, function (n) {
          return n.getBoundingClientRect();
        });
        card.classList.add('dragging');
        if (navigator.vibrate) navigator.vibrate(12);
      }, 380);
    }, { passive: true });

    host.addEventListener('touchmove', function (ev) {
      if (!from) { clearTimeout(timer); return; }
      ev.preventDefault();
      moved = true;
      var y = ev.touches[0].clientY;
      var kids = Array.prototype.slice.call(list.children);
      var at = kids.indexOf(from);
      for (var i = 0; i < rects.length; i++) {
        if (i === at) continue;
        var r = rects[i];
        if (y > r.top && y < r.bottom) {
          if (i < at) list.insertBefore(from, kids[i]);
          else list.insertBefore(from, kids[i].nextSibling);
          rects = Array.prototype.map.call(list.children, function (n) {
            return n.getBoundingClientRect();
          });
          break;
        }
      }
    }, { passive: false });

    host.addEventListener('touchend', function () {
      if (!from || !moved) return clear();
      var ids = Array.prototype.map.call(list.children, function (n) {
        return n.dataset.pid;
      });
      clear();
      var pos = {};
      ids.forEach(function (id, i) { pos[id] = i; });
      var next = allProducts().map(function (p) {
        return pos[p.id] == null ? p : Object.assign({}, p, { ord: pos[p.id] });
      });
      saveProducts(next, '产品库：调整顺序')
        .catch(function (e) { toast('排序没保存：' + (e.message || e), true); });
    });

    host.addEventListener('touchcancel', clear);
  }


  /* 同一件东西的不同款式/色号：敷尔佳的各种面膜、眉笔的各个色号。
     它们是一件产品的多个选项，不该在产品库里各占一行。 */
  function variantList(p) {
    var v = p.variants;
    if (!v) return [];
    if (Array.isArray(v)) return v;
    return String(v).split(/[、,，]/).map(function (x) { return x.trim(); })
      .filter(Boolean);
  }


  /* 二级分类：彩妆分底妆/彩妆/工具，护肤分日常/面膜。
     一整列 30 多件平铺，找一支眼线要划半天。 */
  var SUBCATS = {
    makeup: [
      { key: 'base', label: '底妆', re: /粉底|粉霜|遮瑕|粉饼|散粉|蜜粉|定妆/ },
      { key: 'color', label: '彩妆', re: /腮红|修容|高光|眼影|眼线|睫毛膏|眉|唇|口红/ },
      { key: 'tool', label: '工具', re: /粉扑|美妆蛋|刷|睫毛夹|眉笔刀/ },
    ],
    skincare: [
      { key: 'mask', label: '面膜', re: /面膜|眼膜|唇膜/ },
      { key: 'daily', label: '日常', re: /./ },
    ],
    device: [{ key: 'all', label: '仪器', re: /./ }],
  };

  function subCatOf(p) {
    var list = SUBCATS[kindOf(p)] || [];
    // 你手动改过的优先 —— 自动归类总有猜错的时候
    if (p.sub) {
      var hit = list.filter(function (x) { return x.key === p.sub; })[0];
      if (hit) return hit;
    }
    var hay = (p.category || '') + ' ' + (p.name || '') + ' ' + (p.short || '');
    for (var i = 0; i < list.length; i++) {
      if (list[i].re.test(hay)) return list[i];
    }
    return list[list.length - 1] || { key: 'all', label: '其他' };
  }

  function sortProducts(rows) {
    return rows.slice().sort(function (a, b) {
      var ao = a.ord, bo = b.ord;
      if (ao != null && bo != null) return ao - bo;
      if (ao != null) return -1;
      if (bo != null) return 1;
      var d = orderIndex(a) - orderIndex(b);
      return d !== 0 ? d : (a.name < b.name ? -1 : 1);
    });
  }

  function avgScore(p) {
    var rs = (p.reviews || []).map(function (r) { return r.score; })
      .filter(function (v) { return typeof v === 'number'; });
    if (!rs.length) return null;
    return rs.reduce(function (x, y) { return x + y; }, 0) / rs.length;
  }

  function renderProducts() {
    var host = $('#view-products');
    var list = allProducts();

    var body = '';
    KINDS.forEach(function (k) {
      var rows = sortProducts(list.filter(function (p) {
        return kindOf(p) === k.key && p.status !== 'retired';
      }));
      if (!rows.length) return;
      var closed = prodFold[k.key];
      // 二级分类，各自也能折叠
      var subs = (SUBCATS[k.key] || []).map(function (sc) {
        var mine = rows.filter(function (p) { return subCatOf(p).key === sc.key; });
        if (!mine.length) return '';
        var sk = k.key + ':' + sc.key;
        var sClosed = prodFold[sk];
        return '<div class="sub-head' + (sClosed ? ' closed' : '') + '" data-kind="' + esc(sk) + '">' +
            esc(sc.label) + '<span>' + mine.length + '</span>' +
            '<span class="ml-caret">▾</span>' +
          '</div>' +
          '<div class="prod-list"' + (sClosed ? ' hidden' : '') + '>' +
            mine.map(prodCardHTML).join('') + '</div>';
      }).join('');

      body +=
        '<div class="cat-head' + (closed ? ' closed' : '') + '" data-kind="' + k.key + '">' +
          esc(k.label) + '<span>' + rows.length + '</span>' +
          '<span class="ml-caret">▾</span>' +
        '</div>' +
        '<div class="cat-body"' + (closed ? ' hidden' : '') + '>' + subs + '</div>';
    });

    var retired = list.filter(function (p) { return p.status === 'retired'; });
    if (retired.length) {
      var rClosed = prodFold.retired;
      body +=
        '<div class="cat-head' + (rClosed ? ' closed' : '') + '" data-kind="retired">' +
          '已停用<span>' + retired.length + '</span><span class="ml-caret">▾</span></div>' +
        '<div class="prod-list dim"' + (rClosed ? ' hidden' : '') + '>' +
          retired.map(prodCardHTML).join('') + '</div>';
    }

    if (!body) {
      body = '<div class="empty"><strong>产品库还是空的</strong>' +
        '拍一张护肤品或彩妆的照片，AI 会认出品牌和品名。</div>';
    }

    host.innerHTML =
      '<div class="tl-bar">' +
        '<span class="tiny">产品库 · ' +
          list.filter(function (p) { return p.status !== 'retired'; }).length + ' 件在用</span>' +
        '<button id="scanBtn" type="button">＋ 拍照识别</button>' +
      '</div>' +
      '<div id="scanOut"></div>' + body +
      '<button class="more-toggle" id="addProdBtn" type="button">手动添加一件</button>';

    bindProdDrag(host);
    $('#scanBtn', host).addEventListener('click', function () { $('#prodInput').click(); });
    $('#addProdBtn', host).addEventListener('click', function () {
      addProductManually(this);
    });

    if (!host.dataset.bound) {
      host.dataset.bound = '1';
      host.addEventListener('click', function (ev) {
        var ch = ev.target.closest('[data-kind]');
        if (ch) {
          var k = ch.dataset.kind;
          prodFold[k] = !prodFold[k];
          ch.classList.toggle('closed', prodFold[k]);
          ch.nextElementSibling.hidden = prodFold[k];
          return;
        }
        var rv = ev.target.closest('[data-review]');
        if (rv) return openReviewEditor(rv.dataset.review, rv.closest('.prod-card'));
        var dp = ev.target.closest('[data-detail-prod]');
        if (dp) return toggleProdDetail(dp.dataset.detailProd, dp.closest('.prod-card'));
        var ex = ev.target.closest('[data-expand]');
        if (ex) {
          var box = document.getElementById('rv-' + ex.dataset.expand);
          if (box) box.hidden = !box.hidden;
          return;
        }
        var b = ev.target.closest('[data-del]');
        if (b) return removeProduct(b.dataset.del);
        var t = ev.target.closest('[data-toggle]');
        if (t) return toggleProduct(t.dataset.toggle);
      });
    }
    hydratePhotos(host);
  }


  /* 显示名 = 品牌 + 产品，几个字说清楚。
     用户原话：「很多写的就是高光修容盘，这有啥用，我得知道品牌，以后才能对比」
     ——「彩棠修容盘」「covermark粉底霜」「YSL恒久」「雅诗兰黛DW」这种。
     `short` 是可编辑字段，没填就用品牌+品名拼一个兜底。 */

  /* 产品改名后，把所有历史记录里的旧名字换掉。 */
  function renameInEntries(oldName, newName) {
    var touched = 0;
    var swap = function (list) {
      return (list || []).map(function (n) {
        if (n !== oldName) return n;
        touched++;
        return newName;
      });
    };
    // 本地先改，界面立刻对
    ((state.data && state.data.entries) || []).forEach(function (e) {
      if (!e.products) return;
      e.products.skincare = swap(e.products.skincare);
      e.products.makeup = swap(e.products.makeup);
    });
    if (!touched) return Promise.resolve(null);
    refresh('products');

    return GitStore.updateJSON('entries.json', function (remote) {
      return (remote || []).map(function (e) {
        if (!e.products) return e;
        var y = Object.assign({}, e);
        y.products = {
          skincare: swap(e.products.skincare),
          makeup: swap(e.products.makeup),
        };
        return y;
      });
    }, '把记录里的「' + oldName + '」改成「' + newName + '」')
      .then(function () { toast('顺带改了 ' + touched + ' 处历史记录'); });
  }


  /* ===== 产品名只有一个来源：产品库 =====
     记录里存的是产品 id，显示时现查现取。
     以前存的是名字字符串，产品库改了名，时间线和记一条里还是旧的 ——
     同一件东西三个地方三个叫法。

     老数据存的是名字，这里按名字兜底解析，所以不用迁移也能正常显示。 */

  /* 记录里的一项可以带款式：「pid#积雪草」。
     同一件产品换个款式（面膜换配方、眉笔换色号）本来就是一次变量改动，
     记不下来的话「控制变量看效果」就无从比起。 */
  function splitToken(t) {
    var s = String(t || '');
    var at = s.indexOf('#');
    return at < 0 ? { id: s, variant: '' }
                  : { id: s.slice(0, at), variant: s.slice(at + 1) };
  }

  function joinToken(id, variant) {
    return variant ? id + '#' + variant : id;
  }

  function prodById(id) {
    return allProducts().filter(function (p) { return p.id === id; })[0] || null;
  }

  function prodByLabel(text) {
    var k = String(text || '').trim();
    if (!k) return null;
    return allProducts().filter(function (p) {
      return p.id === k || shortName(p) === k || p.name === k || p.short === k;
    })[0] || null;
  }

  // 记录里的一项 → 显示用的名字
  function prodLabel(token) {
    var t = splitToken(token);
    var p = prodById(t.id) || prodByLabel(token);
    if (!p) return String(token || '');
    return shortName(p) + (t.variant ? ' · ' + t.variant : '');
  }

  // 记录里的一项 → 用来比对的唯一键（有 id 用 id，没有就用名字）
  // 换了款式也算「和上次不一样」，所以键里要带款式
  function prodKey(token) {
    var t = splitToken(token);
    var p = prodById(t.id) || prodByLabel(token);
    return p ? joinToken(p.id, t.variant) : String(token || '');
  }

  // 界面上填的名字 → 存进记录的值（库里有就存 id）
  function toToken(text) {
    var s = String(text || '').trim();
    // 「敷尔佳面膜 · 积雪草」这种手打的也要能还原成 pid#款式
    var parts = s.split(/\s*·\s*/);
    var p = prodByLabel(parts[0]);
    if (p && parts.length > 1) return joinToken(p.id, parts.slice(1).join(' · '));
    p = p || prodByLabel(s);
    return p ? p.id : s;
  }

  function shortName(p) {
    if (p.short) return p.short;
    var brand = String(p.brand || '').split(/[\s/·]/)[0];
    var name = String(p.name || '');
    // 品名里已经带了品牌就不重复拼
    if (brand && name.toLowerCase().indexOf(brand.toLowerCase()) >= 0) return name;
    return (brand + name).slice(0, 18);
  }

  function prodCardHTML(p) {
    var disp = shortName(p);
    // 显示名里已经有品牌了，副标题只留类别，不重复
    var sub = [disp.indexOf(p.brand || '\u0000') >= 0 ? '' : p.brand, p.category]
      .filter(Boolean).join(' · ');
    var dates = [];
    if (p.start) dates.push('起 ' + fmtDate(p.start));
    if (p.status === 'retired' && p.end) dates.push('停 ' + fmtDate(p.end));
    var avg = avgScore(p);
    var rs = p.reviews || [];

    return '<div class="prod-card" data-pid="' + esc(p.id) + '">' +
      '<div class="pc-main" data-detail-prod="' + esc(p.id) + '">' +
        '<div class="nm">' + esc(disp) + '</div>' +
        (sub ? '<div class="sub">' + esc(sub) + '</div>' : '') +
        (dates.length ? '<div class="sub">' + esc(dates.join(' · ')) + '</div>' : '') +
      '</div>' +
      (avg != null ? '<span class="prod-score">' + avg.toFixed(1) + '<i>/5</i></span>' : '') +
      '<div class="act">' +
        '<button data-review="' + esc(p.id) + '">评分</button>' +
        '<button data-toggle="' + esc(p.id) + '">' +
          (p.status === 'retired' ? '恢复' : '停用') + '</button>' +
      '</div>' +
      (rs.length
        ? '<div class="prod-reviews" id="rv-' + esc(p.id) + '" hidden>' +
          rs.slice().reverse().map(function (r) {
            return '<div class="prod-review">' +
              '<b>' + esc(fmtDate(r.date)) + (r.score ? ' · ' + r.score + '分' : '') + '</b>' +
              '<span>' + esc(r.text || '') + '</span></div>';
          }).join('') + '</div>'
        : '') +
    '</div>';
  }

  /* 同一个产品可以在不同时间反复打分 —— 用久了感受会变，
     这些变化本身就是信息，所以留全部记录，卡片上显示平均分。 */
  function closeInlineEditors() {
    $$('.inline-edit').forEach(function (n) { n.remove(); });
    $$('.prod-detail').forEach(function (n) { n.remove(); });
    flushRefresh();
  }

  function openReviewEditor(id, card) {
    if (card.querySelector('.inline-edit')) return;
    closeInlineEditors();   // 一次只开一个，否则页面上会堆好几个编辑框
    var box = el(
      '<div class="inline-edit">' +
        '<div class="score-row">' +
          '<span class="score-val">3.0</span>' +
          '<input type="range" min="0" max="5" step="0.1" value="3">' +
        '</div>' +
        '<textarea placeholder="这次的感受（可留空）"></textarea>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">记下</button>' +
        '</div>' +
      '</div>'
    );
    card.appendChild(box);
    var range = box.querySelector('input');
    var val = box.querySelector('.score-val');
    range.addEventListener('input', function () { val.textContent = Number(this.value).toFixed(1); });
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var score = Number(range.value);
      var txt = box.querySelector('textarea').value;
      /* 先把编辑框拆掉再保存。
         保存里会调 refresh()，而 refresh 看到编辑框还开着就会把刷新欠下 ——
         结果就是点了没反应，等编辑框关了才突然更新。 */
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      addReview(id, score, txt);
    });
  }

  /* editIdx 有值就是在改已有的那一条 —— AI 认错了日期、价格得能纠正。 */
  function openBuyEditor(pid, anchor, editIdx) {
    if (anchor.parentNode.querySelector('.inline-edit')) return;
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    var buys = sortedBuys(p);
    var cur = editIdx != null ? buys[editIdx] : null;
    var v = function (k) { return cur && cur[k] != null ? esc(String(cur[k])) : ''; };

    var box = el(
      '<div class="inline-edit">' +
        '<div class="w-form">' +
          '<input type="date" class="b-date" value="' + (cur ? esc(cur.date || '') : todayISO()) + '">' +
          '<input type="number" class="b-price" inputmode="decimal" placeholder="价格" value="' + v('price') + '">' +
        '</div>' +
        '<div class="w-form" style="margin-top:8px">' +
          '<input type="text" class="b-size" placeholder="规格 如 50ml" value="' + v('size') + '">' +
          '<input type="text" class="b-where" placeholder="渠道 如 天猫" value="' + v('where') + '">' +
        '</div>' +
        '<input type="text" class="b-spec" placeholder="款式/色号（可留空）" ' +
          'style="margin-top:8px" value="' + v('spec') + '">' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">' + (cur ? '保存' : '记下') + '</button>' +
        '</div>' +
      '</div>'
    );
    anchor.insertAdjacentElement('beforebegin', box);
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var price = Number(box.querySelector('.b-price').value);
      var rec = {
        date: box.querySelector('.b-date').value || todayISO(),
        price: isFinite(price) && price > 0 ? price : undefined,
        size: box.querySelector('.b-size').value.trim() || undefined,
        where: box.querySelector('.b-where').value.trim() || undefined,
        spec: box.querySelector('.b-spec').value.trim() || undefined,
      };
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      var next = allProducts().map(function (x) {
        if (x.id !== pid) return x;
        var y = Object.assign({}, x);
        var list = sortedBuys(y).slice();
        if (cur) list[editIdx] = rec; else list.push(rec);
        y.purchases = list;
        // 第一次购买顺手当作开始使用日期
        if (!y.start) y.start = rec.date;
        return y;
      });
      saveProducts(next, cur ? '产品库：改一条购买记录' : '产品库：记录一次购买')
        .then(function () { toast(cur ? '已改' : '已记下'); })
        .catch(function (e) { toast('失败：' + (e.message || e), true); });
    });
  }

  // 购买记录统一按日期倒序，显示和改用的是同一份顺序，索引才不会错位
  function sortedBuys(p) {
    return ((p && p.purchases) || []).slice()
      .sort(function (x, y) { return (x.date || '') < (y.date || '') ? 1 : -1; });
  }

  function deleteBuy(pid, idx) {
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p) return;
    var sorted = sortedBuys(p);
    var target = sorted[idx];
    if (!target) return;
    var next = allProducts().map(function (x) {
      if (x.id !== pid) return x;
      var y = Object.assign({}, x);
      var hit = false;
      y.purchases = (y.purchases || []).filter(function (b) {
        if (!hit && b.date === target.date && b.price === target.price) { hit = true; return false; }
        return true;
      });
      return y;
    });
    saveProducts(next, '产品库：删除一条购买记录')
      .catch(function (e) { toast('失败：' + (e.message || e), true); });
  }

  function editReview(pid, idx, row) {
    if (row.querySelector('.inline-edit')) return;
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p) return;
    var r = (p.reviews || [])[idx];
    if (!r) return;

    var box = el(
      '<div class="inline-edit">' +
        '<div class="score-row">' +
          '<span class="score-val">' + (r.score != null ? r.score.toFixed(1) : '—') + '</span>' +
          '<input type="range" min="0" max="5" step="0.1" value="' +
            (r.score != null ? r.score : 3) + '">' +
        '</div>' +
        '<input type="date" class="rv-date" value="' + esc(r.date || todayISO()) + '">' +
        '<textarea style="margin-top:8px">' + esc(r.text || '') + '</textarea>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">保存</button>' +
        '</div>' +
      '</div>'
    );
    row.appendChild(box);
    var range = box.querySelector('input[type=range]');
    var val = box.querySelector('.score-val');
    range.addEventListener('input', function () { val.textContent = Number(this.value).toFixed(1); });
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var patch = {
        date: box.querySelector('.rv-date').value || r.date,
        score: Number(range.value),
        text: box.querySelector('textarea').value.trim() || undefined,
      };
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      var next = allProducts().map(function (x) {
        if (x.id !== pid) return x;
        var y = Object.assign({}, x);
        y.reviews = (y.reviews || []).slice();
        y.reviews[idx] = patch;
        return y;
      });
      saveProducts(next, '产品库：修改 ' + p.name + ' 的评价')
        .then(function () { toast('已更新'); })
        .catch(function (e) { toast('失败：' + (e.message || e), true); });
    });
  }

  function deleteReview(pid, idx) {
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p || !(p.reviews || [])[idx]) return;
    if (!confirm('删掉这条评价？')) return;
    var next = allProducts().map(function (x) {
      if (x.id !== pid) return x;
      var y = Object.assign({}, x);
      y.reviews = (y.reviews || []).filter(function (_, i) { return i !== idx; });
      return y;
    });
    saveProducts(next, '产品库：删除 ' + p.name + ' 的一条评价')
      .then(function () { toast('已删除'); })
      .catch(function (e) { toast('失败：' + (e.message || e), true); });
  }

  function addReview(id, score, txt) {
    var list = allProducts();
    var p = list.filter(function (x) { return x.id === id; })[0];
    if (!p) return;
    txt = String(txt || '').trim();

    var next = list.map(function (x) {
      if (x.id !== id) return x;
      var y = Object.assign({}, x);
      y.reviews = (y.reviews || []).concat([{
        date: todayISO(),
        score: (score >= 0 && score <= 5) ? score : undefined,
        text: txt || undefined,
      }]);
      return y;
    });
    saveProducts(next, '产品库：' + p.name + ' 新增评价')
      .then(function () { toast('已记下'); })
      .catch(function (e) { toast('失败：' + e.message, true); });
  }

  /* 产品详情：在卡片里就地展开，所有字段直接改，不跳新页也不弹窗 */
  var PROD_FIELDS = [
    /* 简称是【到处显示的那个名字】，你会改；
       名称是 AI 认出来的全名，一般不动。所以简称排最前。 */
    { k: 'short',    label: '显示名', type: 'text', ph: '如 彩棠修容盘 / YSL恒久' },
    { k: 'name',     label: '全名',   type: 'text', ph: 'AI 识别的完整品名' },
    { k: 'brand',    label: '品牌',   type: 'text' },
    { k: 'category', label: '类别',   type: 'text' },
    { k: 'price',    label: '价格',   type: 'number', unit: '元' },
    { k: 'size',     label: '规格',   type: 'text',   ph: '如 50ml / 30g' },
    { k: 'variants', label: '款式/色号', type: 'text', ph: '顿号分隔，如 积雪草、依克多因' },
    { k: 'spec',     label: '成分/参数', type: 'text', ph: '如 SPF50+ PA++++' },
    { k: 'start',    label: '购买/开始', type: 'date' },
    { k: 'end',      label: '停用',   type: 'date' },
    { k: 'note',     label: '备注',   type: 'text' },
  ];

  function toggleProdDetail(id, card) {
    var old = card.querySelector('.prod-detail');
    if (old) { old.remove(); return; }
    closeInlineEditors();

    var p = allProducts().filter(function (x) { return x.id === id; })[0];
    if (!p) return;

    /* 只读区只显示【别处没有的】信息。
       名称、品牌、类别、起用日期上面标题那行已经写了；
       价格和规格属于购买记录，那边列得更清楚（还能区分每次回购）。
       同一件事写三遍，翻起来全是噪音。
       编辑态仍然给全字段 —— 认错了要能改。 */
    var buysAll = p.purchases || [];
    var inBuys = function (k) {
      return buysAll.some(function (b) { return String(b[k] || '') === String(p[k] || ''); });
    };
    /* 名称不算重复：上面标题一行放不下会截断（ESSENCE FOUNDATI…），
       详情里必须能看到完整的名字。品牌、类别、起用日期在标题里是完整的。 */
    /* 显示名要留在这儿：它是到处引用的那个名字，也是最常改的。
       之前想着「标题里已经有了」把它隐掉，结果反而没地方改。 */
    var HEADER_FIELDS = { brand: 1, category: 1, start: 1, variants: 1 };
    // 全名和显示名一样就不重复列
    if (shortName(p) === p.name) HEADER_FIELDS.name = 1;

    // 默认只读，点 ✎ 才切成输入框 —— 一打开就满屏输入框太吵
    var readRows = PROD_FIELDS.filter(function (f) {
      if (p[f.k] == null || p[f.k] === '') return false;
      if (HEADER_FIELDS[f.k]) return false;
      // 有购买记录了，价格和规格那边写得更清楚（还分得开每次回购）
      if ((f.k === 'price' || f.k === 'size') && buysAll.length) return false;
      if (f.k === 'spec' && buysAll.length) return false;   // 已并进购买记录那一行
      return true;
    }).map(function (f) {
      return '<div class="pd-row read"><span>' + esc(f.label) + '</span>' +
        '<b>' + esc(String(p[f.k])) + (f.unit || '') + '</b></div>';
    }).join('');

    var editRows = PROD_FIELDS.map(function (f) {
      return '<label class="pd-row"><span>' + esc(f.label) + '</span>' +
        '<input type="' + f.type + '" data-f="' + f.k + '" ' +
        (f.ph ? 'placeholder="' + esc(f.ph) + '" ' : '') +
        'value="' + esc(p[f.k] == null ? '' : p[f.k]) + '">' +
        (f.unit ? '<i>' + f.unit + '</i>' : '') + '</label>';
    }).join('');

    /* 历史评分可改可删。用久了看法会变，早先那条写得不准就该能修，
       但索引要按【原数组】算 —— 显示是倒序的，直接用显示位置会改错人。 */
    /* 购买记录：同一件会反复回购，价格和渠道都可能变。
       只留一个「购买时间」字段是不够的。 */
    var buys = sortedBuys(p);
    var buyHTML = '<div class="pd-hist">' +
      '<b>购买记录<button class="ph-add" data-buy-add="' + esc(p.id) + '" ' +
        'type="button" aria-label="记一次购买">＋</button></b>' +
      (buys.length
        ? buys.map(function (b, i) {
            return '<div class="prod-review">' +
              '<b>' + esc(fmtDate(b.date)) + '</b>' +
              /* 一行写完：价格 · 规格 · 色号参数 · 渠道。
                 色号跟着「买的这一次」走 —— 回购换色号是常事。 */
              '<span>' + [b.price ? b.price + '元' : '', b.size || '',
                          b.spec || (i === buys.length - 1 ? p.spec : '') || '',
                          b.where || '']
                .filter(Boolean).map(esc).join(' · ') + '</span>' +
              '<button class="rv-edit" data-buy-edit="' + i + '" aria-label="改">✎</button>' +
              '<button class="rv-edit" data-buy-del="' + i + '" aria-label="删">×</button>' +
            '</div>';
          }).join('')
        : '<div class="tiny">还没有记录</div>') +
      '</div>';

    var all = p.reviews || [];
    var hist = all.length
      ? '<div class="pd-hist"><b>历史评分</b>' +
        all.map(function (r, i) { return { r: r, i: i }; }).reverse().map(function (x) {
          var r = x.r;
          return '<div class="prod-review" data-rv="' + x.i + '">' +
            '<b>' + esc(fmtDate(r.date)) + (r.score != null ? ' · ' + r.score.toFixed(1) : '') + '</b>' +
            '<span>' + esc(r.text || '') + '</span>' +
            '<button class="rv-edit" data-rv-edit="' + x.i + '" aria-label="改">✎</button>' +
            '<button class="rv-edit" data-rv-del="' + x.i + '" aria-label="删">×</button>' +
          '</div>';
        }).join('') + '</div>'
      : '';

    var box = el('<div class="prod-detail">' +
      (variantList(p).length
        ? '<div class="pd-vars">' + variantList(p).map(function (v) {
            return '<span class="vchip">' + esc(v) + '</span>';
          }).join('') + '</div>'
        : '') +
      '<div class="pd-read' + (readRows ? '' : ' bare') + '">' + readRows +
        '<button class="pd-edit" type="button" aria-label="编辑">✎</button>' +
      '</div>' +
      '<div class="pd-edit-form" hidden>' + editRows +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">保存</button>' +
        '</div>' +
      '</div>' +
      hist + buyHTML +
      /* 照片小节：＋ 挂在标题右边，识别到的信息自动补进产品和购买记录 */
      // 归类改不了的话，自动猜错就只能一直错着
      '<div class="pd-cats">' +
        '<div class="segmented sm" data-catset="kind">' +
          KINDS.map(function (k) {
            return '<button type="button" data-v="' + k.key + '"' +
              (kindOf(p) === k.key ? ' class="on"' : '') + '>' + esc(k.label) + '</button>';
          }).join('') +
        '</div>' +
        ((SUBCATS[kindOf(p)] || []).length > 1
          ? '<div class="segmented sm" data-catset="sub" style="margin-top:6px">' +
            SUBCATS[kindOf(p)].map(function (sc) {
              return '<button type="button" data-v="' + esc(sc.key) + '"' +
                (subCatOf(p).key === sc.key ? ' class="on"' : '') + '>' + esc(sc.label) + '</button>';
            }).join('') + '</div>'
          : '') +
      '</div>' +

      /* 合并和删除都是很少用、且用错了麻烦的动作 ——
         缩成一行小图标放在最下面就够，不该占一整行文字。 */
      '<div class="pd-tools">' +
        '<button data-merge="' + esc(p.id) + '" type="button" aria-label="并入另一件">⇥</button>' +
        '<button class="danger" data-del="' + esc(p.id) + '" type="button" aria-label="删除">🗑</button>' +
      '</div>' +
      '<div class="pd-hist"><b>照片' +
        '<button class="ph-add" data-shoot="' + esc(p.id) + '" type="button" ' +
          'aria-label="拍张照补充信息">＋</button></b>' +
        '<span class="tiny pd-shoot-msg"></span>' +
        ((p.photos || []).length
          ? '<div class="pc-shots">' +
            p.photos.map(function (path, i) {
              return '<span class="pc-cell">' +
                '<button class="pc-shot" type="button" data-shot="' + i + '">' +
                  '<img data-key="' + esc(path) + '" alt=""></button>' +
                '<button class="pc-del" type="button" data-shot-del="' + i + '" ' +
                  'aria-label="删掉这张">×</button>' +
              '</span>';
            }).join('') + '</div>'
          : '') +
      '</div>' +
      '</div>');

    card.appendChild(box);
    // 产品照片和时间线的照片走同一套懒加载，不调这一下就一直是白的
    hydratePhotos(box);
    box.addEventListener('click', function (ev) {
      var ed = ev.target.closest('[data-rv-edit]');
      if (ed) return editReview(id, Number(ed.dataset.rvEdit), ed.closest('.prod-review'));
      var dl = ev.target.closest('[data-rv-del]');
      if (dl) return deleteReview(id, Number(dl.dataset.rvDel));
      var ba = ev.target.closest('[data-buy-add]');
      if (ba) return openBuyEditor(id, ba);
      var be = ev.target.closest('[data-buy-edit]');
      if (be) return openBuyEditor(id, be.closest('.prod-review'), Number(be.dataset.buyEdit));
      var bd = ev.target.closest('[data-buy-del]');
      if (bd) return deleteBuy(id, Number(bd.dataset.buyDel));
      var cs = ev.target.closest('[data-catset] button');
      if (cs) {
        var which = cs.closest('[data-catset]').dataset.catset;
        var patch = which === 'kind' ? { kind: cs.dataset.v, sub: undefined }
                                     : { sub: cs.dataset.v };
        return saveProducts(allProducts().map(function (x) {
          return x.id === id ? Object.assign({}, x, patch) : x;
        }), '产品库：调整 ' + shortName(p) + ' 的归类');
      }
      var rn = ev.target.closest('[data-rename]');
      if (rn) return openRenameBox(rn.dataset.rename, rn.closest('.pd-rename'));
      var mg = ev.target.closest('[data-merge]');
      if (mg) return openMergePicker(mg.dataset.merge, mg.closest('.pd-tools'));
      var sx = ev.target.closest('[data-shot-del]');
      if (sx) return deleteProductShot(id, Number(sx.dataset.shotDel));
      var sp = ev.target.closest('[data-shot]');
      if (sp) return openPhotoList(p.photos, Number(sp.dataset.shot));
      var sh = ev.target.closest('[data-shoot]');
      if (sh) {
        var inp = $('#prodShotInput');
        inp.onchange = function () {
          shootProduct(id, this.files, box.querySelector('.pd-shoot-msg'));
          this.value = '';
        };
        inp.click();
      }
    });

    box.querySelector('.pd-edit').addEventListener('click', function () {
      box.querySelector('.pd-read').hidden = true;
      box.querySelector('.pd-edit-form').hidden = false;
    });
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var patch = {};
      $$('[data-f]', box).forEach(function (inp) {
        var v = inp.value.trim();
        patch[inp.dataset.f] = inp.type === 'number' ? (v === '' ? undefined : Number(v))
                                                     : (v || undefined);
      });
      /* 先 blur 再移除。
         只移除表单的话，activeElement 还停在那个输入框上，
         isEditing() 判定为真，刷新就被欠下 —— 表现是「点保存没反应」。 */
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      var next = allProducts().map(function (x) {
        return x.id === id ? Object.assign({}, x, patch) : x;
      });
      var after = next.filter(function (x) { return x.id === id; })[0];
      var oldName = shortName(p), newName = shortName(after);

      saveProducts(next, '产品库：更新 ' + (patch.name || p.name))
        .then(function () {
          /* 记录里存的是产品名字符串。
             改了名不同步，历史记录里还是旧名字，产品库对不上号 ——
             既选不中，也看不出「这条用的就是这件」。 */
          if (oldName === newName) return null;
          return renameInEntries(oldName, newName);
        })
        .then(function () { toast('已保存'); })
        .catch(function (e) { toast('失败：' + (e.message || e), true); });
    });
  }

  function saveProducts(list, message, extraFiles) {
    /* ⚠️ 不能整份覆盖 base.products = list。
       list 来自这台设备内存里的副本；只要它比云端旧，
       一次保存就把云端的改动整个抹掉 ——
       手机上改个评分，就能把别处刚做的合并复原成合并前的样子。
       所以按 id 做差异：本地改过的用本地的，本地没碰过的保留云端的，
       本地明确删掉的才删。 */
    var before = allProducts();
    var kept = {};
    list.forEach(function (p) { kept[p.id] = p; });
    var removed = before.filter(function (b) { return !kept[b.id]; })
      .map(function (b) { return b.id; });

    // 先本地生效，界面立刻更新；提交在后面慢慢走
    if (state.data) state.data.products = list;
    refresh('products');

    // 照片这类新文件只是新增，不会冲突，先单独提交
    var pre = (extraFiles && extraFiles.length)
      ? GitStore.commit(extraFiles, message + '（照片）')
      : Promise.resolve();

    return pre.then(function () {
      return GitStore.updateJSON('settings.json', function (remote) {
        var base = remote || {};
        var rp = base.products || [];
        var seen = {};
        var out = rp.filter(function (p) { return removed.indexOf(p.id) < 0; })
          .map(function (p) { seen[p.id] = 1; return kept[p.id] || p; });
        list.forEach(function (p) { if (!seen[p.id]) out.push(p); });
        base.products = out;
        return base;
      }, message);
    }).then(loadData).then(function () { refresh('products'); });
  }

  /* 把一件产品并进另一件：购买记录、照片、评价、款式全部并过去。
     同一件东西的不同款式/色号本来就该是一条 —— 敷尔佳那 8 个面膜、
     眉笔的几个色号，分开列既占地方，也看不出「这东西我一共买过几次」。 */
  function mergeProductInto(fromId, toId) {
    var all = allProducts();
    var from = all.filter(function (x) { return x.id === fromId; })[0];
    var to = all.filter(function (x) { return x.id === toId; })[0];
    if (!from || !to || fromId === toId) return;

    var label = shortName(from);
    /* 款式名要归一化：一个名字包含另一个就算同一个款式，留短的。
       不然「积雪草」和「积雪草面膜舒缓修护贴」会并排列出来，
       其实是同一款。 */
    var addV = function (list, v) {
      v = String(v || '').trim();
      if (!v) return list;
      for (var i = 0; i < list.length; i++) {
        if (list[i].indexOf(v) >= 0) { list[i] = v; return list; }   // 新的更短，换掉
        if (v.indexOf(list[i]) >= 0) return list;                     // 已有更短的，不加
      }
      list.push(v);
      return list;
    };
    var vs = variantList(to).slice();
    variantList(from).forEach(function (v) { addV(vs, v); });
    // 被并进来的那件，它的显示名本身就是一个款式
    if (label !== shortName(to)) addV(vs, label);

    var buys = (to.purchases || []).concat(
      (from.purchases || []).map(function (b) {
        return b.spec ? b : Object.assign({}, b, { spec: label });
      })
    ).sort(function (x, y) { return (x.date || '') < (y.date || '') ? 1 : -1; });

    var merged = Object.assign({}, to, {
      variants: vs,
      purchases: buys,
      photos: (to.photos || []).concat(
        (from.photos || []).filter(function (p) { return (to.photos || []).indexOf(p) < 0; })),
      reviews: (to.reviews || []).concat(from.reviews || []),
      start: [to.start, from.start].filter(Boolean).sort()[0] || to.start,
    });

    var next = all.filter(function (x) { return x.id !== fromId; })
      .map(function (x) { return x.id === toId ? merged : x; });

    saveProducts(next, '产品库：把「' + label + '」并进「' + shortName(to) + '」')
      .then(function () {
        // 历史记录里引用的是被并掉那件，改指到合并后那件
        return renameInEntries(fromId, toId);
      })
      .then(function () { toast('已并入' + shortName(to)); })
      .catch(function (e) { toast('合并失败：' + (e.message || e), true); });
  }


  /* 点产品第一行的名字就能改。
     这是【到处引用的那个名字】：时间线、记一条、对比都取它。
     藏在「展开详情 → ✎ → 表单」后面太深了，用户反复说找不到。 */
  function openRenameBox(pid, card) {
    if (card.querySelector('.rn-box')) return;
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p) return;
    var box = el(
      '<div class="inline-edit rn-box">' +
        '<div class="tiny" style="margin-bottom:6px">显示名（时间线、记一条都用这个）</div>' +
        '<input type="text" id="rn-v" value="' + esc(shortName(p)) + '">' +
        '<div class="tiny hint" style="margin-top:6px">全名「' + esc(p.name) + '」不会动</div>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">保存</button>' +
        '</div>' +
      '</div>'
    );
    card.appendChild(box);
    var input = box.querySelector('#rn-v');
    input.focus();
    input.select();
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var v = input.value.trim();
      if (!v) return toast('名字不能空', true);
      var oldName = shortName(p);
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      if (v === oldName) return;
      var next = allProducts().map(function (x) {
        return x.id === pid ? Object.assign({}, x, { short: v }) : x;
      });
      saveProducts(next, '产品库：改显示名 ' + oldName + ' → ' + v)
        .then(function () { toast('已改成「' + v + '」'); })
        .catch(function (e) { toast('失败：' + (e.message || e), true); });
    });
  }

  function openMergePicker(fromId, anchor) {
    if (document.getElementById('mg-box')) return;
    var from = allProducts().filter(function (x) { return x.id === fromId; })[0];
    if (!from) return;
    var same = allProducts().filter(function (p) {
      return p.id !== fromId && kindOf(p) === kindOf(from);
    });
    if (!same.length) return toast('没有可以并入的产品', true);

    var box = el(
      '<div class="inline-edit" id="mg-box">' +
        '<div class="tiny" style="margin-bottom:8px">把「' + esc(shortName(from)) +
          '」并进哪一件？它会变成对方的一个款式。</div>' +
        '<select id="mg-to">' + same.map(function (p) {
          return '<option value="' + esc(p.id) + '">' + esc(shortName(p)) + '</option>';
        }).join('') + '</select>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">合并</button>' +
        '</div>' +
      '</div>'
    );
    anchor.appendChild(box);
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var to = box.querySelector('#mg-to').value;
      box.remove();
      mergeProductInto(fromId, to);
    });
  }

  function removeProduct(id) {
    var p = allProducts().filter(function (x) { return x.id === id; })[0];
    if (!p || !confirm('从产品库删除「' + p.name + '」？')) return;
    saveProducts(allProducts().filter(function (x) { return x.id !== id; }), '产品库：删除 ' + p.name)
      .then(function () { toast('已删除'); })
      .catch(function (e) { toast('失败：' + e.message, true); });
  }

  function toggleProduct(id) {
    var today = todayISO();
    var list = allProducts().map(function (x) {
      if (x.id !== id) return x;
      var y = Object.assign({}, x);
      if (y.status === 'retired') { y.status = 'using'; delete y.end; }
      else { y.status = 'retired'; y.end = today; }   // 停用要记下日期
      if (!y.start) y.start = y.addedAt || today;
      return y;
    });
    saveProducts(list, '产品库：切换状态')
      .then(function () { toast('已更新'); })
      .catch(function (e) { toast('失败：' + (e.message || e), true); });
  }

  /* 手动加一件：就地展开完整表单，字段和产品详情的编辑态完全一致。
     以前是连着四个 prompt() 弹窗、且只能填名字和品牌 ——
     App 里其它地方都是页内编辑，只有这里弹窗，交互不一致。 */
  var newShots = null;

  function addProductManually(btn) {
    newShots = null;
    if (btn.nextElementSibling && btn.nextElementSibling.classList.contains('inline-edit')) {
      return btn.nextElementSibling.remove();
    }
    var rows = PROD_FIELDS.map(function (f) {
      return '<label class="pd-row"><span>' + esc(f.label) + '</span>' +
        '<input type="' + f.type + '" data-f="' + f.k + '" ' +
        (f.ph ? 'placeholder="' + esc(f.ph) + '" ' : '') +
        (f.k === 'start' ? 'value="' + esc(todayISO()) + '" ' : '') + '>' +
        (f.unit ? '<i>' + f.unit + '</i>' : '') + '</label>';
    }).join('');

    var box = el('<div class="inline-edit">' +
      '<div class="segmented" id="newKind">' +
        KINDS.map(function (k, i) {
          return '<button type="button" data-v="' + k.key + '"' +
            (i === 1 ? ' class="on"' : '') + '>' + esc(k.label) + '</button>';
        }).join('') +
      '</div>' +
      /* 手动添加也能配照片：拍一张，认出来的信息直接填进下面的空格 */
      '<button class="more-toggle" type="button" id="newShot">＋ 拍张照自动填</button>' +
      '<span class="tiny" id="newShotMsg"></span>' + rows +
      '<div class="ie-act">' +
        '<button class="ie-cancel" type="button">取消</button>' +
        '<button class="ie-ok" type="button">入库</button>' +
      '</div></div>');
    btn.insertAdjacentElement('afterend', box);

    var kind = 'skincare';
    box.querySelector('#newShot').addEventListener('click', function () {
      if (!ensureKey()) return;
      var msg = box.querySelector('#newShotMsg');
      var inp = $('#prodShotInput');
      inp.onchange = function () {
        var files = Array.prototype.slice.call(this.files);
        this.value = '';
        if (!files.length) return;
        msg.textContent = '识别中…';
        Promise.all(files.map(function (f) {
          return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
        })).then(function (blobs) {
          newShots = blobs;
          return PrettierAI.identifyProducts(blobs);
        }).then(function (found) {
          var x = (found.products || [])[0];
          if (!x) { msg.textContent = '没认出产品信息，手填也行'; return; }
          // 只填空着的格子，你已经写过的不动
          $$('[data-f]', box).forEach(function (inp2) {
            var v = x[inp2.dataset.f];
            if (v != null && v !== '' && !inp2.value) inp2.value = v;
          });
          var short = box.querySelector('[data-f="short"]');
          if (short && !short.value) short.value = x.short || ((x.brand || '') + (x.name || ''));
          msg.textContent = '已填入，检查一下再入库';
        }).catch(function (e) { msg.textContent = '识别失败：' + (e.message || e); });
      };
      inp.click();
    });

    box.querySelector('#newKind').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      kind = b.dataset.v;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
    });

    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var p = { id: 'p' + Date.now().toString(36), kind: kind,
                status: 'using', addedAt: todayISO() };
      $$('input[data-f]', box).forEach(function (inp) {
        var v = inp.value.trim();
        if (!v) return;
        p[inp.dataset.f] = inp.type === 'number' ? Number(v) : v;
      });
      if (!p.name) return toast('至少写个名字', true);
      if (!p.start) p.start = todayISO();

      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();

      // 刚才拍的照片一起存进去
      var files = null;
      if (newShots && newShots.length) {
        var stamp = Date.now().toString(36);
        files = newShots.map(function (b, i) {
          return { path: 'products/' + p.id + '-' + stamp + '-' + i + '.jpg', blob: b };
        });
        p.photos = files.map(function (f) { return f.path; });
        newShots = null;
      }

      saveProducts(allProducts().concat([p]), '产品库：添加 ' + p.name, files)
        .then(function () { toast('已入库'); refresh('products'); })
        .catch(function (e) { toast('失败：' + e.message, true); });
    });
  }


  /* 识别结果里凡是带了价格/规格/日期的，都当成一次购买记录下来。
     用户反馈：「上传的照片多了时间、价格、容量等信息，你没补进去」——
     以前只往产品字段里塞，字段非空就被跳过，等于白认。 */
  function buyFrom(x) {
    var price = x.price != null && x.price !== '' ? Number(x.price) : null;
    var size = x.size || '';
    var date = /^\d{4}-\d{2}-\d{2}$/.test(x.boughtAt || '') ? x.boughtAt : todayISO();
    if (price == null && !size && !x.where) return null;
    var b = { date: date, at: nowLocal() };   // at 是记录动作的时间点，展示只用 date
    if (price != null && !isNaN(price)) b.price = price;
    if (size) b.size = size;
    if (x.where) b.where = x.where;
    if (x.spec) b.spec = x.spec;
    return b;
  }

  /* 同一单只记一次。
     判断「是不是同一单」看订单本身：日期 + 价格 + 规格都一样就是同一单 ——
     同一张截图传两次、或同一单里截了两张图，都不该变成两条记录。 */
  /* 同一天、同价、同渠道，且款式不冲突 → 同一单。
     「款式不冲突」= 有一边没写款式，或者写的只是数量（2片装）。
     ⚠️ 不能只看日期和价格：同一天用同样的价格买了两个不同款式，
     那是两张订单（依克多因和透明质酸就各是一单），合掉就丢记录了。 */
  function buyVariant(b) {
    var sp = String((b && b.spec) || '').trim();
    return /^\d+\s*[片枚盒支只袋]装?$/.test(sp) ? '' : sp;
  }

  function hasSameBuy(list, b) {
    var bv = buyVariant(b);
    return (list || []).some(function (o) {
      if (o.date !== b.date) return false;
      if ((o.price == null ? '' : o.price) !== (b.price == null ? '' : b.price)) return false;
      if ((o.where || '') !== (b.where || '')) return false;
      var ov = buyVariant(o);
      return !ov || !bv || ov === bv;
    });
  }

  /* 单个产品补拍：直接指定是哪一件，不走去重猜名字。
     用户要的是「这件东西我又看到了新信息，补进去」，
     而不是「认认看这是什么」—— 后者才需要匹配。 */
  function shootProduct(pid, files, statusEl) {
    if (!files || !files.length) return;
    if (!ensureKey()) return;
    statusEl.textContent = '识别中…';

    Promise.all(Array.prototype.slice.call(files).map(function (f) {
      return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
    })).then(function (blobs) {
      return PrettierAI.identifyProducts(blobs).then(function (found) {
        var x = (found.products || [])[0];
        if (!x) throw new Error('这张照片上没认出产品信息');

        var stamp = Date.now().toString(36);
        var shots = blobs.map(function (b, i) {
          return { path: 'products/' + pid + '-' + stamp + '-' + i + '.jpg', blob: b };
        });

        var next = allProducts().map(function (p) {
          if (p.id !== pid) return p;
          var add = {};
          // 只补空的，你自己填过的不动
          ['brand', 'category', 'size', 'price', 'spec', 'note'].forEach(function (f) {
            if ((p[f] === undefined || p[f] === '') && x[f]) add[f] = x[f];
          });
          var buy = buyFrom(x);
          if (buy && !hasSameBuy(p.purchases, buy)) {
            add.purchases = (p.purchases || []).concat([buy]);
          }
          add.photos = (p.photos || []).concat(shots.map(function (s) { return s.path; }));
          return Object.assign({}, p, add);
        });

        var got = [x.size, x.price ? x.price + ' 元' : '', x.spec].filter(Boolean).join(' · ');
        statusEl.textContent = got ? '认出：' + got : '照片已存下，没认出新字段';
        return saveProducts(next, '产品库：从照片补充信息', shots);
      });
    }).then(function () {
      refresh('products');
    }).catch(function (e) {
      statusEl.textContent = '失败：' + (e.message || e);
    });
  }


  /* 反复上传同一件产品，识别用的原图会攒一堆重复的。
     删除要连仓库里的文件一起删 —— 只从列表里摘掉，图还占着空间。 */
  function deleteProductShot(pid, idx) {
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p || !p.photos || !p.photos[idx]) return;
    var path = p.photos[idx];
    if (!confirm('删掉这张识别用的照片？')) return;

    var next = allProducts().map(function (x) {
      if (x.id !== pid) return x;
      return Object.assign({}, x, {
        photos: x.photos.filter(function (_, i) { return i !== idx; }),
      });
    });
    saveProducts(next, '产品库：删掉一张识别照片')
      .then(function () { return GitStore.commitDelete([path], '删除照片 ' + path); })
      .then(function () { refresh('products'); })
      .catch(function (e) { toast('删除失败：' + (e.message || e), true); });
  }

  /* 拍产品 → AI 识别 → 只把【库里没有的】加进去 */
  function scanProducts(files) {
    if (!files || !files.length) return;
    if (!ensureKey()) return;

    var n = files.length;
    var picked = Array.prototype.slice.call(files);
    toast('已加入后台识别（' + n + ' 张）');
    enqueue({
      label: '识别 ' + n + ' 张产品照',
      refreshView: 'products',
      run: function (step) { return scanProductsJob(picked, step); },
    });
  }

  /* 一张一张识别，不整批送。
     以前是把整批照片一次送给模型，然后把【这一批的全部照片】
     挂到每一件认出来的产品上 —— 一次传 24 张订单截图，
     每件产品下面就挂了 24 张，只有一张真跟它有关。
     一张一张来还有个好处：一张订单截图本来就只对应一件商品，
     模型不用在多张之间猜谁是谁。 */
  function scanProductsJob(files, step) {
    var stamp = Date.now().toString(36);
    var addedNames = [], patchedNames = [];

    return files.reduce(function (chain, f, idx) {
      return chain.then(function () {
        step('第 ' + (idx + 1) + '/' + files.length + ' 张');
        return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
      }).then(function (blob) {
        return PrettierAI.identifyProducts([blob]).then(function (found) {
          var list = (found.products || []);
          if (!list.length) return null;

          var path = 'products/' + stamp + '-' + idx + '.jpg';
          var existing = allProducts();
          var keyOf = function (x) {
            return String(x.short || x.name || '')
              .replace(/[\s·・\-—_（）()【】\[\]]/g, '').toLowerCase();
          };
          var merged = existing.slice();
          var newOnes = [];

          list.forEach(function (x) {
            var at = merged.findIndex(function (p) {
              return keyOf(p) === keyOf(x) || p.name === x.name;
            });
            var buy = buyFrom(x);

            if (at < 0) {
              var np = {
                id: 'p' + stamp + idx,
                name: x.name, short: x.short || '', brand: x.brand || '',
                kind: x.kind || 'skincare', category: x.category || '',
                size: x.size || undefined, price: x.price,
                spec: x.spec || undefined, note: x.note || undefined,
                status: 'using',
                purchases: buy ? [buy] : undefined,
                photos: [path],                 // 只挂自己这一张
                start: (buy && buy.date) || todayISO(),
                addedAt: todayISO(),
              };
              newOnes.push(np);
              addedNames.push(x.short || x.name);
              return;
            }

            var p = merged[at], add = {};
            ['brand', 'category', 'size', 'price', 'spec', 'note', 'short'].forEach(function (k) {
              if ((p[k] === undefined || p[k] === '') && x[k]) add[k] = x[k];
            });
            if (buy && !hasSameBuy(p.purchases, buy)) {
              add.purchases = (p.purchases || []).concat([buy]);
            }
            add.photos = (p.photos || []).concat([path]);
            merged[at] = Object.assign({}, p, add);
            patchedNames.push(shortName(merged[at]));
          });

          return saveProducts(merged.concat(newOnes),
            '产品库：' + (newOnes.length ? '新增 ' + newOnes.length + ' 件' : '补全信息'),
            [{ path: path, blob: blob }]);
        });
      });
    }, Promise.resolve()).then(function () {
      var msg = [];
      if (addedNames.length) msg.push('新增 ' + addedNames.length + ' 件');
      if (patchedNames.length) msg.push('补全 ' + patchedNames.length + ' 处');
      toast(msg.length ? msg.join('，') : '没认出新东西');
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

    openLb();
    renderLightbox();
  }

  /* 直接给一组路径开灯箱。
     openLightbox 是按记录 id 找照片的，产品照片不属于任何记录，走不通。 */
  function openPhotoList(paths, startIdx) {
    if (!paths || !paths.length) return;
    lb.keys = paths.slice();
    lb.i = Math.max(0, Math.min(startIdx || 0, paths.length - 1));
    openLb();
    renderLightbox();
  }

  /* body 加 position:fixed 会让页面滚动位置归零，
     关掉灯箱就回不到刚才那张照片的位置了 —— 开之前记下来，关了再放回去。 */
  var lbScrollY = 0;

  function openLb() {
    lbScrollY = window.scrollY;
    $('#lightbox').hidden = false;
    document.body.classList.add('no-scroll');
    document.body.style.top = -lbScrollY + 'px';
    resetZoom();
  }

  function closeLb() {
    $('#lightbox').hidden = true;
    document.body.classList.remove('no-scroll');
    document.body.style.top = '';
    window.scrollTo(0, lbScrollY);
    resetZoom();
  }


  /* 直接用现成的图片地址开灯箱（草稿里的照片还没进仓库，没有 path）。 */
  function openBlobList(urls, startIdx) {
    if (!urls || !urls.length) return;
    lb.keys = urls.map(function (u) { return { url: u }; });
    lb.i = Math.max(0, Math.min(startIdx || 0, urls.length - 1));
    openLb();
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
    var cur = lb.keys[lb.i];
    // 草稿里的照片直接给地址，不用去仓库找
    if (cur && cur.url) {
      img.src = cur.url;
      img.style.opacity = '1';
      return;
    }
    photoURL(cur).then(function (u) {
      img.src = u;
      img.style.opacity = '1';
    }).catch(function () { img.style.opacity = '1'; });

    // 顺手预取相邻两张，滑动时不用等
    [lb.i - 1, lb.i + 1].forEach(function (j) {
      if (j >= 0 && j < lb.keys.length) photoURL(lb.keys[j]).catch(function () {});
    });
  }

  function step(d) {
    resetZoom();
    if (lb.keys.length < 2) return;
    lb.i = (lb.i + d + lb.keys.length) % lb.keys.length;
    renderLightbox();
  }


  /* 双指放大只作用在照片上。
     iOS 默认的双指缩放是【整页】的，看毛孔时背景跟着一起放大很难受；
     所以给灯箱关掉浏览器手势（touch-action: none），自己算缩放和拖动。 */
  var zm = { s: 1, x: 0, y: 0, d0: 0, s0: 1, px: 0, py: 0, moved: false };

  function applyZoom() {
    var img = $('#lbImg');
    if (!img) return;
    img.style.transform = 'translate(' + zm.x + 'px,' + zm.y + 'px) scale(' + zm.s + ')';
  }

  function resetZoom() {
    zm.s = 1; zm.x = 0; zm.y = 0; zm.moved = false;
    applyZoom();
  }

  function dist(t) {
    var dx = t[0].clientX - t[1].clientX, dy = t[0].clientY - t[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  function bindZoom() {
    var box = $('#lightbox');

    box.addEventListener('touchstart', function (ev) {
      if (ev.touches.length === 2) {
        zm.d0 = dist(ev.touches);
        zm.s0 = zm.s;
        zm.moved = true;
      } else if (ev.touches.length === 1 && zm.s > 1) {
        zm.px = ev.touches[0].clientX - zm.x;
        zm.py = ev.touches[0].clientY - zm.y;
      }
    }, { passive: false });

    box.addEventListener('touchmove', function (ev) {
      if (ev.touches.length === 2) {
        ev.preventDefault();
        zm.s = Math.max(1, Math.min(6, zm.s0 * (dist(ev.touches) / (zm.d0 || 1))));
        if (zm.s === 1) { zm.x = 0; zm.y = 0; }
        applyZoom();
      } else if (ev.touches.length === 1 && zm.s > 1) {
        ev.preventDefault();
        zm.x = ev.touches[0].clientX - zm.px;
        zm.y = ev.touches[0].clientY - zm.py;
        zm.moved = true;
        applyZoom();
      }
    }, { passive: false });

    // 双击放大 / 还原
    var lastTap = 0;
    box.addEventListener('touchend', function (ev) {
      if (ev.touches.length) return;
      var now = ev.timeStamp;
      if (now - lastTap < 300) {
        zm.s = zm.s > 1 ? 1 : 2.5;
        zm.x = 0; zm.y = 0;
        zm.moved = true;
        applyZoom();
      }
      lastTap = now;
    });
  }

  function bindLightbox() {
    var box = $('#lightbox');

    document.addEventListener('click', function (ev) {
      // +N 角标不是「看大图」，是「展开全部」，让它落到时间线自己的处理里
      if (ev.target.closest && ev.target.closest('.more-chip')) return;
      var ph = ev.target.closest && ev.target.closest('.entry-photos .ph');
      if (ph) {
        var wrap = ph.closest('.entry-photos');
        openLightbox(wrap.dataset.id, Number(ph.dataset.idx) || 0);
        return;
      }
      if (ev.target.closest('#lbPrev')) { step(-1); return; }
      if (ev.target.closest('#lbNext')) { step(1); return; }
      /* 点图片本身也退出 —— 大部分看图应用都是这样，
         点背景才关会让人以为卡住了。左右翻页有专门的按钮和横滑。 */
      /* 点照片：左三分之一上一张、右三分之一下一张、中间退出。
         放大状态下不响应 —— 那时候手指是在看细节，不是在翻页。 */
      if (ev.target.id === 'lbImg') {
        if (zm.s > 1 || zm.moved) { zm.moved = false; return; }
        var r = ev.target.getBoundingClientRect();
        var f = (ev.clientX - r.left) / r.width;
        /* 只有一张时两侧也退出。
           否则点到边上会调翻页，而翻页在只有一张时直接 return —— 
           什么都没发生，看起来就是「点了退不出去」。 */
        if (lb.keys.length < 2) closeLb();
        else if (f < 0.25) step(-1);
        else if (f > 0.75) step(1);
        else closeLb();
        return;
      }
      if (ev.target.id === 'lightbox' || ev.target.closest('#lbClose')) closeLb();
    });

    document.addEventListener('keydown', function (ev) {
      if (box.hidden) return;
      if (ev.key === 'Escape') closeLb();
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
    syncAppbarHeight();
    if (window.ResizeObserver) {
      new ResizeObserver(syncAppbarHeight).observe($('.appbar'));
    }
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

      var btn = $('#gateBtn');
      btn.disabled = true;
      btn.textContent = token ? '连接中…' : '进入本地模式…';

      state.owner = parts[0];
      state.repo = parts[1];
      state.token = token;   // 可以为空：空令牌 = 本地模式，记的东西存在这台设备上

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

  /* 绑事件前先确认元素在。
     改版时删掉一个按钮、忘了删对应的 addEventListener，
     就会 null.addEventListener 抛错，把后面整段 init 都带走 ——
     表现是版本号空白、入口失踪，很难联想到根因。 */
  function on(sel, ev, fn) {
    var node = $(sel);
    if (node) node.addEventListener(ev, fn);
    else console.warn('找不到元素：' + sel);
  }

  /* 顶栏高度随安全区变化，量出来写进 CSS 变量，
     吸顶的日期栏就不会被它盖住 */
  /* 日期条要吸在顶栏【下面】，所以得知道顶栏多高。
     ⚠️ 量到 0 千万不能写进去 —— init() 跑的时候 #app 还是 hidden，
     顶栏高度是 0，写进去日期条就吸到视口最顶上，
     正好被顶栏盖住：看起来就是「日期栏没吸顶」。 */
  function syncAppbarHeight() {
    var bar = $('.appbar');
    if (!bar) return;
    var h = Math.round(bar.getBoundingClientRect().height);
    if (!h) return;
    document.documentElement.style.setProperty('--appbar-h', h + 'px');
  }


  /* 装成桌面图标之后，iOS 不会主动检查更新，人就一直用着旧版本 ——
     表现是「明明改好的功能说没做」。主动比一次版本号，不一样就提示。 */
  function checkForUpdate() {
    if (!window.PRETTIER_BUILD) return;
    fetch('assets/version.js?t=' + Date.now(), { cache: 'no-store' })
      .then(function (r) { return r.text(); })
      .then(function (t) {
        /* 手工切字符串而不是用正则 ——
           发布前的检查脚本会先把字符串剥掉再扫函数调用，
           正则字面量里出现引号会让它错位，整份文件都判错。 */
        var i = t.indexOf('v:');
        if (i < 0) return;
        var rest = t.slice(i + 2).replace(/^\s+/, '');
        var q = rest.charAt(0);
        var ver = rest.slice(1, rest.indexOf(q, 1));
        if (!ver || ver === PRETTIER_BUILD.v) return;
        var bar = document.createElement('div');
        bar.id = 'newver';
        bar.innerHTML = '<span>有新版本 ' + esc(ver) + '（当前 ' +
          esc(PRETTIER_BUILD.v) + '）</span><button type="button">立即更新</button>';
        document.body.appendChild(bar);
        bar.querySelector('button').addEventListener('click', function () {
          // 连 Service Worker 的缓存一起清，否则刷新还是拿旧文件
          if (navigator.serviceWorker) {
            navigator.serviceWorker.getRegistrations().then(function (rs) {
              rs.forEach(function (r) { r.unregister(); });
            });
          }
          if (window.caches) {
            caches.keys().then(function (ks) { ks.forEach(function (k) { caches.delete(k); }); })
              .then(function () { location.reload(); });
          } else {
            location.reload();
          }
        });
      })
      .catch(function () {});
  }

  function init() {
    applyTheme(get(LS.theme, 'light'));
    syncAppbarHeight();
    window.addEventListener('resize', syncAppbarHeight);
    window.addEventListener('orientationchange', function () {
      setTimeout(syncAppbarHeight, 300);
    });

    var av = $('#appVersion');
    if (av && window.PRETTIER_BUILD) {
      av.textContent = 'Prettier ' + PRETTIER_BUILD.v + ' · ' + PRETTIER_BUILD.at;
    }

    state.owner = get(LS.owner, '');
    state.repo = get(LS.repo, '');
    state.token = get(LS.token, '');

    bindGate();

    on('#fileInput', 'change', function () {
      onFilesPicked(this.files);
      this.value = '';
    });

    on('.tabbar', 'click', function (ev) {
      var b = ev.target.closest('button');
      if (b) go(b.dataset.view);
    });

    /* 右上角这颗按钮按页面变身份：
       时间线上最常做的是「挑两条比一比」，设置一天也点不了一次。 */
    on('#settingsBtn', 'click', function () {
      if (state.view !== 'timeline') return go('settings');
      selectMode = !selectMode;
      if (!selectMode) cmpSel = [];
      syncTopBtn();
      redrawTimeline();
    });
    on('#trendBtn', 'click', function () { go('trend'); });

    on('#foldAllBtn', 'click', function () {
      allCollapsed = !allCollapsed;
      this.style.transform = allCollapsed ? 'rotate(-90deg)' : '';
      $$('#view-timeline .day').forEach(function (sec) {
        collapsedDays[sec.dataset.date] = allCollapsed;
        sec.classList.toggle('closed', allCollapsed);
        sec.querySelector('.day-body').hidden = allCollapsed;
      });
      if (!allCollapsed) hydratePhotos($('#view-timeline'));
    });

    on('#refreshBtn', 'click', function () {
      if (isEditing() && !confirm('正在编辑的内容会丢失，确定刷新？')) return;
      loadData().then(function () { go(state.view); toast('已刷新'); })
        .catch(function (err) { toast(String(err.message || err), true); });
    });

    // 灯箱：点开后可左右滑动看同一条记录里的全部照片
    bindLightbox();
    bindZoom();
    bindQueueSwipe();
    checkForUpdate();

    if (state.owner && state.repo) {
      showApp();
    } else {
      $('#gate').hidden = false;
      $('#gateRepo').value = (state.owner && state.repo)
        ? state.owner + '/' + state.repo
        : 'wang-piaoliang/prettier-data';
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

    on('#prodInput', 'change', function () {
      scanProducts(this.files);
      this.value = '';
    });
  }

  document.addEventListener('DOMContentLoaded', init);
})();
