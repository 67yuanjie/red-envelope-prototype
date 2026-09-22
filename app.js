import {
  EXPIRY_HOURS,
  FEATURE_KEY,
  PACKET_STATUS,
  PAYMENT_TEST_CODE,
  PERSPECTIVE,
  RedEnvelopeDomain,
  RedEnvelopeError,
  parsePositiveInteger,
} from "./src/domain.js";
import { createUI, formatMoney } from "./src/ui.js";

const domain = new RedEnvelopeDomain();
let draft = { amount: null };

const ui = createUI({ onAction: handleAction });

function snapshot() {
  const next = domain.getSnapshot();
  ui.renderSnapshot(next);
  return next;
}

function ensureAmount(value) {
  const amount = parsePositiveInteger(value);
  const balance = domain.getBalance(domain.senderId);
  if (amount > balance) {
    throw new RedEnvelopeError("INSUFFICIENT_BALANCE", "餘額不足，請調整紅包金額", {
      amount,
      balance,
    });
  }
  return amount;
}

function returnNotification(packetIds, sourcePackets) {
  if (!packetIds?.length) return;
  const packets = sourcePackets.filter((packet) => packetIds.includes(packet.id));
  const amount = packets.reduce((total, packet) => total + Number(packet.amount || 0), 0);
  ui.toast(`好友未領取紅包，${formatMoney(amount)} 已退回您的帳戶`);
}

function requireSenderPerspective() {
  if (domain.getSnapshot().perspective !== PERSPECTIVE.SENDER) {
    throw new RedEnvelopeError("SENDER_ONLY", "請切換至發送方視角使用紅包發送功能");
  }
}

async function handleAction({ type, payload = {} }) {
  switch (type) {
    case "entry:open": {
      requireSenderPerspective();
      const eligibility = domain.getSendEligibility();
      if (!eligibility.allowed) {
        throw new RedEnvelopeError(eligibility.code, eligibility.message);
      }
      draft = { amount: null };
      ui.setDraft({ amount: 0, recipientName: domain.getSnapshot().recipient.name });
      ui.fieldError("amount", "");
      return { view: "amount" };
    }

    case "send:start": {
      const amount = ensureAmount(payload.amount);
      draft = { amount };
      ui.setDraft({ amount, recipientName: domain.getSnapshot().recipient.name });
      return { view: "confirm" };
    }

    case "send:confirm":
      return undefined;

    case "send:verify": {
      if (!draft.amount) {
        throw new RedEnvelopeError("INVALID_AMOUNT", "金額必須是正整數");
      }
      if (!domain.verifyPaymentCode(payload.code)) {
        throw new RedEnvelopeError("PAYMENT_VERIFICATION_FAILED", "支付驗證失敗");
      }

      const sending = domain.startSend(draft.amount);
      const sent = domain.verifyAndSend(sending.id, PAYMENT_TEST_CODE);
      const next = snapshot();
      if (sent.status === PACKET_STATUS.FAILED) {
        ui.showModal({ message: "紅包尚未送出，請稍後再試" });
        return undefined;
      }
      ui.renderSent(sent);
      draft = { amount: null };
      return { snapshot: next };
    }

    case "packet:open": {
      const packet = domain.openPacket(payload.packetId);
      ui.renderPacketDetail(packet, packet.perspective);
      return undefined;
    }

    case "packet:claim": {
      const claimed = domain.claim(payload.packetId);
      snapshot();
      ui.showModal({
        title: "領取成功",
        message: "收取成功！紅包已領取",
        confirmLabel: "確定",
        onConfirm: () => ui.navigate("chat", { reset: true }),
      });
      return { packet: claimed };
    }

    case "packet:recall": {
      const recalled = domain.recall(payload.packetId);
      snapshot();
      ui.renderPacketDetail(
        domain.openPacket(recalled.id, PERSPECTIVE.SENDER),
        PERSPECTIVE.SENDER,
      );
      return undefined;
    }

    case "history:open": {
      try {
        const records = domain.getLedger();
        ui.renderHistory(records);
        ui.navigate("history");
      } catch (error) {
        if (error?.code === "LEDGER_UNAVAILABLE") {
          ui.renderError(error.message);
          return undefined;
        }
        throw error;
      }
      return undefined;
    }

    case "record:open": {
      try {
        ui.renderRecord(domain.getRecord(payload.recordId));
      } catch (error) {
        if (error?.code === "RECORD_NOT_FOUND" || error?.code === "LEDGER_UNAVAILABLE") {
          ui.renderError(error.message);
          return undefined;
        }
        throw error;
      }
      return undefined;
    }

    case "perspective:set": {
      domain.setPerspective(payload.perspective);
      snapshot();
      ui.navigate("chat", { reset: true });
      return undefined;
    }

    case "feature:set": {
      const before = domain.getSnapshot();
      const pendingIds = before.packets
        .filter((packet) => packet.status === PACKET_STATUS.PENDING)
        .map((packet) => packet.id);
      const next = domain.setFeature(
        payload.key || FEATURE_KEY.RECIPIENT_SERVICE_ENABLED,
        payload.enabled,
      );
      ui.renderSnapshot(next);
      if (!payload.enabled) returnNotification(pendingIds, before.packets);
      ui.navigate("chat", { reset: true });
      return undefined;
    }

    case "time:advance": {
      const before = domain.getSnapshot();
      const result = domain.advanceTime(EXPIRY_HOURS);
      ui.renderSnapshot(result.snapshot);
      returnNotification(result.expiredPacketIds, before.packets);
      ui.navigate("chat", { reset: true });
      return undefined;
    }

    case "nav:back":
    case "nav:chat":
    case "modal:confirm":
    case "modal:cancel":
      return undefined;

    default:
      return undefined;
  }
}

snapshot();
