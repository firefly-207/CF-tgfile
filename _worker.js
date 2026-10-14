// 数据库初始化（首次）
let isDatabaseInitialized = false;

async function initDatabase(config) {
  if (isDatabaseInitialized) return;
  try {
    await config.database
      .prepare(
        `
      CREATE TABLE IF NOT EXISTS files (
        url TEXT PRIMARY KEY,
        webp_url TEXT UNIQUE,
        fileId TEXT NOT NULL,
        message_id INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        file_name TEXT,
        webp_file_name TEXT,
        file_size INTEGER,
        mime_type TEXT
      )
    `,
      )
      .run();
    // 【补丁⑧】为「隐藏」功能补一列（幂等：列已存在时报错可忽略）
    try {
      await config.database.prepare("ALTER TABLE files ADD COLUMN hidden INTEGER DEFAULT 0").run();
    } catch (e) {
      // 列已存在，忽略
    }
    // 【补丁⑪】文件夹功能：给 files 补一列「所属文件夹」，再建两张新表
    //   folder     ："旅行" 或 "文章/2026/11" 这样的路径；空字符串 = 未分类（根目录）
    //   folders    ：记录所有文件夹（含空文件夹，否则建了空文件夹就看不见）
    //   redirects  ：图片被移动/重命名后，老地址 → 新地址 的跳转记录，保证已发布的文章不会挂
    try {
      await config.database.prepare("ALTER TABLE files ADD COLUMN folder TEXT DEFAULT ''").run();
    } catch (e) {
      // 列已存在，忽略
    }
    await config.database.prepare("CREATE TABLE IF NOT EXISTS folders (path TEXT PRIMARY KEY, created_at INTEGER NOT NULL)").run();
    await config.database
      .prepare("CREATE TABLE IF NOT EXISTS redirects (old_url TEXT PRIMARY KEY, new_url TEXT NOT NULL, created_at INTEGER NOT NULL)")
      .run();
    isDatabaseInitialized = true;
  } catch (error) {
    console.error("[error] Database initialization failed:", error);
    throw new Response("数据库初始化失败", { status: 500 });
  }
}

// 导出函数
export default {
  async fetch(request, env) {
    // 环境变量配置
    const config = {
      domain: env.DOMAIN,
      database: env.DATABASE,
      username: env.USERNAME || "admin",
      password: env.PASSWORD || "admin",
      apiToken: env.API_TOKEN || "tgfile-admin",
      enableAuth: env.ENABLE_AUTH === "false" ? false : true, // 是否开启身份认证，默认开启
      webpEnabled: env.WEBP_ENABLED === "true" ? true : false, // 是否开启 WebP 转换，默认不开启
      tgBotToken: env.TG_BOT_TOKEN,
      tgChatId: env.TG_CHAT_ID,
      tgApiBase: env.TG_API_BASE || "https://api.telegram.org", // 自建 TG Bot API 地址，未设置则回退官方
      cookie: Number(env.COOKIE) || 7, // cookie有效期默认为 7
      maxSizeMB: Number(env.MAX_SIZE_MB) || 20, // 上传单文件大小默认为20M
    };

    // 初始化数据库
    await initDatabase(config);

    const { pathname } = new URL(request.url);

    // 统一认证检查
    const publicRoutes = ["/config", "/tg-upload"]; // 【补丁⑨】/tg-upload 需要在 handler 里自行鉴权（否则 CORS 预检会被 302 拦掉）
    const authRoutes = ["/", "/login"];
    // 【补丁⑪】图片地址现在可以带文件夹路径（如 /旅行/001-1791xxx.jpg），所以放开多段路径
    const isFileRequest = /\/(?:[\p{L}\p{N}_.%-]+\/)*[\p{L}\p{N}_.%-]+\.[a-z0-9]+$/iu.test(pathname);
    // 【补丁⑪】以 / 结尾的地址 = 文件夹浏览页（带尾斜杠），公开可访问，方便把整个文件夹分享出去
    const isFolderPage = pathname.length > 1 && pathname.endsWith("/");

    if (config.enableAuth) {
      if (!publicRoutes.includes(pathname) && !authRoutes.includes(pathname) && !isFileRequest && !isFolderPage) {
        if (!authenticate(request, config)) {
          return Response.redirect(`${new URL(request.url).origin}/`, 302);
        }
      }
    }

    if (pathname === "/config") {
      const safeConfig = { maxSizeMB: config.maxSizeMB };
      return new Response(JSON.stringify(safeConfig), {
        headers: { "Content-Type": "application/json" },
      });
    }

    const routes = {
      "/": () => handleAuthRequest(request, config),
      "/login": () => handleLoginRequest(request, config),
      "/upload": () => handleUploadRequest(request, config),
      "/admin": () => handleAdminRequest(request, config),
      "/delete": () => handleDeleteRequest(request, config),
      "/delete-batch": () => handleBatchDeleteRequest(request, config), // 【补丁④】批量删除
      "/hide": () => handleHideRequest(request, config), // 【补丁⑧】隐藏 / 取消隐藏
      "/tg-upload": () => handleTgUploadRequest(request, config), // 【补丁⑨】Telegraph 上传中转
      "/search": () => handleSearchRequest(request, config),
      "/folders": () => handleFoldersRequest(request, config), // 【补丁⑪】文件夹：列表 / 新建 / 重命名 / 删除
      "/move-files": () => handleMoveFilesRequest(request, config), // 【补丁⑪】把图片移动到文件夹
    };
    const handler = routes[pathname];
    if (handler) return await handler();

    // 【补丁⑪】文件夹浏览页：/<文件夹路径>/
    if (isFolderPage) return await handleFolderPageRequest(request, config);

    // 处理文件访问请求
    return await handleFileRequest(request, config);
  },
};

// 处理身份认证
function authenticate(request, config) {
  // 检查 API Token (固定密钥认证)
  const authHeader = request.headers.get("Authorization");
  if (config.apiToken && authHeader) {
    // 提取 Token 值，支持 Bearer 格式或直接 Token
    const tokenValue = authHeader.startsWith("Bearer ") ? authHeader.substring(7).trim() : authHeader.trim();
    if (tokenValue === config.apiToken) return true;
  }

  // 检查 Cookie (会话认证，仅在 API Token 认证失败时检查)
  const cookies = request.headers.get("Cookie") || "";
  const authToken = cookies.match(/auth_token=([^;]+)/); // 获取cookie中的auth_token
  if (authToken) {
    try {
      const tokenData = JSON.parse(atob(authToken[1]));
      const now = Date.now();
      if (now > tokenData.expiration) return false; // 检查token是否过期
      return tokenData.username === config.username; // 如果token有效，返回用户名是否匹配
    } catch (error) {
      console.error("[error] Authentication token parsing failed:", error);
      return false;
    }
  }
  return false; // 两种认证方式都失败
}

// 处理身份验证
async function handleAuthRequest(request, config) {
  if (config.enableAuth) {
    const isAuthenticated = authenticate(request, config);
    if (!isAuthenticated) return handleLoginRequest(request, config); // 认证失败，跳转到登录页面
    return handleUploadRequest(request, config); // 认证通过，跳转到上传页面
  }
  return handleUploadRequest(request, config); // 如果没有启用认证，直接跳转到上传页面
}

// 处理登录
async function handleLoginRequest(request, config) {
  if (request.method === "POST") {
    const { username, password } = await request.json();

    if (username === config.username && password === config.password) {
      // 登录成功，设置 cookie 有效期为 config.cookie 天
      const expirationDate = new Date();
      expirationDate.setDate(expirationDate.getDate() + config.cookie);
      const expirationTimestamp = expirationDate.getTime();
      const tokenData = JSON.stringify({
        username: config.username,
        expiration: expirationTimestamp,
      }); // 创建token数据，包含用户名和过期时间

      const token = btoa(tokenData);
      const cookie = `auth_token=${token}; Path=/; HttpOnly; Secure; Expires=${expirationDate.toUTCString()}`;
      return new Response("登录成功", {
        status: 200,
        headers: {
          "Set-Cookie": cookie,
          "Content-Type": "text/plain",
        },
      });
    }
    return new Response("身份认证失败", { status: 401 });
  }
  const html = generateLoginPage();
  return new Response(html, {
    headers: { "Content-Type": "text/html;charset=UTF-8" },
  });
}

// 文件大小计算函数
function formatSize(bytes) {
  if (bytes === null || bytes === undefined || isNaN(bytes)) return "0.00 B";
  let size = Number(bytes);
  const units = ["B", "KB", "MB", "GB"];
  let unitIndex = 0;
  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex++;
  }
  return `${size.toFixed(2)} ${units[unitIndex]}`;
}

// 支持预览的文件类型
function getPreviewHtml(url, mimeType) {
  const ext = (url.split(".").pop() || "").toLowerCase();
  const isImage = ["jpg", "jpeg", "png", "gif", "webp", "svg", "icon"].includes(ext);
  const isVideo = ["mp4", "webm"].includes(ext);
  const isAudio = ["mp3", "wav", "ogg"].includes(ext);

  if (isImage) return `<img src="${url}" alt="预览">`;
  if (isVideo) return `<video src="${url}" controls></video>`;
  if (isAudio) return `<audio src="${url}" controls></audio>`;

  // 按 MIME 类型预览
  if (mimeType === "application/pdf") {
    return `<iframe src="${url}" style="width:100%;height:100%;border:none;background:rgba(255,255,255,0.3);border-radius:4px;"></iframe>`;
  }
  if (mimeType && mimeType.startsWith("text/")) {
    return `<div class="text-preview" data-url="${url}"><i class="fas fa-file-alt" style="font-size:36px;color:#666"></i><div class="text-preview-hint">文本预览</div></div>`;
  }

  // 非预览文件类型图标
  const iconMap = {
    'pdf': 'fa-file-pdf', 'doc': 'fa-file-word', 'docx': 'fa-file-word',
    'xls': 'fa-file-excel', 'xlsx': 'fa-file-excel',
    'ppt': 'fa-file-powerpoint', 'pptx': 'fa-file-powerpoint',
    'zip': 'fa-file-archive', 'rar': 'fa-file-archive', '7z': 'fa-file-archive',
    'html': 'fa-file-code', 'css': 'fa-file-code', 'js': 'fa-file-code',
    'json': 'fa-file-code', 'xml': 'fa-file-code', 'yaml': 'fa-file-code', 'yml': 'fa-file-code',
    'txt': 'fa-file-alt', 'csv': 'fa-file-csv', 'log': 'fa-file-alt',
    'md': 'fa-file-alt', 'sql': 'fa-file-code', 'sh': 'fa-file-code', 'bat': 'fa-file-code',
    'mp4': 'fa-file-video', 'mkv': 'fa-file-video', 'avi': 'fa-file-video',
    'mov': 'fa-file-video', 'wmv': 'fa-file-video',
    'mp3': 'fa-file-audio', 'wav': 'fa-file-audio', 'flac': 'fa-file-audio', 'ogg': 'fa-file-audio',
    'exe': 'fa-gear', 'dmg': 'fa-compact-disc', 'iso': 'fa-file-archive', 'apk': 'fa-android',
  };
  const icon = iconMap[ext] || 'fa-file-lines';
  const colorMap = {
    'fa-file-pdf': '#ff4d4f', 'fa-file-word': '#2b579a', 'fa-file-excel': '#217346',
    'fa-file-powerpoint': '#d24726', 'fa-file-archive': '#fadb14', 'fa-file-code': '#e34f26',
    'fa-file-alt': '#666', 'fa-file-csv': '#217346',
    'fa-file-video': '#722ed1', 'fa-file-audio': '#eb2f96',
    'fa-file-lines': '#e8b830', 'fa-gear': '#ff7043', 'fa-compact-disc': '#42a5f5', 'fa-android': '#66bb6a',
  };
  const color = colorMap[icon] || '#e8b830';
  return `<i class="fas ${icon}" style="font-size:48px;color:${color};opacity:0.55"></i>`;
}

// 调用 TG getFile API 获取文件路径，并构造完整的下载 URL
async function getTelegramFileUrl(fileId, config) {
  try {
    const tgResponse = await fetch(`${config.tgApiBase}/bot${config.tgBotToken}/getFile?file_id=${fileId}`);
    if (!tgResponse.ok) return null;
    const tgData = await tgResponse.json();
    const filePath = tgData.result?.file_path;
    if (!filePath) return null;
    // 构造完整的 Telegram 下载 URL
    return `${config.tgApiBase}/file/bot${config.tgBotToken}/${filePath}`;
  } catch (error) {
    console.error("[error] Fetching Telegram file URL failed:", error);
    return null;
  }
}

// 在 Worker 内部对远程图片进行 webp 转换并返回响应（CF Images Worker API）
async function fetchWebpConverted(tgFileUrl) {
  return await fetch(tgFileUrl, {
    cf: { image: { format: "webp", quality: 80 } },
  });
}

// 【补丁 2026-10-12】Telegram 接口 429 自动等待重试
// 背景：Telegram 对同一频道限制约「每分钟 20 条消息」，超限时返回 429，
//       响应体里带 parameters.retry_after（还需要等多少秒）。
//       原代码直接把 429 抛出去，导致批量上传中途丢图、链接与文件名错位。
async function fetchTelegramWithRetry(url, options, maxRetry = 3, totalBudgetSec = 60) {
  let lastResp;
  let spent = 0;
  for (let attempt = 0; ; attempt++) {
    lastResp = await fetch(url, options);
    if (lastResp.status !== 429 || attempt >= maxRetry) return lastResp;

    // 解析 Telegram 给的等待秒数；拿不到就用兜底值
    let waitSec = 0;
    try {
      const body = await lastResp.clone().json();
      waitSec = Number(body && body.parameters && body.parameters.retry_after) || 0;
      if (!waitSec) {
        const m = String((body && body.description) || "").match(/retry after (\d+)/i);
        if (m) waitSec = Number(m[1]);
      }
    } catch {}
    if (!waitSec) waitSec = 5;
    waitSec += 1; // 多等 1 秒更保险

    if (spent + waitSec > totalBudgetSec) {
      console.log("[warn] Telegram 限流，但累计等待将超过 " + totalBudgetSec + " 秒，放弃重试");
      return lastResp;
    }
    spent += waitSec;
    console.log("[warn] Telegram 限流(429)：等待 " + waitSec + " 秒后重试（第 " + (attempt + 1) + "/" + maxRetry + " 次）");
    await new Promise((r) => setTimeout(r, waitSec * 1000));
  }
}

// ==================== 【补丁⑪】文件夹相关的公共小工具 ====================
// 规范化文件夹路径：去首尾斜杠、合并连续斜杠、拒绝 . 和 ..、长度上限 200
// 返回 { ok, path } 或 { ok:false, error }
function normalizeFolderPath(input) {
  if (input === undefined || input === null) return { ok: true, path: "" };
  const s = String(input)
    .trim()
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
  if (!s) return { ok: true, path: "" };
  for (const seg of s.split("/")) {
    if (!seg || seg === "." || seg === "..") return { ok: false, error: "文件夹名不能为空，也不能是 . 或 .." };
  }
  if (s.length > 200) return { ok: false, error: "文件夹路径太长（最多 200 个字符）" };
  return { ok: true, path: s };
}

// 文件夹路径 → URL 里那一段（逐段百分号编码，中文文件夹名才不会出错）
function encodeFolderPath(path) {
  if (!path) return "";
  return path.split("/").map(encodeURIComponent).join("/") + "/";
}

// 拼出图片的完整地址
function buildFileUrl(config, folderPath, fileName) {
  return `https://${config.domain}/${encodeFolderPath(folderPath)}${fileName}`;
}

// 从一个完整地址里取出「文件名」部分（已经是编码过的，原样保留）
function fileNameFromUrl(url) {
  const s = String(url);
  const i = s.lastIndexOf("/");
  return i === -1 ? s : s.slice(i + 1);
}

// 文件夹路径 → 用于 LIKE 前缀匹配的转义串（% _ ! 都要转义，配合 ESCAPE '!'）
function likePrefix(path) {
  return (
    String(path)
      .replace(/!/g, "!!")
      .replace(/%/g, "!%")
      .replace(/_/g, "!_") + "/%"
  );
}

