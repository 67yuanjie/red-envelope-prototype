export const PACKET_STATUS = Object.freeze({
  SENDING: "sending",
  PENDING: "pending",
  FAILED: "failed",
  CLAIMED: "claimed",
  RECALLED: "recalled",
  EXPIRED: "expired",
});

export const TRANSACTION_TYPE = Object.freeze({
  SEND: "send",
  RETURN: "return",
  RECEIVE: "receive",
});

export const PERSPECTIVE = Object.freeze({
  SENDER: "sender",
  RECIPIENT: "recipient",
});

export const ELIGIBILITY_CODE = Object.freeze({
  TERMS_REQUIRED: "TERMS_REQUIRED",
  PAYMENT_ACCOUNT_REQUIRED: "PAYMENT_ACCOUNT_REQUIRED",
  RECIPIENT_CANNOT_RECEIVE: "RECIPIENT_CANNOT_RECEIVE",
});

export const FEATURE_KEY = Object.freeze({
  SENDER_TERMS_ACCEPTED: "senderTermsAccepted",
  SENDER_PAYMENT_BOUND: "senderPaymentBound",
  RECIPIENT_CAN_RECEIVE_MESSAGES: "recipientCanReceiveMessages",
  RECIPIENT_SERVICE_ENABLED: "recipientServiceEnabled",
  RECIPIENT_PAYMENT_BOUND: "recipientPaymentBound",
  SEND_TRANSFER_AVAILABLE: "sendTransferAvailable",
  CLAIM_TRANSFER_AVAILABLE: "claimTransferAvailable",
  LEDGER_READABLE: "ledgerReadable",
});

export const STATUS_LABELS = Object.freeze({
  [PACKET_STATUS.SENDING]: "發送中",
  [PACKET_STATUS.PENDING]: "待領取",
  [PACKET_STATUS.FAILED]: "失敗",
  [PACKET_STATUS.CLAIMED]: "已領取",
  [PACKET_STATUS.RECALLED]: "已收回",
  [PACKET_STATUS.EXPIRED]: "已逾期",
});

export const TRANSACTION_TYPE_LABELS = Object.freeze({
  [TRANSACTION_TYPE.SEND]: "發送",
  [TRANSACTION_TYPE.RETURN]: "退回",
  [TRANSACTION_TYPE.RECEIVE]: "接收",
});

export const PAYMENT_TEST_CODE = "1234";
export const EXPIRY_HOURS = 72;

const TERMINAL_STATUSES = new Set([
  PACKET_STATUS.FAILED,
  PACKET_STATUS.CLAIMED,
  PACKET_STATUS.RECALLED,
  PACKET_STATUS.EXPIRED,
]);

const PENDING_TERMINAL_STATUSES = new Set([
  PACKET_STATUS.CLAIMED,
  PACKET_STATUS.RECALLED,
  PACKET_STATUS.EXPIRED,
]);

const FEATURE_KEYS = new Set(Object.values(FEATURE_KEY));
const HOUR_MS = 60 * 60 * 1000;

const clone = (value) => JSON.parse(JSON.stringify(value));
const timestampToSecond = (value) =>
  new Date(value).toISOString().replace(/\.\d{3}Z$/, "Z");

export class RedEnvelopeError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = "RedEnvelopeError";
    this.code = code;
    this.details = details;
  }
}

export function parsePositiveInteger(value) {
  if (typeof value === "number") {
    if (Number.isSafeInteger(value) && value > 0) return value;
    throw new RedEnvelopeError("INVALID_AMOUNT", "金額必須是正整數");
  }

  const text = String(value ?? "").trim();
  if (!/^[1-9]\d*$/.test(text)) {
    throw new RedEnvelopeError("INVALID_AMOUNT", "金額必須是正整數");
  }

  const amount = Number(text);
  if (!Number.isSafeInteger(amount)) {
    throw new RedEnvelopeError("INVALID_AMOUNT", "金額必須是正整數");
  }
  return amount;
}

/**
 * Page-lifetime, dependency-free domain model for the red-envelope prototype.
 * Mutations are synchronous. The pending-state check and terminal commit are
 * therefore one atomic operation in the browser event loop.
 */
