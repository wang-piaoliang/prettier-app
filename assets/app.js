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
    tagFilter: null,   // 时间线上按标签筛的时候，筛的是哪个
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
  /* 所有多行输入框都随行数长高。
     用事件委托挂在 document 上，不管框是什么时候造出来的都管用 ——
     一个个去绑总会漏掉新加的地方，用户反复反馈「只留一行，看不到写了什么」。 */
  function fitBox(t) {
    if (!t || t.tagName !== 'TEXTAREA') return;
    /* ⚠️ 元素还没布局出来时 scrollHeight 是 0，
       照着设就变成 2px，而 2px 高的框 scrollHeight 仍然是 0 ——
       从此再也长不回来。所以量不到就把内联高度清掉，交回给 CSS。 */
    if (!t.getClientRects().length) { t.style.height = ''; return; }
    t.style.height = 'auto';
    var h = t.scrollHeight;
    if (!h) { t.style.height = ''; return; }
    t.style.height = Math.min(h + 2, 460) + 'px';
  }

  function autoGrow(root) {
    $$('textarea', root || document).forEach(fitBox);
  }

  document.addEventListener('input', function (ev) { fitBox(ev.target); }, true);
  document.addEventListener('focusin', function (ev) { fitBox(ev.target); }, true);

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

  /* 本地攒下的东西，一旦云端接得上就自己传，不用等人点按钮。
     踩过一次：手机离线时记了一下午，横幅在顶上没被注意到，
     人以为已经存进云端了，第二天在别的设备上看就是「都没了」。 */
  var draining = false;

  function autoDrain() {
    if (draining || !state.token) return;
    var p = GitStore.pending();
    if (!p || !p.total) return;

    draining = true;
    syncDot('busy', '正在补传 ' + p.total + ' 项');
    GitStore.drain(function (t) { syncDot('busy', t); })
      .then(function () {
        draining = false;
        toast('已把本地的 ' + p.total + ' 项传上云端');
        return loadData();
      })
      .catch(function (err) {
        draining = false;
        syncDot('err', '补传失败');
        // 失败不吭声最危险 —— 人会以为已经传上去了
        toast('还有 ' + p.total + ' 项没传上去：' + (err.message || err), true);
        renderPending();
      });
  }

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
        autoDrain();          // 本地还欠着的，连上就自己补传
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
    // 分数就跟在「带妆 / 素颜」旁边，一眼看到这次几分
    if (e.rating != null) {
      pills.push('<span class="pill ' + pillLevel(e.rating) + '">' + e.rating.toFixed(1) + '</span>');
    }
    if (ov != null) pills.push('<span class="pill ' + pillLevel(ov) + '">肤况 ' + ov.toFixed(1) + '</span>');
    if (e.makeup && typeof e.makeup.fit === 'number') {
      pills.push('<span class="pill ' + pillLevel(e.makeup.fit) + '">妆 ' + e.makeup.fit + '</span>');
    }
    if (e.ai) pills.push('<span class="pill accent">AI</span>');
    if (e._pending) pills.push('<span class="pill ok">上传中</span>');

    /* 标签一直是算出来却没画出去的 —— 记了等于没记。
       现在跟分数排在一起，点一下就只看这一处的记录。 */
    var tags = (e.tags || []).map(function (t) {
      return '<button type="button" class="pill accent tag-pill' +
        (state.tagFilter === t ? ' on' : '') + '" data-tagpick="' + esc(t) + '">' +
        esc(t) + '</button>';
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
        '<div class="meta">' + pills.join('') + tags + '</div>' +
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
        ((prod || e.note)
          ? '<div class="entry-detail" id="dt-' + esc(e.id) + '">' +
              prod + noteHTML(e) +
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

  /* 正在按哪个标签筛。挂在时间线顶上，点「看全部」撤掉。 */
  function tagBar() {
    if (!state.tagFilter) return '';
    return '<div class="tag-bar">' +
      '<span class="pill accent">' + esc(state.tagFilter) + '</span>' +
      '<button class="more-toggle" id="tagFilterOff" type="button">看全部</button>' +
    '</div>';
  }

  function renderTimeline() {
    var host = $('#view-timeline');
    var list = newestFirst((state.data && state.data.entries) || []);
    if (state.tagFilter) {
      list = list.filter(function (e) {
        return (e.tags || []).indexOf(state.tagFilter) >= 0;
      });
    }
    if (!list.length) {
      host.innerHTML = state.tagFilter
        ? tagBar() + '<div class="empty"><strong>没有带「' + esc(state.tagFilter) +
          '」的记录</strong>记一条的时候点上这个标签就有了。</div>'
        : '<div class="empty"><strong>还没有记录</strong>点下面的「记一条」开始。</div>';
      if (!host.dataset.bound) { host.dataset.bound = '1'; bindTimeline(host); }
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

    host.innerHTML = tagBar() +

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
      /* 标签要排在最前面：它长在 .entry-head 里，
         让下面的折叠先接到的话，点标签只会把这条收起来。 */
      var tg = ev.target.closest('[data-tagpick]');
      if (tg) {
        state.tagFilter = state.tagFilter === tg.dataset.tagpick ? null : tg.dataset.tagpick;
        window.scrollTo(0, 0);
        return redrawTimeline();
      }
      if (ev.target.closest('#tagFilterOff')) {
        state.tagFilter = null;
        return redrawTimeline();
      }
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
      weightHTML() + workoutHTML() + bodyHTML() + careHTML() + memoHTML() +
      foldSection('ml', '在跟的问题', ml.map(card).join('')) +
      procedureHTML() + mapHTML();

    bindSkinMap(host);
    hydratePhotos(host);
    // 第一次进主线才去拉地图数据，拉到再重画一次
    if (!skinMap) {
      loadSkinMap().then(function (d) { if (d) refresh('mainlines'); });
    }

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

        var aWk = ev.target.closest('#addWorkout');
        if (aWk) return openWorkoutEditor(aWk.closest('.care-add'));
        var wkE = ev.target.closest('[data-wk-edit]');
        if (wkE) return openWorkoutEditor(wkE.closest('.care-row'), wkE.dataset.wkEdit);
        var wkD = ev.target.closest('[data-wk-del]');
        if (wkD) return deleteWorkout(wkD.dataset.wkDel);

        var aBd = ev.target.closest('#addBody');
        if (aBd) return openBodyEditor(aBd.closest('.care-add'));
        var bdE = ev.target.closest('[data-bd-edit]');
        if (bdE) return openBodyEditor(bdE.closest('.care-row'), bdE.dataset.bdEdit);
        var bdD = ev.target.closest('[data-bd-del]');
        if (bdD) return deleteBody(bdD.dataset.bdDel);

        var aMe = ev.target.closest('#addMemo');
        if (aMe) return openMemoEditor(aMe.closest('.care-add'));
        var aTd = ev.target.closest('#addTodo');
        if (aTd) return openMemoEditor(aTd.closest('.care-add'), null, true);
        var meC = ev.target.closest('[data-memo-check]');
        if (meC) return toggleMemoDone(meC.dataset.memoCheck);
        var meE = ev.target.closest('[data-memo-edit]');
        if (meE) return openMemoEditor(meE.closest('.care-row'), meE.dataset.memoEdit);
        var meD = ev.target.closest('[data-memo-del]');
        if (meD) return deleteMemo(meD.dataset.memoDel);

        var aPc = ev.target.closest('#addProc');
        if (aPc) return openProcEditor(aPc.closest('.care-add'), null);
        var pcE = ev.target.closest('[data-pc-edit]');
        if (pcE) return openProcEditor(pcE.closest('.care-row'), pcE.dataset.pcEdit);
        var pcD = ev.target.closest('[data-pc-del]');
        if (pcD) return deleteProc(pcD.dataset.pcDel);
        var pcS = ev.target.closest('[data-pc-shoot]');
        if (pcS) return pickProcShots(pcS.dataset.pcShoot);
        var pcX = ev.target.closest('[data-pc-shot-del]');
        if (pcX) return deleteProcShot(pcX.dataset.pcShotDel, Number(pcX.dataset.i));
        var pcV = ev.target.closest('[data-pc-shot]');
        if (pcV) return openProcShot(pcV.dataset.pcShot, Number(pcV.dataset.i));

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



  /* ================= 皮肤地图 =================
     从 skin 那份分析同步过来：5 张照片、50 处标注、7 类分色。
     原页面是左图右列的桌面布局，手机上放不下 ——
     这里改成图在上、条目在下，点哪边另一边跟着高亮。

     照片存在仓库里当普通图片，走已有的懒加载和 IndexedDB 缓存；
     不像原页面那样 base64 内嵌，每次打开都要拉 1.7MB。 */

  var MAP_COLORS = {
    abnom: '#7b6aa8',
    lentigo: '#b98a4a',
    nevus: '#6b4f3f',
    comedo: '#4a6b7b',
    pore: '#5f8a6a',
    acne: '#b05a52',
    redness: '#c07a86',
  };

  var skinMap = null;        // 加载后的 json
  var mapPhoto = 0;          // 当前看第几张
  var mapCats = null;        // 打开着的分类
  var mapPick = null;        // 当前高亮的标注

  function loadSkinMap() {
    if (skinMap) return Promise.resolve(skinMap);
    return GitStore.readJSON('skin-map.json').then(function (d) {
      skinMap = d;
      if (d && !mapCats) mapCats = Object.keys(d.cats || {});
      return d;
    }).catch(function () { return null; });
  }

  function mapHTML() {
    if (!skinMap || !(skinMap.photos || []).length) {
      return foldSection('map', '皮肤地图',
        '<div class="card"><div class="tiny">加载中…</div></div>');
    }
    var p = skinMap.photos[Math.min(mapPhoto, skinMap.photos.length - 1)];
    var cats = skinMap.cats || {};
    var on = function (c) { return mapCats.indexOf(c) >= 0; };

    // 每类各有多少处，关掉时也看得见数量
    var cnt = {};
    skinMap.photos.forEach(function (ph) {
      (ph.marks || []).forEach(function (m) { cnt[m.cat] = (cnt[m.cat] || 0) + 1; });
    });

    var chips = Object.keys(cats).map(function (c) {
      return '<button type="button" class="mapchip' + (on(c) ? '' : ' off') + '" ' +
        'data-mapcat="' + esc(c) + '" style="--mc:' + MAP_COLORS[c] + '">' +
        '<i></i>' + esc(cats[c]) + '<b>' + (cnt[c] || 0) + '</b></button>';
    }).join('');

    var tabs = skinMap.photos.map(function (ph, i) {
      return '<button type="button" class="maptab' + (i === mapPhoto ? ' on' : '') + '" ' +
        'data-mapph="' + i + '">' + (i + 1) + '</button>';
    }).join('');

    var marks = (p.marks || []).map(function (m, i) {
      if (!on(m.cat)) return '';
      return '<span class="mk' + (m.shape === 'region' ? ' region' : '') +
        (mapPick === i ? ' on' : '') + '" data-mapmk="' + i + '" style="--mc:' +
        MAP_COLORS[m.cat] + ';left:' + m.x + '%;top:' + m.y + '%;width:' + m.w +
        '%;height:' + m.h + '%"><b>' + (i + 1) + '</b></span>';
    }).join('');

    var items = (p.marks || []).map(function (m, i) {
      if (!on(m.cat)) return '';
      return '<div class="mapitem' + (mapPick === i ? ' on' : '') + '" data-mapmk="' + i + '" ' +
        'style="--mc:' + MAP_COLORS[m.cat] + '">' +
        '<span class="mi-n">' + (i + 1) + '</span>' +
        '<div><div class="mi-c">' + esc(cats[m.cat] || m.cat) + '</div>' +
        '<h5>' + esc(m.title) + (m.flag ? '<span class="mi-flag">请医生看</span>' : '') + '</h5>' +
        (m.desc ? '<p>' + esc(m.desc) + '</p>' : '') + '</div></div>';
    }).join('');

    var total = skinMap.photos.reduce(function (n, x) { return n + (x.marks || []).length; }, 0);

    return foldSection('map', '皮肤地图',
      '<div class="card mapcard">' +
        '<div class="tiny" style="margin-bottom:10px">' +
          esc(skinMap.source || '') + ' · 共 ' + total + ' 处标注</div>' +
        '<div class="mapbar">' + chips + '</div>' +
        '<div class="maptabs">' + tabs +
          '<span class="mapname">' + esc(p.title) + '</span></div>' +
        '<div class="mapstage">' +
          '<img data-key="skin-map/' + esc(p.file) + '" alt="">' +
          '<div class="maplayer">' + marks + '</div>' +
        '</div>' +
        '<div class="maplist">' + items + '</div>' +
      '</div>');
  }

  function bindSkinMap(host) {
    if (host.dataset.mapBound) return;
    host.dataset.mapBound = '1';
    host.addEventListener('click', function (ev) {
      var c = ev.target.closest('[data-mapcat]');
      if (c) {
        var k = c.dataset.mapcat, at = mapCats.indexOf(k);
        if (at >= 0) mapCats.splice(at, 1); else mapCats.push(k);
        mapPick = null;
        return refresh('mainlines');
      }
      var t = ev.target.closest('[data-mapph]');
      if (t) { mapPhoto = Number(t.dataset.mapph); mapPick = null; return refresh('mainlines'); }
      var m = ev.target.closest('[data-mapmk]');
      if (m) {
        var i = Number(m.dataset.mapmk);
        mapPick = (mapPick === i) ? null : i;
        return refresh('mainlines');
      }
    });
  }

  /* ================= 标签库 =================
     这些一排排的小标签，原来是写死在代码里的常量 ——
     想加一个「泪沟」得来找我改代码。现在整块存进 settings.json，
     在哪儿用就在哪儿加、改名、拿掉。

     两条规矩：
       · 改名连着已有的记录一起改。否则同一处会裂成两个名字，筛的时候漏一半。
       · 拿掉只是这排里不再出现，已经记下的记录一个字都不动 ——
         标签是给以后挑的，不是用来抹掉过去的。 */

  var TAG_SETS = {
    zone: {
      label: '部位',
      ph: '新部位，比如「泪沟」',
      def: ['下巴', '泪沟', '黑头', '脸颊', '鼻翼', '额头', '法令纹', '眼下', '唇周', '痘印'],
    },
    /* 运动这组带 key：记录里存的是 key，所以改名字不用动老记录 */
    sport: {
      label: '运动',
      ph: '新项目，比如「普拉提」',
      keyed: true,
      def: [
        { k: 'swim', label: '游泳' },
        { k: 'gym', label: '健身' },
        { k: 'run', label: '跑步' },
        { k: 'climb', label: '攀岩' },
        { k: 'yoga', label: '瑜伽' },
        { k: 'walk', label: '走路' },
        { k: 'other', label: '其他' },
      ],
    },
    gym: { label: '健身部位', ph: '新部位，比如「肩」',
           def: ['背', '臀', '上肢', '下肢', '核心', '全身'] },
    body: {
      label: '身体',
      ph: '还有什么情况，比如「拉肚子」',
      def: ['姨妈', '睡不好', '头疼', '胃疼', '腰酸', '肩颈',
            '嗓子疼', '感冒', '过敏', '乏力', '水肿', '便秘'],
    },
    proc: {
      label: '医美项目',
      ph: '还做过什么，比如「热玛吉」',
      def: ['光子嫩肤', '超皮秒', '热玛吉', '超声炮', '水光针',
            '肉毒素', '玻尿酸', '点阵激光', '果酸焕肤', '小气泡'],
    },
    mkstate: {
      label: '持妆状态',
      ph: '新状态，比如「浮粉」',
      def: ['泛油光', '斑驳', '卡粉', '脱妆', '暗沉', '干纹', '完好'],
    },
    light: {
      label: '光线',
      ph: '新光线，比如「浴室灯」',
      def: ['窗边自然光', '室内暖光', '室内白光', '近距离侧光', '均匀正面光', '室外'],
    },
  };

  /* 对外一律是 [{k, label}]。不带 key 的那几组，k 就是它自己的名字 ——
     组件不用关心哪组带 key，存的时候再变回去。 */
  function tagItems(setKey) {
    var set = TAG_SETS[setKey] || { def: [] };
    var saved = state.data && state.data.tags && state.data.tags[setKey];
    var raw = (saved && saved.length) ? saved : set.def;
    return raw.map(function (t) {
      return typeof t === 'string'
        ? { k: t, label: t }
        : { k: t.k || t.key, label: t.label || t.k || t.key };
    });
  }

  function tagLabel(setKey, k) {
    var hit = tagItems(setKey).filter(function (t) { return t.k === k; })[0];
    return hit ? hit.label : (k || '');
  }

  /* 存一组标签。顺带把改名铺到老记录上 ——
     健身部位和整份 settings 一起提交，免得两次写打架。 */
  function saveTagSet(setKey, items, renames) {
    var all = Object.assign({}, (state.data && state.data.tags) || {});
    all[setKey] = TAG_SETS[setKey].keyed
      ? items.map(function (t) { return { k: t.k, label: t.label }; })
      : items.map(function (t) { return t.label; });

    var map = {};
    (renames || []).forEach(function (r) { map[r.from] = r.to; });
    var swap = function (arr) {
      return (arr || []).map(function (x) { return map[x] || x; });
    };
    var hasRename = Object.keys(map).length > 0;

    var ws = null;
    if (setKey === 'gym' && hasRename) {
      ws = ((state.data && state.data.workouts) || []).map(function (w) {
        return w.parts ? Object.assign({}, w, { parts: swap(w.parts) }) : w;
      });
    }

    if (state.data) {
      state.data.tags = all;              // 先本地生效，界面立刻跟上
      if (ws) state.data.workouts = ws;
    }

    var p = GitStore.updateJSON('settings.json', function (remote) {
      var base = remote || {};
      base.tags = all;
      if (ws) base.workouts = ws;
      return base;
    }, '标签 · ' + TAG_SETS[setKey].label);

    // 记录里存的是标签原文的那两组，得回头把 entries.json 也改了
    var field = setKey === 'zone' ? 'tags' : (setKey === 'mkstate' ? 'makeupState' : null);
    if (field && hasRename) {
      ((state.data && state.data.entries) || []).forEach(function (e) {
        if (e[field]) e[field] = swap(e[field]);
      });
      p = p.then(function () {
        return GitStore.updateJSON('entries.json', function (remote) {
          return (remote || []).map(function (e) {
            if (!e[field]) return e;
            var n = Object.assign({}, e);
            n[field] = swap(e[field]);
            return n;
          });
        }, '标签改名 · ' + Object.keys(map).map(function (k) {
          return k + '→' + map[k];
        }).join('、'));
      });
    }
    return p.catch(function (e) { toast('标签没存上：' + (e.message || e), true); });
  }

  /* 一排能自己加、改名、拿掉的小标签。
     谁要用就给一个容器和一份配置，剩下的它自己管。
     cfg: { isOn(k), onPick(k), onRename(map), extra() -> 选中但库里没有的, sub }

     为什么不做成一个「设置里的标签管理页」：想加标签的时刻永远是
     正在记录、发现没这一项的时刻，跑去设置页再回来，这条记录就记不完了。 */
  function mountTagRow(host, setKey, cfg) {
    var st = { manage: false, adding: false, rows: null, focusLast: false };

    function chipsHTML() {
      var items = tagItems(setKey);
      var known = {};
      items.forEach(function (t) { known[t.k] = 1; });
      // 库里没有、但这条记录上有的（早先手打的、AI 填的）也得露出来，
      // 否则它明明记着、界面上却一个都看不见
      var extra = (cfg.extra ? cfg.extra() : []).filter(function (x) { return !known[x]; });
      var chip = function (k, label, on) {
        return '<button type="button" class="pchip' + (cfg.sub ? ' vsub' : '') +
          (on ? ' on' : '') + '" data-tk="' + esc(k) + '">' + esc(label) + '</button>';
      };
      return '<div class="pick tag-row">' +
        items.map(function (t) { return chip(t.k, t.label, cfg.isOn(t.k)); }).join('') +
        extra.map(function (x) { return chip(x, x, true); }).join('') +
        '<button type="button" class="pchip tag-op" data-tadd="1">＋</button>' +
        '<button type="button" class="pchip tag-op" data-tmgr="1">管理</button>' +
      '</div>' +
      (st.adding
        ? '<div class="tag-new">' +
            '<input type="text" placeholder="' +
              esc(TAG_SETS[setKey].ph || '新标签') + '">' +
            '<button type="button" class="more-toggle" data-tsave="1">加上</button>' +
          '</div>'
        : '');
    }

    function mgrHTML() {
      return '<div class="tag-mgr">' +
        '<div class="tiny">改名字直接在框里改，已有的记录跟着一起改；' +
          '× 是从这排里拿掉，记过的一个字都不动。</div>' +
        st.rows.map(function (t, i) {
          return '<div class="tm-row">' +
            '<input type="text" data-ti="' + i + '" value="' + esc(t.label) + '">' +
            '<button type="button" class="rv-edit" data-tdel="' + i + '" aria-label="拿掉">×</button>' +
          '</div>';
        }).join('') +
        '<div class="care-add" style="margin-top:10px">' +
          '<button type="button" class="more-toggle" data-tadd2="1">＋ 加一个</button>' +
          '<button type="button" class="more-toggle" data-tdone="1">完成</button>' +
        '</div>' +
      '</div>';
    }

    function draw() {
      host.innerHTML = st.manage ? mgrHTML() : chipsHTML();
      if (st.manage && st.focusLast) {
        var all = $$('[data-ti]', host);
        if (all.length) all[all.length - 1].focus();
        st.focusLast = false;
      }
      if (!st.manage && st.adding) {
        var i = $('.tag-new input', host);
        if (i) i.focus();
      }
    }

    // 管理模式下先把框里改过的字收回来，再做增删，免得一重画就白改了
    function syncRows() {
      $$('[data-ti]', host).forEach(function (inp) {
        var row = st.rows[Number(inp.dataset.ti)];
        if (row) row.label = inp.value.trim();
      });
    }

    function apply(exit) {
      var store = tagItems(setKey);
      var byKey = {};
      store.forEach(function (t) { byKey[t.k] = t.label; });
      var renames = [];
      var items = st.rows.filter(function (t) { return t.label; }).map(function (t) {
        if (t.k && byKey[t.k] !== undefined && byKey[t.k] !== t.label) {
          renames.push({ from: byKey[t.k], to: t.label });
        }
        return { k: (TAG_SETS[setKey].keyed && t.k) ? t.k : (t.k || t.label), label: t.label };
      });
      if (!TAG_SETS[setKey].keyed) {
        items = items.map(function (t) { return { k: t.label, label: t.label }; });
      }
      saveTagSet(setKey, items, renames);
      if (renames.length && cfg.onRename) {
        var map = {};
        renames.forEach(function (r) { map[r.from] = r.to; });
        cfg.onRename(map);
      }
      if (exit) { st.manage = false; st.rows = null; }
      else { st.rows = tagItems(setKey); }
      draw();
    }

    function addNew() {
      var inp = $('.tag-new input', host);
      var v = inp ? inp.value.trim() : '';
      st.adding = false;
      if (!v) return draw();
      var items = tagItems(setKey);
      if (items.filter(function (t) { return t.label === v; }).length) {
        draw();
        return toast('已经有「' + v + '」了');
      }
      var k = TAG_SETS[setKey].keyed ? 'tg' + Date.now().toString(36) : v;
      items.push({ k: k, label: v });
      saveTagSet(setKey, items, []);
      if (cfg.onPick) cfg.onPick(k);      // 加它就是为了这次要用，顺手选上
      draw();
    }

    host.addEventListener('click', function (ev) {
      var t = ev.target.closest('[data-tk]');
      if (t) { if (cfg.onPick) cfg.onPick(t.dataset.tk); return draw(); }
      if (ev.target.closest('[data-tadd]')) { st.adding = !st.adding; return draw(); }
      if (ev.target.closest('[data-tsave]')) return addNew();
      if (ev.target.closest('[data-tmgr]')) {
        st.manage = true; st.adding = false; st.rows = tagItems(setKey);
        return draw();
      }
      var del = ev.target.closest('[data-tdel]');
      if (del) {
        syncRows();
        var gone = st.rows[Number(del.dataset.tdel)];
        if (!gone || !confirm('把「' + gone.label + '」从这排里拿掉？已经记下的记录不动。')) return;
        st.rows.splice(Number(del.dataset.tdel), 1);
        return apply(false);
      }
      if (ev.target.closest('[data-tadd2]')) {
        syncRows();
        st.rows.push({ k: '', label: '' });
        st.focusLast = true;
        return draw();
      }
      if (ev.target.closest('[data-tdone]')) { syncRows(); return apply(true); }
    });

    // 回车就当点了「加上」——手机上收键盘再找按钮太绕
    host.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Enter') return;
      if (ev.target.closest('.tag-new')) { ev.preventDefault(); return addNew(); }
      if (st.manage && ev.target.dataset && ev.target.dataset.ti !== undefined) {
        ev.preventDefault();
        ev.target.blur();
        syncRows();
        apply(false);
      }
    });

    draw();
  }

  /* ================= 运动 =================
     游泳、健身（练了哪几块）、时长。
     记下来是为了和皮肤对照 —— 出汗、作息、强度都会写在脸上。 */


  function workoutList() {
    return ((state.data && state.data.workouts) || []).slice()
      .sort(function (x, y) { return (x.at || '') < (y.at || '') ? 1 : -1; });
  }

  function sportLabel(k) {
    // 删掉的运动、老记录里的 key，都还得显示得出来
    return tagLabel('sport', k) || k || '运动';
  }

  function workoutHTML() {
    var ws = workoutList();

    // 本周和本月各练了多久 —— 这是最想一眼看到的两个数
    var now = new Date();
    var monday = new Date(now);
    monday.setDate(now.getDate() - ((now.getDay() + 6) % 7));
    var wkStart = monday.toISOString().slice(0, 10);
    var moStart = todayISO().slice(0, 7);
    var sum = function (test) {
      return ws.filter(test).reduce(function (n, w) { return n + (w.mins || 0); }, 0);
    };
    var wkMin = sum(function (w) { return (w.at || '').slice(0, 10) >= wkStart; });
    var moMin = sum(function (w) { return (w.at || '').slice(0, 7) === moStart; });
    var wkCnt = ws.filter(function (w) { return (w.at || '').slice(0, 10) >= wkStart; }).length;

    var rows = ws.map(function (w) {
      return '<div class="care-row" data-wkid="' + esc(w.id) + '">' +
        '<div class="cr-top">' +
          '<b>' + esc(fmtDate((w.at || '').slice(0, 10))) + '</b>' +
          '<span class="care-what">' + esc(sportLabel(w.type)) +
            ((w.parts && w.parts.length) ? ' · ' + esc(w.parts.join('、')) : '') + '</span>' +
          (w.mins ? '<span class="pill">' + w.mins + ' 分</span>' : '') +
          '<button class="rv-edit" data-wk-edit="' + esc(w.id) + '" aria-label="改">✎</button>' +
          '<button class="rv-edit" data-wk-del="' + esc(w.id) + '" aria-label="删">×</button>' +
        '</div>' +
        (w.note ? '<div class="cr-note">' + esc(w.note) + '</div>' : '') +
      '</div>';
    });

    return foldSection('sport', '运动', '<div class="card">' +
        '<div class="w-now">' +
          '<span class="w-kg">' + Math.round(wkMin / 60 * 10) / 10 + '<i>小时/本周</i></span>' +
          '<span class="pill">' + wkCnt + ' 次</span>' +
          '<span class="pill">本月 ' + Math.round(moMin / 60 * 10) / 10 + ' 小时</span>' +
        '</div>' +
        '<div class="care-add">' +
          '<button class="more-toggle" id="addWorkout" type="button">＋ 记一次运动</button>' +
        '</div>' +
        (rows.length ? '<div class="w-list">' + limitRows('sport', rows) + '</div>' : '') +
      '</div>');
  }

  function openWorkoutEditor(anchor, editId) {
    if (document.getElementById('wk-edit')) return;
    var cur = editId ? workoutList().filter(function (x) { return x.id === editId; })[0] : null;
    var sel = {
      type: (cur && cur.type) || 'gym',
      parts: (cur && cur.parts) ? cur.parts.slice() : [],
      mins: (cur && cur.mins) || 60,
    };

    /* 类型、部位、时长各占一块。
       原来这三样挤在一个 #wk-body 里，点一下类型就把整块重画 ——
       标签行自己管着「管理 / 加一个」的开合状态，一重画就全没了。 */
    var box = el(
      '<div class="inline-edit" id="wk-edit">' +
        '<input type="date" id="wk-date" value="' +
          (cur ? esc((cur.at || '').slice(0, 10)) : todayISO()) + '">' +
        '<div id="wk-type" style="margin-top:8px"></div>' +
        '<div id="wk-parts" style="margin-top:6px"></div>' +
        '<div class="score-row" style="margin-top:10px">' +
          '<span class="score-val">' + sel.mins + '<i style="font-size:11px"> 分</i></span>' +
          '<input type="range" id="wk-mins" min="10" max="180" step="5" value="' + sel.mins + '">' +
        '</div>' +
        '<textarea id="wk-note" placeholder="备注（可留空）" style="margin-top:8px">' +
          esc((cur && cur.note) || '') + '</textarea>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">' + (cur ? '保存' : '记下') + '</button>' +
        '</div>' +
      '</div>'
    );
    anchor.replaceWith ? anchor.insertAdjacentElement('afterend', box) : anchor.appendChild(box);

    var partsHost = box.querySelector('#wk-parts');
    var drawParts = function () {
      // 只有健身才分部位；换成游泳这一排就该收起来
      if (sel.type !== 'gym') { partsHost.innerHTML = ''; return; }
      mountTagRow(partsHost, 'gym', {
        sub: true,
        isOn: function (k) { return sel.parts.indexOf(k) >= 0; },
        onPick: function (k) {
          var at = sel.parts.indexOf(k);
          if (at >= 0) sel.parts.splice(at, 1); else sel.parts.push(k);
        },
        extra: function () { return sel.parts.slice(); },
        onRename: function (map) {
          sel.parts = sel.parts.map(function (x) { return map[x] || x; });
        },
      });
    };
    mountTagRow(box.querySelector('#wk-type'), 'sport', {
      isOn: function (k) { return sel.type === k; },
      onPick: function (k) { sel.type = k; drawParts(); },
    });
    drawParts();

    box.querySelector('#wk-mins').addEventListener('input', function () {
      sel.mins = Number(this.value);
      box.querySelector('.score-val').innerHTML = sel.mins + '<i style="font-size:11px"> 分</i>';
    });

    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var date = box.querySelector('#wk-date').value || todayISO();
      var rec = {
        id: cur ? cur.id : 'wk' + Date.now().toString(36),
        at: date + 'T' + nowLocal().slice(11),
        type: sel.type,
        parts: sel.type === 'gym' ? sel.parts : undefined,
        mins: sel.mins,
        note: box.querySelector('#wk-note').value.trim() || undefined,
      };
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      saveWorkout(rec);
    });
  }

  function saveWorkout(rec) {
    var list = ((state.data && state.data.workouts) || [])
      .filter(function (x) { return x.id !== rec.id; }).concat([rec]);
    persistList('workouts', list, '运动：' + sportLabel(rec.type));
  }

  function deleteWorkout(id) {
    if (!confirm('删掉这条运动记录？')) return;
    persistList('workouts',
      ((state.data && state.data.workouts) || []).filter(function (x) { return x.id !== id; }),
      '运动：删掉一条');
  }

  /* ================= 身体记录 =================
     哪里不舒服、身体什么情况。单独一块，不并进护肤记录 ——
     那边回答的是「脸上的变化从哪来」，这边回答的是「人怎么样」。
     两件事混在一个列表里，翻的时候谁也看不清。 */

  /* 程度不用 0–5 的滑条。这份档案里分数一律「越高越好」，
     而不舒服是越重越糟，同一个控件两套读法，迟早看反。 */
  var BODY_LEVELS = [
    { k: 'mild', label: '轻', pill: '' },
    { k: 'mid', label: '中', pill: 'ok' },
    { k: 'bad', label: '重', pill: 'watch' },
  ];

  function bodyLevel(k) {
    return BODY_LEVELS.filter(function (x) { return x.k === k; })[0] || null;
  }

  function bodyList() {
    return ((state.data && state.data.bodyLog) || []).slice()
      .sort(function (x, y) { return (x.at || '') < (y.at || '') ? 1 : -1; });
  }

  function bodyHTML() {
    var rows = bodyList().map(function (b) {
      var lv = bodyLevel(b.level);
      return '<div class="care-row" data-bdid="' + esc(b.id) + '">' +
        '<div class="cr-top">' +
          '<b>' + esc(fmtDate((b.at || '').slice(0, 10))) + '</b>' +
          '<span class="care-what">' + esc(b.what || '') + '</span>' +
          (lv ? '<span class="pill ' + lv.pill + '">' + esc(lv.label) + '</span>' : '') +
          '<button class="rv-edit" data-bd-edit="' + esc(b.id) + '" aria-label="改">✎</button>' +
          '<button class="rv-edit" data-bd-del="' + esc(b.id) + '" aria-label="删">×</button>' +
        '</div>' +
        (b.note ? '<div class="cr-note">' + esc(b.note) + '</div>' : '') +
      '</div>';
    });

    return foldSection('body', '身体记录', '<div class="card">' +
        '<div class="care-add">' +
          '<button class="more-toggle" id="addBody" type="button">＋ 记一条</button>' +
        '</div>' +
        (rows.length ? '<div class="w-list">' + limitRows('body', rows) + '</div>'
                     : '<div class="tiny">哪儿不舒服、身体什么情况，记在这儿。' +
                       '睡不好、姨妈、感冒最后都会写在脸上。</div>') +
      '</div>');
  }

  function openBodyEditor(anchor, editId) {
    if (document.getElementById('bd-edit')) return;
    var cur = editId ? bodyList().filter(function (x) { return x.id === editId; })[0] : null;
    var sel = { what: (cur && cur.what) || '', level: (cur && cur.level) || '' };

    /* 标签点了就是选了。
       原来是「点标签 → 同样几个字出现在下面的输入框里 → 还能再改」——
       同一件事在屏幕上写两遍，多出来那个框只让人犹豫以哪个为准。
       缺哪一项就点 ＋ 加进来，下次就在这排里了。产品那边早就是这么定的。 */
    var box = el(
      '<div class="inline-edit" id="bd-edit">' +
        '<div class="tiny ie-lab" style="margin-top:0">哪儿不舒服 / 什么情况</div>' +
        '<div id="bd-pick"></div>' +
        '<div class="tiny ie-lab">程度（不选也行）</div>' +
        '<div class="pick" id="bd-lv">' + BODY_LEVELS.map(function (l) {
          return '<button type="button" class="pchip vsub' + (sel.level === l.k ? ' on' : '') +
            '" data-bdlv="' + l.k + '">' + esc(l.label) + '</button>';
        }).join('') + '</div>' +
        '<div class="w-form" style="margin-top:12px">' +
          '<input type="date" id="bd-date" value="' +
            (cur ? esc((cur.at || '').slice(0, 10)) : todayISO()) + '">' +
        '</div>' +
        '<textarea id="bd-note" placeholder="怎么个不舒服法、吃了什么药、后来怎么样" ' +
          'style="margin-top:8px">' + esc((cur && cur.note) || '') + '</textarea>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">' + (cur ? '保存' : '记下') + '</button>' +
        '</div>' +
      '</div>'
    );
    anchor.insertAdjacentElement('afterend', box);

    mountTagRow(box.querySelector('#bd-pick'), 'body', {
      isOn: function (k) { return sel.what === k; },
      onPick: function (k) { sel.what = (sel.what === k) ? '' : k; },
      // 库里被拿掉、但这条记录还写着的，也得亮着显示，否则改一下就丢了
      extra: function () { return sel.what ? [sel.what] : []; },
      onRename: function (map) { sel.what = map[sel.what] || sel.what; },
    });

    var lvHost = box.querySelector('#bd-lv');
    lvHost.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-bdlv]');
      if (!b) return;
      // 再点一下取消 —— 「姨妈来了」这种不是不舒服，不该被逼着选个程度
      sel.level = (sel.level === b.dataset.bdlv) ? '' : b.dataset.bdlv;
      $$('.pchip', lvHost).forEach(function (x) {
        x.classList.toggle('on', x.dataset.bdlv === sel.level);
      });
    });

    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      if (!sel.what) return toast('先点一个，没有就点 ＋ 加进去', true);
      var date = box.querySelector('#bd-date').value || todayISO();
      var rec = {
        id: cur ? cur.id : 'bd' + Date.now().toString(36),
        // 存到分钟：一天里疼两回也分得清先后
        at: date + 'T' + (cur ? (cur.at || '').slice(11, 16) || '12:00' : nowLocal().slice(11, 16)),
        what: sel.what,
        level: sel.level || undefined,
        note: box.querySelector('#bd-note').value.trim() || undefined,
      };
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      persistList('bodyLog',
        ((state.data && state.data.bodyLog) || [])
          .filter(function (x) { return x.id !== rec.id; }).concat([rec]),
        '身体记录：' + sel.what);
    });
  }

  function deleteBody(id) {
    var b = bodyList().filter(function (x) { return x.id === id; })[0];
    if (!b || !confirm('删掉「' + (b.what || '') + '」这条？')) return;
    persistList('bodyLog',
      ((state.data && state.data.bodyLog) || []).filter(function (x) { return x.id !== id; }),
      '身体记录：删掉一条');
  }

  /* ================= 随手记 =================
     想到什么记什么：用法、教训、下次注意。一条一条的，像备忘录。
     其中一部分是「要做的事」—— 标成待办，做完勾掉，不用删。 */

  function noteList() {
    var all = ((state.data && state.data.notes) || []).slice()
      .sort(function (x, y) { return (x.at || '') < (y.at || '') ? 1 : -1; });
    /* 没勾掉的待办浮到最前。
       待办要是也按时间埋进去，过几天就被新记录挤到「还有 N 条」后面 ——
       「剪剪刘海」就是这么忘掉的。勾掉之后它自己沉回时间里，还查得到。 */
    var todo = all.filter(function (n) { return n.todo && !n.done; });
    return todo.concat(all.filter(function (n) { return !(n.todo && !n.done); }));
  }

  function openTodos() {
    return ((state.data && state.data.notes) || [])
      .filter(function (n) { return n.todo && !n.done; }).length;
  }

  function memoHTML() {
    /* 一条随手记就是一句话，没有「名称 + 备注」两截 —— 别占两行。
       原来上面一行只剩个日期和两个按钮、底下那句话缩在 85px 处，跟谁都对不齐。
       现在摆进中间那一列，和体重、运动、身体记录、医美记录一个排法。 */
    var rows = noteList().map(function (n) {
      var done = !!(n.todo && n.done);
      return '<div class="care-row memo-row' + (n.todo ? ' memo-todo' : '') +
          (done ? ' done' : '') + '" data-memo="' + esc(n.id) + '">' +
        '<div class="cr-top">' +
          '<b>' + esc(fmtDate((n.at || '').slice(0, 10))) + '</b>' +
          '<span class="care-what memo-text">' + esc(n.text || '') + '</span>' +
          /* ⚠ 勾选框放右边。夹在日期和正文之间会把正文往右顶，
             待办行和普通随手记就成了两套缩进，同一列对不齐。 */
          (n.todo
            ? '<button class="todo-box' + (done ? ' on' : '') + '" type="button" ' +
                'data-memo-check="' + esc(n.id) + '" aria-label="' +
                (done ? '取消勾掉' : '勾掉') + '"></button>'
            : '') +
          '<button class="rv-edit" data-memo-edit="' + esc(n.id) + '" aria-label="改">✎</button>' +
          '<button class="rv-edit" data-memo-del="' + esc(n.id) + '" aria-label="删">×</button>' +
        '</div>' +
      '</div>';
    });
    var open = openTodos();

    return foldSection('memo', '随手记', '<div class="card">' +
        '<div class="care-add">' +
          '<button class="more-toggle" id="addMemo" type="button">＋ 记一条</button>' +
          '<button class="more-toggle" id="addTodo" type="button">＋ 记个待办</button>' +
        '</div>' +
        (rows.length ? '<div class="w-list">' + limitRows('memo', rows) + '</div>'
                     : '<div class="tiny">想到什么记什么：用法、教训、下次注意。' +
                       '要做的事记成待办，做完勾掉。</div>') +
      '</div>', open ? open + ' 件待办' : 0);
  }

  function openMemoEditor(anchor, editId, asTodo) {
    if (document.getElementById('memo-edit')) return;
    var cur = editId ? noteList().filter(function (x) { return x.id === editId; })[0] : null;
    var isTodo = cur ? !!cur.todo : !!asTodo;
    var ph = function (t) { return t ? '要做的事，例：剪刘海' : '随手记一条…'; };

    var box = el(
      '<div class="inline-edit" id="memo-edit">' +
        '<div class="pick" style="margin-bottom:8px">' +
          '<button type="button" class="pchip' + (isTodo ? ' on' : '') + '" id="memo-todo">' +
            '待办 · 做完勾掉</button>' +
        '</div>' +
        '<textarea id="memo-text" placeholder="' + ph(isTodo) + '">' +
          esc((cur && cur.text) || '') + '</textarea>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">' + (cur ? '保存' : '记下') + '</button>' +
        '</div>' +
      '</div>'
    );
    anchor.insertAdjacentElement('afterend', box);

    // 记着记着发现「这其实是件要做的事」，随时能翻过去，不用删了重记
    var tBtn = box.querySelector('#memo-todo');
    var ta = box.querySelector('#memo-text');
    tBtn.addEventListener('click', function () {
      isTodo = !isTodo;
      tBtn.classList.toggle('on', isTodo);
      ta.placeholder = ph(isTodo);
    });

    ta.focus();
    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var t = ta.value.trim();
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      if (!t) return;
      var rec = { id: cur ? cur.id : 'me' + Date.now().toString(36),
                  at: cur ? cur.at : nowLocal(), text: t };
      if (isTodo) {
        rec.todo = true;
        // 改一条已经勾掉的待办，别把勾弄丢了
        if (cur && cur.done) { rec.done = true; rec.doneAt = cur.doneAt; }
      }
      persistList('notes',
        ((state.data && state.data.notes) || [])
          .filter(function (x) { return x.id !== rec.id; }).concat([rec]),
        isTodo ? '待办：' + t.slice(0, 12) : '随手记');
    });
  }

  /* 勾掉不是删掉 —— 做过什么本身也是记录，勾掉之后按时间沉下去，还翻得到。 */
  function toggleMemoDone(id) {
    var hit = null;
    var list = ((state.data && state.data.notes) || []).map(function (n) {
      if (n.id !== id) return n;
      var m = Object.assign({}, n, { todo: true });
      if (n.done) { delete m.done; delete m.doneAt; }
      else { m.done = true; m.doneAt = nowLocal(); }
      hit = m;
      return m;
    });
    if (!hit) return;
    if (hit.done && navigator.vibrate) navigator.vibrate(12);
    persistList('notes', list,
      (hit.done ? '待办：勾掉 ' : '待办：撤回 ') + String(hit.text || '').slice(0, 12));
  }

  function deleteMemo(id) {
    if (!confirm('删掉这条？')) return;
    persistList('notes',
      ((state.data && state.data.notes) || []).filter(function (x) { return x.id !== id; }),
      '随手记：删掉一条');
  }

  /* settings.json 里某个列表的通用保存：先本地生效，再后台提交。 */
  function persistList(key, list, message) {
    if (state.data) state.data[key] = list;
    refresh('mainlines');
    return GitStore.updateJSON('settings.json', function (remote) {
      var base = remote || {};
      base[key] = list;
      return base;
    }, message).catch(function (e) { toast('保存失败：' + (e.message || e), true); });
  }

  function careList() {
    return ((state.data && state.data.careLog) || []).slice()
      .sort(function (x, y) { return (x.at || '') < (y.at || '') ? 1 : -1; });
  }

  // 能敷的：面膜、唇膜、眼膜
  function maskProducts() {
    return allProducts().filter(function (p) {
      if (!inUse(p)) return false;
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

  /* ================= 医美记录 =================
     做过什么、什么时候做的。和护肤记录分开 ——
     一次热玛吉的影响按年算，混在每天敷面膜里根本翻不出来。 */

  function procList() {
    return ((state.data && state.data.procedures) || []).slice()
      .sort(function (x, y) { return (x.date || '') < (y.date || '') ? 1 : -1; });
  }

  /* 早先手写进去的那几条没有 id，用「日期+名字」当身份。
     不为了加两个按钮就去改已有的数据。 */
  function procKey(p) { return p.id || ((p.date || '') + '|' + (p.name || '')); }

  function procedureHTML() {
    var rows = procList().map(function (p) {
      var k = procKey(p);
      var shots = p.photos || [];
      return '<div class="care-row" data-pcid="' + esc(k) + '">' +
        '<div class="cr-top">' +
          '<b>' + esc(fmtDate(p.date)) + '</b>' +
          '<span class="care-what">' + esc(p.name || '') + '</span>' +
          '<button class="rv-edit" data-pc-shoot="' + esc(k) + '" aria-label="加照片">＋</button>' +
          '<button class="rv-edit" data-pc-edit="' + esc(k) + '" aria-label="改">✎</button>' +
          '<button class="rv-edit" data-pc-del="' + esc(k) + '" aria-label="删">×</button>' +
        '</div>' +
        (p.note ? '<div class="cr-note">' + esc(p.note) + '</div>' : '') +
        (shots.length
          ? '<div class="pc-shots">' + shots.map(function (path, i) {
              return '<span class="pc-cell">' +
                '<button class="pc-shot" type="button" data-pc-shot="' + esc(k) + '" ' +
                  'data-i="' + i + '"><img data-key="' + esc(path) + '" alt=""></button>' +
                '<button class="pc-del" type="button" data-pc-shot-del="' + esc(k) + '" ' +
                  'data-i="' + i + '" aria-label="删掉这张">×</button>' +
              '</span>';
            }).join('') + '</div>'
          : '') +
      '</div>';
    });

    return foldSection('proc', '医美记录', '<div class="card">' +
        '<div class="care-add">' +
          '<button class="more-toggle" id="addProc" type="button">＋ 记一次</button>' +
        '</div>' +
        (rows.length ? '<div class="w-list">' + limitRows('proc', rows) + '</div>'
                     : '<div class="tiny">做过什么、什么时候做的，记在这里。' +
                       '哪家做的、恢复几天、效果怎么样写在备注里，' +
                       '下次才知道值不值得再做。<br>' +
                       '每条右边的 ＋ 存照片：病历、导诊单、药盒、缴费单 —— ' +
                       '单据上写的东西，隔半年只有原件说得清。</div>') +
      '</div>');
  }

  function openProcEditor(anchor, editKey) {
    if (document.getElementById('pc-edit')) return;
    var cur = editKey
      ? procList().filter(function (x) { return procKey(x) === editKey; })[0]
      : null;

    var sel = { name: (cur && cur.name) || '' };

    var box = el(
      '<div class="inline-edit" id="pc-edit">' +
        '<div class="tiny ie-lab" style="margin-top:0">做了什么</div>' +
        '<div id="pc-pick"></div>' +
        '<div class="w-form" style="margin-top:12px">' +
          '<input type="date" id="pc-date" value="' +
            (cur && cur.date ? esc(cur.date) : todayISO()) + '">' +
        '</div>' +
        '<textarea id="pc-note" placeholder="哪家做的、什么参数、恢复几天、效果怎么样" ' +
          'style="margin-top:8px">' + esc((cur && cur.note) || '') + '</textarea>' +
        '<div class="ie-act">' +
          '<button class="ie-cancel" type="button">取消</button>' +
          '<button class="ie-ok" type="button">' + (cur ? '保存' : '记下') + '</button>' +
        '</div>' +
      '</div>'
    );
    anchor.insertAdjacentElement('afterend', box);

    mountTagRow(box.querySelector('#pc-pick'), 'proc', {
      isOn: function (k) { return sel.name === k; },
      onPick: function (k) { sel.name = (sel.name === k) ? '' : k; },
      extra: function () { return sel.name ? [sel.name] : []; },
      onRename: function (map) { sel.name = map[sel.name] || sel.name; },
    });

    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      if (!sel.name) return toast('先点一个项目，没有就点 ＋ 加进去', true);
      var rec = {
        id: (cur && cur.id) || 'pc' + Date.now().toString(36),
        date: box.querySelector('#pc-date').value || todayISO(),
        name: sel.name,
        note: box.querySelector('#pc-note').value.trim() || undefined,
      };
      var old = cur ? editKey : null;
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      // 存的时候按时间从早到晚排，和体重那份一个规矩
      persistList('procedures',
        procList().filter(function (x) { return procKey(x) !== old; }).concat([rec])
          .sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; }),
        '医美记录：' + sel.name);
    });
  }

  function deleteProc(key) {
    var p = procList().filter(function (x) { return procKey(x) === key; })[0];
    if (!p || !confirm('删掉「' + (p.name || '') + '」这条？')) return;
    persistList('procedures',
      procList().filter(function (x) { return procKey(x) !== key; })
        .sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; }),
      '医美记录：删除 ' + (p.name || ''))
      // 记录先删干净，再清照片文件 —— 反过来的话中途失败会留下引用不到的图
      .then(function () {
        return (p.photos || []).length
          ? GitStore.commitDelete(p.photos, '删除「' + (p.name || '') + '」的照片')
          : null;
      })
      .catch(function (e) { toast('删除失败：' + (e.message || e), true); });
  }

  /* 病历、导诊单、药盒、缴费单。
     和产品那边的「拍照识别」不是一回事：单据要的是【原样存档】——
     AI 认错了反而污染记录，而且没填 API Key 也该能存。所以这里只压缩和上传。 */
  function pickProcShots(key) {
    var inp = $('#docInput');
    if (!inp) return;
    inp.onchange = function () {
      addProcShots(key, this.files);
      this.value = '';
    };
    inp.click();
  }

  function addProcShots(key, files) {
    if (!files || !files.length) return;
    var p = procList().filter(function (x) { return procKey(x) === key; })[0];
    if (!p) return;
    var n = files.length;
    toast('照片处理中…（' + n + ' 张）');

    Promise.all(Array.prototype.slice.call(files).map(function (f) {
      return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
    })).then(function (blobs) {
      /* 早先手写进去的记录没有 id，身份是「日期+名字」——
         之后改个名字，照片就跟丢了。第一次贴照片顺手补一个 id 钉住它。 */
      var stamp = Date.now().toString(36);
      var pid = p.id || ('pc' + stamp);
      var shots = blobs.map(function (b, i) {
        return { path: 'procedures/' + pid + '-' + stamp + '-' + i + '.jpg', blob: b };
      });
      // 图先进仓库；记录里存的是路径，反过来会指向还不存在的文件
      return GitStore.commit(shots, '医美记录：' + (p.name || '') + ' 的照片')
        .then(function () {
          return persistList('procedures', procList().map(function (x) {
            if (procKey(x) !== key) return x;
            return Object.assign({}, x, {
              id: pid,
              photos: (x.photos || []).concat(shots.map(function (s) { return s.path; })),
            });
          }).sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; }),
            '医美记录：' + (p.name || '') + ' 加 ' + n + ' 张照片');
        });
    /* ⚠️ 必须重新拉一次。缩略图靠 state.tree 里的 blob sha 找图，
       而 persistList 只写 settings.json、不碰这棵树 ——
       不补这一下，照片存进去了，位置也占了，但一直显示「照片加载失败」。
       产品那边的 saveProducts 自带这一步，所以没露出来过。 */
    }).then(loadData).then(function () {
      refresh('mainlines');
      toast('已存下 ' + n + ' 张');
    }).catch(function (e) {
      toast('照片没存上：' + (e.message || e), true);
    });
  }

  function openProcShot(key, idx) {
    var p = procList().filter(function (x) { return procKey(x) === key; })[0];
    if (p && (p.photos || []).length) openPhotoList(p.photos, idx);
  }

  function deleteProcShot(key, idx) {
    var p = procList().filter(function (x) { return procKey(x) === key; })[0];
    if (!p || !p.photos || !p.photos[idx]) return;
    var path = p.photos[idx];
    if (!confirm('删掉这张照片？')) return;

    persistList('procedures', procList().map(function (x) {
      if (procKey(x) !== key) return x;
      return Object.assign({}, x, {
        photos: x.photos.filter(function (_, i) { return i !== idx; }),
      });
    }).sort(function (a, b) { return (a.date || '') < (b.date || '') ? -1 : 1; }),
      '医美记录：删掉一张照片')
      .then(function () { return GitStore.commitDelete([path], '删除照片 ' + path); })
      .catch(function (e) { toast('删除失败：' + (e.message || e), true); });
  }

  /* ---- 记一条 ---- */

  function lastEntry() {
    var all = newestFirst((state.data && state.data.entries) || []);
    return all[0] || null;
  }

  /* 找最近一条【记了某类产品】的记录。
     彩妆必须只跟带妆的记录走 —— 直接沿用上一条的话，
     上一条要是素颜，彩妆就成空的了，等于每天都要重填。 */
  /* 护肤也要按 face 找，不能只看「最近一条有产品的」。
     素颜那天用的和带妆那天用的根本是两套（带妆那天还有防晒和底妆前的步骤），
     混着沿用等于每天都要重填。

     还有一条更要命的：找到同类的第一条就返回，【空也返回】。
     以前是 list.length 才算数，于是「那天什么都没用」被当成「没数据」，
     继续往前翻，把更早的产品又拽回来 —— 术后医嘱是什么都不涂，
     结果 9/1–9/4 四条素颜记录全被自动填上了小棕瓶和敷尔佳面膜，
     人根本没选过。判读的时候这批假数据是会误导人的。 */
  function lastProducts(kind, faceNeeded) {
    var all = newestFirst((state.data && state.data.entries) || []);
    for (var i = 0; i < all.length; i++) {
      var e = all[i];
      if (faceNeeded && e.face !== faceNeeded) continue;
      return { list: ((e.products && e.products[kind]) || []).slice(), date: e.date };
    }
    return null;
  }


  /* 产品库点选：手打产品名又慢又容易和库里对不上号。
     库里按顺序列出来，点一下就加/去掉，输入框跟着同步 ——
     输入框留着是为了记库里还没有的东西。 */
  function pickerHTML(sel, bare) {
    var list = allProducts().filter(inUse);
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
    // 产品从照片上看不出来，而且基本天天一样 —— 默认沿用上一次，自己改。
    // 新草稿默认带妆（下面 face: 'makeup'），所以按带妆那条沿用；
    // 切到素颜时 renderCompose 会按 _carriedFace 重新算一遍。
    var sk = lastProducts('skincare', 'makeup');
    var mk = lastProducts('makeup', 'makeup');
    var carried = { skincare: sk ? sk.list.slice() : [], makeup: mk ? mk.list.slice() : [] };
    var prev = (mk && mk.list.length) ? mk : ((sk && sk.list.length) ? sk : null);

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
      rating: null,
      tags: [],
      ai: null,
    };
  }

  /* 带妆时的持妆状态、光线预设都在标签库里（mkstate / light）——
     AI 会自动勾持妆状态，不准直接点掉。这些是判断
     「这个底妆到底扛不扛得住」最直接的证据，比分数更具体。 */

  function renderCompose() {
    var host = $('#view-compose');
    if (!state.draft) state.draft = blankDraft();
    var d = state.draft;

    /* 沿用上次的产品要在【打开这一页时】算，不能只在建草稿时算。
       建草稿可能发生在云端数据还没加载完的时候，那时候翻不到历史记录，
       结果就是「彩妆没有默认带进来」。
       只在你还没动过产品栏时补，动过就不碰。 */
    if (!d.editingId && !d._touchedProducts && d._carriedFace !== d.face) {
      var sk0 = lastProducts('skincare', d.face);      // 素颜沿用素颜的，带妆沿用带妆的
      var mk0 = lastProducts('makeup', 'makeup');
      d.products.skincare = sk0 ? sk0.list.slice() : [];
      d.products.makeup = d.face === 'bare' ? [] : (mk0 ? mk0.list.slice() : []);
      // 空的沿用不写来源 —— 「沿用 9 月 4 日」后面跟一片空白只会让人以为坏了
      var src = (sk0 && sk0.list.length) ? sk0 : ((mk0 && mk0.list.length) ? mk0 : null);
      d.carriedFrom = src ? src.date : null;
      d._carriedFace = d.face;   // 记下这次是按哪种 face 算的，改了 face 要重算
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

      '<div class="field"><label>这次打几分</label>' +
        '<div class="score-row' + (d.rating == null ? ' unset' : '') + '">' +
          '<span class="score-val" id="fRateVal">' +
            (d.rating == null ? '未打分' : d.rating.toFixed(1)) + '</span>' +
          '<input type="range" id="fRate" min="0" max="5" step="0.1" value="' +
            (d.rating == null ? 3 : d.rating) + '">' +
          (d.rating == null ? '' :
            '<button class="more-toggle" id="fRateOff" type="button">清除</button>') +
        '</div>' +
      '</div>' +

      '<div class="field"><label>备注</label>' +
        '<textarea id="fNote" placeholder="看到什么写什么，可留空">' + esc(d.note) + '</textarea>' +
      '</div>' +

      /* 标签原来是折叠区里一个用空格分词的文本框：想不起上次写的是
         「泪沟」还是「泪沟处」，两种写法就成了两个标签，等于白记。
         改成点选，缺哪个当场加。放在外面 —— 收在「更多」里等于没有。 */
      '<div class="field"><label>部位标签</label>' +
        '<div id="fZone"></div>' +
        '<div class="tiny hint">这次在看哪儿。时间线上点一下标签，' +
          '就只剩同一处的记录。</div>' +
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
      /* 展开状态存在草稿里，不能只存在 DOM 上 —— 点一下产品就 renderCompose()
         整个重画，DOM 上的展开状态跟着没了，「更多」啪一下合回去。
         素颜时产品栏就在这个折叠区里，等于每选一件都要重新展开一次。 */
      '<button class="more-toggle' + (d._moreOpen ? ' open' : '') + '" id="moreToggle" ' +
        'type="button" aria-expanded="' + (d._moreOpen ? 'true' : 'false') + '">' +
        '更多（光线、评分、产品）<span class="ml-caret">▾</span>' +
      '</button>' +
      '<div id="moreBox"' + (d._moreOpen ? '' : ' hidden') + '>' +

        '<div class="field"><label>光线条件</label>' +
          '<input type="text" id="fLight" placeholder="比如：窗边自然光" value="' + esc(d.light) + '">' +
          '<div id="lightPresets" style="margin-top:8px"></div>' +
          '<div class="tiny hint">填了这个，AI 判读会准很多。</div>' +
        '</div>' +

        '<div class="field"><label>肤况评分（看不清就留空）</label>' +
          '<div class="card" id="fScores"></div>' +
        '</div>' +

        (d.face === 'makeup'
          ? '<div class="field"><label>妆容</label>' +
              '<div class="card" id="fMakeupScores"></div>' +
              '<div class="tiny hint" style="margin:10px 0 8px">持妆状态（AI 会自动勾，不准就点掉）</div>' +
              '<div id="fMakeupState"></div>' +
            '</div>'
          : '') +

        (d.face === 'makeup' ? '' : productField(d)) +

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
      if (state.draft) state.draft._moreOpen = !open;   // 重画后还得是这个状态
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
    if (ms) mountTagRow(ms, 'mkstate', {
      isOn: function (k) { return (d.makeupState || []).indexOf(k) >= 0; },
      onPick: function (k) {
        d.makeupState = d.makeupState || [];
        var at = d.makeupState.indexOf(k);
        if (at >= 0) d.makeupState.splice(at, 1); else d.makeupState.push(k);
      },
      extra: function () { return (d.makeupState || []).slice(); },
      onRename: function (map) {
        d.makeupState = (d.makeupState || []).map(function (x) { return map[x] || x; });
      },
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
    /* 一拖就算打分了，不用先点个按钮开启 ——
       拖了滑块却不算数是最容易踩空的地方。 */
    var rate = $('#fRate', host), rateVal = $('#fRateVal', host);
    var wasUnset = d.rating == null;
    rate.addEventListener('input', function () {
      d.rating = Number(this.value);
      rateVal.textContent = d.rating.toFixed(1);
      if (wasUnset) { wasUnset = false; renderCompose(); }
    });
    on('#fRateOff', 'click', function () {
      d.rating = null;
      renderCompose();
    });

    var noteBox = $('#fNote', host);
    autoGrow(host);
    noteBox.addEventListener('input', function () { d.note = this.value; });
    mountTagRow($('#fZone', host), 'zone', {
      isOn: function (k) { return (d.tags || []).indexOf(k) >= 0; },
      onPick: function (k) {
        d.tags = d.tags || [];
        var at = d.tags.indexOf(k);
        if (at >= 0) d.tags.splice(at, 1); else d.tags.push(k);
      },
      // 早先手打的、AI 填的标签库里没有，也得露出来，否则看着像丢了
      extra: function () { return (d.tags || []).slice(); },
      onRename: function (map) {
        d.tags = (d.tags || []).map(function (x) { return map[x] || x; });
      },
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
        // 展开状态现在存在草稿里，重画会自己保持，不用再补一下 click
        if (redraw) { renderCompose(); return; }
        $$(sel + ' button', host).forEach(function (x) { x.classList.remove('on'); });
        b.classList.add('on');
      });
    };
    seg('#fFace', 'face', true);   // true = 改完重画，产品栏要跟着换位置

    mountTagRow($('#lightPresets', host), 'light', {
      isOn: function (k) { return d.light === k; },
      onPick: function (k) {
        d.light = (d.light === k) ? '' : k;
        $('#fLight', host).value = d.light;
      },
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
        // 只认标签库里有的：AI 偶尔会自创一个词，别让它往库外面写
        var known = tagItems('mkstate').map(function (t) { return t.label; });
        d.makeupState = r.makeupState.filter(function (x) { return known.indexOf(x) >= 0; });
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
      /* ⚠️ 队列只活在内存里。提交失败就这么放着，人一刷新或关掉页面，
         照片连同记录一起没了 —— 而照片是当场拍的，丢了补不回来。
         所以失败要立刻转存本地（IndexedDB），等下次连上再补传。 */
      var why = (err.step ? '「' + err.step + '」' : '') + (err.message || err);
      return GitStore.goLocal(seedFromCache())
        .then(function () { return runJob(job); })     // 现在会落到本地
        .then(function () {
          queue.shift();
          running = false;
          renderQueue();
          renderPending();
          toast('云端没传成功，已存在手机上，等会儿自动补传', true);
        })
        .catch(function (e2) {
          // 连本地都存不下才算真失败
          job.state = 'failed';
          job.error = why;
          running = false;
          renderQueue();
          toast('保存失败：' + why + '（本地也没存下：' + (e2.message || e2) + '）', true);
        });
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
        var e = job.entry;
        var at = entries.findIndex(function (x) { return x.id === e.id; });

        /* 新记录撞上云端已有的同号 —— makeEntryId 只在【这台设备内存里】
           找空号，所以上一条没传成功、或者别的设备刚写进去的，这边都看不见，
           于是又发了同一个 id。直接 entries[at] = e 会把对方那条抹掉，
           所以另起一个号，两条都留住。 */
        if (at >= 0 && job.isNew && entries[at].at !== e.at) {
          var base = e.date.replace(/-/g, ''), used = {};
          entries.forEach(function (x) { if (x.date === e.date) used[x.id] = 1; });
          for (var n = 1; n < 100; n++) {
            var nid = base + '-' + String(n).padStart(2, '0');
            if (!used[nid]) { e = Object.assign({}, e, { id: nid }); break; }
          }
          entries.push(e);
          return entries;
        }

        if (at >= 0) entries[at] = e; else entries.push(e);
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
      rating: d.rating == null ? undefined : d.rating,
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
      isNew: !d.editingId,   // 撞号时要不要另起一个号，看这个
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
      rating: e.rating == null ? null : e.rating,
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

  /* 在用 = 既没停用、也不是「待尝试」。
     待尝试的东西手里还没有，它不能出现在「今天用了什么」的选项里 ——
     能选就会有人选，记录就脏了。 */
  function inUse(p) { return p.status !== 'retired' && p.status !== 'wishlist'; }

  var prodQuery = '';

  function matchProduct(p, q) {
    if (!q) return true;
    var hay = [p.short, p.name, p.brand, p.category, (p.variants || []).join(' ')]
      .filter(Boolean).join(' ').toLowerCase();
    return q.toLowerCase().split(/\s+/).every(function (w) { return hay.indexOf(w) >= 0; });
  }

  function renderProducts() {
    var host = $('#view-products');
    var list = allProducts().filter(function (p) { return matchProduct(p, prodQuery); });

    var body = '';
    KINDS.forEach(function (k) {
      var rows = sortProducts(list.filter(function (p) {
        return kindOf(p) === k.key && inUse(p);
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

    /* 待尝试单独一节，不按类别拆 —— 想试的东西一次就那么几件，
       拆进五个分类里反而要翻五次才看全。 */
    var wish = sortProducts(list.filter(function (p) { return p.status === 'wishlist'; }));
    if (wish.length) {
      var wClosed = prodFold.wishlist;
      body +=
        '<div class="cat-head' + (wClosed ? ' closed' : '') + '" data-kind="wishlist">' +
          '待尝试<span>' + wish.length + '</span><span class="ml-caret">▾</span></div>' +
        '<div class="prod-list"' + (wClosed ? ' hidden' : '') + '>' +
          wish.map(prodCardHTML).join('') + '</div>';
    }

    var retired = list.filter(function (p) { return p.status === 'retired'; });
    if (retired.length) {
      var rClosed = prodFold.retired;
      body +=
        '<div class="cat-head' + (rClosed ? ' closed' : '') + '" data-kind="retired">' +
          '已停用<span>' + retired.length + '</span><span class="ml-caret">▾</span></div>' +
        '<div class="prod-list dim"' + (rClosed ? ' hidden' : '') + '>' +
          retired.map(prodCardHTML).join('') + '</div>';
    }

    if (!body && prodQuery) {
      body = '<div class="empty">没有匹配「' + esc(prodQuery) + '」的产品</div>';
    }
    if (!body) {
      body = '<div class="empty"><strong>产品库还是空的</strong>' +
        '拍一张护肤品或彩妆的照片，AI 会认出品牌和品名。</div>';
    }

    host.innerHTML =
      '<div class="tl-bar">' +
        '<span class="tiny">产品库 · ' +
          list.filter(inUse).length + ' 件在用' +
          (wish.length ? ' · ' + wish.length + ' 件待尝试' : '') + '</span>' +
        '<button id="scanBtn" type="button">＋ 拍照识别</button>' +
        /* 手动添加原来在整页最底下，得翻到底才看得见。
           她 2026-09-05：「手动添加产品删掉，放在最上面，有个加号就行」 */
        '<button id="addProdBtn" class="icon-add" type="button" ' +
          'aria-label="手动添加一件" title="手动添加一件">＋</button>' +
      '</div>' +
      /* 三十多件之后，翻列表找一支眼线笔比搜一下慢多了。
         品名、品牌、款式、类别都能搜 —— 记不清全名时按品牌找也行。 */
      '<input type="search" id="prodSearch" placeholder="搜产品（品名 / 品牌 / 款式）" ' +
        'value="' + esc(prodQuery) + '" autocapitalize="off" autocorrect="off">' +
      '<div id="scanOut"></div>' + body + spendHTML();

    bindProdDrag(host);
    var sBox = $('#prodSearch', host);
    if (sBox) {
      sBox.addEventListener('input', function () {
        prodQuery = this.value.trim();
        var pos = this.selectionStart;
        renderProducts();
        // 重画之后把焦点和光标放回去，不然打一个字就跳出来
        var again = $('#prodSearch');
        if (again) { again.focus(); try { again.setSelectionRange(pos, pos); } catch (e) {} }
      });
    }
    $('#scanBtn', host).addEventListener('click', function () { $('#prodInput').click(); });
    $('#addProdBtn', host).addEventListener('click', function () {
      /* ⚠ 按钮现在在 .tl-bar 里，那是个 flex 行，表单插进去会把它撑坏 —— 插到搜索框下面 */
      addProductManually(this, $('#prodSearch', host));
    });
    bindSpend(host);

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
    if (p) return shortName(p) + (t.variant ? ' · ' + t.variant : '');
    // 像 id 的（一串小写字母数字、没有中文）就别当名字显示了
    var s = String(token || '');
    return /^[a-z0-9]{6,}$/.test(s) ? '已删除的产品' : s;
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
          (p.status === 'retired' ? '恢复'
            : p.status === 'wishlist' ? '开始用' : '停用') + '</button>' +
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
  /* 成分表历史上写过两个字段名：代码这边一直是 inci，但库里已有的四条
     （大白瓶、紫熨斗、绽妍敷料、蓝科兴敷料）存的是 ingredients ——
     结果是「填了却显示不出来」。读的时候两个都认，写的时候统一收敛到 inci。 */
  function inciOf(p) { return p.inci || p.ingredients || ''; }

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
    /* 这一栏是包装上印的【卖点参数】，一句话那种。
       全成分表另有一块（inci）——两个都叫「成分」会分不清该往哪填。 */
    { k: 'spec',     label: '参数',   type: 'text',   ph: '如 SPF50+ PA++++' },
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
      '<b>购买记录' +
        '<button class="ph-add" data-buy-add="' + esc(p.id) + '" ' +
          'type="button" aria-label="记一次购买">＋</button>' +
        /* 识别错了一堆的时候，一条条删太费劲 —— 给个一键清空。
           破坏性动作，所以放最右、压淡，并且要二次确认。 */
        (buys.length
          ? '<button class="ph-clear" data-buy-clear="' + esc(p.id) + '" ' +
            'type="button" aria-label="清空购买记录">清空</button>'
          : '') +
      '</b>' +
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

    /* 成分单独一块，不塞进上面那排单行输入框 ——
       全成分表动辄三四十个词，一行输入框里看不到第三个之后的东西，
       而它的用处恰恰是【整段拿出来比对】：几件产品一起烂脸时，
       找共同成分是唯一能收敛的线索。
       文字和照片都收：瓶身背面来不及抄，先拍下来也算存住了。 */
    var inciShots = p.inciPhotos || [];
    var inciHTML = '<div class="pd-hist">' +
      '<b>成分' +
        '<button class="ph-add" data-inci-edit="' + esc(p.id) + '" type="button" ' +
          'aria-label="写成分表">✎</button>' +
        '<button class="ph-add" data-inci-shoot="' + esc(p.id) + '" type="button" ' +
          'aria-label="拍成分表">＋</button>' +
      '</b>' +
      (inciOf(p) ? '<div class="inci-text">' + esc(inciOf(p)) + '</div>' : '') +
      (inciShots.length
        ? '<div class="pc-shots">' + inciShots.map(function (path, i) {
            return '<span class="pc-cell">' +
              '<button class="pc-shot" type="button" data-inci-shot="' + i + '">' +
                '<img data-key="' + esc(path) + '" alt=""></button>' +
              '<button class="pc-del" type="button" data-inci-del="' + i + '" ' +
                'aria-label="删掉这张">×</button>' +
            '</span>';
          }).join('') + '</div>'
        : '') +
      (inciOf(p) || inciShots.length ? ''
        : '<div class="tiny">✎ 贴全成分表（可以直接粘贴），＋ 拍瓶身背面那一段。</div>') +
      '</div>';

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
      hist + buyHTML + inciHTML +
      /* 照片小节：＋ 挂在标题右边，识别到的信息自动补进产品和购买记录 */
      // 归类改不了的话，自动猜错就只能一直错着
      '<div class="pd-cats">' +
        '<span class="pc-lab">归类</span>' +
        '<span class="catpick" data-catset="kind">' +
          KINDS.map(function (k) {
            return '<button type="button" class="ccip' +
              (kindOf(p) === k.key ? ' on' : '') + '" data-v="' + k.key + '">' +
              esc(k.label) + '</button>';
          }).join('') +
        '</span>' +
        ((SUBCATS[kindOf(p)] || []).length > 1
          ? '<span class="catpick sub" data-catset="sub">' +
            SUBCATS[kindOf(p)].map(function (sc) {
              return '<button type="button" class="ccip' +
                (subCatOf(p).key === sc.key ? ' on' : '') + '" data-v="' + esc(sc.key) + '">' +
                esc(sc.label) + '</button>';
            }).join('') + '</span>'
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
      var bc = ev.target.closest('[data-buy-clear]');
      if (bc) return clearBuys(bc.dataset.buyClear);
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
      var ie = ev.target.closest('[data-inci-edit]');
      if (ie) return openInciEditor(id, ie.closest('.pd-hist'));
      var ish = ev.target.closest('[data-inci-shoot]');
      if (ish) return pickInciShots(id);
      var ix = ev.target.closest('[data-inci-del]');
      if (ix) return deleteInciShot(id, Number(ix.dataset.inciDel));
      var iv = ev.target.closest('[data-inci-shot]');
      if (iv) return openPhotoList(p.inciPhotos, Number(iv.dataset.inciShot));
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
      /* 同一件产品的不同色号，成分表通常也是同一份 —— 留已有的那份，
         没有才拿被并进来的。照片两边都留：色号之间偶尔真的有差别。 */
      inci: inciOf(to) || inciOf(from),
      inciPhotos: (to.inciPhotos || []).concat(
        (from.inciPhotos || []).filter(function (p) {
          return (to.inciPhotos || []).indexOf(p) < 0;
        })),
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


  /* 产品被删掉之后，把记录里指向它的引用一并摘掉。 */

  /* 清空某件产品的全部购买记录。
     识别认错一堆的时候，一条条删太费劲。
     起用日期跟着回到「没有购买记录」的状态 —— 它本来就是从最早那单算出来的。 */
  function clearBuys(pid) {
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p) return;
    var n = (p.purchases || []).length;
    if (!n) return;
    if (!confirm('清空「' + shortName(p) + '」的全部 ' + n + ' 条购买记录？\n照片和评价不动。')) return;

    var next = allProducts().map(function (x) {
      if (x.id !== pid) return x;
      var y = Object.assign({}, x);
      delete y.purchases;
      delete y.start;          // 起用日期是从最早那单推出来的，一起撤掉
      return y;
    });
    saveProducts(next, '产品库：清空 ' + shortName(p) + ' 的购买记录')
      .then(function () { toast('已清空 ' + n + ' 条'); })
      .catch(function (e) { toast('失败：' + (e.message || e), true); });
  }

  function clearProductRefs(pid) {
    var strip = function (list) {
      return (list || []).filter(function (t) { return String(t).split('#')[0] !== pid; });
    };
    ((state.data && state.data.entries) || []).forEach(function (e) {
      if (!e.products) return;
      e.products.skincare = strip(e.products.skincare);
      e.products.makeup = strip(e.products.makeup);
    });
    return GitStore.updateJSON('entries.json', function (remote) {
      return (remote || []).map(function (e) {
        if (!e.products) return e;
        var y = Object.assign({}, e);
        y.products = { skincare: strip(e.products.skincare), makeup: strip(e.products.makeup) };
        return y;
      });
    }, '清掉已删除产品的引用').catch(function () {});
  }

  function removeProduct(id) {
    var p = allProducts().filter(function (x) { return x.id === id; })[0];
    if (!p || !confirm('从产品库删除「' + shortName(p) + '」？')) return;
    // 记录里引用的是 id，产品没了不清引用，时间线上就会露出一串 id
    clearProductRefs(id);
    saveProducts(allProducts().filter(function (x) { return x.id !== id; }), '产品库：删除 ' + p.name)
      .then(function () { toast('已删除'); })
      .catch(function (e) { toast('失败：' + e.message, true); });
  }

  function toggleProduct(id) {
    var today = todayISO();
    var list = allProducts().map(function (x) {
      if (x.id !== id) return x;
      var y = Object.assign({}, x);
      /* 待尝试 → 开始用：这一刻才算真的起用，start 按今天记。
         不能沿用 addedAt —— 那是「记下这件想试的」的日期，可能早好几个月，
         拿它当起用日期会把「用了多久」算多。 */
      if (y.status === 'wishlist') { y.status = 'using'; y.start = today; delete y.end; }
      else if (y.status === 'retired') { y.status = 'using'; delete y.end; }
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
  var newBuys = null;      // 刚才那几张照片里认出来的购买记录

  /* ──────────────── 花费统计（产品页最底下） ────────────────
     她 2026-09-05：「统计下我买的主要产品花的钱」「还可以看按年度的」。
     ⚠ 只统计 purchases 里填了价格的记录 —— 库里有一半产品还没登过价，
     所以这里显示的永远是**下限**，那句提示不能省。 */

  var spendYear = 'all';   // 'all' 或 '2024' 这样的年份

  function spendBuys() {
    var out = [];
    allProducts().forEach(function (p) {
      var k = kindOf(p);
      var nm = p.short || p.name || '未命名';
      (p.purchases || []).forEach(function (q) {
        if (!q || !q.date) return;
        out.push({ d: q.date, y: String(q.date).slice(0, 4), p: +q.price || 0, n: nm, k: k });
      });
    });
    out.sort(function (a, b) { return a.d < b.d ? -1 : a.d > b.d ? 1 : 0; });
    return out;
  }

  function yuan(n) { return '¥' + Math.round(n).toLocaleString('en-US'); }

  function spendHTML() {
    var buys = spendBuys();
    if (!buys.length) return '';

    var years = [];
    buys.forEach(function (b) { if (years.indexOf(b.y) < 0) years.push(b.y); });
    years.sort();
    if (spendYear !== 'all' && years.indexOf(spendYear) < 0) spendYear = 'all';

    var yTot = {}, maxY = 0;
    years.forEach(function (y) {
      var v = buys.filter(function (b) { return b.y === y; });
      yTot[y] = {
        all: v.reduce(function (t, b) { return t + b.p; }, 0),
        skincare: v.reduce(function (t, b) { return t + (b.k === 'skincare' ? b.p : 0); }, 0),
        makeup: v.reduce(function (t, b) { return t + (b.k === 'makeup' ? b.p : 0); }, 0)
      };
      if (yTot[y].all > maxY) maxY = yTot[y].all;
    });
    if (!maxY) maxY = 1;

    var isAll = spendYear === 'all';
    var cur = isAll ? buys : buys.filter(function (b) { return b.y === spendYear; });
    var total = cur.reduce(function (t, b) { return t + b.p; }, 0);

    /* 按产品聚合 */
    var agg = {};
    cur.forEach(function (b) {
      var a = agg[b.n] || (agg[b.n] = { n: b.n, k: b.k, p: 0, c: 0 });
      a.p += b.p; a.c++;
    });
    var list = Object.keys(agg).map(function (k) { return agg[k]; })
      .sort(function (x, y) { return y.p - x.p; });
    var mx = list.length ? (list[0].p || 1) : 1;

    /* 覆盖率：库里多少件还没登过价 */
    var withBuy = 0;
    allProducts().forEach(function (p) { if ((p.purchases || []).length) withBuy++; });
    var nAll = allProducts().length;

    /* 年份切换 */
    var tabs = '<div class="sp-tabs">' +
      ['all'].concat(years.slice().reverse()).map(function (y) {
        return '<button type="button" data-y="' + y + '"' +
          (y === spendYear ? ' class="on"' : '') + '>' + (y === 'all' ? '全部' : y) + '</button>';
      }).join('') + '</div>';

    /* 年度柱图 */
    var chart = '<div class="sp-chart">' + years.map(function (y) {
      var t = yTot[y], dim = (!isAll && y !== spendYear) ? ' dim' : '';
      return '<button type="button" class="sp-col' + dim + '" data-y="' + y + '">' +
        '<span class="sp-bars">' +
          (t.makeup > 0 ? '<i class="mk" style="height:' + (t.makeup / maxY * 100) + '%"></i>' : '') +
          (t.skincare > 0 ? '<i class="sk" style="height:' + (t.skincare / maxY * 100) + '%"></i>' : '') +
        '</span>' +
        '<em>' + y.slice(2) + '</em></button>';
    }).join('') + '</div>';

    /* 排行：前 5 件 + 其余合并 */
    var top = list.slice(0, 5), rest = list.slice(5);
    var restSum = rest.reduce(function (t, a) { return t + a.p; }, 0);
    var bars = top.map(function (a) {
      return '<div class="sp-row"><div class="sp-nm">' + esc(a.n) +
        '<span>' + a.c + ' 笔</span></div>' +
        '<div class="sp-track"><i class="' + (a.k === 'makeup' ? 'mk' : 'sk') +
          '" style="width:' + (a.p / mx * 100).toFixed(1) + '%"></i></div>' +
        '<div class="sp-v">' + yuan(a.p) + '</div></div>';
    }).join('');
    if (rest.length) {
      bars += '<div class="sp-row"><div class="sp-nm">其余 ' + rest.length + ' 件</div>' +
        '<div class="sp-track"><i class="ot" style="width:' + (restSum / mx * 100).toFixed(1) + '%"></i></div>' +
        '<div class="sp-v">' + yuan(restSum) + '</div></div>';
    }

    var sk = cur.reduce(function (t, b) { return t + (b.k === 'skincare' ? b.p : 0); }, 0);
    var mk = cur.reduce(function (t, b) { return t + (b.k === 'makeup' ? b.p : 0); }, 0);
    var sp = (sk + mk) > 0 ? Math.round(sk / (sk + mk) * 100) : 0;

    var sub;
    if (isAll) {
      sub = buys[0].d.slice(0, 7).replace('-', '.') + ' – ' +
            buys[buys.length - 1].d.slice(0, 7).replace('-', '.');
    } else {
      var i = years.indexOf(spendYear);
      if (i > 0 && yTot[years[i - 1]].all > 0) {
        var pct = Math.round((total - yTot[years[i - 1]].all) / yTot[years[i - 1]].all * 100);
        sub = spendYear + ' 年 · 较 ' + years[i - 1] + ' ' + (pct >= 0 ? '+' : '') + pct + '%';
      } else {
        sub = spendYear + ' 年';
      }
    }

    return '<div class="cat-head" id="spendHead">花费统计<span>' + buys.length + ' 笔</span></div>' +
      '<div class="sp-box">' + tabs +
        '<div class="sp-total">' + yuan(total) + '<em>' + esc(sub) + '</em></div>' +
        '<div class="sp-line">' + cur.length + ' 笔 · ' + list.length + ' 件 · ' +
          '护肤 ' + sp + '% / 彩妆 ' + (100 - sp) + '%</div>' +
        chart + '<div class="sp-rows">' + bars + '</div>' +
        '<div class="sp-note">⚠️ 这是下限：库里 ' + nAll + ' 件，只有 ' + withBuy +
          ' 件有购买记录，没登价的没算进来。</div>' +
      '</div>';
  }

  function bindSpend(host) {
    var box = $('.sp-box', host);
    if (!box) return;
    box.addEventListener('click', function (ev) {
      var b = ev.target.closest('[data-y]');
      if (!b) return;
      var y = b.dataset.y;
      /* 再点一次已选中的年份 = 回到全部，省一次来回 */
      spendYear = (y === spendYear) ? 'all' : y;
      renderProducts();
      var head = $('#spendHead');
      if (head) head.scrollIntoView({ block: 'start' });
    });
  }

  function addProductManually(btn, anchor) {
    /* anchor = 表单插在谁后面。按钮挪进 .tl-bar 之后就不能再插在按钮后面了。 */
    var at = anchor || btn;
    newShots = null;
    newBuys = null;
    if (at.nextElementSibling && at.nextElementSibling.classList.contains('inline-edit')) {
      return at.nextElementSibling.remove();
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
      /* 在用 / 待尝试：手动加的很多是「看到了想试」而不是「已经在用」，
         入库时就分清楚，省得后面再去改一遍状态。 */
      '<div class="segmented sm" id="newStatus" style="margin-top:6px">' +
        '<button type="button" data-v="using" class="on">在用</button>' +
        '<button type="button" data-v="wishlist">待尝试</button>' +
      '</div>' +
      /* 手动添加也能配照片：拍一张，认出来的信息直接填进下面的空格 */
      '<button class="more-toggle" type="button" id="newShot">＋ 拍张照自动填</button>' +
      '<span class="tiny" id="newShotMsg"></span>' + rows +
      '<div class="ie-act">' +
        '<button class="ie-cancel" type="button">取消</button>' +
        '<button class="ie-ok" type="button">入库</button>' +
      '</div></div>');
    at.insertAdjacentElement('afterend', box);

    var kind = 'skincare';
    var newStatus = 'using';

    box.querySelector('#newStatus').addEventListener('click', function (ev) {
      var b = ev.target.closest('button');
      if (!b) return;
      newStatus = b.dataset.v;
      Array.prototype.forEach.call(this.children, function (x) { x.classList.remove('on'); });
      b.classList.add('on');
      // 起用日期跟着走：待尝试的还没开始用，不该预填今天
      var st = box.querySelector('[data-f="start"]');
      if (st) st.value = newStatus === 'wishlist' ? '' : todayISO();
    });

    box.querySelector('#newShot').addEventListener('click', function () {
      if (!ensureKey()) return;
      var msg = box.querySelector('#newShotMsg');
      var inp = $('#prodShotInput');
      inp.onchange = function () {
        var files = Array.prototype.slice.call(this.files);
        this.value = '';
        if (!files.length) return;
        msg.textContent = '识别中…';
        /* 和补拍一样一张一张来：整批送给模型只会回来一件，
           传 5 张订单截图就只剩 1 单。 */
        var blobs = [], hits = 0;
        newBuys = [];
        files.reduce(function (prev, f, i) {
          return prev.then(function () {
            return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
          }).then(function (blob) {
            blobs.push(blob);
            if (files.length > 1) msg.textContent = '识别中… ' + (i + 1) + '/' + files.length;
            return PrettierAI.identifyProducts([blob]).then(function (found) {
              var x = (found.products || [])[0];
              if (!x) return;
              hits++;
              // 只填空着的格子，你已经写过的不动
              $$('[data-f]', box).forEach(function (inp2) {
                var v = x[inp2.dataset.f];
                if (v != null && v !== '' && !inp2.value) inp2.value = v;
              });
              var short = box.querySelector('[data-f="short"]');
              if (short && !short.value) short.value = x.short || ((x.brand || '') + (x.name || ''));
              var buy = buyFrom(x);
              if (buy) newBuys = mergeBuys(newBuys, [buy]).list;
            });
          }).catch(function () { /* 单张失败不拖累整批 */ });
        }, Promise.resolve()).then(function () {
          newShots = blobs;
          if (!hits) { msg.textContent = '没认出产品信息，手填也行'; return; }
          msg.textContent = newBuys.length
            ? '已填入，还认出 ' + newBuys.length + ' 笔购买，检查一下再入库'
            : '已填入，检查一下再入库';
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
                status: newStatus, addedAt: todayISO() };
      $$('input[data-f]', box).forEach(function (inp) {
        var v = inp.value.trim();
        if (!v) return;
        p[inp.dataset.f] = inp.type === 'number' ? Number(v) : v;
      });
      if (!p.name) return toast('至少写个名字', true);
      /* 照片里认出来的购买信息一起带进去 —— 认出来却不记，等于白传。
         第一次购买的日期比「今天」更接近真正的起用时间。 */
      if (newBuys && newBuys.length) {
        p.purchases = newBuys.slice();
        if (!p.start && newStatus !== 'wishlist') p.start = newBuys[0].date;
      }
      // 待尝试的还没开始用，别给它填起用日期
      if (!p.start && newStatus !== 'wishlist') p.start = todayISO();
      if (newStatus === 'wishlist') delete p.end;

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
      newBuys = null;

      saveProducts(allProducts().concat([p]), '产品库：添加 ' + p.name, files)
        .then(function () { toast('已入库'); refresh('products'); })
        .catch(function (e) { toast('失败：' + e.message, true); });
    });
  }


  /* 识别结果里凡是带了价格/规格/日期的，都当成一次购买记录下来。
     用户反馈：「上传的照片多了时间、价格、容量等信息，你没补进去」——
     以前只往产品字段里塞，字段非空就被跳过，等于白认。 */
  /* 照片名 = 前缀 + 内容指纹。
     同一张截图重传一次就落回同一个路径，不会在产品下面挂出两张一样的图。
     算不出指纹（老浏览器没有 crypto.subtle）就退回时间戳，最多是多存一份，不出错。 */
  function photoPath(prefix, blob) {
    var fallback = prefix + Date.now().toString(36) +
      '-' + Math.random().toString(36).slice(2, 6) + '.jpg';
    if (!(window.crypto && crypto.subtle && blob.arrayBuffer)) {
      return Promise.resolve(fallback);
    }
    return blob.arrayBuffer()
      .then(function (buf) { return crypto.subtle.digest('SHA-256', buf); })
      .then(function (h) {
        var hex = Array.prototype.map.call(new Uint8Array(h), function (b) {
          return b.toString(16).padStart(2, '0');
        }).join('');
        return prefix + hex.slice(0, 12) + '.jpg';
      })
      .catch(function () { return fallback; });
  }

  /* 一次识别可能带出好几单：订单列表截图上同一件东西回购了三次。
     buysFrom 把 purchases 数组和单条字段合到一起，都变成购买记录。 */
  var DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

  /* ⚠ 没有下单日期就不算一条购买记录。
     原来是 `b.date || todayISO()` —— 模型没读到日期就拿今天顶上，
     结果库里混进「2026-08-17」「2026-09-05」这种其实是入库日/识别日的假记录，
     看着跟真的一样，翻历史时会误导。宁可少一条也不记假的。 */
  function buysFrom(x) {
    var out = (x.purchases || []).filter(function (b) {
      return b && DATE_RE.test(String(b.date || ''));
    }).map(function (b) {
      var one = { date: b.date, at: nowLocal() };
      if (b.price != null) one.price = b.price;
      if (b.size) one.size = b.size;
      if (b.spec) one.spec = b.spec;
      if (b.where) one.where = b.where;
      return one;
    });
    // 顶层那组字段是「只有一单」时的写法，别重复算进去
    var single = buyFrom(x);
    if (single && !out.length) out.push(single);
    return out;
  }

  // 认出了金额、却没认出日期 —— 这种要单独告诉她，不能悄悄吞掉
  function buysMissingDate(x) {
    var n = (x.purchases || []).filter(function (b) {
      return b && !DATE_RE.test(String(b.date || '')) &&
             (b.price != null || b.size || b.where);
    }).length;
    if (!n && !DATE_RE.test(String(x.boughtAt || '')) &&
        (x.price != null || x.size || x.where)) n = 1;
    return n;
  }

  // 起用日期＝已知购买记录里最早的那天
  function earliestBuy(list) {
    return (list || []).reduce(function (min, b) {
      var d = b && b.date;
      if (!d) return min;
      return (!min || d < min) ? d : min;
    }, null);
  }

  function buyFrom(x) {
    var price = x.price != null && x.price !== '' ? Number(x.price) : null;
    var size = x.size || '';
    // 同上：日期读不出来就不生成购买记录
    if (!DATE_RE.test(String(x.boughtAt || ''))) return null;
    var date = x.boughtAt;
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

  /* 同一天 + 没有任何一项「两边都写了却写得不一样」→ 同一单。
     ⚠️ 不能只看日期：同一天同样价格买了两个不同款式，那是两张订单
     （依克多因和透明质酸就各是一单），合掉就丢记录了 ——
     所以只要有一项真冲突就判成两单。
     反过来，一边空着不算冲突：那是【信息缺】，不是另一单。
     以前那版要求价格和渠道都一字不差，结果同一张订单截图重传一次、
     模型这回多认出个渠道，就又写了一条重复的。 */
  function sameBuyAt(list, b) {
    return (list || []).findIndex(function (o) {
      if (o.date !== b.date) return false;
      if (o.price != null && b.price != null && Number(o.price) !== Number(b.price)) return false;
      if (o.where && b.where && o.where !== b.where) return false;
      if (o.size && b.size && o.size !== b.size) return false;
      var ov = buyVariant(o), bv = buyVariant(b);
      if (ov && bv && ov !== bv) return false;
      return true;
    });
  }

  function hasSameBuy(list, b) { return sameBuyAt(list, b) >= 0; }

  /* 同一单又传了一次：不写第二条，把这次多认出来的补进原来那条。
     只补空着的格子 —— 你自己改过的价格不能被模型盖掉。
     返回补了几项。 */
  function fillBuy(o, b) {
    var n = 0;
    ['price', 'size', 'where', 'spec'].forEach(function (k) {
      var cur = o[k];
      if (cur !== undefined && cur !== '' && cur !== null) return;
      if (b[k] === undefined || b[k] === '' || b[k] === null) return;
      o[k] = b[k];
      n++;
    });
    return n;
  }

  /* 把一批认出来的订单并进已有的购买记录里。
     同一单就补，认不出对应的才新增。返回 {list, added, filled}。 */
  function mergeBuys(existing, incoming) {
    var out = (existing || []).map(function (o) { return Object.assign({}, o); });
    var added = 0, filled = 0;
    (incoming || []).forEach(function (b) {
      var at = sameBuyAt(out, b);
      if (at < 0) { out.push(b); added++; return; }
      if (fillBuy(out[at], b)) filled++;
    });
    return { list: out, added: added, filled: filled };
  }

  /* 单个产品补拍：直接指定是哪一件，不走去重猜名字。
     用户要的是「这件东西我又看到了新信息，补进去」，
     而不是「认认看这是什么」—— 后者才需要匹配。

     ⚠️ 一张一张识别，不整批送。
     以前是把 N 张一次交给模型、然后只取 products[0]：
     5 张订单截图本来是 5 次回购，结果只落了 1 条购买记录，另外 4 单白传。
     产品扫描那边（scanProductsJob）早就改成一张一张了，这条路当时漏掉了。
     一张订单截图就对应一单，模型不用在多张之间猜谁是谁。 */
  /* 给某一件产品补拍照片。

     ⚠ 两条铁律都在这儿：
     ① 一张一张送给模型（R-B）——一张订单截图 = 一单，别让它在多张之间猜。
     ② **一张一张写进仓库**——原来是攒够 N 张最后存一次，
        中途被打断（切页面、iOS 挂起 PWA）就全丢。2026-09-05 这样丢过 7 张。
     现在最多丢正在处理的那一张。

     整个过程放进后台队列：切到别的页面也照跑，进度显示在底部队列条上。 */
  function shootProduct(pid, files, statusEl) {
    if (!files || !files.length) return;
    if (!ensureKey()) return;
    var list = Array.prototype.slice.call(files);
    var p0 = allProducts().filter(function (x) { return x.id === pid; })[0];
    var who = p0 ? shortName(p0) : '产品';

    if (statusEl) statusEl.textContent = '已加入后台识别（' + list.length + ' 张）';
    toast('已加入后台识别（' + list.length + ' 张）');

    enqueue({
      label: who + ' · ' + list.length + ' 张',
      refreshView: 'products',
      run: function (step) { return shootProductJob(pid, list, step); },
    });
  }

  function shootProductJob(pid, list, step) {
    var added = 0, filled = 0, hits = 0, noDate = 0;

    return list.reduce(function (prev, f, i) {
      return prev.then(function () {
        step('第 ' + (i + 1) + '/' + list.length + ' 张');
        return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
      }).then(function (blob) {
        // 文件名是内容指纹：同一张再传一次，路径一样，不会挂成两张
        return photoPath('products/' + pid + '-', blob).then(function (path) {
          return PrettierAI.identifyProducts([blob]).then(function (found) {
            var all = (found && found.products) || [];
            var x = all[0];
            var buys = [];
            if (x) {
              hits++;
              // 一张订单列表上可能有好几单，整张图上的都收下
              all.forEach(function (y) {
                var more = buysFrom(y);
                if (more.length) buys = mergeBuys(buys, more).list;
                noDate += buysMissingDate(y);
              });
            }
            return { path: path, blob: blob, fields: x || null, buys: buys };
          }).catch(function () {
            // 认不出来也要把照片存下 —— 图是当场传的，丢了补不回来
            return { path: path, blob: blob, fields: null, buys: [] };
          });
        });
      }).then(function (one) {
        /* ⚠ 每张单独保存。攒到最后再存，中断一次就全没了。 */
        var next = allProducts().map(function (p) {
          if (p.id !== pid) return p;
          var add = {};
          if (one.fields) {
            ['brand', 'category', 'size', 'price', 'spec', 'note'].forEach(function (k) {
              if ((p[k] === undefined || p[k] === '') && one.fields[k]) add[k] = one.fields[k];
            });
          }
          if (one.buys.length) {
            var got = mergeBuys(p.purchases, one.buys);
            if (got.added || got.filled) add.purchases = got.list;
            added += got.added;
            filled += got.filled;
          }
          var first = earliestBuy(add.purchases || p.purchases);
          if (first && (!p.start || first < p.start)) add.start = first;
          if ((p.photos || []).indexOf(one.path) < 0) {
            add.photos = (p.photos || []).concat([one.path]);
          }
          return Object.assign({}, p, add);
        });
        return saveProducts(next, '产品库：补充第 ' + (i + 1) + '/' + list.length + ' 张',
                            [{ path: one.path, blob: one.blob }]);
      }).catch(function () {
        // 单张失败不拖累后面的
      });
    }, Promise.resolve()).then(function () {
      var say = [];
      if (added) say.push('记下 ' + added + ' 笔购买');
      if (filled) say.push('补全 ' + filled + ' 笔');
      // 认出了金额却没认出日期的，明说跳过了，别让人以为都记上了
      if (noDate) say.push('有 ' + noDate + ' 笔没读到日期，没记（可手动补）');
      toast(say.length ? say.join('，')
        : (hits ? '这些单之前都记过了' : '照片已存下，没认出购买信息'));
    });
  }


  /* ---- 全成分表 ---- */

  /* 用 textarea 而不是那排单行输入框：成分表是要整段读、整段比的东西，
     换行也得留住 —— 官网复制下来的顺序本身就是信息（含量从高到低）。 */
  function openInciEditor(pid, anchor) {
    if (document.getElementById('inci-edit')) return;
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p) return;

    var box = el('<div class="inline-edit" id="inci-edit">' +
      '<div class="tiny ie-lab" style="margin-top:0">全成分表（照瓶身抄，或直接粘贴）</div>' +
      '<textarea id="inci-txt" style="min-height:130px" ' +
        'placeholder="水、甘油、丁二醇、烟酰胺、透明质酸钠……">' +
        esc(inciOf(p)) + '</textarea>' +
      '<div class="ie-act">' +
        '<button class="ie-cancel" type="button">取消</button>' +
        '<button class="ie-ok" type="button">保存</button>' +
      '</div>' +
    '</div>');
    anchor.appendChild(box);
    box.querySelector('#inci-txt').focus();

    box.querySelector('.ie-cancel').addEventListener('click', function () { box.remove(); });
    box.querySelector('.ie-ok').addEventListener('click', function () {
      var v = box.querySelector('#inci-txt').value.trim();
      /* 先 blur 再移除：只移除的话 activeElement 还停在 textarea 上，
         isEditing() 判定为真，刷新被欠下 —— 表现是「点保存没反应」。 */
      if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
      box.remove();
      saveProducts(allProducts().map(function (x) {
        // 存的时候把旧字段清掉，免得两个名字各存一份、以后不知道该信谁
        return x.id === pid
          ? Object.assign({}, x, { inci: v || undefined, ingredients: undefined })
          : x;
      }), '产品库：' + shortName(p) + ' 的成分表')
        .then(function () { toast('已保存'); })
        .catch(function (e) { toast('失败：' + (e.message || e), true); });
    });
  }

  /* 成分表照片和「识别用的原图」分开存：那边是拿去认品牌品名的，
     这边是留着回头逐条看的，混在一起两边都不好找。 */
  function pickInciShots(pid) {
    var inp = $('#docInput');
    if (!inp) return;
    inp.onchange = function () {
      addInciShots(pid, this.files);
      this.value = '';
    };
    inp.click();
  }

  function addInciShots(pid, files) {
    if (!files || !files.length) return;
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p) return;
    var n = files.length;
    toast('照片处理中…（' + n + ' 张）');

    Promise.all(Array.prototype.slice.call(files).map(function (f) {
      return PrettierPhoto.normalize(f).then(function (r) { return r.blob; });
    })).then(function (blobs) {
      var stamp = Date.now().toString(36);
      var shots = blobs.map(function (b, i) {
        return { path: 'products/' + pid + '-inci-' + stamp + '-' + i + '.jpg', blob: b };
      });
      var next = allProducts().map(function (x) {
        if (x.id !== pid) return x;
        return Object.assign({}, x, {
          inciPhotos: (x.inciPhotos || []).concat(shots.map(function (s) { return s.path; })),
        });
      });
      // saveProducts 会先把图单独提交，再改 settings.json
      return saveProducts(next, '产品库：' + shortName(p) + ' 的成分表照片', shots);
    }).then(function () {
      toast('已存下 ' + n + ' 张');
    }).catch(function (e) {
      toast('照片没存上：' + (e.message || e), true);
    });
  }

  function deleteInciShot(pid, idx) {
    var p = allProducts().filter(function (x) { return x.id === pid; })[0];
    if (!p || !p.inciPhotos || !p.inciPhotos[idx]) return;
    var path = p.inciPhotos[idx];
    if (!confirm('删掉这张成分表照片？')) return;

    var next = allProducts().map(function (x) {
      if (x.id !== pid) return x;
      return Object.assign({}, x, {
        inciPhotos: x.inciPhotos.filter(function (_, i) { return i !== idx; }),
      });
    });
    saveProducts(next, '产品库：删掉一张成分表照片')
      .then(function () { return GitStore.commitDelete([path], '删除照片 ' + path); })
      .catch(function (e) { toast('删除失败：' + (e.message || e), true); });
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

          list.forEach(function (x, n) {
            var at = merged.findIndex(function (p) {
              return keyOf(p) === keyOf(x) || p.name === x.name;
            });
            var buys = buysFrom(x);

            if (at < 0) {
              /* ⚠️ id 必须带上这张图里的序号 n。
                 原来是 'p'+stamp+idx —— stamp 每批只算一次、idx 是第几张图，
                 于是同一张图里认出的每一件都拿到同一个 id，
                 而 saveProducts 按 id 去重，只活下来最后一条：
                 一张图里有三件也只入库一件。 */
              var np = {
                id: 'p' + stamp + idx + '-' + n,
                name: x.name, short: x.short || '', brand: x.brand || '',
                kind: x.kind || 'skincare', category: x.category || '',
                size: x.size || undefined, price: x.price,
                spec: x.spec || undefined, note: x.note || undefined,
                status: 'using',
                purchases: buys.length ? buys : undefined,
                photos: [path],                 // 只挂自己这一张
                start: earliestBuy(buys) || todayISO(),
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
            if (buys.length) {
              // 同一单再扫到就补进原来那条，新的单子才追加
              var m = mergeBuys(p.purchases, buys);
              if (m.added || m.filled) add.purchases = m.list;
            }
            // 起用日期以最早的一单为准 —— 后翻到更早的订单要能往前推
            var first = earliestBuy(add.purchases || p.purchases);
            if (first && (!p.start || first < p.start)) add.start = first;
            if ((p.photos || []).indexOf(path) < 0) {
              add.photos = (p.photos || []).concat([path]);
            }
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
