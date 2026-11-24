package cn.cinemavault.app

import android.app.Application
import cn.cinemavault.app.data.api.ApiClient
import cn.cinemavault.app.data.api.ServerConfig
import cn.cinemavault.app.data.prefs.ThemeStore
import cn.cinemavault.app.data.prefs.UpdatePrefs

/** 全局初始化：服务端配置 + 网络客户端（Cookie 持久化）+ 主题/更新偏好。 */
class CvApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        ServerConfig.init(this)
        ApiClient.init(this)
        ThemeStore.init(this)
        UpdatePrefs.init(this)
    }
}
