import test from "node:test";
import assert from "node:assert/strict";

import {
  ELIGIBILITY_CODE,
  EXPIRY_HOURS,
  FEATURE_KEY,
  PACKET_STATUS,
  PAYMENT_TEST_CODE,
  PERSPECTIVE,
  RedEnvelopeDomain,
  RedEnvelopeError,
  TRANSACTION_TYPE,
  parsePositiveInteger,
} from "../src/domain.js";

const fixedNow = () => new Date("2026-09-22T04:00:00.000Z");
const makeDomain = (options = {}) => new RedEnvelopeDomain({ now: fixedNow, ...options });

const sendPending = (domain, amount = 1_000) => {
  const sending = domain.startSend(amount);
  return domain.verifyAndSend(sending.id, PAYMENT_TEST_CODE);
};

const errorCode = (code) => (error) =>
  error instanceof RedEnvelopeError && error.code === code;

test("positive-integer validation rejects zero, decimals, signs and unsafe values", () => {
  assert.equal(parsePositiveInteger("12000"), 12_000);
  assert.equal(parsePositiveInteger(1), 1);
  for (const value of [0, -1, "0", "1.5", "+1", "01", "", "abc", Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => parsePositiveInteger(value), errorCode("INVALID_AMOUNT"));
  }
});

test("eligibility checks follow the deck order", () => {
  const domain = makeDomain();

  domain.setFeature(FEATURE_KEY.SENDER_TERMS_ACCEPTED, false);
  domain.setFeature(FEATURE_KEY.SENDER_PAYMENT_BOUND, false);
  assert.equal(domain.getSendEligibility().code, ELIGIBILITY_CODE.TERMS_REQUIRED);

  domain.setFeature(FEATURE_KEY.SENDER_TERMS_ACCEPTED, true);
  assert.equal(domain.getSendEligibility().code, ELIGIBILITY_CODE.PAYMENT_ACCOUNT_REQUIRED);

  domain.setFeature(FEATURE_KEY.SENDER_PAYMENT_BOUND, true);
  domain.setFeature(FEATURE_KEY.RECIPIENT_CAN_RECEIVE_MESSAGES, false);
  assert.equal(domain.getSendEligibility().code, ELIGIBILITY_CODE.RECIPIENT_CANNOT_RECEIVE);

  domain.setFeature(FEATURE_KEY.RECIPIENT_CAN_RECEIVE_MESSAGES, true);
  domain.setFeature(FEATURE_KEY.RECIPIENT_PAYMENT_BOUND, false);
  assert.equal(domain.getSendEligibility().code, ELIGIBILITY_CODE.RECIPIENT_CANNOT_RECEIVE);
});

test("latest amount rule allows an amount equal to the sender balance", () => {
  const domain = makeDomain({ initialSenderBalance: 20_000 });
  const packet = sendPending(domain, 20_000);
  assert.equal(packet.status, PACKET_STATUS.PENDING);
  assert.equal(domain.getBalance(domain.senderId), 0);
});

test("amount above balance is rejected before a packet is created", () => {
  const domain = makeDomain({ initialSenderBalance: 20_000 });
  assert.throws(() => domain.startSend(20_001), errorCode("INSUFFICIENT_BALANCE"));
  assert.deepEqual(domain.getPackets(), []);
});

test("payment code 1234 moves sending to pending and invalid code keeps sending", () => {
  const domain = makeDomain();
  const packet = domain.startSend(500);

  assert.throws(
    () => domain.verifyAndSend(packet.id, "9999"),
    errorCode("PAYMENT_VERIFICATION_FAILED"),
  );
  assert.equal(domain.getPacket(packet.id).status, PACKET_STATUS.SENDING);
  assert.equal(domain.getBalance(domain.senderId), 20_000);

  const sent = domain.verifyAndSend(packet.id, "1234");
  assert.equal(sent.status, PACKET_STATUS.PENDING);
  assert.equal(domain.getBalance(domain.senderId), 19_500);
});

