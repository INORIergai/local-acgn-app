package cn.cinemavault.app;

import android.annotation.SuppressLint;
import android.app.PictureInPictureParams;
import android.app.ProgressDialog;
import android.content.ActivityNotFoundException;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.pm.ActivityInfo;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.content.pm.Signature;
import android.graphics.Bitmap;
import android.graphics.Color;
import android.media.AudioManager;
import android.net.Uri;
import android.os.Build;
import android.os.Message;
import android.os.Bundle;
import android.os.Environment;
import android.os.Handler;
import android.os.Looper;
import android.provider.Settings;
import android.util.Rational;
import android.view.HapticFeedbackConstants;
import android.view.KeyEvent;
import android.view.View;
import android.view.ViewGroup;
import android.view.Window;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Button;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.Toast;

import androidx.activity.OnBackPressedCallback;
import androidx.appcompat.app.AlertDialog;
import androidx.appcompat.app.AppCompatActivity;
import androidx.core.content.FileProvider;
import androidx.swiperefreshlayout.widget.SwipeRefreshLayout;

import org.json.JSONObject;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileInputStream;
import java.io.FileOutputStream;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.net.HttpURLConnection;
import java.net.URL;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

public class MainActivity extends AppCompatActivity {

    private static final String PREFS_NAME = "CinemaVaultPrefs";
    private static final String KEY_SERVER_URL = "server_url";
    private static final int REQ_FILE_CHOOSER = 0x1001;

    private WebView webView;
    private SwipeRefreshLayout swipeRefresh;
    private FrameLayout fullscreenContainer;
    private LinearLayout setupOverlay;
    private LinearLayout errorOverlay;
    private ImageView btnFloatingSettings;
    private EditText etServerUrl;
    private Button btnConnect;
    private Button btnRetry;
    private Button btnSwitchAddress;

    private View customVideoView;
    private WebChromeClient.CustomViewCallback customViewCallback;

    private SharedPreferences prefs;
    private long lastBackPressTime = 0;
    private String currentLoadingUrl = "";
    private final ExecutorService executor = Executors.newSingleThreadExecutor();
    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private boolean hasCheckedUpdateThisSession = false;
    private volatile boolean isInReaderMode = false;
    private File pendingApkToInstall = null;

    // ── v4.6.0 安全加固相关 ──
    /** 文件选择回调（<input type=file> 用） */
    private ValueCallback<Uri[]> filePathCallback = null;
    /** 受信任来源 scheme://host:port —— 只有它能留在 WebView 内，其余一律甩给系统浏览器 */
    private String trustedOrigin = "";
    /** 桥实例（需要在离开受信任来源时 remove，回到受信任来源时 add） */
    private final AndroidBridge bridge = new AndroidBridge();
    private boolean bridgeAttached = false;
    private AudioManager audioManager;

    // JavaScript 与原生 Android 通信桥
    public class AndroidBridge {
        @JavascriptInterface
        public void setReaderMode(boolean inReader) {
            isInReaderMode = inReader;
            mainHandler.post(() -> {
                if (btnFloatingSettings != null) {
                    btnFloatingSettings.setVisibility(inReader ? View.GONE : View.VISIBLE);
                }
                if (swipeRefresh != null) {
                    swipeRefresh.setEnabled(!inReader);
                }
                if (inReader) {
                    hideSystemUI();
                } else {
                    showSystemUI();
                }
            });
        }

        @JavascriptInterface
        public void vibrate() {
            mainHandler.post(() -> {
                if (webView != null) {
                    webView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
                }
            });
        }

        @JavascriptInterface
        public void toast(String msg) {
            mainHandler.post(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_SHORT).show());
        }

        @JavascriptInterface
        public int getVersionCode() {
            try {
                PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pInfo.versionCode;
            } catch (Exception e) {
                return 1;
            }
        }

        @JavascriptInterface
        public String getVersionName() {
            try {
                PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                return pInfo.versionName;
            } catch (Exception e) {
                return BuildConfig.VERSION_NAME;
            }
        }

        @JavascriptInterface
        public void triggerUpdate(String downloadUrl, String versionName) {
            mainHandler.post(() -> downloadAndInstallApk(downloadUrl, versionName, null));
        }

