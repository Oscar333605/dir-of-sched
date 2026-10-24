const { cloud } = require('./cloud')

// 获取当前会话；未登录返回 null。
async function getSession() {
  const { data, error } = await cloud.auth.getSession()
  if (error || !data) return null
  return data
}

// 微信小程序登录：wx.login 拿 code → signInWithWechat 换取 WorkBuddy 会话。
function loginWithWechat() {
  return new Promise(function (resolve, reject) {
    wx.login({
      success: async function (res) {
        if (!res.code) {
          reject(new Error('微信登录失败，请重试'))
          return
        }
        try {
          const appid = wx.getAccountInfoSync().miniProgram.appId
          const { data, error } = await cloud.auth.signInWithWechat(res.code, appid)
          if (error) {
            reject(error)
            return
          }
          resolve(data)
        } catch (e) {
          reject(e)
        }
      },
      fail: function (err) {
        reject(new Error((err && err.errMsg) || '微信登录失败，请重试'))
      }
    })
  })
}

module.exports = { getSession, loginWithWechat }
