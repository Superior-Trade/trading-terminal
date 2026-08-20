"use client";

import {
  createContext,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { useServerPrefs } from "./server-prefs";

export type Lang = "en" | "zh";

const DICT: Record<string, { en: string; zh: string }> = {
  balance: { en: "Balance", zh: "餘額" },
  deposit: { en: "Deposit", zh: "入金" },
  // Rate-limit near-cap banner.
  rlRouteChat: { en: "AI chat / detect", zh: "AI 對話 / 偵測" },
  rlRouteCompile: { en: "strategy builds", zh: "策略編譯" },
  rlNearCap: {
    en: "{n} of {limit} {route} left today",
    zh: "今日 {route} 剩餘 {n}/{limit}",
  },
  rlAtCap: {
    en: "Daily {route} limit reached",
    zh: "已達每日 {route} 上限",
  },
  rlResetsAt: { en: "resets {time}", zh: "{time} 重置" },
  rlResetsSoon: { en: "resets shortly", zh: "即將重置" },
  // AI credits row in the account dropdown — launch week is unlimited: the
  // 1,000 base allotment is shown struck-through next to an ∞.
  credits: { en: "AI Credits", zh: "AI 額度" },
  creditsUnlimited: { en: "Unlimited", zh: "無限" },
  creditsTip: {
    en: "Unlimited usage — free for launch week",
    zh: "無限使用 — 上線首週免費",
  },
  tabDetected: { en: "Draft Setups", zh: "草稿策略" },
  tabRunning: { en: "Running Setups", zh: "運行中的策略" },
  setupsSheet: { en: "Setups", zh: "策略" },
  detect: { en: "Detect setups", zh: "偵測策略" },
  readingChart: { en: "Reading chart…", zh: "讀取圖表中…" },
  markOnChart: { en: "Mark on chart", zh: "標記到圖表" },
  marked: { en: "✓ Marked · click to clear", zh: "✓ 已標記 · 點擊清除" },
  entry: { en: "ENTRY", zh: "進場" },
  stop: { en: "STOP", zh: "止損" },
  target: { en: "TARGET", zh: "目標" },
  drawHint: {
    en: "Draw your thesis on the chart, then hit Detect — the agent reads your drawings + indicators and proposes multiple plans.",
    zh: "在圖表上畫出你的想法，然後按「偵測」— AI 會讀取你的繪圖與指標，提出多個交易計畫。",
  },
  detectingChartHint: { en: "Agent detecting…", zh: "AI 偵測中…" },
  nothingRunning: {
    en: "Nothing running — detect a setup and deploy a plan to get started.",
    zh: "目前沒有運行中的策略 — 先偵測策略並部署一個計畫。",
  },
  draftEmptyTitle: { en: "No setups yet", zh: "尚無交易設定" },
  runningEmptyTitle: { en: "Nothing running yet", zh: "沒有運行中的策略" },
  runningEmptyBody: {
    en: "Detect a setup and deploy a plan — running strategies show up here.",
    zh: "先偵測策略並部署計畫 — 運行中的策略會顯示在這裡。",
  },
  loading: { en: "loading…", zh: "載入中…" },
  placeholder: {
    en: "Ask about this chart, or describe a strategy…",
    zh: "詢問這張圖表，或描述一個策略…",
  },
  welcome: {
    en: "I can see your chart — indicators, timeframe, and anything you draw. Ask me to read a setup, mark levels, or turn your drawings into a strategy you can deploy.",
    zh: "我能看到你的圖表 — 指標、時間週期，以及你畫的任何東西。可以請我解讀盤勢、標記價位，或把你的繪圖變成可部署的策略。",
  },
  // De-branded: the underlying model changes (currently Gemini 3.5 Flash);
  // the product name is what users should see.
  superiorAI: { en: "Superior AI", zh: "Superior AI" },
  chatReading: { en: "reading chart", zh: "讀取圖表中" },
  clearAll: { en: "clear all", zh: "全部清除" },
  toolBrush: { en: "Brush", zh: "畫筆" },
  toolTrendline: { en: "Trendline", zh: "趨勢線" },
  toolHLine: { en: "Horizontal line", zh: "水平線" },
  toolRay: { en: "Ray", zh: "射線" },
  toolRect: { en: "Rectangle", zh: "矩形" },
  toolFib: { en: "Fib retracement", zh: "斐波那契回撤" },
  toolPick: { en: "Choose drawing tool", zh: "選擇繪圖工具" },
  autoStops: { en: "Auto-stops", zh: "自動停止於" },
  oneShot: { en: "One-shot", zh: "單次" },
  // 重複 pairs naturally with 單次 (once vs repeatedly) — 循環 read as a
  // mechanical "loop" and didn't convey re-entering on each trigger.
  recurring: { en: "Recurring", zh: "重複" },
  oneShotTip: {
    en: "Fires once — enters, hits target or stop, then the deployment auto-stops.",
    zh: "單次執行 — 進場後觸及目標或止損即自動停止部署。",
  },
  recurringTip: {
    en: "Keeps re-entering every time the setup triggers again.",
    zh: "每次條件再次觸發時都會重新進場。",
  },
  contextLabel: { en: "context", zh: "上下文" },
  detectProcessingCard: {
    en: "Detecting setups — reading your chart…",
    zh: "偵測策略中 — 正在解讀你的圖表…",
  },
  seeRunning: { en: "See running setups →", zh: "查看運行中的策略 →" },
  // Native bracket orders (entry + TP/SL resting on Hyperliquid, no bot).
  // USER-FACING NAME: "direct order" / 直接下單 — "bracket" is internal jargon.
  bracketSection: { en: "Direct orders", zh: "直接下單（含止盈/止損）" },
  bracketOrder: { en: "direct order", zh: "直接訂單" },
  bracketCancel: { en: "Cancel order", zh: "取消訂單" },
  bracketPlacing: { en: "placing order on Hyperliquid…", zh: "正在 Hyperliquid 下單…" },
  bracketPlacedNote: {
    en: "Direct order placed for {title} on {account}: entry, take-profit and stop-loss now rest directly on Hyperliquid — no bot needed.",
    zh: "已為 {title} 在 {account} 直接下單：進場、止盈與止損現已直接掛於 Hyperliquid — 無需機器人。",
  },
  detectBlocked: {
    en: "Detecting setups… chat unlocks when it finishes",
    zh: "正在偵測策略…完成後即可繼續對話",
  },
  paBadge: { en: "Price action only", zh: "純價格行為" },
  paNudge: {
    en: "Clean chart — these setups read pure price action. Mark your levels or add an indicator, then re-run for tighter plans.",
    zh: "目前是空白圖表——這些交易計畫僅根據價格行為判讀。畫出關鍵價位或加上指標後重新偵測，計畫會更精準。",
  },
  indUsedChip: { en: "used {used} of {total} indicators", zh: "採用 {total} 個指標中的 {used} 個" },
  rerunAll: { en: "re-run with all {total}", zh: "以全部 {total} 個重新偵測" },
  pnlCardBtn: { en: "share pnl", zh: "分享收益" },
  confirmExitTitle: { en: "Close positions?", zh: "確認平倉？" },
  confirmExitBody: {
    en: "Exit market-closes every open position this strategy holds, at the current price, and realizes the PnL. The bot keeps running unless you also stop it. This cannot be undone.",
    zh: "「平倉」會以市價立即關閉此策略持有的所有倉位並實現損益。機器人本身仍會繼續運行（除非另外按停止）。此操作無法復原。",
  },
  // Conversation list / switch.
  deploySafetyRejectLead: {
    en: "This setup didn't pass the safety checks:",
    zh: "此策略未通過安全檢查：",
  },
  deploySafetyRejectMore: {
    en: "(+{n} more)",
    zh: "（另有 {n} 項）",
  },
  convListTitle: { en: "Recent chats", zh: "最近的對話" },
  convListHint: {
    en: "Pick one, or type /switch <number>",
    zh: "點選一項，或輸入 /switch <編號>",
  },
  convListEmpty: {
    en: "No other chats yet — this is your first.",
    zh: "尚無其他對話 — 這是第一個。",
  },
  convListCurrent: { en: "current", zh: "目前" },
  convListPrev: { en: "Previous page", zh: "上一頁" },
  convListNext: { en: "Next page", zh: "下一頁" },
  convListOpen: { en: "Recent chats", zh: "最近的對話" },
  convNew: { en: "New chat", zh: "新對話" },
  convSwitched: {
    en: "Switched to “{title}”.",
    zh: "已切換至「{title}」。",
  },
  convSwitchNoIndex: {
    en: "There's no chat {n}. Run /list to see the numbers.",
    zh: "沒有編號 {n} 的對話。輸入 /list 查看編號。",
  },
  convSwitchUsage: {
    en: "Use /switch <number> — run /list to see the numbers.",
    zh: "用法：/switch <編號> — 輸入 /list 查看編號。",
  },
  confirmStopTitle: { en: "Stop this setup?", zh: "確認停止此策略？" },
  confirmStopBody: {
    en: "Stopping market-closes every open position this strategy holds, at the current price, and realizes the PnL. The setup stays in your list and can be restarted, but the positions do not come back.",
    zh: "「停止」會以市價立即關閉此策略持有的所有倉位並實現損益。策略本身會保留在清單中並可重新啟動，但已平倉的部位不會恢復。",
  },
  confirmDeleteTitle: { en: "Delete deployment?", zh: "確認刪除？" },
  inboxTitle: { en: "Inbox", zh: "通知" },
  notifyLabel: { en: "alerts", zh: "推送" },
  notifyOnTip: { en: "Turn on browser notifications", zh: "開啟瀏覽器通知" },
  notifyOffTip: { en: "Turn off browser notifications", zh: "關閉瀏覽器通知" },
  notifyBlocked: {
    en: "Notifications blocked — enable them in your browser's site settings",
    zh: "通知已被封鎖 — 請在瀏覽器網站設定中開啟",
  },
  bareDetectTitle: { en: "Detect on a bare chart?", zh: "在空白圖表上偵測？" },
  bareDetectBody: {
    en: "Nothing is drawn and no indicators are on. Detection will read pure price action, volume, open interest and funding — solid, but plans get sharper when you mark your levels or add indicators first.",
    zh: "圖表上沒有繪圖也沒有指標。偵測將僅根據價格行為、成交量、未平倉量與資金費率判讀——可行，但先畫出關鍵價位或加上指標，計畫會更精準。",
  },
  bareDetectGo: { en: "Detect anyway", zh: "直接偵測" },
  expiredWarnTitle: { en: "This setup has expired", zh: "此策略已過期" },
  expiredWarnBody: {
    en: "Its entry, stop and target are stale. Deploying now can fill instantly at a price the plan never intended.",
    zh: "進場、止損與目標價位皆已過時。現在部署可能立即在計畫從未設想的價位成交。",
  },
  expiredWarnGo: { en: "Deploy anyway", zh: "仍要部署" },
  ofTitle: { en: "Order Flow", zh: "訂單流" },
  ofBuys: { en: "buys", zh: "買入" },
  ofSells: { en: "sells", zh: "賣出" },
  ofSince: { en: "live since", zh: "起始於" },
  ofImb: { en: "imbalance", zh: "失衡" },
  inboxEmpty: {
    en: "No inbox yet",
    zh: "尚無通知",
  },
  inboxDepositTitle: { en: "Deposit received", zh: "已收到入金" },
  inboxDepositBody: {
    en: "{amt} USDC received in your Superior wallet — ready to deploy.",
    zh: "已收到 {amt} USDC，已存入您的 Superior 錢包，可隨時部署。",
  },
  inboxWithdrawTitle: { en: "Withdrawal started", zh: "出金已開始" },
  inboxWithdrawBody: {
    en: "{amt} USDC to {addr}.",
    zh: "{amt} USDC 至 {addr}。",
  },
  inboxWithdrawFailTitle: { en: "Withdrawal failed", zh: "出金失敗" },
  inboxWithdrawFailBody: {
    en: "Your funds were not sent. Please try again.",
    zh: "您的資金未送出，請再試一次。",
  },
  confirmDeleteBody: {
    en: "Delete removes this deployment and frees its wallet. Its history stays in your records, but the deployment itself cannot be restored.",
    zh: "「刪除」會移除此部署並釋放其錢包。歷史紀錄仍會保留，但部署本身無法還原。",
  },
  pnlCardTitle: { en: "PnL card", zh: "收益卡片" },
  pnlCardDownload: { en: "Download", zh: "下載" },
  pnlCardShare: { en: "Share", zh: "分享" },
  pnlCardUpload: { en: "upload bg", zh: "上傳背景" },
  pnlCardBgNote: {
    en: "Background images stay in your browser — never uploaded.",
    zh: "背景圖片只儲存在你的瀏覽器，不會上傳。",
  },
  contextTip: {
    en: "Share of the model's context window currently in use. Older messages are summarized automatically to keep this low.",
    zh: "目前使用的模型上下文視窗比例。較舊的訊息會自動摘要以保持較低佔用。",
  },
  runBacktest: { en: "▶ Run backtest", zh: "▶ 執行回測" },
  submitting: { en: "Submitting…", zh: "提交中…" },
  earlier: { en: "earlier — click to expand", zh: "則較早訊息 — 點擊展開" },
  skip: { en: "Skip", zh: "跳過" },
  long: { en: "Long", zh: "做多" },
  short: { en: "Short", zh: "做空" },
  neutral: { en: "Neutral", zh: "中性" },
  autoStop: { en: "Auto-stop", zh: "自動停止" },
  depositTitle: {
    en: "Deposit to start trading on Superior Trade",
    zh: "入金，開始在 Superior Trade 交易",
  },
  depositCardTitle: { en: "Card · Stripe", zh: "信用卡 · Stripe" },
  depositCardRate: { en: "Coming soon", zh: "即將推出" },
  // Accurate per Privy × Stripe onramp (Stripe acquired Privy; onramp GA'd
  // via Privy funding): cards + Apple/Google Pay + ACH, US/EU via Stripe,
  // 100+ countries via Privy's aggregator. No fee % — Stripe prices vary.
  depositCardDesc: {
    en: "Buy USDC with card, Apple Pay or Google Pay — powered by Stripe × Privy onramp (US/EU + 100+ countries).",
    zh: "使用信用卡、Apple Pay 或 Google Pay 購買 USDC — 由 Stripe × Privy 入金通道支援（美國/歐盟及 100+ 國家）。",
  },
  depositCryptoTitle: { en: "Crypto · USDC", zh: "加密貨幣 · USDC" },
  depositCryptoRate: { en: "No fee · ~1 min", zh: "免手續費 · 約 1 分鐘" },
  depositHistory: { en: "View deposit history", zh: "查看入金紀錄" },
  copy: { en: "Copy", zh: "複製" },
  depositNetworkWarn: {
    en: "USDC on Arbitrum One only — other assets or chains will be lost",
    zh: "僅限 Arbitrum One 網路的 USDC — 其他資產或鏈上轉入將遺失",
  },
  depositWaiting: { en: "Waiting for USDC…", zh: "等待 USDC 到帳…" },
  depositArrived: {
    en: "≈${amt} received — confirming on-chain…",
    zh: "已收到 ≈${amt} — 正在鏈上確認…",
  },
  depositCredited: {
    en: "≈${amt} received — in your Superior wallet, ready to deploy",
    zh: "已收到 ≈${amt} — 已存入您的 Superior 錢包，可隨時部署",
  },
  depositCreditFailed: {
    en: "≈${amt} received in your Superior wallet.",
    zh: "已收到 ≈${amt}，已存入您的 Superior 錢包。",
  },
  depositFundingProofFailed: {
    en: "Funds are safe, but the sender could not be verified for withdrawals. Use the wallet linked to this account or contact support before withdrawing.",
    zh: "資金已安全到帳，但無法驗證出金錢包。請使用此帳戶已連結的錢包入金，或在出金前聯絡支援。",
  },
  depositInfoError: {
    en: "Couldn't load your deposit address — try again shortly.",
    zh: "無法載入入金地址 — 請稍後再試。",
  },
  depositMinNote: {
    en: "Minimum deposit: {min} USDC",
    zh: "最低入金：{min} USDC",
  },
  depositBelowMin: {
    en: "${amt} received — below the {min} USDC minimum. Send more; amounts accumulate.",
    zh: "已收到 ${amt} — 低於 {min} USDC 最低限額。可再轉入，金額會累計。",
  },
  depositCryptoDesc: {
    en: "Send Arbitrum USDC from your linked wallet so the same wallet can be registered for withdrawals. Network gas only.",
    zh: "請從已連結的錢包轉入 Arbitrum USDC，以便將同一錢包登記為出金錢包，僅需網路 gas 費。",
  },
  withdraw: { en: "Withdraw", zh: "出金" },
  withdrawTitle: { en: "Withdraw USDC", zh: "出金 USDC" },
  withdrawRegisterTitle: {
    en: "Register your withdrawal wallet",
    zh: "登記你的出金錢包",
  },
  withdrawRegisterIntro: {
    en: "Withdrawals will be locked to this wallet. After registration, it cannot be changed in the Terminal.",
    zh: "所有出金將鎖定至此錢包。登記後無法在 Terminal 內更改。",
  },
  withdrawRegisterSafety: {
    en: "Only register a wallet you control and can access long term.",
    zh: "只可登記由你控制並可長期存取的錢包。",
  },
  withdrawRegisterCandidate: {
    en: "Wallet to register",
    zh: "將登記的錢包",
  },
  withdrawRegisterPermanent: {
    en: "Permanent destination",
    zh: "永久目的地",
  },
  withdrawRegisterAcknowledge: {
    en: "I understand this will be my only withdrawal wallet.",
    zh: "我明白這將是我唯一的出金錢包。",
  },
  withdrawRegisterSubmit: {
    en: "Register wallet",
    zh: "登記錢包",
  },
  withdrawRegisterSubmitting: {
    en: "Registering…",
    zh: "登記中…",
  },
  withdrawRegisterFailed: {
    en: "Wallet registration failed. Please try again.",
    zh: "錢包登記失敗，請再試一次。",
  },
  withdrawRegisterUnavailable: {
    en: "No eligible wallet is available. Fund your Superior wallet from the wallet you want to register, then try again.",
    zh: "目前沒有符合資格的錢包。請先從你想登記的錢包向 Superior 錢包入金，然後再試。",
  },
  withdrawRegisterLockedUnavailable: {
    en: "Your registered wallet does not match the wallet currently verified on this account. Withdrawals are blocked.",
    zh: "已登記錢包與此帳戶目前驗證的錢包不符，出金已被封鎖。",
  },
  withdrawAvailable: { en: "Available", zh: "可出金" },
  withdrawMax: { en: "MAX", zh: "全部" },
  withdrawDestLabel: {
    en: "Registered withdrawal wallet",
    zh: "已登記的出金錢包",
  },
  withdrawDestEmbedded: {
    en: "To your Privy wallet (your login identity)",
    zh: "轉至你的 Privy 錢包（你的登入身分）",
  },
  withdrawDestNote: {
    en: "This destination is permanently locked. Funds return through your Superior wallet; email logins also require a one-time code.",
    zh: "此目的地已永久鎖定。資金會先返回你的 Superior 錢包；電郵登入亦需要一次性驗證碼。",
  },
  withdrawFeeNote: {
    en: "USDC on Arbitrum · $1 network fee · arrives in ~5 min",
    zh: "Arbitrum 網路 USDC · $1 網路手續費 · 約 5 分鐘到帳",
  },
  withdrawMinNote: {
    en: "Minimum withdrawal: {min} USDC",
    zh: "最低出金：{min} USDC",
  },
  withdrawSubmit: { en: "Withdraw", zh: "確認出金" },
  withdrawOtpLabel: { en: "Email verification code", zh: "電郵驗證碼" },
  withdrawOtpSent: {
    en: "Sent to {email}",
    zh: "已傳送至 {email}",
  },
  withdrawOtpResend: { en: "Resend", zh: "重新傳送" },
  withdrawOtpSend: { en: "Send verification code", zh: "傳送驗證碼" },
  withdrawOtpInvalid: {
    en: "Enter the 6-digit verification code.",
    zh: "請輸入 6 位數驗證碼。",
  },
  withdrawSubmitting: { en: "Withdrawing…", zh: "出金中…" },
  withdrawDone: {
    en: "≈${amt} is routing through your Superior wallet — usually arrives on Arbitrum in ~5 min",
    zh: "≈${amt} 正經由你的 Superior 錢包轉出 — 通常約 5 分鐘後到達你的 Arbitrum 錢包",
  },
  withdrawNoDest: {
    en: "No login wallet found on this account — log in with a wallet to withdraw.",
    zh: "此帳戶沒有登入錢包 — 請使用錢包登入後再出金。",
  },
  withdrawQuoteError: {
    en: "Couldn't load your withdrawal details — try again shortly.",
    zh: "無法載入出金資訊 — 請稍後再試。",
  },
  withdrawFailed: {
    en: "Withdrawal failed: {detail}",
    zh: "出金失敗：{detail}",
  },
  apiKeysMenu: { en: "API keys", zh: "API 金鑰" },
  apiKeysTitle: { en: "API keys", zh: "API 金鑰" },
  apiKeyLoadFailed: { en: "Couldn't load your keys — try again shortly.", zh: "無法載入金鑰 — 請稍後再試。" },
  apiKeyNamePlaceholder: { en: "New key name", zh: "新金鑰名稱" },
  apiKeyCreate: { en: "Create", zh: "建立" },
  apiKeyCreateFailed: { en: "Couldn't create the key.", zh: "無法建立金鑰。" },
  apiKeyRevealTitle: { en: "Key created — copy it now", zh: "金鑰已建立 — 請立即複製" },
  apiKeyRevealWarn: {
    en: "This is the only time the full key is shown. Store it somewhere safe.",
    zh: "完整金鑰僅顯示這一次，請妥善保存。",
  },
  apiKeyCopy: { en: "Copy", zh: "複製" },
  apiKeyDismiss: { en: "Dismiss", zh: "關閉" },
  apiKeyEmpty: { en: "No API keys yet.", zh: "尚無 API 金鑰。" },
  apiKeyUnnamed: { en: "Unnamed key", zh: "未命名金鑰" },
  apiKeyRename: { en: "Rename", zh: "重新命名" },
  apiKeyRenameFailed: { en: "Couldn't rename the key.", zh: "無法重新命名金鑰。" },
  apiKeyDelete: { en: "Delete", zh: "刪除" },
  apiKeyDeleteConfirm: { en: "Delete this key?", zh: "刪除此金鑰？" },
  apiKeyDeleteFailed: { en: "Couldn't delete the key.", zh: "無法刪除金鑰。" },
  confHigh: { en: "high conf.", zh: "高信心" },
  confMedium: { en: "med conf.", zh: "中信心" },
  confLow: { en: "low conf.", zh: "低信心" },
  confirmDeploy: { en: "Confirm deploy", zh: "確認部署" },
  deploying: { en: "Deploying…", zh: "部署中…" },
  deployStepCompile: { en: "Compiling strategy", zh: "編譯策略中" },
  deployStepCreate: { en: "Creating deployment", zh: "建立部署中" },
  deployStepWallet: { en: "Attaching wallet", zh: "綁定錢包中" },
  deployStepStart: { en: "Starting trading pod", zh: "啟動交易程序中" },
  deployFundingNote: {
    en: "Funding your account — moving USDC into the venue. This can take up to a minute.",
    zh: "正在為帳戶注資 — 將 USDC 轉入交易場。最多可能需要一分鐘。",
  },
  deployedLive: { en: "✓ Deployed · live", zh: "✓ 已部署 · 運行中" },
  retry: { en: "Retry", zh: "重試" },
  deployStop: { en: "Stop", zh: "停止" },
  deployStopping: { en: "Stopping…", zh: "停止中…" },
  // Cancelling waits for the step already in flight to answer, because only
  // its answer says whether anything needs undoing.
  deployStoppingNote: {
    en: "Finishing the current step before stopping — nothing is left half-placed.",
    zh: "正在完成目前步驟後停止 — 不會留下未完成的委託。",
  },
  deployStopped: { en: "Stopped · nothing deployed", zh: "已停止 · 未部署" },
  deployStoppedUndone: {
    en: "Stopped · the order was placed and has been cancelled",
    zh: "已停止 · 委託已送出並已取消",
  },
  deployStoppedRemoved: {
    en: "Stopped · the deployment was created and has been removed",
    zh: "已停止 · 部署已建立並已移除",
  },
  // The unwind failed. Never claim "stopped" here — say what is live.
  deployStopFailedBracket: {
    en: "Your order reached the exchange and could not be cancelled automatically. It is live — cancel it from Active.",
    zh: "委託已送達交易所且無法自動取消。它正在運行中 — 請至 Active 手動取消。",
  },
  deployStopFailedDeployment: {
    en: "The deployment started and could not be removed automatically. It is running — stop it from Running.",
    zh: "部署已啟動且無法自動移除。它正在運行中 — 請至 Running 手動停止。",
  },
  deployBusyElsewhere: {
    en: "A deploy is in progress",
    zh: "另一項部署進行中",
  },
  // 10-deployment cap. Only ever offers something that is not trading.
  capBlockedOffer: {
    en: "You're at the 10-setup limit. Free a slot by removing “{name}” ({why})?",
    zh: "已達 10 個策略上限。移除「{name}」（{why}）以空出名額？",
  },
  capBlockedNoSpare: {
    en: "You're at the 10-setup limit and every one of them is still trading. Stop one you no longer need, then deploy.",
    zh: "已達 10 個策略上限，且全部仍在交易中。請先停止不再需要的策略，再進行部署。",
  },
  capWhyNeverStarted: { en: "never started", zh: "從未啟動" },
  capWhyStopped: { en: "already stopped", zh: "已停止" },
  capFreeBtn: { en: "Remove & deploy", zh: "移除並部署" },
  capFreeFailed: {
    en: "Could not remove it. Delete a setup from Running, then try again.",
    zh: "無法移除。請至 Running 刪除一個策略後再試。",
  },
  balanceLoading: { en: "loading balance…", zh: "載入餘額中…" },
  clearMarks: { en: "✕ Clear marks", zh: "✕ 清除標記" },
  planUpdated: { en: "Plan updated", zh: "計畫已更新" },
  detectingLabel: { en: "detecting setups…", zh: "偵測策略中…" },
  sectionActive: { en: "Active", zh: "運行中" },
  sectionPrevious: { en: "Previous", zh: "歷史" },
  foreign: { en: "Foreign", zh: "外部" },
  foreignHint: {
    en: "Not deployed from this terminal — no plan data, controls only.",
    zh: "非本終端部署 — 無計畫資料，僅提供控制。",
  },
  stopBtn: { en: "Stop", zh: "停止" },
  exitBtn: { en: "Exit pos.", zh: "平倉" },
  deleteBtn: { en: "Delete", zh: "刪除" },
  stopping: { en: "Stopping…", zh: "停止中…" },
  restartBtn: { en: "Restart", zh: "重新啟動" },
  restarting: { en: "Restarting…", zh: "重新啟動中…" },
  exiting: { en: "Closing positions…", zh: "平倉中…" },
  deleting: { en: "Deleting…", zh: "刪除中…" },
  login: { en: "Login", zh: "登入" },
  settings: { en: "Settings", zh: "設定" },
  advancedSettings: { en: "+ More settings", zh: "+ 更多設定" },
  detectStepRead: { en: "Reading chart", zh: "讀取圖表" },
  detectStepMarket: { en: "Appending market context", zh: "附加市場情境" },
  detectStepPlans: { en: "Generating plans", zh: "生成計畫中" },
  scanPriceAction: { en: "Price action", zh: "價格行為" },
  scanDrawings: { en: "Your drawings", zh: "你的繪圖" },
  scanLevels: { en: "Key levels", zh: "關鍵價位" },
  comingSoon: { en: "Coming soon", zh: "即將推出" },
  language: { en: "Language", zh: "語言" },
  themeLabel: { en: "Theme", zh: "主題" },
  fontSize: { en: "Font size", zh: "字體大小" },
  fontSmall: { en: "Small", zh: "小" },
  fontDefault: { en: "Default", zh: "預設" },
  fontLarge: { en: "Large", zh: "大" },
  darkTheme: { en: "☾ Dark", zh: "☾ 深色" },
  lightTheme: { en: "☀ Light", zh: "☀ 淺色" },
  logout: { en: "Logout", zh: "登出" },
  signedIn: { en: "Signed in", zh: "已登入" },
  copyAddress: { en: "Copy wallet address", zh: "複製錢包地址" },
  copied: { en: "✓ Copied", zh: "✓ 已複製" },
  manageAccount: { en: "Manage account ↗", zh: "管理帳戶 ↗" },
  devMode: { en: "DEV", zh: "DEV" },
  devModeHint: {
    en: "Privy keys not configured — running as a local dev user.",
    zh: "尚未設定 Privy 金鑰 — 以本機開發者身分執行。",
  },
  loginPrompt: {
    en: "Sign in (top right) to use the AI and see your data.",
    zh: "請先登入（右上角）以使用 AI 並查看你的資料。",
  },
  detectedNote: {
    en: "Detected {n} setups — they're in the panel:",
    zh: "偵測到 {n} 個策略 — 已顯示在側欄：",
  },
  editingStrategy: { en: "Editing strategy", zh: "正在編輯策略" },
  revert: { en: "↺ Revert", zh: "↺ 還原" },
  mktSearch: { en: "Search 550+ markets…", zh: "搜尋 550+ 個市場…" },
  colMarket: { en: "Market", zh: "市場" },
  colLastPrice: { en: "Last Price", zh: "最新價" },
  colChg24h: { en: "24h %", zh: "24小時 %" },
  colFunding: { en: "Funding", zh: "資金費率" },
  colVolume: { en: "Volume", zh: "成交量" },
  colOpenInt: { en: "Open Int.", zh: "未平倉" },
  noMarkets: { en: "No markets match", zh: "沒有符合的市場" },
  // Venue layer (flag-gated Lighter integration).
  venuePicker: { en: "Venue", zh: "交易所" },
  venueAll: { en: "All", zh: "全部" },
  lighterMktsUnavailable: {
    en: "Lighter markets unavailable right now",
    zh: "Lighter 市場資料暫時無法取得",
  },
  lighterDeployRollout: {
    en: "Lighter live deploys are in rollout — this venue is chart & browse only in this build.",
    zh: "Lighter 實盤部署正在逐步開放 — 此版本中該交易所僅供圖表與瀏覽。",
  },
  noFills: { en: "no fills yet", zh: "尚無成交" },
  tabAll: { en: "All", zh: "全部" },
  tabPerps: { en: "Perps", zh: "永續" },
  tabSpot: { en: "Spot", zh: "現貨" },
  tabCrypto: { en: "Crypto", zh: "加密貨幣" },
  tabStocks: { en: "Stocks", zh: "股票" },
  tabIndices: { en: "Indices", zh: "指數" },
  tabCommodities: { en: "Commodities", zh: "商品" },
  tabFx: { en: "FX", zh: "外匯" },
  tagMajors: { en: "Majors", zh: "主流" },
  hideLowVol: { en: "Hide low volume", zh: "隱藏低成交量" },
  tagMeme: { en: "Meme", zh: "迷因" },
  tagAI: { en: "AI", zh: "AI" },
  tagTech: { en: "Tech", zh: "科技" },
  tagSemis: { en: "Semis", zh: "半導體" },
  tagCryptoStk: { en: "Crypto", zh: "加密概念" },
  tagEV: { en: "EV", zh: "電動車" },
  fundingTipDesc: {
    en: "Hourly funding rate: positive = longs pay shorts, negative = shorts pay longs. Charged every hour on Hyperliquid.",
    zh: "每小時資金費率：為正時多方支付空方，為負時空方支付多方。Hyperliquid 每小時收取一次。",
  },
  maxLevTipDesc: {
    en: "Maximum leverage for this market",
    zh: "此市場的最大槓桿",
  },
  sizingFunds: { en: "Funds", zh: "資金" },
  sizingLeverage: { en: "Leverage", zh: "槓桿" },
  sizingPosition: { en: "position", zh: "倉位" },
  sizingMax: { en: "max", zh: "上限" },
  sizingTradable: { en: "tradable", zh: "可用" },
  clearConfirm: {
    en: "Clear the entire chat history and start over? This can't be undone.",
    zh: "清除整個聊天記錄並重新開始？此操作無法復原。",
  },
  clearYes: { en: "Yes, clear", zh: "確認清除" },
  clearNo: { en: "Cancel", zh: "取消" },
  chatCleared: { en: "Chat cleared — fresh start.", zh: "已清除聊天 — 重新開始。" },
  rrTip: {
    en: "If the target hits, this plan wins about {rr}× the amount it risks if the stop hits. Above 2× is considered a good trade.",
    zh: "若達到目標價，獲利約為觸及停損時虧損的 {rr} 倍。高於 2 倍通常視為理想交易。",
  },
  // R:R badge label; the tooltip carries the plain-language explanation.
  rrBadge: { en: "{rr}R", zh: "{rr}R" },
  // Per-plan derived sizing next to Confirm Deploy: "$33 · 4× · risk $2 (1%)".
  riskLabel: { en: "risk", zh: "風險" },
  // Synthetic user turn the Detect button submits (detect runs via the agent).
  detectMsg: {
    en: "Scan my chart for setups.",
    zh: "掃描我的圖表，尋找交易機會。",
  },
  detectMsgAll: {
    en: "Scan my chart for setups — use ALL of my enabled indicators.",
    zh: "掃描我的圖表尋找交易機會——使用我啟用的全部指標。",
  },
  // Voice mode (persistent listening session).
  voiceListening: {
    en: "Listening — just speak; pause to send…",
    zh: "聆聽中——直接說話，停頓即送出…",
  },
  voiceDenied: {
    en: "Microphone access was denied — voice mode needs mic permission.",
    zh: "麥克風權限遭拒——語音模式需要麥克風權限。",
  },
  voiceEnded: {
    en: "Voice mode ended — the speech service dropped the session. Tap the mic to restart.",
    zh: "語音模式已結束——語音服務中斷了連線。點麥克風可重新開始。",
  },
  voiceUnsupported: {
    en: "Voice mode needs Chrome (Web Speech API not available in this browser).",
    zh: "語音模式需要 Chrome（此瀏覽器不支援 Web Speech API）。",
  },
  // Account Value header pill + account-management dialog.
  accountValue: { en: "Account Value", zh: "帳戶總值" },
  accountsTitle: { en: "Accounts", zh: "帳戶" },
  acctManage: { en: "Manage accounts", zh: "管理帳戶" },
  restartInsufficient: {
    en: "Not enough deployable funds to re-fund this restart — deposit or free up funds first",
    zh: "可部署資金不足以重啟此策略 — 請先入金或釋放資金",
  },
  acctRunning: { en: "Running", zh: "運行中" },
  acctIdle: { en: "Idle", zh: "閒置" },
  acctValue: { en: "Value", zh: "總值" },
  acctRealized: { en: "Realized PnL", zh: "已實現損益" },
  acctVolume: { en: "Volume", zh: "成交量" },
  acctTotal: { en: "Total", zh: "總計" },
  acctEmpty: {
    en: "No trading accounts yet — deploy a strategy to create one.",
    zh: "尚無交易帳戶——部署策略後即會建立。",
  },
  acctDefaultName: { en: "Account {n}", zh: "帳戶 {n}" },
  // — Fund management (accounts dialog): rename / transfer / sweep + deposit/withdraw —
  fmDeposit: { en: "Deposit", zh: "入金" },
  fmWithdraw: { en: "Withdraw", zh: "出金" },
  fmRename: { en: "Rename", zh: "重新命名" },
  fmTransfer: { en: "Transfer", zh: "轉帳" },
  fmSave: { en: "Save", zh: "儲存" },
  fmCancel: { en: "Cancel", zh: "取消" },
  fmConfirm: { en: "Confirm", zh: "確認" },
  fmBusy: { en: "Working…", zh: "處理中…" },
  fmNamePlaceholder: { en: "Account name", zh: "帳戶名稱" },
  fmRenameFailed: { en: "Rename failed", zh: "重新命名失敗" },
  fmTransferTo: { en: "To", zh: "轉入" },
  fmAmount: { en: "Amount", zh: "金額" },
  fmMax: { en: "Max", zh: "最大" },
  fmNoOtherAccounts: { en: "No other account to move funds to", zh: "沒有其他可轉入的帳戶" },
  fmTransferConfirm: { en: "Move {amt} to {name}?", zh: "轉 {amt} 至 {name}？" },
  fmTransferDone: { en: "Moved {amt} to {name}", zh: "已轉 {amt} 至 {name}" },
  fmTransferFailed: { en: "Transfer failed", zh: "轉帳失敗" },
  fmSweep: { en: "Sweep idle → main", zh: "歸集閒置 → 主帳戶" },
  fmSweepIdle: { en: "{amt} idle in {n}", zh: "{n} 個帳戶共 {amt} 閒置" },
  fmSweepConfirm: { en: "Sweep {amt} to your main account?", zh: "將 {amt} 歸集至主帳戶？" },
  fmSweepDone: { en: "Swept {amt} from {n} account(s)", zh: "已從 {n} 個帳戶歸集 {amt}" },
  fmSweepNone: { en: "Nothing idle to sweep", zh: "沒有可歸集的閒置資金" },
  fmSweepFailed: { en: "Sweep failed", zh: "歸集失敗" },
  fmOccupiedNote: { en: "Accounts running a strategy are left untouched.", zh: "運行中策略的帳戶不會被動用。" },
  // — appended: inbox relative times + flexible layout, i18n gap sweep —
  // TV-toolbar combined Indicators button (trading-chart.tsx paintBtn).
  indBtn: { en: "Indicators", zh: "指標" },
  indBtnActive: { en: "Indicators ({n} active)", zh: "指標（{n} 個啟用）" },
  // TV-toolbar footprint toggle (own button, next to Indicators).
  // "Footprint" is the industry-convergent name for this exact chart mode
  // (Exocharts/ATAS/TradingView/CoinGlass); "Order Flow" is the umbrella
  // category that also covers our separate CVD/Delta studies.
  ofBtn: { en: "Footprint", zh: "足跡圖" },
  ofUnavailTitle: { en: "Footprint coming soon", zh: "足跡圖即將推出" },
  ofUnavailBody: {
    en: "Order-flow footprint isn't available for this market yet — it's coming soon. For now it's live on the main perpetual markets, so switch to a perp like BTC or ETH to see it.",
    zh: "此市場的訂單流足跡圖尚未推出——即將上線。目前已在主要永續市場提供，請切換到永續合約（例如 BTC 或 ETH）以查看。",
  },
  ofUnavailGotIt: { en: "Got it", zh: "知道了" },
  // Chart top-bar "Strategies" overlay dropdown: paints one running
  // deployment's live state on the chart (positions/TP/SL, or intended levels).
  stratOverlayBtn: { en: "Strategies", zh: "策略" },
  stratOverlayEmpty: { en: "No running strategies", zh: "沒有運行中的策略" },
  stratOverlayLive: { en: "IN TRADE", zh: "持倉中" },
  stratOverlayArmed: { en: "ARMED", zh: "待觸發" },
  stratOverlayFlat: { en: "IDLE", zh: "閒置" },
  ofTipTitle: { en: "Order Flow Footprint", zh: "訂單流足跡圖" },
  ofTipBody: {
    en: "See how much was aggressively bought (green) vs sold (red) at each price inside a bar — spot where big buyers or sellers step in and confirm a turn at a level. Gold box = the price with the most volume. Best on 5m–1h.",
    zh: "顯示每根 K 線中各價位有多少「主動買進」（綠）與「主動賣出」（紅）——用來看出大買家或賣家在哪裡進場，並在關鍵價位確認轉折。金框＝成交量最大的價位。最適合 5m–1h。",
  },
  // Chart overlay shown while a detected setup is marked on the chart; {name}
  // replaced with the setup's title. Undo deselects it.
  setupBannerShowing: { en: "Showing {name} setup", zh: "正在顯示 {name} 策略" },
  // "Hide" — the button clears the drawn setup from the chart. "Undo"
  // implied it reversed the last action, which it never did.
  setupBannerUndo: { en: "Hide", zh: "隱藏" },
  // Relative timestamps (inbox); {n} replaced with the integer count.
  relJustNow: { en: "just now", zh: "剛剛" },
  relMinutes: { en: "{n}m ago", zh: "{n}分鐘前" },
  relHours: { en: "{n}h ago", zh: "{n}小時前" },
  relDays: { en: "{n}d ago", zh: "{n}天前" },
  inboxSize: { en: "size", zh: "數量" },
  // i18n gap sweep — previously hardcoded English in allowed files.
  acctValueUnavailable: {
    en: "Account value unavailable — retrying",
    zh: "無法取得帳戶總值 — 重試中",
  },
  dragResize: { en: "Drag to resize", zh: "拖曳調整寬度" },
  back: { en: "Back", zh: "返回" },
  depositQrAlt: { en: "Deposit QR code", zh: "入金 QR 碼" },
  ofCollecting: { en: "collecting live trades…", zh: "收集即時成交中…" },
  ofBin: { en: "bin", zh: "區間" },
  chartLoadFailed: { en: "Failed to load chart", zh: "圖表載入失敗" },
  close: { en: "Close", zh: "關閉" },
  accountFallback: { en: "Account", zh: "帳戶" },
  // Deploy/detect failure + notify strings (setups-context).
  deployFailedNote: {
    en: 'Deployment of "{title}" failed: {error}',
    zh: "「{title}」部署失敗：{error}",
  },
  deployErrCompile: { en: "strategy compilation failed", zh: "策略編譯失敗" },
  deployErrCreate: { en: "deployment creation failed", zh: "建立部署失敗" },
  deployErrWallet: { en: "wallet attachment failed", zh: "綁定錢包失敗" },
  deployErrPodStart: { en: "pod start failed", zh: "啟動交易程序失敗" },
  deployErrGeneric: { en: "deploy failed", zh: "部署失敗" },
  // Shown instead of the raw exchange error when the account simply isn't
  // funded/onboarded yet (new account, empty wallet). The fix is a deposit,
  // not a retry — the deposit dialog opens alongside this.
  deployNeedsFunding: {
    en: "This account isn't funded yet — deposit to start trading, then deploy.",
    zh: "此帳戶尚未入金 — 請先入金開始交易，再進行部署。",
  },
  strategyCompiled: {
    en: "Strategy compiled — ready to deploy",
    zh: "策略已編譯 — 可部署",
  },
  inboxExpiredTitle: { en: "Setup reached its time limit", zh: "設定已到期" },
  inboxExpiredBody: {
    en: '"{name}" hit its auto-stop time — it was closed and stopped.',
    zh: "「{name}」已到自動停止時間 — 已平倉並停止。",
  },
  deployWalletBusy: {
    en: "This trading account is already running a live strategy. Stop that strategy, add another account, or use a sub-account — then deploy again.",
    zh: "此交易帳戶已在運行一個策略。請先停止該策略、新增帳戶或使用子帳戶，再重新部署。",
  },
  deploySafetyReject: {
    en: "We couldn't build a safe version of this setup. Adjust the plan's stop or leverage and try again.",
    zh: "無法為此設定建立安全版本。請調整計畫的止損或槓桿後再試。",
  },
  detectErrGeneric: { en: "detect failed", zh: "偵測失敗" },
  deployedNote: {
    en: 'Deployed "{title}" live on Superior infra (${funds} at {lev}x, {dir}, entry {entry} / stop {stop} / target {target}).',
    zh: "「{title}」已部署上線（${funds}、{lev}x 槓桿、{dir}，進場 {entry} / 止損 {stop} / 目標 {target}）。",
  },
  // Backtest notify strings (floating-chat).
  btBitTrades: { en: "{n} trades", zh: "{n} 筆交易" },
  btBitTotal: { en: "{n}% total", zh: "總報酬 {n}%" },
  btBitWin: { en: "{n}% win", zh: "勝率 {n}%" },
  btBitDd: { en: "{n}% max DD", zh: "最大回撤 {n}%" },
  btFinishedNote: { en: "Backtest {id} finished: {results}.", zh: "回測 {id} 完成：{results}。" },
  btResultsReady: {
    en: "results ready in the Backtests tab",
    zh: "結果已在回測分頁備妥",
  },
  btStatusNote: { en: "Backtest {id} {st}.", zh: "回測 {id} {st}。" },
  btStillRunning: {
    en: "Backtest {id} is still running — check the Backtests tab.",
    zh: "回測 {id} 仍在執行中 — 請查看回測分頁。",
  },
  btRunning: { en: "Backtest running…", zh: "回測執行中…" },
  btSubmittedNote: {
    en: "Backtest submitted ({id}) — I'll report the results here when it finishes.",
    zh: "回測已提交（{id}）— 完成後我會在這裡回報結果。",
  },
  requestFailed: { en: "Request failed", zh: "請求失敗" },
  // Privacy mode (header eye toggle) — hides all money amounts.
  privacyHide: { en: "Privacy mode — hide amounts", zh: "隱私模式 — 隱藏金額" },
  privacyShow: { en: "Privacy mode — show amounts", zh: "隱私模式 — 顯示金額" },
};

export type Theme = "dark" | "light" | "dracula" | "nord" | "tokyo";
// Dark is the default (first, no class). "Light" is GitHub-Light.
export const THEMES: Array<{ id: Theme; name: string; swatch: string; track: string }> = [
  { id: "dark", name: "Dark", swatch: "#0a0a0a", track: "#a3e635" },
  { id: "light", name: "Light", swatch: "#ffffff", track: "#1a7f37" },
  { id: "dracula", name: "Dracula", swatch: "#bd93f9", track: "#282a36" },
  { id: "nord", name: "Nord", swatch: "#88c0d0", track: "#2e3440" },
  { id: "tokyo", name: "Tokyo Night", swatch: "#7aa2f7", track: "#1a1b26" },
];
const applyThemeClass = (th: Theme) => {
  const el = document.documentElement;
  el.classList.remove("light", "dracula", "nord", "tokyo");
  if (th !== "dark") el.classList.add(th);
};
export type FontScale = "sm" | "md" | "lg";

const FONT_PX: Record<FontScale, string> = { sm: "14px", md: "16px", lg: "17.5px" };

// All prefs persist in one cookie (readable server-side later for SSR).
const PREFS_COOKIE = "cg-prefs";

function readPrefs(): Partial<{ lang: Lang; theme: Theme; fontScale: FontScale }> {
  try {
    const raw = document.cookie
      .split("; ")
      .find((c) => c.startsWith(`${PREFS_COOKIE}=`))
      ?.slice(PREFS_COOKIE.length + 1);
    if (raw) return JSON.parse(decodeURIComponent(raw));
    // Migrate from the old localStorage keys once.
    const lang = window.localStorage.getItem("terminal-lang");
    const theme = window.localStorage.getItem("terminal-theme");
    if (lang || theme) return { lang: lang as Lang, theme: theme as Theme };
  } catch {
    /* fresh visitor */
  }
  return {};
}

function writePrefs(p: { lang: Lang; theme: Theme; fontScale: FontScale }): void {
  try {
    document.cookie = `${PREFS_COOKIE}=${encodeURIComponent(JSON.stringify(p))}; path=/; max-age=31536000; SameSite=Lax`;
  } catch {
    /* ignore */
  }
}

interface I18nContextType {
  lang: Lang;
  setLang: (l: Lang) => void;
  t: (key: string) => string;
  theme: Theme;
  setTheme: (t: Theme) => void;
  fontScale: FontScale;
  setFontScale: (f: FontScale) => void;
}

const I18nContext = createContext<I18nContextType | null>(null);

export function useLang(): I18nContextType {
  const ctx = useContext(I18nContext);
  if (!ctx) throw new Error("useLang must be used within I18nProvider");
  return ctx;
}

export function I18nProvider({ children }: { children: ReactNode }) {
  // Initialize from the SERVER-read cookie prefs (lib/server-prefs) — the
  // layout already stamped <html lang/class/font-size> with the same values,
  // so the first paint AND the first render match the user's saved settings
  // (no english/dark flash). The effect below only migrates pre-cookie
  // localStorage users.
  const server = useServerPrefs();
  const [lang, setLangState] = useState<Lang>(server.lang);
  const [theme, setThemeState] = useState<Theme>(server.theme);
  const [fontScale, setFontScaleState] = useState<FontScale>(server.fontScale);

  useEffect(() => {
    if (document.cookie.includes(`${PREFS_COOKIE}=`)) return; // cookie era — SSR handled it
    const p = readPrefs(); // legacy localStorage migration
    if (p.lang === "zh" || p.lang === "en") setLangState(p.lang);
    if (p.theme && THEMES.some((x) => x.id === p.theme)) {
      setThemeState(p.theme);
      applyThemeClass(p.theme);
    }
    if (p.fontScale && FONT_PX[p.fontScale]) {
      setFontScaleState(p.fontScale);
      document.documentElement.style.fontSize = FONT_PX[p.fontScale];
    }
  }, []);

  const persist = (next: { lang: Lang; theme: Theme; fontScale: FontScale }) =>
    writePrefs(next);

  const setLang = (l: Lang) => {
    setLangState(l);
    persist({ lang: l, theme, fontScale });
  };
  const setTheme = (th: Theme) => {
    setThemeState(th);
    applyThemeClass(th);
    persist({ lang, theme: th, fontScale });
  };
  const setFontScale = (f: FontScale) => {
    setFontScaleState(f);
    // rem-based scaling: Tailwind sizes are rem, so the whole UI follows.
    document.documentElement.style.fontSize = FONT_PX[f];
    persist({ lang, theme, fontScale: f });
  };

  const t = (key: string) => DICT[key]?.[lang] ?? key;
  return (
    <I18nContext.Provider
      value={{ lang, setLang, t, theme, setTheme, fontScale, setFontScale }}
    >
      {children}
    </I18nContext.Provider>
  );
}