test("send transfer failure produces failed without moving money", () => {
  const domain = makeDomain();
  domain.setTransferAvailability({ send: false });
  const packet = domain.startSend(500);
  const failed = domain.verifyAndSend(packet.id, PAYMENT_TEST_CODE);

  assert.equal(failed.status, PACKET_STATUS.FAILED);
  assert.equal(failed.failureCode, "SEND_TRANSFER_FAILED");
  assert.equal(domain.getBalance(domain.senderId), 20_000);
  assert.deepEqual(domain.getLedger(), []);
});

test("valid state transitions claim once and terminal status is irreversible", () => {
  const domain = makeDomain();
  const pending = sendPending(domain, 1_200);

  const claimed = domain.claim(pending.id);
  assert.equal(claimed.status, PACKET_STATUS.CLAIMED);
  assert.equal(claimed.operationApplied, true);
  assert.equal(domain.getBalance(domain.recipientId), 1_200);

  const duplicateClaim = domain.claim(pending.id);
  const conflictingRecall = domain.recall(pending.id);
  assert.equal(duplicateClaim.status, PACKET_STATUS.CLAIMED);
  assert.equal(duplicateClaim.operationApplied, false);
  assert.equal(conflictingRecall.status, PACKET_STATUS.CLAIMED);
  assert.equal(conflictingRecall.operationApplied, false);
  assert.equal(domain.getBalance(domain.recipientId), 1_200);
  assert.equal(domain.getBalance(domain.senderId), 18_800);
});

test("claiming before send completion is an illegal transition", () => {
  const domain = makeDomain();
  const sending = domain.startSend(100);
  assert.throws(() => domain.claim(sending.id), errorCode("INVALID_TRANSITION"));
});

test("active recall refunds exactly once and blocks later claim", () => {
  const domain = makeDomain();
  const pending = sendPending(domain, 900);
  assert.equal(domain.getBalance(domain.senderId), 19_100);

  const recalled = domain.recall(pending.id);
  const duplicate = domain.recall(pending.id);
  const claimAfterRecall = domain.claim(pending.id);

  assert.equal(recalled.status, PACKET_STATUS.RECALLED);
  assert.equal(recalled.refundReason, "active_recall");
  assert.equal(duplicate.operationApplied, false);
  assert.equal(claimAfterRecall.status, PACKET_STATUS.RECALLED);
  assert.equal(domain.getBalance(domain.senderId), 20_000);

  const returns = domain.getLedger().filter((item) => item.type === TRANSACTION_TYPE.RETURN);
  assert.equal(returns.length, 1);
});

test("claim transfer failure leaves the packet pending for retry", () => {
  const domain = makeDomain();
  const pending = sendPending(domain, 700);
  domain.setTransferAvailability({ claim: false });

  assert.throws(() => domain.claim(pending.id), errorCode("CLAIM_TRANSFER_FAILED"));
  assert.equal(domain.getPacket(pending.id).status, PACKET_STATUS.PENDING);
  assert.equal(domain.getBalance(domain.recipientId), 0);

  domain.setTransferAvailability({ claim: true });
  assert.equal(domain.claim(pending.id).status, PACKET_STATUS.CLAIMED);
});

test("recipient service exit returns every pending amount and only once", () => {
  const domain = makeDomain();
  const first = sendPending(domain, 500);
  const second = sendPending(domain, 800);
  assert.equal(domain.getBalance(domain.senderId), 18_700);

  const result = domain.exitRecipientService();
  assert.deepEqual(new Set(result.recalledPacketIds), new Set([first.id, second.id]));
  assert.equal(domain.getPacket(first.id).status, PACKET_STATUS.RECALLED);
  assert.equal(domain.getPacket(first.id).refundReason, "recipient_exit");
  assert.equal(domain.getPacket(second.id).status, PACKET_STATUS.RECALLED);
  assert.equal(domain.getBalance(domain.senderId), 20_000);

  const again = domain.exitRecipientService();
  assert.deepEqual(again.recalledPacketIds, []);
  assert.equal(
    domain.getLedger().filter((item) => item.type === TRANSACTION_TYPE.RETURN).length,
    2,
  );
});