export class RedEnvelopeDomain {
  constructor({
    sender = {},
    recipient = {},
    initialSenderBalance = 20_000,
    initialRecipientBalance = 0,
    now = () => new Date(),
  } = {}) {
    this.senderId = sender.id ?? "xiaoqing";
    this.recipientId = recipient.id ?? "akai";
    this._accounts = new Map([
      [
        this.senderId,
        {
          id: this.senderId,
          name: sender.name ?? "小晴",
          balance: Number(initialSenderBalance),
          termsAccepted: sender.termsAccepted ?? true,
          paymentBound: sender.paymentBound ?? true,
          serviceEnabled: sender.serviceEnabled ?? true,
          canReceiveMessages: sender.canReceiveMessages ?? true,
        },
      ],
      [
        this.recipientId,
        {
          id: this.recipientId,
          name: recipient.name ?? "阿凱",
          balance: Number(initialRecipientBalance),
          termsAccepted: recipient.termsAccepted ?? true,
          paymentBound: recipient.paymentBound ?? true,
          serviceEnabled: recipient.serviceEnabled ?? true,
          canReceiveMessages: recipient.canReceiveMessages ?? true,
        },
      ],
    ]);

    this._clockSource = typeof now === "function" ? now : () => new Date(now);
    this._clockOffsetMs = 0;
    this._perspective = PERSPECTIVE.SENDER;
    this._sendTransferAvailable = true;
    this._claimTransferAvailable = true;
    this._ledgerReadable = true;
    this._packets = new Map();
    this._transactions = new Map();
    this._listeners = new Set();
    this._sequence = 0;
  }

  subscribe(listener) {
    if (typeof listener !== "function") {
      throw new RedEnvelopeError("INVALID_LISTENER", "監聽器必須是函式");
    }
    this._listeners.add(listener);
    return () => this._listeners.delete(listener);
  }

  getSnapshot() {
    this.expireDuePackets({ silent: true });
    return this._snapshot();
  }

  getBalance(accountId = this.senderId) {
    return this._requireAccount(accountId).balance;
  }

  getSendEligibility() {
    const sender = this._requireAccount(this.senderId);
    const recipient = this._requireAccount(this.recipientId);

    if (!sender.termsAccepted) {
      return {
        allowed: false,
        code: ELIGIBILITY_CODE.TERMS_REQUIRED,
        message: "請先同意紅包服務條款，才能使用紅包功能",
      };
    }
    if (!sender.paymentBound) {
      return {
        allowed: false,
        code: ELIGIBILITY_CODE.PAYMENT_ACCOUNT_REQUIRED,
        message: "請先綁定支付帳戶，才能使用紅包功能",
      };
    }
    if (
      !recipient.canReceiveMessages ||
      !recipient.serviceEnabled ||
      !recipient.paymentBound
    ) {
      return {
        allowed: false,
        code: ELIGIBILITY_CODE.RECIPIENT_CANNOT_RECEIVE,
        message: "對方目前無法接收紅包",
      };
    }
    return { allowed: true, code: null, message: null };
  }

  setPerspective(perspective) {
    if (!Object.values(PERSPECTIVE).includes(perspective)) {
      throw new RedEnvelopeError("INVALID_PERSPECTIVE", "未知的操作視角");
    }
    this._perspective = perspective;
    this._publish("perspective_changed", { perspective });
    return this.getSnapshot();
  }

  setFeature(key, value) {
    if (!FEATURE_KEYS.has(key)) {
      throw new RedEnvelopeError("UNKNOWN_FEATURE", `未知的測試功能：${key}`);
    }
    return this.setEligibility({ [key]: Boolean(value) });
  }

