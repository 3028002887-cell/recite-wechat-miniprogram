// notes 云函数 —— 首页笔记模块
// 所有笔记数据操作走云函数，openid 由服务端上下文获取，避免客户端伪造
const cloud = require("wx-server-sdk");
cloud.init({
  env: cloud.DYNAMIC_CURRENT_ENV, // 使用当前云环境
});

const db = cloud.database();
const COLLECTION = "notes"; // 笔记集合名

// 获取当前用户 openid（服务端从调用上下文获取，安全可靠）
const getOpenid = (openid) => {
  return {
    success: true,
    data: { openid },
  };
};

// 查询用户所有笔记，按创建时间倒序（新建的在最上方）
const getNoteList = async (openid) => {
  const res = await db
    .collection(COLLECTION)
    .where({ openid }) // 只查当前用户的笔记
    .orderBy("createTime", "desc")
    .limit(100)
    .get();
  return { success: true, data: res.data };
};

// 新建笔记：标题由用户手动输入，其余字段按数据库约定初始化
const createNote = async (openid, event) => {
  const title = (event.title || "").trim();
  if (!title) {
    return { success: false, errMsg: "标题不能为空" };
  }
  const now = new Date();
  const data = {
    openid, // 用户 openid（服务端注入）
    title, // 用户自定义笔记标题
    content: "", // 原文文本，进入编辑页后填写
    createTime: now, // 创建时间
    updateTime: now, // 更新时间
    editingOpenid: "", // 编辑锁：当前编辑者 openid，空串表示未锁定
    editingTimestamp: 0, // 编辑锁：心跳时间戳，超时 3 分钟自动失效
    annotations: [], // 荧光笔标注数组（编辑页模块使用）
  };
  const res = await db.collection(COLLECTION).add({ data });
  return { success: true, data: Object.assign({ _id: res._id }, data) };
};

// 查询单条笔记（点击笔记前校验编辑锁用），只允许查自己的笔记
const getNoteById = async (openid, event) => {
  const id = event.id;
  if (!id) {
    return { success: false, errMsg: "参数错误" };
  }
  const res = await db.collection(COLLECTION).where({ _id: id, openid }).get();
  if (!res.data.length) {
    return { success: false, errMsg: "笔记不存在" };
  }
  return { success: true, data: res.data[0] };
};

// 删除笔记：同时校验 _id 与 openid，防止误删他人数据
const deleteNote = async (openid, event) => {
  const id = event.id;
  if (!id) {
    return { success: false, errMsg: "参数错误" };
  }
  const res = await db.collection(COLLECTION).where({ _id: id, openid }).remove();
  if (!res.stats || res.stats.removed === 0) {
    return { success: false, errMsg: "笔记不存在或已删除" };
  }
  return { success: true };
};

// 更新笔记（标题/正文）：只允许更新自己的笔记，并刷新更新时间
const updateNote = async (openid, event) => {
  const id = event.id;
  if (!id) {
    return { success: false, errMsg: "参数错误" };
  }
  const data = { updateTime: new Date() };
  if (typeof event.title === "string") {
    if (!event.title.trim()) {
      return { success: false, errMsg: "标题不能为空" };
    }
    data.title = event.title;
  }
  if (typeof event.content === "string") {
    data.content = event.content; // 原文文本，保留 \n 换行
  }
  if (Array.isArray(event.annotations)) {
    // 荧光笔标注数组：[{aid, startIdx, endIdx, text, color}]
    data.annotations = event.annotations;
  }
  const res = await db.collection(COLLECTION).where({ _id: id, openid }).update({ data });
  if (!res.stats || res.stats.updated === 0) {
    return { success: false, errMsg: "笔记不存在" };
  }
  return { success: true };
};

// 编辑锁加锁/心跳：进入页面时写入当前用户 openid，定时刷新心跳时间戳
// 客户端心跳间隔 30 秒；读取方按 3 分钟超时判定锁是否仍有效
const updateLock = async (openid, event) => {
  const id = event.id;
  if (!id) {
    return { success: false, errMsg: "参数错误" };
  }
  const res = await db.collection(COLLECTION).where({ _id: id, openid }).update({
    data: {
      editingOpenid: openid, // 编辑锁持有者 openid
      editingTimestamp: Date.now(), // 心跳时间戳
    },
  });
  if (!res.stats || res.stats.updated === 0) {
    return { success: false, errMsg: "笔记不存在" };
  }
  return { success: true };
};

// 释放编辑锁：页面卸载/返回首页时清空锁字段
const releaseLock = async (openid, event) => {
  const id = event.id;
  if (!id) {
    return { success: false, errMsg: "参数错误" };
  }
  // 笔记不存在时不视为失败（可能已被删除，锁自然无需释放）
  await db.collection(COLLECTION).where({ _id: id, openid }).update({
    data: { editingOpenid: "", editingTimestamp: 0 },
  });
  return { success: true };
};

// 云函数入口：按 type 分发处理
exports.main = async (event, context) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.type) {
      case "getOpenid":
        return getOpenid(OPENID);
      case "getNoteList":
        return await getNoteList(OPENID);
      case "createNote":
        return await createNote(OPENID, event);
      case "getNoteById":
        return await getNoteById(OPENID, event);
      case "deleteNote":
        return await deleteNote(OPENID, event);
      case "updateNote":
        return await updateNote(OPENID, event);
      case "updateLock":
        return await updateLock(OPENID, event);
      case "releaseLock":
        return await releaseLock(OPENID, event);
      default:
        return { success: false, errMsg: "未知操作类型" };
    }
  } catch (err) {
    // 统一兜底：集合未创建时返回明确错误码，前端据此给出引导提示
    const errMsg = (err && (err.errMsg || err.message)) || "云函数内部错误";
    if (
      errMsg.indexOf("Db or Table not exist") > -1 ||
      errMsg.indexOf("collection not exists") > -1 ||
      errMsg.indexOf("-502005") > -1
    ) {
      return {
        success: false,
        errCode: "COLLECTION_NOT_EXIST",
        errMsg: "notes 集合不存在，请先在云开发控制台创建",
      };
    }
    console.error("notes 云函数执行失败", err);
    return { success: false, errMsg };
  }
};
