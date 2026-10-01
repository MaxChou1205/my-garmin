# my-garmin

把 `.fit` 檔傳給 Telegram bot，自動匯入 Garmin Connect 帳號。

跑在 Cloudflare Worker 上。已上線運作中。

---

## 1. 運作方式

```
Telegram ──webhook──> Cloudflare Worker  (src/worker.ts)
                          │
                          ├─ 驗 X-Telegram-Bot-Api-Secret-Token  ─┐ 不過就
                          ├─ 驗 message.from.id 在白名單          ─┘ 直接擋掉
                          ├─ 驗 file_name 以 .fit 結尾
                          ├─ 立即回 200
                          └─ ctx.waitUntil(
                                getFile(file_id)
                                → 下載 api.telegram.org/file/bot<TOKEN>/<path>
                                → 驗 .FIT magic                    ─┐
                                → KV 取 token（沒有就 login()）      ├ src/garmin.ts
                                → POST upload-service/upload/.fit  ─┘
                                → sendMessage 回報結果
                             )
```

幾個刻意的選擇：

- **一律回 200。** Telegram 對非 2xx 會重送，重送等於同一筆活動再上傳一次。錯誤靠 `sendMessage` 回報，不靠 HTTP status。
- **兩層驗證。** secret header 只證明請求來自 Telegram，不證明來自你本人；任何人找到這個 bot 都能對它說話，所以還要比對 `from.id`。
- **失敗不重試**，把真正的錯誤訊息回報給使用者。

限制：Telegram bot 下載檔案上限 20MB；webhook 必須是 HTTPS，port 只能 443/80/88/8443。

---

## 2. 為什麼要走非官方 API

Garmin **官方 API 沒有上傳活動的端點**。Activity API / Health API 都是唯讀的，只能把資料從 Garmin 拉出來，不能推進去。要程式化上傳只剩模擬網頁登入拿 OAuth token，再打 `connectapi.garmin.com` 的內部端點。

代價是登入靠爬 HTML 正則。Garmin 隨時可以改登入頁或加強 Cloudflare 規則，這條路就斷了——這不是能修掉的東西，只能接受並準備好它哪天會壞。`npm run smoke` 是提早發現的方法。

（`garth` 這類同性質專案已於 2026-03-27 標記棄用，原因就是 Garmin 在 2026 年 3 月中於 Cloudflare 層擋掉自動化 SSO。目前 Cloudflare Workers 的 egress 沒被擋。）

### 登入流程

五個 HTTP 往返，其中兩步靠爬 HTML：

```
1. GET  sso.garmin.com/sso/embed              → 種下 3 個 cookie（含 __cf_bm）
2. GET  sso.garmin.com/sso/signin             → 爬出 _csrf，種下 SESSION cookie
3. POST sso.garmin.com/sso/signin             → 爬出 ticket=ST-...
4. GET  connectapi.garmin.com/oauth-service/oauth/preauthorized     → OAuth1 token
5. POST connectapi.garmin.com/oauth-service/oauth/exchange/user/2.0 → OAuth2 bearer
```

### 上傳

```
POST https://connectapi.garmin.com/upload-service/upload/.fit
Authorization: Bearer <oauth2.access_token>
Content-Type: multipart/form-data（boundary 由 FormData 自動產生）

欄位名固定是 userfile
```

回應碼：`200`/`201`/`202` 成功，`409` 重複活動，`415` 檔案內容不是合法 FIT。

### Token 策略

只存 `access_token` 進 KV，TTL 設成 `expires_in` 減 10 分鐘（實測 access token 約 21 小時）。過期就重登，不走 refresh token——一天登入一次的成本（3.3~4.3 秒）不值得為它多維護一套 OAuth1 簽章邏輯。

上傳收到 `401` 會強制重登再試一次，涵蓋 Garmin 提早作廢 token 的情況（例如改密碼）。

---

## 3. workerd 上的四個地雷

`@flow-js/garmin-connect` 是為 Node 寫的，Cloudflare Workers 跑的是 workerd。**動 `src/garmin.ts` 之前先看這節**——每一項的失敗訊息都會把人帶往錯誤的方向。

### 3.1 `app-root-path` 在載入時就炸掉

`GarminConnect.js` 在 module load 階段執行 `appRoot.require('/garmin.config.json')` 想讀選用設定檔。workerd 上沒有專案根目錄，`app-root-path` 的 browser shim 會在讀 `require.main.filename` 時丟 `TypeError: Cannot read properties of undefined (reading 'filename')`，整個 Worker 起不來。