  setEligibility(patch = {}) {
    const sender = this._requireAccount(this.senderId);
    const recipient = this._requireAccount(this.recipientId);
    const previousRecipientService = recipient.serviceEnabled;

    if (Object.hasOwn(patch, FEATURE_KEY.SENDER_TERMS_ACCEPTED)) {
      sender.termsAccepted = Boolean(patch.senderTermsAccepted);
    }
    if (Object.hasOwn(patch, FEATURE_KEY.SENDER_PAYMENT_BOUND)) {
      sender.paymentBound = Boolean(patch.senderPaymentBound);
    }
    if (Object.hasOwn(patch, FEATURE_KEY.RECIPIENT_CAN_RECEIVE_MESSAGES)) {
      recipient.canReceiveMessages = Boolean(patch.recipientCanReceiveMessages);
    }
    if (Object.hasOwn(patch, FEATURE_KEY.RECIPIENT_PAYMENT_BOUND)) {
      recipient.paymentBound = Boolean(patch.recipientPaymentBound);
    }
    if (Object.hasOwn(patch, FEATURE_KEY.RECIPIENT_SERVICE_ENABLED)) {
      recipient.serviceEnabled = Boolean(patch.recipientServiceEnabled);
    }
    if (Object.hasOwn(patch, FEATURE_KEY.SEND_TRANSFER_AVAILABLE)) {
      this._sendTransferAvailable = Boolean(patch.sendTransferAvailable);
    }
    if (Object.hasOwn(patch, FEATURE_KEY.CLAIM_TRANSFER_AVAILABLE)) {
      this._claimTransferAvailable = Boolean(patch.claimTransferAvailable);
    }
    if (Object.hasOwn(patch, FEATURE_KEY.LEDGER_READABLE)) {
      this._ledgerReadable = Boolean(patch.ledgerReadable);
    }

    let recalledPacketIds = [];
    if (previousRecipientService && !recipient.serviceEnabled) {
      recalledPacketIds = this._returnPendingForRecipientExit();
    }

    this._publish("eligibility_changed", { recalledPacketIds });
    return this.getSnapshot();
  }

  setTransferAvailability({ send, claim } = {}) {
    const patch = {};
    if (send !== undefined) patch.sendTransferAvailable = Boolean(send);
    if (claim !== undefined) patch.claimTransferAvailable = Boolean(claim);
    return this.setEligibility(patch);
  }

  setLedgerReadable(readable) {
    return this.setEligibility({ ledgerReadable: Boolean(readable) });
  }

  setRecordReadFailure(enabled) {
    return this.setLedgerReadable(!enabled);
  }

  verifyPaymentCode(code) {
    return String(code ?? "") === PAYMENT_TEST_CODE;
  }

  startSend(value) {
    const eligibility = this.getSendEligibility();
    if (!eligibility.allowed) {
      throw new RedEnvelopeError(eligibility.code, eligibility.message);
    }

    const amount = parsePositiveInteger(value);
    if (this.getBalance(this.senderId) < amount) {
      throw new RedEnvelopeError(
        "INSUFFICIENT_BALANCE",
        "餘額不足，請調整紅包金額",
        { amount, balance: this.getBalance(this.senderId) },
      );
    }

    const createdAt = this._timestamp();
    const packet = {
      id: `rp-${createdAt.replace(/\D/g, "")}-${++this._sequence}`,
      senderId: this.senderId,
      senderName: this._requireAccount(this.senderId).name,
      recipientId: this.recipientId,
      recipientName: this._requireAccount(this.recipientId).name,
      amount,
      status: PACKET_STATUS.SENDING,
      createdAt,
      updatedAt: createdAt,
      sentAt: null,
      expiresAt: null,
      claimedAt: null,
      recalledAt: null,
      expiredAt: null,
      failedAt: null,
      refundedAt: null,
      transferredAt: null,
      refundReason: null,
      failureCode: null,
      history: [{ status: PACKET_STATUS.SENDING, at: createdAt }],
    };
    this._packets.set(packet.id, packet);
    this._publish("packet_started", { packetId: packet.id });
    return this._operationResult(packet, true);
  }

  verifyAndSend(packetId, paymentCode, { transferSucceeds } = {}) {
    const packet = this._requirePacket(packetId);
    if (packet.status !== PACKET_STATUS.SENDING) {
      return this._operationResult(packet, false);
    }
    if (!this.verifyPaymentCode(paymentCode)) {
      throw new RedEnvelopeError("PAYMENT_VERIFICATION_FAILED", "支付驗證失敗");
    }

    const transferAvailable = transferSucceeds ?? this._sendTransferAvailable;
    if (!transferAvailable) {
      this._commitPacketStatus(packet, PACKET_STATUS.FAILED, {
        failureCode: "SEND_TRANSFER_FAILED",
      });
      return this._operationResult(packet, true);
    }

    // Recheck at the debit point so multiple prepared envelopes cannot overspend.
    if (this.getBalance(packet.senderId) < packet.amount) {
      this._commitPacketStatus(packet, PACKET_STATUS.FAILED, {
        failureCode: "INSUFFICIENT_BALANCE",
      });
      return this._operationResult(packet, true);
    }

    const sender = this._requireAccount(packet.senderId);
    sender.balance -= packet.amount;
    const sentAt = this._timestamp();
    const expiresAt = timestampToSecond(new Date(this._nowMs() + EXPIRY_HOURS * HOUR_MS));
    this._commitPacketStatus(packet, PACKET_STATUS.PENDING, { sentAt, expiresAt });
    this._createTransaction({
      id: `tx-send-${packet.id}`,
      packet,
      accountId: packet.senderId,
      counterpartyId: packet.recipientId,
      type: TRANSACTION_TYPE.SEND,
      status: PACKET_STATUS.PENDING,
      direction: "debit",
      transactionTime: sentAt,
    });
    this._publish("packet_sent", { packetId: packet.id });
    return this._operationResult(packet, true);
  }