test("feature control for recipient service uses the same automatic-return path", () => {
  const domain = makeDomain();
  const pending = sendPending(domain, 650);

  const snapshot = domain.setFeature(FEATURE_KEY.RECIPIENT_SERVICE_ENABLED, false);
  assert.equal(snapshot.recipient.serviceEnabled, false);
  assert.equal(domain.getPacket(pending.id).status, PACKET_STATUS.RECALLED);
  assert.equal(domain.getPacket(pending.id).refundReason, "recipient_exit");
  assert.equal(domain.getBalance(domain.senderId), 20_000);
});

test("72-hour fast-forward expires pending packets and refunds once", () => {
  const domain = makeDomain();
  const pending = sendPending(domain, 2_000);

  domain.advanceTime(EXPIRY_HOURS - 1);
  assert.equal(domain.getPacket(pending.id).status, PACKET_STATUS.PENDING);
  assert.equal(domain.getBalance(domain.senderId), 18_000);

  const result = domain.advanceTime(1);
  assert.deepEqual(result.expiredPacketIds, [pending.id]);
  assert.equal(domain.getPacket(pending.id).status, PACKET_STATUS.EXPIRED);
  assert.equal(domain.getBalance(domain.senderId), 20_000);

  domain.advanceTime(24);
  assert.equal(domain.getBalance(domain.senderId), 20_000);
  assert.equal(
    domain.getLedger().filter((item) => item.type === TRANSACTION_TYPE.RETURN).length,
    1,
  );
});

test("claim at or after the deadline returns the latest expired state", () => {
  const domain = makeDomain();
  const pending = sendPending(domain, 250);
  domain.advanceTime(72);

  const result = domain.claim(pending.id);
  assert.equal(result.status, PACKET_STATUS.EXPIRED);
  assert.equal(result.operationApplied, false);
  assert.equal(domain.getBalance(domain.recipientId), 0);
  assert.equal(domain.getBalance(domain.senderId), 20_000);
});

test("ledger keeps transaction type separate from transaction status", () => {
  const domain = makeDomain();
  const claimedPacket = sendPending(domain, 300);
  domain.claim(claimedPacket.id);

  const senderLedger = domain.getLedger({ perspective: PERSPECTIVE.SENDER });
  assert.equal(senderLedger.length, 1);
  assert.equal(senderLedger[0].type, TRANSACTION_TYPE.SEND);
  assert.equal(senderLedger[0].typeLabel, "發送");
  assert.equal(senderLedger[0].status, PACKET_STATUS.CLAIMED);
  assert.equal(senderLedger[0].accountBalance, 19_700);

  const recipientLedger = domain.getLedger({ perspective: PERSPECTIVE.RECIPIENT });
  assert.equal(recipientLedger.length, 1);
  assert.equal(recipientLedger[0].type, TRANSACTION_TYPE.RECEIVE);
  assert.equal(recipientLedger[0].typeLabel, "接收");
  assert.equal(recipientLedger[0].status, PACKET_STATUS.CLAIMED);
  assert.equal(recipientLedger[0].accountBalance, 300);
  assert.match(recipientLedger[0].transactionTime, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);
});

test("record details expose recall only for a pending sender send record", () => {
  const domain = makeDomain();
  const pending = sendPending(domain, 400);
  const sendRecord = domain.getLedger()[0];

  assert.equal(domain.getRecord(sendRecord.id).canRecall, true);
  domain.recall(pending.id);
  assert.equal(domain.getRecord(sendRecord.id).canRecall, false);
});

test("perspective and ledger-failure controls are available to the UI", () => {
  const domain = makeDomain();
  const events = [];
  const unsubscribe = domain.subscribe((event) => events.push(event.type));

  const snapshot = domain.setPerspective(PERSPECTIVE.RECIPIENT);
  assert.equal(snapshot.perspective, PERSPECTIVE.RECIPIENT);

  domain.setRecordReadFailure(true);
  assert.throws(() => domain.getLedger(), errorCode("LEDGER_UNAVAILABLE"));
  domain.setRecordReadFailure(false);
  assert.deepEqual(domain.getLedger(), []);
  assert.ok(events.includes("perspective_changed"));
  assert.ok(events.includes("eligibility_changed"));

  unsubscribe();
});
