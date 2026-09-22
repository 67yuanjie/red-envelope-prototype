# RD / UI integration contract

Import `RedEnvelopeDomain` and constants from `src/domain.js`.

```js
import {
  RedEnvelopeDomain,
  FEATURE_KEY,
  PERSPECTIVE,
} from "./src/domain.js";

const domain = new RedEnvelopeDomain();
```

The model stores data only for the current page lifetime. The fixed prototype users are 小晴 (sender), 阿凱 (recipient), and the initial sender balance is NT$20,000.

## UI action mapping

| UI action | Domain call |
| --- | --- |
| `perspective:set` | `domain.setPerspective("sender" | "recipient")` |
| `feature:set` | `domain.setFeature(FEATURE_KEY.*, boolean)` |
| `time:advance` | `domain.advanceTime(hours)`; `72` expires pending envelopes |
| `payment-code:set` | Keep the input in UI; pass it to `verifyAndSend`. The test code is `1234`. |
| `entry:open` | `domain.getSendEligibility()` |
| `send:start` | `domain.startSend(amount)` |
| `send:verify` | `domain.verifyAndSend(packetId, code)` |
| `packet:open` | `domain.openPacket(packetId)` |
| `packet:claim` | `domain.claim(packetId)` |
| `packet:recall` | `domain.recall(packetId)` |
| `history:open` | `domain.getLedger()` |
| `record:open` | `domain.getRecord(transactionId)` |

`getSnapshot()` returns the current perspective, both accounts, eligibility, test-control values, and packets. `subscribe((event, snapshot) => {})` returns an unsubscribe function.

## Test controls

Feature keys:

- `senderTermsAccepted`
- `senderPaymentBound`
- `recipientCanReceiveMessages`
- `recipientServiceEnabled`
- `recipientPaymentBound`
- `sendTransferAvailable`
- `claimTransferAvailable`
- `ledgerReadable`

Setting `recipientServiceEnabled` to `false` automatically recalls every pending envelope and refunds the sender once. `setRecordReadFailure(true)` is a convenience alias for making the ledger unreadable.

## Errors

Expected business failures throw `RedEnvelopeError` with a stable `code`. Relevant UI mappings are:

| Code | UI text |
| --- | --- |
| `TERMS_REQUIRED` | 請先同意紅包服務條款，才能使用紅包功能 |
| `PAYMENT_ACCOUNT_REQUIRED` | 請先綁定支付帳戶，才能使用紅包功能 |
| `RECIPIENT_CANNOT_RECEIVE` | 對方目前無法接收紅包 |
| `INVALID_AMOUNT` | 金額必須是正整數 |
| `INSUFFICIENT_BALANCE` | 餘額不足，請調整紅包金額 |
| `PAYMENT_VERIFICATION_FAILED` | 支付驗證失敗 |
| `CLAIM_TRANSFER_FAILED` | 紅包暫時無法領取，請稍後再試 |
| `LEDGER_UNAVAILABLE` | 暫時無法顯示，請稍後再試 |

Invalid payment and failed claim transfer preserve the current state so the UI can retry. A failed send transfer changes `sending` to `failed`.

## State and ledger behavior

Allowed transitions are `sending -> pending | failed` and `pending -> claimed | recalled | expired`. Terminal operations return the latest packet with `operationApplied: false`, which makes duplicate and competing claim/recall/expire calls idempotent.

Ledger `type` and `status` are separate fields. `type` is `send`, `return`, or `receive`; localized text is available as `typeLabel`. A successful send creates the sender's `send` entry. Claim creates the recipient's `receive` entry. Recall, recipient-service exit, and expiry create one sender `return` entry. Each entry includes amount, counterparty, time to the second, account balance, status, and localized status text.