  failSend(packetId, failureCode = "SEND_TRANSFER_FAILED") {
    const packet = this._requirePacket(packetId);
    if (packet.status !== PACKET_STATUS.SENDING) {
      return this._operationResult(packet, false);
    }
    this._commitPacketStatus(packet, PACKET_STATUS.FAILED, { failureCode });
    this._publish("packet_failed", { packetId });
    return this._operationResult(packet, true);
  }

  claim(packetId, { transferSucceeds } = {}) {
    this._expirePacketIfDue(packetId);
    const packet = this._requirePacket(packetId);
    if (TERMINAL_STATUSES.has(packet.status)) {
      return this._operationResult(packet, false);
    }
    if (packet.status !== PACKET_STATUS.PENDING) {
      throw this._invalidTransition(packet, PACKET_STATUS.CLAIMED);
    }

    const transferAvailable = transferSucceeds ?? this._claimTransferAvailable;
    if (!transferAvailable) {
      throw new RedEnvelopeError(
        "CLAIM_TRANSFER_FAILED",
        "紅包暫時無法領取，請稍後再試",
      );
    }

    const recipient = this._requireAccount(packet.recipientId);
    if (!packet.transferredAt) {
      recipient.balance += packet.amount;
      packet.transferredAt = this._timestamp();
    }
    this._commitPacketStatus(packet, PACKET_STATUS.CLAIMED);
    this._updateSendTransaction(packet);
    this._createTransaction({
      id: `tx-receive-${packet.id}`,
      packet,
      accountId: packet.recipientId,
      counterpartyId: packet.senderId,
      type: TRANSACTION_TYPE.RECEIVE,
      status: PACKET_STATUS.CLAIMED,
      direction: "credit",
      transactionTime: packet.claimedAt,
    });
    this._publish("packet_claimed", { packetId });
    return this._operationResult(packet, true);
  }

  recall(packetId) {
    return this._settleWithRefund(packetId, PACKET_STATUS.RECALLED, "active_recall");
  }

  expire(packetId) {
    return this._settleWithRefund(packetId, PACKET_STATUS.EXPIRED, "time_expired");
  }

  exitRecipientService() {
    const recipient = this._requireAccount(this.recipientId);
    recipient.serviceEnabled = false;
    const recalledPacketIds = this._returnPendingForRecipientExit();
    this._publish("recipient_service_exited", { recalledPacketIds });
    return { recalledPacketIds, snapshot: this.getSnapshot() };
  }

  advanceTime(hours) {
    const numericHours = Number(hours);
    if (!Number.isFinite(numericHours) || numericHours < 0) {
      throw new RedEnvelopeError("INVALID_TIME_ADVANCE", "快轉時數必須是非負數");
    }
    this._clockOffsetMs += numericHours * HOUR_MS;
    const expiredPacketIds = this.expireDuePackets({ silent: true });
    this._publish("time_advanced", { hours: numericHours, expiredPacketIds });
    return { now: this._timestamp(), expiredPacketIds, snapshot: this._snapshot() };
  }

  expireDuePackets({ silent = false } = {}) {
    const expiredPacketIds = [];
    for (const packet of this._packets.values()) {
      if (
        packet.status === PACKET_STATUS.PENDING &&
        packet.expiresAt &&
        this._nowMs() >= Date.parse(packet.expiresAt)
      ) {
        const result = this._settleWithRefund(
          packet.id,
          PACKET_STATUS.EXPIRED,
          "time_expired",
          { silent: true },
        );
        if (result.operationApplied) expiredPacketIds.push(packet.id);
      }
    }
    if (!silent && expiredPacketIds.length) {
      this._publish("packets_expired", { expiredPacketIds });
    }
    return expiredPacketIds;
  }

