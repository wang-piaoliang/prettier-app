/* ============================================================
   AI 判读：照片 → 评分 + 观察
   ------------------------------------------------------------
   用阿里云百炼的 qwen3-vl-plus。选它是因为 dashscope 在国内直连
   实测 0.14s，而 Gemini 的域名直接不通。

   密钥存在本机 localStorage，只发给 dashscope，不经过任何第三方。

   ⚠️ 设计上的两个要点：

   1. 判读前必须先告诉模型【拍摄条件】。同一张脸，近距离侧光会放大
      毛孔和纹理，均匀正面光会让色斑更显；带妆会压掉色斑、腮红会被
      当成泛红。不交代这些，分数就是噪音。

   2. 让它【看不清就不打分】。宁可留空，也不要为了凑满而猜 ——
      这份档案的价值全在纵向可比，掺了猜测就毁了。
   ============================================================ */

(function () {
  'use strict';

  var ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions';
  var MODEL = 'qwen3-vl-plus';
  var KEY_LS = 'prettier.ai.key';

  function getKey() {
    try { return localStorage.getItem(KEY_LS) || ''; } catch (e) { return ''; }
  }
  function setKey(v) {
    try { v ? localStorage.setItem(KEY_LS, v) : localStorage.removeItem(KEY_LS); } catch (e) {}
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
    var key = getKey();
    if (!key) return Promise.reject(new Error('还没填百炼 API Key'));
    if (!blobs || !blobs.length) return Promise.reject(new Error('没有照片'));

    // 一次最多看 4 张：再多既慢又容易让模型串台
    var use = blobs.slice(0, 4);

    return Promise.all(use.map(blobToB64)).then(function (b64s) {
      var content = b64s.map(function (b) {
        return { type: 'image_url', image_url: { url: 'data:image/jpeg;base64,' + b } };
      });
      content.push({ type: 'text', text: buildPrompt(ctx) });

      return fetch(ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + key },
        body: JSON.stringify({ model: MODEL, messages: [{ role: 'user', content: content }] }),
      });
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          if (res.status === 401) throw new Error('API Key 不对');
          if (res.status === 429) throw new Error('调用太频繁，等一会儿再试');
          throw new Error('百炼 ' + res.status + '：' + t.slice(0, 160));
        });
      }
      return res.json();
    }).then(function (data) {
      var text = data && data.choices && data.choices[0] &&
                 data.choices[0].message && data.choices[0].message.content;
      if (!text) throw new Error('模型没有返回内容');
      var out = parseJSON(text);

      // 清洗：只收 1-5 的整数，其余一律丢掉，避免把 "无法判断" 之类塞进分数
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

      out.model = MODEL;
      out.at = new Date().toISOString();
      return out;
    });
  }

  window.PrettierAI = {
    analyze: analyze,
    getKey: getKey,
    setKey: setKey,
    model: MODEL,
  };
})();
