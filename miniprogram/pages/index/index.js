// index.js —— 首页笔记列表
// 数据来源：notes 云函数（云端主数据）+ 本地 storage 缓存（离线兜底）
const CLOUD_FUNC = "notes"; // 笔记模块云函数名
const CACHE_KEY = "notes_cache"; // 笔记列表本地缓存 key
const LOCK_TIMEOUT = 3 * 60 * 1000; // 编辑锁心跳超时时间：3 分钟

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
    noteList: [], // 笔记列表（按创建时间倒序）
    isOffline: false, // 是否处于离线模式（显示本地缓存数据，联网后自动同步）
  },

  onLoad() {
    // 监听网络状态变化：网络恢复后自动同步云端
    this.onNetStatusChange = (res) => {
      if (res.isConnected) {
        this.loadNoteList();
      }
    };
    wx.onNetworkStatusChange(this.onNetStatusChange);
  },

  onUnload() {
    // 移除网络监听，避免页面卸载后残留回调
    if (this.onNetStatusChange) {
      wx.offNetworkStatusChange(this.onNetStatusChange);
      this.onNetStatusChange = null;
    }
  },

  // 云开发环境未开通/未配置：弹一次明确指引（避免每次 onShow 重复打扰）
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

  onShow() {
    // 每次页面显示都刷新列表：从编辑页返回、恢复网络后都能自动同步
    this.loadNoteList();
  },

  // 下拉刷新：离线恢复网络后可手动拉取云端数据
  onPullDownRefresh() {
    this.loadNoteList().finally(() => {
      wx.stopPullDownRefresh();
    });
  },

  // 加载笔记列表：优先渲染本地缓存（离线立即出内容），再拉云端刷新
  // 云端失败标记离线模式；网络恢复后由网络监听自动重新同步
  loadNoteList() {
    // 优先读取本地 storage 笔记并渲染，保证首屏有内容可看
    const cached = wx.getStorageSync(CACHE_KEY) || [];
    if (cached.length) {
      this.renderList(cached);
    }
    return callNoteCloud("getNoteList")
      .then((list) => {
        // 云端成功：刷新本地缓存，退出离线模式
        wx.setStorageSync(CACHE_KEY, list);
        this.setData({ isOffline: false });
        this.renderList(list);
      })
      .catch((err) => {
        console.error("云端拉取笔记失败，回退本地缓存", err);
        const msg = (err && (err.errMsg || err.message)) || "";
        // 集合未创建时给出明确引导
        if (msg.indexOf("集合") > -1 || msg.indexOf("collection") > -1) {
          this.setData({ noteList: [], isOffline: false });
          wx.showToast({ title: "请先在云开发控制台创建 notes 集合", icon: "none" });
          return;
        }
        // 云开发未开通/未配置（-601034）：弹明确指引，不误报网络异常
        if (isCloudEnvError(msg)) {
          this.setData({ noteList: [], isOffline: false });
          this.warnCloudEnv();
          return;
        }
        // 无网络等异常：本地缓存已渲染，标记离线模式
        // 提示只在状态变化时弹一次，避免每次 onShow 重复打扰
        if (cached.length) {
          const wasOffline = this.data.isOffline;
          this.setData({ isOffline: true });
          if (!wasOffline) {
            wx.showToast({ title: "网络异常，已进入离线模式", icon: "none" });
          }
        } else {
          this.setData({ noteList: [], isOffline: true });
          wx.showToast({ title: "网络异常，请检查网络后重试", icon: "none" });
        }
      });
  },

  // 渲染列表：补充展示字段（格式化时间、标注数、锁状态）并保证倒序
  renderList(list) {
    const noteList = (list || [])
      .map((item) => {
        const annotations = item.annotations || [];
        return Object.assign({}, item, {
          createTimeText: this.formatTime(item.createTime), // 格式化创建时间
          annotationCount: annotations.length, // 标注数量
          // 编辑锁是否有效：编辑者 openid 非空且心跳未超过 3 分钟
          isLocked:
            !!item.editingOpenid &&
            Date.now() - this.toTimestamp(item.editingTimestamp) < LOCK_TIMEOUT,
        });
      })
      .sort((a, b) => this.toTimestamp(b.createTime) - this.toTimestamp(a.createTime));
    this.setData({ noteList });
  },

  // 新建笔记：弹窗输入自定义标题，无数量限制
  onCreateNote() {
    wx.showModal({
      title: "新建笔记",
      editable: true, // 带输入框的弹窗（基础库 2.17.1+）
      placeholderText: "请输入笔记标题",
      success: (res) => {
        if (!res.confirm) return; // 用户取消
        const title = (res.content || "").trim();
        if (!title) {
          wx.showToast({ title: "标题不能为空", icon: "none" });
          return;
        }
        this.createNote(title);
      },
    });
  },

  // 云函数创建笔记（服务端注入 openid），成功后同步本地缓存并进入笔记页面
  createNote(title) {
    wx.showLoading({ title: "创建中" });
    callNoteCloud("createNote", { title })
      .then((note) => {
        wx.hideLoading();
        this.setData({ isOffline: false }); // 创建成功说明网络已恢复
        wx.showToast({ title: "创建成功", icon: "success" });
        // 插入本地缓存头部（新笔记创建时间最新，保持倒序、新建的在最上方）
        const cache = wx.getStorageSync(CACHE_KEY) || [];
        wx.setStorageSync(CACHE_KEY, [note, ...cache]);
        // 进入笔记页面（编辑+背书合一页，当前为占位页，阶段2实现完整逻辑）
        wx.navigateTo({ url: "/pages/edit/index?id=" + note._id });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error("创建笔记失败", err);
        const msg = (err && (err.errMsg || err.message)) || "";
        if (isCloudEnvError(msg)) {
          this.warnCloudEnv();
        } else {
          wx.showToast({ title: "创建失败，请检查网络", icon: "none" });
        }
      });
  },

  // 点击笔记：先查询该笔记的编辑锁，有有效锁则弹窗拦截，禁止进入
  onOpenNote(e) {
    const index = e.currentTarget.dataset.index;
    const note = this.data.noteList[index];
    if (!note) return;
    wx.showLoading({ title: "加载中" });
    this.fetchLatestNote(note._id)
      .then((latest) => {
        wx.hideLoading();
        // 编辑锁有效（editingOpenid 非空且心跳未超 3 分钟）→ 弹窗拦截，禁止进入
        if (
          latest.editingOpenid &&
          Date.now() - this.toTimestamp(latest.editingTimestamp) < LOCK_TIMEOUT
        ) {
          wx.showModal({
            title: "笔记编辑中",
            content: "该笔记正在其他设备编辑，请稍后再试",
            showCancel: false,
            confirmText: "知道了",
          });
          return;
        }
        // 无锁或锁已超时：允许跳转编辑背书合一页面
        wx.navigateTo({ url: "/pages/edit/index?id=" + note._id });
      })
      .catch((err) => {
        wx.hideLoading();
        const msg = (err && (err.errMsg || err.message)) || "";
        if (msg.indexOf("笔记不存在") > -1) {
          // 笔记可能已在其他设备被删除：刷新列表保持一致
          this.loadNoteList();
          wx.showToast({ title: "笔记不存在，可能已删除", icon: "none" });
          return;
        }
        if (isCloudEnvError(msg)) {
          this.warnCloudEnv();
          return;
        }
        wx.showToast({ title: "网络异常，请稍后重试", icon: "none" });
      });
  },

  // 拉取单条笔记最新数据（云函数查询编辑锁字段）；离线时回退本地缓存判断
  fetchLatestNote(id) {
    return callNoteCloud("getNoteById", { id }).catch((err) => {
      const cache = wx.getStorageSync(CACHE_KEY) || [];
      const local = cache.find((item) => item._id === id);
      if (local) return local; // 离线：用本地缓存数据做锁校验
      throw err;
    });
  },

  // 删除笔记：二次确认后删除云端记录 + 同步本地 storage
  onDeleteNote(e) {
    const index = e.currentTarget.dataset.index;
    const note = this.data.noteList[index];
    if (!note) return;
    wx.showModal({
      title: "删除笔记",
      content: `删除「${note.title}」后无法恢复，确定删除吗？`,
      confirmText: "删除",
      confirmColor: "#c94f4f", // 轻量红色提示，避免强刺激
      success: (res) => {
        if (res.confirm) this.deleteNote(note);
      },
    });
  },

  deleteNote(note) {
    wx.showLoading({ title: "删除中" });
    callNoteCloud("deleteNote", { id: note._id })
      .then(() => {
        wx.hideLoading();
        this.setData({ isOffline: false }); // 删除成功说明网络已恢复
        wx.showToast({ title: "已删除", icon: "success" });
        // 同步删除本地缓存
        const cache = (wx.getStorageSync(CACHE_KEY) || []).filter(
          (item) => item._id !== note._id
        );
        wx.setStorageSync(CACHE_KEY, cache);
        // 更新页面列表
        this.setData({
          noteList: this.data.noteList.filter((item) => item._id !== note._id),
        });
      })
      .catch((err) => {
        wx.hideLoading();
        console.error("删除笔记失败", err);
        const msg = (err && (err.errMsg || err.message)) || "";
        if (msg.indexOf("笔记不存在") > -1) {
          // 云端已无此笔记：刷新列表保持数据一致
          this.loadNoteList();
          wx.showToast({ title: "笔记不存在", icon: "none" });
        } else if (isCloudEnvError(msg)) {
          this.warnCloudEnv();
        } else {
          wx.showToast({ title: "删除失败，请检查网络", icon: "none" });
        }
      });
  },

  // 格式化时间：兼容 Date 对象 / 时间戳 / ISO 字符串（本地缓存序列化后为字符串）
  formatTime(value) {
    const d = new Date(value);
    if (isNaN(d.getTime())) return "";
    const pad = (n) => (n < 10 ? "0" + n : "" + n);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(
      d.getHours()
    )}:${pad(d.getMinutes())}`;
  },

  // 转时间戳：兼容 Date 对象 / 时间戳 / ISO 字符串
  toTimestamp(value) {
    if (!value) return 0;
    if (typeof value === "number") return value;
    const t = new Date(value).getTime();
    return isNaN(t) ? 0 : t;
  },
});