  getPacket(packetId) {
    this._expirePacketIfDue(packetId);
    return clone(this._requirePacket(packetId));
  }

  openPacket(packetId, perspective = this._perspective) {
    const packet = this.getPacket(packetId);
    return {
      ...packet,
      perspective,
      statusLabel: STATUS_LABELS[packet.status],
      canClaim: perspective === PERSPECTIVE.RECIPIENT && packet.status === PACKET_STATUS.PENDING,
      canRecall: perspective === PERSPECTIVE.SENDER && packet.status === PACKET_STATUS.PENDING,
    };
  }

  getPackets() {
    this.expireDuePackets({ silent: true });
    return [...this._packets.values()]
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .map((packet) => clone(packet));
  }

  getLedger({ perspective = this._perspective } = {}) {
    this.expireDuePackets({ silent: true });
    if (!this._ledgerReadable) {
      throw new RedEnvelopeError("LEDGER_UNAVAILABLE", "暫時無法顯示，請稍後再試");
    }
    const accountId = this._accountIdForPerspective(perspective);
    return [...this._transactions.values()]
      .filter((transaction) => transaction.accountId === accountId)
      .sort(
        (a, b) =>
          b.transactionTime.localeCompare(a.transactionTime) || b.id.localeCompare(a.id),
      )
      .map((transaction) => clone(transaction));
  }

  getRecord(transactionId) {
    if (!this._ledgerReadable) {
      throw new RedEnvelopeError("LEDGER_UNAVAILABLE", "暫時無法顯示，請稍後再試");
    }
    const transaction = this._transactions.get(transactionId);
    if (!transaction) {
      throw new RedEnvelopeError("RECORD_NOT_FOUND", "找不到內容，請返回上一頁");
    }
    const packet = this.getPacket(transaction.packetId);
    return {
      ...clone(transaction),
      canRecall:
        transaction.accountId === packet.senderId &&
        transaction.type === TRANSACTION_TYPE.SEND &&
        packet.status === PACKET_STATUS.PENDING,
      packet: clone(packet),
    };
  }

  _settleWithRefund(packetId, targetStatus, refundReason, { silent = false } = {}) {
    if (!PENDING_TERMINAL_STATUSES.has(targetStatus) || targetStatus === PACKET_STATUS.CLAIMED) {
      throw new RedEnvelopeError("INVALID_REFUND_STATUS", "退款狀態不正確");
    }
    const packet = this._requirePacket(packetId);
    if (TERMINAL_STATUSES.has(packet.status)) {
      return this._operationResult(packet, false);
    }
    if (packet.status !== PACKET_STATUS.PENDING) {
      throw this._invalidTransition(packet, targetStatus);
    }

    if (!packet.refundedAt) {
      this._requireAccount(packet.senderId).balance += packet.amount;
      packet.refundedAt = this._timestamp();
    }
    packet.refundReason = refundReason;
    this._commitPacketStatus(packet, targetStatus);
    this._updateSendTransaction(packet);
    this._createTransaction({
      id: `tx-return-${packet.id}`,
      packet,
      accountId: packet.senderId,
      counterpartyId: packet.recipientId,
      type: TRANSACTION_TYPE.RETURN,
      status: targetStatus,
      direction: "credit",
      transactionTime: packet.refundedAt,
    });
    if (!silent) this._publish("packet_refunded", { packetId, refundReason });
    return this._operationResult(packet, true);
  }

  _returnPendingForRecipientExit() {
    const recalledPacketIds = [];
    for (const packet of this._packets.values()) {
      if (packet.recipientId === this.recipientId && packet.status === PACKET_STATUS.PENDING) {
        const result = this._settleWithRefund(
          packet.id,
          PACKET_STATUS.RECALLED,
          "recipient_exit",
          { silent: true },
        );
        if (result.operationApplied) recalledPacketIds.push(packet.id);
      }
    }
    return recalledPacketIds;
  }