// HTML 转义（文件夹页会显示用户自己起的名字）
function escapeHtml(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// 把某条路径沿途的所有层级都登记进 folders 表
//   「文章/2026/11」→ 同时登记 文章、文章/2026、文章/2026/11
//   这样后台的文件夹列表是一棵完整的树，中间层也能点进去
async function ensureFolderChain(config, path) {
  if (!path) return;
  const segs = String(path).split("/");
  for (let i = 1; i <= segs.length; i++) {
    const p = segs.slice(0, i).join("/");
    await config.database.prepare("INSERT OR IGNORE INTO folders (path, created_at) VALUES (?, ?)").bind(p, Date.now()).run();
  }
}

// 列出所有文件夹 + 各自的图片数量（只统计未隐藏的）
async function loadFolderList(config) {
  const folders = (await config.database.prepare("SELECT path FROM folders ORDER BY path").all()).results || [];
  const counts =
    (await config.database
      .prepare("SELECT COALESCE(folder, '') AS f, COUNT(*) AS c FROM files WHERE COALESCE(hidden, 0) = 0 GROUP BY COALESCE(folder, '')")
      .all()).results || [];
  const countMap = {};
  let uncategorized = 0;
  for (const row of counts) {
    const key = row.f || "";
    if (key === "") uncategorized = Number(row.c) || 0;
    else countMap[key] = Number(row.c) || 0;
  }
  // 只出现在 files 里、没登记进 folders 表的路径也一起显示（老数据兜底）
  const paths = new Set(folders.map((f) => f.path));
  for (const k of Object.keys(countMap)) paths.add(k);
  const list = Array.from(paths).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true }));
  return {
    folders: list.map((p) => ({ path: p, count: countMap[p] || 0, depth: p.split("/").length - 1 })),
    uncategorized,
    total: list.reduce((acc, p) => acc + (countMap[p] || 0), 0) + uncategorized,
  };
}

