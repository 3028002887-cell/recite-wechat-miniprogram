// edit.js —— 编辑+背书合一页面（阶段3：在编辑模式上新增荧光笔标注）
// 说明：本页含编辑模式基础能力 + 荧光笔标注模块；背书挖空逻辑在后续阶段实现
const CLOUD_FUNC = "notes"; // 笔记模块云函数名（与首页共用）
const CACHE_KEY = "notes_cache"; // 笔记列表本地缓存 key（与首页共用，离线兜底）
const FONT_KEY = "edit_font_size"; // 字体大小本地缓存 key
const DEFAULT_FONT_SIZE = 32; // 默认字号（rpx）
const FONT_MIN = 24; // 字号下限（rpx），与 wxml slider min 保持一致
const FONT_MAX = 64; // 字号上限（rpx），与 wxml slider max 保持一致
const LOCK_HEARTBEAT_INTERVAL = 30 * 1000; // 编辑锁心跳间隔：30 秒
const LOCK_FAIL_WARN_COUNT = 3; // 心跳连续失败多少次后提示锁失效风险（约 90 秒无网络）
const TAP_MOVE_THRESHOLD = 10; // 轻点判定位移阈值（px）：手指位移超过视为滚动，忽略轻点

// 调用 notes 云函数统一入口：成功返回 result.data，失败抛出异常
function callNoteCloud(type, data) {
  return wx.cloud
    .callFunction({
      name: CLOUD_FUNC,
      data: Object.assign({ type }, data || {}),
    })
    .then((res) => {
      const result = res.result || {};
      if (!result.success) {
        throw new Error(result.errMsg || "云函数调用失败");
      }
      return result.data;
    });
}

// 判断是否为云开发环境未开通/未配置错误（-601034：没有权限）
function isCloudEnvError(msg) {
  return msg.indexOf("-601034") > -1 || msg.indexOf("没有权限") > -1;
}