        @JavascriptInterface
        public void triggerUpdate(String downloadUrl, String versionName, String sha256) {
            mainHandler.post(() -> downloadAndInstallApk(downloadUrl, versionName, sha256));
        }
    }

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        // 观影与阅读期间保持屏幕常亮
        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);

        // 沉浸式透明状态栏（与黑色/暗金主题自然融合）
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            Window window = getWindow();
            window.clearFlags(WindowManager.LayoutParams.FLAG_TRANSLUCENT_STATUS);
            window.addFlags(WindowManager.LayoutParams.FLAG_DRAWS_SYSTEM_BAR_BACKGROUNDS);
            window.setStatusBarColor(Color.TRANSPARENT);
            window.setNavigationBarColor(Color.TRANSPARENT);
            window.getDecorView().setSystemUiVisibility(
                    View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                            | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
            );
        }

        prefs = getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE);

        initViews();
        setupWebView();
        setupEvents();

        Uri intentData = getIntent().getData();
        String savedUrl = prefs.getString(KEY_SERVER_URL, "");
        if (savedUrl != null && !savedUrl.trim().isEmpty()) {
            trustedOrigin = originOf(normalizeUrl(savedUrl));
        }
        if (intentData != null && handleDeepLink(intentData, savedUrl)) {
            // 深链已处理
        } else if (savedUrl != null && !savedUrl.trim().isEmpty()) {
            loadServerUrl(normalizeUrl(savedUrl));
        } else {
            showSetupOverlay();
        }
    }

    @Override
    protected void onNewIntent(Intent intent) {
        super.onNewIntent(intent);
        setIntent(intent);
        if (intent != null && intent.getData() != null) {
            String savedUrl = prefs.getString(KEY_SERVER_URL, "");
            handleDeepLink(intent.getData(), savedUrl);
        }
    }

    /**
     * 处理外部 Intent 带来的 URI。
     * v4.6.0：**不再接受任意 URL 直接灌进 WebView**（旧实现 else 分支会把 file:// 之类也照单全收），
     * 只有与已保存影库同源的 http(s) 才在应用内打开，其余一律交给系统浏览器。
     */
    private boolean handleDeepLink(Uri data, String savedUrl) {
        if (data == null) return false;
        String uriStr = data.toString();
        if (uriStr.startsWith("cinemavault://")) {
            if (savedUrl == null || savedUrl.trim().isEmpty()) {
                showSetupOverlay();
                return true;
            }
            String path = uriStr.substring("cinemavault://".length());
            String base = normalizeUrl(savedUrl);
            if (!path.startsWith("/")) path = "/" + path;
            loadServerUrl(base + path);
            return true;
        }
        if (isTrustedUrl(uriStr)) {
            loadServerUrl(uriStr);
        } else {
            openExternally(uriStr);
            if (savedUrl != null && !savedUrl.trim().isEmpty()) {
                loadServerUrl(normalizeUrl(savedUrl));
            }
        }
        return true;
    }

    @Override
    protected void onResume() {
        super.onResume();
        // 如果之前跳转去开启安装未知应用权限，返回后立即自动开始安装
        if (pendingApkToInstall != null && pendingApkToInstall.exists()) {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                if (getPackageManager().canRequestPackageInstalls()) {
                    File apk = pendingApkToInstall;
                    pendingApkToInstall = null;
                    installApk(apk);
                }
            }
        }
    }

    private void initViews() {
        webView = findViewById(R.id.webView);
        swipeRefresh = findViewById(R.id.swipeRefresh);
        fullscreenContainer = findViewById(R.id.fullscreenContainer);
        setupOverlay = findViewById(R.id.setupOverlay);
        errorOverlay = findViewById(R.id.errorOverlay);
        btnFloatingSettings = findViewById(R.id.btnFloatingSettings);
        etServerUrl = findViewById(R.id.etServerUrl);
        btnConnect = findViewById(R.id.btnConnect);
        btnRetry = findViewById(R.id.btnRetry);
        btnSwitchAddress = findViewById(R.id.btnSwitchAddress);

        swipeRefresh.setColorSchemeResources(R.color.accent_gold, R.color.accent_blue);
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void setupWebView() {
        WebSettings s = webView.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);
        s.setDatabaseEnabled(true);
        s.setAllowFileAccess(true);
        s.setMediaPlaybackRequiresUserGesture(false);
        s.setUseWideViewPort(true);
        s.setLoadWithOverviewMode(true);
        s.setSupportZoom(true);
        s.setBuiltInZoomControls(true);
        s.setDisplayZoomControls(false);
        s.setCacheMode(WebSettings.LOAD_DEFAULT);
        // 页面本身就走 http（局域网形态），mixed-content 规则并不改变实际防护效果；
        // 保留 ALWAYS_ALLOW 以免 http 子资源（海报/切片）被整体判死导致大面积破图。
        s.setMixedContentMode(WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        // v4.6.0：开启多窗口支持（配合 onCreateWindow，让 window.open 能被接管而不是静默丢弃）
        s.setSupportMultipleWindows(true);

        // 自定义移动端 UA：版本号取自 BuildConfig，避免与 build.gradle 漂移
        String defaultUa = s.getUserAgentString();
        s.setUserAgentString(defaultUa + " CinemaVault-Android/" + BuildConfig.VERSION_NAME);

        // 注册桥接通信（v4.6.0：由 attachBridge() 统一增删，见 onPageStarted）
        attachBridge(true);

        audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                // v4.6.0 导航白名单：只有与影库同源的页面留在 WebView 内，
                // 其余一律交给系统浏览器 —— 否则任意站点都会驻留在同一个 WebView 里继续吃 JS 桥。
                if (request == null) return false;
                String target = request.getUrl() != null ? request.getUrl().toString() : "";
                if (!request.isForMainFrame()) {
                    // 子框架也只允许同源：JS 桥是挂在 WebView 上的，不受同源策略保护，
                    // 一个外部 iframe 一旦加载进来就能直接调 AndroidBridge。
                    return !isTrustedUrl(target);
                }
                if (isTrustedUrl(target)) return false;
                openExternally(target);
                return true;
            }

            @Override
            public void onPageStarted(WebView view, String url, Bitmap favicon) {
                super.onPageStarted(view, url, favicon);
                errorOverlay.setVisibility(View.GONE);
                // 桥只对受信任来源开放：离开影库即摘掉，回来再挂上
                attachBridge(isTrustedUrl(url));
                // 新页面开始加载时，把阅读器状态复位，等 H5 重新上报
                if (isTrustedUrl(url)) {
                    isInReaderMode = false;
                }
            }

            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                swipeRefresh.setRefreshing(false);

                // 阅读器/看片状态只认 H5 通过 setReaderMode 上报的真相：
                // 旧实现用主框架 URL 猜（reader.html/comic/novel），但阅读器跑在 library.html 的 iframe 里，
                // 判定永不命中，等于每次进阅读器都要靠 H5 侧再补一次调用才生效。
                swipeRefresh.setEnabled(!isInReaderMode);
                if (btnFloatingSettings != null) {
                    btnFloatingSettings.setVisibility(isInReaderMode ? View.GONE : View.VISIBLE);
                }
                if (isInReaderMode) {
                    hideSystemUI();
                } else {
                    showSystemUI();
                }

                // 首次成功连上影库后，后台自动检查应用更新（base 取已保存的地址，不依赖当前 URL）
                if (!hasCheckedUpdateThisSession && !url.isEmpty() && !url.equals("about:blank")) {
                    hasCheckedUpdateThisSession = true;
                    String base = prefs.getString(KEY_SERVER_URL, "");
                    checkAppUpdateInBackground(base != null && !base.trim().isEmpty() ? normalizeUrl(base) : currentLoadingUrl);
                }
            }

            @Override
            public void onReceivedHttpError(WebView view, WebResourceRequest request, WebResourceResponse errorResponse) {
                super.onReceivedHttpError(view, request, errorResponse);
                if (request.isForMainFrame()) {
                    int statusCode = errorResponse.getStatusCode();
                    if (statusCode == 502 || statusCode == 504 || statusCode == 503) {
                        swipeRefresh.setRefreshing(false);
                        showErrorOverlay();
                    }
                }
            }

            @Override
            public void onReceivedError(WebView view, WebResourceRequest request, WebResourceError error) {
                super.onReceivedError(view, request, error);
                if (request.isForMainFrame()) {
                    swipeRefresh.setRefreshing(false);
                    showErrorOverlay();
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView view, RenderProcessGoneDetail detail) {
                // v4.6.0：渲染进程被杀（内存压力/系统回收）时不再让整个应用跟着崩掉。
                // 按官方建议：销毁该 WebView 并重建，保持"还在影库里"的体验。
                try {
                    boolean wasTrusted = isTrustedUrl(currentLoadingUrl);
                    webView.destroy();
                    rebuildWebView();
                    if (wasTrusted) {
                        webView.loadUrl(currentLoadingUrl);
                    } else {
                        String base = prefs.getString(KEY_SERVER_URL, "");
                        if (base != null && !base.trim().isEmpty()) {
                            loadServerUrl(normalizeUrl(base));
                        } else {
                            showSetupOverlay();
                        }
                    }
                } catch (Exception e) {
                    Toast.makeText(MainActivity.this, "页面渲染进程异常，请重开应用", Toast.LENGTH_LONG).show();
                    finish();
                }
                return true; // 已自行处理，避免系统杀进程
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onShowCustomView(View view, CustomViewCallback callback) {
                if (customVideoView != null) {
                    callback.onCustomViewHidden();
                    return;
                }
                customVideoView = view;
                customViewCallback = callback;

                swipeRefresh.setVisibility(View.GONE);
                btnFloatingSettings.setVisibility(View.GONE);
                fullscreenContainer.setVisibility(View.VISIBLE);
                fullscreenContainer.addView(view, new FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                ));

                setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE);
                hideSystemUI();
            }

            @Override
            public void onHideCustomView() {
                onHideCustomViewInternal();
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                // v4.6.0：补上文件选择器。之前完全没实现，页面里 4 个 <input type=file>
                // （字幕/封面/NFO/导入）点了没反应。
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    Intent intent = params != null ? params.createIntent() : null;
                    if (intent == null) {
                        intent = new Intent(Intent.ACTION_GET_CONTENT);
                        intent.addCategory(Intent.CATEGORY_OPENABLE);
                        intent.setType("*/*");
                    }
                    intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
                    startActivityForResult(intent, REQ_FILE_CHOOSER);
                    return true;
                } catch (ActivityNotFoundException e) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "没有可用的文件选择器", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }

            @Override
            public boolean onCreateWindow(WebView view, boolean isDialog, boolean isUserGesture, Message resultMsg) {
                // v4.6.0：接管 window.open / target=_blank（页面里共 17 处）。
                // 之前没有这个方法 → 多窗口未开启，这些调用全部静默失效。
                // 现在的策略：同源目标在主框架里打开，外链交给系统浏览器。
                if (resultMsg == null || !(resultMsg.obj instanceof WebView.WebViewTransport)) {
                    return false;
                }
                final WebView popup = new WebView(MainActivity.this);
                WebSettings ps = popup.getSettings();
                ps.setJavaScriptEnabled(true);
                ps.setDomStorageEnabled(true);
                popup.setWebViewClient(new WebViewClient() {
                    private boolean handled = false;

                    @Override
                    public boolean shouldOverrideUrlLoading(WebView v, WebResourceRequest request) {
                        if (handled) return true;
                        handled = true;
                        String target = request.getUrl() != null ? request.getUrl().toString() : "";
                        if (isTrustedUrl(target)) {
                            webView.loadUrl(target);
                        } else if (!target.isEmpty()) {
                            openExternally(target);
                        }
                        popup.destroy();
                        return true;
                    }
                });
                WebView.WebViewTransport transport = (WebView.WebViewTransport) resultMsg.obj;
                transport.setWebView(popup);
                resultMsg.sendToTarget();
                return true;
            }
        });

        // 仅在页面处于绝对顶部且非阅读器时才允许下拉刷新
        webView.getViewTreeObserver().addOnScrollChangedListener(() -> {
            if (isInReaderMode) {
                swipeRefresh.setEnabled(false);
            } else {
                swipeRefresh.setEnabled(webView.getScrollY() <= 0);
            }
        });

        // 监听 WebView 文件下载：如果是 APK 则直接启动应用内静默下载与安装
        webView.setDownloadListener((url, userAgent, contentDisposition, mimetype, contentLength) -> {
            if (url != null && (url.contains(".apk") || url.contains("android-apk"))) {
                // 版本号与 build.gradle 单一来源；服务端若给了校验值会另行覆盖
                downloadAndInstallApk(url, BuildConfig.VERSION_NAME, null);
            } else {
                openExternally(url);
            }
        });
    }

    // ─────────────────── v4.6.0 安全 / 健壮性 helper ───────────────────

    /** 挂载或摘除 JS 桥：只有受信任来源（影库服务本身）才看得到 AndroidBridge */
    private void attachBridge(boolean attach) {
        if (attach) {
            if (!bridgeAttached) {
                webView.addJavascriptInterface(bridge, "AndroidBridge");
                bridgeAttached = true;
            }
        } else if (bridgeAttached) {
            webView.removeJavascriptInterface("AndroidBridge");
            bridgeAttached = false;
        }
    }

    /** 规范化 origin：scheme://host:port（端口缺省按 scheme 补 80/443） */
    private static String originOf(String url) {
        if (url == null) return "";
        try {
            Uri u = Uri.parse(url.trim());
            String scheme = u.getScheme() == null ? "" : u.getScheme().toLowerCase();
            String host = u.getHost() == null ? "" : u.getHost().toLowerCase();
            if (scheme.isEmpty() || host.isEmpty()) return "";
            int port = u.getPort();
            if (port <= 0) port = "https".equals(scheme) ? 443 : 80;
            return scheme + "://" + host + ":" + port;
        } catch (Exception e) {
            return "";
        }
    }

    /** 是否属于影库自己：受信任来源，或内部 about:blank / 本地 asset */
    private boolean isTrustedUrl(String url) {
        if (url == null || url.isEmpty()) return false;
        String u = url.trim();
        if (u.equals("about:blank") || u.startsWith("file:///android_asset/")) return true;
        if (!u.startsWith("http://") && !u.startsWith("https://")) return false;
        return !trustedOrigin.isEmpty() && originOf(u).equals(trustedOrigin);
    }

    /** 不在应用内加载的链接一律交给系统浏览器 */
    private void openExternally(String url) {
        if (url == null || url.trim().isEmpty()) return;
        try {
            Intent i = new Intent(Intent.ACTION_VIEW, Uri.parse(url));
            i.addCategory(Intent.CATEGORY_BROWSABLE);
            i.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
            startActivity(i);
        } catch (ActivityNotFoundException e) {
            Toast.makeText(this, "没有可处理该链接的应用", Toast.LENGTH_SHORT).show();
        } catch (Exception e) {
            Toast.makeText(this, "链接无法打开", Toast.LENGTH_SHORT).show();
        }
    }

    /** 渲染进程被杀后重建 WebView（保持在同一容器位置，重新装好各种监听） */
    private void rebuildWebView() {
        bridgeAttached = false;
        ViewGroup parent = (webView.getParent() instanceof ViewGroup)
                ? (ViewGroup) webView.getParent() : swipeRefresh;
        int index = parent.indexOfChild(webView);
        ViewGroup.LayoutParams lp = webView.getLayoutParams();
        if (webView.getParent() != null) {
            ((ViewGroup) webView.getParent()).removeView(webView);
        }
        WebView fresh = new WebView(this);
        fresh.setId(R.id.webView);
        fresh.setLayoutParams(lp != null ? lp
                : new ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.MATCH_PARENT));
        parent.addView(fresh, index >= 0 ? index : 0);
        webView = fresh;
        setupWebView();
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE_CHOOSER) {
            if (filePathCallback != null) {
                Uri[] results = null;
                if (resultCode == RESULT_OK && data != null) {
                    if (data.getClipData() != null) {
                        int count = data.getClipData().getItemCount();
                        results = new Uri[count];
                        for (int i = 0; i < count; i++) {
                            results[i] = data.getClipData().getItemAt(i).getUri();
                        }
                    } else if (data.getData() != null) {
                        results = new Uri[]{data.getData()};
                    }
                }
                filePathCallback.onReceiveValue(results);
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    /** 文件 SHA-256（小写 hex）；失败返回空串 */
    private static String sha256OfFile(File f) {
        if (f == null || !f.isFile()) return "";
        try {
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            try (FileInputStream in = new FileInputStream(f)) {
                byte[] buf = new byte[64 * 1024];
                int n;
                while ((n = in.read(buf)) > 0) md.update(buf, 0, n);
            }
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest()) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    @SuppressWarnings("deprecation")
    private static Signature[] signersOf(PackageInfo info) {
        if (info == null) return null;
        if (Build.VERSION.SDK_INT >= 28) {
            return info.signingInfo != null ? info.signingInfo.getApkContentsSigners() : null;
        }
        return info.signatures;
    }

    /** 某个 APK 文件的签名证书 SHA-256（用于校验"下载的包是不是自己签的"） */
    @SuppressWarnings("deprecation")
    private String apkSignerSha256(String apkPath) {
        try {
            int flags = Build.VERSION.SDK_INT >= 28
                    ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            Signature[] sigs = signersOf(getPackageManager().getPackageArchiveInfo(apkPath, flags));
            if (sigs == null || sigs.length == 0) return "";
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest(sigs[0].toByteArray())) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    /** 当前已安装自身的签名证书 SHA-256 */
    private String ownSignerSha256() {
        try {
            int flags = Build.VERSION.SDK_INT >= 28
                    ? PackageManager.GET_SIGNING_CERTIFICATES : PackageManager.GET_SIGNATURES;
            Signature[] sigs = signersOf(getPackageManager().getPackageInfo(getPackageName(), flags));
            if (sigs == null || sigs.length == 0) return "";
            MessageDigest md = MessageDigest.getInstance("SHA-256");
            StringBuilder sb = new StringBuilder();
            for (byte b : md.digest(sigs[0].toByteArray())) sb.append(String.format("%02x", b));
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private void onHideCustomViewInternal() {
        if (customVideoView == null) return;

        fullscreenContainer.removeView(customVideoView);
        customVideoView = null;
        fullscreenContainer.setVisibility(View.GONE);
        swipeRefresh.setVisibility(View.VISIBLE);
        btnFloatingSettings.setVisibility(View.VISIBLE);

        if (customViewCallback != null) {
            customViewCallback.onCustomViewHidden();
            customViewCallback = null;
        }

        setRequestedOrientation(ActivityInfo.SCREEN_ORIENTATION_USER);
        showSystemUI();
    }

    private String normalizeUrl(String raw) {
        if (raw == null) return "";
        String url = raw.trim();
        if (url.isEmpty()) return "";

        while (url.endsWith("/")) {
            url = url.substring(0, url.length() - 1);
        }

        // 智能处理 Cloudflare 穿透网址
        if (url.contains("trycloudflare.com")) {
            url = url.replaceAll(":[0-9]+$", "");
            if (!url.startsWith("http://") && !url.startsWith("https://")) {
                url = "https://" + url;
            } else if (url.startsWith("http://")) {
                url = "https://" + url.substring(7);
            }
            return url;
        }

        // 局域网 IP 或普通域名
        if (!url.startsWith("http://") && !url.startsWith("https://")) {
            url = "http://" + url;
        }

        // 如果用户只输入了 IP（如 192.168.1.5）未带端口，自动补齐 :3517
        String withoutScheme = url.replaceFirst("^https?://", "");
        if (!withoutScheme.contains(":") && !withoutScheme.contains("/")) {
            url = url + ":3517";
        }

        return url;
    }

    private void setupEvents() {
        swipeRefresh.setOnRefreshListener(() -> {
            errorOverlay.setVisibility(View.GONE);
            webView.reload();
        });

        btnFloatingSettings.setOnClickListener(v -> promptChangeServer());

        btnConnect.setOnClickListener(v -> {
            String url = etServerUrl.getText().toString().trim();
            if (url.isEmpty()) {
                Toast.makeText(this, "请输入影库地址", Toast.LENGTH_SHORT).show();
                return;
            }
            url = normalizeUrl(url);
            prefs.edit().putString(KEY_SERVER_URL, url).apply();
            setupOverlay.setVisibility(View.GONE);
            loadServerUrl(url);
        });

        btnRetry.setOnClickListener(v -> {
            errorOverlay.setVisibility(View.GONE);
            swipeRefresh.setVisibility(View.VISIBLE);
            swipeRefresh.setRefreshing(true);
            if (!currentLoadingUrl.isEmpty()) {
                webView.loadUrl(currentLoadingUrl);
            } else {
                webView.reload();
            }
        });

        btnSwitchAddress.setOnClickListener(v -> promptChangeServer());

        // 智能拦截 Android 物理返回键（抽屉/播放器/阅读器/详情弹窗优先依次关闭）
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                // 1. 全屏原生视频退出全屏
                if (customVideoView != null) {
                    onHideCustomViewInternal();
                    return;
                }

                // 2. 覆盖层设置面板优先关闭
                if (setupOverlay.getVisibility() == View.VISIBLE || errorOverlay.getVisibility() == View.VISIBLE) {
                    String saved = prefs.getString(KEY_SERVER_URL, "");
                    if (!saved.isEmpty()) {
                        setupOverlay.setVisibility(View.GONE);
                        errorOverlay.setVisibility(View.GONE);
                        swipeRefresh.setVisibility(View.VISIBLE);
                        return;
                    }
                }

                // 3. 智能检测并关闭 Web 界面内的各个弹窗层
                String checkModalJs = "(function(){"
                        + "var sb = document.getElementById('mainSidebar');"
                        + "if (sb && sb.classList.contains('open')) {"
                        + "  var mask = document.getElementById('mNavMask');"
                        + "  if (mask) { mask.click(); return 'MODAL'; }"
                        + "}"
                        + "var pm = document.getElementById('playerModal');"
                        + "if (pm && pm.classList.contains('show')) {"
                        + "  var closeP = document.getElementById('closePlayer');"
                        + "  if (closeP) { closeP.click(); return 'MODAL'; }"
                        + "  pm.classList.remove('show'); return 'MODAL';"
                        + "}"
                        + "var rv = document.getElementById('readerView');"
                        + "if (rv && rv.classList.contains('show')) {"
                        + "  var closeR = document.querySelector('.reader-close-btn');"
                        + "  if (closeR) { closeR.click(); return 'MODAL'; }"
                        + "  rv.classList.remove('show'); return 'MODAL';"
                        + "}"
                        + "var dm = document.getElementById('detailModal');"
                        + "if (dm && dm.classList.contains('show')) {"
                        + "  if (typeof window.closeModal === 'function') { window.closeModal(); return 'MODAL'; }"
                        + "  dm.classList.remove('show'); return 'MODAL';"
                        + "}"
                        + "var anyModal = document.querySelector('.modal.show');"
                        + "if (anyModal) { anyModal.classList.remove('show'); return 'MODAL'; }"
                        + "return 'NONE';"
                        + "})()";

                webView.evaluateJavascript(checkModalJs, result -> {
                    if (result != null && result.contains("MODAL")) {
                        webView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
                        return;
                    }

                    if (webView.canGoBack()) {
                        webView.goBack();
                    } else {
                        long now = System.currentTimeMillis();
                        if (now - lastBackPressTime < 2000) {
                            finish();
                        } else {
                            lastBackPressTime = now;
                            Toast.makeText(MainActivity.this, getString(R.string.press_again_to_exit), Toast.LENGTH_SHORT).show();
                        }
                    }
                });
            }
        });
    }

    // 监听物理音量键：在漫画或小说阅读器中直接映射为上下翻页，带触觉震动
    @Override
    public boolean dispatchKeyEvent(KeyEvent event) {
        if (event.getAction() == KeyEvent.ACTION_DOWN) {
            int keyCode = event.getKeyCode();
            if (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN || keyCode == KeyEvent.KEYCODE_VOLUME_UP) {
                // v4.6.0：只认 H5 上报的阅读器状态（URL 猜测对 iframe 内阅读器永不命中）
                if (isInReaderMode) {
                    final boolean isNext = (keyCode == KeyEvent.KEYCODE_VOLUME_DOWN);
                    String js = "(function(){"
                            + "var rv = document.getElementById('readerView');"
                            + "var isReaderOpen = rv && rv.classList.contains('show');"
                            + "var isDirect = window.location.pathname.indexOf('reader.html') !== -1;"
                            + "if (!isReaderOpen && !isDirect) return false;"
                            + "var win = window;"
                            + "if (isReaderOpen) {"
                            + "  var iframe = document.getElementById('readerFrame');"
                            + "  if (iframe && iframe.contentWindow) win = iframe.contentWindow;"
                            + "}"
                            + "if (" + isNext + ") {"
                            + "  if (typeof win.nextPage === 'function') { win.nextPage(); return true; }"
                            + "  if (typeof win.pageTurn === 'function') { win.pageTurn(1); return true; }"
                            + "}"
                            + "if (!" + isNext + ") {"
                            + "  if (typeof win.prevPage === 'function') { win.prevPage(); return true; }"
                            + "  if (typeof win.pageTurn === 'function') { win.pageTurn(-1); return true; }"
                            + "}"
                            + "return false;"
                            + "})()";
                    webView.evaluateJavascript(js, res -> {
                        boolean turned = "true".equals(res);
                        if (turned) {
                            webView.performHapticFeedback(HapticFeedbackConstants.KEYBOARD_TAP);
                        } else {
                            // 阅读器其实没接管这次按键 → 交回系统调音量，避免"音量键彻底失灵"
                            adjustSystemVolume(keyCode == KeyEvent.KEYCODE_VOLUME_UP);
                        }
                    });
                    return true;
                }
            }
        }
        return super.dispatchKeyEvent(event);
    }

    /** 阅读器没吃下音量键时，用 AudioManager 主动调一次（附带系统音量条） */
    private void adjustSystemVolume(boolean up) {
        try {
            if (audioManager == null) {
                audioManager = (AudioManager) getSystemService(Context.AUDIO_SERVICE);
            }
            if (audioManager == null) return;
            audioManager.adjustStreamVolume(
                    AudioManager.STREAM_MUSIC,
                    up ? AudioManager.ADJUST_RAISE : AudioManager.ADJUST_LOWER,
                    AudioManager.FLAG_SHOW_UI);
        } catch (Exception ignored) {
        }
    }

    // 系统画中画支持（切回桌面时全屏视频自动缩小悬浮播放）
    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (customVideoView != null && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            try {
                PictureInPictureParams params = new PictureInPictureParams.Builder()
                        .setAspectRatio(new Rational(16, 9))
                        .build();
                enterPictureInPictureMode(params);
            } catch (Exception ignored) {}
        }
    }

    private void loadServerUrl(String url) {
        currentLoadingUrl = url;
        // 影库地址即受信任来源：只有这个 origin 能留在 WebView 内并持有 JS 桥
        String origin = originOf(url);
        if (!origin.isEmpty()) {
            trustedOrigin = origin;
        }
        setupOverlay.setVisibility(View.GONE);
        errorOverlay.setVisibility(View.GONE);
        swipeRefresh.setVisibility(View.VISIBLE);
        swipeRefresh.setRefreshing(true);
        webView.loadUrl(url);
    }

    private void showSetupOverlay() {
        swipeRefresh.setVisibility(View.GONE);
        errorOverlay.setVisibility(View.GONE);
        setupOverlay.setVisibility(View.VISIBLE);
        String current = prefs.getString(KEY_SERVER_URL, "");
        etServerUrl.setText(current);
        etServerUrl.setSelection(current.length());
    }

    private void showErrorOverlay() {
        swipeRefresh.setVisibility(View.GONE);
        setupOverlay.setVisibility(View.GONE);
        errorOverlay.setVisibility(View.VISIBLE);
    }

    public void promptChangeServer() {
        final EditText input = new EditText(this);
        input.setSingleLine(true);
        input.setText(prefs.getString(KEY_SERVER_URL, ""));
        input.setSelection(input.getText().length());
        input.setHint("http://192.168.x.x:3517 或 https://xxx.trycloudflare.com");

        new AlertDialog.Builder(this)
                .setTitle(R.string.server_config_title)
                .setMessage("请输入新的影库地址：")
                .setView(input)
                .setPositiveButton(R.string.connect, (dialog, which) -> {
                    String newUrl = normalizeUrl(input.getText().toString());
                    if (!newUrl.isEmpty()) {
                        prefs.edit().putString(KEY_SERVER_URL, newUrl).apply();
                        hasCheckedUpdateThisSession = false;
                        loadServerUrl(newUrl);
                    }
                })
                .setNegativeButton(R.string.cancel, null)
                .show();
    }

    // ==========================================
    // 应用内自动检查更新与一键下载覆盖安装
    // ==========================================
    private void checkAppUpdateInBackground(String serverUrl) {
        if (serverUrl == null || serverUrl.trim().isEmpty()) return;
        executor.execute(() -> {
            try {
                String base = serverUrl.replaceFirst("/+$", "");
                URL url = new URL(base + "/api/app/android-version");
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setRequestMethod("GET");
                conn.setConnectTimeout(8000);
                conn.setReadTimeout(8000);
                if (conn.getResponseCode() == 200) {
                    BufferedReader reader = new BufferedReader(new InputStreamReader(conn.getInputStream()));
                    StringBuilder sb = new StringBuilder();
                    String line;
                    while ((line = reader.readLine()) != null) {
                        sb.append(line);
                    }
                    reader.close();

                    JSONObject json = new JSONObject(sb.toString());
                    if (json.optBoolean("success", false)) {
                        int remoteVersionCode = json.optInt("versionCode", 1);
                        String remoteVersionName = json.optString("version", BuildConfig.VERSION_NAME);
                        String apkUrl = json.optString("apkUrl", "");
                        String changelog = json.optString("changelog", "性能优化与问题修复");
                        // v4.6.0：服务端下发的包哈希（可选），用于下载后比对
                        String remoteSha256 = json.optString("apkSha256", "");

                        int currentVersionCode = BuildConfig.VERSION_CODE;
                        try {
                            PackageInfo pInfo = getPackageManager().getPackageInfo(getPackageName(), 0);
                            currentVersionCode = pInfo.versionCode;
                        } catch (Exception ignored) {}

                        if (remoteVersionCode > currentVersionCode && !apkUrl.isEmpty()) {
                            final String fullDownloadUrl = apkUrl.startsWith("http") ? apkUrl : (base + apkUrl);
                            final String sha = remoteSha256;
                            mainHandler.post(() -> showUpdateDialog(remoteVersionName, changelog, fullDownloadUrl, sha));
                        }
                    }
                }
            } catch (Exception e) {
                // 静默忽略网络异常
            }
        });
    }

    private void showUpdateDialog(String versionName, String changelog, String downloadUrl, String sha256) {
        if (isFinishing() || isDestroyed()) return;

        new AlertDialog.Builder(this)
                .setTitle("发现新版本 · v" + versionName)
                .setMessage("更新内容：\n\n" + changelog)
                .setCancelable(false)
                .setPositiveButton("立即更新", (dialog, which) -> downloadAndInstallApk(downloadUrl, versionName, sha256))
                .setNegativeButton("稍后再说", null)
                .show();
    }

    private void downloadAndInstallApk(String downloadUrl, String versionName, String expectedSha256) {
        ProgressDialog progressDialog = new ProgressDialog(this);
        progressDialog.setTitle("正在下载更新包");
        progressDialog.setMessage("请稍候...");
        progressDialog.setProgressStyle(ProgressDialog.STYLE_HORIZONTAL);
        progressDialog.setIndeterminate(false);
        progressDialog.setMax(100);
        progressDialog.setCancelable(false);
        progressDialog.show();

        executor.execute(() -> {
            File outFile = null;
            try {
                String targetUrl = downloadUrl;
                if (targetUrl == null || targetUrl.trim().isEmpty()) {
                    targetUrl = "/api/app/download/android-apk";
                }
                if (!targetUrl.startsWith("http://") && !targetUrl.startsWith("https://")) {
                    // v4.6.0：不再回退到模拟器地址 10.0.2.2，只认用户保存的影库地址
                    String saved = prefs.getString(KEY_SERVER_URL, "");
                    String base = (currentLoadingUrl != null && isTrustedUrl(currentLoadingUrl))
                            ? currentLoadingUrl.replaceFirst("/+$", "")
                            : (saved != null ? normalizeUrl(saved).replaceFirst("/+$", "") : "");
                    if (base.isEmpty()) {
                        throw new IllegalStateException("尚未连接影库");
                    }
                    targetUrl = base + (targetUrl.startsWith("/") ? "" : "/") + targetUrl;
                }
                URL url = new URL(targetUrl);
                HttpURLConnection conn = (HttpURLConnection) url.openConnection();
                conn.setConnectTimeout(15000);
                conn.setReadTimeout(30000);
                conn.connect();

                int fileLength = conn.getContentLength();
                File downloadDir = getExternalFilesDir(Environment.DIRECTORY_DOWNLOADS);
                if (downloadDir == null) downloadDir = getCacheDir();
                outFile = new File(downloadDir, "CinemaVault-v" + versionName + "-update.apk");

                InputStream input = conn.getInputStream();
                FileOutputStream output = new FileOutputStream(outFile);

                byte[] data = new byte[4096];
                long total = 0;
                int count;
                while ((count = input.read(data)) != -1) {
                    total += count;
                    if (fileLength > 0) {
                        int progress = (int) (total * 100 / fileLength);
                        mainHandler.post(() -> progressDialog.setProgress(progress));
                    }
                    output.write(data, 0, count);
                }

                output.flush();
                output.close();
                input.close();

                // ① 服务端给了哈希就严格比对；② 无论如何都要求"签名证书 == 自己"，
                //    否则一个被投毒的 APK 会以"更新"的名义把用户装成另一个应用。
                final File finalApk = outFile;
                if (expectedSha256 != null && !expectedSha256.trim().isEmpty()) {
                    String actual = sha256OfFile(finalApk);
                    if (!expectedSha256.trim().equalsIgnoreCase(actual)) {
                        finalApk.delete();
                        throw new SecurityException("更新包校验失败（sha256 不匹配）");
                    }
                }
                String ownSigner = ownSignerSha256();
                String pkgSigner = apkSignerSha256(finalApk.getAbsolutePath());
                if (ownSigner.isEmpty() || pkgSigner.isEmpty() || !ownSigner.equalsIgnoreCase(pkgSigner)) {
                    finalApk.delete();
                    throw new SecurityException("更新包签名与应用不一致，已拒绝安装");
                }
                pendingApkToInstall = null;
                mainHandler.post(() -> {
                    progressDialog.dismiss();
                    installApk(finalApk);
                });
            } catch (Exception e) {
                if (outFile != null && outFile.exists()) outFile.delete();
                final String msg = (e instanceof SecurityException) ? e.getMessage() : ("下载更新失败: " + e.getMessage());
                mainHandler.post(() -> {
                    if (!isFinishing() && !isDestroyed()) {
                        progressDialog.dismiss();
                        Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show();
                    }
                });
            }
        });
    }

    private void installApk(File apkFile) {
        if (apkFile == null || !apkFile.exists()) {
            Toast.makeText(this, "更新包文件不存在，请重试下载", Toast.LENGTH_SHORT).show();
            return;
        }

        // Android 8.0+ 检查未知应用安装权限
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            boolean hasInstallPermission = getPackageManager().canRequestPackageInstalls();
            if (!hasInstallPermission) {
                pendingApkToInstall = apkFile; // 关键：保存待安装文件，授权后返回本应用自动触发安装！
                new AlertDialog.Builder(this)
                        .setTitle("需要安装权限")
                        .setMessage("为了自动完成应用更新，请在接下来的系统设置中允许 Cinema Vault 安装应用。\n（开启后返回本应用将自动开始安装）")
                        .setPositiveButton("去设置", (d, w) -> {
                            try {
                                Uri packageUri = Uri.parse("package:" + getPackageName());
                                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, packageUri);
                                startActivity(intent);
                            } catch (Exception e) {
                                Intent intent = new Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES);
                                startActivity(intent);
                            }
                        })
                        .setNegativeButton("取消", (d, w) -> pendingApkToInstall = null)
                        .show();
                return;
            }
        }

        try {
            Uri apkUri = FileProvider.getUriForFile(this, "cn.cinemavault.app.fileprovider", apkFile);
            Intent intent = new Intent(Intent.ACTION_VIEW);
            intent.setDataAndType(apkUri, "application/vnd.android.package-archive");
            intent.addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION);
            intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);

            // 显式授予权限，兼容各类深度定制系统
            java.util.List<android.content.pm.ResolveInfo> resolveInfoList = getPackageManager().queryIntentActivities(intent, PackageManager.MATCH_DEFAULT_ONLY);
            for (android.content.pm.ResolveInfo resolveInfo : resolveInfoList) {
                String packageName = resolveInfo.activityInfo.packageName;
                grantUriPermission(packageName, apkUri, Intent.FLAG_GRANT_READ_URI_PERMISSION);
            }

            startActivity(intent);
        } catch (Exception e) {
            Toast.makeText(this, "调起安装程序失败: " + e.getMessage(), Toast.LENGTH_LONG).show();
        }
    }

    @Override
    public boolean onKeyLongPress(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK) {
            promptChangeServer();
            return true;
        }
        return super.onKeyLongPress(keyCode, event);
    }

    private void hideSystemUI() {
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN
        );
    }

    private void showSystemUI() {
        View decorView = getWindow().getDecorView();
        decorView.setSystemUiVisibility(View.SYSTEM_UI_FLAG_VISIBLE);
    }
}