**修法**：`wrangler.toml` 的 `[alias]` 把它導到 `src/app-root-path-stub.ts`，stub 直接 throw。呼叫端本來就包了 try/catch 並 fallback 成 `config = undefined`，而我們是用建構子傳帳密，所以 throw 才是正確行為。

### 3.2 SSO 登入的 POST body 送出去是壞的

套件用 `form-data`（multipart stream）組登入 body，卻手動把 header 覆寫成 `application/x-www-form-urlencoded`。Node 上 axios 對 form-data stream 有特例處理、Garmin 也容忍這個矛盾；workerd 沒有那個特例，body 送出去 Garmin 解不出來，回 `{"type":"undefined"}` 然後報 **`Ticket not found or MFA`**——那個訊息跟真正的原因毫無關係。

**修法**：`fixSsoFormEncoding()` 攔截 `/sso/signin` 的 POST，自己用 `URLSearchParams` 重組 body 並補正 Content-Type。

### 3.3 套件完全不處理 cookie

整包 dist grep `cookie` 一個字都沒有。Garmin 的 Spring Security 把 `_csrf` 綁在第 2 步種下的 `SESSION` cookie 上，第 3 步不帶回去就驗不過。症狀跟 3.2 一模一樣。

**修法**：`attachCookieJar()` 用 axios interceptor 掛一個 `Map` 當 cookie jar。

> 3.2 和 3.3 是一起修好的，**沒有隔離出哪一個是決定性的**。兩個都是真缺陷，兩個都留著。

### 3.4 `uploadActivity()` 不能用

`gc.uploadActivity(path, format)` 有兩個問題：用 `form-data` 套件（在 workerd 上會 bundle 成 browser shim，沒有 `getHeaders()`，直接 `TypeError`），而且只吃檔案路徑、內部用 `fs.createReadStream`。

**修法**：`src/garmin.ts` 的 `post()` 繞過套件，直接用原生 `fetch` + `FormData` + `Blob` 打那一個端點。

⚠️ 用原生 `FormData` 時**絕對不要手動設 `Content-Type`**，boundary 是 FormData 自己產的，手寫的 header 對不上 body。

---

## 4. 設定

### 環境變數

| 變數 | 放哪 | 說明 |
|------|------|------|
| `GARMIN_USERNAME` | secret | Garmin 帳號 |
| `GARMIN_PASSWORD` | secret | Garmin 密碼 |
| `TELEGRAM_BOT_TOKEN` | secret | BotFather 給的 |
| `TELEGRAM_SECRET` | secret | 自己編的隨機字串，要和 `setWebhook` 的 `secret_token` 一致 |
| `TELEGRAM_ALLOWED_IDS` | secret | 允許上傳的 Telegram user id，逗號分隔 |
| `GARMIN_CONSUMER_KEY` | `wrangler.toml [vars]` | Garmin 公開的 OAuth consumer key，非機密 |
| `GARMIN_CONSUMER_SECRET` | `wrangler.toml [vars]` | 同上，名字叫 secret 但它是公開值 |

`TELEGRAM_SECRET` 和 `TELEGRAM_ALLOWED_IDS` 任一沒設，Worker 直接回 500 不服務。這是刻意的——這個端點對全世界開放且握有 Garmin 帳密。

consumer key/secret 是 2026-08-14 從 `thegarth.s3.amazonaws.com/oauth_consumer.json` 抄下來的快照。硬編是刻意的：那個 bucket 屬於已棄用的專案，卻卡在 token 的關鍵路徑上。

本機開發放 `.dev.vars`（已 gitignore，範本見 `.dev.vars.example`），部署用 `npx wrangler secret put <NAME>`。

### 從零建起來

```bash
npx wrangler kv namespace create GARMIN_TOKENS
```

把印出來的 id 填進 `wrangler.toml` 的 `[[kv_namespaces]]`，然後：

```bash
npm run deploy
```