// 处理文件上传
async function handleUploadRequest(request, config) {
  if (request.method === "GET") {
    const html = generateUploadPage();
    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  }

  try {
    const formData = await request.formData();
    const file = formData.get("file");
    if (!file) throw new Error("未找到文件");
    if (file.size > config.maxSizeMB * 1024 * 1024) throw new Error(`文件超过${config.maxSizeMB}MB限制`);

    // 【补丁⑪】上传时可以指定文件夹（上传页的下拉框；不填 = 未分类）
    const folderResult = normalizeFolderPath(formData.get("folder"));
    if (!folderResult.ok) throw new Error(folderResult.error);
    const folderPath = folderResult.path;

    const ext = (file.name.split(".").pop() || "").toLowerCase(); //获取文件扩展名
    const [mainType] = file.type.split("/"); // 获取文件主类型
    const typeMap = {
      image: { method: "sendPhoto", field: "photo" },
      video: { method: "sendVideo", field: "video" },
      audio: { method: "sendAudio", field: "audio" },
    }; // 定义类型映射
    let { method = "sendDocument", field = "document" } = typeMap[mainType] || {};
    if (["application", "text"].includes(mainType)) {
      method = "sendDocument";
      field = "document";
    }

    // 【补丁⑥】图片优先用 sendPhoto；若因大小/尺寸被拒，自动降级为 sendDocument
    //   sendPhoto  限制：<= 10MB，且 宽+高 <= 10000（超长截图会失败）
    //   sendDocument 限制：<= 50MB，且不做照片压缩
    const sendToTelegram = async (m, f) => {
      const fd = new FormData();
      fd.append("chat_id", config.tgChatId);
      fd.append(f, file, file.name);
      return await fetchTelegramWithRetry(`${config.tgApiBase}/bot${config.tgBotToken}/${m}`, {
        method: "POST",
        body: fd,
      });
    };
    const isImageUpload = mainType === "image";
    const SEND_PHOTO_MAX = 9.5 * 1024 * 1024; // 留 0.5MB 余量
    let useMethod = method;
    let useField = field;
    if (isImageUpload && file.size > SEND_PHOTO_MAX) {
      useMethod = "sendDocument";
      useField = "document";
      console.log(`[info] 图片 ${(file.size / 1024 / 1024).toFixed(1)}MB 超过 sendPhoto 上限，改用 sendDocument`);
    }
    let tgResponse = await sendToTelegram(useMethod, useField);
    // 【补丁⑩】把响应体读成文本，后面的判断都基于这份文本
    //   原来直接用 tgResponse.json()：body 一旦读掉就取不到原文，出错时根本查不出原因
    let tgText = await tgResponse.text();
    let tgData = null;
    try {
      tgData = JSON.parse(tgText);
    } catch {}

    // 【补丁⑩】Telegram 不只用 HTTP 状态码报错 —— 它还会用「HTTP 200 + {"ok":false}」表示失败，
    //   最典型的就是 .webp 图片（body 里写 "wrong type of the web page content"，HTTP 状态却是 200）。
    //   原代码只看 tgResponse.ok（HTTP 层），会把这个失败当成功继续往下走，
    //   最后卡在「未获取到文件ID」，完全看不出真实原因。
    const isTgOk = () => tgResponse.ok && !(tgData && tgData.ok === false);

    // 兜底：sendPhoto 被拒（尺寸过大 / 格式不支持）时，自动改走文档方式再试一次
    //   【补丁⑩】去掉「必须 400」的限制，改成「只要 Telegram 说不行就重试」；429 除外（重试也是白等）
    if (!isTgOk() && isImageUpload && useMethod === "sendPhoto" && tgResponse.status !== 429) {
      console.error(`[warn] sendPhoto 被拒（HTTP ${tgResponse.status}），改用 sendDocument 重试:`, String(tgText).slice(0, 500));
      tgResponse = await sendToTelegram("sendDocument", "document");
      tgText = await tgResponse.text();
      try {
        tgData = JSON.parse(tgText);
      } catch {
        tgData = null;
      }
      useMethod = "sendDocument";
    }
    if (!isTgOk()) {
      const errorText = tgText;
      if (tgResponse.status === 429) {
        throw new Error(`Telegram 限流（429）—— 同一频道约每分钟最多 20 条消息，请等 1 分钟再传、或一次少传几张。原始信息: ${errorText}`);
      }
      if (isImageUpload) {
        throw new Error(`Telegram 拒绝了这张图片（状态码: ${tgResponse.status}）—— 可能超过 10MB、尺寸过大（宽+高 > 10000），或格式不被支持（如 .webp）。原始信息: ${errorText}`);
      }
      throw new Error(`Telegram API调用失败 (状态码: ${tgResponse.status}): ${errorText}`);
    }

    const result = tgData && tgData.result;
    const messageId = result && result.message_id;
    // 【补丁⑩】把 Telegram 可能承载文件的字段全都算上
    //   原来只认 document / video / audio / photo；一旦 Telegram 把文件归到
    //   sticker / animation / voice / video_note，就会误报「未获取到文件ID」
    const pickFileId = (x) => (x && typeof x === "object" && typeof x.file_id === "string" ? x.file_id : null);
    const fileId =
      pickFileId(result && result.document) ||
      (result && Array.isArray(result.photo) && result.photo.length ? pickFileId(result.photo[result.photo.length - 1]) : null) ||
      pickFileId(result && result.video) ||
      pickFileId(result && result.audio) ||
      pickFileId(result && result.sticker) ||
      pickFileId(result && result.animation) ||
      pickFileId(result && result.voice) ||
      pickFileId(result && result.video_note) ||
      // 最后兜底：扫描 result 第一层对象里任意一个 file_id
      (result && typeof result === "object" ? Object.keys(result).reduce((acc, k) => acc || pickFileId(result[k]), null) : null);
    if (!fileId) {
      // 【补丁⑩】把 Telegram 的原始返回一起报出来 —— 下次一眼就能看出真实原因
      throw new Error(`未获取到文件ID（HTTP ${tgResponse.status}；Telegram 返回：${String(tgText).slice(0, 300)}）`);
    }
    if (!messageId) throw new Error("未获取到tg消息ID");
    const time = Date.now();
    const timestamp = new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString();

    const isConvertibleImage = ["image/jpeg", "image/png", "image/gif"].includes(file.type);
    const useWebpMode = config.webpEnabled && isConvertibleImage;
    const isImageType = mainType === "image"; // 广义图片（含 webp/svg 等不可转换的）
    // 生成文件访问 URL
    // 【补丁①⑦】用「原文件名 + 毫秒时间戳」命名：
    //   - 前缀 = 原文件名  -> 排序/识别依然按文件名（上传顺序由补丁⑤ 保证）
    //   - 后缀 = 时间戳    -> 同名文件不再互相覆盖，每次上传都得到**全新链接**
    //   例：001.jpg  ->  https://<域名>/001-1791814062238.jpg
    //   无文件名 / 无扩展名时（例如直接粘贴的图片）回退为纯时间戳命名
    let originalUrl;
    const rawName = (file.name || "").trim();
    const hasExt = /\.[A-Za-z0-9]{1,8}$/.test(rawName);
    let safeName;
    if (hasExt) {
      const dot = rawName.lastIndexOf(".");
      safeName = `${encodeURIComponent(rawName.slice(0, dot))}-${time}${rawName.slice(dot)}`;
    } else {
      // 【补丁⑧】文件名没有可用扩展名时：用 MIME 类型推断扩展名，并保留文件名前缀
      //   例：名为「图片」(image/jpeg) -> 图片-1791xxx.jpg   （改前会变成 1791xxx.图片 这种怪名字）
      //       名为空（粘贴的图片）    -> 1791xxx.jpg
      const MIME_EXT = { "image/jpeg": "jpg", "image/jpg": "jpg", "image/png": "png", "image/gif": "gif", "image/webp": "webp", "image/bmp": "bmp", "video/mp4": "mp4", "video/webm": "webm", "audio/mpeg": "mp3", "audio/wav": "wav", "application/pdf": "pdf" };
      const mimeExt = MIME_EXT[String(file.type || "").toLowerCase()] || (ext && ext !== rawName ? ext : "") || "bin";
      safeName = `${rawName ? encodeURIComponent(rawName) + "-" : ""}${time}.${mimeExt}`;
    }
    originalUrl = buildFileUrl(config, folderPath, safeName); // 【补丁⑪】带文件夹路径

    // 【补丁⑪】上传到还不存在的文件夹时自动登记（连中间层一起，否则后台列表里看不到）
    if (folderPath) {
      await ensureFolderChain(config, folderPath);
    }

    // 同名覆盖：url 是主键(PRIMARY KEY)，必须先删旧记录，否则 INSERT 会失败
    {
      const old = await config.database
        .prepare("SELECT url, webp_url, fileId, message_id FROM files WHERE url = ?")
        .bind(originalUrl)
        .first();
      if (old) {
        await config.database.prepare("DELETE FROM files WHERE url = ?").bind(originalUrl).run();
        // 尝试清理旧 TG 消息
        try {
          await fetch(`${config.tgApiBase}/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgChatId}&message_id=${old.message_id}`);
        } catch {}
        // 清除 CF 缓存
        try {
          const cache = caches.default;
          await cache.delete(new Request(originalUrl));
          if (old.webp_url) await cache.delete(new Request(old.webp_url));
        } catch {}
      }
    }
    const webpUrl = useWebpMode ? `https://${config.domain}/${encodeFolderPath(folderPath)}${time}.webp` : null; // 【补丁⑪】同样带文件夹路径
    const finalUrl = useWebpMode ? webpUrl : originalUrl;
    const webpFileName = useWebpMode ? file.name.replace(/\.[^/.]+$/, ".webp") : null;
    const finalFileName = useWebpMode ? webpFileName : file.name;

    await config.database
      .prepare(
        `
      INSERT INTO files (url, webp_url, fileId, message_id, created_at, file_name, webp_file_name, file_size, mime_type, folder)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
      )
      .bind(originalUrl, webpUrl, fileId, messageId, timestamp, file.name, webpFileName, file.size, file.type, folderPath)
      .run();

    // 方案A优化版：webp 预转换，测量准确大小并预热缓存
    let webpSize = file.size;
    if (useWebpMode) {
      try {
        const tgFileUrl = await getTelegramFileUrl(fileId, config);
        if (tgFileUrl) {
          const webpResponse = await fetchWebpConverted(tgFileUrl);
          if (webpResponse.ok) {
            // CF Images 响应不携带 Content-Length，改用读取响应体字节数
            const webpBuffer = await webpResponse.arrayBuffer();
            webpSize = webpBuffer.byteLength;
            // 更新数据库为 webp 实际大小
            await config.database
              .prepare("UPDATE files SET file_size = ? WHERE url = ?")
              .bind(webpSize, originalUrl)
              .run();
            // 将转换结果写入 CF Cache，首次访问零消耗
            const cache = caches.default;
            const cacheResponse = new Response(webpBuffer, {
              headers: {
                "Content-Type": webpResponse.headers.get("Content-Type") || "image/webp",
                "Cache-Control": "public, max-age=31536000",
                "Access-Control-Allow-Origin": "*",
                "Content-Disposition": "inline; filename*=UTF-8''" + encodeURIComponent(webpFileName),
              },
            });
            await cache.put(new Request(webpUrl), cacheResponse);
          }
        }
      } catch (e) {
        console.error("[warn] WebP pre-conversion failed, fallback to original size:", e);
      }
    }

    return new Response(JSON.stringify({ status: 1, msg: "✔ 上传成功", url: finalUrl, file: finalFileName, webpSize }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    let statusCode = 500;
    if (error.message.includes(`文件超过${config.maxSizeMB}MB限制`)) {
      statusCode = 400; // 客户端错误：文件大小超限
    } else if (error.message.includes("Telegram参数配置错误")) {
      statusCode = 502; // 网关错误：与Telegram通信失败
    } else if (error.message.includes("未获取到文件ID") || error.message.includes("未获取到tg消息ID")) {
      statusCode = 500; // 服务器内部错误：Telegram返回数据异常
    } else if (error instanceof TypeError && error.message.includes("Failed to fetch")) {
      statusCode = 504; // 网络超时或断网
    }
    console.error(`[Error] ${error.message}`, error);
    return new Response(JSON.stringify({ status: 0, msg: "✘ 上传失败", error: error.message }), {
      status: statusCode,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 【补丁⑨】Telegraph 上传中转
// 为什么要它：浏览器页面直接 POST https://telegra.ph/upload 会返回 400 "Unknown error"
//（实测「字段名 file/photo × 凭据 omit/same-origin」四种组合全部失败）——
// Telegraph 不接受来自网页脚本的调用；改由 Worker 从服务端转发即可（同类项目都这么做）。
async function handleTgUploadRequest(request, config) {
  const cors = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Max-Age": "86400",
  };
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const withCors = (obj, status) =>
    new Response(JSON.stringify(obj), {
      status: status,
      headers: Object.assign({ "Content-Type": "application/json" }, cors),
    });
  try {
    const token = String(request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "").trim();
    if (token !== config.apiToken) {
      return withCors({ ok: false, error: "未授权：请在脚本面板里填写正确的 API_TOKEN" }, 401);
    }
    const inFd = await request.formData();
    const file = inFd.get("file");
    if (!file || typeof file === "string") {
      return withCors({ ok: false, error: "没有收到文件（表单字段名应为 file）" }, 400);
    }
    const outFd = new FormData();
    outFd.append("file", file, file.name || "image.jpg");
    const up = await fetch("https://telegra.ph/upload", { method: "POST", body: outFd });
    const txt = await up.text();
    return withCors({ ok: up.ok, status: up.status, body: txt }, 200);
  } catch (error) {
    console.error("[error] tg-upload proxy failed:", error);
    return withCors({ ok: false, error: error.message }, 500);
  }
}
// 【补丁⑧】隐藏 / 取消隐藏
// 只改 D1 里的一个标记：记录主体和 Telegram 消息都保留 => 链接永久有效
async function handleHideRequest(request, config) {
  try {
    const { urls, hidden } = await request.json();
    if (!Array.isArray(urls) || urls.length === 0) {
      return new Response(JSON.stringify({ error: "无效的URL列表" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const flag = hidden === false ? 0 : 1;
    let changed = 0;
    for (const url of urls) {
      if (typeof url !== "string") continue;
      const r = await config.database.prepare("UPDATE files SET hidden = ? WHERE url = ? OR webp_url = ?").bind(flag, url, url).run();
      changed += (r && r.meta && r.meta.changes) || 0;
    }
    return new Response(
      JSON.stringify({ success: true, total: urls.length, changed, hidden: flag === 1 }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[error] Hide request failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
// ==================== 【补丁⑪】文件夹：后端处理 ====================
// 清掉某个地址的边缘缓存（搬家后新旧地址都要清）
async function purgeCache(url) {
  try {
    await caches.default.delete(new Request(url));
  } catch {}
}

// 把某个文件夹（含子文件夹）下的图片整体搬家
//   oldPrefix ：原文件夹路径
//   newPath   ：新文件夹路径；空字符串表示「未分类」
//   keepSub   ：true = 保留子文件夹结构（重命名用）；false = 全部并到 newPath（删除文件夹时全部回未分类）
// 返回 [{ oldUrl, newUrl, ok, msg }]
async function relocateFiles(config, oldPrefix, newPath, keepSub) {
  const rows =
    (await config.database
      .prepare("SELECT url, folder, file_name FROM files WHERE folder = ? OR folder LIKE ? ESCAPE '!'")
      .bind(oldPrefix, likePrefix(oldPrefix))
      .all()).results || [];
  const out = [];
  for (const row of rows) {
    const oldUrl = row.url;
    const folder = row.folder || "";
    let targetFolder;
    if (!keepSub) targetFolder = newPath;
    else if (folder === oldPrefix) targetFolder = newPath;
    else targetFolder = newPath ? newPath + "/" + folder.slice(oldPrefix.length + 1) : folder.slice(oldPrefix.length + 1);
    const newUrl = buildFileUrl(config, targetFolder, fileNameFromUrl(oldUrl));
    if (newUrl === oldUrl) {
      out.push({ oldUrl, newUrl, ok: true, msg: "地址未变化" });
      continue;
    }
    try {
      const clash = await config.database.prepare("SELECT url FROM files WHERE url = ?").bind(newUrl).first();
      if (clash) {
        out.push({ oldUrl, newUrl, ok: false, msg: "目标位置已有同名文件，已跳过" });
        continue;
      }
      await config.database
        .prepare("INSERT OR REPLACE INTO redirects (old_url, new_url, created_at) VALUES (?, ?, ?)")
        .bind(oldUrl, newUrl, Date.now())
        .run();
      await config.database.prepare("UPDATE files SET url = ?, folder = ? WHERE url = ?").bind(newUrl, targetFolder, oldUrl).run();
      await purgeCache(oldUrl);
      await purgeCache(newUrl);
      out.push({ oldUrl, newUrl, ok: true });
    } catch (e) {
      out.push({ oldUrl, newUrl, ok: false, msg: e.message });
    }
  }
  return out;
}

// 【补丁⑪】文件夹接口：GET 列表；POST { action: create | rename | delete }
async function handleFoldersRequest(request, config) {
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  try {
    if (request.method === "GET") {
      const data = await loadFolderList(config);
      return reply({ success: true, folders: data.folders, uncategorized: data.uncategorized, total: data.total });
    }

    const body = await request.json();
    const action = String(body.action || "");

    if (action === "create") {
      const n = normalizeFolderPath(body.path);
      if (!n.ok) return reply({ error: n.error }, 400);
      if (!n.path) return reply({ error: "文件夹名不能为空" }, 400);
      const exists = await config.database.prepare("SELECT path FROM folders WHERE path = ?").bind(n.path).first();
      if (exists) return reply({ error: "文件夹「" + n.path + "」已经存在" }, 400);
      await config.database.prepare("INSERT INTO folders (path, created_at) VALUES (?, ?)").bind(n.path, Date.now()).run();
      await ensureFolderChain(config, n.path); // 【补丁⑪】中间层也一起登记
      const data = await loadFolderList(config);
      return reply({ success: true, path: n.path, folders: data.folders, uncategorized: data.uncategorized, total: data.total });
    }

    if (action === "rename") {
      const o = normalizeFolderPath(body.old);
      const n = normalizeFolderPath(body.new);
      if (!o.ok) return reply({ error: o.error }, 400);
      if (!n.ok) return reply({ error: n.error }, 400);
      if (!o.path || !n.path) return reply({ error: "不能把文件夹改成空路径" }, 400);
      if (o.path === n.path) return reply({ error: "新旧名字一模一样" }, 400);
      if (n.path.startsWith(o.path + "/")) return reply({ error: "不能把文件夹移动到自己里面" }, 400);
      const oldRow = await config.database.prepare("SELECT path FROM folders WHERE path = ?").bind(o.path).first();
      if (!oldRow) return reply({ error: "文件夹不存在" }, 400);
      const dup = await config.database.prepare("SELECT path FROM folders WHERE path = ?").bind(n.path).first();
      if (dup) return reply({ error: "已经有一个叫「" + n.path + "」的文件夹了" }, 400);
      // 【补丁⑪】新路径的「中间层」要先存在（例如 旅行 → 文章/旅行，需要先有「文章」）
      //   注意：只登记中间层，最后一段留给下面的改名语句去产生 —— 否则会和主键撞车
      const newSegs = n.path.split("/");
      if (newSegs.length > 1) await ensureFolderChain(config, newSegs.slice(0, -1).join("/"));
      const affected =
        (await config.database.prepare("SELECT path FROM folders WHERE path = ? OR path LIKE ? ESCAPE '!'").bind(o.path, likePrefix(o.path)).all()).results || [];
      for (const row of affected) {
        const np = n.path + row.path.slice(o.path.length);
        await config.database.prepare("UPDATE folders SET path = ? WHERE path = ?").bind(np, row.path).run();
      }
      const moved = await relocateFiles(config, o.path, n.path, true);
      const data = await loadFolderList(config);
      return reply({
        success: true,
        old: o.path,
        new: n.path,
        files: moved.filter((m) => m.ok).length,
        failed: moved.filter((m) => !m.ok),
        folders: data.folders,
        uncategorized: data.uncategorized,
        total: data.total,
      });
    }

    if (action === "delete") {
      const d = normalizeFolderPath(body.path);
      if (!d.ok) return reply({ error: d.error }, 400);
      if (!d.path) return reply({ error: "不能删除根目录" }, 400);
      // 里面的图片（含子文件夹里的）全部回到「未分类」，图片本身不删
      const moved = await relocateFiles(config, d.path, "", false);
      await config.database.prepare("DELETE FROM folders WHERE path = ? OR path LIKE ? ESCAPE '!'").bind(d.path, likePrefix(d.path)).run();
      const data = await loadFolderList(config);
      return reply({
        success: true,
        deleted: d.path,
        files: moved.filter((m) => m.ok).length,
        failed: moved.filter((m) => !m.ok),
        folders: data.folders,
        uncategorized: data.uncategorized,
        total: data.total,
      });
    }

    return reply({ error: "未知操作：" + action }, 400);
  } catch (error) {
    console.error("[error] Folders request failed:", error);
    return reply({ error: error.message }, 500);
  }
}

// 【补丁⑪】把勾选的图片移动到某个文件夹
async function handleMoveFilesRequest(request, config) {
  const reply = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json" } });
  try {
    const body = await request.json();
    const urls = Array.isArray(body.urls) ? body.urls.filter((u) => typeof u === "string") : [];
    if (urls.length === 0) return reply({ error: "请先勾选要移动的图片" }, 400);
    if (urls.length > 100) return reply({ error: "一次最多移动 100 个文件，请分批操作（当前 " + urls.length + " 个）" }, 400);
    const n = normalizeFolderPath(body.folder);
    if (!n.ok) return reply({ error: n.error }, 400);
    const target = n.path;
    if (target) {
      const exists = await config.database.prepare("SELECT path FROM folders WHERE path = ?").bind(target).first();
      if (!exists) return reply({ error: "文件夹「" + target + "」不存在，请先创建" }, 400);
    }
    const results = [];
    for (let i = 0; i < urls.length; i++) {
      const url = urls[i];
      try {
        const file = await config.database.prepare("SELECT url, folder, file_name FROM files WHERE url = ? OR webp_url = ?").bind(url, url).first();
        if (!file) {
          results.push({ url, ok: false, msg: "数据库中无此记录" });
        } else {
          const newUrl = buildFileUrl(config, target, fileNameFromUrl(file.url));
          if (newUrl === file.url) {
            results.push({ url, ok: true, unchanged: true });
          } else {
            const clash = await config.database.prepare("SELECT url FROM files WHERE url = ?").bind(newUrl).first();
            if (clash) {
              results.push({ url, ok: false, msg: "目标文件夹里已经有同名文件：" + fileNameFromUrl(newUrl) });
            } else {
              await config.database
                .prepare("INSERT OR REPLACE INTO redirects (old_url, new_url, created_at) VALUES (?, ?, ?)")
                .bind(file.url, newUrl, Date.now())
                .run();
              await config.database.prepare("UPDATE files SET url = ?, folder = ? WHERE url = ?").bind(newUrl, target, file.url).run();
              await purgeCache(file.url);
              await purgeCache(newUrl);
              results.push({ url, ok: true, newUrl });
            }
          }
        }
      } catch (e) {
        results.push({ url, ok: false, msg: e.message });
      }
      if (i < urls.length - 1) await new Promise((r) => setTimeout(r, 50));
    }
    const data = await loadFolderList(config);
    return reply({
      success: true,
      total: urls.length,
      moved: results.filter((r) => r.ok).length,
      results,
      folders: data.folders,
      uncategorized: data.uncategorized,
      count: data.total,
    });
  } catch (error) {
    console.error("[error] Move files failed:", error);
    return reply({ error: error.message }, 500);
  }
}

// 【补丁⑪】公开的文件夹浏览页：/<文件夹路径>/
async function handleFolderPageRequest(request, config) {
  try {
    const pathname = new URL(request.url).pathname;
    let raw = pathname.replace(/^\/+|\/+$/g, "");
    try {
      raw = decodeURIComponent(raw);
    } catch {}
    const n = normalizeFolderPath(raw);
    if (!n.ok || !n.path) return new Response("文件夹不存在", { status: 404, headers: { "Content-Type": "text/plain;charset=UTF-8" } });
    const folder = n.path;
    const folderRow = await config.database.prepare("SELECT path FROM folders WHERE path = ?").bind(folder).first();
    const files =
      (await config.database
        .prepare(
          "SELECT url, file_name, file_size, mime_type FROM files WHERE COALESCE(folder, '') = ? AND COALESCE(hidden, 0) = 0 ORDER BY file_name COLLATE NOCASE",
        )
        .bind(folder)
        .all()).results || [];
    if (!folderRow && files.length === 0) {
      return new Response("文件夹不存在", { status: 404, headers: { "Content-Type": "text/plain;charset=UTF-8" } });
    }
    // 直接子文件夹：folders 表 + 实际有图的路径，两处合并（取第一层）
    const prefix = likePrefix(folder);
    const subRows =
      (await config.database.prepare("SELECT path FROM folders WHERE path LIKE ? ESCAPE '!'").bind(prefix).all()).results || [];
    const subFileRows =
      (await config.database.prepare("SELECT DISTINCT folder FROM files WHERE COALESCE(hidden, 0) = 0 AND folder LIKE ? ESCAPE '!'").bind(prefix).all()).results || [];
    const direct = new Set();
    for (const r of subRows.concat(subFileRows)) {
      const rest = String(r.path || r.folder || "").slice(folder.length + 1);
      const first = rest.split("/")[0];
      if (first) direct.add(first);
    }
    const subs = Array.from(direct).sort((a, b) => a.localeCompare(b, "zh-CN", { numeric: true })).map((name) => ({ name: name, path: folder + "/" + name }));
    return new Response(generateFolderPage(config, folder, files, subs), { headers: { "Content-Type": "text/html;charset=UTF-8" } });
  } catch (error) {
    console.error("[error] Folder page failed:", error);
    return new Response("服务器内部错误: " + error.message, { status: 500, headers: { "Content-Type": "text/plain;charset=UTF-8" } });
  }
}

// 【补丁⑪】文件夹浏览页的 HTML（公开页面，只读、不带任何管理按钮）
function generateFolderPage(config, folder, files, subs) {
  const segs = folder.split("/");
  let acc = "";
  const crumbs = [
    `<a href="${config.domain ? "https://" + config.domain + "/" : "/"}">根目录</a>`,
    ...segs.map((s) => {
      acc = acc ? acc + "/" + s : s;
      return `<a href="https://${config.domain}/${encodeFolderPath(acc)}">${escapeHtml(s)}</a>`;
    }),
  ];
  const subHtml = subs.length
    ? `<div class="subs"><div class="subs-title"><i class="fas fa-folder"></i> 子文件夹</div><div class="subs-list">${subs
        .map((s) => `<a class="sub" href="https://${config.domain}/${encodeFolderPath(s.path)}"><i class="fas fa-folder"></i> ${escapeHtml(s.name)}</a>`)
        .join("")}</div></div>`
    : "";
  const cards = files
    .map(
      (f) => `
      <div class="card">
        <a class="thumb" href="${escapeHtml(f.url)}" target="_blank">${getPreviewHtml(f.url, f.mime_type)}</a>
        <div class="meta">
          <div class="name" title="${escapeHtml(f.file_name)}">${escapeHtml(f.file_name)}</div>
          <div class="size">${formatSize(f.file_size)}</div>
        </div>
        <div class="acts">
          <button class="copy" data-url="${escapeHtml(f.url)}">复制链接</button>
          <a href="${escapeHtml(f.url)}" download="${escapeHtml(f.file_name)}" target="_blank">下载</a>
        </div>
      </div>`,
    )
    .join("");
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${escapeHtml(folder)} - 文件夹</title>
<style>
  * { box-sizing: border-box; }
  body { margin: 0; padding: 24px 18px 60px; font-family: -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; background: #f4f6fa; color: #222; }
  .wrap { max-width: 1200px; margin: 0 auto; }
  h1 { font-size: 20px; margin: 0 0 6px; }
  .crumbs { font-size: 13px; color: #666; margin-bottom: 16px; word-break: break-all; }
  .crumbs a { color: #007bff; text-decoration: none; }
  .crumbs a:hover { text-decoration: underline; }
  .count { font-size: 13px; color: #888; margin-bottom: 14px; }
  .subs { background: #fff; border-radius: 12px; padding: 12px 14px; margin-bottom: 18px; box-shadow: 0 2px 10px rgba(0,0,0,.06); }
  .subs-title { font-size: 13px; color: #666; margin-bottom: 8px; }
  .subs-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .sub { display: inline-flex; align-items: center; gap: 6px; padding: 6px 12px; background: #eef3ff; color: #2059c9; border-radius: 999px; text-decoration: none; font-size: 13px; }
  .sub:hover { background: #dfe9ff; }
  .grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 16px; }
  .card { background: #fff; border-radius: 12px; overflow: hidden; box-shadow: 0 2px 10px rgba(0,0,0,.06); display: flex; flex-direction: column; }
  .thumb { display: block; height: 150px; background: #eef0f4; overflow: hidden; }
  .thumb img, .thumb video { width: 100%; height: 100%; object-fit: cover; display: block; }
  .meta { padding: 8px 10px 0; }
  .name { font-size: 12px; word-break: break-all; line-height: 1.4; max-height: 34px; overflow: hidden; }
  .size { font-size: 11px; color: #999; margin-top: 2px; }
  .acts { display: flex; gap: 8px; padding: 8px 10px 12px; }
  .acts a, .acts button { flex: 1; text-align: center; font-size: 12px; padding: 6px 0; border-radius: 8px; border: none; cursor: pointer; text-decoration: none; background: #007bff; color: #fff; }
  .acts button { background: #e9eef7; color: #2059c9; }
  .empty { padding: 40px; text-align: center; color: #999; background: #fff; border-radius: 12px; }
</style>
</head>
<body>
<div class="wrap">
  <h1><i>📁</i> ${escapeHtml(folder)}</h1>
  <div class="crumbs">${crumbs.join(" / ")}</div>
  <div class="count">共 ${files.length} 个文件${subs.length ? "，" + subs.length + " 个子文件夹" : ""}</div>
  ${subHtml}
  ${files.length ? `<div class="grid">${cards}</div>` : `<div class="empty">这个文件夹里还没有图片</div>`}
</div>
<script>
  document.querySelectorAll('.acts .copy').forEach(function (b) {
    b.addEventListener('click', function () {
      var url = b.getAttribute('data-url');
      var done = function () { var t = b.textContent; b.textContent = '已复制'; setTimeout(function () { b.textContent = t; }, 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(url).then(done, done);
      else done();
    });
  });
</script>
</body>
</html>`;
}

// 处理文件管理和预览
async function handleAdminRequest(request, config) {
  try {
    const params = new URL(request.url).searchParams;
    // 【补丁⑧】默认只列出未隐藏的；带 ?hidden=1 时把已隐藏的也列出来
    const showHidden = params.get("hidden") === "1";
    // 【补丁⑪】文件夹筛选：?folder=旅行 只看这个文件夹；?folder=（空）= 未分类；不带参数 = 全部
    const folderRaw = params.get("folder");
    const folderNorm = normalizeFolderPath(folderRaw === null ? undefined : folderRaw);
    const folderFilter = folderRaw === null ? null : folderNorm.ok ? folderNorm.path : "";
    const deep = params.get("deep") === "1";

    const where = [];
    const binds = [];
    if (!showHidden) where.push("COALESCE(hidden, 0) = 0");
    if (folderFilter !== null) {
      if (deep && folderFilter !== "") {
        where.push("(COALESCE(folder, '') = ? OR COALESCE(folder, '') LIKE ? ESCAPE '!')");
        binds.push(folderFilter, likePrefix(folderFilter));
      } else {
        where.push("COALESCE(folder, '') = ?");
        binds.push(folderFilter);
      }
    }
    const sql = `SELECT url, webp_url, fileId, message_id, created_at, file_name, webp_file_name, file_size, mime_type, COALESCE(hidden, 0) AS hidden, COALESCE(folder, '') AS folder
        FROM files
        ${where.length ? "WHERE " + where.join(" AND ") : ""}
        ORDER BY created_at DESC`;
    const stmt = config.database.prepare(sql);
    const files = await (binds.length ? stmt.bind(...binds) : stmt).all();

    const fileList = files.results || [];

    // ---------------- 【补丁⑪】文件夹侧栏数据 ----------------
    const folderData = await loadFolderList(config);
    const hiddenCond = showHidden ? "" : " AND COALESCE(hidden, 0) = 0";
    let ownCount = 0;
    let deepCount = 0;
    if (folderFilter === null) {
      const r = await config.database.prepare("SELECT COUNT(*) AS c FROM files WHERE 1 = 1" + hiddenCond).first();
      ownCount = Number(r && r.c) || 0;
      deepCount = ownCount;
    } else if (folderFilter === "") {
      const r = await config.database.prepare("SELECT COUNT(*) AS c FROM files WHERE COALESCE(folder, '') = ''" + hiddenCond).first();
      ownCount = Number(r && r.c) || 0;
      deepCount = ownCount;
    } else {
      const r1 = await config.database.prepare("SELECT COUNT(*) AS c FROM files WHERE COALESCE(folder, '') = ?" + hiddenCond).bind(folderFilter).first();
      ownCount = Number(r1 && r1.c) || 0;
      const r2 = await config.database
        .prepare("SELECT COUNT(*) AS c FROM files WHERE (COALESCE(folder, '') = ? OR COALESCE(folder, '') LIKE ? ESCAPE '!')" + hiddenCond)
        .bind(folderFilter, likePrefix(folderFilter))
        .first();
      deepCount = Number(r2 && r2.c) || 0;
    }

    const adminUrl = (folder, useDeep, withHidden) => {
      const qs = [];
      if (folder !== null) qs.push("folder=" + encodeURIComponent(folder));
      if (useDeep) qs.push("deep=1");
      if (withHidden) qs.push("hidden=1");
      return "/admin" + (qs.length ? "?" + qs.join("&") : "");
    };
    const jsArg = (s) => escapeHtml(JSON.stringify(String(s)));

    const chips = [];
    chips.push(
      `<a class="folder-chip${folderFilter === null ? " active" : ""}" href="${adminUrl(null, false, showHidden)}"><i class="fas fa-images"></i> 全部图片<span class="fc-count">${folderData.total}</span></a>`,
    );
    chips.push(
      `<a class="folder-chip${folderFilter === "" ? " active" : ""}" href="${adminUrl("", false, showHidden)}"><i class="far fa-folder-open"></i> 未分类<span class="fc-count">${folderData.uncategorized}</span></a>`,
    );
    for (const f of folderData.folders) {
      const indent = "&nbsp;&nbsp;".repeat(f.depth);
      const short = f.path.split("/").pop();
      chips.push(
        `<span class="folder-item">` +
          `<a class="folder-chip${folderFilter === f.path ? " active" : ""}" href="${adminUrl(f.path, true, showHidden)}" title="${escapeHtml(f.path)}">${indent}<i class="fas fa-folder"></i> ${escapeHtml(short)}<span class="fc-count">${f.count}</span></a>` +
          `<a class="folder-mini" href="https://${config.domain}/${encodeFolderPath(f.path)}" target="_blank" title="打开这个文件夹的公开页面（可以分享给别人）">↗</a>` +
          `<button class="folder-mini" onclick="renameFolder(${jsArg(f.path)})" title="重命名文件夹">改名</button>` +
          `<button class="folder-mini danger" onclick="deleteFolder(${jsArg(f.path)})" title="删除文件夹（里面的图片会回到未分类，图片本身不删）">删</button>` +
          `</span>`,
      );
    }

    const folderPanel =
      `<div class="folder-panel">` +
      `<div class="folder-head">` +
      `<span class="fp-title"><i class="fas fa-folder-tree"></i> 文件夹</span>` +
      `<button class="btn fp-new" onclick="createFolder()"><i class="fas fa-folder-plus"></i> 新建文件夹</button>` +
      `<span class="fp-now">当前：${folderFilter === null ? "全部图片" : escapeHtml(folderFilter || "未分类")} · ${ownCount} 张` +
      (folderFilter && deepCount !== ownCount ? `（含子文件夹 ${deepCount} 张）` : "") +
      `</span>` +
      (folderFilter ? `<a class="fp-deep" href="${adminUrl(folderFilter, !deep, showHidden)}">${deep ? "只看本层" : "含子文件夹"}</a>` : "") +
      `</div>` +
      `<div class="folder-list">${chips.join("")}</div>` +
      `<div class="folder-tip">点文件夹名 = 只看这个文件夹；「↗」= 打开它的公开页面（可直接分享给别人）。移动 / 改名后，旧链接会自动 302 跳到新链接，已发布的文章不会挂。</div>` +
      `</div>`;

    const optionsHtml =
      `<option value="">未分类（根目录）</option>` +
      folderData.folders
        .map((f) => `<option value="${escapeHtml(f.path)}">${"&nbsp;&nbsp;".repeat(f.depth)}${escapeHtml(f.path)}</option>`)
        .join("");

    const folderUI = {
      panel: folderPanel,
      optionsHtml: optionsHtml,
      hiddenLink: adminUrl(folderFilter, deep, !showHidden),
    };
    const fileCards = fileList
      .map((file) => {
        const createdAt = new Date(file.created_at).toISOString().replace("T", " ").split(".")[0];
        const displayFileSize = formatSize(file.file_size);
        let displayUrl = file.url;
        let displayFileName = file.file_name;

        const isWebpMode = config.webpEnabled && file.webp_url;
        if (isWebpMode) {
          displayUrl = file.webp_url;
          displayFileName = file.webp_file_name;
        }

        const isHidden = Number(file.hidden) === 1; // 【补丁⑧】
        return `
        <div class="file-card${isHidden ? " is-hidden" : ""}" data-url="${file.url}">
          <label class="card-pick" title="选择此项（用于批量操作）">
            <input type="checkbox" class="card-check" data-check="${file.url}">
          </label>
          <button class="card-hide-btn" title="${isHidden ? "取消隐藏" : "隐藏（链接仍然有效）"}" onclick="hideFile('${file.url}', ${isHidden ? "false" : "true"})"><i class="fas fa-eye${isHidden ? "" : "-slash"}"></i></button>
          ${isHidden ? '<span class="hidden-badge"><i class="fas fa-eye-slash"></i> 已隐藏</span>' : ""}
          <div class="file-preview">
            ${getPreviewHtml(displayUrl, file.mime_type)}
          </div>
          <div class="file-info">
            <div>${displayFileName}</div>
            <div>${displayFileSize}</div>
            <div>${createdAt}</div>
            <div class="file-folder" title="所属文件夹">${file.folder ? "📁 " + escapeHtml(file.folder) : "📁 未分类"}</div>
          </div>
          <div class="file-actions">
            <button class="btn btn-copy" onclick="showQRCode('${displayUrl}')"><i class="fas fa-share"></i> 分享</button>
            <a class="btn btn-down" href="${displayUrl}" download="${displayFileName}" target="_blank"><i class="fas fa-download"></i> 下载</a>
            <button class="btn btn-delete" onclick="deleteFile('${file.url}')"><i class="fas fa-trash"></i> 删除</button>
          </div>
        </div>
      `;
      })
      .join("");

    // 二维码分享元素
    const qrModal = `
    <div id="qrModal" class="qr-modal">
      <div class="qr-content">
        <div id="qrcode"></div>
        <div class="qr-buttons">
          <button class="qr-copy" onclick="handleCopyUrl()"><i class="fas fa-copy"></i> 复制链接</button>
          <button class="qr-close" onclick="closeQRModal()"><i class="fas fa-times"></i> 关闭</button>
        </div>
      </div>
    </div>
  `;

    const html = generateAdminPage(fileCards, qrModal, showHidden, folderUI); // 【补丁⑧修复】+【补丁⑪】文件夹侧栏
    return new Response(html, {
      headers: { "Content-Type": "text/html;charset=UTF-8" },
    });
  } catch (error) {
    console.error("[Error]:", error);
    return new Response(`服务器内部错误: ${error.message}`, {
      status: 500,
      headers: { "Content-Type": "text/html" },
    });
  }
}

// 处理文件搜索
async function handleSearchRequest(request, config) {
  try {
    const { query } = await request.json();
    const searchPattern = `%${query}%`;
    const files = await config.database
      .prepare(
        `SELECT url, webp_url, fileId, message_id, created_at, file_name, webp_file_name, file_size, mime_type
        FROM files 
        WHERE file_name LIKE ? ESCAPE '!'
        OR webp_file_name LIKE ? ESCAPE '!'
        COLLATE NOCASE
        ORDER BY created_at DESC`,
      )
      .bind(searchPattern, searchPattern)
      .all();

    return new Response(JSON.stringify({ files: files.results || [] }), {
      headers: { "Content-Type": "application/json" },
    });
  } catch (error) {
    console.error("[error] Search request failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

// 获取文件并缓存
async function handleFileRequest(request, config) {
  const cache = caches.default;
  const cacheKey = request;
  const { pathname } = new URL(request.url);
  const isWebpRequest = pathname.toLowerCase().endsWith(".webp");
  const lookupColumn = config.webpEnabled && isWebpRequest ? "webp_url" : "url";
  const lookupValue = request.url;

  try {
    // 尝试从缓存中获取
    const cachedResponse = await cache.match(cacheKey);
    if (cachedResponse) return cachedResponse;

    // 从数据库查询文件
    const file = await config.database
      .prepare(
        `SELECT url, webp_url, fileId, message_id, created_at, file_name, webp_file_name, file_size, mime_type
         FROM files WHERE ${lookupColumn} = ?`,
      )
      .bind(lookupValue)
      .first();

    if (!file) {
      // 【补丁⑪】老链接救回：图片被移动 / 文件夹被重命名后，旧地址在这里 302 跳到新地址
      //   这样已经写进 Telegraph 文章、Telegram 消息里的旧链接永远不会挂
      if (lookupColumn === "url") {
        try {
          const alias = await config.database.prepare("SELECT new_url FROM redirects WHERE old_url = ?").bind(lookupValue).first();
          if (alias && alias.new_url) return Response.redirect(alias.new_url, 302);
        } catch (e) {
          console.error("[warn] 查询跳转记录失败:", e);
        }
      }
      return new Response("文件不存在", {
        status: 404,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
      });
    }

    // 重定向条件：WebP 启用 AND 请求的是原始 URL, AND 数据库中有 webp_url 记录
    if (config.webpEnabled && !isWebpRequest && file.webp_url) {
      return Response.redirect(file.webp_url, 301);
    }

    // 获取 Telegram 文件
    const fileUrl = await getTelegramFileUrl(file.fileId, config);
    if (!fileUrl) {
      return new Response("文件路径无效或获取失败", {
        status: 404,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
      });
    }

    let fileResponse;
    let contentType = file.mime_type;
    const isConvertibleImage = ["image/jpeg", "image/png", "image/gif"].includes(file.mime_type);
    const shouldConvert = config.webpEnabled && isWebpRequest && isConvertibleImage;

    if (shouldConvert) {
      fileResponse = await fetchWebpConverted(fileUrl);
      if (fileResponse.ok) contentType = fileResponse.headers.get("Content-Type") || "image/webp";
    }
    if (!fileResponse || !fileResponse.ok) fileResponse = await fetch(fileUrl);
    if (!fileResponse.ok) {
      return new Response("下载文件失败", {
        status: 500,
        headers: { "Content-Type": "text/plain;charset=UTF-8" },
      });
    }

    // 创建响应并缓存 (使用新的 contentType)
    let finalFileName = file.file_name;
    if (isWebpRequest) finalFileName = finalFileName.replace(/\.[^/.]+$/, ".webp");
    const response = new Response(fileResponse.body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": "public, max-age=31536000",
        "X-Content-Type-Options": "nosniff",
        "Access-Control-Allow-Origin": "*",
        "Content-Disposition": `inline; filename*=UTF-8''${encodeURIComponent(finalFileName)}`,
      },
    });

    await cache.put(cacheKey, response.clone());
    return response;
  } catch (error) {
    console.error("[error] File request failed:", error);
    return new Response("服务器内部错误", {
      status: 500,
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
    });
  }
}

// 【补丁④】处理批量删除
async function handleBatchDeleteRequest(request, config) {
  try {
    const { urls } = await request.json();
    if (!Array.isArray(urls) || urls.length === 0) {
      return new Response(JSON.stringify({ error: "无效的URL列表" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const list = urls.filter((u) => typeof u === "string");
    if (list.length > 100) {
      return new Response(JSON.stringify({ error: "一次最多删除 100 个文件，请分批操作（当前 " + list.length + " 个）" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }
    const results = [];
    for (let i = 0; i < list.length; i++) {
      const url = list[i];
      let ok = false;
      let msg = "";
      try {
        const file = await config.database
          .prepare("SELECT fileId, message_id, webp_url FROM files WHERE url = ? OR webp_url = ?")
          .bind(url, url)
          .first();
        if (!file) {
          msg = "数据库中无此记录";
        } else {
          // 删除 Telegram 消息（复用补丁② 的 429 自动重试）
          try {
            const r = await fetchTelegramWithRetry(
              `${config.tgApiBase}/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgChatId}&message_id=${file.message_id}`,
            );
            if (!r.ok) {
              const e = await r.json().catch(() => ({}));
              const desc = (e && e.description) || "";
              if (!desc.includes("message to delete not found")) msg = desc || "Telegram 删除失败";
            }
          } catch (e) {
            msg = e.message;
          }
          // 无论 Telegram 是否成功，都清掉数据库记录
          await config.database.prepare("DELETE FROM files WHERE url = ? OR webp_url = ?").bind(url, url).run();
          // 顺手清理边缘缓存，让删除立即生效
          try {
            const cache = caches.default;
            await cache.delete(new Request(url));
            if (file.webp_url) await cache.delete(new Request(file.webp_url));
          } catch {}
          ok = true;
        }
      } catch (e) {
        msg = e.message;
      }
      results.push({ url, ok, msg: msg || undefined });
      if (i < list.length - 1) await new Promise((r) => setTimeout(r, 150));
    }
    return new Response(
      JSON.stringify({
        success: true,
        total: list.length,
        deleted: results.filter((r) => r.ok).length,
        results,
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[error] Batch delete failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}
// 处理文件删除
async function handleDeleteRequest(request, config) {
  try {
    const { url } = await request.json();
    if (!url || typeof url !== "string") {
      return new Response(JSON.stringify({ error: "无效的URL" }), {
        status: 400,
        headers: { "Content-Type": "application/json" },
      });
    }

    const file = await config.database
      .prepare("SELECT fileId, message_id FROM files WHERE url = ? OR webp_url = ?")
      .bind(url, url)
      .first();
    if (!file) {
      return new Response(JSON.stringify({ error: "文件不存在" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }

    const deleteError = await (async () => {
      try {
        const deleteResponse = await fetch(
          `${config.tgApiBase}/bot${config.tgBotToken}/deleteMessage?chat_id=${config.tgChatId}&message_id=${file.message_id}`,
        );
        if (!deleteResponse.ok) {
          const errorData = await deleteResponse.json();
          console.error("[error] Telegram message delete failed:", errorData);
          if (errorData.description && errorData.description.includes("message to delete not found")) {
            return "Telegram消息已不存在，但已从数据库移除";
          }
          throw new Error(`Telegram 消息删除失败: ${errorData.description}`);
        }
        return null;
      } catch (error) {
        return error.message;
      }
    })();

    // 删除数据库表数据，即使Telegram删除失败也会删除数据库记录
    await config.database.prepare("DELETE FROM files WHERE url = ? OR webp_url = ?").bind(url, url).run();
    // 【补丁④】顺手清理边缘缓存，让删除立即生效
    try { await caches.default.delete(new Request(url)); } catch {}
    return new Response(
      JSON.stringify({
        success: true,
        message: deleteError ? `文件已从数据库删除，但Telegram消息删除失败: ${deleteError}` : "文件删除成功",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  } catch (error) {
    console.error("[error] File delete request failed:", error);
    return new Response(JSON.stringify({ error: error.message }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }
}

function headLinks() {
  return `
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta name="description" content="Telegram文件存储与分享平台">
    <link rel="shortcut icon" href="https://pan.811520.xyz/2025-02/1739241502-tgfile-favicon.ico" type="image/x-icon">
    <link rel="stylesheet" href="https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.4.0/css/all.min.css">
  `;
}

// HTML版权页
function copyright() {
  return `
    <p>
      <span><i class="fas fa-copyright"></i> 2025 Copyright by Yutian81</span><span>|</span>
      <a href="https://github.com/yutian81/CF-tgfile" target="_blank">
      <i class="fab fa-github"></i> GitHub Repo</a><span>|</span>
      <a href="https://blog.811520.xyz/" target="_blank">
      <i class="fas fa-blog"></i> QingYun Blog</a>
    </p>
  `;
}

// 登录页面生成函数 /login
function generateLoginPage() {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
  ${headLinks()}
  <title>登录</title>
    <style>
      body {
        position: relative;
        min-height: 100vh;
        margin: 0;
        background: #f5f5f5;
        background-size: cover;
        background-position: center;
        font-family: Arial, sans-serif;
        display: flex;
        justify-content: center;
        align-items: center;
        padding: 20px;
        box-sizing: border-box;
      }
      .login-container {
        background: rgba(255, 255, 255, 0.3);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        padding: 30px 30px 20px 30px;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        width: 100%;
        max-width: 400px;
        z-index: 1;
      }
      .form-group { margin-bottom: 1rem; }
      .input-wrapper { position: relative; display: block; }
      .input-wrapper i { position: absolute; left: 12px; top: 50%; transform: translateY(-50%); color: #666; pointer-events: none; }
      input {
        width: 100%;
        padding: 0.75rem 0.75rem 0.75rem 35px;
        border: 1px solid rgba(0,0,0,0.1);
        border-radius: 8px;
        font-size: 1rem;
        box-sizing: border-box;
        background: rgba(255, 255, 255, 0.6);
        color: #333;
        outline: none;
      }
      input:focus { background: rgba(255, 255, 255, 0.5); border-color: #007bff; box-shadow: 0 0 5px rgba(0, 98, 255, 0.5); }

      button {
        width: 100%;
        padding: 0.75rem;
        background: #007bff;
        color: white;
        border: none;
        border-radius: 8px;
        font-size: 1rem;
        cursor: pointer;
        margin-bottom: 10px;
        transition: background 0.3s ease;
      }
      button:hover { background: #0056b3; }
      button:disabled { background: #ccc; cursor: not-allowed; }

      .error { 
        color: #dc3545; 
        margin-top: 1rem; 
        font-size: 14px;
        display: none; 
        text-align: center;
      }

      footer {
        position: absolute;
        margin-bottom: 30px;
        bottom: 0;
        left: 0;
        width: 100%;
        text-align: center;
        font-size: 0.85rem;
        padding: 10px 0;
        background: transparent;
      }
      footer p {
        color: #585858;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0;
      }
      footer a { color: #585858; text-decoration: none; }
      footer a:hover { color: #007BFF; transition: color 0.3s ease; }
      /* 通用模态框（毛玻璃） */
      .modal-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        display: none; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.25s ease;
      }
      .modal-overlay.show { display: flex; opacity: 1; }
      .modal-box {
        background: rgba(255, 255, 255, 0.65);
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        border: 1px solid rgba(255, 255, 255, 0.4);
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
        padding: 28px 32px; max-width: 90vw; width: 360px;
        text-align: center; color: #222;
        transform: scale(0.92); transition: transform 0.25s ease;
      }
      .modal-overlay.show .modal-box { transform: scale(1); }
      .modal-icon { font-size: 42px; margin-bottom: 12px; }
      .modal-icon.success { color: #28a745; }
      .modal-icon.error { color: #dc3545; }
      .modal-icon.warning { color: #ffc107; }
      .modal-title { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
      .modal-msg { font-size: 14px; line-height: 1.6; margin-bottom: 20px; color: #444; word-break: break-word; }
      .modal-btns { display: flex; gap: 10px; justify-content: center; }
      .modal-btns button {
        padding: 8px 22px; border: none; border-radius: 8px;
        font-size: 14px; cursor: pointer; transition: all 0.2s;
      }
      .modal-btn { background: #007bff; color: #fff; }
      .modal-btn:hover { background: #0056b3; }
      .modal-btn.secondary { background: rgba(0,0,0,0.08); color: #444; }
      .modal-btn.secondary:hover { background: rgba(0,0,0,0.15); }
      .modal-btn.danger { background: #dc3545; color: #fff; }
      .modal-btn.danger:hover { background: #c82333; }
    </style>
  </head>
  <body>
    <div class="login-container">
      <h2 style="text-align: center; margin: 0 0 20px 0;"><i class="fab fa-telegram"></i> TG Files 文件管理</h2>
      <form id="loginForm">
        <div class="form-group">
          <div class="input-wrapper">
            <i class="fas fa-user"></i>
            <input type="text" id="username" placeholder="用户名" required autocomplete="username">
          </div>
        </div>
        <div class="form-group">
          <div class="input-wrapper">
            <i class="fas fa-key"></i>
            <input type="password" id="password" placeholder="密码" required autocomplete="current-password">
          </div>
        </div>
        <button type="submit" id="loginBtn"><i class="fas fa-right-to-bracket"></i> 登录</button>
        <div id="error" class="error"></div>
      </form>
    </div>
    <footer>
      ${copyright()}
    </footer>
    <script>
      async function setBingBackground() {
        try {
          document.body.style.backgroundImage = \`url('https://bing.by.ccwu.cc/api/daily')\`;
        } catch (error) {
          console.error('获取背景图失败:', error);
        }
      }
      setBingBackground(); 
      setInterval(setBingBackground, 3600000);

      document.getElementById('loginForm').addEventListener('submit', async (e) => {
        e.preventDefault();
        
        const loginBtn = document.getElementById('loginBtn');
        const errorEl = document.getElementById('error');
        const username = document.getElementById('username').value.trim();
        const password = document.getElementById('password').value.trim();
        
        // 状态重置：先禁用按钮再发请求
        loginBtn.disabled = true;
        loginBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 登录中...';
        errorEl.style.display = 'none';
    
        try {
          const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
          });
    
          if (response.ok) {
            window.location.href = '/upload';
          } else {
            errorEl.style.display = 'block';
            errorEl.innerHTML = '<i class="fas fa-ban"></i> 用户名或密码错误';
            // 失败时恢复按钮
            loginBtn.disabled = false;
            loginBtn.innerHTML = '<i class="fas fa-right-to-bracket"></i> 登录';
          }
        } catch (err) {
          console.error('登录请求失败:', err);
          errorEl.style.display = 'block';
          errorEl.innerHTML = '<i class="fas fa-clock"></i> 网络错误，请稍后再试';
          // 异常时恢复按钮
          loginBtn.disabled = false;
          loginBtn.innerHTML = '<i class="fas fa-right-to-bracket"></i> 登录';
        }
      });
      // ---------- 通用模态框 ----------
      function showModal({icon='success', title='', msg='', btns=null}) {
        return new Promise(resolve => {
          let overlay = document.getElementById('globalModal');
          if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'globalModal';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = '<div class="modal-box"><div class="modal-icon"></div><div class="modal-title"></div><div class="modal-msg"></div><div class="modal-btns"></div></div>';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.classList.remove('show'); resolve(false); } });
          }
          const iconMap = { success:'fa-circle-check', error:'fa-circle-xmark', warning:'fa-triangle-exclamation', info:'fa-circle-info' };
          overlay.querySelector('.modal-icon').className = 'modal-icon ' + icon + ' fas ' + (iconMap[icon]||'fa-circle-info');
          overlay.querySelector('.modal-title').textContent = title;
          overlay.querySelector('.modal-msg').textContent = msg;
          const btnBox = overlay.querySelector('.modal-btns'); btnBox.innerHTML = '';
          const list = btns || [{text:'确定', type:'primary'}];
          list.forEach(b => {
            const btn = document.createElement('button');
            btn.textContent = b.text;
            btn.className = 'modal-btn' + (b.type==='secondary' ? ' secondary' : (b.type==='danger' ? ' danger' : ''));
            btn.onclick = () => { overlay.classList.remove('show'); resolve(b.value !== undefined ? b.value : true); };
            btnBox.appendChild(btn);
          });
          overlay.classList.add('show');
        });
      }
      async function showAlert(msg, title='提示', icon='info') { await showModal({icon, title, msg}); }
      async function showConfirm(msg, title='确认', icon='warning') {
        return await showModal({icon, title, msg, btns:[{text:'取消', type:'secondary', value:false},{text:'确定', type:'primary', value:true}]});
      }

    </script>
  </body>
  </html>`;
}

// 生成文件上传页面 /upload
function generateUploadPage() {
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
  ${headLinks()}
  <title>文件上传</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        transition: background-image 1s ease-in-out;
        display: flex;
        justify-content: center;
        align-items: center;
        min-height: 100vh;
        background: #f5f5f5;
        background-size: cover;
        background-position: center;
        margin: 0;
      }
      .container {
        width: 95%;
        max-width: 800px;
        background: rgba(255, 255, 255, 0.3);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        padding: 30px;
        margin: 20px;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        box-sizing: border-box;
      }

      .header { display: flex; justify-content: space-between; align-items: center; margin-bottom: 20px; }
      .admin-link {
        background: #007BFF;
        padding: 5px 10px;
        border: none;
        border-radius: 8px;
        text-decoration: none;
        color: #ffffff;
        display: inline-block;
        margin-left: auto;
      }
      .admin-link:hover { background: #0056b3; text-decoration: none; transition: color 0.3s ease; }
      
      .upload-area {
        border: 2px dashed rgba(0, 0, 0, 0.15);
        padding: 8px;
        height: 80px;
        display: flex;
        align-items: center;
        justify-content: center;
        text-align: center;
        margin: 0 auto;
        border-radius: 8px;
        transition: all 0.3s;
        box-sizing: border-box;
      }
      .upload-area p { line-height: 2; }
      .upload-area.dragover { border-color: #007bff; background: #f8f9fa; }

      /* 【补丁⑪】上传时选择文件夹 */
      .folder-picker {
        display: flex; align-items: center; gap: 10px; flex-wrap: wrap;
        margin: 0 auto 14px; padding: 8px 12px; max-width: 640px;
        background: rgba(255,255,255,0.6); border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0,0,0,0.08); font-size: 14px;
      }
      .folder-picker select {
        flex: 1; min-width: 180px; padding: 6px 10px; border-radius: 8px;
        border: 1px solid rgba(0,0,0,0.15); background: #fff; font-size: 14px;
      }
      .fp-new-btn {
        padding: 6px 12px; border: none; border-radius: 8px; cursor: pointer;
        background: #007bff; color: #fff; font-size: 13px;
      }
      .fp-new-btn:hover { background: #0056b3; }
      .fp-tip { color: #888; font-size: 12px; }
      
      .preview-area { margin-top: 20px; display: none; overflow-y: auto; min-height: 80px; max-height: 180px; padding-right: 6px; }
      .preview-item {
        display: flex;
        flex-direction: row;
        align-items: center;
        position: relative;
        padding: 10px;
        border: 1px solid rgba(0, 0, 0, 0.15);
        margin-bottom: 8px;
        border-radius: 8px;
        box-sizing: border-box;
      }
      .preview-item img {
        width: 100px;
        height: 60px;
        object-fit: cover;
        margin-right: 15px;
        border-radius: 4px;
        flex-shrink: 0;
      }
      .preview-item .info { flex-grow: 1; min-width: 0; overflow: hidden; }
      .info div:first-child {
        font-weight: bold;
        white-space: nowrap;
        overflow: hidden;
        word-break: break-all;
        white-space: normal;
        font-size: 14px;
      }
      .progress-bar {
        height: 20px;
        background: #eee;
        border-radius: 10px;
        margin: 8px 0;
        overflow: hidden;
        position: relative;
      }
      .progress-track {
        height: 100%;
        background: #007bff;
        transition: width 0.3s ease;
        width: 0;
      }
      .progress-text {
        position: absolute;
        left: 50%;
        top: 50%;
        transform: translate(-50%, -50%);
        color: white;
        font-size: 12px;
      }
      .success .progress-track { background: #28a745; }
      .success .progress-text { color: white; }
      .error .progress-track { background: #dc3545; }
      .clear-btn {
        position: absolute;
        top: 8px;
        right: 8px;
        width: 24px;
        height: 24px;
        display: flex;
        justify-content: center;
        align-items: center;
        background: rgba(0, 0, 0, 0.05);
        color: #888;
        border: none;
        border-radius: 50%;
        cursor: pointer;
        font-size: 12px;
        transition: all 0.2s;
        z-index: 10;
      }
      .clear-btn:hover { background: #ff4d4f; color: white; transform: rotate(90deg); }

      .url-area { margin: 15px 0; box-sizing: border-box; height: 80px; }
      .url-area .input-wrapper { position: relative; display: block; width: 100%; }
      .url-area .input-wrapper i { position: absolute; left: 12px; top: 15px; color: #666; pointer-events: none; }
      .url-area textarea {
        width: 100%;
        box-sizing: border-box;
        resize: none;
        height: 80px;
        min-height: 80px;
        overflow-y: auto;
        padding: 12px 12px 12px 35px;
        word-break: break-all;
        border: 1px solid rgba(0, 0, 0, 0.15);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.2);
      }

      .button-container {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
        margin: 15px 0;
      }
      .button-container button {
        flex: 1;
        min-width: 80px;
        padding: 8px 12px;
        border: none;
        border-radius: 4px;
        background: #007bff;
        color: white;
        cursor: pointer;
      }
      .button-container button:hover { background: #0056b3; transition: color 0.3s ease; }

      /* 版权页脚 */
      footer {
        font-size: 0.85rem;
        width: 100%;
        text-align: center;
        padding: 15px 0 5px 0;
      }
      footer p {
        color: #585858;
        display: flex;
        margin: 0;
        align-content: center;
        justify-content: center;
        flex-wrap: wrap;
        gap: 8px;
      }
      footer a { color: #585858; text-decoration: none; transition: color 0.3s ease; }
      footer a:hover { color: #007BFF; transition: color 0.3s ease; }
      
      /* PC屏幕 */
      @media (max-width: 768px) {
        footer p { justify-content: center; }
        .container { padding: 15px; margin: 10px auto; }
        .preview-item { flex-direction: column; align-items: flex-start; }
        .preview-item img { width: 100%; height: 120px; margin-right: 0; margin-bottom: 10px; }
        .preview-item .info { width: 100%; }
      }
      /* 通用模态框（毛玻璃） */
      .modal-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        display: none; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.25s ease;
      }
      .modal-overlay.show { display: flex; opacity: 1; }
      .modal-box {
        background: rgba(255, 255, 255, 0.65);
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        border: 1px solid rgba(255, 255, 255, 0.4);
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
        padding: 28px 32px; max-width: 90vw; width: 360px;
        text-align: center; color: #222;
        transform: scale(0.92); transition: transform 0.25s ease;
      }
      .modal-overlay.show .modal-box { transform: scale(1); }
      .modal-icon { font-size: 42px; margin-bottom: 12px; }
      .modal-icon.success { color: #28a745; }
      .modal-icon.error { color: #dc3545; }
      .modal-icon.warning { color: #ffc107; }
      .modal-title { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
      .modal-msg { font-size: 14px; line-height: 1.6; margin-bottom: 20px; color: #444; word-break: break-word; }
      .modal-btns { display: flex; gap: 10px; justify-content: center; }
      .modal-btns button {
        padding: 8px 22px; border: none; border-radius: 8px;
        font-size: 14px; cursor: pointer; transition: all 0.2s;
      }
      .modal-btn { background: #007bff; color: #fff; }
      .modal-btn:hover { background: #0056b3; }
      .modal-btn.secondary { background: rgba(0,0,0,0.08); color: #444; }
      .modal-btn.secondary:hover { background: rgba(0,0,0,0.15); }
      .modal-btn.danger { background: #dc3545; color: #fff; }
      .modal-btn.danger:hover { background: #c82333; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h1 style="margin: 0;"><i class="fas fa-file-upload"></i> 文件上传</h1>
        <a href="/admin" class="admin-link"><i class="fas fa-list"></i> 文件管理</a>
      </div>
      <!-- 【补丁⑪】上传到哪个文件夹 -->
      <div class="folder-picker">
        <span><i class="fas fa-folder"></i> 上传到：</span>
        <select id="folderSelect"><option value="">未分类（根目录）</option></select>
        <button type="button" class="fp-new-btn" id="folderNewBtn"><i class="fas fa-folder-plus"></i> 新建文件夹</button>
        <span class="fp-tip">链接会自动带上文件夹路径</span>
      </div>
      <div class="upload-area" id="uploadArea">
        <p>点击选择 或 拖拽文件到此处<br>支持 Ctrl+V 粘贴上传</p>
        <input type="file" id="fileInput" multiple style="display: none">
      </div>
      <div class="preview-area" id="previewArea"></div>
      <div class="url-area">
        <div class="input-wrapper">
          <i class="fas fa-link"></i> <textarea id="urlArea" readonly placeholder="上传完成后的链接将显示在这里"></textarea>
        </div>
      </div>
      <div class="button-container">
        <button onclick="copyUrls('url')"><i class="fas fa-link"></i> 复制 URL</button>
        <button onclick="copyUrls('markdown')"><i class="fab fa-markdown"></i> 复制 Markdown</button>
        <button onclick="copyUrls('html')"><i class="fas fa-code"></i> 复制 HTML</button>
      </div>
      <footer>
        ${copyright()}
      </footer>
    </div>

    <script>
      // 声明全局配置变量
      let globalConfig = { maxSizeMB: 20 };
      async function loadConfig() {
        try {
          const resp = await fetch('/config');
          if (resp.ok) {
            globalConfig = await resp.json();
          }
        } catch (e) {
          console.error("加载配置失败:", e);
        }
      }
      loadConfig();

      // 背景图函数
      async function setBingBackground() {
        try {
          document.body.style.backgroundImage = \`url('https://bing.by.ccwu.cc/api/daily')\`;
        } catch (error) {
          console.error('获取背景图失败:', error);
        }
      }
      setBingBackground();
      setInterval(setBingBackground, 3600000);
      
      // 文件图标映射
      function getFileInfo(fileName) {
        const extension = fileName.split('.').pop().toLowerCase();
        const iconMap = {
          'pdf': { icon: 'fa-file-pdf', color: '#ff4d4f' },
          'doc': { icon: 'fa-file-word', color: '#2b579a' },
          'docx': { icon: 'fa-file-word', color: '#2b579a' },
          'xls': { icon: 'fa-file-excel', color: '#217346' },
          'xlsx': { icon: 'fa-file-excel', color: '#217346' },
          'ppt': { icon: 'fa-file-powerpoint', color: '#d24726' },
          'pptx': { icon: 'fa-file-powerpoint', color: '#d24726' },
          'csv': { icon: 'fa-file-csv', color: '#217346' },
          'txt': { icon: 'fa-file-alt', color: '#666' },
          'log': { icon: 'fa-file-alt', color: '#666' },
          'md': { icon: 'fa-file-alt', color: '#666' },
          'html': { icon: 'fa-file-code', color: '#e34f26' },
          'css': { icon: 'fa-file-code', color: '#1572b6' },
          'js': { icon: 'fa-file-code', color: '#f7df1e' },
          'json': { icon: 'fa-file-code', color: '#333' },
          'xml': { icon: 'fa-file-code', color: '#e34f26' },
          'yaml': { icon: 'fa-file-code', color: '#e34f26' },
          'yml': { icon: 'fa-file-code', color: '#e34f26' },
          'sql': { icon: 'fa-file-code', color: '#e34f26' },
          'sh': { icon: 'fa-file-code', color: '#4CAF50' },
          'bat': { icon: 'fa-file-code', color: '#333' },
          'zip': { icon: 'fa-file-archive', color: '#fadb14' },
          'rar': { icon: 'fa-file-archive', color: '#fadb14' },
          '7z': { icon: 'fa-file-archive', color: '#fadb14' },
          'iso': { icon: 'fa-file-archive', color: '#fadb14' },
          'mp4': { icon: 'fa-file-video', color: '#722ed1' },
          'mkv': { icon: 'fa-file-video', color: '#722ed1' },
          'avi': { icon: 'fa-file-video', color: '#722ed1' },
          'mov': { icon: 'fa-file-video', color: '#722ed1' },
          'wmv': { icon: 'fa-file-video', color: '#722ed1' },
          'mp3': { icon: 'fa-file-audio', color: '#eb2f96' },
          'wav': { icon: 'fa-file-audio', color: '#eb2f96' },
          'flac': { icon: 'fa-file-audio', color: '#eb2f96' },
          'ogg': { icon: 'fa-file-audio', color: '#eb2f96' },
          'exe': { icon: 'fa-gear', color: '#ff7043' },
          'dmg': { icon: 'fa-compact-disc', color: '#42a5f5' },
          'apk': { icon: 'fa-android', color: '#66bb6a' },
        };
        return iconMap[extension] || { icon: 'fa-file-lines', color: '#e8b830' };
      }

      const uploadArea = document.getElementById('uploadArea');
      const fileInput = document.getElementById('fileInput');
      const previewArea = document.getElementById('previewArea');
      const urlArea = document.getElementById('urlArea');
      let uploadedUrls = [];

      // -------------------- 【补丁⑪】文件夹选择 --------------------
      let folderPaths = [];
      function selectedFolder() {
        const sel = document.getElementById('folderSelect');
        return sel ? sel.value : '';
      }
      function renderFolderOptions(keep) {
        const sel = document.getElementById('folderSelect');
        if (!sel) return;
        const cur = keep !== undefined ? keep : sel.value;
        sel.innerHTML = '';
        const first = document.createElement('option');
        first.value = '';
        first.textContent = '未分类（根目录）';
        sel.appendChild(first);
        folderPaths.forEach(function (p) {
          const o = document.createElement('option');
          o.value = p;
          o.textContent = '　'.repeat(p.split('/').length - 1) + p;
          sel.appendChild(o);
        });
        if (cur && folderPaths.indexOf(cur) !== -1) sel.value = cur; else sel.value = '';
      }
      async function loadFolderOptions(keep) {
        try {
          const r = await fetch('/folders');
          const d = await r.json();
          folderPaths = (d.folders || []).map(function (f) { return f.path; });
          renderFolderOptions(keep);
        } catch (e) {
          console.warn('读取文件夹列表失败:', e);
        }
      }
      (function bindNewFolderBtn() {
        const btn = document.getElementById('folderNewBtn');
        if (!btn) return;
        btn.addEventListener('click', async function () {
          const p = window.prompt('新建文件夹（可以用 / 分层，例如 文章/2026/11）', '');
          if (!p) return;
          const name = String(p).trim();
          if (!name) return;
          try {
            const r = await fetch('/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'create', path: name }) });
            const d = await r.json();
            if (!r.ok) throw new Error(d.error || '创建失败');
            await loadFolderOptions(d.path);
            await showAlert('文件夹「' + d.path + '」创建好了，已帮你选中', '创建成功', 'success');
          } catch (e) {
            await showAlert('创建失败: ' + e.message, '失败', 'error');
          }
        });
      })();
      loadFolderOptions();

      // 统一文件处理函数：负责校验和启动上传
      async function processFiles(files) {
        // 【补丁⑤】先按文件名自然排序，保证上传顺序 = 文件名顺序
        // 不再依赖文件对话框的排序（数字按数值比较：1,2,...,9,10,11，而不是 11,12,...,1,10）
        files = Array.from(files).sort(function (a, b) {
          return String(a.name).localeCompare(String(b.name), 'zh-CN', { numeric: true, sensitivity: 'base' });
        });
        let isFirst = true; // 【补丁③】串行上传用
        for (let file of files) {
          if (!file) continue;
          if (file.size > globalConfig.maxSizeMB * 1024 * 1024) {
            await showAlert(\`文件 "\${file.name || '粘贴的文件'}" 超过 \${globalConfig.maxSizeMB}MB 限制\`, '文件过大', 'warning');
            continue;
          } // 校验大小
          // 【补丁③】每张之间至少间隔 3.3 秒，避免触发 Telegram「同一频道每分钟 20 条」限制
          if (!isFirst) await new Promise((r) => setTimeout(r, 3300));
          isFirst = false;
          await uploadFile(file);
        }
      }

      // 处理点击选择和拖拽
      function handleFiles(e) {
        const files = e.target.files;
        if (files && files.length > 0) {
          processFiles(files);
          fileInput.value = ''; // 清除值以便重复选择同一文件
        }
      }

      // 事件监听：粘贴上传
      document.addEventListener('paste', (e) => {
        const items = (e.clipboardData || window.clipboardData).items;
        const files = [];
        for (let item of items) {
          if (item.kind === 'file') {
            files.push(item.getAsFile());
          }
        }
        if (files.length > 0) processFiles(files);
      });

      // UI 交互：拖拽上传区域
      function preventDefaults(e) { e.preventDefault(); e.stopPropagation(); }
      ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
        document.body.addEventListener(eventName, preventDefaults, false);
      });
      ['dragenter', 'dragover'].forEach(eventName => { uploadArea.addEventListener(eventName, () => uploadArea.classList.add('dragover'), false); });
      ['dragleave', 'drop'].forEach(eventName => { uploadArea.addEventListener(eventName, () => uploadArea.classList.remove('dragover'), false); });
      
      uploadArea.addEventListener('drop', (e) => processFiles(e.dataTransfer.files), false);
      uploadArea.addEventListener('click', () => fileInput.click());
      fileInput.addEventListener('change', handleFiles);

      // 上传文件：负责创建预览、发送请求、更新进度
      async function uploadFile(file) {
        const preview = createPreview(file);
        previewArea.appendChild(preview);
        previewArea.style.display = 'block';

        // 【补丁③】把本次上传包成 Promise —— 原代码发完 XHR 就返回，导致 await 形同虚设、所有文件并发上传
        return new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        const progressTrack = preview.querySelector('.progress-track');
        const progressText = preview.querySelector('.progress-text');

        xhr.upload.addEventListener('progress', (e) => {
          if (e.lengthComputable) {
            const percent = Math.round((e.loaded / e.total) * 100);
            progressTrack.style.width = \`\${percent}%\`;
            progressText.textContent = \`\${percent}%\`;
          }
        });

        xhr.addEventListener('load', () => {
          try {
            const data = JSON.parse(xhr.responseText);
            const progressText = preview.querySelector('.progress-text');          
            if (xhr.status >= 200 && xhr.status < 300 && data.status === 1) {
              progressText.textContent = data.msg;
              uploadedUrls.push(data.url);
              preview.setAttribute('data-url', data.url);
              updateUrlArea();
              preview.classList.add('success');
              // 上传完成：显示文件大小（webp 用准确值，其他用原图大小）
              const metaDiv = preview.querySelector('.file-meta');
              if (metaDiv) {
                const displayName = data.file || file.name;
                const displaySize = data.webpSize ? formatSize(data.webpSize) : formatSize(file.size);
                metaDiv.textContent = displayName + ' | ' + displaySize;
              }
            } else {
              const errorMsg = [data.msg, data.error || '未知错误'].filter(Boolean).join(' | ');
              progressText.textContent = errorMsg;
              preview.classList.add('error');
              // 【补丁⑩】失败时也把文件大小显示出来，方便一眼判断是不是「文件太大」
              const errMeta = preview.querySelector('.file-meta');
              if (errMeta) errMeta.textContent = (file.name || 'Pasted Image') + ' | ' + formatSize(file.size);
            }
          } catch (e) {
            preview.querySelector('.progress-text').textContent = '✗ 响应解析失败';
            preview.classList.add('error');
          }
          resolve(); // 【补丁③】本次上传结束，放行队列
        });

        const formData = new FormData();
        formData.append('file', file);
        formData.append('folder', selectedFolder()); // 【补丁⑪】带上要上传到的文件夹
        // 【补丁③】网络错误 / 中断也要放行队列，否则后面的文件会被卡死
        xhr.addEventListener('error', () => {
          preview.querySelector('.progress-text').textContent = '✗ 网络错误';
          preview.classList.add('error');
          resolve();
        });
        xhr.addEventListener('abort', () => resolve());
        xhr.open('POST', '/upload');
        xhr.send(formData);
        });
      }

      // 创建文件预览：负责显示文件信息、进度条、清除按钮
      function createPreview(file) {
        const div = document.createElement('div');
        div.className = 'preview-item';
        const clearBtn = document.createElement('button');
        clearBtn.className = 'clear-btn';
        clearBtn.innerHTML = '<i class="fas fa-times"></i>';
        clearBtn.onclick = function() {
          const urlToRemove = div.getAttribute('data-url');
          const img = div.querySelector('img');
          if (img && img.src.startsWith('blob:')) { URL.revokeObjectURL(img.src); }
          if (urlToRemove) { 
            uploadedUrls = uploadedUrls.filter(url => url !== urlToRemove); 
            updateUrlArea(); 
          }
          div.remove();
          if (previewArea.children.length === 0) {
            previewArea.style.display = 'none';
          }
        };
        div.appendChild(clearBtn);

        if (file.type.startsWith('image/')) {
          const img = document.createElement('img');
          img.src = URL.createObjectURL(file);
          div.appendChild(img);
        } else {
          const info = getFileInfo(file.name);
          const iconContainer = document.createElement('div');
          iconContainer.style.cssText = \`width: 100px; height: 56px; display: flex; justify-content: center; align-items: center; background: \${info.color}15; margin-right: 15px; border-radius: 4px; flex-shrink: 0; border: 1px solid \${info.color}33;\`;
          iconContainer.innerHTML = \`<i class="fas \${info.icon}" style="font-size: 36px; color: \${info.color};"></i>\`;
          div.appendChild(iconContainer);
        }    

        const info = document.createElement('div');
        info.className = 'info';
        info.innerHTML = \`
          <div class="file-meta">\${file.name || 'Pasted Image'} | 正在计算文件大小...</div>
          <div class="progress-bar">
            <div class="progress-track"></div>
            <span class="progress-text">0%</span>
          </div>
        \`;
        div.appendChild(info);
        return div;
      }

      // 格式化文件大小：负责将字节转换为易读的大小单位
      function formatSize(bytes) {
        const units = ['B', 'KB', 'MB', 'GB'];
        let size = bytes;
        let unitIndex = 0;
        while (size >= 1024 && unitIndex < units.length - 1) {
          size /= 1024;
          unitIndex++;
        }
        return \`\${size.toFixed(2)} \${units[unitIndex]}\`;
      }

      // 更新 URL 区域：负责将上传的 URL 显示在文本区域
      function updateUrlArea() {
        urlArea.value = uploadedUrls.join('\\n');
      }

      // 复制 URL 到剪贴板：负责将上传的 URL 复制到剪贴板
      function copyUrls(format) {
        let text = '';
        if (uploadedUrls.length === 0) return;
        switch (format) {
          case 'url':
            text = uploadedUrls.join('\\n');
            break;
          case 'markdown':
            text = uploadedUrls.map(url => {
              const isImg = /\\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(url);
              const fileName = url.split('/').pop(); 
              return isImg ? \`![\${fileName}](\${url})\` : \`[\${fileName}](\${url})\`;
            }).join('\\n');
            break;
          case 'html':
            text = uploadedUrls.map(url => {
              const isImg = /\\.(jpg|jpeg|png|gif|webp|bmp)$/i.test(url);
              const fileName = url.split('/').pop();
              return isImg ? \`<img src="\${url}" alt="\${fileName}" />\` : \`<a href="\${url}">\${fileName}</a>\`;
            }).join('\\n');
            break;
        }
        navigator.clipboard.writeText(text);
        showAlert('已复制到剪贴板', '复制成功', 'success');
      }
      
      // 点击 URL 区域复制所有 URL
      document.getElementById('urlArea').addEventListener('click', function() {
        if (this.value.trim() !== "") {
          this.select();
          navigator.clipboard.writeText(this.value);
        }
      });
      // ---------- 通用模态框 ----------
      function showModal({icon='success', title='', msg='', btns=null}) {
        return new Promise(resolve => {
          let overlay = document.getElementById('globalModal');
          if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'globalModal';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = '<div class="modal-box"><div class="modal-icon"></div><div class="modal-title"></div><div class="modal-msg"></div><div class="modal-btns"></div></div>';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.classList.remove('show'); resolve(false); } });
          }
          const iconMap = { success:'fa-circle-check', error:'fa-circle-xmark', warning:'fa-triangle-exclamation', info:'fa-circle-info' };
          overlay.querySelector('.modal-icon').className = 'modal-icon ' + icon + ' fas ' + (iconMap[icon]||'fa-circle-info');
          overlay.querySelector('.modal-title').textContent = title;
          overlay.querySelector('.modal-msg').textContent = msg;
          const btnBox = overlay.querySelector('.modal-btns'); btnBox.innerHTML = '';
          const list = btns || [{text:'确定', type:'primary'}];
          list.forEach(b => {
            const btn = document.createElement('button');
            btn.textContent = b.text;
            btn.className = 'modal-btn' + (b.type==='secondary' ? ' secondary' : (b.type==='danger' ? ' danger' : ''));
            btn.onclick = () => { overlay.classList.remove('show'); resolve(b.value !== undefined ? b.value : true); };
            btnBox.appendChild(btn);
          });
          overlay.classList.add('show');
        });
      }
      async function showAlert(msg, title='提示', icon='info') { await showModal({icon, title, msg}); }
      async function showConfirm(msg, title='确认', icon='warning') {
        return await showModal({icon, title, msg, btns:[{text:'取消', type:'secondary', value:false},{text:'确定', type:'primary', value:true}]});
      }

    </script>

  </body>
  </html>`;
}

// 生成文件管理页面 /admin
function generateAdminPage(fileCards, qrModal, showHidden, folderUI) { // 【补丁⑧修复】需要知道当前是否在「显示已隐藏」视图；【补丁⑪】加上文件夹侧栏
  // 【补丁⑪】文件夹侧栏 / 下拉框 / 「显示已隐藏」链接（保留当前筛选）——都要有兜底值，缺了也不会白屏
  const folderPanel = (folderUI && folderUI.panel) || "";
  const folderOptionsHtml = (folderUI && folderUI.optionsHtml) || '<option value="">未分类（根目录）</option>';
  const hiddenLink = (folderUI && folderUI.hiddenLink) || (showHidden ? "/admin" : "/admin?hidden=1");
  return `<!DOCTYPE html>
  <html lang="zh-CN">
  <head>
  ${headLinks()}
  <title>文件管理</title>
    <style>
      body {
        font-family: Arial, sans-serif;
        margin: 0;
        padding: 20px;
        background: #f5f5f5;
        background-size: cover;
        background-position: center;
      }
      .container {
        max-width: 1200px;
        margin: 0 auto;
      }

      .header {
        background: rgba(255, 255, 255, 0.3);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        padding: 20px;
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        margin-bottom: 20px;
        display: flex;
        flex-wrap: wrap; /* 移动端支持换行 */
        align-items: center;
      }
      .header h2 { margin: 0; flex: 1; min-width: 0; }
      .header .backup {
        background: #007BFF;
        padding: 5px 10px;
        border: none;
        border-radius: 8px;
        margin: 0;
        text-decoration: none;
        color: #fff;
        text-decoration: none;
      }
      .header .backup:hover { background: #0056b3; text-decoration: none; transition: color 0.3s ease; }

      .search-wrapper {
        position: relative;
        flex: 1 1 100%;
        max-width: 100%;
        box-sizing: border-box;
        margin-top: 10px;
      }
      .search-wrapper i {
        position: absolute;
        left: 12px;
        top: 50%;
        transform: translateY(-50%);
        color: #666;
        pointer-events: none;
        z-index: 5;
      }
      .search-wrapper .search {
        width: 100%;
        padding: 10px 12px 10px 35px;
        border: 1px solid rgba(0, 0, 0, 0.15);
        border-radius: 8px;
        background: rgba(255, 255, 255, 0.5);
        box-sizing: border-box;
        outline: none;
        transition: all 0.3s;
      }
      .search-wrapper .search:focus {
        background: rgba(255, 255, 255, 0.8);
        border-color: #007bff;
        box-shadow: 0 0 8px rgba(0,123,255,0.2);
      }
      
      .grid {
        display: grid;
        grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
        gap: 20px;
      }
      .file-card {
        background: rgba(255, 255, 255, 0.3);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-radius: 8px;
        box-shadow: 0 2px 10px rgba(0,0,0,0.1);
        overflow: hidden;
        position: relative;
      }
      .file-preview {
        height: 150px;
        display: flex;
        align-items: center;
        justify-content: center;
      }
      .file-preview img, .file-preview video {
        max-width: 100%;
        max-height: 100%;
        object-fit: contain;
      }
      .file-preview iframe {
        width: 100%;
        height: 100%;
        border: none;
        border-radius: 4px;
      }
      .text-preview {
        display: flex;
        flex-direction: column;
        align-items: center;
        justify-content: center;
        width: 100%;
        height: 100%;
        cursor: pointer;
        transition: background 0.2s;
      }
      .text-preview:hover { background: rgba(0,0,0,0.03); }
      .text-preview-hint {
        font-size: 12px;
        color: #999;
        margin-top: 4px;
      }
      .text-preview.loaded pre {
        margin: 0;
        padding: 8px;
        font-size: 11px;
        line-height: 1.4;
        overflow: hidden;
        text-overflow: ellipsis;
        max-height: 130px;
        width: 100%;
        box-sizing: border-box;
        white-space: pre-wrap;
        word-break: break-all;
      }
      .text-preview.loaded i,
      .text-preview.loaded .text-preview-hint { display: none; }
      .text-preview.loaded { cursor: default; }
    
      .file-info { padding: 10px; font-size: 14px; }
      .file-actions { padding: 10px; border-top: 1px solid rgba(0, 0, 0, 0.15); display: flex; justify-content: space-between; align-items: flex-end; font-size: 12px; }
      .file-actions .btn { font-size: inherit; }
      .btn { padding: 5px 10px; border: none; border-radius: 8px; cursor: pointer; }
      .btn-delete { background: #dc3545; color: white; }
      .btn-copy { background: #007bff; color: white; }
      .btn-down { background: #3c9144; color: white; text-decoration: none; }

      /* 【补丁④】批量删除相关样式 */
      .batch-bar {
        display: flex; align-items: center; gap: 14px; flex-wrap: wrap;
        margin: 0 0 18px; padding: 10px 14px;
        background: rgba(255,255,255,0.5); backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        font-size: 14px;
      }
      .batch-bar label { display: flex; align-items: center; gap: 6px; cursor: pointer; user-select: none; }
      .batch-bar input[type="checkbox"] { width: 16px; height: 16px; cursor: pointer; margin: 0; }
      .batch-count { font-weight: 600; color: #333; }
      .batch-hint { color: #888; font-size: 12px; margin-left: auto; }
      .batch-bar .btn:disabled { opacity: 0.45; cursor: not-allowed; }
      .batch-clear { background: rgba(0,0,0,0.08); color: #444; }
      .card-pick {
        position: absolute; top: 8px; left: 8px; z-index: 5;
        display: flex; align-items: center; justify-content: center;
        width: 26px; height: 26px; border-radius: 6px;
        background: rgba(255,255,255,0.9); box-shadow: 0 1px 4px rgba(0,0,0,0.25);
        cursor: pointer;
      }
      .card-pick input { width: 16px; height: 16px; cursor: pointer; margin: 0; }
      .file-card.selected { outline: 3px solid #dc3545; outline-offset: -3px; }

      /* 【补丁⑪】文件夹侧栏 + 批量移动控件 */
      .folder-panel {
        margin: 0 0 14px; padding: 12px 14px;
        background: rgba(255,255,255,0.55); backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        border-radius: 8px; box-shadow: 0 2px 8px rgba(0,0,0,0.08);
        font-size: 14px;
      }
      .folder-head { display: flex; align-items: center; gap: 12px; flex-wrap: wrap; margin-bottom: 10px; }
      .fp-title { font-weight: 600; }
      .fp-new { background: #007bff; color: #fff; font-size: 13px; }
      .fp-now { color: #555; font-size: 13px; }
      .fp-deep { font-size: 13px; color: #007bff; text-decoration: none; }
      .fp-deep:hover { text-decoration: underline; }
      .folder-list { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
      .folder-item { display: inline-flex; align-items: center; gap: 2px; }
      .folder-chip {
        display: inline-flex; align-items: center; gap: 6px;
        padding: 5px 10px; border-radius: 999px; font-size: 13px;
        background: #eef3ff; color: #2059c9; text-decoration: none; white-space: nowrap;
      }
      .folder-chip:hover { background: #dfe9ff; }
      .folder-chip.active { background: #2059c9; color: #fff; }
      .fc-count { font-size: 11px; opacity: 0.75; }
      .folder-mini {
        border: none; background: rgba(0,0,0,0.06); color: #555;
        border-radius: 6px; padding: 3px 6px; font-size: 11px; cursor: pointer; text-decoration: none;
      }
      .folder-mini:hover { background: rgba(0,0,0,0.13); }
      .folder-mini.danger { color: #b3261e; }
      .folder-tip { margin-top: 10px; font-size: 12px; color: #888; line-height: 1.6; }
      .file-folder { font-size: 12px; color: #2059c9; margin-top: 2px; word-break: break-all; }
      .batch-move { display: inline-flex; align-items: center; gap: 6px; color: #555; }
      .batch-move select {
        max-width: 200px; padding: 5px 8px; border-radius: 8px;
        border: 1px solid rgba(0,0,0,0.15); background: #fff; font-size: 13px;
      }
      .btn-move { background: #2059c9; color: #fff; }
      .btn-move:disabled { opacity: 0.45; cursor: not-allowed; }

      /* 【补丁⑧】隐藏功能样式 */
      .file-card.is-hidden { opacity: 0.55; }
      .hidden-badge {
        position: absolute; top: 10px; right: 44px; z-index: 5;
        background: rgba(0,0,0,0.7); color: #fff; font-size: 11px;
        padding: 3px 8px; border-radius: 20px;
      }
      .card-hide-btn {
        position: absolute; top: 8px; right: 8px; z-index: 6;
        width: 26px; height: 26px; border: none; border-radius: 6px;
        background: rgba(255,255,255,0.9); color: #555; cursor: pointer;
        box-shadow: 0 1px 4px rgba(0,0,0,0.25);
      }
      .card-hide-btn:hover { background: #fff; color: #111; }
      .btn-hide { background: #6c757d; color: #fff; }

      .qr-modal {
        display: none;
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background: rgba(0, 0, 0, 0.5);
        justify-content: center;
        align-items: center;
        z-index: 1000;
      }
      .qr-content {
        background: white;
        padding: 20px;
        border-radius: 10px;
        text-align: center;
        box-shadow: 0 2px 10px rgba(0,0,0,0.2);
      }
      #qrcode {
        margin: 5px 0;
      }
      .qr-buttons {
        display: flex;
        gap: 10px;
        justify-content: center;
        margin-top: 15px;
      }
      .qr-copy, .qr-close {
        padding: 8px 20px;
        background: #007bff;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
      }

      /* 分页按钮样式 */
      #pagination {
        display: flex;
        justify-content: center;
        align-items: center;
        flex-wrap: wrap;
        gap: 10px;
      }
    
      #pagination .btn-page {
        padding: 6px 14px;
        border-radius: 8px;
        border: none;
        background: rgba(255, 255, 255, 0.3);
        backdrop-filter: blur(10px);
        -webkit-backdrop-filter: blur(10px);
        color: #0A0A0A;
        cursor: pointer;
        transition: all 0.2s;
        min-width: 40px;
        text-align: center;
        font-size: 14px;
        box-shadow: none;
        margin: 20px 0;
      }

      #pagination .btn-page:hover { background: #0056b3; color: #fff; transition: color 0.3s ease; }
      #pagination .btn-page.active { background-color: #007bff; color: #fff; cursor: default; }
    
      #pagination .btn-page:disabled {
        background-color: #f0f0f0;
        color: #aaa;
        cursor: not-allowed;
        border-color: #ccc;
      }
    
      #pagination span.page-info {
        padding: 6px 10px;
        font-size: 14px;
        color: #333;
      }

      /* 版权页脚 */
      footer {
        font-size: 0.85rem;
        width: 100%;
        text-align: center;
      }
      footer p {
        color: #585858;
        display: flex;
        justify-content: center;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        margin: 0;
      }
      footer a { color: #585858; text-decoration: none; transition: color 0.3s ease; }
      footer a:hover { color: #007BFF; transition: color 0.3s ease; }
      
      /* PC端 */
      @media (min-width: 768px) {
        .header { flex-wrap: nowrap; }
        /*.header .backup { margin-right: 20px; }*/
        .search-wrapper { flex: 0 0 300px; margin-top: 0; margin-left: 20px; }
      }
      /* 通用模态框（毛玻璃） */
      .modal-overlay {
        position: fixed; inset: 0; z-index: 9999;
        background: rgba(0, 0, 0, 0.35);
        backdrop-filter: blur(6px); -webkit-backdrop-filter: blur(6px);
        display: none; align-items: center; justify-content: center;
        opacity: 0; transition: opacity 0.25s ease;
      }
      .modal-overlay.show { display: flex; opacity: 1; }
      .modal-box {
        background: rgba(255, 255, 255, 0.65);
        backdrop-filter: blur(18px); -webkit-backdrop-filter: blur(18px);
        border: 1px solid rgba(255, 255, 255, 0.4);
        border-radius: 16px;
        box-shadow: 0 12px 40px rgba(0, 0, 0, 0.2);
        padding: 28px 32px; max-width: 90vw; width: 360px;
        text-align: center; color: #222;
        transform: scale(0.92); transition: transform 0.25s ease;
      }
      .modal-overlay.show .modal-box { transform: scale(1); }
      .modal-icon { font-size: 42px; margin-bottom: 12px; }
      .modal-icon.success { color: #28a745; }
      .modal-icon.error { color: #dc3545; }
      .modal-icon.warning { color: #ffc107; }
      .modal-title { font-size: 18px; font-weight: 600; margin-bottom: 10px; }
      .modal-msg { font-size: 14px; line-height: 1.6; margin-bottom: 20px; color: #444; word-break: break-word; }
      .modal-btns { display: flex; gap: 10px; justify-content: center; }
      .modal-btns button {
        padding: 8px 22px; border: none; border-radius: 8px;
        font-size: 14px; cursor: pointer; transition: all 0.2s;
      }
      .modal-btn { background: #007bff; color: #fff; }
      .modal-btn:hover { background: #0056b3; }
      .modal-btn.secondary { background: rgba(0,0,0,0.08); color: #444; }
      .modal-btn.secondary:hover { background: rgba(0,0,0,0.15); }
      .modal-btn.danger { background: #dc3545; color: #fff; }
      .modal-btn.danger:hover { background: #c82333; }
    </style>
  </head>
  <body>
    <div class="container">
      <div class="header">
        <h2><i class="fas fa-list"></i> 文件管理</h2>
        <a href="${hiddenLink}" class="backup"><i class="fas fa-eye${showHidden ? "" : "-slash"}"></i> ${showHidden ? "只看未隐藏" : "显示已隐藏"}</a>
        <a href="/upload" class="backup"><i class="fas fa-arrow-left"></i> 返回</a>
        <div class="search-wrapper">
          <i class="fas fa-magnifying-glass"></i>
          <input type="text" class="search" placeholder="搜索文件..." id="searchInput">
        </div>
      </div>
      <!-- 【补丁⑪】文件夹侧栏 -->
      ${folderPanel}
      <!-- 【补丁④】批量删除操作栏 -->
      <div class="batch-bar">
        <label class="batch-all"><input type="checkbox" id="selectAllCheck"> 全选本页</label>
        <span id="batchCount" class="batch-count">已选 0 项</span>
        <button class="btn btn-delete" id="batchDeleteBtn" disabled><i class="fas fa-trash"></i> 批量删除所选</button>
        <button class="btn btn-hide" id="batchHideBtn" disabled><i class="fas fa-eye-slash"></i> 隐藏所选</button>
        <button class="btn batch-clear" id="batchUnhideBtn" disabled><i class="fas fa-eye"></i> 取消隐藏</button>
        <button class="btn batch-clear" id="batchClearBtn"><i class="fas fa-xmark"></i> 取消选择</button>
        <span class="batch-move">
          <i class="fas fa-folder-tree"></i>
          <select id="moveSelect">${folderOptionsHtml}</select>
          <button class="btn btn-move" id="batchMoveBtn" disabled><i class="fas fa-arrow-right"></i> 移动到</button>
        </span>
        <span class="batch-hint">提示：一次最多 100 个</span>
      </div>
      <div class="grid" id="fileGrid">
        ${fileCards}
      </div>
      ${qrModal}
    </div>
    <footer>
      ${copyright()}
    </footer>

    <script src="https://cdn.jsdelivr.net/npm/qrcodejs/qrcode.min.js"></script>
    <script>
      // -------------------- 基本变量 --------------------
      const itemsPerPage = 15; 
      let currentPage = 1;
    
      const fileGrid = document.getElementById('fileGrid');
      const searchInput = document.getElementById('searchInput');
      let fileCards = Array.from(fileGrid.children);
    
      // 创建分页容器
      const paginationContainer = document.createElement('div');
      paginationContainer.id = 'pagination';
      fileGrid.parentNode.insertBefore(paginationContainer, fileGrid.nextSibling);
    
      // -------------------- 背景图 --------------------
      async function setBingBackground() {
        try {
          document.body.style.backgroundImage = \`url('https://bing.by.ccwu.cc/api/daily')\`;
        } catch (error) {
          console.error('获取背景图失败:', error);
        }
      }
      setBingBackground();
      setInterval(setBingBackground, 3600000);
    
      // -------------------- 分页逻辑 --------------------
      function getFilteredCards() {
        const term = searchInput.value.toLowerCase();
        return fileCards.filter(card => {
          const name = card.querySelector('.file-info div:first-child').textContent.toLowerCase();
          return name.includes(term);
        });
      }
    
      function renderPage(page) {
        const filteredCards = getFilteredCards();
        const totalPages = Math.ceil(filteredCards.length / itemsPerPage) || 1;
        if (page > totalPages) currentPage = totalPages;
        if (page < 1) currentPage = 1;
        const start = (currentPage - 1) * itemsPerPage;
        const end = start + itemsPerPage;
        fileCards.forEach(c => c.style.display = 'none');
        filteredCards.slice(start, end).forEach(c => c.style.display = '');
        renderPagination(totalPages);
        updateBatchUI(); // 【补丁④】同步批量选择状态
      }
    
      function renderPagination(totalPages) {
        paginationContainer.innerHTML = '';
        const prevBtn = document.createElement('button');
        prevBtn.innerHTML = '<i class="fas fa-chevron-left"></i> 上一页';
        prevBtn.className = 'btn-page';
        prevBtn.disabled = currentPage === 1;
        prevBtn.onclick = () => { currentPage--; renderPage(currentPage); };
        paginationContainer.appendChild(prevBtn);
    
        for (let i = 1; i <= totalPages; i++) {
          const btn = document.createElement('button');
          btn.textContent = i;
          btn.className = 'btn-page' + (i === currentPage ? ' active' : '');
          btn.onclick = () => { currentPage = i; renderPage(currentPage); };
          paginationContainer.appendChild(btn);
        }
    
        const nextBtn = document.createElement('button');
        nextBtn.innerHTML = '下一页 <i class="fas fa-chevron-right"></i>';
        nextBtn.className = 'btn-page';
        nextBtn.disabled = currentPage === totalPages;
        nextBtn.onclick = () => { currentPage++; renderPage(currentPage); };
        paginationContainer.appendChild(nextBtn);
      }
    
      searchInput.addEventListener('input', () => {
        currentPage = 1;
        renderPage(currentPage);
      });
    
      // -------------------- 二维码功能 --------------------
      let currentShareUrl = '';
      function showQRCode(url) {
        currentShareUrl = url;
        const modal = document.getElementById('qrModal');
        const qrcodeDiv = document.getElementById('qrcode');
        const copyBtn = document.querySelector('.qr-copy');
        copyBtn.innerHTML = '<i class="fas fa-copy"></i> 复制链接';
        copyBtn.disabled = false;
        qrcodeDiv.innerHTML = '';
        new QRCode(qrcodeDiv, { text: url, width: 200, height: 200, colorDark: "#000", colorLight: "#fff", correctLevel: QRCode.CorrectLevel.H });
        modal.style.display = 'flex';
      }
    
      function handleCopyUrl() {
        navigator.clipboard.writeText(currentShareUrl).then(() => {
          const copyBtn = document.querySelector('.qr-copy');
          copyBtn.innerHTML = '<i class="fas fa-check"></i> 已复制';
          copyBtn.disabled = true;
          setTimeout(() => { 
            copyBtn.innerHTML = '<i class="fas fa-copy"></i> 复制链接'; 
            copyBtn.disabled = false; 
          }, 5000);
        }).catch(() => showAlert('复制失败，请手动复制', '复制失败', 'error'));
      }
    
      function closeQRModal() {
        document.getElementById('qrModal').style.display = 'none';
      }
    
      document.getElementById('qrModal').addEventListener('click', function(e) {
        if (e.target === this) this.style.display = 'none';
      });
    
      // -------------------- 删除功能 --------------------
      async function deleteFile(url) {
        const card = document.querySelector(\`[data-url="\${url}"]\`);
        const fileName = card ? card.querySelector('.file-info div:first-child').textContent : '此文件';
        if (!(await showConfirm(\`确定要删除 \${fileName} 吗？此操作不可撤销。\`, '删除确认'))) return;
        try {
          const response = await fetch('/delete', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url }) });
          if (!response.ok) {
            const errorData = await response.json();
            throw new Error(errorData.error || '删除失败');
          }
          if (card) card.remove();
          fileCards = Array.from(fileGrid.children);
          renderPage(currentPage);
          await showAlert(\`\${fileName} 删除成功\`, '删除成功', 'success');
        } catch (err) {
          await showAlert('文件删除失败: ' + err.message, '删除失败', 'error');
        }
      }
    
      // -------------------- 【补丁④】批量删除 --------------------
      const batchCountEl = document.getElementById('batchCount');
      const batchDeleteBtn = document.getElementById('batchDeleteBtn');
      const batchClearBtn = document.getElementById('batchClearBtn');
      const selectAllCheck = document.getElementById('selectAllCheck');

      function getCheckedUrls() {
        return Array.from(document.querySelectorAll('.card-check:checked')).map(function (c) { return c.getAttribute('data-check'); });
      }
      function getVisibleChecks() {
        return getFilteredCards()
          .slice((currentPage - 1) * itemsPerPage, currentPage * itemsPerPage)
          .map(function (card) { return card.querySelector('.card-check'); })
          .filter(Boolean);
      }
      function updateBatchUI() {
        if (!batchCountEl) return;
        const n = getCheckedUrls().length;
        batchCountEl.textContent = '已选 ' + n + ' 项';
        if (batchDeleteBtn) batchDeleteBtn.disabled = n === 0;
        const vis = getVisibleChecks();
        const checkedVis = vis.filter(function (c) { return c.checked; }).length;
        if (selectAllCheck) {
          selectAllCheck.checked = vis.length > 0 && checkedVis === vis.length;
          selectAllCheck.indeterminate = checkedVis > 0 && checkedVis < vis.length;
        }
        document.querySelectorAll('.file-card').forEach(function (card) {
          const cb = card.querySelector('.card-check');
          card.classList.toggle('selected', !!(cb && cb.checked));
        });
        syncHideButtons(); // 【补丁⑧】
      }
      document.addEventListener('change', function (e) {
        if (e.target && e.target.classList && e.target.classList.contains('card-check')) updateBatchUI();
      });
      if (selectAllCheck) {
        selectAllCheck.addEventListener('change', function () {
          const on = selectAllCheck.checked;
          getVisibleChecks().forEach(function (c) { c.checked = on; });
          updateBatchUI();
        });
      }
      if (batchClearBtn) {
        batchClearBtn.addEventListener('click', function () {
          document.querySelectorAll('.card-check').forEach(function (c) { c.checked = false; });
          updateBatchUI();
        });
      }
      if (batchDeleteBtn) {
        batchDeleteBtn.addEventListener('click', async function () {
          const urls = getCheckedUrls();
          if (urls.length === 0) return;
          const okConfirm = await showConfirm('确定要删除选中的 ' + urls.length + ' 个文件吗？此操作不可撤销。', '批量删除确认');
          if (!okConfirm) return;
          const original = batchDeleteBtn.innerHTML;
          batchDeleteBtn.disabled = true;
          batchDeleteBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 删除中...';
          try {
            const resp = await fetch('/delete-batch', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ urls: urls })
            });
            const data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '批量删除失败');
            const okSet = {};
            (data.results || []).forEach(function (r) { if (r.ok) okSet[r.url] = true; });
            document.querySelectorAll('.file-card').forEach(function (card) {
              if (okSet[card.getAttribute('data-url')]) card.remove();
            });
            fileCards = Array.from(fileGrid.children);
            renderPage(currentPage);
            updateBatchUI();
            const failList = (data.results || []).filter(function (r) { return !r.ok; });
            await showAlert('批量删除完成：成功 ' + data.deleted + ' / ' + data.total + ' 个' + (failList.length ? '（失败 ' + failList.length + ' 个，详见控制台）' : ''), '批量删除', failList.length ? 'warning' : 'success');
            if (failList.length) console.warn('批量删除失败明细:', failList);
          } catch (err) {
            await showAlert('批量删除失败: ' + err.message, '删除失败', 'error');
          } finally {
            batchDeleteBtn.innerHTML = original;
            updateBatchUI();
          }
        });
      }
      // -------------------- 【补丁⑧】隐藏 / 取消隐藏 --------------------
      function syncHideButtons() {
        const n = getCheckedUrls().length;
        const bh = document.getElementById('batchHideBtn');
        const bu = document.getElementById('batchUnhideBtn');
        if (bh) bh.disabled = n === 0;
        if (bu) bu.disabled = n === 0;
        const bm = document.getElementById('batchMoveBtn'); // 【补丁⑪】移动到文件夹
        if (bm) bm.disabled = n === 0;
      }
      async function doHide(urls, hidden) {
        try {
          const resp = await fetch('/hide', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ urls: urls, hidden: hidden })
          });
          const data = await resp.json();
          if (!resp.ok) throw new Error(data.error || '操作失败');
          return data;
        } catch (e) {
          await showAlert('操作失败: ' + e.message, '失败', 'error');
          return null;
        }
      }
      async function hideFile(url, hidden) {
        const card = document.querySelector('.file-card[data-url="' + url + '"]');
        const name = card ? card.querySelector('.file-info div:first-child').textContent : '此文件';
        const ok = await showConfirm((hidden ? '确定要隐藏 ' : '确定要取消隐藏 ') + name + ' 吗？隐藏后链接依然有效，只是不在列表里显示。', hidden ? '隐藏确认' : '取消隐藏确认');
        if (!ok) return;
        const r = await doHide([url], hidden);
        if (!r) return;
        if (hidden && card) {
          card.remove();
          fileCards = Array.from(fileGrid.children);
          renderPage(currentPage);
        } else if (!hidden && card) {
          card.classList.remove('is-hidden');
          const b = card.querySelector('.hidden-badge');
          if (b) b.remove();
        }
        updateBatchUI();
        await showAlert(hidden ? (name + ' 已隐藏（链接仍然有效）') : (name + ' 已取消隐藏'), hidden ? '已隐藏' : '已取消隐藏', 'success');
      }
      function bindHideBatch(btnId, hidden) {
        const btn = document.getElementById(btnId);
        if (!btn) return;
        btn.addEventListener('click', async function () {
          const urls = getCheckedUrls();
          if (urls.length === 0) return;
          const tip = hidden ? '确定要隐藏选中的 ' + urls.length + ' 个文件吗？隐藏后链接依然有效，只是不在列表里显示。' : '确定要取消隐藏选中的 ' + urls.length + ' 个文件吗？';
          if (!(await showConfirm(tip, hidden ? '批量隐藏' : '批量取消隐藏'))) return;
          const r = await doHide(urls, hidden);
          if (!r) return;
          if (hidden) {
            document.querySelectorAll('.file-card').forEach(function (card) {
              if (urls.indexOf(card.getAttribute('data-url')) !== -1) card.remove();
            });
            fileCards = Array.from(fileGrid.children);
            renderPage(currentPage);
          } else {
            document.querySelectorAll('.file-card').forEach(function (card) {
              if (urls.indexOf(card.getAttribute('data-url')) !== -1) {
                card.classList.remove('is-hidden');
                const b = card.querySelector('.hidden-badge');
                if (b) b.remove();
              }
            });
          }
          updateBatchUI();
          await showAlert((hidden ? '已隐藏 ' : '已取消隐藏 ') + r.changed + ' / ' + r.total + ' 个', hidden ? '批量隐藏' : '批量取消隐藏', 'success');
        });
      }
      bindHideBatch('batchHideBtn', true);
      bindHideBatch('batchUnhideBtn', false);

      // -------------------- 【补丁⑪】文件夹：新建 / 改名 / 删除 / 批量移动 --------------------
      // 带输入框的弹窗（复用页面已有的 modal 样式）
      function promptModal(title, defaultValue, placeholder) {
        return new Promise(function (resolve) {
          var overlay = document.getElementById('folderPrompt');
          if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'folderPrompt';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = '<div class="modal-box">' +
              '<div class="modal-icon info fas fa-folder"></div>' +
              '<div class="modal-title"></div>' +
              '<input type="text" class="fp-input" style="width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(0,0,0,.15);font-size:14px;margin-bottom:18px;box-sizing:border-box;">' +
              '<div class="modal-btns"></div></div>';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', function (e) {
              if (e.target === overlay) { overlay.classList.remove('show'); resolve(null); }
            });
          }
          overlay.querySelector('.modal-title').textContent = title;
          var input = overlay.querySelector('.fp-input');
          input.value = defaultValue || '';
          input.placeholder = placeholder || '';
          var close = function (val) { overlay.classList.remove('show'); resolve(val); };
          var btnBox = overlay.querySelector('.modal-btns');
          btnBox.innerHTML = '';
          var cancel = document.createElement('button');
          cancel.textContent = '取消';
          cancel.className = 'modal-btn secondary';
          cancel.onclick = function () { close(null); };
          btnBox.appendChild(cancel);
          var okBtn = document.createElement('button');
          okBtn.textContent = '确定';
          okBtn.className = 'modal-btn';
          okBtn.onclick = function () { close(input.value); };
          btnBox.appendChild(okBtn);
          input.onkeydown = function (e) {
            if (e.key === 'Enter') close(input.value);
            if (e.key === 'Escape') close(null);
          };
          overlay.classList.add('show');
          setTimeout(function () { input.focus(); input.select(); }, 60);
        });
      }

      async function folderAction(payload) {
        try {
          var resp = await fetch('/folders', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
          var data = await resp.json();
          if (!resp.ok) throw new Error(data.error || '操作失败');
          return data;
        } catch (e) {
          await showAlert('操作失败: ' + e.message, '失败', 'error');
          return null;
        }
      }

      async function createFolder() {
        var p = await promptModal('新建文件夹', '', '例如：旅行 或 文章/2026/11');
        if (p === null || p === undefined) return;
        p = String(p).trim();
        if (!p) return;
        var d = await folderAction({ action: 'create', path: p });
        if (!d) return;
        await showAlert('文件夹「' + d.path + '」创建好了', '创建成功', 'success');
        location.reload();
      }

      async function renameFolder(path) {
        var p = await promptModal('重命名文件夹：' + path, path, '新的名字（可以用 / 分层）');
        if (p === null || p === undefined) return;
        p = String(p).trim();
        if (!p || p === path) return;
        if (!(await showConfirm('确定把「' + path + '」改名为「' + p + '」吗？里面的图片链接会一起更新，老链接自动跳转，已发布的文章不会挂。', '重命名确认'))) return;
        var d = await folderAction({ action: 'rename', old: path, new: p });
        if (!d) return;
        var failed = (d.failed || []).length;
        await showAlert('重命名完成：跟着改了 ' + d.files + ' 个图片链接' + (failed ? '（有 ' + failed + ' 个因目标重名被跳过）' : ''), '重命名完成', failed ? 'warning' : 'success');
        location.href = '/admin?folder=' + encodeURIComponent(d.new);
      }

      async function deleteFolder(path) {
        if (!(await showConfirm('确定删除文件夹「' + path + '」吗？里面的图片不会被删，会自动回到「未分类」，老链接自动跳转。', '删除文件夹'))) return;
        var d = await folderAction({ action: 'delete', path: path });
        if (!d) return;
        await showAlert('文件夹「' + d.deleted + '」已删除：' + d.files + ' 个图片回到了「未分类」', '已删除', 'success');
        location.href = '/admin?folder=';
      }

      var batchMoveBtn = document.getElementById('batchMoveBtn');
      if (batchMoveBtn) {
        batchMoveBtn.addEventListener('click', async function () {
          var urls = getCheckedUrls();
          if (urls.length === 0) return;
          var sel = document.getElementById('moveSelect');
          var target = sel ? sel.value : '';
          var label = target ? '「' + target + '」' : '「未分类」';
          if (!(await showConfirm('确定把选中的 ' + urls.length + ' 个图片移动到 ' + label + ' 吗？', '移动确认'))) return;
          var original = batchMoveBtn.innerHTML;
          batchMoveBtn.disabled = true;
          batchMoveBtn.innerHTML = '<i class="fas fa-spinner fa-spin"></i> 移动中...';
          try {
            var resp = await fetch('/move-files', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ urls: urls, folder: target }) });
            var data = await resp.json();
            if (!resp.ok) throw new Error(data.error || '移动失败');
            var fails = (data.results || []).filter(function (x) { return !x.ok; });
            if (fails.length) console.warn('移动失败明细:', fails);
            await showAlert('移动完成：成功 ' + data.moved + ' / ' + data.total + ' 个' + (fails.length ? '，失败 ' + fails.length + ' 个（多半是目标文件夹里有同名文件）' : ''), '移动完成', fails.length ? 'warning' : 'success');
            location.href = '/admin?folder=' + encodeURIComponent(target);
          } catch (e) {
            await showAlert('移动失败: ' + e.message, '失败', 'error');
            batchMoveBtn.innerHTML = original;
            updateBatchUI();
          }
        });
      }

      // -------------------- 初始渲染 --------------------
      renderPage(currentPage);

      // -------------------- 文本预览懒加载 --------------------
      async function loadTextPreview(el) {
        const url = el.dataset.url;
        if (!url || el.classList.contains('loaded')) return;
        try {
          const resp = await fetch(url);
          const text = await resp.text();
          const truncated = text.length > 500 ? text.slice(0, 500) + '…' : text;
          el.innerHTML = '<pre>' + escapeHtml(truncated) + '</pre>';
          el.classList.add('loaded');
        } catch { el.classList.add('loaded'); }
      }
      function escapeHtml(s) {
        return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
      }
      function observeTextPreviews() {
        document.querySelectorAll('.text-preview:not(.loaded)').forEach(el => loadTextPreview(el));
      }
      // 首次加载
      observeTextPreviews();
      // 翻页后重新扫描
      const origRenderPage = renderPage;
      renderPage = function(page) { origRenderPage(page); setTimeout(observeTextPreviews, 100); };

      // ---------- 通用模态框 ----------
      function showModal({icon='success', title='', msg='', btns=null}) {
        return new Promise(resolve => {
          let overlay = document.getElementById('globalModal');
          if (!overlay) {
            overlay = document.createElement('div');
            overlay.id = 'globalModal';
            overlay.className = 'modal-overlay';
            overlay.innerHTML = '<div class="modal-box"><div class="modal-icon"></div><div class="modal-title"></div><div class="modal-msg"></div><div class="modal-btns"></div></div>';
            document.body.appendChild(overlay);
            overlay.addEventListener('click', e => { if (e.target === overlay) { overlay.classList.remove('show'); resolve(false); } });
          }
          const iconMap = { success:'fa-circle-check', error:'fa-circle-xmark', warning:'fa-triangle-exclamation', info:'fa-circle-info' };
          overlay.querySelector('.modal-icon').className = 'modal-icon ' + icon + ' fas ' + (iconMap[icon]||'fa-circle-info');
          overlay.querySelector('.modal-title').textContent = title;
          overlay.querySelector('.modal-msg').textContent = msg;
          const btnBox = overlay.querySelector('.modal-btns'); btnBox.innerHTML = '';
          const list = btns || [{text:'确定', type:'primary'}];
          list.forEach(b => {
            const btn = document.createElement('button');
            btn.textContent = b.text;
            btn.className = 'modal-btn' + (b.type==='secondary' ? ' secondary' : (b.type==='danger' ? ' danger' : ''));
            btn.onclick = () => { overlay.classList.remove('show'); resolve(b.value !== undefined ? b.value : true); };
            btnBox.appendChild(btn);
          });
          overlay.classList.add('show');
        });
      }
      async function showAlert(msg, title='提示', icon='info') { await showModal({icon, title, msg}); }
      async function showConfirm(msg, title='确认', icon='warning') {
        return await showModal({icon, title, msg, btns:[{text:'取消', type:'secondary', value:false},{text:'确定', type:'primary', value:true}]});
      }

    </script>
  </body>
  </html>`;
}