  _expirePacketIfDue(packetId) {
    const packet = this._requirePacket(packetId);
    if (
      packet.status === PACKET_STATUS.PENDING &&
      packet.expiresAt &&
      this._nowMs() >= Date.parse(packet.expiresAt)
    ) {
      this._settleWithRefund(packet.id, PACKET_STATUS.EXPIRED, "time_expired", {
        silent: true,
      });
    }
  }

  _createTransaction({
    id,
    packet,
    accountId,
    counterpartyId,
    type,
    status,
    direction,
    transactionTime,
  }) {
    if (this._transactions.has(id)) return this._transactions.get(id);
    const account = this._requireAccount(accountId);
    const counterparty = this._requireAccount(counterpartyId);
    const transaction = {
      id,
      packetId: packet.id,
      accountId,
      item: TRANSACTION_TYPE_LABELS[type],
      type,
      typeLabel: TRANSACTION_TYPE_LABELS[type],
      amount: packet.amount,
      direction,
      counterpartyId,
      counterpartyName: counterparty.name,
      transactionTime,
      accountBalance: account.balance,
      status,
      statusLabel: STATUS_LABELS[status],
    };
    this._transactions.set(id, transaction);
    return transaction;
  }

  _updateSendTransaction(packet) {
    const transaction = this._transactions.get(`tx-send-${packet.id}`);
    if (!transaction) return;
    transaction.status = packet.status;
    transaction.statusLabel = STATUS_LABELS[packet.status];
  }

  _commitPacketStatus(packet, status, extra = {}) {
    const at = this._timestamp();
    packet.status = status;
    packet.updatedAt = at;
    Object.assign(packet, extra);
    if (status === PACKET_STATUS.PENDING && !packet.sentAt) packet.sentAt = at;
    if (status === PACKET_STATUS.CLAIMED) packet.claimedAt = at;
    if (status === PACKET_STATUS.RECALLED) packet.recalledAt = at;
    if (status === PACKET_STATUS.EXPIRED) packet.expiredAt = at;
    if (status === PACKET_STATUS.FAILED) packet.failedAt = at;
    packet.history.push({ status, at });
  }

  _operationResult(packet, operationApplied) {
    return { ...clone(packet), operationApplied };
  }

  _invalidTransition(packet, targetStatus) {
    return new RedEnvelopeError(
      "INVALID_TRANSITION",
      `紅包無法從 ${packet.status} 轉為 ${targetStatus}`,
      { packetId: packet.id, currentStatus: packet.status, targetStatus },
    );
  }

  _accountIdForPerspective(perspective) {
    if (perspective === PERSPECTIVE.SENDER) return this.senderId;
    if (perspective === PERSPECTIVE.RECIPIENT) return this.recipientId;
    throw new RedEnvelopeError("INVALID_PERSPECTIVE", "未知的操作視角");
  }

  _requirePacket(packetId) {
    const packet = this._packets.get(packetId);
    if (!packet) throw new RedEnvelopeError("PACKET_NOT_FOUND", "找不到內容，請返回上一頁");
    return packet;
  }

  _requireAccount(accountId) {
    const account = this._accounts.get(accountId);
    if (!account) throw new RedEnvelopeError("ACCOUNT_NOT_FOUND", "找不到帳戶");
    return account;
  }

  _nowMs() {
    const sourceDate = new Date(this._clockSource());
    if (Number.isNaN(sourceDate.getTime())) {
      throw new RedEnvelopeError("INVALID_CLOCK", "時間來源無效");
    }
    return sourceDate.getTime() + this._clockOffsetMs;
  }

  _timestamp() {
    return timestampToSecond(this._nowMs());
  }

  _snapshot() {
    const sender = this._requireAccount(this.senderId);
    const recipient = this._requireAccount(this.recipientId);
    return clone({
      now: this._timestamp(),
      perspective: this._perspective,
      sender: { ...sender },
      recipient: { ...recipient },
      eligibility: this.getSendEligibility(),
      controls: {
        sendTransferAvailable: this._sendTransferAvailable,
        claimTransferAvailable: this._claimTransferAvailable,
        ledgerReadable: this._ledgerReadable,
      },
      packets: [...this._packets.values()].sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      ),
    });
  }

  _publish(type, detail = {}) {
    if (!this._listeners.size) return;
    const event = clone({ type, detail, at: this._timestamp() });
    const snapshot = this._snapshot();
    for (const listener of this._listeners) listener(event, clone(snapshot));
  }
}

