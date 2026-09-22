const VIEW_TITLES = Object.freeze({
  chat: null,
  amount: "發紅包",
  confirm: "發送確認",
  verify: "支付驗證",
  sent: "發送結果",
  receive: "收到紅包",
  "sender-final": "紅包狀態",
  "sender-pending": "紅包狀態",
  history: "紅包紀錄",
  record: "單筆紀錄",
  error: "提示",
});

const STATUS_LABELS = Object.freeze({
  sending: "發送中",
  pending: "待領取",
  failed: "失敗",
  claimed: "已領取",
  recalled: "已收回",
  expired: "已逾期",
});

const MESSAGE_TEXT = Object.freeze({
  TERMS_REQUIRED: "請先同意紅包服務條款，才能使用紅包功能",
  PAYMENT_ACCOUNT_REQUIRED: "請先綁定支付帳戶，才能使用紅包功能",
  RECIPIENT_CANNOT_RECEIVE: "對方目前無法接收紅包",
  INVALID_AMOUNT: "金額必須是正整數",
  INSUFFICIENT_BALANCE: "餘額不足，請調整紅包金額",
  PAYMENT_VERIFICATION_FAILED: "支付驗證失敗",
  SEND_TRANSFER_FAILED: "紅包尚未送出，請稍後再試",
  CLAIM_SUCCESS: "收取成功！紅包已領取",
  CLAIM_TRANSFER_FAILED: "紅包暫時無法領取，請稍後再試",
  EXIT_CONFIRM: "確定要退出當前頁面嗎？",
  LEDGER_UNAVAILABLE: "暫時無法顯示，請稍後再試",
  RECORD_NOT_FOUND: "找不到內容，請返回上一頁",
});

const currency = new Intl.NumberFormat("zh-TW", {
  style: "currency",
  currency: "TWD",
  currencyDisplay: "narrowSymbol",
  maximumFractionDigits: 0,
});

