/* ============================================================
   AI 判读：照片 → 评分 + 观察
   ------------------------------------------------------------
   两个引擎，自己选：

     · Gemini（gemini-flash-latest）—— 判读细腻度更好，
       但 generativelanguage.googleapis.com 在国内直连不通
       （实测两次都 10s 超时，走代理才通）。所以【手机上用不了】，
       Mac 挂着代理时可以用。
     · 百炼 qwen3-vl-plus —— dashscope 国内直连 0.19s，
       手机不挂代理也能用。默认走这个。

   密钥存在本机 localStorage，只发给对应厂商，不经过任何第三方。

   ⚠️ 设计上的两个要点：

   1. 判读前必须先告诉模型【拍摄条件】。同一张脸，近距离侧光会放大
      毛孔和纹理，均匀正面光会让色斑更显；带妆会压掉色斑、腮红会被
      当成泛红。不交代这些，分数就是噪音。

   2. 让它【看不清就不打分】。宁可留空，也不要为了凑满而猜 ——
      这份档案的价值全在纵向可比，掺了猜测就毁了。
   ============================================================ */

(function () {
  'use strict';

  var QWEN_ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  var QWEN_MODEL = 'qwen3-vl-plus';
  // 仅作列表接口不可用时的兼容候选；正常使用 models.list 返回的名称。
  var GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'];
  var geminiCatalog = null;

  var LS_PROVIDER = 'prettier.ai.provider';
  var LS_KEY_QWEN = 'prettier.ai.key';          // 沿用旧键，已填过的不用重填
  var LS_KEY_GEMINI = 'prettier.ai.key.gemini';
  var LS_GEMINI_MODEL = 'prettier.ai.gemini.model';

  function lsGet(k) { try { return (localStorage.getItem(k) || '').trim(); } catch (e) { return ''; } }
  function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} }

  function provider() { return lsGet(LS_PROVIDER) || 'qwen'; }
  function setProvider(p) { lsSet(LS_PROVIDER, p === 'gemini' ? 'gemini' : 'qwen'); }

  function getKey(p) {
    return lsGet((p || provider()) === 'gemini' ? LS_KEY_GEMINI : LS_KEY_QWEN);
  }
  function setKey(v, p) {
    var selected = p || provider();
    if (selected === 'gemini' && getKey(selected) !== String(v || '').trim()) {
      geminiCatalog = null;
      lsSet(LS_GEMINI_MODEL, '');
    }
    lsSet(selected === 'gemini' ? LS_KEY_GEMINI : LS_KEY_QWEN, String(v || '').trim());
  }
  function modelName() {
    return provider() === 'gemini'
      ? (lsGet(LS_GEMINI_MODEL) || GEMINI_MODELS[0])
      : QWEN_MODEL;
  }

  function visionRequest(url, opts, consume, timeout) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeout || 90000);
    opts.signal = controller.signal;
    return fetch(url, opts).then(consume).catch(function (err) {
      if (err.name === 'AbortError') throw new Error('识别超时，请检查网络后重试');
      if (err.name === 'TypeError') throw new Error(url.indexOf('generativelanguage.googleapis.com') >= 0
        ? '连不上 Gemini API（网络或跨域请求失败），请确认当前设备能访问 Google API；更换模型不能解决连接问题'
        : '连不上百炼识别服务，请检查网络');
      throw err;
    }).finally(function () { clearTimeout(timer); });
  }

  /* 统一的「发一组图 + 一段提示词，拿回文本」——两个厂商的差异只在这里 */
  function callVision(blobs, prompt) {
    var p = provider();
    var key = getKey(p);
    if (!key) throw new Error(p === 'gemini' ? '还没填 Gemini API Key' : '还没填百炼 API Key');

    if (!blobs || !blobs.length) throw new Error('没有照片');
    return Promise.all(blobs.slice(0, 4).map(blobToB64)).then(function (b64s) {
      return p === 'gemini' ? callGemini(key, b64s, prompt) : callQwen(key, b64s, prompt);
    });
  }

  function callQwen(key, b64s, prompt) {
    var content = b64s.map(function (b) {
      return { type: 'image_url', image_url: { url: 'data:' + b.mime + ';base64,' + b.data } };
    });
    content.push({ type: 'text', text: prompt });

    return visionRequest(QWEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: 'user', content: content }] }),
    }, function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          if (res.status === 401) throw new Error('百炼 API Key 不对');
          if (res.status === 429) throw new Error('调用太频繁，等一会儿再试');
          throw new Error('百炼 ' + res.status + '：' + t.slice(0, 160));
        });
      }
      return res.json();
    }).then(function (d) {
      var t = d && d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content;
      if (!t) throw new Error('模型没有返回内容');
      return t;
    });
  }

  function geminiError(res, key, model) {
    return res.text().then(function (raw) {
      var data;
      try { data = JSON.parse(raw); } catch (err) { data = {}; }
      var api = data.error || {};
      var message = String(api.message || raw || '没有错误详情').split(key).join('[已隐藏]');
      var details = Array.isArray(api.details) ? api.details : [];
      var reasons = details.map(function (d) { return d.reason || ''; }).join(' ');
      var hint = 'Gemini 请求失败';
      if (res.status === 401 || /API_KEY_INVALID|API_KEY_EXPIRED/.test(reasons) || /API key not valid|API key expired/i.test(message)) {
        hint = 'Gemini API Key 无效或已过期';
      } else if (/API_KEY_HTTP_REFERRER_BLOCKED/.test(reasons)) {
        hint = 'Gemini Key 的网站限制没有允许当前 App 域名';
      } else if (/API_KEY_SERVICE_BLOCKED|API_KEY_IP_ADDRESS_BLOCKED|API_KEY_ANDROID_APP_BLOCKED|API_KEY_IOS_APP_BLOCKED/.test(reasons)) {
        hint = 'Gemini Key 的 API 或应用限制拒绝了这次调用';
      } else if (/leaked|suspended|blocked/i.test(message) && res.status === 403) {
        hint = 'Gemini Key 已被 Google 停用';
      } else if (/location|region|country/i.test(message) && (res.status === 400 || res.status === 403)) {
        hint = '当前出口地区不支持 Gemini API';
      } else if (res.status === 403) {
        hint = 'Gemini 项目或 Key 没有调用权限';
      } else if (res.status === 429) {
        hint = /limit:\s*0|quotaValue[^0-9]*0(?:[^0-9]|$)/i.test(message + JSON.stringify(details))
          ? 'Gemini 这个模型的可用配额为 0，请检查项目配额与计费状态'
          : 'Gemini 配额不足或达到请求速率上限';
      } else if (res.status === 402 || /billing|payment|prepay|credit/i.test(message)) {
        hint = 'Gemini 项目需要检查计费或余额';
      } else if (res.status === 404) {
        hint = 'Gemini 模型不存在或不支持当前接口';
      } else if (res.status >= 500) {
        hint = 'Gemini 服务暂时不可用';
      }
      var error = new Error(hint + '（HTTP ' + res.status + (model ? '，' + model : '') + '）\nGoogle：' + message.slice(0, 1000));
      error.status = res.status;
      error.modelQuota = res.status === 429 && details.some(function (d) {
        return (d.violations || []).some(function (v) { return v.quotaDimensions && v.quotaDimensions.model; });
      });
      return error;
    });
  }

  function geminiModels(key) {
    if (geminiCatalog && geminiCatalog.key === key && Date.now() - geminiCatalog.at < 1800000) {
      return Promise.resolve(geminiCatalog.models.slice());
    }
    var available = [];
    function page(token) {
      var url = 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000' +
        (token ? '&pageToken=' + encodeURIComponent(token) : '');
      return visionRequest(url, { headers: { 'x-goog-api-key': key } }, function (res) {
        if (!res.ok) return geminiError(res, key, '').then(function (err) { throw err; });
        return res.json();
      }, 20000).then(function (data) {
        (data.models || []).forEach(function (m) {
          var name = String(m.name || '').replace(/^models\//, '');
          // 只选 Flash 通用图文模型，排除图片生成、语音、实时及嵌入模型。
          if ((m.supportedGenerationMethods || []).indexOf('generateContent') >= 0 &&
              /^gemini-.*flash/.test(name) && !/image|tts|audio|live|native|embedding|robotics/.test(name)) {
            if (available.indexOf(name) < 0) available.push(name);
          }
        });
        if (data.nextPageToken) return page(data.nextPageToken);
        if (!available.length) throw new Error('Gemini API 没有返回支持图文识别的 Flash 模型');
        var preferred = [lsGet(LS_GEMINI_MODEL)].concat(GEMINI_MODELS);
        var ordered = preferred.filter(function (m, i) { return m && available.indexOf(m) >= 0 && preferred.indexOf(m) === i; });
        available.forEach(function (m) { if (ordered.indexOf(m) < 0) ordered.push(m); });
        geminiCatalog = { key: key, at: Date.now(), models: ordered };
        return ordered.slice();
      });
    }
    return page('').catch(function (err) {
      // 某些 Key 只允许推理，列表接口 403 时仍尝试原有模型。
      if (err.status === 403 || err.status === 404 || err.status >= 500) return GEMINI_MODELS.slice();
      throw err;
    });
  }

  function callGemini(key, b64s, prompt) {
    var parts = b64s.map(function (b) {
      return { inlineData: { mimeType: b.mime, data: b.data } };
    });
    parts.push({ text: prompt });
    return geminiModels(key).then(function (models) {
      var lastErr = null;
      return models.slice(0, 4).reduce(function (chain, model) {
        return chain.then(function (done) {
          if (done) return done;
          var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + encodeURIComponent(model) + ':generateContent';
          return visionRequest(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
            body: JSON.stringify({
              contents: [{ role: 'user', parts: parts }],
              generationConfig: { responseMimeType: 'application/json' },
            }),
          }, function (res) {
            if (!res.ok) return geminiError(res, key, model).then(function (err) {
              if (res.status === 404 || res.status === 500 || res.status === 503 || err.modelQuota) {
                lastErr = err;
                if (res.status === 404) geminiCatalog = null;
                return null;
              }
              throw err;
            });
            return res.json().then(function (data) {
              var feedback = data.promptFeedback || {};
              var candidate = (data.candidates || [])[0] || {};
              if (feedback.blockReason) throw new Error('Gemini 拒绝了这次识别：' + feedback.blockReason);
              if (candidate.finishReason && candidate.finishReason !== 'STOP') {
                throw new Error('Gemini 未完整返回识别结果：' + candidate.finishReason);
              }
              var returned = (candidate.content && candidate.content.parts) || [];
              var text = returned.filter(function (part) { return !part.thought; })
                .map(function (part) { return part.text || ''; }).join('');
              if (!text.trim()) throw new Error('Gemini 没有返回识别结果，请重试');
              lsSet(LS_GEMINI_MODEL, model);
              return text;
            });
          });
        });
      }, Promise.resolve(null)).then(function (text) {
        if (!text) throw (lastErr || new Error('Gemini 可用模型都未完成识别'));
        return text;
      });
    });
  }

  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      if (!/^image\/(jpeg|png|webp)$/.test(blob.type)) {
        reject(new Error('这张照片的格式不能识别，请先转换为 JPEG 或 PNG'));
        return;
      }
      r.onload = function () { resolve({ mime: blob.type, data: String(r.result).split(',')[1] }); };
      r.onerror = function () { reject(r.error); };
      r.readAsDataURL(blob);
    });
  }

  function buildPrompt(ctx) {
    var dims = (ctx.dimensions || []).map(function (d) {
      return '  "' + d.key + '": 1-5 或 null   // ' + d.label + '，' + d.hint;
    }).join('\n');

    var mk = (ctx.makeupDimensions || []).map(function (d) {
      return '  "' + d.key + '": 1-5 或 null   // ' + d.label + '，' + d.hint;
    }).join('\n');

    return [
      '你在帮一个人维护她自己的皮肤观察档案。看这些照片，给出客观判读。',
      '',
      '【拍摄条件】这直接决定哪些结论成立：',
      '· 上妆状态：' + (ctx.face === 'bare' ? '素颜' : '带妆'),
      '· 光线：' + (ctx.light || '未标注'),
      '· 时段：' + (ctx.slotLabel || '未标注'),
      '',
      '【必须遵守】',
      '1. 看不清的项目一律给 null，不要猜。留空比猜错有价值得多。',
      ctx.face === 'makeup'
        ? '2. 这是带妆照：底妆会压掉色斑，颧部的粉色大概率是腮红而不是泛红。' +
          '涉及色斑和泛红的判断要么给 null，要么明确写"受妆容影响，仅供参考"。'
        : '2. 这是素颜照，可以正常判读色斑。',
      '3. 近距离侧光会放大毛孔和纹理，均匀正面光会弱化它们。判读时把光线考虑进去。',
      '4. 只描述看到的，不要给医疗建议，不要下诊断。',
      '',
      '【已知背景】（用来理解看到的东西，不要重复陈述）',
      (ctx.background || '无'),
      '',
      '【输出】严格的 JSON，不要 markdown 代码块，不要任何解释文字：',
      '{',
      '  "scores": {',
      dims,
      '  },',
      mk ? '  "makeup": {\n' + mk + '\n  },' : '',
      ctx.face === 'makeup'
        ? '  "makeupState": [],   // 从这几个里选，看到几个填几个，没有就空数组：\n' +
          '                       // 泛油光 斑驳 卡粉 脱妆 暗沉 干纹 完好\n' +
          '                       // 判断依据：T区/颧骨是否反光成片=泛油光；' +
          '底妆颜色深浅不匀=斑驳；\n' +
          '                       // 毛孔或干燥处粉体堆积=卡粉；某块露出原本肤色=脱妆\n'
        : '',
      '  "zones": {            // 只写观察到问题的部位，没问题的不要写',
      '    "forehead": "额头的观察", "brow": "眉眼", "nose": "鼻部",',
      '    "cheekL": "左颊", "cheekR": "右颊", "mouth": "口周", "chin": "下巴"',
      '  },',
      '  "tags": ["3-5 个关键词"],',
      '  "best": 0,            // 哪一张最适合做这条记录的封面（从 0 开始的序号，看得最清楚的那张）',
      '  "summary": "一两句话总结，只讲这次看到的"',
      '}',
      '',
      '注意：照片里的【左颊/右颊】指本人的左右，不是画面的左右。',
      ctx.mirrored ? '这些是前置摄像头的镜像自拍，画面左 = 本人左。' :
                     '如果是自拍，通常画面左 = 本人右，请据此判断。',
    ].filter(Boolean).join('\n');
  }

  function parseJSON(text) {
    var t = String(text || '').trim();
    // 模型有时会套一层 ```json，剥掉
    t = t.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
    var a = t.indexOf('{'), b = t.lastIndexOf('}');
    if (a >= 0 && b > a) t = t.slice(a, b + 1);
    var out;
    try { out = JSON.parse(t); } catch (err) { throw new Error('识别服务返回的格式不完整，请重试'); }
    if (!out || typeof out !== 'object' || Array.isArray(out)) throw new Error('识别服务返回的格式不正确，请重试');
    return out;
  }

  /* blobs: [Blob]；ctx: {face, light, slotLabel, dimensions, makeupDimensions, background, mirrored} */
  function analyze(blobs, ctx) {
    if (!blobs || !blobs.length) return Promise.reject(new Error('没有照片'));

    return Promise.resolve()
      .then(function () { return callVision(blobs, buildPrompt(ctx)); })
      .then(function (text) {
        var out = parseJSON(text);

        // 只收 1-5 的整数，其余一律丢掉，免得把「无法判断」之类塞进分数
        var clean = {};
        Object.keys(out.scores || {}).forEach(function (k) {
          var v = out.scores[k];
          if (typeof v === 'number' && v >= 1 && v <= 5) clean[k] = Math.round(v);
        });
        out.scores = clean;

        if (out.makeup) {
          var mk = {};
          Object.keys(out.makeup).forEach(function (k) {
            var v = out.makeup[k];
            if (typeof v === 'number' && v >= 1 && v <= 5) mk[k] = Math.round(v);
          });
          out.makeup = mk;
        }

        out.model = modelName();
        out.at = new Date().toISOString();
        return out;
      });
  }

  /* 认产品：拍瓶身/包装。
     不只认名字 —— 包装上通常还印着规格、成分、批号，价签上有价格。
     这些字段一并抓回来，已经在库的就用它们补全空缺。 */
  function identifyProducts(blobs) {
    var prompt = [
      '识别照片里的护肤品、彩妆、美容仪器。包装上和价签上能看清的信息都提取出来。',
      '',
      '要求：',
      '1. 只写你【真的看清了】的字。看不清就留空字符串或省略该字段 ——',
      '   猜出来的信息会污染产品库，留空比猜有价值。',
      '2. 一张照片里有多件就都列出来；同一件的多张照片（正面/背面/价签）合并成一条。',
      '3. kind 只能是 "skincare"（护肤）、"makeup"（彩妆）、"device"（仪器）。',
      '4. size 写包装上印的净含量，带单位，例如 "50ml"、"30g"、"1.7oz"。',
      '5. price 只写数字（人民币元），看到价签、吊牌或订单截图才填，没有就省略。',
      '6. short 写【品牌+产品】的极简称呼，几个字就够，这是列表里显示的名字。',
      '   例：彩棠修容盘、covermark粉底霜、YSL恒久、雅诗兰黛DW。',
      '   不要写成完整品名（「高光修容盘」这种没有品牌的不行，看不出是谁家的）。',
      '7. 是订单/小票截图的话，把下单日期写进 boughtAt（YYYY-MM-DD），',
      '   店铺或平台写进 where（如 天猫、丝芙兰、免税店）。看不到就省略。',
      '8. ⚠ **订单列表/搜索结果截图**：一屏里常常并排着 3 单甚至更多，',
      '   每一块都有自己的店铺名、价格、日期。**逐块从上到下读，一块一条**，',
      '   别只读最上面那一块就交差。日期在每块的右下角（如「2022.02.28」）；',
      '   ⚠ **年份不要自己补**。截图上写什么就抄什么，原样放进 dateRaw：',
      '   看到「2024.01.13」就写 "2024.01.13"，看到「09.05」就写 "09.05"。',
      '   你不知道今天是哪一年，补出来的年份多半是错的，程序会自己算。',
      '   ⚠ 读不到日期就把 date 和 dateRaw 都留空，**不要猜、不要填今天** —— 宁可少一条。',
      '9. ⚠ 一张订单列表截图上常有【好几单】。同一件东西买过多次，',
      '   就把每一单都写进 purchases 数组，一单一条，不要只留一条、也不要合并。',
      '   每单能看到什么就写什么：date（YYYY-MM-DD）、price（数字）、',
      '   size（净含量）、spec（色号/款式）、where（店铺）。',
      '   只有一单时，写进 purchases 里也行，boughtAt 那几个字段可以省略。',
      '',
      '严格输出 JSON，不要 markdown 代码块：',
      '{"products":[{',
      '  "brand":"", "name":"", "kind":"skincare", "category":"",',
      '  "short":"", "size":"", "price":0, "spec":"", "note":"",',
      '  "boughtAt":"", "where":"",',
      '  "purchases":[{"date":"","dateRaw":"","price":0,"size":"","spec":"","where":""}]',
      '}]}',
      '',
      'category 用中文：洁面、化妆水、精华、眼霜、面霜、防晒、面膜、',
      '粉底、遮瑕、定妆、腮红、修容、高光、眉、眼影、眼线、睫毛、唇、仪器。',
      'spec 放包装上其他值得记的（如"SPF50+ PA++++"、"含2%水杨酸"）。',
      'note 放你不确定但觉得有用的观察。',
      '',
      '一件都没认出来就返回 {"products":[]}。',
    ].join('\n');

    return Promise.resolve()
      .then(function () { return callVision(blobs, prompt); })
      .then(function (text) {
        var out = parseJSON(text || '{"products":[]}');
        out.products = (Array.isArray(out.products) ? out.products : []).filter(function (p) {
          return p && p.name && String(p.name).trim();
        }).map(function (p) {
          var n = Number(p.price);
          return {
            brand: String(p.brand || '').trim(),
            name: String(p.name).trim(),
            short: String(p.short || '').trim(),
            kind: ['makeup', 'device'].indexOf(p.kind) >= 0 ? p.kind : 'skincare',
            category: String(p.category || '').trim(),
            size: String(p.size || '').trim(),
            price: (isFinite(n) && n > 0) ? n : undefined,
            spec: String(p.spec || '').trim(),
            note: String(p.note || '').trim(),
            /* ⚠️ 这份白名单是「识别结果能不能落库」的最后一道闸。
               漏写一个字段，模型认出来了也会在这儿被静默丢掉 ——
               购买记录一直是空的就是因为 boughtAt / where 没列进来。 */
            boughtAt: /^\d{4}-\d{2}-\d{2}$/.test(String(p.boughtAt || '').trim())
              ? String(p.boughtAt).trim() : '',
            where: String(p.where || '').trim(),
            /* ⚠ 白名单漏一个字段，模型认出来了也会在这儿被静默丢掉。
               购买记录一直只有一条，就是因为多单没有地方放。 */
            purchases: (Array.isArray(p.purchases) ? p.purchases : [])
              .map(function (b) {
                var bp = Number(b && b.price);
                return {
                  date: /^\d{4}-\d{2}-\d{2}$/.test(String((b && b.date) || '').trim())
                    ? String(b.date).trim() : '',
                  // 截图上那串日期的原文，年份由 App 补
                  dateRaw: String((b && b.dateRaw) || '').trim(),
                  price: (isFinite(bp) && bp > 0) ? bp : undefined,
                  size: String((b && b.size) || '').trim(),
                  spec: String((b && b.spec) || '').trim(),
                  where: String((b && b.where) || '').trim(),
                };
              })
              .filter(function (b) { return b.date || b.price != null || b.size || b.where; }),
          };
        });
        return out;
      });
  }

  window.PrettierAI = {
    analyze: analyze,
    identifyProducts: identifyProducts,
    getKey: getKey,
    setKey: setKey,
    provider: provider,
    setProvider: setProvider,
    modelName: modelName,
  };
})();