Page({
  data: {
    noteId: "", // 笔记 id（首页跳转传入）
    title: "", // 笔记标题
    content: "", // 原文文本（保留 \n 换行）
    fontSize: DEFAULT_FONT_SIZE, // 正文字号（rpx），滑块实时调节
    lineHeight: 51, // 正文行高（rpx），随字号联动
    mode: "edit", // 页面模式：edit 编辑模式 / recite 背书模式
    // ---------- 阶段3：荧光笔标注模块 ----------
    subTab: "edit", // 编辑模式内子页签：edit 文本编辑 / mark 荧光标注
    annotations: [], // 荧光笔标注数组：[{aid, startIdx, endIdx, text, color}]
    lineList: [], // 标注渲染数据：按 \n 分段，每行含字符列表
    hasText: false, // 是否有正文文本（空文本时显示引导提示）
    selOverlays: [], // 涂抹预览遮罩矩形列表（相对文本容器定位）
    markTool: "paint", // 标注工具：paint 涂抹 / erase 擦除 / browse 浏览（浏览模式下滑动翻页、轻点删除标注）
    markColor: "#fff200", // 当前荧光色，默认黄色
    colorOptions: ["#fff200", "#7fd4ff", "#a8e05f", "#ff9eb5", "#ffc069"], // 可选荧光色
    // ---------- 阶段4：背书模式挖空渲染 ----------
    digGroup: 0, // 当前选中的挖空组：0 挖第1组 / 1 挖第2组 / 2 挖第3组（单选）
    reciteLineList: [], // 背书渲染数据：按 \n 分段的行列表，行内按挖空切分文本段
    // ---------- 阶段5：挖空点击交互 ----------
    revealSegKey: "", // 当前被按住的挖空段 segKey：非空时该段展示原文，松开恢复下划线
    // ---------- 阶段6：异常捕获与 UI 优化 ----------
    isOffline: false, // 是否处于离线模式（显示本地缓存数据，联网后自动同步）
  },

  onLoad(query) {
    this.noteId = query.id || "";
    this.contentDraft = undefined; // 正文输入草稿：输入期间只记草稿不 setData，避免长文本光标跳动
    this.lockTimer = null; // 编辑锁心跳定时器
    // ---------- 标注模块内部状态（无需渲染，挂实例上） ----------
    this.scrollTop = 0; // 标注区当前滚动位置
    this.measureScrollTop = 0; // 测量字符矩形时的滚动位置
    this.charRects = []; // 每个字符的矩形（相对视口，按渲染元素顺序排列，\n 无元素）
    this.rectOfChar = {}; // 全局字符下标 → 矩形 映射（命中检测与遮罩定位用）
    this.contentRect = null; // 文本容器矩形（相对视口）
    this.lineCharStart = []; // 每行首字符全局下标
    this.lineCharEnd = []; // 每行末字符全局下标
    this.lineOfChar = []; // 全局字符下标 → 所在行号
    this.pendingTap = false; // 是否为轻点（浏览模式下使用）
    this.tapIndex = -1; // 轻点命中的字符下标
    this.painting = false; // 是否正在涂抹标注
    this.paintStart = -1; // 本次涂抹起始字符下标
    this.paintEnd = -1; // 本次涂抹当前字符下标
    this.annotationHistory = []; // 标注操作历史（涂抹 {type:"add",aids} / 擦除与删除 {type:"erase",anns}），供撤销
    this.erasePending = null; // 本次擦除目标集合：{aids, overlays}，触摸结束时统一删除
    this.digGroups = [[], [], []]; // 背书模式挖空分组结果（每次进入背书模式重新打乱）
    // 读取上次使用的字号（用户偏好）
    const fontSize = this.getSavedFontSize();
    this.setData({
      noteId: this.noteId,
      fontSize,
      lineHeight: this.calcLineHeight(fontSize),
    });
    // 编辑锁心跳失败兜底状态（连续失败达到阈值时提示用户）
    this.lockFailCount = 0; // 连续心跳失败次数
    this.lockFailWarned = false; // 是否已提示过锁失效风险
    this.dirty = false; // 是否有未保存的标题/正文修改（退出页面时自动保存）
    this.touchStartX = 0; // 一次触摸的起始坐标（用于区分轻点与滚动）
    this.touchStartY = 0;
    // 监听网络状态：网络恢复后自动同步云端最新数据
    this.onNetStatusChange = (res) => {
      if (res.isConnected) {
        this.refreshFromCloud();
      }
    };
    wx.onNetworkStatusChange(this.onNetStatusChange);
    this.loadNote();
  },

  onShow() {
    // 每次页面可见时启动编辑锁心跳（首次进入即加锁）
    this.startLockHeartbeat();
  },

  onHide() {
    // 页面隐藏（切后台等）时停止心跳；锁 3 分钟无人续期后自动失效
    this.stopLockHeartbeat();
    // 切后台兜底保存：防止小程序被系统回收导致未保存内容丢失
    this.autoSaveIfDirty();
  },

  onUnload() {
    // 页面卸载/返回首页：先自动保存未保存的修改，再停止心跳并释放编辑锁
    this.autoSaveIfDirty();
    this.stopLockHeartbeat();
    this.releaseLock();
    // 移除网络监听，避免页面卸载后残留回调
    if (this.onNetStatusChange) {
      wx.offNetworkStatusChange(this.onNetStatusChange);
      this.onNetStatusChange = null;
    }
  },

  // 云开发环境未开通/未配置：弹一次明确指引
  warnCloudEnv() {
    if (this.envWarned) return;
    this.envWarned = true;
    wx.showModal({
      title: "云开发未开通",
      content:
        "当前小程序未开通云开发环境。请在微信开发者工具中开通云开发，创建 notes 集合，并部署 notes 云函数。",
      showCancel: false,
      confirmText: "知道了",
    });
  },

  // ---------- 数据加载 ----------

  // 加载笔记：优先渲染本地缓存（离线立即出内容），云端拉取成功后覆盖刷新
  loadNote() {
    if (!this.noteId) {
      wx.showToast({ title: "缺少笔记参数", icon: "none" });
      return;
    }
    // 先渲染本地缓存（若有），离线/弱网时立即看到内容
    const local = this.findLocalNote();
    if (local) {
      this.renderNote(local);
      this.setData({ isOffline: true });
    }
    callNoteCloud("getNoteById", { id: this.noteId })
      .then((note) => {
        // 云端成功：同步刷新本地缓存，退出离线模式
        this.updateLocalCache(note);
        this.setData({ isOffline: false });
        this.renderNote(note);
      })
      .catch((err) => {
        // 离线兜底：本地数据已展示时仅提示离线；无本地数据则报错返回
        if (local) {
          wx.showToast({ title: "网络异常，已进入离线模式", icon: "none" });
        } else {
          const msg = (err && (err.errMsg || err.message)) || "";
          // 云开发未开通/未配置（-601034）：给明确指引，不误报网络异常
          if (isCloudEnvError(msg)) {
            this.warnCloudEnv();
            return;
          }
          wx.showModal({
            title: "加载失败",
            content:
              msg.indexOf("笔记不存在") > -1
                ? "笔记不存在，可能已被删除"
                : "网络异常，请稍后重试",
            showCancel: false,
            success: () => wx.navigateBack(),
          });
        }
      });
  },

  // 网络恢复后自动同步云端最新数据（静默执行，失败不打扰用户）
  refreshFromCloud() {
    if (!this.noteId) return;
    callNoteCloud("getNoteById", { id: this.noteId })
      .then((note) => {
        this.updateLocalCache(note);
        this.setData({ isOffline: false });
        if (this.contentDraft !== undefined) {
          // 用户正在输入：只刷新标注数据，不覆盖未保存的标题/正文草稿
          this.setData({ annotations: note.annotations || [] });
        } else {
          this.renderNote(note);
        }
      })
      .catch((err) => {
        console.error("联网自动同步失败", err);
      });
  },

  // 渲染笔记内容到页面
  renderNote(note) {
    this.annotationHistory = []; // 笔记数据变化后清空撤销历史
    if (this.contentDraft !== undefined) {
      // 用户正在输入：保留未保存的正文草稿，只更新标题与标注（防止云端返回慢时覆盖输入）
      this.setData({
        title: note.title || "",
        annotations: note.annotations || [],
      });
    } else {
      this.contentDraft = undefined;
      this.setData({
        title: note.title || "",
        content: note.content || "",
        annotations: note.annotations || [],
      });
    }
  },

  // ---------- 本地缓存（与首页共用 notes_cache） ----------

  // 从本地缓存查找当前笔记（离线兜底）
  findLocalNote() {
    const cache = wx.getStorageSync(CACHE_KEY) || [];
    return cache.find((item) => item._id === this.noteId);
  },

  // 把最新数据合并进本地缓存（保存成功/失败都调用，保证离线可用）
  updateLocalCache(partial) {
    const cache = wx.getStorageSync(CACHE_KEY) || [];
    const index = cache.findIndex((item) => item._id === this.noteId);
    if (index > -1) {
      cache[index] = Object.assign({}, cache[index], partial);
    } else {
      // 缓存中还没有这条笔记（极端情况）：补一条
      cache.unshift(Object.assign({ _id: this.noteId, createTime: new Date() }, partial));
    }
    wx.setStorageSync(CACHE_KEY, cache);
  },

  // ---------- 输入处理 ----------

  // 标题输入（标题短，直接 setData 无压力）
  onTitleInput(e) {
    this.dirty = true; // 标记有未保存修改
    this.setData({ title: e.detail.value });
  },

  // 正文输入：仅记录草稿，保存或切换页签时再落回 data
  // 文本保留 \n 换行符，粘贴同样保留
  onContentInput(e) {
    this.dirty = true; // 标记有未保存修改
    this.contentDraft = e.detail.value;
  },

  // 字号滑块：实时作用于正文渲染区域，并记住用户偏好
  onFontChange(e) {
    const fontSize = e.detail.value;
    this.setData({
      fontSize,
      lineHeight: this.calcLineHeight(fontSize),
    });
    wx.setStorageSync(FONT_KEY, fontSize);
  },

  // 读取上次保存的字号，越界时用默认值
  getSavedFontSize() {
    const size = Number(wx.getStorageSync(FONT_KEY));
    return size >= FONT_MIN && size <= FONT_MAX ? size : DEFAULT_FONT_SIZE;
  },

  // 行高随字号联动（1.6 倍）
  calcLineHeight(fontSize) {
    return Math.round(fontSize * 1.6);
  },

  // ---------- 保存 ----------

  // 保存按钮：标题 + 正文同步保存到云数据库，同时写入本地 storage 缓存
  // 正文被编辑后标注下标会错位：保存时按标注文本重新锚定（高光与文字绑定），
  // 文字被改动的标注自动失效，失效数量通过 toast 告知用户
  onSave() {
    const title = (this.data.title || "").trim();
    if (!title) {
      wx.showToast({ title: "标题不能为空", icon: "none" });
      return;
    }
    // 正文取草稿；未输入过则取初始加载值
    const content =
      this.contentDraft !== undefined ? this.contentDraft : this.data.content;
    // 重定位标注：锚定文字重新计算下标，失效标注（文字被改动）一并剔除
    const { annotations, lost } = this.relocateAnnotations(content, this.data.annotations || []);
    wx.showLoading({ title: "保存中" });
    callNoteCloud("updateNote", { id: this.noteId, title, content, annotations })
      .then(() => {
        wx.hideLoading();
        // 云端成功：同步本地缓存 + 落回页面显示值
        this.dirty = false; // 保存成功，清除未保存标记
        this.updateLocalCache({ title, content, annotations });
        this.contentDraft = undefined;
        this.setData({ content, annotations });
        wx.showToast({
          title: lost > 0 ? "已保存，部分标注因文字修改失效" : "已保存",
          icon: "success",
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error("保存笔记失败", err);
        // 云端失败：仍写入本地缓存，保证离线可继续编辑
        this.updateLocalCache({ title, content, annotations });
        wx.showToast({ title: "网络异常，已保存到本地", icon: "none" });
      });
  },

  // 离开页面时自动保存：标题/正文有未保存修改则静默同步（云端失败写入本地缓存）
  // 标注随正文一起保存：先按文字重新锚定，保证云端存的是编辑后的正确下标
  autoSaveIfDirty() {
    if (!this.noteId || !this.dirty) return;
    const title = (this.data.title || "").trim();
    // 正文取草稿；未输入过则取初始加载值
    const content =
      this.contentDraft !== undefined ? this.contentDraft : this.data.content;
    const { annotations } = this.relocateAnnotations(content, this.data.annotations || []);
    this.dirty = false;
    if (!title) {
      // 标题为空不合规：仅写本地缓存保底，不覆盖云端数据
      this.updateLocalCache({ title: this.data.title, content, annotations });
      return;
    }
    callNoteCloud("updateNote", { id: this.noteId, title, content, annotations })
      .then(() => {
        this.updateLocalCache({ title, content, annotations });
      })
      .catch((err) => {
        console.error("自动保存失败，已写入本地缓存", err);
        this.updateLocalCache({ title, content, annotations });
      });
  },

  // ---------- 模式切换 ----------

  // 切换【编辑模式 / 背书模式】
  onSwitchMode(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.mode) return;
    // 切换前把正文草稿落回 data，避免 textarea 重新渲染丢失未保存内容
    if (this.contentDraft !== undefined) {
      this.setData({ content: this.contentDraft });
      this.contentDraft = undefined;
    }
    // 离开编辑模式时收起标注操作栏，避免残留状态
    if (mode !== "edit") {
      this.clearSelection();
    }
    this.setData({ mode }, () => {
      // 每次进入背书模式：全部标注重新随机打乱分组，默认选中挖第1组
      if (mode === "recite") {
        this.buildDigGroups();
        this.setData({ digGroup: 0 }, () => this.buildReciteLines());
        // 边界提示：无文本 / 无标注时进入背书模式给出轻提示
        if (!(this.data.content || "").trim()) {
          wx.showToast({ title: "暂无文本，请先在编辑模式录入", icon: "none" });
        } else if (!(this.digAnnotations || []).length) {
          wx.showToast({ title: "暂无标注，先用荧光笔标注重点", icon: "none" });
        }
      }
    });
    // 同步导航栏标题，让用户清楚当前所处模式
    wx.setNavigationBarTitle({
      title: mode === "edit" ? "编辑笔记" : "背书模式",
    });
  },

  // ---------- 编辑模式内子页签切换（文本编辑 / 荧光标注） ----------

  onSwitchSubTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.subTab) return;
    // 切走前把正文草稿落回 data（与模式切换同理）
    if (this.contentDraft !== undefined) {
      this.setData({ content: this.contentDraft });
      this.contentDraft = undefined;
    }
    if (tab === "edit") {
      this.clearSelection();
    }
    this.setData({ subTab: tab }, () => {
      // 进入标注页签后重建渲染数据（此时节点已渲染，字符测量才有效）
      if (tab === "mark") {
        this.rebuildCharList();
      }
    });
  },

  // ---------- 荧光笔标注：渲染 ----------

  // 按当前正文重新锚定标注下标（高光与文字绑定）：
  // 标注按字符下标记录，正文被编辑（增删文字）后下标会整体错位。
  // 每个标注存有原文 text：在正文中从上一标注结束位置之后顺序查找 text，
  // 找到则更新 startIdx/endIdx，保持标注相对顺序；
  // 找不到（标注文字已被修改/删除）则视为失效剔除，由调用方决定是否提示。
  relocateAnnotations(content, annotations) {
    const sorted = (annotations || [])
      .slice()
      .sort((a, b) => a.startIdx - b.startIdx);
    const relocated = [];
    let searchFrom = 0; // 从上一标注结束位置之后查找，处理重复文本时保持顺序
    let lost = 0;
    sorted.forEach((ann) => {
      const text = ann.text || "";
      if (!text) {
        lost++;
        return;
      }
      const pos = content.indexOf(text, searchFrom);
      if (pos === -1) {
        lost++; // 标注文字已被改动：该标注失效
        return;
      }
      relocated.push(
        Object.assign({}, ann, {
          startIdx: pos,
          endIdx: pos + text.length - 1,
        })
      );
      searchFrom = pos + text.length;
    });
    return { annotations: relocated, lost };
  },

  // 重建渲染数据：按 \n 分段，逐字符计算荧光底色
  // 标注区间互不重叠且按 startIdx 升序，可用游标一次遍历完成着色
  rebuildCharList() {
    // scroll-view 重建后滚动位置归零，先重置记录值，避免命中检测基准错位
    this.scrollTop = 0;
    const content = this.data.content || "";
    // 文字编辑后标注下标会错位：按标注文本重新锚定（高光与文字绑定），
    // 失效标注（文字被改动）自动剔除，重定位结果写回 data 供后续操作使用
    const { annotations } = this.relocateAnnotations(content, this.data.annotations || []);
    const lines = content.split("\n");
    const lineList = [];
    const lineCharStart = [];
    const lineCharEnd = [];
    const lineOfChar = []; // 以全局下标索引行号（\n 无渲染元素，对应位置留空）
    const charIndexes = []; // 渲染元素顺序（文档顺序）→ 全局字符下标 映射
    let globalIndex = 0; // 全局字符下标（\n 也占一个下标）
    let annCursor = 0; // 标注游标
    lines.forEach((lineText, li) => {
      const chars = [];
      const startIdx = globalIndex;
      for (let i = 0; i < lineText.length; i++) {
        // 推进标注游标：跳过已越过的标注区间
        while (annCursor < annotations.length && annotations[annCursor].endIdx < globalIndex) {
          annCursor++;
        }
        const ann = annotations[annCursor];
        // 下标含首尾：字符落在 [startIdx, endIdx] 内即为已标注
        const color =
          ann && ann.startIdx <= globalIndex && globalIndex <= ann.endIdx ? ann.color : "";
        chars.push({ index: globalIndex, ch: lineText[i], color });
        lineOfChar[globalIndex] = li; // 全局下标 → 行号
        charIndexes.push(globalIndex); // 元素顺序 → 全局下标
        globalIndex++;
      }
      globalIndex++; // 跳过 \n 字符本身
      lineList.push({ lineIndex: li, chars });
      lineCharStart.push(startIdx);
      lineCharEnd.push(startIdx + lineText.length - 1);
    });
    this.lineCharStart = lineCharStart;
    this.lineCharEnd = lineCharEnd;
    this.lineOfChar = lineOfChar;
    this.charIndexes = charIndexes;
    this.rectOfChar = {}; // 测量前先清空 全局下标 → 矩形 映射
    this.setData({ lineList, hasText: content.length > 0, annotations }, () =>
      this.measureCharRects()
    );
  },

  // 测量每个字符与文本容器的矩形（相对视口），供坐标命中检测与遮罩定位使用
  measureCharRects() {
    const query = wx.createSelectorQuery().in(this);
    query.select(".text-content").boundingClientRect();
    query.selectAll(".char").boundingClientRect();
    query.select(".mark-scroll").scrollOffset();
    query.exec((res) => {
      if (!res || !res[0] || !res[1]) return;
      this.contentRect = res[0];
      // selectAll 按文档顺序返回，与 charIndexes 构建顺序一致；
      // 渲染元素不含 \n，数组下标与全局下标不一致，需借助 charIndexes 映射
      this.rectOfChar = {};
      this.charRects = res[1].map((r, i) => {
        const gi = this.charIndexes ? this.charIndexes[i] : undefined;
        const rect = Object.assign({}, r, { index: gi });
        if (gi !== undefined) {
          this.rectOfChar[gi] = rect; // 全局下标 → 矩形
        }
        return rect;
      });
      // 以实测滚动位置为测量基准（scroll-view 重建后滚动归零，避免残留值导致偏移）
      this.scrollTop = (res[2] && res[2].scrollTop) || 0;
      this.measureScrollTop = this.scrollTop;
    });
  },

  // 记录滚动位置：命中检测时用于校正滚动偏移
  onTextScroll(e) {
    this.scrollTop = e.detail.scrollTop;
  },

  // 主动校准标注区真实滚动位置：scroll 事件可能滞后于惯性滚动，
  // 触摸开始时查询一次 scroll-view 的实际 scrollTop，消除命中偏移
  calibrateScrollTop() {
    if (this.calibrating) return; // 上一次查询未返回时跳过，避免堆积
    this.calibrating = true;
    wx.createSelectorQuery()
      .in(this)
      .select(".mark-scroll")
      .scrollOffset((res) => {
        this.calibrating = false;
        if (res) this.scrollTop = res.scrollTop;
      })
      .exec();
  },

  // ---------- 荧光笔标注：涂抹交互（手指/触控笔滑动经过即选中，松手自动标注） ----------

  // 触摸开始：涂抹工具按下即开始涂抹；擦除工具开始收集待擦标注；浏览工具记录轻点候选
  onTextTouchStart(e) {
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    this.touchStartX = touch.clientX; // 起点坐标：touchend 时计算位移过滤滚动误触
    this.touchStartY = touch.clientY;
    this.calibrateScrollTop(); // 主动校准滚动位置，避免 scroll 事件滞后导致命中偏移
    const index = this.hitTestChar(touch.clientX, touch.clientY);
    const tool = this.data.markTool;
    if (tool === "paint") {
      // 涂抹：按下即开始涂抹，实时显示预览遮罩
      if (index < 0) return;
      this.painting = true;
      this.paintStart = index;
      this.paintEnd = index;
      this.setData({ selOverlays: this.buildPaintOverlays(index, index) });
    } else if (tool === "erase") {
      // 擦除：初始化本次擦除目标集合
      this.erasePending = { aids: [], overlays: [] };
      if (index >= 0) {
        const ann = this.findAnnotationAt(index);
        if (ann) this.addEraseTarget(ann);
      }
    } else {
      // 浏览：先假定为轻点（用于删除标注）
      this.pendingTap = true;
      this.tapIndex = index;
    }
  },

  // 拖动：涂抹实时扩展范围；擦除滑过标注即加入擦除目标；浏览的移动交给 scroll-view 正常滚动
  onTextTouchMove(e) {
    const tool = this.data.markTool;
    if (tool === "browse") {
      this.pendingTap = false; // 手指移动说明不是轻点
      return;
    }
    const touch = e.touches && e.touches[0];
    if (!touch) return;
    const index = this.hitTestChar(touch.clientX, touch.clientY);
    if (index < 0) return;
    if (tool === "paint") {
      if (!this.painting || index === this.paintEnd) return;
      this.paintEnd = index;
      const start = Math.min(this.paintStart, index);
      const end = Math.max(this.paintStart, index);
      this.setData({ selOverlays: this.buildPaintOverlays(start, end) });
    } else if (tool === "erase") {
      // 擦除：滑过已标注文字即加入擦除目标（白色遮罩实时预览）
      if (!this.erasePending) return;
      const ann = this.findAnnotationAt(index);
      if (ann) this.addEraseTarget(ann);
    }
  },

  // 触摸结束：涂抹保存本次涂抹；擦除删除本次擦除目标；浏览区分滚动与轻点
  onTextTouchEnd(e) {
    const tool = this.data.markTool;
    if (tool === "paint") {
      // 涂抹结束：松手即保存标注，无需逐个确认
      if (!this.painting) return;
      this.painting = false;
      this.commitPaint();
      return;
    }
    if (tool === "erase") {
      // 擦除结束：删除本次滑过的高光
      if (this.erasePending) this.commitErase();
      return;
    }
    if (!this.pendingTap) return;
    this.pendingTap = false;
    // 手指位移超过阈值说明是滚动/滑动操作，忽略轻点，避免滚动误触选中
    const touch = e.changedTouches && e.changedTouches[0];
    if (!touch) return;
    const dx = touch.clientX - this.touchStartX;
    const dy = touch.clientY - this.touchStartY;
    if (dx * dx + dy * dy > TAP_MOVE_THRESHOLD * TAP_MOVE_THRESHOLD) return;
    const index = this.tapIndex;
    if (index < 0) return;
    const ann = this.findAnnotationAt(index);
    if (ann) {
      // 轻点已标注文字：询问删除该条标注
      this.onTapAnnotation(ann);
    }
  },

  // 触摸取消：丢弃未完成的涂抹/擦除；浏览清理轻点状态
  onTextTouchCancel() {
    if (this.painting) {
      this.painting = false;
    }
    if (this.erasePending) {
      this.erasePending = null;
    }
    this.pendingTap = false;
    this.setData({ selOverlays: [] });
  },

  // 涂抹预览遮罩：复用选区遮罩计算，颜色跟随当前荧光色（40% 透明度）
  buildPaintOverlays(startIdx, endIdx) {
    const color = this.data.markColor + "66"; // 8 位 hex 透明度
    return this.buildSelectionOverlays(startIdx, endIdx).map((item) =>
      Object.assign({}, item, { color })
    );
  },

  // 涂抹结束保存：自动跳过涂抹范围中已标注的区域，一次涂抹可产生多条标注
  commitPaint() {
    const start = Math.min(this.paintStart, this.paintEnd);
    const end = Math.max(this.paintStart, this.paintEnd);
    const content = this.data.content;
    const annotations = this.data.annotations.slice();
    // 计算涂抹范围中与已有标注不相交的连续子区间
    const gaps = this.buildPaintGaps(annotations, start, end);
    if (!gaps.length) {
      this.setData({ selOverlays: [] });
      wx.showToast({ title: "该区域已标注，不可重复标注", icon: "none" });
      return;
    }
    const addedAids = [];
    gaps.forEach((gap) => {
      const annotation = {
        aid: "a" + Date.now() + Math.floor(Math.random() * 1000), // 唯一 id
        startIdx: gap[0], // 起始字符下标（含）
        endIdx: gap[1], // 结束字符下标（含）
        text: content.substring(gap[0], gap[1] + 1), // 标注文本
        color: this.data.markColor, // 荧光色
      };
      annotations.push(annotation);
      addedAids.push(annotation.aid);
    });
    // 保持按 startIdx 升序，渲染与防重复判断都依赖有序性
    annotations.sort((a, b) => a.startIdx - b.startIdx);
    // 记录本次涂抹产生的标注，供「撤销」退回上一步
    this.annotationHistory.push({ type: "add", aids: addedAids });
    this.setData({ annotations, selOverlays: [] });
    this.saveAnnotations(annotations);
    this.rebuildCharList();
  },

  // 擦除目标加入待擦集合：该标注区间叠加白色遮罩表示将被擦除（实时预览）
  addEraseTarget(ann) {
    const pending = this.erasePending;
    if (!pending || pending.aids.indexOf(ann.aid) > -1) return;
    pending.aids.push(ann.aid);
    const overlays = this.buildSelectionOverlays(ann.startIdx, ann.endIdx).map((item) =>
      Object.assign({}, item, { color: "rgba(255,255,255,0.9)" })
    );
    this.setData({ selOverlays: pending.overlays.concat(overlays) });
    pending.overlays = pending.overlays.concat(overlays);
  },

  // 擦除结束：删除本次滑动擦除的高光，并记录操作供「撤销」恢复
  commitErase() {
    const pending = this.erasePending;
    this.erasePending = null;
    if (!pending || !pending.aids.length) {
      this.setData({ selOverlays: [] });
      return;
    }
    const removed = this.data.annotations.filter((ann) => pending.aids.indexOf(ann.aid) > -1);
    if (!removed.length) {
      this.setData({ selOverlays: [] });
      return;
    }
    const annotations = this.data.annotations.filter(
      (ann) => pending.aids.indexOf(ann.aid) === -1
    );
    // 记录擦除操作，支持「撤销」恢复误擦的高光
    this.annotationHistory.push({ type: "erase", anns: removed });
    this.setData({ annotations, selOverlays: [] });
    this.saveAnnotations(annotations);
    this.rebuildCharList();
  },

  // 计算涂抹范围 [s, e] 中与已有标注不相交的连续子区间（自动跳过已标注区域）
  buildPaintGaps(annotations, s, e) {
    const gaps = [];
    let cursor = s;
    // 只取与涂抹范围相交的标注，按 startIdx 升序
    const overlapped = annotations
      .filter((ann) => ann.startIdx <= e && ann.endIdx >= s)
      .sort((a, b) => a.startIdx - b.startIdx);
    overlapped.forEach((ann) => {
      if (cursor > e) return;
      if (cursor < ann.startIdx) {
        gaps.push([cursor, Math.min(ann.startIdx - 1, e)]);
      }
      if (ann.endIdx >= cursor) {
        cursor = ann.endIdx + 1;
      }
    });
    if (cursor <= e) {
      gaps.push([cursor, e]);
    }
    return gaps;
  },

  // 坐标命中检测：返回距离 (clientX, clientY) 最近的字符全局下标
  hitTestChar(clientX, clientY) {
    const rects = this.charRects;
    if (!rects || !rects.length) return -1;
    // 滚动后字符视口位置 = 测量值 - 滚动增量，等价于把触摸坐标加回增量
    const delta = (this.scrollTop || 0) - (this.measureScrollTop || 0);
    const x = clientX;
    const y = clientY + delta;
    // rects 按文档顺序排列，top/bottom 随行号单调不减：
    // 先按 y 二分缩小候选区间（±一行），避免长文本每次触摸全量遍历卡顿
    const band = (rects[0].height || rects[0].bottom - rects[0].top) || 30;
    let lo = 0;
    let hi = rects.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rects[mid].bottom < y - band) lo = mid + 1;
      else hi = mid;
    }
    const from = lo;
    lo = 0;
    hi = rects.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (rects[mid].top <= y + band) lo = mid + 1;
      else hi = mid;
    }
    const to = lo;
    let best = -1;
    let bestDist = Infinity;
    for (let i = from; i < to; i++) {
      const r = rects[i];
      // 取字符矩形上离 (x, y) 最近的点计算距离
      const cx = Math.max(r.left, Math.min(x, r.right));
      const cy = Math.max(r.top, Math.min(y, r.bottom));
      const dist = (x - cx) * (x - cx) + (y - cy) * (y - cy);
      if (dist < bestDist) {
        bestDist = dist;
        best = i;
      }
    }
    // 数组下标 → 全局字符下标（渲染元素不含 \n，两者不一致，直接返回会偏移）
    const gi = best < 0 ? -1 : this.charIndexes[best];
    return gi === undefined ? -1 : gi;
  },

  // 计算选中范围的遮罩矩形：跨行时按行拆分为多个矩形（坐标为相对文本容器）
  buildSelectionOverlays(startIdx, endIdx) {
    const overlays = [];
    const content = this.contentRect;
    const rectOfChar = this.rectOfChar;
    if (!rectOfChar || !content || startIdx < 0 || endIdx < 0) return overlays;
    const sLine = this.lineOfChar[startIdx];
    const eLine = this.lineOfChar[endIdx];
    if (sLine === undefined || eLine === undefined) return overlays;
    for (let li = sLine; li <= eLine; li++) {
      const a = Math.max(startIdx, this.lineCharStart[li]);
      const b = Math.min(endIdx, this.lineCharEnd[li]);
      if (a > b) continue;
      // 用全局下标取对应矩形（\n 无渲染元素，不能按数组下标取）
      const ra = rectOfChar[a];
      const rb = rectOfChar[b];
      if (!ra || !rb) continue;
      overlays.push({
        left: ra.left - content.left,
        top: ra.top - content.top,
        width: rb.right - ra.left,
        height: ra.height || rb.bottom - rb.top,
      });
    }
    return overlays;
  },

  // ---------- 荧光笔标注：模式切换 / 撤销 / 删除 / 保存 ----------

  // 切换标注工具：paint 涂抹 / erase 擦除 / browse 浏览
  // 涂抹：滑动即涂字（滑动不翻页）；擦除：滑动擦除高光；浏览：滑动翻页、轻点删除标注
  onSelectTool(e) {
    const tool = e.currentTarget.dataset.tool;
    if (!tool || tool === this.data.markTool) return;
    this.clearSelection(); // 切换工具时丢弃未完成的涂抹/擦除
    this.setData({ markTool: tool });
  },

  // 退回上一步：撤销最近一次标注操作（涂抹 / 擦除 / 轻点删除）
  onUndoAnnotation() {
    const history = this.annotationHistory;
    // 跳过已失效的记录（如标注已被后续操作删除）
    while (history.length) {
      const op = history.pop();
      if (op.type === "add") {
        // 撤销涂抹：删除该次涂抹产生的标注
        const kept = this.data.annotations.filter((ann) => op.aids.indexOf(ann.aid) === -1);
        if (kept.length < this.data.annotations.length) {
          this.applyAnnotations(kept);
          wx.showToast({ title: "已撤销", icon: "success" });
          return;
        }
      } else if (op.type === "erase") {
        // 撤销删除/擦除：恢复被删除的标注（跳过与现有标注重叠的部分）
        const kept = this.data.annotations;
        const restored = op.anns.filter(
          (ann) => !kept.some((k) => k.startIdx <= ann.endIdx && k.endIdx >= ann.startIdx)
        );
        if (restored.length) {
          const next = kept.concat(restored).sort((a, b) => a.startIdx - b.startIdx);
          this.applyAnnotations(next);
          wx.showToast({ title: "已撤销", icon: "success" });
          return;
        }
      }
    }
    wx.showToast({ title: "没有可撤销的标注", icon: "none" });
  },

  // 应用标注变更：更新页面 + 云端保存 + 重建渲染（撤销操作共用）
  // 保存前先按正文重定位，保证存到云端的是与当前文字一致的下标
  applyAnnotations(annotations) {
    const { annotations: relocated } = this.relocateAnnotations(
      this.data.content || "",
      annotations
    );
    this.setData({ annotations: relocated });
    this.saveAnnotations(relocated);
    this.rebuildCharList();
  },

  // 取消涂抹/擦除：清除预览遮罩与未完成状态
  clearSelection() {
    this.painting = false;
    this.erasePending = null;
    this.setData({ selOverlays: [] });
  },

  // 切换荧光颜色
  onChooseColor(e) {
    const color = e.currentTarget.dataset.color;
    if (!color) return;
    this.setData({ markColor: color });
  },

  // 轻点已标注文字：确认后删除该条标注
  onTapAnnotation(ann) {
    const preview = ann.text.length > 12 ? ann.text.slice(0, 12) + "…" : ann.text;
    wx.showModal({
      title: "删除标注",
      content: `删除标注「${preview}」吗？`,
      confirmText: "删除",
      confirmColor: "#c94f4f", // 轻量红色提示，避免强刺激
      success: (res) => {
        if (!res.confirm) return;
        const annotations = this.data.annotations.filter((item) => item.aid !== ann.aid);
        // 记录删除操作，支持「撤销」恢复误删的标注
        this.annotationHistory.push({ type: "erase", anns: [ann] });
        this.setData({ annotations });
        this.saveAnnotations(annotations);
        this.rebuildCharList();
      },
    });
  },

  // 标注数组保存：云端 + 本地 storage（独立于正文保存按钮，标注变更即自动保存）
  saveAnnotations(annotations) {
    callNoteCloud("updateNote", { id: this.noteId, annotations })
      .then(() => {
        this.updateLocalCache({ annotations });
      })
      .catch((err) => {
        console.error("保存标注失败", err);
        // 云端失败：仍写入本地缓存，保证离线可继续标注
        this.updateLocalCache({ annotations });
        wx.showToast({ title: "网络异常，标注已保存到本地", icon: "none" });
      });
  },

  // 查找覆盖指定字符下标的标注（下标含首尾）
  findAnnotationAt(index) {
    const annotations = this.data.annotations || [];
    return annotations.find((ann) => ann.startIdx <= index && index <= ann.endIdx) || null;
  },

  // ---------- 阶段4：背书模式挖空渲染（不改动荧光笔与保存逻辑） ----------

  // 切换挖空组（单选）：仅选中组的标注替换为下划线占位，其余两组原文正常展示
  onSwitchDigGroup(e) {
    const group = Number(e.currentTarget.dataset.group);
    if (group === this.data.digGroup) return;
    this.setData({ digGroup: group }, () => this.buildReciteLines());
  },

  // 打乱分组：每次进入背书模式，全部标注重新随机打乱
  // 均分3组，余数优先分配给第1组（如 7 个标注 → 3+2+2）
  buildDigGroups() {
    // 文字编辑后标注下标可能失效：先按标注文本重新锚定再分组，挖空位置才正确
    const { annotations } = this.relocateAnnotations(
      this.data.content || "",
      this.data.annotations || []
    );
    this.digAnnotations = annotations; // 有效标注（供边界提示判断）
    // Fisher-Yates 洗牌：打乱标注顺序
    const shuffled = annotations.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const tmp = shuffled[i];
      shuffled[i] = shuffled[j];
      shuffled[j] = tmp;
    }
    // 均分：每组 base 个，余数按组序从第1组开始每组多 1 个
    const base = Math.floor(shuffled.length / 3);
    const remainder = shuffled.length % 3;
    const groups = [[], [], []];
    let cursor = 0;
    for (let g = 0; g < 3; g++) {
      const size = base + (g < remainder ? 1 : 0);
      groups[g] = shuffled.slice(cursor, cursor + size);
      cursor += size;
    }
    this.digGroups = groups;
  },

  // 生成与原文等宽的挖空占位：全角字符用全角下划线、半角字符用半角下划线，
  // 占位宽度近似原文宽度，按下展示原文时行内布局不跳动
  buildUnderscores(text) {
    let out = "";
    for (const ch of text) {
      out += ch.charCodeAt(0) > 0xff ? "＿" : "_";
    }
    return out;
  },

  // 渲染挖空文本：按 \n 分段，选中组的标注替换为下划线占位
  buildReciteLines() {
    const content = this.data.content || "";
    const group = (this.digGroups || [[], [], []])[this.data.digGroup] || [];
    // 选中组内标注按 startIdx 升序，便于行内顺序切分
    const sorted = group.slice().sort((a, b) => a.startIdx - b.startIdx);
    const lines = content.split("\n");
    const reciteLineList = [];
    let lineStart = 0; // 当前行首字符的全局下标（\n 也占一个下标）
    lines.forEach((lineText, li) => {
      const segments = [];
      const lineEnd = lineStart + lineText.length - 1;
      let pos = 0; // 行内游标（相对行首）
      sorted.forEach((ann) => {
        // 与当前行无交集则跳过
        if (ann.endIdx < lineStart || ann.startIdx > lineEnd) return;
        // 标注与当前行的交集，换算为行内相对下标
        const s = Math.max(ann.startIdx, lineStart);
        const e = Math.min(ann.endIdx, lineEnd);
        const relS = s - lineStart;
        const relE = e - lineStart;
        // 标注前的普通文本段
        if (relS > pos) {
          segments.push({
            segKey: li + "-t" + pos,
            text: lineText.substring(pos, relS),
            cloze: false,
          });
        }
        // 挖空段：渲染为下划线占位（原文保留在 text 中，供触发展示原文使用）
        segments.push({
          segKey: li + "-c" + relS,
          text: lineText.substring(relS, relE + 1),
          cloze: true,
          // 与原文等宽的占位字符：按下展示原文时布局不跳动（修复挖空点击位置偏移）
          underscores: this.buildUnderscores(lineText.substring(relS, relE + 1)),
        });
        pos = relE + 1;
      });
      // 行尾剩余普通文本
      if (pos < lineText.length) {
        segments.push({
          segKey: li + "-t" + pos,
          text: lineText.substring(pos),
          cloze: false,
        });
      }
      reciteLineList.push({ lineIndex: li, segments });
      lineStart += lineText.length + 1; // 跳过 \n 字符
    });
    // 重建渲染数据后清空交互状态，避免残留的段 key 命中新数据
    this.setData({ reciteLineList, hasText: content.length > 0, revealSegKey: "" });
  },

  // ---------- 阶段5：挖空区域点击交互（不改动分组与渲染逻辑） ----------

  // 按下挖空下划线：瞬间展示原本标注文字
  onClozeTouchStart(e) {
    const key = e.currentTarget.dataset.key;
    if (!key || key === this.data.revealSegKey) return;
    this.setData({ revealSegKey: key });
  },

  // 松开：立刻恢复为下划线占位
  onClozeTouchEnd(e) {
    const key = e.currentTarget.dataset.key;
    if (this.data.revealSegKey === key) {
      this.setData({ revealSegKey: "" });
    }
  },

  // 触摸被系统打断（来电等）：同样恢复下划线
  onClozeTouchCancel(e) {
    this.onClozeTouchEnd(e);
  },

  // ---------- 编辑锁心跳 ----------

  // 启动心跳：立即写入一次（加锁），之后每 30 秒刷新时间戳
  startLockHeartbeat() {
    if (!this.noteId) return;
    this.stopLockHeartbeat(); // 防止重复启动产生多个定时器
    this.refreshLock();
    this.lockTimer = setInterval(() => {
      this.refreshLock();
    }, LOCK_HEARTBEAT_INTERVAL);
  },

  // 停止心跳定时器
  stopLockHeartbeat() {
    if (this.lockTimer) {
      clearInterval(this.lockTimer);
      this.lockTimer = null;
    }
  },

  // 心跳：更新 editingOpenid 与 editingTimestamp（锁超时 3 分钟自动失效）
  refreshLock() {
    callNoteCloud("updateLock", { id: this.noteId })
      .then(() => {
        // 心跳恢复：清零失败计数，下次失败重新计数
        this.lockFailCount = 0;
        this.lockFailWarned = false;
      })
      .catch((err) => {
        // 心跳失败不打断用户编辑，下个周期自动重试
        console.error("编辑锁心跳刷新失败", err);
        // 兜底：连续多次失败说明网络异常，锁 3 分钟超时后将失效，
        // 提示用户留意其他设备可能进入编辑
        this.lockFailCount = (this.lockFailCount || 0) + 1;
        if (this.lockFailCount >= LOCK_FAIL_WARN_COUNT && !this.lockFailWarned) {
          this.lockFailWarned = true;
          wx.showToast({ title: "网络异常，编辑锁可能失效", icon: "none" });
        }
      });
  },

  // 释放锁：清空 editingOpenid 与 editingTimestamp
  releaseLock() {
    if (!this.noteId) return;
    callNoteCloud("releaseLock", { id: this.noteId }).catch((err) => {
      // 离线时释放失败没关系：锁 3 分钟超时后自动失效
      console.error("释放编辑锁失败", err);
    });
  },
});