const dateTime = new Intl.DateTimeFormat("zh-TW", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

const shortTime = new Intl.DateTimeFormat("zh-TW", {
  hour: "2-digit",
  minute: "2-digit",
  hour12: false,
});

function byId(id) {
  return document.getElementById(id);
}

function formatMoney(value) {
  const amount = Number(value);
  return Number.isFinite(amount) ? `NT$ ${currency.format(amount).replace(/^\$/, "")}` : "NT$ 0";
}

function formatDate(value, formatter = dateTime) {
  const parsed = value ? new Date(value) : null;
  return parsed && !Number.isNaN(parsed.getTime()) ? formatter.format(parsed) : "--";
}

function setText(element, value) {
  if (element) element.textContent = value ?? "";
}

function setHidden(element, hidden) {
  if (element) element.hidden = Boolean(hidden);
}

function normalizedStatus(status) {
  return STATUS_LABELS[status] ?? status ?? "";
}

function packetIdFrom(source) {
  return source?.closest?.("[data-packet-id]")?.dataset.packetId || null;
}

function recordIdFrom(source) {
  return source?.closest?.("[data-record-id]")?.dataset.recordId || null;
}

/**
 * DOM-only UI adapter. Business decisions stay in app.js/domain.js.
 * `onAction` receives { type, payload, source } and may return a promise.
 */
export function createUI({ onAction = () => undefined } = {}) {
  const shell = byId("app-shell");
  const main = byId("app-main");
  const title = byId("view-title");
  const backButton = byId("app-back");
  const historyButton = byId("open-history");
  const modalLayer = byId("modal");
  const modalTitle = byId("modal-title");
  const modalMessage = byId("modal-message");
  const modalConfirm = byId("modal-confirm");
  const modalCancel = byId("modal-cancel");
  const toastElement = byId("toast");
  const actionMenu = byId("action-menu");
  const actionMenuButton = byId("open-actions");
  const announcer = byId("loading-announcer");

  const views = new Map(
    [...document.querySelectorAll("[data-view]")].map((view) => [view.dataset.view, view]),
  );

  let activeView = "chat";
  let viewStack = ["chat"];
  let lastFocused = null;
  let modalCallbacks = { confirm: null, cancel: null };
  let toastTimer = 0;

  function currentChatTitle() {
    return shell?.dataset.perspective === "recipient" ? "小晴" : "阿凱";
  }

  function navigate(viewName, { replace = false, reset = false, focus = true } = {}) {
    if (!views.has(viewName)) return false;

    for (const [name, view] of views) view.hidden = name !== viewName;
    activeView = viewName;

    if (reset) viewStack = [viewName];
    else if (replace) viewStack[viewStack.length - 1] = viewName;
    else if (viewStack[viewStack.length - 1] !== viewName) viewStack.push(viewName);

    setText(title, VIEW_TITLES[viewName] ?? currentChatTitle());
    setHidden(backButton, viewName === "chat" || viewName === "sent");
    setHidden(historyButton, viewName !== "chat");
    closeActionMenu();
    views.get(viewName).scrollTop = 0;
    if (focus) main?.focus({ preventScroll: true });
    return true;
  }

  function back() {
    if (viewStack.length > 1) viewStack.pop();
    return navigate(viewStack[viewStack.length - 1] ?? "chat", { replace: true });
  }

  function openActionMenu() {
    if (!actionMenu || !actionMenuButton) return;
    actionMenu.hidden = false;
    actionMenuButton.setAttribute("aria-expanded", "true");
    actionMenuButton.setAttribute("aria-label", "關閉聊天室功能選單");
  }

  function closeActionMenu() {
    if (!actionMenu || !actionMenuButton) return;
    actionMenu.hidden = true;
    actionMenuButton.setAttribute("aria-expanded", "false");
    actionMenuButton.setAttribute("aria-label", "開啟聊天室功能選單");
  }

  function toggleActionMenu() {
    if (actionMenu?.hidden) openActionMenu();
    else closeActionMenu();
  }

  function showModal({
    title: heading = "提示",
    message = "",
    confirmLabel = "確定",
    cancelLabel = "取消",
    showCancel = false,
    onConfirm = null,
    onCancel = null,
  } = {}) {
    lastFocused = document.activeElement;
    modalCallbacks = { confirm: onConfirm, cancel: onCancel };
    setText(modalTitle, heading);
    setText(modalMessage, message);
    setText(modalConfirm, confirmLabel);
    setText(modalCancel, cancelLabel);
    setHidden(modalCancel, !showCancel);
    modalLayer.hidden = false;
    document.body.style.overflow = "hidden";
    modalConfirm.focus();
  }

  function closeModal({ restoreFocus = true } = {}) {
    if (!modalLayer || modalLayer.hidden) return;
    modalLayer.hidden = true;
    document.body.style.overflow = "";
    modalCallbacks = { confirm: null, cancel: null };
    if (restoreFocus && lastFocused instanceof HTMLElement) lastFocused.focus();
    lastFocused = null;
  }

  function toast(message, { duration = 2400 } = {}) {
    window.clearTimeout(toastTimer);
    setText(toastElement, message);
    toastElement.hidden = false;
    toastTimer = window.setTimeout(() => {
      toastElement.hidden = true;
    }, duration);
  }

  function setBusy(target, busy = true, label = "處理中") {
    const element =
      typeof target === "string"
        ? byId(target) || document.querySelector(`[data-action="${CSS.escape(target)}"]`)
        : target;
    if (!element) return;
    element.classList.toggle("is-loading", Boolean(busy));
    element.setAttribute("aria-busy", String(Boolean(busy)));
    if ("disabled" in element) element.disabled = Boolean(busy);
    setText(announcer, busy ? label : "");
  }

  function fieldError(field, message = "") {
    const errorElement = byId(`${field}-error`);
    const inputElement = byId(`${field}-input`);
    if (!errorElement) return;
    setText(errorElement, message);
    errorElement.hidden = !message;
    inputElement?.setAttribute("aria-invalid", String(Boolean(message)));
    if (message) inputElement?.focus();
  }

  function renderSnapshot(snapshot = {}) {
    const perspective = snapshot.perspective === "recipient" ? "recipient" : "sender";
    const sender = snapshot.sender ?? {};
    const recipient = snapshot.recipient ?? {};
    const isRecipient = perspective === "recipient";
    const otherName = isRecipient ? sender.name ?? "小晴" : recipient.name ?? "阿凱";

    if (shell) shell.dataset.perspective = perspective;
    setText(byId("perspective-label"), isRecipient ? "接收方視角" : "發送方視角");
    if (activeView === "chat") setText(title, otherName);
    setText(byId("chat-placeholder-text"), `這裡是與${otherName}的一對一聊天室。`);

    document.querySelectorAll("[data-action='perspective:set']").forEach((button) => {
      const selected = button.dataset.value === perspective;
      button.classList.toggle("is-active", selected);
      button.setAttribute("aria-pressed", String(selected));
    });

    const featureToggle = byId("feature-enabled");
    if (featureToggle && recipient.serviceEnabled !== undefined) {
      featureToggle.checked = Boolean(recipient.serviceEnabled);
    }
    const openSend = byId("open-send");
    if (openSend && recipient.serviceEnabled !== undefined) {
      const sendUnavailable = isRecipient || !recipient.serviceEnabled;
      openSend.disabled = sendUnavailable;
      openSend.setAttribute("aria-disabled", String(sendUnavailable));
    }

    const currentBalance = isRecipient ? recipient.balance : sender.balance;
    setText(byId("balance-display"), formatMoney(sender.balance));
    setText(byId("history-balance"), formatMoney(currentBalance));
    setText(byId("amount-recipient"), recipient.name ?? "阿凱");
    setText(byId("confirm-recipient"), recipient.name ?? "阿凱");
    setText(byId("prototype-clock"), `目前時間：${formatDate(snapshot.now)}`);

    const latestPacket = Array.isArray(snapshot.packets) ? snapshot.packets[0] : null;
    renderChatPacket(latestPacket, perspective);
    return snapshot;
  }

  function renderChatPacket(packet, perspective = shell?.dataset.perspective ?? "sender") {
    const senderCard = byId("sender-card");
    const receiverCard = byId("receiver-card");
    const empty = byId("chat-empty");

    setHidden(senderCard, !packet || perspective !== "sender");
    setHidden(receiverCard, !packet || perspective !== "recipient");
    setHidden(empty, Boolean(packet));
    if (!packet) return;

    const isRecipient = perspective === "recipient";
    const card = isRecipient ? receiverCard : senderCard;
    if (!card) return;

    card.dataset.packetId = packet.id ?? "";
    setText(card.querySelector("[data-field='headline']"), isRecipient ? "收到一個紅包" : "你送出一個紅包");
    setText(card.querySelector("[data-field='amount']"), formatMoney(packet.amount));
    setText(
      card.querySelector("[data-field='party']"),
      isRecipient ? `來自${packet.senderName ?? "小晴"}` : `給${packet.recipientName ?? "阿凱"}`,
    );
    setText(
      card.querySelector("[data-field='status']"),
      isRecipient && packet.status === "pending" ? "可領取" : normalizedStatus(packet.status),
    );
    setText(card.querySelector("[data-field='time']"), formatDate(packet.updatedAt ?? packet.createdAt, shortTime));
  }

  function setDraft({ amount = 0, recipientName = "阿凱" } = {}) {
    setText(byId("confirm-amount"), formatMoney(amount));
    setText(byId("confirm-recipient"), recipientName);
    setText(byId("amount-recipient"), recipientName);
    const amountInput = byId("amount-input");
    if (amountInput) amountInput.value = amount ? String(amount) : "";
    if (!amount) {
      const verifyInput = byId("verify-input");
      if (verifyInput) verifyInput.value = "";
    }
  }

  function renderSent(packet = {}) {
    setText(byId("sent-amount"), formatMoney(packet.amount));
    navigate("sent");
  }

  function renderPacketDetail(packet = {}, perspective = packet.perspective ?? shell?.dataset.perspective) {
    const amountText = formatMoney(packet.amount);
    const statusText = normalizedStatus(packet.status);

    if (perspective === "recipient") {
      const canClaim = packet.status === "pending";
      setText(
        byId("receive-heading"),
        canClaim ? `收到${packet.senderName ?? "小晴"}給你的 ${amountText} 紅包` : "無法領取",
      );
      setText(byId("receive-status"), canClaim ? "" : `紅包${statusText}`);
      setHidden(byId("receive-status"), canClaim);
      const claimButton = byId("claim-button");
      setHidden(claimButton, !canClaim);
      if (claimButton) claimButton.closest("[data-view]").dataset.packetId = packet.id ?? "";
      navigate("receive");
      return;
    }

    if (packet.status === "pending") {
      setText(
        byId("recall-description"),
        `送給${packet.recipientName ?? "阿凱"}的 ${amountText} 紅包尚未被領取`,
      );
      const pendingView = byId("view-sender-pending");
      if (pendingView) pendingView.dataset.packetId = packet.id ?? "";
      navigate("sender-pending");
      return;
    }

    const description =
      packet.status === "claimed"
        ? `${packet.recipientName ?? "阿凱"}已領取你的 ${amountText} 紅包`
        : `送給${packet.recipientName ?? "阿凱"}的 ${amountText} 紅包${statusText}`;
    setText(byId("sender-detail-description"), description);
    setText(byId("sender-detail-status"), `紅包${statusText}`);
    setText(byId("sender-final-heading"), statusText || "紅包狀態");
    navigate("sender-final");
  }

  function renderHistory(records = []) {
    const list = byId("history-list");
    const empty = byId("history-empty");
    if (!list) return;
    list.replaceChildren();
    setHidden(empty, records.length > 0);

    for (const record of records) {
      const item = document.createElement("button");
      item.type = "button";
      item.className = "history-item";
      item.dataset.action = "record:open";
      item.dataset.recordId = record.id ?? "";
      item.setAttribute("aria-label", `${record.typeLabel ?? record.item ?? "紀錄"} ${formatMoney(record.amount)}，查看明細`);

      const top = document.createElement("span");
      top.className = "history-item__top";
      const type = document.createElement("strong");
      type.textContent = record.typeLabel ?? record.item ?? "";
      const amount = document.createElement("span");
      amount.className = "history-item__amount";
      amount.textContent = formatMoney(record.amount);
      top.append(type, amount);

      const meta = document.createElement("span");
      meta.className = "history-item__meta";
      const party = document.createElement("span");
      party.textContent = record.counterpartyName ?? "";
      const status = document.createElement("span");
      status.textContent = record.statusLabel ?? normalizedStatus(record.status);
      meta.append(party, status);

      const detail = document.createElement("span");
      detail.className = "history-item__detail";
      const time = document.createElement("time");
      time.textContent = formatDate(record.transactionTime);
      const balance = document.createElement("span");
      balance.textContent = `餘額 ${formatMoney(record.accountBalance)}`;
      detail.append(time, balance);

      item.append(top, meta, detail);
      list.append(item);
    }
  }

  function renderRecord(record = {}) {
    setText(byId("record-type"), record.typeLabel ?? record.item ?? "");
    setText(byId("record-amount"), formatMoney(record.amount));
    setText(byId("record-party"), record.counterpartyName ?? "");
    setText(byId("record-time"), formatDate(record.transactionTime));
    setText(byId("record-balance"), formatMoney(record.accountBalance));
    setText(byId("record-state"), record.statusLabel ?? normalizedStatus(record.status));
    setText(byId("record-status"), record.statusLabel ?? normalizedStatus(record.status));

    const recallButton = byId("record-recall");
    setHidden(recallButton, !record.canRecall);
    const recordView = byId("view-record");
    if (recordView) {
      recordView.dataset.recordId = record.id ?? "";
      recordView.dataset.packetId = record.packetId ?? record.packet?.id ?? "";
    }
    navigate("record");
  }

  function renderError(message = MESSAGE_TEXT.LEDGER_UNAVAILABLE) {
    setText(byId("error-message"), message);
    navigate("error");
  }

  function render(viewModel = {}) {
    if (viewModel.snapshot) renderSnapshot(viewModel.snapshot);
    else if (viewModel.perspective || viewModel.sender || viewModel.packets) renderSnapshot(viewModel);
    if (viewModel.draft) setDraft(viewModel.draft);
    if (viewModel.packet) renderPacketDetail(viewModel.packet, viewModel.perspective);
    if (viewModel.records) renderHistory(viewModel.records);
    if (viewModel.record) renderRecord(viewModel.record);
    if (viewModel.error) renderError(viewModel.error);
    if (viewModel.view) navigate(viewModel.view, { replace: Boolean(viewModel.replace) });
  }

  async function emit(type, payload, source) {
    const result = onAction({ type, payload, source });
    return result instanceof Promise ? result : Promise.resolve(result);
  }

  async function handleAction(source) {
    const type = source.dataset.action;
    if (!type) return;

    if (type === "menu:toggle") {
      toggleActionMenu();
      return;
    }
    if (type === "nav:back") {
      await emit(type, {}, source);
      back();
      return;
    }
    if (type === "nav:chat") {
      await emit(type, {}, source);
      navigate("chat", { reset: true });
      return;
    }
    if (type === "exit:confirm") {
      showModal({
        message: MESSAGE_TEXT.EXIT_CONFIRM,
        showCancel: true,
        confirmLabel: "確定",
        cancelLabel: "取消",
        onConfirm: () => navigate("chat", { reset: true }),
      });
      return;
    }
    if (type === "send:confirm") {
      await emit(type, {}, source);
      navigate("verify");
      byId("verify-input")?.focus();
      return;
    }

    const payload = {};
    if (type === "send:start") payload.amount = byId("amount-input")?.value ?? "";
    if (type === "send:verify") payload.code = byId("verify-input")?.value ?? "";
    if (type === "perspective:set") payload.perspective = source.dataset.value;
    if (type === "feature:set") {
      payload.key = source.dataset.featureKey || "recipientServiceEnabled";
      payload.enabled = source.checked;
    }
    if (type === "time:advance") payload.hours = Number(source.dataset.hours || 72);
    if (type.startsWith("packet:")) payload.packetId = packetIdFrom(source);
    if (type === "record:open") payload.recordId = recordIdFrom(source);

    setBusy(source, true);
    try {
      const result = await emit(type, payload, source);
      if (result?.view) navigate(result.view);
    } finally {
      setBusy(source, false);
    }
  }

  document.addEventListener("click", (event) => {
    const source = event.target.closest("[data-action]");
    if (!source || source.disabled || source.getAttribute("aria-disabled") === "true") return;

    if (source === modalConfirm) {
      const callback = modalCallbacks.confirm;
      closeModal({ restoreFocus: false });
      callback?.();
      emit("modal:confirm", {}, source);
      return;
    }
    if (source === modalCancel) {
      const callback = modalCallbacks.cancel;
      closeModal();
      callback?.();
      emit("modal:cancel", {}, source);
      return;
    }

    handleAction(source).catch((error) => {
      fieldError("amount", "");
      fieldError("verify", "");
      const message = MESSAGE_TEXT[error?.code] ?? error?.message ?? "暫時無法處理，請稍後再試";
      if (error?.code === "INVALID_AMOUNT" || error?.code === "INSUFFICIENT_BALANCE") {
        fieldError("amount", message);
      } else if (error?.code === "PAYMENT_VERIFICATION_FAILED") {
        fieldError("verify", message);
      } else {
        showModal({ message });
      }
    });
  });

  modalLayer?.addEventListener("click", (event) => {
    if (event.target === modalLayer && modalCancel && !modalCancel.hidden) closeModal();
  });

  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    if (!modalLayer?.hidden && modalCancel && !modalCancel.hidden) closeModal();
    else if (!actionMenu?.hidden) closeActionMenu();
  });

  byId("amount-input")?.addEventListener("input", () => fieldError("amount", ""));
  byId("verify-input")?.addEventListener("input", () => fieldError("verify", ""));

  return Object.freeze({
    navigate,
    back,
    render,
    renderSnapshot,
    renderHistory,
    renderRecord,
    renderPacketDetail,
    renderSent,
    renderError,
    setDraft,
    showModal,
    closeModal,
    toast,
    setBusy,
    fieldError,
    messages: MESSAGE_TEXT,
    get activeView() {
      return activeView;
    },
  });
}

export { MESSAGE_TEXT, STATUS_LABELS, formatMoney, formatDate };
