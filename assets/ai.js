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
  // 从新到旧试，成功的那个记下来，下次先用它，省得每次都撞一遍 404
  var GEMINI_MODELS = ['gemini-flash-latest', 'gemini-3.6-flash', 'gemini-2.5-flash'];

  var LS_PROVIDER = 'prettier.ai.provider';
  var LS_KEY_QWEN = 'prettier.ai.key';          // 沿用旧键，已填过的不用重填
  var LS_KEY_GEMINI = 'prettier.ai.key.gemini';
  var LS_GEMINI_MODEL = 'prettier.ai.gemini.model';

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { v ? localStorage.setItem(k, v) : localStorage.removeItem(k); } catch (e) {} }

  function provider() { return lsGet(LS_PROVIDER) || 'qwen'; }
  function setProvider(p) { lsSet(LS_PROVIDER, p === 'gemini' ? 'gemini' : 'qwen'); }

  function getKey(p) {
    return lsGet((p || provider()) === 'gemini' ? LS_KEY_GEMINI : LS_KEY_QWEN);
  }
  function setKey(v, p) {
    lsSet((p || provider()) === 'gemini' ? LS_KEY_GEMINI : LS_KEY_QWEN, v);
  }
  function modelName() {
    return provider() === 'gemini'
      ? (lsGet(LS_GEMINI_MODEL) || GEMINI_MODELS[0])
      : QWEN_MODEL;
  }

  /* 统一的「发一组图 + 一段提示词，拿回文本」——两个厂商的差异只在这里 */
  function callVision(blobs, prompt) {
    var p = provider();
    var key = getKey(p);
    if (!key) throw new Error(p === 'gemini' ? '还没填 Gemini API Key' : '还没填百炼 API Key');

    return Promise.all(blobs.slice(0, 4).map(blobToB64)).then(function (b64s) {
      return p === 'gemini' ? callGemini(key, b64s, prompt) : callQwen(key, b64s, prompt);
    });
  }

  function callQwen(key, b64s, prompt) {
    var content = b64s.map(function (b) {
      return { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b } };
    });
    content.push({ type: 'text', text: prompt });

    return fetch(QWEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
      body: JSON.stringify({ model: QWEN_MODEL, messages: [{ role: 'user', content: content }] }),
    }).then(function (res) {
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

  function callGemini(key, b64s, prompt) {
    var remembered = lsGet(LS_GEMINI_MODEL);
    var models = remembered
      ? [remembered].concat(GEMINI_MODELS.filter(function (m) { return m !== remembered; }))
      : GEMINI_MODELS.slice();

    var parts = b64s.map(function (b) {
      return { inline_data: { mime_type: 'image/jpeg', data: b } };
    });
    parts.push({ text: prompt });

    var lastErr = null;
    // 依次试，404 就换下一个（模型名会随版本下线）
    return models.reduce(function (chain, model) {
      return chain.then(function (done) {
        if (done) return done;
        var url = 'https://generativelanguage.googleapis.com/v1beta/models/' +
                  model + ':generateContent?key=' + encodeURIComponent(key);
        return fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: parts }],
            generationConfig: { responseMimeType: 'application/json' },
          }),
        }).then(function (res) {
          if (res.status === 404) { lastErr = new Error('模型 ' + model + ' 不存在'); return null; }
          if (!res.ok) {
            return res.text().then(function (t) {
              if (res.status === 400 && /API key/i.test(t)) throw new Error('Gemini API Key 不对');
              if (res.status === 429) throw new Error('调用太频繁，等一会儿再试');
              throw new Error('Gemini ' + res.status + '：' + t.slice(0, 160));
            });
          }
          return res.json().then(function (d) {
            var t = d && d.candidates && d.candidates[0] &&
                    d.candidates[0].content && d.candidates[0].content.parts &&
                    d.candidates[0].content.parts[0] && d.candidates[0].content.parts[0].text;
            if (!t) throw new Error('模型没有返回内容');
            lsSet(LS_GEMINI_MODEL, model);   // 记住能用的那个
            return t;
          });
        }).catch(function (e) {
          // 连不上：给一句能直接行动的话，而不是原始网络错误
          if (e instanceof TypeError) {
            throw new Error('连不上 Gemini。它在国内需要代理，手机上通常用不了 —— 可以在设置里切回百炼。');
          }
          throw e;
        });
      });
    }, Promise.resolve(null)).then(function (t) {
      if (!t) throw (lastErr || new Error('Gemini 全部模型都不可用'));
      return t;
    });
  }

  function blobToB64(blob) {
    return new Promise(function (resolve, reject) {
      var r = new FileReader();
      r.onload = function () { resolve(String(r.result).split(',')[1]); };
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
    return JSON.parse(t);
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

  /* 认产品：拍瓶身/包装，识别品牌和品名 */
  function identifyProducts(blobs) {
    var prompt = [
      '识别照片里的护肤品和彩妆产品。',
      '',
      '要求：',
      '1. 只写你在包装上【真的看清了】的字。看不清品牌就把 brand 留空字符串，',
      '   不要根据外观猜品牌 —— 猜错了会污染产品库。',
      '2. 一张照片里有多件就都列出来。',
      '3. kind 只能是 "skincare"（护肤）或 "makeup"（彩妆）。',
      '4. category 用中文，例如：洁面、化妆水、精华、面霜、防晒、粉底、遮瑕、腮红、口红。',
      '',
      '严格输出 JSON，不要 markdown 代码块：',
      '{"products":[{"brand":"","name":"","kind":"skincare","category":""}]}',
      '',
      '一件都没认出来就返回 {"products":[]}。',
    ].join('\n');

    return Promise.resolve()
      .then(function () { return callVision(blobs, prompt); })
      .then(function (text) {
        var out = parseJSON(text || '{"products":[]}');
        out.products = (out.products || []).filter(function (p) {
          return p && p.name && String(p.name).trim();
        }).map(function (p) {
          return {
            brand: String(p.brand || '').trim(),
            name: String(p.name).trim(),
            kind: p.kind === 'makeup' ? 'makeup' : 'skincare',
            category: String(p.category || '').trim(),
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
