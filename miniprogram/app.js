// app.js
App({
  onLaunch: function () {
    if (!wx.cloud) {
      console.error("请使用 2.2.3 或以上的基础库以使用云能力");
    } else {
      wx.cloud.init({
        // env 参数说明：
        // env 决定小程序发起的云开发调用（wx.cloud.xxx）请求到哪个云环境。
        env: "",
        // 注意：未开通云开发或填错环境 ID 时，云调用会报 -601034（没有权限）。
        traceUser: true,
      });
    }
  },
});