五個 secret 各 `npx wrangler secret put` 一次（會自己觸發新版本，不用再 deploy）。user id 用 [@userinfobot](https://t.me/userinfobot) 查。

最後註冊 webhook。**用 PowerShell 原生指令，別用 curl**——PowerShell 會把 `-d "{\"url\":...}"` 的跳脫吃掉，curl 還會把 `["message"]` 當成 glob range：

```powershell
Invoke-RestMethod -Method Post -Uri "https://api.telegram.org/bot<TOKEN>/setWebhook" -ContentType "application/json" -Body (@{ url = "https://my-garmin.<subdomain>.workers.dev"; secret_token = "<SECRET>"; allowed_updates = @("message") } | ConvertTo-Json)
```

成功的 `description` 是 `Webhook was set`。

---

## 5. 指令

```bash
npm run dev      # 本機 wrangler dev，port 8787
npm run deploy   # 部署
npm run tail     # 看即時 log 和 CPU time
```

```bash
npm run smoke -- path/to/activity.fit
```

`src/smoke.ts` 用 Bun 跑 `src/garmin.ts` 的真實程式碼路徑（in-memory 假 KV），對真的 Garmin 帳號上傳同一個檔兩次：第一次應該成功，第二次應該回 duplicate。Garmin 改登入頁的話會在這裡先炸，而不是在 bot 裡默默壞掉。**這會真的寫進你的 Garmin 帳號。**

出問題時先跑 smoke：它不經過 Telegram，能立刻分辨是 Garmin 那半邊壞了還是 Telegram 那半邊。

---

## 6. 疑難排解

**bot 完全沒反應** — 先看 webhook 有沒有真的註冊上：

```powershell
Invoke-RestMethod "https://api.telegram.org/bot<TOKEN>/getWebhookInfo" | ConvertTo-Json
```

`url` 空字串就是沒設成。`last_error_message` 有值就照著查。注意 `"Webhook is already deleted"` 是 **deleteWebhook** 的回應，不是 setWebhook 的——看到這句代表打錯 endpoint 了。

**bot 收到檔案但沒回話** — `npm run tail` 開著再傳一次。`from.id` 不在白名單時 Worker 會靜靜丟掉，這是設計如此，tail 裡看得到請求進來但沒有後續。

**傳了檔案卻說不是 .fit** — Telegram 要以「檔案 / document」方式傳送。用照片或「壓縮傳送」會變成別的型別，`message.document` 是空的。

**改了 `.dev.vars` 但沒生效** — `wrangler dev` 只熱更新原始碼，環境變數要重啟。

**`Ticket not found or MFA`** — 看第 3.2 / 3.3 節，這個訊息幾乎從來不是它字面上的意思。

---

## 7. 已知限制

- **CPU 時間沒量過。** 免費方案上限 10ms，付費方案 30s。登入的 3~4 秒是 wall clock 不是 CPU time，兩者差很多，但沒實際量過就是不知道。`npm run tail` 傳一個檔就有數字。
- **登入靠爬 HTML 正則**，Garmin 改版就會壞。見第 2 節。
- **沒有重試機制**，失敗就是失敗，重傳一次檔案即可。
- **20MB 上限**，來自 Telegram Bot API，不是這個 Worker。

---

## 8. 檔案

```
src/worker.ts              Telegram webhook：驗證、回 200、waitUntil 背景處理
src/garmin.ts              登入、KV token 快取、上傳。workerd 的四個修法都在這
src/app-root-path-stub.ts  讓 app-root-path 安全爆掉的 stub
src/smoke.ts               冒煙測試，Bun 跑真實程式碼路徑
src/export.ts              把全部 Garmin 活動匯出成 .fit（給 Strava 手動匯入）
wrangler.toml              含 [alias]、KV binding、[vars]
.dev.vars                  本機祕密（gitignored）
.dev.vars.example          範本
```


---

## 9. 匯出全部活動成 .fit

```bash
npm run export             # 存到 export/
npm run export -- D:\fit   # 指定資料夾
```

`src/export.ts` 用 `src/garmin.ts` 的 `accessToken()` 登入，分頁列出全部活動，逐筆下載原始檔。Garmin 給的是只包一個 .fit 的 zip，程式會解開後存成 `YYYY-MM-DD_HHMM_<activityId>.fit`。

- **可以中斷後再跑。** 資料夾裡已經有的檔案會直接跳過。
- **手動輸入的活動沒有原始檔**，會顯示 `❌ Garmin 下載 404`，結束時列在失敗清單裡。
- `export/` 已加進 gitignore。

匯入 Strava：到 https://www.strava.com/upload/select 上傳，**一次最多 25 個檔**，每個檔最多 25MB。重複的活動 Strava 會自己擋掉。
